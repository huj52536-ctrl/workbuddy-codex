/**
 * credentials.mjs —— 凭据解析、持久化、自动刷新
 *
 * 支持三条凭据路径（按优先级）：
 *   1. API Key        —— 环境变量 WORKBUDDY_API_KEY / CODEBUDDY_API_KEY
 *   2. 本工具登录令牌 —— ~/.workbuddy-codex/session.json（内置浏览器 OAuth 流程）
 *   3. 外部会话注入   —— WORKBUDDY_SESSION_FILE（指向任意含 {auth:{accessToken}} 的 JSON）
 *
 * 关于桌面端凭据文件：
 *   部分版本的 CodeBuddy/WorkBuddy 桌面端把 token 存成 `$wbEncrypted` 加密信封
 *   （{ $wbEncrypted: 1, envelope: "<base64>" }），而非明文。本模块会**探测**这种
 *   形态并给出明确提示，而不是像某些实现那样静默失败（读出来是 undefined，
 *   最终表现为难以排查的 401）。加密信封需要桌面端自身的平台密钥才能解开，
 *   本工具不做逆向，改为引导用户走 API Key 或内置登录流程。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";

import {
  REGIONS, DEFAULT_REGION, endpointsFor, inferRegionFromDomain, resolveEndpoints,
} from "./region.mjs";

/**
 * 默认端点（中国区），保留这些常量是为了**向后兼容**：
 * 既有代码与测试都按 `copilot.tencent.com` 的形态引用它们。
 *
 * 需要其它区域时，走各 API 的 `endpoints` 选项（见 region.mjs），
 * 而不是改这些常量 —— 保持默认行为恒定，避免"改区域把老用户弄坏"。
 */
export const BACKEND = endpointsFor(DEFAULT_REGION).backend;
export const PLUGIN_BASE = endpointsFor(DEFAULT_REGION).pluginBase;
export const CONFIG_URL = endpointsFor(DEFAULT_REGION).configUrl;
export const CHAT_URL = endpointsFor(DEFAULT_REGION).chatUrl;
export const USER_AGENT = "CLI/unknown CodeBuddy/2.137.1";

export { REGIONS, DEFAULT_REGION, endpointsFor, inferRegionFromDomain, resolveEndpoints };

export const API_KEY_ENVS = ["WORKBUDDY_API_KEY", "CODEBUDDY_API_KEY"];
export const HOME_DIR = join(homedir(), ".workbuddy-codex");
export const SESSION_FILE = join(HOME_DIR, "session.json");
/** 记录上次选定的端口等运行时状态，保证端口在重启后稳定。 */
export const STATE_FILE = join(HOME_DIR, "state.json");

/** 读取运行时状态（缺失/损坏时返回空对象）。 */
export function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return {};
    const j = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch { return {}; }
}

/** 合并写入运行时状态。 */
export function saveState(patch) {
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    const next = { ...loadState(), ...patch, updatedAt: new Date().toISOString() };
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, STATE_FILE);
    return next;
  } catch { return null; }
}

const REQUEST_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  "user-agent": USER_AGENT,
  "x-product": "SaaS",
};

const NO_ACCOUNT_HEADERS = {
  "X-No-Authorization": "true",
  "X-No-User-Id": "true",
  "X-No-Enterprise-Id": "true",
  "X-No-Department-Info": "true",
};

/** 判断一个字段是不是加密信封（而非明文）。 */
export function isEncryptedField(value) {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    value.$wbEncrypted === 1 && typeof value.envelope === "string"
  );
}

/** 把可能是「明文」或「加密信封」的字段解出明文；加密时返回 undefined。 */
export function unwrapField(value) {
  if (typeof value === "string") return value;
  if (isEncryptedField(value)) return undefined;
  return undefined;
}

// ---------------------------------------------------------------------------
// 桌面端凭据文件探测（只用于「发现并提示」，不尝试解密）
// ---------------------------------------------------------------------------

