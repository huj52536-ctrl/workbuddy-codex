/**
 * codex-config.mjs —— 安全地读写 ~/.codex/config.toml
 *
 * 可靠性要求（针对真实用户配置）：
 *   - 绝不整体重写用户配置：只做**定点增删**，保留注释、顺序与未知键
 *   - 每次改动前先备份到 ~/.workbuddy-codex/backups/
 *   - 卸载时能精确还原我们加过的内容（用标记块界定）
 *   - 保留用户已有的 [model_providers.*] 与 [projects.*] 等段
 *
 * 之所以不引入 TOML 库：保持零依赖，且定点编辑比「解析→序列化」更能
 * 保住用户的注释与格式（序列化会丢掉注释）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
export const CONFIG_PATH = join(CODEX_HOME, "config.toml");
export const BACKUP_DIR = join(homedir(), ".workbuddy-codex", "backups");

export const PROVIDER_ID = "workbuddy";
export const BEGIN_MARK = "# >>> workbuddy-codex >>>";
export const END_MARK = "# <<< workbuddy-codex <<<";
export const MODEL_CATALOG_FILE = join(CODEX_HOME, "workbuddy-models.json");
const STATE_PREFIX = "# workbuddy-codex-state: ";

/** 我们会改写的顶层键；卸载时需按记录还原。 */
export const MANAGED_TOP_LEVEL_KEYS = ["model", "model_provider", "model_catalog_json"];

export function readConfig() {
  if (!existsSync(CONFIG_PATH)) return "";
  return readFileSync(CONFIG_PATH, "utf8");
}

export function backupConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(BACKUP_DIR, `config.toml.${stamp}.bak`);
  copyFileSync(CONFIG_PATH, dest);
  // 只保留最近 10 份
  try {
    const all = readdirSync(BACKUP_DIR).filter((f) => f.startsWith("config.toml.")).sort();
    for (const f of all.slice(0, Math.max(0, all.length - 10))) {
      try { unlinkSync(join(BACKUP_DIR, f)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return dest;
}

const ABSENT = "__ABSENT__";

/**
 * 读取我们记录在托管块里的「原始顶层键值」。
 *
 * 为什么要记录：`install` 会改写 model / model_provider / model_catalog_json
 * 这三个**顶层键**。如果卸载时只删掉 provider 段而不还原它们，用户的配置就
 * 被永久改掉了（例如 model_provider 仍指向已不存在的 workbuddy）。
 */
export function parseManagedState(text) {
  const state = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^#\s*workbuddy-codex-state:\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) state[m[1]] = m[2].trim();
  }
  return state;
}

/** 取出本工具写入的托管块（含标记行）；不存在则返回空串。 */
export function extractManagedBlock(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (line.trim() === BEGIN_MARK) { inside = true; out.push(line); continue; }
    if (line.trim() === END_MARK) { out.push(line); inside = false; continue; }
    if (inside) out.push(line);
  }
  return out.join("\n");
}

/** 移除我们之前写入的标记块（含块内的状态注释）。 */
export function stripManagedBlock(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (line.trim() === BEGIN_MARK) { inside = true; continue; }
    if (line.trim() === END_MARK) { inside = false; continue; }
    if (!inside) out.push(line);
  }
  return out.join("\n");
}

/**
 * 检测用户的 config 里是否存在会阻断 Codex 启动的 wire_api="chat"。
 * Codex 0.95.0+ 对未使用到的 provider 条目也会做急切校验。
 */
export function findChatWireApi(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  let currentSection = "";
  lines.forEach((line, i) => {
    const sec = line.match(/^\s*\[([^\]]+)\]/);
    if (sec) currentSection = sec[1];
    const m = line.match(/^\s*wire_api\s*=\s*["']([^"']+)["']/);
    if (m && m[1] === "chat") hits.push({ line: i + 1, section: currentSection });
  });
  return hits;
}

