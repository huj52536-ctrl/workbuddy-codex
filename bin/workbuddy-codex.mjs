#!/usr/bin/env node
/**
 * workbuddy-codex —— 把 WorkBuddy / CodeBuddy 的模型接入任意 OpenAI Codex CLI。
 *
 * 命令：
 *   login      浏览器登录取令牌（不依赖桌面端）
 *   start      只启动桥接服务
 *   install    启动 + 写入 ~/.codex/config.toml（一键接入 Codex）
 *   uninstall  从 ~/.codex/config.toml 移除本工具的配置
 *   doctor     诊断环境（凭据 / 上游连通性 / Codex 版本 / 配置冲突）
 *   models     列出当前凭据可用的模型
 *   status     显示当前接入状态
 */

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBridgeServer } from "../src/server.mjs";
import {
  resolveCredential, loginWorkBuddy, fetchModels, inspectDesktopCredentials,
  sessionNeedsRefresh, refreshSession, loadSession, HOME_DIR, SESSION_FILE,
  CHAT_URL, API_KEY_ENVS, verifyInference, listCredentialCandidates,
  loadState, saveState,
} from "../src/credentials.mjs";
import {
  REGIONS, DEFAULT_REGION, endpointsFor, resolveEndpoints, normalizeRegionId, probeHosts,
} from "../src/region.mjs";
import {
  startDetached, stopDaemon, daemonStatus, waitForPid, waitForHealth,
  writeOwnPid, clearPid, readPid, LOG_FILE, PID_FILE,
} from "../src/daemon.mjs";
import {
  applyManagedBlock, removeManagedBlock, readConfig, writeConfig, backupConfig,
  findChatWireApi, writeModelCatalog, CONFIG_PATH, CODEX_HOME, PROVIDER_ID, MODEL_CATALOG_FILE,
  extractManagedBlock,
} from "../src/codex-config.mjs";

const args = process.argv.slice(2);
const command = args[0] ?? "help";

function flag(name, def = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
function has(name) { return args.includes(`--${name}`); }

const DEFAULT_PORT = 8799;

/** 解析一个「可能是端口」的值；无效返回 null（供 ?? 链安全跳过）。 */
function asPort(v) {
  if (v === undefined || v === null || v === "" || v === true) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/** 端口优先级：--port > 环境变量 > 上次成功的端口 > 默认 */
const PORT = asPort(flag("port"))
  ?? asPort(process.env.WORKBUDDY_CODEX_PORT)
  ?? asPort(loadState().port)
  ?? DEFAULT_PORT;
const HOST = String(flag("host", "127.0.0.1"));
const LOG = has("verbose");

const log = (...a) => { if (LOG) console.error("[workbuddy-codex]", ...a); };
const say = (...a) => console.log(...a);

/**
 * 检查端口是否空闲。
 */
function probePort(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

/** 有哪些 pid 正在监听指定端口（可能为空）。跨平台。 */
function listenersOn(port) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "TCP"], {
        encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "i"));
        if (m) pids.add(Number(m[1]));
      }
      return [...pids];
    }
    // macOS / Linux：lsof 若有则用之，否则退回 netstat
    const out = (() => {
      try {
        return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
          encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        return execFileSync("netstat", ["-tlnp"], {
          encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        });
      }
    })();
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      if (/^\d+$/.test(t)) { pids.add(Number(t)); continue; }   // lsof -t 输出
      const m = t.match(new RegExp(`[:.]${port}\\s.*?(\\d+)\\s*$`));  // netstat 最后一列是 pid/prog
      if (m) pids.add(Number(m[1]));
    }
    return [...pids];
  } catch { return []; }
}

