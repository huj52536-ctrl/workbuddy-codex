/**
 * server.mjs —— 本地桥接服务
 *
 * 对外（给 Codex CLI 用）：
 *   POST /v1/responses           Responses API（SSE 流式）← Codex 走这个
 *   POST /v1/chat/completions    Chat Completions（兼容其它客户端）
 *   GET  /v1/models              模型列表
 *   GET  /healthz                健康检查
 *
 * 对内：把请求翻译成上游 Chat Completions，并强制 stream=true。
 */

import { createServer } from "node:http";
import {
  responsesRequestToChat,
  chatStreamToResponses,
  aggregateChatStream,
  toSse,
} from "./translate.mjs";
import {
  CHAT_URL,
  buildUpstreamHeaders,
  resolveCredential,
  refreshSession,
  sessionNeedsRefresh,
  fetchModels,
} from "./credentials.mjs";

/** 解析上游 SSE 的字节流为 data 载荷字符串。 */
async function* sseDataLines(webStream) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of webStream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      yield line.slice(5).trim();
    }
  }
  const rest = buf.trim();
  if (rest.startsWith("data:")) yield rest.slice(5).trim();
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function openaiError(res, status, message, type = "upstream_error") {
  json(res, status, { error: { message, type, code: status } });
}

async function readBody(req, limitBytes = 32 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * 调用上游并返回 fetch Response（流式）。
 * 令牌临近过期时自动刷新一次。
 */
async function callUpstream(chatBody, state, { retryOn401 = true } = {}) {
  let credential = resolveCredential({ explicitKey: state.apiKeyOverride });

  if (credential.kind === "token" && credential.session && sessionNeedsRefresh(credential.session)) {
    try {
      const refreshed = await refreshSession(credential.session);
      credential = { ...credential, session: refreshed, value: refreshed.auth.accessToken };
      state.log?.("token 已刷新");
    } catch (e) {
      state.log?.(`token 刷新失败（继续用旧令牌尝试）：${e.message}`);
    }
  }

  if (credential.kind === "none") {
    const err = new Error("未找到凭据：请设置 WORKBUDDY_API_KEY，或先运行 workbuddy-codex login");
    err.code = "NO_CREDENTIAL";
    throw err;
  }

  const headers = buildUpstreamHeaders(credential);
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(chatBody),
    signal: AbortSignal.timeout(state.upstreamTimeoutMs),
  });

  // 401 且是令牌模式：刷新后重试一次
  if (res.status === 401 && retryOn401 && credential.kind === "token" && credential.session) {
    state.log?.("上游 401，尝试刷新令牌后重试");
    try {
      const refreshed = await refreshSession(credential.session);
      const h2 = buildUpstreamHeaders({ ...credential, session: refreshed, value: refreshed.auth.accessToken });
      return fetch(CHAT_URL, {
        method: "POST",
        headers: h2,
        body: JSON.stringify(chatBody),
        signal: AbortSignal.timeout(state.upstreamTimeoutMs),
      });
    } catch (e) {
      state.log?.(`刷新重试失败：${e.message}`);
    }
  }

  return res;
}

/** 上游非 200 时，把上游错误转成 Codex 能理解的失败。 */
async function relayUpstreamError(res, upstream) {
  let text = "";
  try { text = await upstream.text(); } catch { /* ignore */ }
  let detail = text.slice(0, 600);
  try {
    const j = JSON.parse(text);
    detail = j?.msg ?? j?.message ?? j?.error?.message ?? detail;
  } catch { /* keep raw */ }
  openaiError(res, upstream.status, `上游返回 ${upstream.status}：${detail}`);
}