export function desktopAuthCandidates() {
  const home = homedir();
  const list = [];
  const push = (p) => { if (p) list.push(p); };

  if (platform() === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    push(join(local, "CodeBuddyExtension", "Data", "Public", "auth"));
    push(join(local, "WorkBuddyExtension", "Data", "Public", "auth"));
  } else if (platform() === "darwin") {
    push(join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth"));
    push(join(home, "Library", "Application Support", "WorkBuddyExtension", "Data", "Public", "auth"));
  } else {
    const xdg = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
    push(join(xdg, "CodeBuddyExtension", "Data", "Public", "auth"));
    push(join(xdg, "WorkBuddyExtension", "Data", "Public", "auth"));
  }
  return list;
}

/**
 * 扫描桌面端凭据文件，报告是否可用（明文）或加密。
 * @returns {{path:string, readable:boolean, encrypted:boolean, reason?:string}[]}
 */
export function inspectDesktopCredentials() {
  const out = [];
  for (const dir of desktopAuthCandidates()) {
    if (!existsSync(dir)) continue;
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".info"));
    } catch { continue; }

    for (const f of files) {
      const full = join(dir, f);
      const rec = { path: full, readable: false, encrypted: false };
      try {
        const j = JSON.parse(readFileSync(full, "utf8"));
        const at = j?.auth?.accessToken;
        if (typeof at === "string" && at.length > 20) {
          rec.readable = true;
        } else if (isEncryptedField(at)) {
          rec.encrypted = true;
          rec.reason = "token 为 $wbEncrypted 加密信封，需桌面端平台密钥，本工具不逆向";
        } else {
          rec.reason = "未找到 accessToken 字段";
        }
      } catch (e) {
        rec.reason = `解析失败：${e.message}`;
      }
      out.push(rec);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 会话对象规范化
// ---------------------------------------------------------------------------

export function sessionNeedsRefresh(session, now = Date.now(), skewMs = 120_000) {
  const exp = Number(session?.auth?.expiresAt);
  if (Number.isFinite(exp) && exp > 0) return exp <= now + skewMs;
  // 退化：解析 JWT exp
  const tok = session?.auth?.accessToken;
  if (typeof tok === "string" && tok.includes(".")) {
    try {
      const payload = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString("utf8"));
      return Number.isFinite(payload.exp) ? payload.exp * 1000 <= now + skewMs : true;
    } catch { /* fallthrough */ }
  }
  return true;
}

function withExpiry(auth, now = Date.now()) {
  const out = { ...auth };
  if (!out.expiresAt && Number.isFinite(out.expiresIn)) out.expiresAt = now + out.expiresIn * 1000;
  if (!out.refreshExpiresAt && Number.isFinite(out.refreshExpiresIn)) out.refreshExpiresAt = now + out.refreshExpiresIn * 1000;
  return out;
}

/** 从 accessToken 的 JWT claims 里取账号标识（用于 X-User-Id / 企业头）。 */
function tokenClaims(token) {
  if (typeof token !== "string") return {};
  try {
    const p = token.split(".")[1];
    if (!p) return {};
    const j = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    return j && typeof j === "object" ? j : {};
  } catch { return {}; }
}

const firstText = (...vals) => {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
};

export function normalizeSession(session, { defaultDomain } = {}) {
  const auth = withExpiry(session?.auth ?? session ?? {});
  const acc = session?.account ?? session?.user ?? {};
  const claims = tokenClaims(auth.accessToken);
  const userId = firstText(acc.userId, acc.uid, acc.user_id, acc.id, claims.userId, claims.uid, claims.sub);
  const enterpriseId = firstText(acc.enterpriseId, acc.tenantId, acc.enterprise_id, claims.enterpriseId, claims.tenantId);
  // 回退域名随区域：国际版账号若凭据里没写 domain，不能错填成 .cn
  const domain = firstText(auth.domain, acc.domain, defaultDomain, endpointsFor(DEFAULT_REGION).defaultDomain);
  return {
    auth,
    account: { userId, enterpriseId, domain, displayName: firstText(acc.nickname, acc.displayName, acc.email) },
  };
}

// ---------------------------------------------------------------------------
// 上游请求头
// ---------------------------------------------------------------------------