/** 取某 pid 的完整命令行（跨平台）。 */
function commandLineOf(pid) {
  try {
    if (process.platform === "win32") {
      return execFileSync("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return ""; }
}

/**
 * 若端口被**本项目自己的**桥接服务占用，则停掉它。
 *
 * 为什么需要：重复 install 时旧服务仍占着端口，新服务会顺延到下一个端口
 * 并写进 config.toml；但用户下次启动时又会从默认端口开始试 —— 端口与配置
 * 不一致，直接导致 Codex 连不上。所以安装时要先回收自己的旧进程。
 *
 * 只终止命令行里含 `workbuddy-codex` 的进程，绝不碰用户其它服务。
 */
function reclaimPortFromOwnService(port) {
  const stopped = [];
  for (const pid of listenersOn(port)) {
    if (pid === process.pid) continue;
    const cmd = commandLineOf(pid);
    if (cmd && /workbuddy-codex/i.test(cmd)) {
      try { process.kill(pid); stopped.push(pid); } catch { /* ignore */ }
    }
  }
  return stopped;
}

/**
 * 选择监听端口。
 *
 * 优先级：显式 --port > 上次成功的端口（state.json）> 默认端口。
 * 这样端口在多次启动间保持稳定，不会因为一次偶然占用就永久漂移。
 */
async function pickPort(preferred, { allowReclaim = true } = {}) {
  // 先回收自己上次留下的服务，避免端口漂移
  if (allowReclaim) {
    const stopped = reclaimPortFromOwnService(preferred);
    if (stopped.length) {
      say(C.dim(`  已停止上次运行的桥接服务 (pid ${stopped.join(", ")})`));
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  if (await probePort(preferred)) return { port: preferred, moved: false };

  for (let p = preferred + 1; p < preferred + 20; p++) {
    if (await probePort(p)) return { port: p, moved: true };
  }
  throw new Error(`端口 ${preferred} 及其后 20 个端口都被占用，请用 --port 指定其它端口`);
}

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/**
 * 选择默认模型。
 *
 * 不直接取目录第一项：上游目录以 `hy4-preview` 之类的**预览模型**打头，
 * 把预览模型设为默认会让用户首次体验不稳定。这里按「稳定编程模型优先」排序，
 * 并明确回避 preview / flash-lite 等前缀。
 */
const PREFERRED_MODELS = [
  "glm-5.3",
  "deepseek-v4-pro",
  "kimi-k3-1",
  "glm-5.2",
  "deepseek-v4.1-flash",
  "minimax-m3",
  "kimi-k2.7",
];

function pickDefaultModel(models, explicit) {
  if (typeof explicit === "string" && models.some((m) => m.id === explicit)) return explicit;
  const isStable = (id) => !/preview|beta|experimental|flash-lite/i.test(id);
  for (const want of PREFERRED_MODELS) {
    const hit = models.find((m) => m.id === want);
    if (hit && isStable(hit.id)) return hit.id;
  }
  const stable = models.filter((m) => isStable(m.id));
  return (stable[0] ?? models[0])?.id ?? "auto";
}

/**
 * 解析本次运行要用的端点。
 *
 * 优先级：--region > 环境变量 WORKBUDDY_CODEX_REGION > 凭据 domain 推断 > 默认(CN)
 *
 * 只在**显式指定**区域时才做多主机探测（逐个试到能推理为止）；
 * 未指定时保持与改造前一致的行为——直接用中国区端点，
 * 避免给现有用户增加额外网络往返。
 */
async function resolveEffectiveEndpoints(cred) {
  const explicit = flag("region");
  const explicitRegion = typeof explicit === "string" ? explicit : process.env.WORKBUDDY_CODEX_REGION;

  const domain = cred?.session?.account?.domain;
  const r = resolveEndpoints({ explicitRegion, domain });

  // 显式指定区域（且非 auto）时，逐个 host 探测，确保选到真正能用的那个
  const wantsProbe = typeof explicitRegion === "string" && normalizeRegionId(explicitRegion) !== "auto";
  if (wantsProbe && r.endpoints.hosts.length > 1 && cred.kind !== "none") {
    say(C.dim(`  正在探测 ${r.endpoints.label} 的可用主机…`));
    const probeCred = {
      ...cred,
      session: cred.session
        ? { ...cred.session, account: { ...cred.session.account, domain: r.endpoints.defaultDomain } }
        : undefined,
    };
    const { endpoints, attempts } = await probeHosts({
      hosts: r.endpoints.hosts,
      region: r.region,
      probe: (ep) => verifyInference(probeCred, { endpoints: ep, timeoutMs: 30000 }),
    });
    for (const a of attempts) {
      say(C.dim(`    ${a.ok ? C.ok("✓") : "✗"} ${a.host}${a.ok ? "" : ` — ${String(a.reason ?? "").slice(0, 70)}`}`));
    }
    if (endpoints) {
      return { endpoints, region: r.region, source: "probe", reason: `探测选定 ${endpoints.backend}` };
    }
    say(C.warn(`  ${r.endpoints.label} 的所有候选主机都无法推理`));
    return { endpoints: r.endpoints, region: r.region, source: r.source, reason: r.reason };
  }

  return { endpoints: r.endpoints, region: r.region, source: r.source, reason: r.reason };
}

/** 打印一行区域信息，便于用户确认工具到底连的是哪个区域。 */
function sayRegion(region, source) {
  const r = REGIONS[region];
  const label = r ? r.label : region;
  const auto = (source === "explicit" || source === "probe") ? "" : "（自动推断）";
  say(`  区域    : ${label}${auto}`);
}

async function ensureModels(cred, endpoints) {
  try {
    return await fetchModels(cred, { endpoints });
  } catch (e) {
    say(C.warn(`获取模型目录失败（将使用退避列表）：${e.message}`));
    return [
      { id: "glm-5.3", name: "GLM-5.3", contextWindow: 1000000, maxOutputTokens: 64000, supportsImages: true, supportsReasoning: true },
      { id: "deepseek-v4-pro", name: "Deepseek-V4-Pro", contextWindow: 1000000, maxOutputTokens: 128000, supportsImages: true, supportsReasoning: true },
      { id: "kimi-k3-1", name: "Kimi-K3", contextWindow: 1000000, maxOutputTokens: 32000, supportsImages: true, supportsReasoning: true },
    ];
  }
}

async function startServer({ quiet = false, daemonChild = false, endpoints } = {}) {
  const state = {
    log,
    apiKeyOverride: typeof flag("api-key") === "string" ? flag("api-key") : undefined,
    bridgeKey: typeof flag("bridge-key") === "string" ? flag("bridge-key") : undefined,
    upstreamTimeoutMs: Number(flag("timeout", 300000)),
    reasoningSummary: !has("no-reasoning-summary"),
    cachedModels: null,
    fallbackModels: [],
    // 端点由 CLI 解析后注入；缺省为中国区，行为与改造前一致
    endpoints: endpoints ?? endpointsFor(DEFAULT_REGION),
  };
  if (typeof flag("api-key") === "string") {
    process.env.WORKBUDDY_API_KEY = flag("api-key");
  }

  const { port, moved } = await pickPort(PORT);
  if (moved && !quiet) say(C.warn(`端口 ${PORT} 被占用，已改用 ${port}`));
  // 记住端口，确保下次启动/重启后与 config.toml 里写的一致
  saveState({ port });

  const server = createBridgeServer(state);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      // 作为分离进程运行时，由自己落盘 PID（父进程拿不到我们的 PID）
      if (daemonChild) writeOwnPid();
      if (!quiet) {
        say(`${C.ok("✓")} 桥接服务已启动: ${C.bold(`http://${HOST}:${port}`)}`);
        say(C.dim(`  POST /v1/responses          ← Codex CLI 使用`));
        say(C.dim(`  POST /v1/chat/completions   ← 其它 OpenAI 兼容客户端`));
        say(C.dim(`  GET  /v1/models`));
        say(C.dim(`  GET  /healthz`));
        say("");
      }
      resolve({ server, state, port });
    });
  });
}

/**
 * 从 config.toml 的托管块里读出实际使用的端口。
 * install 可能因端口冲突自动回退，所以 doctor/status 不能假定 PORT。
 */
function configuredPort() {
  const text = readConfig();
  const m = text.match(/base_url\s*=\s*"http:\/\/127\.0\.0\.1:(\d+)\/v1"/);
  return m ? Number(m[1]) : PORT;
}

/** 桥接服务「应该」在的端口：配置里有就用配置的，否则用本次选定的。 */
function actualConfiguredPort() {
  return configuredPort();
}

async function probeHealth(port = configuredPort()) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2500) });
    return { running: true, port, info: await r.json() };
  } catch {
    return { running: false, port };
  }
}

