/**
 * 凭据层测试：重点覆盖 DSH 凭据解析（YAML 折行标量）与加密信封判别。
 *   node --test "test/*.test.mjs"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isEncryptedField,
  unwrapField,
  findDshCredential,
  listCredentialCandidates,
  buildUpstreamHeaders,
  normalizeSession,
} from "../src/credentials.mjs";

/** 造一份会话 JSON（形状与真实一致）。 */
const session = (over = {}) => ({
  auth: {
    accessToken: "header.payload.signature-token-value-long-enough",
    refreshToken: "refresh-token-value",
    domain: "www.codebuddy.cn",
    expiresIn: 2419200,
    ...over.auth,
  },
  account: { userId: "user-123", displayName: "tester", ...over.account },
});

test("isEncryptedField 只认真实信封形态", () => {
  assert.equal(isEncryptedField({ $wbEncrypted: 1, envelope: "abc" }), true);
  assert.equal(isEncryptedField("plain-string"), false);
  assert.equal(isEncryptedField({ $wbEncrypted: 2, envelope: "abc" }), false);
  assert.equal(isEncryptedField({ $wbEncrypted: 1 }), false);
  assert.equal(isEncryptedField(null), false);
});

test("unwrapField 解不出加密信封（不逆向）", () => {
  assert.equal(unwrapField("plain"), "plain");
  assert.equal(unwrapField({ $wbEncrypted: 1, envelope: "abc" }), undefined);
});

test("buildUpstreamHeaders：令牌模式只发 Authorization，不发 x-api-key", () => {
  const s = normalizeSession(session());
  const h = buildUpstreamHeaders({ kind: "token", value: s.auth.accessToken, session: s });
  assert.ok(h.authorization?.startsWith("Bearer "), "应有 Bearer Authorization");
  assert.equal("x-api-key" in h, false, "令牌模式绝不能发 x-api-key（会 401）");
  assert.equal(h["X-User-Id"], "user-123");
  assert.equal(h["X-Domain"], "www.codebuddy.cn");
});

test("buildUpstreamHeaders：API Key 模式用 x-api-key", () => {
  const h = buildUpstreamHeaders({ kind: "api-key", value: "sk-test" });
  assert.equal(h["x-api-key"], "sk-test");
  assert.equal("authorization" in h, false);
});

// ---------------------------------------------------------------------------
// DSH 凭据：YAML 折行标量（真实踩过的坑）
// ---------------------------------------------------------------------------