/**
 * 构造上游请求头。
 *
 * 实测关键点：**令牌模式必须只发 Authorization，不能同时发 x-api-key**，
 * 同时发会得到 401 {"message":"not_found"}。
 * API Key 模式则用 x-api-key。
 */
export function buildUpstreamHeaders(credential) {
  const base = { ...REQUEST_HEADERS };

  if (credential.kind === "api-key") {
    return { ...base, "x-api-key": credential.value };
  }

  const s = credential.session;
  return {
    ...base,
    authorization: `Bearer ${credential.value}`,
    ...(s?.account?.userId ? { "X-User-Id": s.account.userId } : {}),
    ...(s?.account?.enterpriseId
      ? { "X-Enterprise-Id": s.account.enterpriseId, "X-Tenant-Id": s.account.enterpriseId }
      : {}),
    ...(s?.account?.domain ? { "X-Domain": s.account.domain } : {}),
  };
}

// ---------------------------------------------------------------------------
// 凭据解析
// ---------------------------------------------------------------------------

function readSessionFile(path) {
  const raw = readFileSync(path, "utf8");
  const j = JSON.parse(raw);
  if (Array.isArray(j?.sessions)) return normalizeSession(j.sessions.find((s) => s.id === j.activeId) ?? j.sessions[0]);
  return normalizeSession(j);
}

/**
 * 扫描桌面端凭据文件，返回**第一个可用的明文会话**。
 *
 * 注意：桌面端不同版本对 token 的存储方式不同 —— 有的是明文，
 * 有的是 `$wbEncrypted` 加密信封。这里只接受明文；
 * 加密文件会被跳过（不逆向），由调用方给出提示。
 *
 * 本函数**只读**，绝不回写桌面端文件。
 */
export function findDesktopCredential() {
  const encrypted = [];
  for (const dir of desktopAuthCandidates()) {
    if (!existsSync(dir)) continue;
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".info")).sort();
    } catch { continue; }

    for (const f of files) {
      const full = join(dir, f);
      let j;
      try { j = JSON.parse(readFileSync(full, "utf8")); } catch { continue; }

      const at = j?.auth?.accessToken;
      if (isEncryptedField(at)) { encrypted.push(full); continue; }
      if (typeof at !== "string" || at.length < 20) continue;

      // 明文：接受（即使已过期也有 refreshToken 兜底）
      const session = normalizeSession(j);
      return { session, path: full, encryptedCount: encrypted.length };
    }
  }
  return encrypted.length ? { session: null, path: null, encryptedCount: encrypted.length, encryptedPaths: encrypted } : null;
}

/**
 * 从 DSH（DeepSeek Harness）的凭据文件里读取 WorkBuddy 会话。
 *
 * 很多用户已经在 DSH 里登录过 WorkBuddy，那份会话通常是**新鲜且可用**的，
 * 而桌面端的旧 `.info` 文件可能早已失效（实测见过 expiresAt 写 2027、
 * 但 refreshToken 已作废的情况）。复用 DSH 会话可以让用户真正零配置接入。
 *
 * 只读，不改写 DSH 文件。不需要 YAML 依赖：目标值是一个 JSON 字符串标量，
 * 用定点提取即可（避免为一个小功能引入整个 YAML 解析器）。
 */
