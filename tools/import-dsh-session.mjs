/**
 * import-dsh-session.mjs —— 把 DSH 里已登录的 WorkBuddy 会话导入本工具。
 *
 * 用途：如果你已经在 DeepSeek Harness（DSH）里登录过 WorkBuddy，
 * 可以用这个脚本把那份会话固化成 `~/.workbuddy-codex/session.json`。
 *
 * 其实 `workbuddy-codex install` 会自动发现并使用 DSH 会话（只读），
 * **通常不需要运行本脚本**。它适用于：
 *   - 想把 DSH 会话固定下来，之后即使 DSH 卸载也能继续用；
 *   - 排查「为什么我的 DSH 会话没被识别」。
 *
 * 说明：DSH 把凭据写在 `~/.dsh/.credentials.yaml`，其中供 WorkBuddy 使用的
 * 键是 `WORKBUDDY_LOGIN_SESSION`（可能带旧名 `CODEBUDDY_LOGIN_SESSION`）。
 * 该值是一个 JSON 字符串，长内容会被 YAML 折成多行。
 *
 * 全程不打印任何令牌内容。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { saveSession, HOME_DIR, SESSION_FILE, normalizeSession } from "../src/credentials.mjs";

const argPath = process.argv[2];
const credPath = argPath ?? join(homedir(), ".dsh", ".credentials.yaml");

if (!existsSync(credPath)) {
  console.error(`找不到 DSH 凭据文件：${credPath}`);
  console.error("用法：node tools/import-dsh-session.mjs [credentials.yaml 路径]");
  process.exit(1);
}

/** 提取 YAML 折行标量（与 src/credentials.mjs 中同源的简化版）。 */
function extractScalar(text, key) {
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^(\\s*)${key}[ \\t]*:[ \\t]*(.*)$`);
  let start = -1, indent = "", first = "";
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) { start = i; indent = m[1]; first = m[2]; break; }
  }
  if (start === -1) return null;

  const parts = [first];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") { parts.push(""); continue; }
    if (l.match(/^\s*/)[0].length <= indent.length) break;
    parts.push(l.trim());
  }
  const strip = (s) => {
    const v = s.trim();
    if (v.startsWith("'")) return (v.endsWith("'") && v.length >= 2 ? v.slice(1, -1) : v.slice(1)).replace(/''/g, "'");
    if (v.startsWith('"')) return (v.endsWith('"') && v.length >= 2 ? v.slice(1, -1) : v.slice(1)).replace(/\\"/g, '"');
    return v;
  };
  // 依次尝试空格连接与无分隔连接，取第一个能解析且 token 无空白的
  const out = [];
  for (const sep of [" ", ""]) out.push(strip(parts.join(sep)));
  return out;
}

const text = readFileSync(credPath, "utf8");
const KEYS = ["WORKBUDDY_LOGIN_SESSION", "WORKBUDDY_LOGIN_SESSIONS", "CODEBUDDY_LOGIN_SESSION"];

let session = null;
for (const key of KEYS) {
  const cands = extractScalar(text, key);
  if (!cands) continue;
  for (const c of cands) {
    let j;
    try { j = JSON.parse(c); } catch { continue; }
    let s = j;
    if (Array.isArray(j?.sessions) && j.sessions.length) {
      s = j.sessions.find((x) => x.id === j.activeId) ?? j.sessions[0];
    } else if (Array.isArray(j)) s = j[0];
    const token = s?.auth?.accessToken;
    if (typeof token === "string" && !/\s/.test(token)) { session = s; break; }
  }
  if (session) break;
}

if (!session) {
  console.error(`在 ${credPath} 中未找到可用的 WorkBuddy 会话。`);
  console.error("请先在 DSH 里登录 WorkBuddy，或改用 workbuddy-codex login / WORKBUDDY_API_KEY。");
  process.exit(1);
}

const normalized = saveSession(session);
console.log("已导入 DSH 会话");
console.log(`  目标文件: ${SESSION_FILE}`);
console.log(`  账号    : ${normalized.account?.displayName ?? normalized.account?.userId ?? "未知"}`);
console.log(`  到期    : ${normalized.auth?.expiresAt ? new Date(Number(normalized.auth.expiresAt)).toISOString() : "未知"}`);
console.log("（未打印任何令牌内容）");
