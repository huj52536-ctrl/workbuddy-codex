# workbuddy-codex

把 **WorkBuddy / CodeBuddy**（腾讯的 AI 编程助手）的模型接入**任意 OpenAI Codex CLI**。

Codex 0.95.0 起移除了 `wire_api = "chat"`，只认 **Responses API**；而 WorkBuddy
后端只提供 **Chat Completions**。本工具在本地做 **Responses ⇄ Chat Completions
双向协议转换**，因此你**不需要**降级 Codex，也**不需要**手改 `wire_api`。

> **已验证环境**：Codex CLI `0.162.0-alpha.2` 与 `0.163.0-alpha.10.2`（Windows）
> + WorkBuddy 中国版。文本对话、工具调用、多轮 agent 回路均已实测跑通。
> 跨大版本升级后仍兼容（0.162 → 0.163 实测通过）。

---

## 为什么需要它

现有的同类工具（如 `codebuddy2openai`）只暴露 `/v1/chat/completions`，
它们的 README 明确写着「**Codex CLI 已移除 `wire_api="chat"`，本工具无法接入 Codex**」——
缺口正好是 Responses 这一层。本项目补的就是这一层。

```
Codex CLI
   │  POST /v1/responses            (Responses API + SSE)
   ▼
workbuddy-codex  ← 本工具：协议转换 + 凭据注入 + 令牌刷新
   │  POST /v2/chat/completions     (Chat Completions + SSE, stream=true)
   ▼
copilot.tencent.com  (WorkBuddy 模型后端)
```

---

## 快速开始

需要 **Node.js ≥ 18.17**（不需要 Python）与**已登录的 WorkBuddy / CodeBuddy**
（桌面端，或 DSH，或一把 API Key —— 任选其一）。

```bash
git clone https://github.com/huj52536-ctrl/workbuddy-codex.git
cd workbuddy-codex
node bin/workbuddy-codex.mjs install
```

Windows 用户如果不在同一盘符，注意用 `cd /d`：

```bat
git clone https://github.com/huj52536-ctrl/workbuddy-codex.git
cd /d D:\path\to\workbuddy-codex
node bin\workbuddy-codex.mjs install
```

**cmd 用户常踩的坑**：

- README 里以 `#` 或 `::` 开头的行是**注释**，不要粘进 cmd ——
  会报 `'#' 不是内部或外部命令`。
- `D:\path\to\...` 这类路径要替换成你自己的实际位置；
  照抄会报"系统找不到指定的文件"。
- 跨盘符切目录必须用 `cd /d`，否则报"系统找不到指定的路径"。

`install` 会：

1. **自动寻找可用凭据**（见下节），逐个验证直到找到能真正推理的那个；
2. 拉取你账号实际可用的模型列表；
3. 以**后台分离进程**启动桥接服务（不占用终端；端口被占用会自动顺延）；
4. **做一次真实自检**——自检失败就**不会**写配置，并顺手停掉刚起的服务；
5. 备份原配置后，写入 `~/.codex/config.toml`；
6. 安装开机自启，重启后自动恢复。

跑完 `install` 后**终端可以立刻关闭**——服务在后台独立运行。

```
$ node bin\workbuddy-codex.mjs install
...
✓ 桥接服务已在后台运行: http://127.0.0.1:8799 (pid 17264)
✓ 自检通过（模型回复: "OK"）
✓ 已写入 ~/.codex/config.toml
✓ 已安装开机自启

接入完成，现在可以直接用 Codex。
  • 桥接服务在后台运行，本终端可以关闭
  • 模型：glm-5.3
  • 服务管理：workbuddy-codex service status|stop|restart
```

然后正常运行 `codex` 即可。

```bash
codex                              # 默认模型已在配置里设好
codex --model glm-5.3              # 或临时指定其它模型
```

用完卸载：

```bash
node bin/workbuddy-codex.mjs uninstall
```

> **让 Codex 的工具调用真正生效**：Codex 默认 `sandbox_mode = "read-only"`
> 会拦掉 `exec_command`。若要让 Codex 执行命令，需要在 `~/.codex/config.toml`
> 里设置 `sandbox_mode = "workspace-write"`（或 `danger-full-access`）。
> 这是 Codex 自身的策略，与本项目无关。

---

## 命令