export function findDshCredential({ files } = {}) {
  // 显式 files > 环境变量（作为覆盖，不叠加默认路径）> 默认 ~/.dsh 位置。
  // 让环境变量成为**替代**而非追加，便于测试隔离与自定义部署。
  const candidates = files
    ?? (process.env.WORKBUDDY_DSH_CREDENTIALS
      ? [process.env.WORKBUDDY_DSH_CREDENTIALS]
      : [join(homedir(), ".dsh", ".credentials.yaml")]);

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }

    for (const key of ["WORKBUDDY_LOGIN_SESSION", "WORKBUDDY_LOGIN_SESSIONS", "CODEBUDDY_LOGIN_SESSION"]) {
      const candidates = extractYamlScalarCandidates(text, key);

      // 依次尝试候选，取第一个**解析成功且 token 形状合理**的。
      // 仅靠 JSON.parse 不够：若写入器在 token 中间断行，空格连接会产出一个
      // "能解析但 token 被插入空格"的结果，最终表现为难以定位的 401。
      // 因此优先选择 accessToken 不含空白字符的候选。
      let parsed = null;
      let fallback = null;
      for (const raw of candidates) {
        let j;
        try { j = JSON.parse(raw); } catch { continue; }
        const token = j?.auth?.accessToken ?? j?.sessions?.[0]?.auth?.accessToken;
        if (typeof token !== "string") continue;
        if (!/\s/.test(token)) { parsed = j; break; }   // 形状合理 → 采用
        if (!fallback) fallback = j;                    // 含空白 → 仅作兜底
      }
      parsed = parsed ?? fallback;
      if (!parsed) continue;

      // 可能是 {auth,account} 或 {version,activeId,sessions:[...]}
      let session = parsed;
      if (Array.isArray(parsed?.sessions) && parsed.sessions.length) {
        session = parsed.sessions.find((s) => s.id === parsed.activeId) ?? parsed.sessions[0];
      } else if (Array.isArray(parsed)) {
        session = parsed[0];
      }
      if (typeof session?.auth?.accessToken !== "string") continue;

      const normalized = normalizeSession(session);
      return { session: normalized, path: file, key };
    }
  }
  return null;
}

/**
 * 从 YAML 文本中提取形如 `KEY: value` 的标量值。
 *
 * 必须处理 **折行标量**（folded scalar）：DSH 写出的长 JSON 会被 YAML
 * 折成多行，缩进更深的后续行属于同一个值。只读第一行会得到被截断的
 * JSON，JSON.parse 必然失败——这正是本函数要避免的坑。
 *
 * 返回**候选值数组**（按可信度排序）：
 *   1. 空格连接 —— YAML 折行的正确语义（单个换行折叠为一个空格）
 *   2. 无分隔连接 —— 兜底：应对某些写入器在 token 中间断行的情况
 *
 * 交由调用方按顺序尝试解析，取第一个成功的，避免因写入器差异导致失败。
 */