function withTempDsh(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "wbcx-cred-"));
  const file = join(dir, "credentials.yaml");
  writeFileSync(file, content, "utf8");
  const prev = process.env.WORKBUDDY_DSH_CREDENTIALS;
  process.env.WORKBUDDY_DSH_CREDENTIALS = file;
  try { return fn(file); } finally {
    if (prev === undefined) delete process.env.WORKBUDDY_DSH_CREDENTIALS;
    else process.env.WORKBUDDY_DSH_CREDENTIALS = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("DSH 凭据：单行 JSON 能被解析", () => {
  const json = JSON.stringify(session());
  withTempDsh(`version: 1\nrefs:\n  WORKBUDDY_LOGIN_SESSION: '${json}'\n`, () => {
    const found = findDshCredential();
    assert.ok(found, "应找到 DSH 会话");
    assert.equal(found.session.account.userId, "user-123");
    assert.equal(found.session.auth.accessToken, session().auth.accessToken);
  });
});

test("DSH 凭据：折行 JSON 必须能重组（回归）", () => {
  // 模拟真实文件：长 JSON 被 YAML 折成多行，续行缩进更深。
  // 折行点必须落在 JSON 的**结构边界**（逗号后），与真实写入器一致。
  const json = JSON.stringify(session());
  const cut1 = json.indexOf(',"refreshToken"');
  assert.ok(cut1 > 0, "测试数据应包含 refreshToken 字段");
  const a = json.slice(0, cut1 + 1);
  const cut2 = json.indexOf(',"domain"');
  const b = json.slice(cut1 + 1, cut2 + 1);
  const c = json.slice(cut2 + 1);
  const content =
    `version: 1\n` +
    `refs:\n` +
    `  WORKBUDDY_LOGIN_SESSION: '${a}\n` +
    `    ${b}\n` +
    `    ${c}'\n` +
    `records:\n` +
    `  other:\n` +
    `    kind: grant\n`;

  withTempDsh(content, () => {
    const found = findDshCredential();
    assert.ok(found, "折行后仍应找到 DSH 会话（只读第一行会失败）");
    assert.equal(found.session.auth.accessToken, session().auth.accessToken,
      "token 必须完整，不能被截断或插入空格");
    assert.equal(found.session.auth.refreshToken, session().auth.refreshToken);
  });
});

test("DSH 凭据：折行落在 token 中间时，不应产出被插入空格的 token", () => {
  // 极端情况：写入器把 token 从中间断开。若只做 JSON.parse，
  // 空格连接会得到"可解析但 token 含空格"的结果 → 上游 401。
  // 本工具应优先选出不含空白的候选。
  const json = JSON.stringify(session());
  const tokenStart = json.indexOf('"accessToken":"') + '"accessToken":"'.length;
  const cut = tokenStart + 20;                       // 断在 token 中间
  const a = json.slice(0, cut);
  const b = json.slice(cut);
  const content = `refs:\n  WORKBUDDY_LOGIN_SESSION: '${a}\n    ${b}'\n`;

  withTempDsh(content, () => {
    const found = findDshCredential();
    assert.ok(found, "仍应解析出会话");
    assert.equal(/\s/.test(found.session.auth.accessToken), false,
      "选出的 token 不得含空白字符");
  });
});

test("DSH 凭据：外层是 sessions 数组时取 activeId 对应项", () => {
  const s1 = session({ account: { userId: "u1" } });
  const s2 = session({ account: { userId: "u2" } });
  const store = JSON.stringify({ version: 1, activeId: "id2", sessions: [
    { ...s1, id: "id1" }, { ...s2, id: "id2" },
  ] });
  withTempDsh(`refs:\n  WORKBUDDY_LOGIN_SESSION: '${store}'\n`, () => {
    const found = findDshCredential();
    assert.ok(found);
    assert.equal(found.session.account.userId, "u2", "应取 activeId 指向的会话");
  });
});

test("DSH 凭据：加密信封会被跳过而不是当成令牌", () => {
  const enc = JSON.stringify({
    auth: { accessToken: { $wbEncrypted: 1, envelope: "AAAA" }, refreshToken: "r" },
    account: { userId: "u" },
  });
  withTempDsh(`refs:\n  WORKBUDDY_LOGIN_SESSION: '${enc}'\n`, () => {
    assert.equal(findDshCredential(), null, "加密信封不应被当作可用凭据");
  });
});

test("DSH 凭据：文件缺失 / 损坏时返回 null 而不抛异常", () => {
  const prev = process.env.WORKBUDDY_DSH_CREDENTIALS;
  process.env.WORKBUDDY_DSH_CREDENTIALS = join(tmpdir(), "definitely-not-here-xyz.yaml");
  try {
    assert.equal(findDshCredential(), null);
  } finally {
    if (prev === undefined) delete process.env.WORKBUDDY_DSH_CREDENTIALS;
    else process.env.WORKBUDDY_DSH_CREDENTIALS = prev;
  }

  withTempDsh(`refs:\n  WORKBUDDY_LOGIN_SESSION: 'not valid json{{{'\n`, () => {
    assert.equal(findDshCredential(), null, "损坏的 JSON 应被跳过");
  });
});

test("候选列表去重且不包含无效项", () => {
  const json = JSON.stringify(session());
  withTempDsh(`refs:\n  WORKBUDDY_LOGIN_SESSION: '${json}'\n`, () => {
    const list = listCredentialCandidates({});
    const dshOnes = list.filter((c) => c.fromDsh);
    assert.equal(dshOnes.length, 1, "DSH 凭据只应出现一次");
    assert.ok(list.every((c) => c.kind === "api-key" || c.value), "候选不得为空值");
  });
});