/** 路径太长时保留尾部，避免终端换行混乱。 */
function shortenPath(p) {
  const s = String(p ?? "");
  if (s.length <= 62) return s;
  return `…${s.slice(-59)}`;
}

function printCredInfo(cred) {
  if (cred.kind === "api-key") {
    say(`  凭据模式: ${C.ok("API Key")} ${C.dim(`(${cred.source})`)}`);
  } else if (cred.kind === "token") {
    const s = cred.session;
    const exp = Number(s?.auth?.expiresAt);
    const expStr = Number.isFinite(exp) ? new Date(exp).toISOString() : "未知";
    say(`  凭据模式: ${C.ok("登录令牌")} ${C.dim(`(${cred.source})`)}`);
    say(`  账号    : ${s?.account?.displayName ?? s?.account?.userId ?? "未知"}`);
    say(`  令牌到期: ${expStr}${sessionNeedsRefresh(s) ? C.warn("  ← 需要刷新") : ""}`);
  } else {
    say(`  凭据模式: ${C.bad("未找到")}`);
  }
}

// ---------------------------------------------------------------------------

async function cmdLogin() {
  say(C.bold("WorkBuddy / CodeBuddy 登录"));
  say(C.dim("将打开浏览器完成登录；若无法自动打开，请手动访问打印出的地址。\n"));
  const session = await loginWorkBuddy({
    onUrl: (url, opened) => {
      say(opened ? "已在浏览器中打开登录页：" : `${C.warn("请手动打开以下地址：")}`);
      say(`  ${url}\n`);
      say(C.dim("等待登录完成…"));
    },
  });
  say(`\n${C.ok("✓")} 登录成功`);
  say(`  账号: ${session?.account?.displayName ?? session?.account?.userId ?? "未知"}`);
  say(`  会话已保存: ${SESSION_FILE}`);
}

async function cmdModels() {
  const cred = resolveCredential({ explicitKey: typeof flag("api-key") === "string" ? flag("api-key") : undefined });
  if (cred.kind === "none") { say(C.bad("未找到凭据。请先 `workbuddy-codex login` 或设置 WORKBUDDY_API_KEY。")); process.exitCode = 1; return; }
  const regionInfo = await resolveEffectiveEndpoints(cred);
  sayRegion(regionInfo.region, regionInfo.source);
  say(C.dim(`  端点    : ${regionInfo.endpoints.backend}\n`));
  const models = await ensureModels(cred, regionInfo.endpoints);
  say(C.bold(`可用模型（${models.length}）`));
  const pad = (s, n) => String(s).padEnd(n);
  say(C.dim(`${pad("模型 ID", 24)}${pad("名称", 22)}${pad("上下文", 12)}${pad("最大输出", 12)}图片  推理`));
  for (const m of models) {
    say(`${pad(m.id, 24)}${pad(m.name, 22)}${pad(m.contextWindow, 12)}${pad(m.maxOutputTokens, 12)}` +
      `${m.supportsImages ? " ✓  " : " -  "}  ${m.supportsReasoning ? "✓" : "-"}`);
  }
}

