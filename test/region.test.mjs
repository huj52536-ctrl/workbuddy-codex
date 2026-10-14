/**
 * 区域与端点解析测试。
 *   node --test "test/*.test.mjs"
 *
 * 重点：确保**默认行为与改造前完全一致**（中国区、copilot.tencent.com），
 * 避免"加区域支持把老用户弄坏"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REGIONS, DEFAULT_REGION, endpointsFor, endpointsAt,
  inferRegionFromDomain, normalizeRegionId, resolveEndpoints, probeHosts,
} from "../src/region.mjs";
import { CHAT_URL, CONFIG_URL, BACKEND, normalizeSession } from "../src/credentials.mjs";

// ---------------------------------------------------------------------------
// 向后兼容：默认必须与改造前一致
// ---------------------------------------------------------------------------

test("默认端点常量保持不变（改造前后必须一致）", () => {
  assert.equal(BACKEND, "https://copilot.tencent.com");
  assert.equal(CHAT_URL, "https://copilot.tencent.com/v2/chat/completions");
  assert.equal(CONFIG_URL, "https://copilot.tencent.com/v3/config");
});

test("DEFAULT_REGION 是中国区", () => {
  assert.equal(DEFAULT_REGION, "cn");
  assert.equal(endpointsFor().region, "cn");
  assert.equal(endpointsFor().backend, "https://copilot.tencent.com");
});

test("endpointsFor 生成三个一致的 URL", () => {
  const ep = endpointsFor("cn");
  assert.equal(ep.pluginBase, `${ep.backend}/v2/plugin`);
  assert.equal(ep.configUrl, `${ep.backend}/v3/config`);
  assert.equal(ep.chatUrl, `${ep.backend}/v2/chat/completions`);
});

// ---------------------------------------------------------------------------
// 区域定义
// ---------------------------------------------------------------------------

test("cn 与 intl 都有可用主机与默认域", () => {
  for (const id of ["cn", "intl"]) {
    const r = REGIONS[id];
    assert.ok(Array.isArray(r.hosts) && r.hosts.length > 0, `${id} 应有 hosts`);
    assert.ok(r.defaultDomain, `${id} 应有 defaultDomain`);
    assert.ok(r.domainPatterns.length > 0, `${id} 应有 domainPatterns`);
  }
});

test("intl 主机包含 codebuddy.ai / workbuddy.ai（依据 CLI 的 isInternationalEndpoint）", () => {
  const hosts = REGIONS.intl.hosts.join(" ");
  assert.match(hosts, /codebuddy\.ai/);
  assert.match(hosts, /workbuddy\.ai/);
});

test("cn 主机来自 product.json 的 officialEndpoints", () => {
  const hosts = REGIONS.cn.hosts.join(" ");
  assert.match(hosts, /copilot\.tencent\.com/);
  assert.match(hosts, /workbuddy\.cn/);
  assert.match(hosts, /tencentbuddy\.com/);
});

// ---------------------------------------------------------------------------
// 域名推断
// ---------------------------------------------------------------------------

test("从 domain 正确推断区域", () => {
  for (const [domain, want] of [
    ["www.codebuddy.cn", "cn"],
    ["www.workbuddy.cn", "cn"],
    ["wb.tencentbuddy.com", "cn"],
    ["copilot.tencent.com", "cn"],
    ["www.codebuddy.ai", "intl"],
    ["www.workbuddy.ai", "intl"],
    ["codebuddy.ai", "intl"],
  ]) {
    const r = inferRegionFromDomain(domain);
    assert.equal(r.region, want, `${domain} 应推断为 ${want}，实际 ${r.region}`);
    assert.equal(r.matched, true);
  }
});

test("未知 / 缺失 domain 回落到中国区（不报错）", () => {
  for (const d of ["example.com", "", null, undefined, "   "]) {
    const r = inferRegionFromDomain(d);
    assert.equal(r.region, "cn");
    assert.equal(r.matched, false);
  }
});

test("域匹配大小写不敏感，且不误匹配相似域名（如 notcodebuddy.cn）", () => {
  assert.equal(inferRegionFromDomain("WWW.CodeBuddy.CN").region, "cn");
  // 子域匹配用 (^|\.) 锚定，避免 evilcodebuddy.cn 被误判
  assert.equal(inferRegionFromDomain("evilcodebuddy.cn").matched, false);
  assert.equal(inferRegionFromDomain("codebuddy.cn.evil.com").matched, false);
});

// ---------------------------------------------------------------------------
// 显式区域
// ---------------------------------------------------------------------------

test("normalizeRegionId 接受常见别名", () => {
  assert.equal(normalizeRegionId("cn"), "cn");
  assert.equal(normalizeRegionId("CN"), "cn");
  assert.equal(normalizeRegionId("china"), "cn");
  assert.equal(normalizeRegionId("国内"), "cn");
  assert.equal(normalizeRegionId("intl"), "intl");
  assert.equal(normalizeRegionId("global"), "intl");
  assert.equal(normalizeRegionId("international"), "intl");
  assert.equal(normalizeRegionId("国际"), "intl");
  assert.equal(normalizeRegionId("auto"), "auto");
  assert.equal(normalizeRegionId("bogus"), null);
  assert.equal(normalizeRegionId(undefined), null);
});

test("显式区域优先于 domain 推断", () => {
  const r = resolveEndpoints({ explicitRegion: "intl", domain: "www.codebuddy.cn" });
  assert.equal(r.region, "intl");
  assert.equal(r.source, "explicit");
  assert.match(r.endpoints.backend, /\.ai$/);
});

test("auto 等同「按 domain 推断」", () => {
  const r = resolveEndpoints({ explicitRegion: "auto", domain: "www.codebuddy.ai" });
  assert.equal(r.region, "intl");
  assert.equal(r.source, "credential-domain");
});

test("无显式区域时按 domain 推断", () => {
  const cn = resolveEndpoints({ domain: "www.codebuddy.cn" });
  assert.equal(cn.region, "cn");
  assert.equal(cn.source, "credential-domain");

  const intl = resolveEndpoints({ domain: "www.codebuddy.ai" });
  assert.equal(intl.region, "intl");
  assert.equal(intl.source, "credential-domain");
});

test("完全没有线索时回落到 cn 且标记为 default", () => {
  const r = resolveEndpoints({});
  assert.equal(r.region, "cn");
  assert.equal(r.source, "default");
});

// ---------------------------------------------------------------------------
// endpointsAt
// ---------------------------------------------------------------------------

test("endpointsAt 可把端点指向任意主机（用于探测）", () => {
  const ep = endpointsAt("intl", "https://staging.example.com/");
  assert.equal(ep.backend, "https://staging.example.com");   // 去掉尾斜杠
  assert.equal(ep.chatUrl, "https://staging.example.com/v2/chat/completions");
  assert.equal(ep.region, "intl");
});

// ---------------------------------------------------------------------------
// 主机探测
// ---------------------------------------------------------------------------

test("probeHosts 取第一个成功的主机", async () => {
  const seen = [];
  const r = await probeHosts({
    hosts: ["https://a.test", "https://b.test", "https://c.test"],
    region: "cn",
    probe: async (ep) => {
      seen.push(ep.backend);
      return { ok: ep.backend === "https://b.test" };
    },
  });
  assert.equal(r.endpoints.backend, "https://b.test");
  assert.deepEqual(seen, ["https://a.test", "https://b.test"], "成功后应停止探测");
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].ok, false);
  assert.equal(r.attempts[1].ok, true);
});

test("probeHosts 全部失败时返回 null 并保留每次原因", async () => {
  const r = await probeHosts({
    hosts: ["https://a.test", "https://b.test"],
    region: "cn",
    probe: async (ep) => ({ ok: false, reason: `nope ${ep.backend}` }),
  });
  assert.equal(r.endpoints, null);
  assert.equal(r.attempts.length, 2);
  assert.match(r.attempts[0].reason, /a\.test/);
});

test("probeHosts 遇 probe 抛异常时不中断（继续下一个）", async () => {
  const r = await probeHosts({
    hosts: ["https://bad.test", "https://good.test"],
    region: "cn",
    probe: async (ep) => {
      if (ep.backend.includes("bad")) throw new Error("boom");
      return { ok: true };
    },
  });
  assert.equal(r.endpoints.backend, "https://good.test");
  assert.equal(r.attempts[0].ok, false);
  assert.match(r.attempts[0].reason, /boom/);
});

// ---------------------------------------------------------------------------
// normalizeSession 的默认域随区域
// ---------------------------------------------------------------------------

test("normalizeSession 默认域可指定（国际版不应错填成 .cn）", () => {
  const s = normalizeSession({ auth: { accessToken: "a" }, account: {} }, {
    defaultDomain: "www.codebuddy.ai",
  });
  assert.equal(s.account.domain, "www.codebuddy.ai");
});

test("normalizeSession 未指定 defaultDomain 时仍回落 .cn（向后兼容）", () => {
  const s = normalizeSession({ auth: { accessToken: "a" }, account: {} });
  assert.equal(s.account.domain, "www.codebuddy.cn");
});

test("normalizeSession 尊重凭据里已有的 domain", () => {
  const s = normalizeSession({ auth: { accessToken: "a", domain: "www.codebuddy.ai" }, account: {} });
  assert.equal(s.account.domain, "www.codebuddy.ai");
});