| 命令 | 说明 |
|---|---|
| `install` | 一键接入 Codex（后台起服务 + 真实自检 + 配置备份 + 开机自启） |
| `uninstall` | 从 `~/.codex/config.toml` 移除配置并**还原原值** |
| `service status` | 查看后台服务状态 |
| `service stop` | 停止后台服务 |
| `service restart` | 重启后台服务 |
| `autostart` | 安装开机自启（`--remove` 取消） |
| `login` | 浏览器登录获取令牌（不依赖桌面端） |
| `start` | 前台启动桥接（`--detach` 则转后台），用于调试 |
| `doctor` | 诊断：凭据 / 上游连通性 / Codex 配置冲突 |
| `models` | 列出当前凭据可用的模型 |
| `status` | 显示当前状态 |

选项：`--region <cn|intl|auto>`、`--port <n>`（默认 8799；被占用时自动顺延）、`--model <id>`、`--api-key <key>`、`--verbose`。

**建议先跑 `doctor`**，它会检查一个很容易踩的坑（见下）。

---

## 区域：中国区 / 国际版

WorkBuddy 与 CodeBuddy 是同一套代码的两个区域部署。本工具**默认按你凭据里的
domain 自动判断**，判断不出就用中国区——所以大多数人什么都不用加。

```bash
workbuddy-codex doctor                 # 自动推断
workbuddy-codex doctor --region intl   # 显式指定国际版
workbuddy-codex doctor --region auto   # 强制走自动推断
```

| 区域 | 值 | 主机（按顺序探测） |
|---|---|---|
| 中国区 | `cn`（默认） | `copilot.tencent.com` → `www.workbuddy.cn` → `wb.tencentbuddy.com` |
| 国际版 | `intl` | `www.codebuddy.ai` → `www.workbuddy.ai` |

指定区域时会**逐个探测**候选主机，取第一个**真正能推理**的（不是第一个能连上的）。

### 为什么协议层不用改

从本机客户端包里读到的证据：

1. **同一份客户端要对多个主机工作** —— `product.json` 的 `officialEndpoints`
   同时列出 `workbuddy.cn` / `copilot.tencent.com` / `codebuddy.ai` 等；
2. **区域判定只比对主机名** —— CLI 的 `isInternationalEndpoint()` 检查
   `["codebuddy.ai", "workbuddy.ai", "staging-codebuddy.tencent.com"]`；
3. **路径与区域无关** —— `/v3/config` 是版本探测数组
   `["/v1/config","/v2/config","/v3/config", …]`；聊天地址只是给 base 补
   `/chat/completions`（`normalizeChatCompletionsUrl` 的语义）。

因此差异只在主机名，`Responses ⇄ Chat Completions` 转换层完全复用。

### 国际版的实测进展与限制

> **尚未用国际版账号完成端到端验证。** 以下是目前观察到的事实，请按需自测。

用**国内版**令牌访问国际版端点，`doctor --region intl` 的结果是：

```
✗ https://www.codebuddy.ai — 推理端点鉴权失败（HTTP 401）
✗ https://www.workbuddy.ai — 推理端点鉴权失败（HTTP 401）
模型目录：可用（19 个模型）      ← /v3/config 响应正常
```

这说明：

- ✅ 国际版**端点可达**，`/v3/config` 路径与鉴权方式**与国内版一致**
  （否则不会返回 19 个模型）；
- ✅ 401 的成因是**凭据属于另一个区域**，而不是协议不兼容；
- ❓ **仍未经证实**：国际版是否同样强制流式、`tool_choice` 是否同样只接受字符串、
  `X-Product: SaaS` 是否需要换值、桌面端凭据文件名是否有 `-ai` 变体。

如果你有国际版账号，欢迎跑一次并把结果反馈：

```bash
workbuddy-codex doctor --region intl
workbuddy-codex models --region intl
```

---

## 凭据：通常你什么都不用做

`install` 会按顺序**逐个验证**下列来源，取**第一个能真正推理**的：

1. **API Key** —— `--api-key`，或环境变量 `WORKBUDDY_API_KEY` / `CODEBUDDY_API_KEY`（最稳）
2. `WORKBUDDY_SESSION_FILE` 指定的会话 JSON
3. 本工具自己的会话 —— `workbuddy-codex login` 生成
4. **DSH 中已登录的 WorkBuddy 会话** —— 读 `~/.dsh/.credentials.yaml`（只读）
5. **桌面端明文凭据文件** —— `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info`（只读）

也就是说：**如果你已经登录过桌面端或在 DSH 里用过 WorkBuddy，直接 `install` 即可**，
不需要再登录一次。都没有时才需要 `workbuddy-codex login`。

### 为什么是"逐个验证"而不是"取第一个存在"