function extractYamlScalarCandidates(text, key) {
  const lines = text.split(/\r?\n/);
  const startRe = new RegExp(`^(\\s*)${key}[ \\t]*:[ \\t]*(.*)$`);

  let startIdx = -1;
  let indent = "";
  let first = "";
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(startRe);
    if (m) { startIdx = i; indent = m[1]; first = m[2]; break; }
  }
  if (startIdx === -1) return [];

  // 收集本值的全部物理行：后续行缩进必须**深于**键的缩进，
  // 且不能是新的同级/上级键。
  const parts = [first];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") { parts.push(""); continue; }
    const lead = line.match(/^\s*/)[0];
    if (lead.length <= indent.length) break;      // 回到同级或更外层 → 值结束
    parts.push(line.trim());                       // 续行去掉缩进
  }

  const strip = (s) => {
    if (!s) return "";
    if (s.startsWith("'")) return (s.endsWith("'") && s.length >= 2 ? s.slice(1, -1) : s.slice(1)).replace(/''/g, "'");
    if (s.startsWith('"')) return (s.endsWith('"') && s.length >= 2 ? s.slice(1, -1) : s.slice(1))
      .replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    return s;
  };

  const out = [];
  for (const sep of [" ", ""]) {
    const v = strip(parts.join(sep).trim());
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 列出所有**候选**凭据来源（按优先级），供安装器逐个验证后取第一个可用的。
 * 这比"取第一个存在的"更可靠：实测存在「能列模型但推理 401」的失效来源。
 */
export function listCredentialCandidates({ explicitKey } = {}) {
  const out = [];
  const push = (c) => {
    if (!c || c.kind === "none") return;
    if (out.some((x) => x.kind === c.kind && x.value === c.value)) return;
    out.push(c);
  };

  const key = explicitKey || API_KEY_ENVS.map((e) => process.env[e]).find(Boolean);
  if (key) push({ kind: "api-key", value: key.trim(), source: explicitKey ? "cli" : "env" });

  const ext = process.env.WORKBUDDY_SESSION_FILE;
  if (ext && existsSync(ext)) {
    try {
      const s = readSessionFile(ext);
      const v = unwrapField(s?.auth?.accessToken);
      if (v) push({ kind: "token", value: v, session: s, source: ext });
    } catch { /* 跳过损坏文件 */ }
  }

  if (existsSync(SESSION_FILE)) {
    try {
      const s = readSessionFile(SESSION_FILE);
      const v = unwrapField(s?.auth?.accessToken);
      if (v) push({ kind: "token", value: v, session: s, source: SESSION_FILE });
    } catch { /* ignore */ }
  }

  const dsh = findDshCredential();
  if (dsh) {
    const v = unwrapField(dsh.session.auth?.accessToken);
    if (v) push({ kind: "token", value: v, session: dsh.session, source: `dsh:${dsh.path}`, fromDsh: true });
  }

  const desktop = findDesktopCredential();
  if (desktop?.session) {
    const v = unwrapField(desktop.session.auth?.accessToken);
    if (v) push({ kind: "token", value: v, session: desktop.session, source: `desktop:${desktop.path}`, fromDesktop: true });
  }

  return out;
}

/**
 * 解析当前可用凭据。
 *
 * 优先级：
 *   1. 显式 API Key（--api-key）
 *   2. 环境变量 WORKBUDDY_API_KEY / CODEBUDDY_API_KEY
 *   3. WORKBUDDY_SESSION_FILE 指定的会话文件
 *   4. 本工具自己的会话（~/.workbuddy-codex/session.json）
 *   5. DSH 中已登录的 WorkBuddy 会话（只读）
 *   6. 桌面端明文凭据文件（只读，不回写）
 *
 * @returns {{kind:"api-key"|"token"|"none", value:string, session?:object, source:string}}
 */
export function resolveCredential({ explicitKey, useDesktop = true } = {}) {
  const list = listCredentialCandidates({ explicitKey });
  if (!useDesktop) {
    const filtered = list.filter((c) => !c.fromDesktop && !c.fromDsh);
    if (filtered.length) return filtered[0];
    return { kind: "none", value: "", source: "none" };
  }
  return list[0] ?? { kind: "none", value: "", source: "none" };
}

/** 保存会话到本工具目录（权限收紧到仅当前用户）。 */
export function saveSession(session) {
  mkdirSync(HOME_DIR, { recursive: true });
  const normalized = normalizeSession(session);
  const tmp = `${SESSION_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(normalized, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, SESSION_FILE);
  try { chmodSync(SESSION_FILE, 0o600); } catch { /* Windows 上可能不支持 */ }
  return normalized;
}

export function loadSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try { return readSessionFile(SESSION_FILE); } catch { return null; }
}

// ---------------------------------------------------------------------------
// 刷新
// ---------------------------------------------------------------------------

async function postJson(url, { headers, body = "{}", timeoutMs = 20_000 } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...REQUEST_HEADERS, ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let j = null;
  try { j = await res.json(); } catch { /* non-json */ }
  return { status: res.status, ok: res.ok, body: j };
}

async function getJson(url, { headers, timeoutMs = 20_000 } = {}) {
  const res = await fetch(url, { headers: { ...REQUEST_HEADERS, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  let j = null;
  try { j = await res.json(); } catch { /* non-json */ }
  return { status: res.status, ok: res.ok, body: j };
}

/** 用 refreshToken 换新令牌。 */
export async function refreshSession(session, { persist = true, endpoints } = {}) {
  const ep = endpoints ?? endpointsFor(DEFAULT_REGION);
  const refreshToken = unwrapField(session?.auth?.refreshToken);
  if (!refreshToken) throw new Error("会话缺少 refreshToken，请重新登录");

  const enterpriseId = session.account?.enterpriseId;
  const headers = {
    ...(enterpriseId ? { "X-Enterprise-Id": enterpriseId, "X-Tenant-Id": enterpriseId } : {}),
    ...(session.account?.domain ? { "X-Domain": session.account.domain } : {}),
    "X-Refresh-Token": refreshToken,
    "X-Auth-Refresh-Source": "plugin",
  };

  const r = await postJson(`${ep.pluginBase}/auth/token/refresh`, { headers });
  if (!r.ok || r.body?.code !== 0 || !r.body?.data) {
    throw new Error(`刷新令牌失败：HTTP ${r.status} ${r.body?.msg ?? r.body?.message ?? ""}`);
  }
  const fresh = withExpiry(r.body.data);
  const merged = {
    auth: { ...session.auth, ...fresh, refreshToken: fresh.refreshToken ?? refreshToken },
    account: session.account,
  };
  const normalized = normalizeSession(merged);
  if (persist && existsSync(SESSION_FILE)) saveSession(normalized);
  return normalized;
}

// ---------------------------------------------------------------------------
// 内置登录流程（浏览器 OAuth，不依赖桌面端）
// ---------------------------------------------------------------------------

function openBrowser(url) {
  const [cmd, args] = platform() === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : platform() === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return true;
  } catch { return false; }
}

/**
 * 交互式登录。返回并保存会话。
 * @param {{onUrl?:(url:string,opened:boolean)=>void, signal?:AbortSignal,
 *          timeoutMs?:number, endpoints?:object}} opts
 */
export async function loginWorkBuddy({ onUrl, signal, timeoutMs = 10 * 60_000, endpoints } = {}) {
  const ep = endpoints ?? endpointsFor(DEFAULT_REGION);
  const state = await postJson(`${ep.pluginBase}/auth/state?platform=CLI`, { headers: NO_ACCOUNT_HEADERS });
  const st = state.body?.data;
  if (!st?.state || !st?.authUrl) {
    throw new Error(`创建登录会话失败：HTTP ${state.status} ${state.body?.msg ?? state.body?.message ?? ""}`);
  }
  const opened = openBrowser(st.authUrl);
  onUrl?.(st.authUrl, opened);

  const deadline = Date.now() + timeoutMs;
  let auth = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("登录已取消");
    await new Promise((r) => setTimeout(r, 1500));
    const r = await getJson(`${ep.pluginBase}/auth/token?state=${encodeURIComponent(st.state)}`, { headers: NO_ACCOUNT_HEADERS });
    if (r.ok && r.body?.code === 0 && r.body?.data) { auth = withExpiry(r.body.data); break; }
    if (r.status === 401 || r.status === 403) throw new Error(`登录被拒绝：HTTP ${r.status}`);
  }
  if (!auth?.accessToken) throw new Error("等待登录超时，请重试");

  // 取账号信息
  let account = {};
  const accHeaders = {
    ...(auth.domain ? { "X-Domain": auth.domain } : {}),
    authorization: `Bearer ${auth.accessToken}`,
    "X-No-User-Id": "true",
    "X-No-Enterprise-Id": "true",
    "X-No-Department-Info": "true",
  };
  try {
    const a = await getJson(`${ep.pluginBase}/login/account?state=${encodeURIComponent(st.state)}`, { headers: accHeaders });
    if (a.ok && a.body?.code === 0 && a.body?.data) account = a.body.data;
  } catch { /* 账号信息非必需 */ }

  return saveSession({ auth, account });
}

// ---------------------------------------------------------------------------
// 模型目录
// ---------------------------------------------------------------------------

/**
 * 取当前凭据可用的模型。
 *
 * 必须用 agents[name=cli].models 与 data.models 关联过滤：
 * data.models 是平台超集，直接暴露会包含当前 Key/账号无权的模型。
 *
 * 注意：`/v3/config` 的鉴权比推理端点**宽松**。存在这种情况：
 * 令牌能列出模型、但推理端点返回 401。因此本函数不能作为
 * "凭据可用"的证明 —— 必须另外用 verifyInference() 验证。
 */
export async function fetchModels(credential, { timeoutMs = 20_000, endpoints } = {}) {
  const ep = endpoints ?? endpointsFor(DEFAULT_REGION);
  const headers = buildUpstreamHeaders(credential);
  const res = await fetch(ep.configUrl, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`模型目录 HTTP ${res.status}`);
  const body = await res.json();
  if (body?.code !== 0) throw new Error(`模型目录业务错误：${body?.msg ?? body?.code}`);

  const data = body.data ?? {};
  const agents = Array.isArray(data.agents) ? data.agents : data.agent?.agents;
  const allowed = agents?.find((a) => a?.name === "cli")?.models ?? [];
  const byId = new Map((data.models ?? []).map((m) => [m.id, m]));

  const models = [];
  for (const id of allowed) {
    const m = byId.get(id);
    if (!m) continue;
    const ctx = m.maxInputTokens ?? m.maxAllowedSize;
    const maxOut = m.maxOutputTokens;
    if (!Number.isSafeInteger(ctx) || !Number.isSafeInteger(maxOut)) continue;
    models.push({
      id,
      name: m.name ?? id,
      contextWindow: ctx,
      maxOutputTokens: maxOut,
      supportsImages: m.supportsImages === true,
      supportsReasoning: m.supportsReasoning === true,
      onlyReasoning: m.onlyReasoning === true,
      defaultReasoningEffort: m.reasoning?.effort,
    });
  }
  return models;
}

/**
 * 真正验证凭据能否用于**推理**（而不仅是列模型）。
 *
 * 为什么需要：`/v3/config` 会用宽松策略接受某些已失效的令牌，
 * 于是出现"能列出 18 个模型、一推理就 401"的误导性状态。
 * 返回结构化结果，便于 CLI 给出可行动的指引。
 *
 * @returns {{ok:boolean, status?:number, reason?:string, hint?:string}}
 */
export async function verifyInference(credential, { model, timeoutMs = 60_000, endpoints } = {}) {
  const ep = endpoints ?? endpointsFor(DEFAULT_REGION);
  const headers = buildUpstreamHeaders(credential);
  headers.accept = "text/event-stream";
  const body = {
    model: model ?? "auto",
    messages: [{ role: "user", content: "ping" }],
    stream: true,
    max_tokens: 4,
  };

  let res;
  try {
    res = await fetch(ep.chatUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, reason: `网络错误：${e.message}`, hint: "检查网络或代理设置。" };
  }

  if (res.status === 200) return { ok: true, status: 200, endpoint: ep.backend };

  const text = await res.text().catch(() => "");
  const short = text.slice(0, 200).replace(/\s+/g, " ");

  if (res.status === 401 || res.status === 403) {
    const isOpenresty = /openresty|Authorization Required/i.test(text);
    return {
      ok: false,
      status: res.status,
      endpoint: ep.backend,
      reason: `推理端点鉴权失败（HTTP ${res.status}）`,
      hint: isOpenresty
        ? "该令牌能列出模型，但推理时被拒。这通常意味着**令牌已实际失效**" +
          "（例如来自桌面端的旧会话文件），或账号在别处重新登录过导致旧令牌作废。" +
          "解决办法：运行 `workbuddy-codex login` 重新登录，或设置 WORKBUDDY_API_KEY。" +
          "若这是国际版账号，请确认已用 --region intl。"
        : "令牌模式请确认**只**发送 Authorization（不要同时发 x-api-key）；" +
          "否则请重新登录或改用 API Key。",
      detail: short,
    };
  }

  // 404 常见于「区域选错」：路径对但主机不对
  if (res.status === 404) {
    return {
      ok: false,
      status: 404,
      endpoint: ep.backend,
      reason: `推理端点不存在（HTTP 404 @ ${ep.backend}）`,
      hint: "该主机上没有 /v2/chat/completions。若你的账号属于另一个区域，" +
        "请用 `--region cn` 或 `--region intl` 指定。",
      detail: short,
    };
  }

  return { ok: false, status: res.status, endpoint: ep.backend, reason: `推理端点返回 HTTP ${res.status}`, detail: short };
}

export { REQUEST_HEADERS, NO_ACCOUNT_HEADERS, postJson, getJson };
