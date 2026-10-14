/**
 * codex-config 单元测试：重点验证**不破坏用户既有配置**。
 *   node --test "test/*.test.mjs"
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyManagedBlock,
  removeManagedBlock,
  stripManagedBlock,
  extractManagedBlock,
  findChatWireApi,
  buildManagedBlock,
  buildModelCatalog,
  BUILTIN_TEMPLATE,
} from "../src/codex-config.mjs";

/** 模拟一份真实用户的 config.toml（含注释、多 provider、多 projects 段）。 */
const USER_CONFIG = `# 我的 Codex 配置
model = "deepseek-flash"
model_provider = "deepseek"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.deepseek.com/"
wire_api = "responses"
env_key = "DEEPSEEK_API_KEY"

[projects.'c:\\users\\someone\\documents\\codex\\ni']
trust_level = "trusted"

# 自定义注释要保留
[mcp_servers.node_repl]
command = 'node_repl.exe'
args = []
`;

test("applyManagedBlock 保留用户原有的 provider 与注释", () => {
  const out = applyManagedBlock(USER_CONFIG, { port: 8787, model: "glm-5.3" });
  assert.match(out, /\[model_providers\.deepseek\]/);
  assert.match(out, /DEEPSEEK_API_KEY/);
  assert.match(out, /# 我的 Codex 配置/);
  assert.match(out, /# 自定义注释要保留/);
  assert.match(out, /\[projects\./);
  assert.match(out, /\[mcp_servers\.node_repl\]/);
});

test("applyManagedBlock 写入 provider 段与顶层键", () => {
  const out = applyManagedBlock(USER_CONFIG, { port: 9999, model: "kimi-k3-1" });
  assert.match(out, /\[model_providers\.workbuddy\]/);
  assert.match(out, /base_url = "http:\/\/127\.0\.0\.1:9999\/v1"/);
  assert.match(out, /wire_api = "responses"/);
  assert.match(out, /^model = "kimi-k3-1"$/m);
  assert.match(out, /^model_provider = "workbuddy"$/m);
  assert.match(out, /^model_catalog_json = /m);
});

test("顶层键必须出现在任何 [section] 之前（TOML 语义要求）", () => {
  const out = applyManagedBlock(USER_CONFIG, { port: 8787, model: "glm-5.3" });
  const modelIdx = out.search(/^model = /m);
  const firstSectionIdx = out.search(/^\s*\[/m);
  assert.ok(modelIdx >= 0 && modelIdx < firstSectionIdx,
    `model= 必须位于首个 [section] 之前 (model@${modelIdx}, section@${firstSectionIdx})`);
});

test("重复 apply 幂等：不会堆积多个 provider 段", () => {
  let out = applyManagedBlock(USER_CONFIG, { port: 8787, model: "glm-5.3" });
  out = applyManagedBlock(out, { port: 8787, model: "glm-5.3" });
  out = applyManagedBlock(out, { port: 8888, model: "glm-5.2" });
  const count = (out.match(/\[model_providers\.workbuddy\]/g) ?? []).length;
  assert.equal(count, 1, "provider 段只能有一个");
  assert.match(out, /:8888\/v1/);
  assert.equal(/glm-5\.3/.test(out.split("\n").find((l) => l.startsWith("model = "))), false);
});

test("removeManagedBlock 精确还原：移除后与原始配置等价", () => {
  const installed = applyManagedBlock(USER_CONFIG, { port: 8787, model: "glm-5.3" });
  const restored = removeManagedBlock(installed);
  assert.equal(restored.includes("model_providers.workbuddy"), false);
  assert.equal(restored.includes("workbuddy-codex"), false);
  // 用户原有内容仍在
  assert.match(restored, /\[model_providers\.deepseek\]/);
  assert.match(restored, /\[mcp_servers\.node_repl\]/);
  assert.match(restored, /# 自定义注释要保留/);
  // 关键：不应遗留我们改写过的顶层键值
  assert.match(restored, /^model_provider = "deepseek"$/m);
});

test("findChatWireApi 能定位 wire_api=\"chat\" 及其所在 section", () => {
  const bad = `model = "x"

[model_providers.legacy]
wire_api = "chat"
base_url = "http://localhost"

[model_providers.ok]
wire_api = "responses"
`;
  const hits = findChatWireApi(bad);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].section, "model_providers.legacy");
  assert.equal(hits[0].line, 4);
});

test("findChatWireApi 单引号形式也能识别", () => {
  const hits = findChatWireApi(`[model_providers.a]\nwire_api = 'chat'\n`);
  assert.equal(hits.length, 1);
});

test("findChatWireApi 对干净配置返回空", () => {
  assert.deepEqual(findChatWireApi(USER_CONFIG), []);
});

test("stripManagedBlock 处理缺失标记的情况", () => {
  assert.equal(stripManagedBlock(USER_CONFIG), USER_CONFIG);
});

test("buildManagedBlock 含起止标记，便于精确增删", () => {
  const block = buildManagedBlock({ port: 1, model: "m" });
  assert.ok(block.startsWith("# >>> workbuddy-codex >>>"));
  assert.ok(block.trimEnd().endsWith("# <<< workbuddy-codex <<<"));
});

// ---------------------------------------------------------------------------
// env_key 陷阱（真实故障回归）
// ---------------------------------------------------------------------------

test("默认**不得**生成 env_key（桌面版 Codex 读不到终端环境变量）", () => {
  // 真实故障：生成的配置带 env_key = "WORKBUDDY_BRIDGE_KEY"，
  // 用户从图标启动 Codex 桌面版时报
  //   Missing environment variable: `WORKBUDDY_BRIDGE_KEY`
  // 桥接服务只监听 127.0.0.1，本来就不需要客户端密钥。
  const block = buildManagedBlock({ port: 8799, model: "glm-5.3" });
  assert.equal(/env_key/.test(block), false, "默认块不能包含 env_key");
  assert.equal(/WORKBUDDY_BRIDGE_KEY/.test(block), false);

  const applied = applyManagedBlock("model = \"x\"\n", { port: 8799, model: "glm-5.3" });
  assert.equal(/env_key/.test(applied), false, "apply 后也不能出现 env_key");
});

test("显式指定 bridgeKey 时使用静态 experimental_bearer_token（而非 env_key）", () => {
  const block = buildManagedBlock({ port: 8799, model: "m", bridgeKey: "s3cret" });
  assert.match(block, /experimental_bearer_token = "s3cret"/);
  assert.equal(/env_key/.test(block), false, "即便有密钥也不能用 env_key");
});

test("不写 env_key 时仍必须有 base_url 与 wire_api=responses", () => {
  const block = buildManagedBlock({ port: 1234, model: "m" });
  assert.match(block, /base_url = "http:\/\/127\.0\.0\.1:1234\/v1"/);
  assert.match(block, /wire_api = "responses"/);
});

test("extractManagedBlock 只取本工具的块，便于精确检测", () => {
  const user = `model = "x"
[model_providers.deepseek]
env_key = "DEEPSEEK_API_KEY"
`;
  const installed = applyManagedBlock(user, { port: 8799, model: "glm-5.3" });

  const ourBlock = extractManagedBlock(installed);
  assert.match(ourBlock, /\[model_providers\.workbuddy\]/);
  // 用户自己的合法 env_key 不应出现在我们的块里 ——
  // 否则 doctor 会把用户的 DeepSeek provider 误判成故障（真实发生过的误报）
  assert.equal(/DEEPSEEK_API_KEY/.test(ourBlock), false);
  assert.equal(/env_key/.test(ourBlock), false);

  // 而整份配置里当然仍保留用户的 env_key
  assert.match(installed, /DEEPSEEK_API_KEY/);

  // 没有托管块时返回空串
  assert.equal(extractManagedBlock(user), "");
});

// ---------------------------------------------------------------------------
// 模型目录模板（可移植性：全新机器必须也能生成合法 catalog）
// ---------------------------------------------------------------------------

const SAMPLE_MODELS = [
  { id: "glm-5.3", name: "GLM-5.3", contextWindow: 1000000, maxOutputTokens: 64000, supportsImages: true, supportsReasoning: true, defaultReasoningEffort: "medium" },
];

test("内置兜底模板无 null 值字段（null 会让 Codex 拒绝加载整个 catalog）", () => {
  // 真实故障：内置模板含 web_search_tool_type=null、default_service_tier=null 等，
  // Codex 报 `invalid type: null, expected string or map` 并拒绝启动。
  const nulls = Object.entries(BUILTIN_TEMPLATE).filter(([, v]) => v === null).map(([k]) => k);
  assert.deepEqual(nulls, [], `内置模板不得含 null 字段，实际：${nulls.join(", ")}`);
});

test("内置兜底模板含 Codex 必需字段", () => {
  // 缺 support_verbosity → "missing field `support_verbosity`"
  assert.ok("support_verbosity" in BUILTIN_TEMPLATE);
  // 缺 base_instructions 且无 model_messages →
  // "missing both `base_instructions` and `model_messages.instructions_template`"
  assert.ok(
    typeof BUILTIN_TEMPLATE.base_instructions === "string" || BUILTIN_TEMPLATE.model_messages,
    "必须提供 base_instructions 或 model_messages",
  );
});

test("强制 builtin 来源时生成的 catalog 合法且无 null", () => {
  const cat = buildModelCatalog(SAMPLE_MODELS, { sources: ["builtin"] });
  assert.equal(cat._template_source, "builtin");
  const e = cat.models[0];
  assert.deepEqual(Object.entries(e).filter(([, v]) => v === null).map(([k]) => k), []);
  assert.ok(e.base_instructions, "应有 base_instructions");
  assert.ok("support_verbosity" in e);
  // 本工具的字段必须覆盖模板占位值
  assert.equal(e.slug, "glm-5.3");
  assert.equal(e.display_name, "GLM-5.3");
  assert.equal(e.context_window, 1000000);
  assert.equal(e.max_context_window, 1000000);
  assert.deepEqual(e.input_modalities, ["text", "image"]);
});

test("不支持图片 / 推理的模型生成正确的模态与档位", () => {
  const cat = buildModelCatalog(
    [{ id: "plain", name: "Plain", contextWindow: 8000, maxOutputTokens: 1000, supportsImages: false, supportsReasoning: false }],
    { sources: ["builtin"] },
  );
  const e = cat.models[0];
  assert.deepEqual(e.input_modalities, ["text"]);
  assert.deepEqual(e.supported_reasoning_levels, []);
  assert.equal(e.default_reasoning_level, "none");
});

test("多模型时 priority 递增，保证默认模型稳定", () => {
  const cat = buildModelCatalog([
    { id: "a", name: "A", contextWindow: 1000, maxOutputTokens: 100 },
    { id: "b", name: "B", contextWindow: 1000, maxOutputTokens: 100 },
    { id: "c", name: "C", contextWindow: 1000, maxOutputTokens: 100 },
  ], { sources: ["builtin"] });
  const prios = cat.models.map((m) => m.priority);
  assert.deepEqual(prios, [1000, 1001, 1002]);
});

test("不含 undefined 值（序列化后不应出现 null 占位）", () => {
  const cat = buildModelCatalog(SAMPLE_MODELS, { sources: ["builtin"] });
  const serialized = JSON.parse(JSON.stringify(cat));
  for (const [k, v] of Object.entries(serialized.models[0])) {
    assert.notEqual(v, undefined, `字段 ${k} 不应为 undefined`);
  }
});