实测发现上游的 `/v3/config`（列模型）鉴权比推理端点**宽松**。存在这种状态：

```
能列出 18 个模型 ✅   →   一发起推理就 401 ❌
```

甚至有 `expiresAt` 写着 2027-06，但 refreshToken 已被服务端作废的文件。
如果只取"第一个存在的凭据"，就会把这样一个 401 的桥接写进你的 Codex 配置。

因此本工具在写配置**之前**会真的发起一次推理来验证，失败会：

- 继续尝试下一个候选来源；
- 全部失败则**不写配置**，并明确告诉你该怎么办。

### 关于桌面端凭据文件（重要）

很多同类工具直接读桌面端的 `*.info`。这里有两个坑：

**坑 1：较新版本把 token 存成加密信封**

```json
"accessToken": { "$wbEncrypted": 1, "envelope": "base64…" }
```

读出来是对象不是字符串。不做判断就会发出坏的 Authorization 头，
最终表现为**一个非常难排查的 401**。本工具会探测并明确告知，不逆向。

**坑 2：文件"看起来没过期"但实际已失效**

`expiresAt` 是本地记录的，不代表服务端仍认这个令牌。
本工具不信任它，一律实测。

---

## 上游契约（实测，改代码前请先读）

这些都是对着真实上游实测出来的行为，与官方文档不一致处已标注：

| 行为 | 说明 |
|---|---|
| **强制流式** | 非流式请求返回 `400 {"code":11101,"msg":"Non-stream chat request is currently not supported"}`。桥接层始终以 `stream:true` 调上游，非流式由本地聚合。 |
| **令牌模式只能发 `Authorization`** | 令牌模式下**必须只发** `Authorization: Bearer`。一旦同时发 `x-api-key`，会得到 `401 {"message":"not_found"}`。官方文档那条"建议同时发送 Authorization 和 X-API-Key"是针对 **API Key 模式**的。 |
| **`tool_choice` 只接受字符串** | 传对象会 400：`cannot unmarshal object into Go struct field Request.tool_choice of type string`。因此「强制某函数」会被降级为 `auto`。 |
| **账号头必需** | 令牌模式还需 `X-User-Id` / `X-Domain`（企业账号再加 `X-Enterprise-Id`、`X-Tenant-Id`）。 |
| **模型目录要过滤** | `GET /v3/config` 的 `data.models` 是平台超集；必须用 `agents[name="cli"].models` 关联过滤，否则会暴露账号无权的模型。 |
| **流式字段** | delta 含 `content` / `reasoning_content` / `tool_calls`（按 `index` 分片）/ `function_call` / `refusal`；`usage` 含 `prompt_tokens`、`completion_tokens`、`reasoning_tokens`、`cached_tokens`、`credit`。 |

### Codex 侧契约（决定事件怎么发）

- **唯一必须的事件是 `response.completed`**；缺了它会报
  `stream closed before response.completed` 并整轮失败。
- `response.function_call_arguments.delta` / `.done` **在 Codex 里是 no-op**——
  工具调用必须通过 **`response.output_item.done`** 交付。只发 `.delta` 不会触发任何工具执行。
- `sequence_number` / `output_index` Codex 并不校验，但本工具仍按规范发出（便于其它客户端复用）。
- 有工具调用时 `end_turn` 必须为 `false`，否则 Codex 会在拿到工具结果前结束回合。

---

## 它翻译了什么

**请求方向**（Responses → Chat Completions）

| Responses | Chat Completions |
|---|---|
| `instructions` | 首条 `system` 消息 |
| `message(role=developer)` | `system` |
| `input[].message` | `messages[]` |
| `function_call` | `assistant.tool_calls[]` |
| `function_call_output` | `role: "tool"` + `tool_call_id` |
| `tools[].type="function"` | 直通 |
| `tools[].type="namespace"` | **拍平**为 `namespace__tool`，并记录 alias |
| `tools[].type="custom"` | 包成单字符串参数的 `function` |
| `tools[].type="web_search"` | **丢弃**（Chat Completions 无对应表示） |
| `tool_choice` 对象 | 降级为字符串 |
| `reasoning.effort` | `reasoning_effort` |
| `store` / `include` / `prompt_cache_key` | **丢弃** |

**流方向**（Chat Completions SSE → Responses SSE）

