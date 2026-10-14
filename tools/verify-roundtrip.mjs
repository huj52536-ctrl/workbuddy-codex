/**
 * 安装 → 卸载 往返验证（真实文件操作，使用临时 CODEX_HOME）
 *
 * 场景：用户已有一份含 deepseek provider、注释、projects 段的配置。
 * 验证 install 后 Codex 可用、uninstall 后能**精确还原**到原文件。
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL = `# Codex 用户配置 —— 这行注释必须保留
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

# 另一个自定义注释
[mcp_servers.node_repl]
command = 'node_repl.exe'
args = []
`;

const home = mkdtempSync(join(tmpdir(), "wbcx-"));
process.env.CODEX_HOME = home;
const cfgPath = join(home, "config.toml");
writeFileSync(cfgPath, ORIGINAL, "utf8");

// 必须在设置 CODEX_HOME 之后导入，因为模块在加载时读取它
const { applyManagedBlock, removeManagedBlock, findChatWireApi } = await import("../src/codex-config.mjs");

const fail = [];
const check = (cond, label) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}`);
  if (!cond) fail.push(label);
};

console.log(`temp CODEX_HOME: ${home}\n`);

// ---- install ----
console.log("【install】");
const installed = applyManagedBlock(ORIGINAL, { port: 8787, model: "glm-5.3" });
writeFileSync(cfgPath, installed, "utf8");
check(installed.includes("[model_providers.workbuddy]"), "写入了 workbuddy provider");
check(/^wire_api = "responses"$/m.test(installed), "使用 responses（不是 chat）");
check(findChatWireApi(installed).length === 0, "没有 wire_api=\"chat\" 冲突");
check(installed.includes("[model_providers.deepseek]"), "保留用户原有 deepseek provider");
check(installed.includes("# Codex 用户配置 —— 这行注释必须保留"), "保留原有注释");
check(installed.includes("[projects."), "保留 projects 段");
check(installed.includes("[mcp_servers.node_repl]"), "保留 mcp_servers 段");
check(/^model_provider = "workbuddy"$/m.test(installed), "model_provider 指向 workbuddy");

const modelLine = installed.split("\n").find((l) => l.startsWith("model = "));
const firstSection = installed.split("\n").findIndex((l) => /^\s*\[/.test(l));
const modelLineIdx = installed.split("\n").findIndex((l) => l.startsWith("model = "));
check(modelLineIdx < firstSection, "顶层键位于首个 [section] 之前（TOML 合法）");

// ---- 幂等 ----
console.log("\n【重复 install 幂等】");
const twice = applyManagedBlock(installed, { port: 9999, model: "glm-5.2" });
check((twice.match(/\[model_providers\.workbuddy\]/g) ?? []).length === 1, "provider 段未重复堆积");
check(twice.includes(":9999/v1"), "端口已更新");
check(twice.includes('model = "glm-5.2"'), "模型已更新");
check((twice.match(/workbuddy-codex-state:/g) ?? []).length > 0, "记录了原始值用于还原");

// ---- uninstall ----
console.log("\n【uninstall 还原】");
const restored = removeManagedBlock(twice);
writeFileSync(cfgPath, restored, "utf8");

check(!restored.includes("model_providers.workbuddy"), "workbuddy provider 已移除");
check(!restored.includes("workbuddy-codex-state"), "状态注释已移除");
check(/^model = "deepseek-flash"$/m.test(restored), "model 还原为 deepseek-flash");
check(/^model_provider = "deepseek"$/m.test(restored), "model_provider 还原为 deepseek");
check(!/^model_catalog_json/m.test(restored), "model_catalog_json 已删除（原本不存在）");
check(restored.includes("[model_providers.deepseek]"), "deepseek provider 完好");
check(restored.includes("# 另一个自定义注释"), "注释完好");

// 语义等价比较（忽略首尾空行差异）
const norm = (s) => s.split("\n").map((l) => l.trimEnd()).filter((l) => l !== "").join("\n");
const same = norm(restored) === norm(ORIGINAL);
check(same, "还原结果与原始配置语义等价");
if (!same) {
  console.log("\n--- 原始 ---");
  console.log(norm(ORIGINAL));
  console.log("\n--- 还原后 ---");
  console.log(norm(restored));
}

rmSync(home, { recursive: true, force: true });

console.log(`\n${fail.length === 0 ? "全部通过" : `${fail.length} 项失败`}`);
process.exit(fail.length === 0 ? 0 : 1);