async function cmdDoctor() {
  say(C.bold("workbuddy-codex doctor\n"));

  say(C.bold("1) 运行环境"));
  say(`  Node    : ${process.version}`);
  say(`  平台    : ${process.platform} ${process.arch}`);

  say(C.bold("\n2) 凭据"));
  const cred = resolveCredential({ explicitKey: typeof flag("api-key") === "string" ? flag("api-key") : undefined });
  printCredInfo(cred);
  say(C.dim(`  会话文件: ${SESSION_FILE} ${loadSession() ? "(存在)" : "(无)"}`));

  // 列出所有候选来源：用户能一眼看到"有几个来源、正在用哪个、
  // 其它的为什么没用"，避免"我明明登录过却说没有凭据"的困惑。
  const candidates = listCredentialCandidates({ explicitKey: typeof flag("api-key") === "string" ? flag("api-key") : undefined });
  if (candidates.length) {
    say(C.dim(`  候选来源（共 ${candidates.length} 个，按优先级）：`));
    for (const c of candidates) {
      const isActive = c.kind === cred.kind && c.value === cred.value;
      const label = c.kind === "api-key" ? "API Key" : "登录令牌";
      const short = shortenPath(c.source);
      say(`    ${isActive ? C.ok("→") : " "} ${label}  ${C.dim(short)}${isActive ? C.ok("  ← 当前使用") : ""}`);
    }
  }

  if (cred.kind === "none") {
    say(`\n  ${C.warn("桌面端凭据探测：")}`);
    const found = inspectDesktopCredentials();
    if (!found.length) say(C.dim("    (未找到桌面端凭据目录)"));
    for (const f of found) {
      const state = f.readable ? C.ok("有明文令牌（但可能已失效）")
        : f.encrypted ? C.warn("加密信封，本工具不逆向")
          : C.dim(f.reason ?? "不可用");
      say(`    ${shortenPath(f.path)}`);
      say(`      → ${state}`);
    }
    say(`\n  ${C.warn("建议：")} 运行 ${C.bold("workbuddy-codex login")} 走内置浏览器登录，或设置 ${C.bold("WORKBUDDY_API_KEY")}。`);
  }

  say(C.bold("\n3) 上游连通性"));
  if (cred.kind !== "none") {
    // 区域：显式指定时逐个主机探测；否则按凭据 domain 推断（或默认中国区）
    const regionInfo = await resolveEffectiveEndpoints(cred);
    const ep = regionInfo.endpoints;
    sayRegion(regionInfo.region, regionInfo.source);
    say(C.dim(`  端点    : ${ep.backend}`));
    // 注意：`/v3/config` 的鉴权比推理端点**宽松**。
    // 只看它会给用户"一切正常"的错觉，而实际推理可能 401。
    // 因此这里必须做一次真实的推理验证。
    let catalogOk = false;
    let modelCount = 0;
    try {
      const models = await fetchModels(cred, { endpoints: ep });
      catalogOk = true;
      modelCount = models.length;
    } catch (e) {
      say(`  ${C.bad("✗")} 模型目录失败：${e.message}`);
    }
    if (catalogOk) say(C.dim(`  模型目录：可用（${modelCount} 个模型）`));

    const probe = await verifyInference(cred, { endpoints: ep });
    if (probe.ok) {
      say(`  ${C.ok("✓")} 凭据可用于推理`);
    } else {
      say(`  ${C.bad("✗")} ${probe.reason}`);
      if (probe.hint) say(C.warn(`    ${probe.hint}`));
      if (catalogOk) {
        say(C.dim(`    注意：模型目录能列出 ${modelCount} 个模型，但推理被拒 ——`));
        say(C.dim(`          /v3/config 的鉴权更宽松，不能作为凭据可用的依据。`));
      }
      if (cred.kind === "token" && cred.session) {
        say(C.dim("    尝试刷新令牌…"));
        try {
          await refreshSession(cred.session, { persist: !cred.fromDesktop && !cred.fromDsh, endpoints: ep });
          const re = await verifyInference(resolveCredential(), { endpoints: ep });
          if (re.ok) say(`  ${C.ok("✓")} 刷新后可用`);
          else say(`  ${C.bad("✗")} 刷新后仍失败：${re.reason}`);
        } catch (e2) {
          say(`  ${C.bad("✗")} 刷新失败：${e2.message}`);
        }
      }
      // 区域选错是最常见的失败原因之一，主动给出建议
      if (!has("region") && !process.env.WORKBUDDY_CODEX_REGION) {
        const other = regionInfo.region === "cn" ? "intl" : "cn";
        say(C.dim(`    若你的账号属于${REGIONS[other].label}，可试试：workbuddy-codex doctor --region ${other}`));
      }
    }
  } else {
    say(C.dim("  (跳过：无凭据)"));
  }

  say(C.bold("\n4) Codex 配置"));
  say(`  CODEX_HOME : ${CODEX_HOME}`);
  say(`  config.toml: ${CONFIG_PATH}`);
  const text = readConfig();
  if (!text) {
    say(`  ${C.warn("配置文件不存在")}`);
  } else {
    const chat = findChatWireApi(text);
    if (chat.length) {
      say(`  ${C.bad("✗ 发现 wire_api=\"chat\"")} —— Codex 0.95.0+ 会因此拒绝启动：`);
      for (const h of chat) say(C.dim(`      第 ${h.line} 行  [${h.section}]`));
      say(`  ${C.warn("请删掉这些行（本工具的 install 不会生成它们）")}`);
    } else {
      say(`  ${C.ok("✓")} 无 wire_api="chat" 冲突`);
    }
    const installed = text.includes("[model_providers.workbuddy]");
    say(`  ${installed ? C.ok("✓ 已接入本工具") : C.dim("尚未接入（运行 workbuddy-codex install）")}`);

    // env_key 陷阱：桌面版 Codex 从图标启动时拿不到终端环境变量。
    // 只检查**本工具生成的托管块**，不要误报用户其它 provider 的合法 env_key。
    if (installed) {
      const ourBlock = extractManagedBlock(text);
      const envKeyHit = ourBlock.match(/^\s*env_key\s*=\s*"([^"]+)"/m);
      if (envKeyHit) {
        const name = envKeyHit[1];
        say(`  ${C.bad("✗ 本工具的 provider 段里有 env_key = " + JSON.stringify(name))}`);
        say(`     Codex 桌面版从图标启动时**不会**继承终端环境变量，`);
        say(`     会直接报 "Missing environment variable: \`${name}\`"。`);
        say(`     桥接服务只监听 127.0.0.1，本来就不需要客户端密钥。`);
        say(C.warn(`     修复：重新运行 workbuddy-codex install`));
      } else {
        say(`  ${C.ok("✓")} 本工具的 provider 段未使用 env_key`);
      }
    }
  }

  say(C.bold("\n5) 桥接服务"));
  const health = await probeHealth();
  if (health.running) {
    say(`  ${C.ok("✓")} 正在运行 (端口 ${health.port}, 凭据 ${health.info.credential})`);
  } else {
    say(C.dim(`  未运行（端口 ${health.port}）`));
  }
}

