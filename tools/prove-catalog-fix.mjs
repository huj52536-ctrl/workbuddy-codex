/**
 * 对照实验：重建「修复前」的模板，确认它真的会让全新机器失败，
 * 并验证修复后的模板在本机**没有** ~/.codex/models.json 的情况下可用。
 *
 * 为什么必须做这个：如果只测「修复后能用」，无法证明修复解决了真问题。
 * 必须重现失败 → 再证明修好，才算验证。
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findCodexBin } from "../src/codex-config.mjs";

const CODEX = process.env.CODEX_BIN || findCodexBin();
if (!CODEX) {
  console.error("找不到 codex 可执行文件。请用 CODEX_BIN=/path/to/codex 指定。");
  process.exit(2);
}
const WORK = join(tmpdir(), "wbcx-proof");
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const models = [{ id: "glm-5.3", name: "GLM-5.3", contextWindow: 1000000, maxOutputTokens: 64000, supportsImages: true, supportsReasoning: true }];

/** 修复前的模板：含 null、无 base_instructions、无 model_messages */
const OLD_TEMPLATE = {
  prefer_websockets: false,
  support_verbosity: true,
  default_verbosity: "low",
  apply_patch_tool_type: "freeform",
  web_search_tool_type: null,
  input_modalities: ["text"],
  supports_image_detail_original: true,
  truncation_policy: { mode: "tokens", limit: 10000 },
  supports_parallel_tool_calls: true,
  tool_mode: null,
  multi_agent_version: "v2",
  use_responses_lite: false,
  include_skills_usage_instructions: false,
  auto_review_model_override: null,
  effective_context_window_percent: 95,
  auto_compact_token_limit: null,
  comp_hash: "3000",
  reasoning_summary_format: "experimental",
  default_reasoning_summary: "none",
  visibility: "list",
  minimal_client_version: null,
  supported_in_api: true,
  availability_nux: null,
  upgrade: null,
  experimental_supported_tools: [],
  supports_search_tool: false,
  default_service_tier: null,
  supports_reasoning_summaries: false,
  shell_type: "shell_command",
};

function build(template) {
  return {
    _generated_by: "workbuddy-codex",
    _template_source: "test",
    models: models.map((m) => ({
      ...template,
      slug: m.id, display_name: m.name, description: `WorkBuddy / ${m.id}`,
      context_window: m.contextWindow, max_context_window: m.contextWindow,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low", description: "l" }, { effort: "medium", description: "m" }],
      input_modalities: ["text", "image"],
      priority: 1000,
    })),
  };
}

async function tryLoad(label, catalog, { withUserModels = false } = {}) {
  const dir = join(WORK, label.replace(/[^\w]/g, "_"));
  mkdirSync(dir, { recursive: true });
  const catPath = join(dir, "workbuddy-models.json");
  writeFileSync(catPath, JSON.stringify(catalog, null, 2), "utf8");
  writeFileSync(join(dir, "config.toml"), [
    `model = "glm-5.3"`,
    `model_provider = "p"`,
    `model_catalog_json = "${catPath.replace(/\\/g, "/")}"`,
    `[model_providers.p]`, `name = "p"`,
    `base_url = "http://127.0.0.1:8799/v1"`, `wire_api = "responses"`,
  ].join("\n"), "utf8");

  let out = "";
  try {
    out = execFileSync(CODEX, ["exec", "--skip-git-repo-check", "hi"], {
      encoding: "utf8", windowsHide: true, timeout: 90000,
      env: { ...process.env, CODEX_HOME: dir },
    });
  } catch (e) { out = `${e.stdout ?? ""}${e.stderr ?? ""}`; }

  const errLine = out.split(/\r?\n/).find((l) =>
    /failed to parse model_catalog_json|missing field|invalid type|missing both/i.test(l));
  console.log(`\n=== ${label} ===`);
  console.log(errLine ? `  ✗ 失败：${errLine.trim().slice(0, 170)}` : "  ✓ 加载成功");
  return !errLine;
}

console.log("对照实验：修复前 vs 修复后（模拟全新机器）");

const oldOk = await tryLoad("修复前模板（含 null，无 base_instructions）", build(OLD_TEMPLATE));

// 修复后：去掉 null + 补 base_instructions
const newTemplate = { ...OLD_TEMPLATE, web_search_tool_type: "text",
  base_instructions: "You are a coding agent operating in a shared workspace." };
for (const k of ["tool_mode", "auto_review_model_override", "auto_compact_token_limit",
  "minimal_client_version", "availability_nux", "upgrade", "default_service_tier"]) delete newTemplate[k];
const newOk = await tryLoad("修复后模板（无 null，含 base_instructions）", build(newTemplate));

// 也验证：只去 null 但不补 base_instructions 是否仍失败
const noInstr = { ...newTemplate };
delete noInstr.base_instructions;
const noInstrOk = await tryLoad("仅去 null（仍无 base_instructions）", build(noInstr));

console.log("\n" + "=".repeat(60));
console.log(`修复前           : ${oldOk ? "成功（未复现问题）" : "失败 ← 复现了真实缺陷"}`);
console.log(`修复后           : ${newOk ? "成功 ✓" : "失败"}`);
console.log(`仅去 null 无指令 : ${noInstrOk ? "成功" : "失败（说明 base_instructions 也是必需）"}`);
console.log("=".repeat(60));