```
文本：response.created → response.in_progress → response.output_item.added(message)
      → response.content_part.added → response.output_text.delta×N
      → response.output_text.done → response.content_part.done
      → response.output_item.done → response.completed
工具：response.created → response.output_item.added(function_call)
      → response.function_call_arguments.delta×N
      → response.function_call_arguments.done
      → response.output_item.done(function_call) → response.completed
思考：reasoning_content → response.reasoning_summary_text.delta / .done
```

---

## 端点

| 端点 | 用途 |
|---|---|
| `POST /v1/responses` | Codex 使用 |
| `POST /v1/chat/completions` | 其它 OpenAI 兼容客户端（非流式由本地聚合） |
| `GET /v1/models` | 模型列表 |
| `GET /healthz` | 健康检查 |

默认只监听 `127.0.0.1`。

---

## 已知限制

1. **`tool_choice` 无法强制指定函数**——上游只接受字符串，会降级为 `auto`。
   实践中模型在工具描述清晰时能正确选择，但无法 100% 保证。
2. **`web_search` 工具被丢弃**——Codex 会请求该工具，但 WorkBuddy 后端不提供，
   因此 Codex 的内置联网搜索在此桥接下不可用。
3. **`namespace` 工具被拍平**为 `namespace__tool` 形式。
4. 桥接进程需**保持运行**（`install` 已配置后台运行 + 开机自启）。
5. 上游是非公开承诺的接口，路径与 Header 可能随客户端更新而变化。
6. **中国区**已在 Windows + Codex **0.162 与 0.163** 上完整实测（含工具调用与多轮
   agent 回路），跨大版本升级后仍兼容。
   **国际版**仅验证到端点可达与目录接口兼容，**未经账号级端到端验证**。
   macOS / Linux 的代码路径已按跨平台方式编写（`spawn detached`、`ps`/`lsof`），
   但同样**未经实机验证**。

---

## 兼容性说明

本工具对**用户机器**的假设已经降到最低，但仍依赖以下几点：

| 依赖 | 说明 | 缺失时的行为 |
|---|---|---|
| Node.js ≥ 18.17 | 需要内置 `fetch` 与 `AbortSignal.timeout` | 明确报错并提示 |
| Codex CLI | 用于写入配置 | 仍可生成配置，只是无法验证 |
| WorkBuddy 凭据 | 桌面端 / DSH / API Key 任选其一 | 明确报错并给出三条获取路径 |
| Codex 模型目录 schema | 由 `codex debug models --bundled` 或内置模板提供 | 三级回退，见下 |

### 模型目录的三级回退

Codex 的 `model_catalog_json` schema **版本相关且严格**，字段缺失或类型不符
都会让它拒绝加载整个文件。因此本工具按以下顺序取模板：

1. 用户已有的 `~/.codex/models.json`（最贴合其版本）
2. `codex debug models --bundled`（从用户自己的 Codex 二进制导出，**最可靠**）
3. 内置模板（已实测为「Codex 可加载的最小合法字段集」）

内置模板经过了专门验证：`npm run prove:catalog` 会复现「修复前失败 → 修复后成功」的
对照实验，确保它不会在别人机器上炸掉。

---

## 开发与发布

```bash
npm test                    # 83 项单元 + 集成测试
npm run test:roundtrip      # 安装→卸载 往返还原验证
npm run test:install        # 完整安装验证（隔离 HOME，含真实 Codex 端到端）
npm run prove:catalog       # 模型目录模板的对照验证（需本机有 codex）
```

`npm run test:install` 会在临时目录里搭一个**完全隔离的 HOME** 跑完整用户旅程
（安装 → 生成物校验 → 真实 Codex 调用 → 服务重启 → 重复安装幂等 → 卸载还原 →
区域选错时拒绝写配置），最后校验真实的 `~/.codex/config.toml` **一字未变**（34 项检查）。

发布前建议按顺序自查：

```bash
# 1) 测试全绿
npm test

# 2) 安装/卸载能精确还原用户配置
npm run test:roundtrip

# 3) 端到端（含真实 Codex 调用）
npm run test:install

# 4) 仓库里没有凭据或本机路径
git grep -nE "[A-Z]:\\\\|sk-[A-Za-z0-9]{10}|accessToken.*[:=].*[A-Za-z0-9]{40}"

# 5) 全新机器路径（无 ~/.codex/models.json）也能生成合法 catalog
npm run prove:catalog
```

---

## 常见问题

**Q: 报 `Missing environment variable: \`WORKBUDDY_BRIDGE_KEY\``**
这是本工具早期版本生成的配置有问题（用 `env_key` 要求一个环境变量），
而 **Codex 桌面版从图标启动时读不到终端里设的变量**。
桥接服务只监听 `127.0.0.1`，本来就不需要客户端密钥。