async function cmdInstall() {
  say(C.bold("接入 Codex CLI\n"));

  // 0) 前置检查：配置里不能有 wire_api="chat"
  const text = readConfig();
  const chat = findChatWireApi(text);
  if (chat.length) {
    say(C.bad(`✗ 你的 ${CONFIG_PATH} 里有 wire_api="chat"`));
    for (const h of chat) say(C.dim(`    第 ${h.line} 行  [${h.section}]`));
    say(`\n  Codex 0.95.0+ 会因此拒绝启动（即使该 provider 未被使用）。`);
    say(`  请先删除这些行，然后重新运行 install。`);
    process.exitCode = 1;
    return;
  }

  // 1) 凭据：逐个候选验证，取第一个**真正能推理**的。
  //    不能只取"第一个存在的"——实测存在能列模型但推理 401 的失效来源。
  const explicitKey = typeof flag("api-key") === "string" ? flag("api-key") : undefined;
  let candidates = listCredentialCandidates({ explicitKey });

  if (candidates.length === 0) {
    say(C.warn("未找到凭据，先进行登录…\n"));
    await cmdLogin();
    candidates = listCredentialCandidates({ explicitKey });
  }

  let cred = null;
  let probe = null;
  let endpoints = null;
  let regionInfo = null;

  for (const cand of candidates) {
    const label = cand.kind === "api-key" ? "API Key" : "登录令牌";
    say(C.dim(`  验证凭据来源：${label} (${cand.source})`));

    // 端点按「显式 --region > 该候选的 domain 推断 > 默认」确定。
    // 放在循环内是因为不同候选可能属于不同区域（例如桌面端国际版凭据）。
    if (!endpoints) {
      regionInfo = await resolveEffectiveEndpoints(cand);
      endpoints = regionInfo.endpoints;
      sayRegion(regionInfo.region, regionInfo.source);
      say(C.dim(`  端点    : ${endpoints.backend}`));
    }

    let r = await verifyInference(cand, { endpoints });

    // 令牌失败时尝试刷新一次
    if (!r.ok && cand.kind === "token" && cand.session) {
      try {
        const refreshed = await refreshSession(cand.session, {
          persist: !cand.fromDesktop && !cand.fromDsh,
          endpoints,
        });
        r = await verifyInference({ ...cand, session: refreshed, value: refreshed.auth.accessToken }, { endpoints });
        if (r.ok) { cand.session = refreshed; cand.value = refreshed.auth.accessToken; }
      } catch { /* 刷新失败则继续下一个候选 */ }
    }

    if (r.ok) { cred = cand; probe = r; break; }
    say(C.dim(`    ✗ ${r.reason}${r.detail ? ` — ${r.detail.slice(0, 90)}` : ""}`));
    probe = probe ?? r;
  }

  if (!cred) {
    say(`\n${C.bad("✗")} 所有候选凭据都无法用于推理。`);
    if (probe?.hint) say(C.warn(`  ${probe.hint}`));
    say(C.dim(`  候选来源数：${candidates.length}`));
    if (endpoints) say(C.dim(`  已尝试端点：${endpoints.backend}`));
    if (!has("region") && !process.env.WORKBUDDY_CODEX_REGION && regionInfo) {
      const other = regionInfo.region === "cn" ? "intl" : "cn";
      say(C.warn(`  若你的账号属于${REGIONS[other].label}，试试：workbuddy-codex install --region ${other}`));
    }
    say(C.warn("\n  配置未写入，Codex 保持原状。"));
    process.exitCode = 1;
    return;
  }

  printCredInfo(cred);
  say(`${C.ok("✓")} 凭据可用于推理`);

  // 2) 模型 + 目录
  const models = await ensureModels(cred, endpoints);
  const chosen = pickDefaultModel(models, flag("model"));

  // 3) 选端口并以**分离进程**启动服务 —— 不霸占当前终端。
  const { port: actualPort } = await pickPort(PORT);
  saveState({ port: actualPort, region: regionInfo?.region ?? DEFAULT_REGION });
  say(`${C.dim("  正在启动后台桥接服务…")}`);

  const root = fileURLToPath(new URL("..", import.meta.url));
  const daemonArgs = ["start", "--daemon"];
  if (typeof flag("api-key") === "string") daemonArgs.push("--api-key", flag("api-key"));
  if (typeof flag("bridge-key") === "string") daemonArgs.push("--bridge-key", flag("bridge-key"));
  // 把已解析的区域传给守护进程，避免它在后台重新推断出不同结果
  if (regionInfo) daemonArgs.push("--region", regionInfo.region);

  startDetached({ root, nodePath: process.execPath, args: daemonArgs, port: actualPort });
  const health = await waitForHealth(actualPort, 25000);
  if (!health) {
    say(`${C.bad("✗")} 后台服务启动失败`);
    say(C.dim(`  日志：${LOG_FILE}`));
    say(C.warn("  配置不会写入。"));
    process.exitCode = 1;
    return;
  }
  const daemonPid = readPid();
  say(`${C.ok("✓")} 桥接服务已在后台运行: http://${HOST}:${actualPort}${daemonPid ? ` (pid ${daemonPid})` : ""}`);

  // 4) 自检：通过桥接服务真实调用一次
  say(C.dim("  正在通过桥接层做一次真实自检…"));
  try {
    const r = await fetch(`http://${HOST}:${actualPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: chosen,
        instructions: "You are a test.",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Reply with exactly: OK" }] }],
        stream: true,
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let sawCompleted = false, text = "";
    const raw = await r.text();
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        if (j.type === "response.output_text.delta") text += j.delta;
        if (j.type === "response.completed") sawCompleted = true;
        if (j.type === "response.failed") throw new Error(j.response?.error?.message ?? "上游失败");
      } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
    }
    if (!sawCompleted) throw new Error("未收到 response.completed");
    say(`${C.ok("✓")} 自检通过（模型回复: ${JSON.stringify(text.slice(0, 40))}）`);
  } catch (e) {
    say(`${C.bad("✗")} 自检失败：${e.message}`);
    say(C.warn("  配置不会写入，以免让 Codex 处于不可用状态。"));
    const s = stopDaemon();
    if (s.stopped) say(C.dim(`  已停止刚启动的后台服务 (pid ${s.pid})`));
    process.exitCode = 1;
    return;
  }

  // 5) 写配置（先备份）
  const backup = backupConfig();
  if (backup) say(C.dim(`  已备份原配置: ${backup}`));
  const catalogPath = writeModelCatalog(models);
  say(`${C.ok("✓")} 已写入模型目录: ${catalogPath}`);

  const next = applyManagedBlock(text, {
    port: actualPort,
    model: chosen,
    bridgeKey: typeof flag("bridge-key") === "string" ? flag("bridge-key") : undefined,
  });
  writeConfig(next);
  say(`${C.ok("✓")} 已写入 ${CONFIG_PATH}`);

  // 6) 顺手装好开机自启，避免用户重启后又连不上
  try { await installAutostart({ quiet: true }); say(`${C.ok("✓")} 已安装开机自启`); }
  catch (e) { say(C.warn(`  （开机自启未安装：${e.message}）`)); }

  say(`\n${C.bold("接入完成，现在可以直接用 Codex。")}`);
  say(`  ${C.dim("•")} 桥接服务在后台运行，${C.bold("本终端可以关闭")}`);
  say(`  ${C.dim("•")} 模型：${C.bold(chosen)}`);
  say(`  ${C.dim("•")} 服务管理：${C.bold("workbuddy-codex service status|stop|restart")}`);
  say(`\n  卸载：${C.bold("workbuddy-codex uninstall")}`);
}

async function cmdUninstall() {
  const text = readConfig();
  if (!text.includes("[model_providers.workbuddy]")) {
    say(C.warn("配置里没有本工具写入的内容，无需卸载。"));
    return;
  }
  const backup = backupConfig();
  if (backup) say(C.dim(`已备份: ${backup}`));
  writeConfig(removeManagedBlock(text));
  say(`${C.ok("✓")} 已从 ${CONFIG_PATH} 移除 workbuddy provider`);
  say(C.dim(`  模型目录文件仍保留：${MODEL_CATALOG_FILE}`));
}

async function cmdStatus() {
  const cred = resolveCredential();
  say(C.bold("workbuddy-codex 状态"));
  printCredInfo(cred);
  const text = readConfig();
  say(`  Codex 接入: ${text.includes("[model_providers.workbuddy]") ? C.ok("已接入") : C.dim("未接入")}`);
  const health = await probeHealth();
  if (health.running) {
    say(`  桥接服务  : ${C.ok("运行中")} ${C.dim(`(端口 ${health.port}, ${health.info.credential})`)}`);
  } else {
    say(`  桥接服务  : ${C.dim(`未运行（端口 ${health.port}）`)}`);
  }
}

/**
 * 安装开机自启（Windows 用启动文件夹的 VBS；macOS/Linux 提示用 crontab）。
 *
 * 为什么需要：`install` 启动的桥接进程绑定在当前终端上，终端一关就没了。
 * 用户下次开机发现 Codex 连不上，会以为配置坏了。
 */
/**
 * 安装开机自启。
 *
 * 自启脚本只负责调用 `service start`（分离进程），
 * 因此开机后不会留下任何控制台窗口，也不依赖用户登录终端。
 */
async function installAutostart({ quiet = false } = {}) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const nodePath = process.execPath;

  if (process.platform === "win32") {
    const startup = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    if (!existsSync(startup)) throw new Error(`找不到启动文件夹：${startup}`);
    const vbs = join(startup, "workbuddy-codex-bridge.vbs");
    const content = [
      `' workbuddy-codex 桥接服务自启（由 workbuddy-codex autostart 生成）`,
      `' 调用 service start，以分离进程方式启动，无窗口、可随时关闭终端。`,
      `Set s = CreateObject("WScript.Shell")`,
      `s.CurrentDirectory = "${root}"`,
      `s.Run """${nodePath}"" bin\\workbuddy-codex.mjs service start", 0, False`,
      ``,
    ].join("\r\n");
    writeFileSync(vbs, content, "utf8");
    return { path: vbs, kind: "windows-startup" };
  }

  const line = `@reboot cd ${root} && ${nodePath} bin/workbuddy-codex.mjs service start >> ${LOG_FILE} 2>&1`;
  return { path: null, kind: "crontab", line };
}

