/**
 * region.mjs —— 区域（国内版 / 国际版）与端点解析
 *
 * ── 背景 ──────────────────────────────────────────────────────────────
 * WorkBuddy / CodeBuddy 有国内版与国际版。从本机 CLI 包读到的证据表明：
 *
 *   1. 同一份客户端要对多个主机工作（product.json 的 officialEndpoints
 *      同时列了 workbuddy.cn / copilot.tencent.com / codebuddy.ai 等）；
 *   2. 区域判定只比对**主机名**（CLI 的 isInternationalEndpoint）：
 *        ["codebuddy.ai", "workbuddy.ai", "staging-codebuddy.tencent.com"]
 *   3. API 路径与区域无关：`/v3/config` 是版本探测数组
 *        ["/v1/config","/v2/config","/v3/config", ...]
 *      而聊天地址只是给 base 补 `/chat/completions`
 *        （normalizeChatCompletionsUrl 的语义）
 *
 * 结论：**协议层可原样复用，差异只在主机名**。因此把主机抽成区域配置即可。
 *
 * ── 设计原则 ──────────────────────────────────────────────────────────
 *   - 默认行为与改造前**完全一致**（CN，主机 copilot.tencent.com）
 *   - 区域默认从凭据里的 domain 推断，而不是让用户手挑
 *   - 推断不出来时回落到 CN（保持向后兼容，不让老用户受影响）
 *   - 纯函数，无网络副作用，便于单测
 */

/** 区域定义。hosts 按优先级排列，第一个成功的会被采用。 */
export const REGIONS = {
  cn: {
    id: "cn",
    label: "WorkBuddy 中国区",
    // 顺序与 product.json 的 officialEndpoints 一致：
    // copilot.tencent.com 是实际提供模型目录与推理的备用主域
    hosts: [
      "https://copilot.tencent.com",
      "https://www.workbuddy.cn",
      "https://wb.tencentbuddy.com",
    ],
    defaultDomain: "www.codebuddy.cn",
    // 用于从凭据 domain 反推区域
    domainPatterns: [
      /(^|\.)codebuddy\.cn$/i,
      /(^|\.)workbuddy\.cn$/i,
      /(^|\.)tencentbuddy\.com$/i,
      /(^|\.)copilot\.tencent\.com$/i,
    ],
  },
  intl: {
    id: "intl",
    label: "CodeBuddy / WorkBuddy 国际版",
    // 依据：product.json 的 officialEndpoints 含 www.codebuddy.ai；
    // CLI 的 isInternationalEndpoint 额外认 codebuddy.ai / workbuddy.ai。
    // 两者都列入，由探测决定哪个可用。
    hosts: [
      "https://www.codebuddy.ai",
      "https://www.workbuddy.ai",
    ],
    defaultDomain: "www.codebuddy.ai",
    domainPatterns: [
      /(^|\.)codebuddy\.ai$/i,
      /(^|\.)workbuddy\.ai$/i,
    ],
  },
};

export const DEFAULT_REGION = "cn";

/** 某区域的端点集合。 */
export function endpointsFor(regionId) {
  const r = REGIONS[regionId] ?? REGIONS[DEFAULT_REGION];
  const backend = r.hosts[0];
  return {
    region: r.id,
    label: r.label,
    hosts: r.hosts,
    backend,
    pluginBase: `${backend}/v2/plugin`,
    configUrl: `${backend}/v3/config`,
    chatUrl: `${backend}/v2/chat/completions`,
    defaultDomain: r.defaultDomain,
  };
}

/** 把任意 host 换成指定 base。 */
export function endpointsAt(regionId, base) {
  const r = REGIONS[regionId] ?? REGIONS[DEFAULT_REGION];
  const b = String(base).replace(/\/+$/, "");
  return {
    region: r.id,
    label: r.label,
    hosts: r.hosts,
    backend: b,
    pluginBase: `${b}/v2/plugin`,
    configUrl: `${b}/v3/config`,
    chatUrl: `${b}/v2/chat/completions`,
    defaultDomain: r.defaultDomain,
  };
}

/**
 * 从凭据里的 domain 推断区域。
 *
 * @param {string|undefined} domain 例如 "www.codebuddy.cn" / "www.codebuddy.ai"
 * @returns {{region:string, matched:boolean, reason:string}}
 */
export function inferRegionFromDomain(domain) {
  if (typeof domain !== "string" || !domain.trim()) {
    return { region: DEFAULT_REGION, matched: false, reason: "凭据未提供 domain，回落到中国区" };
  }
  const d = domain.trim().toLowerCase();
  for (const r of Object.values(REGIONS)) {
    if (r.domainPatterns.some((re) => re.test(d))) {
      return { region: r.id, matched: true, reason: `domain "${domain}" 匹配 ${r.label}` };
    }
  }
  return { region: DEFAULT_REGION, matched: false, reason: `domain "${domain}" 未匹配已知区域，回落到中国区` };
}

/** 校验用户显式指定的区域名。 */
export function normalizeRegionId(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "cn" || v === "china" || v === "domestic" || v === "国内") return "cn";
  if (v === "intl" || v === "global" || v === "international" || v === "国际") return "intl";
  if (v === "auto") return "auto";
  return null;
}

/**
 * 解析最终使用的端点。
 *
 * 优先级：显式 --region > 凭据 domain 推断 > 默认（CN）
 * 显式指定 "auto" 时等同"由 domain 推断"。
 *
 * @param {{explicitRegion?:string, domain?:string}} opts
 * @returns {{endpoints:object, region:string, source:string, reason:string}}
 */
export function resolveEndpoints({ explicitRegion, domain } = {}) {
  const explicit = normalizeRegionId(explicitRegion);

  if (explicit && explicit !== "auto") {
    return {
      endpoints: endpointsFor(explicit),
      region: explicit,
      source: "explicit",
      reason: `由 --region ${explicit} 指定`,
    };
  }

  const inferred = inferRegionFromDomain(domain);
  return {
    endpoints: endpointsFor(inferred.region),
    region: inferred.region,
    source: inferred.matched ? "credential-domain" : "default",
    reason: inferred.reason,
  };
}

/**
 * 探测哪个 host 真正可用于**推理**。
 *
 * 为什么要逐个试：`/v3/config` 的鉴权比推理端点宽松，"能列模型"不代表
 * "能推理"（实测遇到过期到 2027 的令牌仍然 401）。所以这里用
 * `probe`（通常是 verifyInference）作为唯一判据。
 *
 * @param {{hosts:string[], region:string, probe:(ep:object)=>Promise<{ok:boolean,reason?:string}>}} opts
 * @returns {Promise<{endpoints:object|null, attempts:Array}>}
 */
export async function probeHosts({ hosts, region, probe }) {
  const attempts = [];
  for (const host of hosts) {
    const ep = endpointsAt(region, host);
    let r;
    try {
      r = await probe(ep);
    } catch (e) {
      r = { ok: false, reason: e?.message ?? String(e) };
    }
    attempts.push({ host, ok: Boolean(r?.ok), reason: r?.reason });
    if (r?.ok) return { endpoints: ep, attempts };
  }
  return { endpoints: null, attempts };
}
