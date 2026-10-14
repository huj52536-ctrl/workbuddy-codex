/**
 * 协议级两轮闭环集成测试（不依赖 Codex 沙箱，也不消耗真实额度）
 *
 * 用一个 mock 上游替身，验证：
 *   轮 1  → 桥接层把上游 tool_calls 翻译成 Codex 能用的 function_call
 *   轮 2  → Codex 回传 function_call_output，桥接层把它翻译成上游的 role:tool
 *
 * 这是「agent 工具回路是否真的通了」的最强证据，因为上面两轮都是
 * 经过真实 HTTP 服务 + 真实翻译代码，只有最上游的模型被替换掉。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createBridgeServer } from "../src/server.mjs";

/** 启动一个会记录收到的请求体的 mock 上游。 */
function startMockUpstream(scriptedReplies) {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      received.push({ url: req.url, headers: req.headers, body: parsed });

      const reply = scriptedReplies[received.length - 1] ?? scriptedReplies.at(-1);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of reply) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, received, port: server.address().port }));
  });
}

async function collectSse(res) {
  const text = await res.text();
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") continue;
    try { events.push(JSON.parse(payload)); } catch { /* skip */ }
  }
  return events;
}

test("两轮工具闭环：tool_calls → function_call → function_call_output → role:tool", async () => {
  // 轮 1：上游返回一个工具调用
  const turn1 = [
    { model: "mock-model", choices: [{ delta: { role: "assistant", content: "" } }] },
    { model: "mock-model", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: '{"city":"Beijing"}' } }] }, finish_reason: "tool_calls" }] },
    { model: "mock-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ];
  // 轮 2：上游收到工具结果后给出最终回答
  const turn2 = [
    { model: "mock-model", choices: [{ delta: { content: "北京晴，26°C" }, finish_reason: "stop" }] },
    { model: "mock-model", choices: [], usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 } },
  ];

  const mock = await startMockUpstream([turn1, turn2]);

  // 桥接层指向 mock 上游
  const prevEnv = process.env.WORKBUDDY_SESSION_FILE;
  process.env.WORKBUDDY_API_KEY = "test-key";
  // 让 credentials.mjs 把请求发到 mock：通过覆盖 CHAT_URL 不可行（常量），
  // 因此这里直接构造 state 并把 fetch 指过去 —— 见下方 patchFetch。

  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const u = String(url);
    if (u.includes("copilot.tencent.com")) {
      return realFetch(u.replace(/^https:\/\/copilot\.tencent\.com/, `http://127.0.0.1:${mock.port}`), init);
    }
    return realFetch(url, init);
  };

  const bridge = createBridgeServer({ log: () => {}, upstreamTimeoutMs: 30000, reasoningSummary: true });
  const bridgePort = await new Promise((resolve) => {
    bridge.listen(0, "127.0.0.1", () => resolve(bridge.address().port));
  });

  try {
    // ---- 轮 1 ----
    const r1 = await realFetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock-model",
        instructions: "be helpful",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "北京天气?" }] }],
        tools: [{ type: "function", name: "get_weather", description: "查天气", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
        tool_choice: "auto",
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: "sess-1",
      }),
    });
    assert.equal(r1.status, 200);
    const ev1 = await collectSse(r1);

    const completed1 = ev1.find((e) => e.type === "response.completed");
    assert.ok(completed1, "轮 1 必须有 response.completed");
    const fc = completed1.response.output.find((i) => i.type === "function_call");
    assert.ok(fc, "轮 1 的 output 必须含 function_call");
    assert.equal(fc.name, "get_weather");
    assert.equal(fc.arguments, '{"city":"Beijing"}');
    assert.equal(fc.call_id, "call_abc");
    assert.equal(completed1.response.end_turn, false, "有工具调用时 end_turn 必须为 false");

    // 上游第 1 次收到的请求应立即校验
    const up1 = mock.received[0];
    assert.ok(up1, "mock 上游应收到轮 1");
    assert.equal(up1.url, "/v2/chat/completions");
    assert.equal(up1.body.stream, true, "上游必须收到 stream=true");
    assert.equal(up1.body.messages[0].role, "system");
    assert.equal(up1.body.messages[0].content, "be helpful");
    assert.equal(up1.body.tools.length, 1);
    assert.equal(up1.body.tool_choice, "auto");
    // Codex 专有字段不能泄漏
    for (const k of ["store", "include", "prompt_cache_key"]) {
      assert.equal(k in up1.body, false, `${k} 不应传给上游`);
    }
    // 令牌/密钥头存在其一
    assert.ok(up1.headers["x-api-key"] || up1.headers.authorization, "上游请求必须带鉴权头");

    // ---- 轮 2：把 function_call_output 回传 ----
    const r2 = await realFetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock-model",
        instructions: "be helpful",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "北京天气?" }] },
          { type: "function_call", call_id: "call_abc", name: "get_weather", arguments: '{"city":"Beijing"}' },
          { type: "function_call_output", call_id: "call_abc", output: "晴，26C" },
        ],
        tools: [{ type: "function", name: "get_weather", description: "查天气", parameters: { type: "object", properties: { city: { type: "string" } } } }],
        stream: true,
      }),
    });
    assert.equal(r2.status, 200);
    const ev2 = await collectSse(r2);
    const completed2 = ev2.find((e) => e.type === "response.completed");
    assert.ok(completed2, "轮 2 必须有 response.completed");
    const msg2 = completed2.response.output.find((i) => i.type === "message");
    assert.ok(msg2, "轮 2 应返回文本消息");
    assert.equal(msg2.content[0].text, "北京晴，26°C");
    assert.equal(completed2.response.end_turn, true, "无工具调用时 end_turn 应为 true");

    // 关键断言：上游第 2 次收到的应是 assistant.tool_calls + role:tool
    const up2 = mock.received[1];
    assert.ok(up2, "mock 上游应收到轮 2");
    const assistantMsg = up2.body.messages.find((m) => m.role === "assistant" && m.tool_calls);
    assert.ok(assistantMsg, "轮 2 应把 function_call 转成 assistant.tool_calls");
    assert.equal(assistantMsg.tool_calls[0].id, "call_abc");
    assert.equal(assistantMsg.tool_calls[0].function.name, "get_weather");
    const toolMsg = up2.body.messages.find((m) => m.role === "tool");
    assert.ok(toolMsg, "轮 2 应把 function_call_output 转成 role:tool");
    assert.equal(toolMsg.tool_call_id, "call_abc", "tool_call_id 必须与 call_id 一致");
    assert.equal(toolMsg.content, "晴，26C");
  } finally {
    globalThis.fetch = realFetch;
    if (prevEnv === undefined) delete process.env.WORKBUDDY_SESSION_FILE;
    else process.env.WORKBUDDY_SESSION_FILE = prevEnv;
    delete process.env.WORKBUDDY_API_KEY;
    bridge.close();
    mock.server.close();
  }
});

test("上游报错（非 200）时桥接层返回错误而非空流", async () => {
  const errUpstream = createServer((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not_found" }));
  });
  const port = await new Promise((resolve) => errUpstream.listen(0, "127.0.0.1", () => resolve(errUpstream.address().port)));

  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const u = String(url);
    if (u.includes("copilot.tencent.com")) return realFetch(u.replace(/^https:\/\/copilot\.tencent\.com/, `http://127.0.0.1:${port}`), init);
    return realFetch(url, init);
  };
  process.env.WORKBUDDY_API_KEY = "k";

  const bridge = createBridgeServer({ log: () => {}, upstreamTimeoutMs: 10000 });
  const bp = await new Promise((resolve) => bridge.listen(0, "127.0.0.1", () => resolve(bridge.address().port)));
  try {
    const r = await realFetch(`http://127.0.0.1:${bp}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] }),
    });
    assert.equal(r.status, 401, "应把上游 401 透传为 401");
    const j = await r.json();
    assert.ok(j.error?.message, "应返回结构化错误");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.WORKBUDDY_API_KEY;
    bridge.close();
    errUpstream.close();
  }
});