async function cmdAutostart() {
  const off = has("remove");

  if (off) {
    if (process.platform === "win32") {
      const startup = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
      const vbs = join(startup, "workbuddy-codex-bridge.vbs");
      if (existsSync(vbs)) { rmSync(vbs, { force: true }); say(`${C.ok("✓")} 已移除开机自启：${vbs}`); }
      else say(C.dim("未安装开机自启。"));
      return;
    }
    say(C.bold("请手动执行 crontab -e 并删除含 workbuddy-codex 的那一行。"));
    return;
  }

  const r = await installAutostart();
  if (r.kind === "windows-startup") {
    say(`${C.ok("✓")} 已安装开机自启`);
    say(`  脚本: ${r.path}`);
    say(C.dim(`  取消: workbuddy-codex autostart --remove`));
  } else {
    say(C.bold("请用 crontab 添加开机自启："));
    say(C.dim("  1) 运行：crontab -e"));
    say(C.dim("  2) 加入这一行："));
    say(`     ${r.line}`);
  }
}

/** 服务管理：start / stop / restart / status */
async function cmdService() {
  const action = args[1] ?? "status";
  const port = configuredPort();

  if (action === "status") {
    const st = daemonStatus();
    const health = await probeHealth(port);
    if (st.running && health.running) {
      say(`${C.ok("✓")} 后台服务运行中 (pid ${st.pid}, 端口 ${health.port})`);
    } else if (health.running) {
      say(`${C.ok("✓")} 桥接在端口 ${health.port} 响应，但不是本工具记录的后台进程`);
      say(C.dim(`  （可能是前台 start 启动的，或 PID 文件已丢失）`));
    } else {
      say(C.dim("后台服务未运行"));
      if (st.stale) say(C.dim(`  PID 文件指向的进程 ${st.pid} 已不存在`));
      if (st.foreign) say(C.warn(`  PID ${st.pid} 已被其它程序占用，已忽略`));
    }
    return;
  }

  if (action === "stop") {
    const r = stopDaemon();
    if (r.stopped) say(`${C.ok("✓")} 已停止后台服务 (pid ${r.pid})`);
    else say(C.dim(`未停止：${r.reason}`));
    return;
  }

  if (action === "restart") {
    const r = stopDaemon();
    if (r.stopped) { say(C.dim(`已停止旧进程 (pid ${r.pid})`)); await new Promise((x) => setTimeout(x, 1200)); }
    await cmdServiceStart(port);
    return;
  }

  if (action === "start") { await cmdServiceStart(port); return; }

  say(C.bad(`未知操作：${action}`));
  say(C.dim("用法：workbuddy-codex service <start|stop|restart|status>"));
}