/**
 * 生成托管配置块。
 *
 * 关于鉴权字段（重要，踩过的坑）：
 *   Codex **桌面版**从开始菜单/图标启动时，不会继承你在终端里 `setx`/`export`
 *   的环境变量。因此默认**不能**写 `env_key` —— 否则会直接报
 *       Missing environment variable: `WORKBUDDY_BRIDGE_KEY`
 *   而桥接服务只监听 127.0.0.1，本来就不需要客户端密钥。
 *
 *   如果用户确实想要一层本地鉴权，用 `experimental_bearer_token`（静态值，
 *   不依赖环境变量）而不是 `env_key`。
 *
 * @param {{port:number, model:string, bridgeKey?:string, state?:Record<string,string>}} opts
 */
export function buildManagedBlock({ port, model, bridgeKey, state = {} }) {
  const stateLines = Object.entries(state)
    .map(([k, v]) => `${STATE_PREFIX}${k} = ${v}`);

  return [
    BEGIN_MARK,
    `# 由 workbuddy-codex 生成；卸载请运行：workbuddy-codex uninstall`,
    ...stateLines,
    `[model_providers.${PROVIDER_ID}]`,
    `name = "WorkBuddy (local bridge)"`,
    `base_url = "http://127.0.0.1:${port}/v1"`,
    `wire_api = "responses"`,
    // 仅当显式要求本地鉴权时才写；且用静态值，不用 env_key
    ...(bridgeKey ? [`experimental_bearer_token = ${JSON.stringify(bridgeKey)}`] : []),
    `request_max_retries = 2`,
    `stream_max_retries = 3`,
    `stream_idle_timeout_ms = 300000`,
    END_MARK,
  ].join("\n");
}

/**
 * 写入 / 更新 provider 段，并设置 model / model_provider / model_catalog_json。
 *
 * 为了可还原，会把这三个键的**原值**（或标记为原本不存在）记录进托管块，
 * 卸载时据此还原。已是本工具写入的值不会被当成"原值"记录，
 * 因此重复 install 不会把 workbuddy 记成用户原配置。
 */