export function createBridgeServer(state) {
  const log = state.log ?? (() => {});

  /**
   * 可选的本地鉴权。桥接服务只监听 127.0.0.1，默认不校验。
   * 若用户设置了 --bridge-key，则要求客户端带上同样的 Bearer。
   */
  const requireKey = state.bridgeKey || "";
  const checkAuth = (req, res) => {
    if (!requireKey) return true;
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (token === requireKey) return true;
    openaiError(res, 401, "invalid bridge key", "auth_error");
    return false;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      // 健康检查不需要鉴权（便于 doctor/status 探测）
      if (req.method === "GET" && (path === "/healthz" || path === "/health")) {
        const cred = resolveCredential({ explicitKey: state.apiKeyOverride });
        return json(res, 200, {
          status: "ok",
          credential: cred.kind,
          source: cred.source,
          upstream: CHAT_URL,
          authRequired: Boolean(requireKey),
        });
      }

      if (!checkAuth(req, res)) return;

      // --- 模型列表 ---
      if (req.method === "GET" && path === "/v1/models") {
        const cred = resolveCredential({ explicitKey: state.apiKeyOverride });
        let models = state.cachedModels ?? [];
        if (!models.length) {
          try {
            models = await fetchModels(cred);
            state.cachedModels = models;
          } catch (e) {
            log(`模型目录获取失败：${e.message}`);
            models = state.fallbackModels;
          }
        }
        return json(res, 200, {
          object: "list",
          data: models.map((m) => ({ id: m.id, object: "model", created: 1700000000, owned_by: "workbuddy" })),
        });
      }

      // --- Responses（Codex 主路径） ---
      if (req.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
        const payload = await readBody(req);
        const { body, meta } = responsesRequestToChat(payload);

        log(`→ responses model=${body.model} msgs=${meta.messageCount} tools=${meta.hasTools ? "yes" : "no"}` +
          (meta.droppedTools.length ? ` droppedTools=[${meta.droppedTools.join(",")}]` : ""));

        const upstream = await callUpstream(body, state);
        if (upstream.status !== 200) return relayUpstreamError(res, upstream);

        // 客户端不想要流式时，聚合后按 Responses 一次性返回
        if (payload.stream === false) {
          const chunks = [];
          for await (const d of sseDataLines(upstream.body)) {
            if (d === "[DONE]") break;
            try { chunks.push(JSON.parse(d)); } catch { /* skip */ }
          }
          const agg = aggregateChatStream(chunks);
          const events = [];
          for await (const ev of chatStreamToResponses(toAsync([JSON.stringify(agg)]), { model: body.model })) {
            events.push(ev);
          }
          const done = events.find((e) => e.event === "response.completed");
          return json(res, 200, done?.data?.response ?? {});
        }

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });

        try {
          for await (const ev of chatStreamToResponses(sseDataLines(upstream.body), {
            model: body.model,
            reasoningSummary: state.reasoningSummary,
          })) {
            res.write(toSse(ev.event, ev.data));
          }
        } catch (e) {
          log(`流式翻译中断：${e.message}`);
          try {
            res.write(toSse("response.failed", {
              type: "response.failed",
              response: { id: "resp_error", status: "failed", error: { code: "stream_error", message: e.message } },
            }));
          } catch { /* socket already gone */ }
        }
        return res.end();
      }

      // --- Chat Completions（兼容其它客户端） ---
      if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
        const payload = await readBody(req);
        const wantStream = payload.stream !== false;

        const body = { ...payload, stream: true };
        delete body.stream_options;
        body.stream_options = { include_usage: true };

        log(`→ chat/completions model=${body.model} stream=${wantStream}`);

        const upstream = await callUpstream(body, state);
        if (upstream.status !== 200) return relayUpstreamError(res, upstream);

        if (!wantStream) {
          const chunks = [];
          for await (const d of sseDataLines(upstream.body)) {
            if (d === "[DONE]") break;
            try { chunks.push(JSON.parse(d)); } catch { /* skip */ }
          }
          return json(res, 200, aggregateChatStream(chunks));
        }

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        for await (const d of sseDataLines(upstream.body)) {
          res.write(`data: ${d}\n\n`);
        }
        return res.end();
      }

      return json(res, 404, { error: { message: `unknown path ${path}`, type: "invalid_request_error" } });
    } catch (e) {
      const status = e.code === "NO_CREDENTIAL" ? 503 : 500;
      log(`请求处理失败：${e.message}`);
      if (!res.headersSent) openaiError(res, status, e.message, e.code ?? "internal_error");
      else res.end();
    }
  });

  return server;
}

async function* toAsync(items) {
  for (const i of items) yield i;
}

export { sseDataLines };