async function cmdServiceStart(port) {
  const existing = daemonStatus();
  if (existing.running) {
    say(`${C.ok("✓")} 后台服务已在运行 (pid ${existing.pid})`);
    return;
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  const daemonArgs = ["start", "--daemon"];
  if (typeof flag("api-key") === "string") daemonArgs.push("--api-key", flag("api-key"));
  if (typeof flag("bridge-key") === "string") daemonArgs.push("--bridge-key", flag("bridge-key"));
  // 区域：显式给出时透传；否则守护进程会按凭据 domain 自行推断
  const region = flag("region");
  if (typeof region === "string") daemonArgs.push("--region", region);
  else if (process.env.WORKBUDDY_CODEX_REGION) daemonArgs.push("--region", process.env.WORKBUDDY_CODEX_REGION);
  else {
    const st = loadState();
    if (st?.region) daemonArgs.push("--region", st.region);
  }

  startDetached({ root, nodePath: process.execPath, args: daemonArgs, port });
  const health = await waitForHealth(port, 20000);
  if (!health) {
    say(C.bad("✗ 后台服务启动失败"));
    say(C.dim(`  日志：${LOG_FILE}`));
    process.exitCode = 1;
    return;
  }
  const pid = readPid();
  say(`${C.ok("✓")} 后台服务已启动${pid ? ` (pid ${pid})` : ""}，端口 ${port}`);
  say(C.dim("  本终端可以关闭，服务继续运行。"));
}

function cmdHelp() {
  say(`${C.bold("workbuddy-codex")} —— 把 WorkBuddy / CodeBuddy 模型接入任意 OpenAI Codex CLI

${C.bold("用法")}  workbuddy-codex <命令> [选项]

${C.bold("命令")}
  login       浏览器登录获取令牌（不依赖桌面端）
  install     一键接入 Codex：启动服务 + 写 ~/.codex/config.toml（含真实自检）
  uninstall   从 ~/.codex/config.toml 移除本工具的配置并还原原值
  autostart   安装开机自启，让桥接服务常驻（--remove 取消）
  start       只启动桥接服务（不碰 Codex 配置）
  doctor      诊断：凭据 / 上游连通性 / Codex 配置冲突
  models      列出当前凭据可用的模型
  status      显示当前状态

${C.bold("选项")}
  --region <cn|intl|auto>
                   区域：cn=中国区（默认），intl=国际版，auto=按凭据自动推断。
                   省略时按凭据里的 domain 自动判断，判断不出则用 cn。
  --port <n>       桥接端口（默认 8799；被占用时自动向后顺延）
  --model <id>     指定默认模型
  --api-key <key>  直接用 API Key（也可用环境变量 WORKBUDDY_API_KEY）
  --verbose        输出调试日志

${C.bold("区域")}
  cn    中国区        copilot.tencent.com / workbuddy.cn
  intl  国际版        codebuddy.ai / workbuddy.ai
  指定区域时会逐个探测候选主机，取第一个**真正能推理**的。
  国际版尚未实机验证（见 README「已知限制」）。

${C.bold("说明")}
  Codex 0.95.0+ 只支持 Responses API。本工具在本地做 Responses ⇄ Chat Completions
  双向转换，因此无需降级 Codex，也无需手动改 wire_api。
`);
}

// ---------------------------------------------------------------------------

switch (command) {
  case "login": await cmdLogin(); break;
  case "models": await cmdModels(); break;
  case "doctor": await cmdDoctor(); break;
  case "install": await cmdInstall(); break;
  case "uninstall": await cmdUninstall(); break;
  case "autostart": await cmdAutostart(); break;
  case "service": await cmdService(); break;
  case "status": await cmdStatus(); break;
  case "start": {
    // --daemon：作为分离进程启动（内部使用，由 startDetached 调用）
    if (has("daemon")) {
      const cred = resolveCredential();
      if (cred.kind === "none") { process.exitCode = 1; break; }
      // 区域由 CLI 通过 --region 传入（install 已解析好），这里不再重新推断，
      // 避免前台与后台得出不同结论
      const regionInfo = await resolveEffectiveEndpoints(cred);
      const { state, port: p } = await startServer({
        quiet: true, daemonChild: true, endpoints: regionInfo.endpoints,
      });
      try { state.cachedModels = await fetchModels(cred, { endpoints: regionInfo.endpoints }); } catch { /* ignore */ }
      log(`daemon 已就绪 port=${p} region=${regionInfo.region} pid=${process.pid}`);
      break;
    }

    // --detach：启动到后台，命令立即返回
    if (has("detach")) {
      await cmdServiceStart(actualConfiguredPort());
      break;
    }

    const cred = resolveCredential();
    if (cred.kind === "none") {
      say(C.bad("未找到凭据。请先 `workbuddy-codex login` 或设置 WORKBUDDY_API_KEY。"));
      process.exitCode = 1;
      break;
    }
    printCredInfo(cred);
    const regionInfo = await resolveEffectiveEndpoints(cred);
    sayRegion(regionInfo.region, regionInfo.source);
    const { state, port: p } = await startServer({ endpoints: regionInfo.endpoints });
    try {
      state.cachedModels = await fetchModels(cred, { endpoints: regionInfo.endpoints });
      say(C.dim(`  已加载 ${state.cachedModels.length} 个模型`));
    } catch { /* ignore */ }
    say(C.dim("\n按 Ctrl+C 停止。"));
    process.on("SIGINT", () => { say("\n已停止。"); process.exit(0); });
    break;
  }
  case "help":
  case "--help":
  case "-h":
  default:
    cmdHelp();
    break;
}