修复：重新运行 `install`（新版不再写 `env_key`）：

```bat
cd /d %USERPROFILE%\path\to\workbuddy-codex
node bin\workbuddy-codex.mjs install
```

`doctor` 会主动检测这一类残留并提示。

**Q: 报 `wire_api = "chat" is no longer supported`**
你的 `config.toml` 里有残留的 `wire_api = "chat"`（即便那个 provider 没被使用，
Codex 也会因此拒绝启动）。`doctor` 会精确定位到行号。删掉那些行即可。

**Q: 报 `Model metadata for <id> not found`**
缺少模型目录。`install` 会自动生成 `~/.codex/workbuddy-models.json` 并写入
`model_catalog_json`。

**Q: 401 / `not_found`**
按顺序检查：① 是否误发了 `x-api-key`（令牌模式不能发）；
② 令牌是否过期或已被服务端作废；③ 桌面端凭据是否为加密信封。
`install` 会在写配置前实测一次推理，通常能直接告诉你原因。

**Q: 重启电脑后 Codex 又连不上了**
桥接服务没在运行。`install` 会顺手装好开机自启；若你手动移除了，
见下方「后台运行机制」。

**Q: 如何卸载干净**
```bash
node bin/workbuddy-codex.mjs uninstall     # 移除 config.toml 里的配置并还原原值
rm -rf ~/.workbuddy-codex                  # 删除会话、状态与备份
```
原配置备份在 `~/.workbuddy-codex/backups/`。

---

## 后台运行机制

`install` 不再占用终端。实现方式：

| 平台 | 机制 |
|---|---|
| Windows | 用 `wscript` 执行 VBS 启动 node —— **完全无控制台窗口** |
| macOS / Linux | `spawn(..., { detached: true })` + `unref()`，进入独立会话 |

要点：

- **PID 由子进程自己写入** `~/.workbuddy-codex/bridge.pid`。
  （Windows 下经 VBS 启动时父进程拿不到子进程 PID，所以不能由父进程写。）
- `service stop` 会**校验该 PID 的命令行确实属于本项目**再终止，
  避免 PID 被复用后误杀你的其它程序。
- 端口记在 `~/.workbuddy-codex/state.json`，重启后复用同一端口，
  与 `config.toml` 保持一致。

常用操作：

```bat
node bin\workbuddy-codex.mjs service status     :: 查看
node bin\workbuddy-codex.mjs service restart    :: 重启
node bin\workbuddy-codex.mjs service stop       :: 停止
```

日志：`~/.workbuddy-codex/bridge.log`

### 为什么不用「Windows 服务」或「计划任务」

考虑过，但都不合适：

- **计划任务**：能做到，但引入了一个系统级实体，卸载时还要记得删；
  启动延迟（默认延迟启动）也会让开机后一两分钟内 Codex 仍不可用。
- **Windows 服务**：需要管理员权限，且要求把 node 包成服务，
  对一个本地开发工具来说过重。

启动文件夹 + 分离进程的组合：无需管理员、零残留（删一个 VBS 即可）、
开机即用，是这个场景下最轻的方案。

---

## 代码结构

```
bin/workbuddy-codex.mjs   CLI 入口（命令分发、安装器、doctor）
src/translate.mjs         Responses ⇄ Chat Completions 协议转换（纯函数，可单测）
src/region.mjs            区域定义、端点解析、主机探测（纯函数，可单测）
src/credentials.mjs       凭据发现/校验/刷新/登录 + 模型目录
src/daemon.mjs            分离进程的启停、PID 管理、健康探测
src/server.mjs            HTTP 服务（/v1/responses、/v1/chat/completions）
src/codex-config.mjs      ~/.codex/config.toml 安全读写 + 精确还原 + 模型目录
test/                     83 项单元与集成测试
tools/                    往返验证、目录模板对照实验、DSH 会话导入
```

---

## 安全与合规

- 凭据只存本地（`~/.workbuddy-codex/`，权限 600），**不上传任何第三方**。
- 只监听 `127.0.0.1`。
- 本工具**不做**设备指纹伪造、零宽字符绕过内容审核、自动刷任务等行为。
- 请在**你合法持有的订阅**范围内使用，并自行确认符合相关服务条款。
  本项目为第三方工具，与腾讯 / CodeBuddy / WorkBuddy / OpenAI 均无关联。

## License

[MIT](./LICENSE)