export function applyManagedBlock(text, { port, model, bridgeKey }) {
  const cleaned = stripManagedBlock(text);
  const previousState = parseManagedState(text);

  // 先解析出用户当前的顶层键值（剥离托管块之后的）
  const beforeLines = cleaned.split(/\r?\n/);
  const readTop = (key) => {
    const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`);
    for (const l of beforeLines) {
      const m = l.match(re);
      if (m) return m[1];
    }
    return undefined;
  };

  const ourCatalog = JSON.stringify(MODEL_CATALOG_FILE.replace(/\\/g, "/"));
  const isOurValue = (key, value) =>
    (key === "model_provider" && value === JSON.stringify(PROVIDER_ID)) ||
    (key === "model_catalog_json" && value === ourCatalog);

  const state = { ...previousState };
  for (const key of MANAGED_TOP_LEVEL_KEYS) {
    if (key in state) continue;                 // 已记录过原始值，保持不变
    const current = readTop(key);
    if (current === undefined) state[key] = ABSENT;
    else if (!isOurValue(key, current)) state[key] = current;
    else state[key] = ABSENT;                   // 已是本工具的值 → 视为原本不存在
  }

  const block = buildManagedBlock({ port, model, bridgeKey, state });

  const lines = cleaned.split(/\r?\n/);
  // 找到第一个 section 起点：顶层键必须放在任何 [section] 之前
  let insertAt = lines.findIndex((l) => /^\s*\[/.test(l));
  if (insertAt === -1) insertAt = lines.length;

  const head = lines.slice(0, insertAt);
  const tail = lines.slice(insertAt);

  const setTop = (key, value) => {
    const re = new RegExp(`^\\s*${key}\\s*=`);
    const idx = head.findIndex((l) => re.test(l));
    if (idx >= 0) head[idx] = `${key} = ${value}`;
    else head.push(`${key} = ${value}`);
  };

  setTop("model", JSON.stringify(model));
  setTop("model_provider", JSON.stringify(PROVIDER_ID));
  setTop("model_catalog_json", ourCatalog);

  const headText = head.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  const tailText = tail.join("\n").trimStart();

  return `${headText}\n\n${block}\n\n${tailText}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * 卸载：移除托管块，并把我们改写过的顶层键**还原为原值**
 * （原值不存在则删除该行）。
 */
export function removeManagedBlock(text) {
  const state = parseManagedState(text);
  const stripped = stripManagedBlock(text);

  const lines = stripped.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = m?.[1];
    if (key && MANAGED_TOP_LEVEL_KEYS.includes(key) && key in state) {
      const original = state[key];
      if (original === ABSENT) continue;        // 原本没有 → 删掉这一行
      out.push(`${key} = ${original}`);         // 原本有 → 还原
      continue;
    }
    out.push(line);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function writeConfig(text) {
  mkdirSync(CODEX_HOME, { recursive: true });
  writeFileSync(CONFIG_PATH, text, "utf8");
}

/**
 * 生成 Codex 模型目录 JSON。
 *
 * ── 为什么这件事比看起来难 ──────────────────────────────────────────
 * Codex 的 catalog schema **版本相关且严格**：字段缺失或类型不符都会让
 * Codex **拒绝加载整个文件**。实测到的三种失败：
 *     missing field `support_verbosity`
 *     invalid type: null, expected string or map
 *     model `x` is missing both `base_instructions` and
 *       `model_messages.instructions_template`
 *
 * ── 取模板的优先级 ────────────────────────────────────────────────
 *   1. 用户已有的 `~/.codex/models.json`（最贴合其当前版本）
 *   2. **`codex debug models --bundled`** —— 从用户自己的 Codex 二进制
 *      导出内置目录。这条最可靠：无需网络、自动匹配版本，且自带
 *      `base_instructions`。
 *   3. 内置兜底模板（BUILTIN_TEMPLATE）
 *
 * 刻意**不把 Codex 的 base_instructions 抄进本仓库**：那是 OpenAI 的
 * 系统提示词，随版本变化，复制既不合适也会迅速过时。改为运行时从用户
 * 自己的安装里读取。
 */
/**
 * 内置兜底模板（**经真实 Codex 实测验证可加载**）。
 *
 * 这是三条取模板路径中最后一条：当用户机器上既没有
 * `~/.codex/models.json`、又无法执行 `codex debug models --bundled` 时使用。
 *
 * 约束（均由实测得出，改动前请先跑 tools/find-minimal-template.mjs）：
 *   - 必须含 `support_verbosity`，否则报 missing field
 *   - 必须提供 `base_instructions`（或 model_messages），否则报
 *     "missing both `base_instructions` and `model_messages.instructions_template`"
 *   - **不得出现值为 null 的字段**：Codex 对其中若干字段期望 string/map，
 *     收到 null 会报 `invalid type: null, expected string or map`
 *     （注意：Codex 自带的 bundled 模板里 `availability_nux`/`upgrade`
 *      确实为 null 且能加载 —— 说明那两个字段本就可空。这里为稳妥
 *      一律不写 null。）
 *   - 这 29 个字段是实测的最小合法集，不要随意删减
 */
export const BUILTIN_TEMPLATE = {
  slug: "placeholder",
  display_name: "placeholder",
  description: "placeholder",
  default_reasoning_level: "medium",
  supported_reasoning_levels: [
    { effort: "low", description: "轻量推理" },
    { effort: "medium", description: "平衡速度与深度" },
    { effort: "high", description: "更深推理" },
  ],
  context_window: 128000,
  max_context_window: 128000,
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 1000,
  support_verbosity: true,
  default_verbosity: "low",
  apply_patch_tool_type: "freeform",
  web_search_tool_type: "text",
  input_modalities: ["text"],
  truncation_policy: { mode: "tokens", limit: 10000 },
  supports_image_detail_original: true,
  effective_context_window_percent: 95,
  comp_hash: "3000",
  default_reasoning_summary: "none",
  reasoning_summary_format: "experimental",
  supports_parallel_tool_calls: true,
  multi_agent_version: "v2",
  use_responses_lite: false,
  include_skills_usage_instructions: false,
  experimental_supported_tools: [],
  supports_search_tool: false,
  supports_reasoning_summaries: false,
  // Codex 要求 base_instructions 或 model_messages 至少存在其一
  base_instructions: "You are a coding agent operating in a shared workspace.",
};

/** 定位 codex 可执行文件（PATH，其次常见安装目录）。 */
export function findCodexBin() {
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  const which = process.platform === "win32" ? "where" : "which";
  for (const n of names) {
    try {
      // stderr 必须静音：`where` 找不到时会向 stderr 打印提示，污染用户终端
      const p = execFileSync(which, [n], {
        encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      }).split(/\r?\n/)[0].trim();
      if (p && existsSync(p)) return p;
    } catch { /* 继续 */ }
  }
  if (process.platform === "win32") {
    const base = join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin");
    try {
      if (existsSync(base)) {
        for (const d of readdirSync(base)) {
          const exe = join(base, d, "codex.exe");
          if (existsSync(exe)) return exe;
        }
      }
    } catch { /* ignore */ }
  }
  return null;
}

/** 从 `codex debug models --bundled` 取 Codex 自带目录（失败返回 null）。 */
export function loadBundledTemplate(codexBin) {
  const bin = codexBin ?? findCodexBin();
  if (!bin) return null;
  try {
    const out = execFileSync(bin, ["debug", "models", "--bundled"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const j = JSON.parse(out);
    const first = Array.isArray(j?.models) ? j.models[0] : null;
    if (first && typeof first === "object") return first;
  } catch { /* 回退 */ }
  return null;
}

/**
 * 载入模板条目。
 *
 * 优先级：用户已有 models.json → `codex debug models --bundled` → 内置模板。
 *
 * @param {{codexBin?:string, sources?:string[], userModelsPaths?:string[]}} opts
 *   sources 可显式限定要尝试的来源（"user" | "bundled" | "builtin"），
 *   便于测试与「强制使用干净模板」的场景。
 */
export function loadTemplate({ codexBin, sources, userModelsPaths } = {}) {
  const use = (name) => !sources || sources.includes(name);

  if (use("user")) {
    const paths = userModelsPaths ?? [
      join(CODEX_HOME, "models.json"),
      join(homedir(), ".codex", "models.json"),
    ];
    for (const p of paths) {
      try {
        if (!existsSync(p)) continue;
        const j = JSON.parse(readFileSync(p, "utf8"));
        const first = Array.isArray(j?.models) ? j.models[0] : null;
        if (first && typeof first === "object") {
          return { template: first, source: `user-models.json:${p}` };
        }
      } catch { /* 继续 */ }
    }
  }

  if (use("bundled")) {
    const bundled = loadBundledTemplate(codexBin);
    if (bundled) return { template: bundled, source: "codex debug models --bundled" };
  }

  return { template: BUILTIN_TEMPLATE, source: "builtin" };
}

/** 去掉值为 undefined 的键（JSON.stringify 本会丢弃，这里显式保证）。 */
function pruneUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function buildModelCatalog(models, { codexBin, sources, userModelsPaths } = {}) {
  const { template, source } = loadTemplate({ codexBin, sources, userModelsPaths });
  return {
    _generated_by: "workbuddy-codex",
    _template_source: source,
    models: models.map((m, i) => pruneUndefined({
      ...template,
      slug: m.id,
      display_name: m.name ?? m.id,
      description: `WorkBuddy / ${m.id}`,
      context_window: m.contextWindow ?? 128000,
      max_context_window: m.contextWindow ?? 128000,
      default_reasoning_level: m.supportsReasoning
        ? (m.defaultReasoningEffort ?? "medium")
        : "none",
      supported_reasoning_levels: m.supportsReasoning
        ? [
          { effort: "low", description: "轻量推理，响应更快" },
          { effort: "medium", description: "平衡速度与深度" },
          { effort: "high", description: "更深推理，适合复杂问题" },
        ]
        : [],
      input_modalities: m.supportsImages ? ["text", "image"] : ["text"],
      priority: 1000 + i,
    })),
  };
}

export function writeModelCatalog(models, opts) {
  const catalog = buildModelCatalog(models, opts);
  mkdirSync(CODEX_HOME, { recursive: true });
  writeFileSync(MODEL_CATALOG_FILE, JSON.stringify(catalog, null, 2), "utf8");
  return MODEL_CATALOG_FILE;
}
