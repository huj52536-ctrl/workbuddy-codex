/**
 * translate.mjs —— 协议转换核心（纯函数，无副作用，可单测）
 *
 * Codex CLI 只认 OpenAI **Responses** API（`wire_api = "responses"`）。
 * WorkBuddy / CodeBuddy 后端只提供 OpenAI **Chat Completions** API
 * （且强制 `stream: true`）。
 *
 * 本模块负责两个方向的翻译：
 *   1. responsesRequestToChat()   Responses 请求体  → Chat Completions 请求体
 *   2. chatStreamToResponses()    Chat Completions SSE → Responses SSE 事件流
 *
 * 设计约束（均为上游实测行为，见 README「上游契约」）：
 *   - 上游只支持流式，非流式请求返回 400 code 11101
 *   - 上游 tool_choice 只接受字符串，对象形式返回 400
 *   - 上游不认识 store / include / prompt_cache_key / previous_response_id
 */

/** 生成短随机 id，避免依赖 crypto 的具体实现差异。 */
function rid(prefix) {
  const s = Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-6);
  return `${prefix}_${s}`;
}

/** 文本内容块 → 纯文本。Responses 用 content 数组，Chat 用字符串。 */
function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    // Responses 的输入用 input_text/output_text；聊天历史里也可能出现 text
    if (typeof block.text === "string") parts.push(block.text);
    else if (block.type === "input_image" || block.type === "image_url") {
      // 图片块在下面单独处理
      continue;
    }
  }
  return parts.join("");
}

/**
 * 把 Responses 的消息 content 数组转换成 Chat Completions 的 content。
 * 有图片时返回数组形式（OpenAI 多模态格式），否则返回纯字符串。
 */
function contentToChat(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const out = [];
  let hasImage = false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "input_image" || block.type === "image_url") {
      hasImage = true;
      const url = block.image_url ?? block.url;
      out.push({ type: "image_url", image_url: { url: typeof url === "string" ? url : url?.url } });
      continue;
    }
    if (typeof block.text === "string") out.push({ type: "text", text: block.text });
  }
  if (!hasImage) {
    return out.map((b) => b.text ?? "").join("");
  }
  return out;
}

/**
 * 把 Responses 的 tools 数组转换成 Chat Completions 的 tools。
 *
 * 需要处理的形态：
 *   - { type: "function", name, description, parameters }   → 直通（改名到 function.name）
 *   - { type: "namespace", name, tools: [...] }             → 拍平为多个 function（加前缀）
 *   - { type: "custom", name, format }                      → 包成一个 function（单字符串参数）
 *   - { type: "web_search" | "local_shell" | ... }          → 上游无法表达，丢弃并记录
 *
 * @returns {{ tools: object[], dropped: string[], alias: Map<string,string> }}
 *   alias 把「拍平后的名字」映射回「原始 namespace 名」，用于回程还原。
 */
export function responsesToolsToChat(tools) {
  const out = [];
  const dropped = [];
  const alias = new Map();

  const pushFunction = (name, description, parameters) => {
    if (!name) return;
    out.push({
      type: "function",
      function: {
        name,
        description: typeof description === "string" ? description : "",
        parameters: parameters && typeof parameters === "object"
          ? parameters
          : { type: "object", properties: {} },
      },
    });
  };

  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== "object") continue;
    const type = tool.type;

    if (type === "function") {
      pushFunction(tool.name ?? tool.function?.name, tool.description ?? tool.function?.description,
        tool.parameters ?? tool.function?.parameters);
      continue;
    }

    if (type === "namespace") {
      const ns = tool.name;
      for (const sub of Array.isArray(tool.tools) ? tool.tools : []) {
        if (sub?.type !== "function") continue;
        // 上游工具名通常限制为 [A-Za-z0-9_-]，所以用双下划线而不是点
        const flat = `${ns}__${sub.name}`;
        alias.set(flat, { namespace: ns, name: sub.name });
        pushFunction(flat, sub.description, sub.parameters);
      }
      continue;
    }

    if (type === "custom") {
      // 自由格式工具（如 apply_patch）：包成单个字符串参数的 function
      pushFunction(tool.name, tool.description, {
        type: "object",
        properties: {
          input: { type: "string", description: "Freeform tool input." },
        },
        required: ["input"],
        additionalProperties: false,
      });
      continue;
    }

    // web_search / local_shell / 其他托管工具：Chat Completions 无对应表示
    dropped.push(type ?? "(unnamed)");
  }

  return { tools: out, dropped, alias };
}

/**
 * Responses 的 tool_choice → 上游可接受的字符串。
 *
 * 实测：上游 `tool_choice` 只接受 string，传对象会 400：
 *   json: cannot unmarshal object into Go struct field Request.tool_choice of type string
 * 因此所有需要「指定某个函数」的语义都必须降级。
 */
export function responsesToolChoiceToChat(toolChoice, { hasTools }) {
  if (!hasTools) return undefined;
  if (toolChoice === undefined || toolChoice === null) return "auto";
  if (typeof toolChoice === "string") {
    if (toolChoice === "required") return "required";
    if (toolChoice === "none") return "none";
    if (toolChoice === "auto") return "auto";
    return "auto";
  }
  if (typeof toolChoice === "object") {
    const mode = toolChoice.type ?? toolChoice.mode;
    if (mode === "none") return "none";
    // 指定具体函数 → 上游不支持，降级为 auto（工具描述里已带语义）
    return "auto";
  }
  return "auto";
}

/**
 * Responses 的 reasoning 配置 → 上游 reasoning_effort。
 * Codex 发的是 { effort, summary }；上游只认字符串档位。
 */
export function responsesReasoningToChat(reasoning) {
  if (!reasoning || typeof reasoning !== "object") return undefined;
  const eff = reasoning.effort;
  if (typeof eff !== "string") return undefined;
  const allowed = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
  return allowed.has(eff) ? eff : undefined;
}

/**
 * 把 Responses 的 input 数组转换成 Chat Completions 的 messages。
 *
 * 覆盖 Codex 实际会发的项类型（本机 0.162.0-alpha.2 抓包确认）：
 *   - message(role=developer|user|assistant)
 *   - function_call        （assistant 发起工具调用）
 *   - function_call_output （工具执行结果）
 *   - reasoning            （思考摘要，上游无对应，丢弃）
 */
export function responsesInputToMessages(input, { instructions } = {}) {
  const messages = [];
  const dropped = [];

  if (typeof instructions === "string" && instructions.trim()) {
    messages.push({ role: "system", content: instructions });
  }

  const items = Array.isArray(input) ? input : (input ? [input] : []);

  // function_call 与 function_call_output 需要按 call_id 归并进 assistant 的 tool_calls
  const pendingCalls = new Map();

  const flushAssistantToolCalls = () => {
    if (pendingCalls.size === 0) return;
    messages.push({ role: "assistant", content: null, tool_calls: [...pendingCalls.values()] });
    pendingCalls.clear();
  };

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const type = item.type;

    if (type === "message" || (!type && item.role)) {
      flushAssistantToolCalls();
      const role = item.role === "developer" ? "system"
        : item.role === "system" ? "system"
          : item.role === "assistant" ? "assistant"
            : item.role === "tool" ? "tool"
              : "user";
      const content = contentToChat(item.content);
      if (role === "tool") {
        messages.push({ role: "tool", tool_call_id: item.tool_call_id ?? item.call_id ?? "", content: contentToText(item.content) });
      } else {
        messages.push({ role, content });
      }
      continue;
    }

    if (type === "function_call") {
      const callId = item.call_id ?? item.id ?? rid("call");
      pendingCalls.set(callId, {
        id: callId,
        type: "function",
        function: { name: item.name ?? "", arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}) },
      });
      continue;
    }

    if (type === "function_call_output") {
      flushAssistantToolCalls();
      const out = item.output;
      const text = typeof out === "string" ? out
        : Array.isArray(out) ? out.map((o) => (typeof o === "string" ? o : o?.text ?? "")).join("")
          : JSON.stringify(out ?? "");
      messages.push({ role: "tool", tool_call_id: item.call_id ?? item.id ?? "", content: text });
      continue;
    }

    if (type === "reasoning") {
      // 上游没有 reasoning 回灌通道，丢弃（不影响多轮，因为正文与工具调用都在）
      dropped.push("reasoning");
      continue;
    }

    dropped.push(type ?? "(unknown)");
  }

  flushAssistantToolCalls();
  return { messages, dropped };
}

/**
 * 主入口：Responses 请求体 → Chat Completions 请求体。
 *
 * @returns {{ body: object, meta: object }}
 */
export function responsesRequestToChat(req, { defaults = {} } = {}) {
  const { messages, dropped: droppedInput } = responsesInputToMessages(req.input, {
    instructions: req.instructions,
  });

  const { tools, dropped: droppedTools, alias } = responsesToolsToChat(req.tools);
  const hasTools = tools.length > 0;

  const body = {
    model: req.model ?? defaults.model ?? "auto",
    messages,
    // 上游强制流式：非流式会返回 400 code 11101
    stream: true,
    stream_options: { include_usage: true },
  };

  if (hasTools) {
    body.tools = tools;
    const tc = responsesToolChoiceToChat(req.tool_choice, { hasTools });
    if (tc) body.tool_choice = tc;
    if (typeof req.parallel_tool_calls === "boolean") body.parallel_tool_calls = req.parallel_tool_calls;
  }

  const effort = responsesReasoningToChat(req.reasoning);
  if (effort) body.reasoning_effort = effort;

  // 透传常见采样参数（上游支持）
  for (const key of ["temperature", "top_p", "max_output_tokens", "presence_penalty", "frequency_penalty", "seed", "stop"]) {
    if (req[key] === undefined) continue;
    if (key === "max_output_tokens") body.max_tokens = req[key];
    else body[key] = req[key];
  }
  // max_tokens 直接给出时优先
  if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;

  return {
    body,
    meta: {
      droppedInput,
      droppedTools,
      alias,
      hasTools,
      messageCount: messages.length,
    },
  };
}

// ---------------------------------------------------------------------------
// 回程：Chat Completions SSE → Responses SSE
// ---------------------------------------------------------------------------

/**
 * 把上游的 Chat Completions SSE 事件流翻译成 Codex 需要的 Responses SSE 事件流。
 *
 * 上游 chunk 形态（实测）：
 *   { choices:[{ delta:{ content?, reasoning_content?, tool_calls?[{index,id,function:{name,arguments}}] }, finish_reason? }], usage? }
 *
 * 输出事件序列（已在本机 Codex 0.162.0-alpha.2 端到端验证）：
 *   文本：response.created → response.output_item.added(message) →
 *         response.content_part.added → response.output_text.delta×N →
 *         response.output_text.done → response.content_part.done →
 *         response.output_item.done → response.completed
 *   工具：response.created → response.output_item.added(function_call) →
 *         response.function_call_arguments.delta×N → response.function_call_arguments.done →
 *         response.output_item.done → response.completed
 *
 * @param {AsyncIterable<string>} chatSseLines 上游 SSE 的 data 载荷（已去掉 "data: " 前缀）
 * @param {{ model: string, reasoningSummary?: boolean, alias?: Map }} opts
 * @returns {AsyncGenerator<{event: string, data: object}>}
 */
export async function* chatStreamToResponses(chatSseLines, opts = {}) {
  const model = opts.model ?? "unknown";
  const responseId = rid("resp");
  let seq = 0;
  const next = () => seq++;

  const created = (status) => ({
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: [],
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
  });

  // 先发 created，Codex 依赖它建立回合
  yield { event: "response.created", data: { type: "response.created", sequence_number: next(), response: created("in_progress") } };
  yield { event: "response.in_progress", data: { type: "response.in_progress", sequence_number: next(), response: created("in_progress") } };

  let messageItemId = null;   // 文本消息项 id
  let textStarted = false;
  let textBuffer = "";
  let reasoningBuffer = "";

  /** {index: {id, name, arguments}} */
  const toolCalls = new Map();
  // 文本消息固定占 output_index 0；工具调用从 1 开始，避免两者冲突。
  const MESSAGE_INDEX = 0;
  let nextToolIndex = 1;
  const completedItems = [];

  const ensureMessageItem = function* () {
    if (messageItemId) return;
    messageItemId = rid("msg");
    yield {
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        sequence_number: next(),
        output_index: MESSAGE_INDEX,
        item: { id: messageItemId, type: "message", status: "in_progress", role: "assistant", content: [] },
      },
    };
    yield {
      event: "response.content_part.added",
      data: {
        type: "response.content_part.added",
        sequence_number: next(),
        item_id: messageItemId,
        output_index: MESSAGE_INDEX,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
    };
  };

  const ensureToolItem = function* (idx) {
    const tc = toolCalls.get(idx);
    if (!tc || tc.added) return;
    tc.added = true;
    tc.outputIndex = nextToolIndex++;
    // call_id 用上游的 tool_call id（Codex 下一轮用 call_id 回填 function_call_output）
    tc.callId = tc.id ?? rid("call");
    tc.itemId = rid("fc");
    yield {
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        sequence_number: next(),
        output_index: tc.outputIndex,
        item: {
          id: tc.itemId,
          type: "function_call",
          status: "in_progress",
          call_id: tc.callId,
          name: tc.name ?? "",
          arguments: "",
        },
      },
    };
  };

  const finalized = new Set();

  const finalizeTools = function* () {
    for (const [idx, tc] of toolCalls) {
      if (finalized.has(idx)) continue;
      finalized.add(idx);
      if (!tc.added) yield* ensureToolItem(idx);
      yield {
        event: "response.function_call_arguments.done",
        data: {
          type: "response.function_call_arguments.done",
          sequence_number: next(),
          item_id: tc.itemId,
          output_index: tc.outputIndex,
          arguments: tc.arguments,
        },
      };
      const item = {
        id: tc.itemId,
        type: "function_call",
        status: "completed",
        call_id: tc.callId,
        name: tc.name ?? "",
        arguments: tc.arguments,
      };
      completedItems.push(item);
      yield {
        event: "response.output_item.done",
        data: { type: "response.output_item.done", sequence_number: next(), output_index: tc.outputIndex, item },
      };
    }
  };

  let finishReason = null;
  let usage = null;

  for await (const raw of chatSseLines) {
    if (raw === "[DONE]") break;
    let chunk;
    try { chunk = JSON.parse(raw); } catch { continue; }

    if (chunk.usage) usage = chunk.usage;
    // 上游错误常以 {code,msg} 形式出现在流里
    if (chunk.code && chunk.code !== 0 && chunk.msg) {
      yield {
        event: "response.failed",
        data: {
          type: "response.failed",
          sequence_number: next(),
          response: { ...created("failed"), error: { code: String(chunk.code), message: String(chunk.msg) } },
        },
      };
      return;
    }

    for (const choice of chunk.choices ?? []) {
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};

      const thought = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text;
      if (typeof thought === "string" && thought) {
        reasoningBuffer += thought;
        // 思考内容以 reasoning summary 形式给出（Codex 用 'summary' 展示）
        if (opts.reasoningSummary !== false) {
          yield* ensureMessageItem();
          yield {
            event: "response.reasoning_summary_text.delta",
            data: {
              type: "response.reasoning_summary_text.delta",
              sequence_number: next(),
              item_id: messageItemId,
              output_index: MESSAGE_INDEX,
              summary_index: 0,
              delta: thought,
            },
          };
        }
      }

      if (typeof delta.content === "string" && delta.content) {
        yield* ensureMessageItem();
        if (!textStarted) textStarted = true;
        textBuffer += delta.content;
        yield {
          event: "response.output_text.delta",
          data: {
            type: "response.output_text.delta",
            sequence_number: next(),
            item_id: messageItemId,
            output_index: MESSAGE_INDEX,
            content_index: 0,
            delta: delta.content,
          },
        };
      }

      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const slot = toolCalls.get(idx) ?? { id: null, name: "", arguments: "", added: false };
        if (tc.id) slot.id = tc.id;
        const fn = tc.function ?? {};
        if (fn.name) slot.name = (slot.name ?? "") + fn.name;
        if (typeof fn.arguments === "string") slot.arguments += fn.arguments;
        toolCalls.set(idx, slot);
        if (slot.name || slot.arguments) {
          yield* ensureToolItem(idx);
          const cur = toolCalls.get(idx);
          if (typeof fn.arguments === "string" && fn.arguments) {
            yield {
              event: "response.function_call_arguments.delta",
              data: {
                type: "response.function_call_arguments.delta",
                sequence_number: next(),
                item_id: cur.itemId,
                output_index: cur.outputIndex,
                delta: fn.arguments,
              },
            };
          }
        }
      }
    }
  }

  // ---- 收尾 ----
  if (reasoningBuffer && opts.reasoningSummary !== false) {
    yield {
      event: "response.reasoning_summary_text.done",
      data: {
        type: "response.reasoning_summary_text.done",
        sequence_number: next(),
        item_id: messageItemId,
        output_index: MESSAGE_INDEX,
        summary_index: 0,
        text: reasoningBuffer,
      },
    };
  }

  if (messageItemId) {
    yield {
      event: "response.output_text.done",
      data: {
        type: "response.output_text.done",
        sequence_number: next(),
        item_id: messageItemId,
        output_index: MESSAGE_INDEX,
        content_index: 0,
        text: textBuffer,
      },
    };
    yield {
      event: "response.content_part.done",
      data: {
        type: "response.content_part.done",
        sequence_number: next(),
        item_id: messageItemId,
        output_index: MESSAGE_INDEX,
        content_index: 0,
        part: { type: "output_text", text: textBuffer, annotations: [] },
      },
    };
    const msgItem = {
      id: messageItemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: textBuffer, annotations: [] }],
    };
    completedItems.push(msgItem);
    yield {
      event: "response.output_item.done",
      data: { type: "response.output_item.done", sequence_number: next(), output_index: MESSAGE_INDEX, item: msgItem },
    };
  }

  yield* finalizeTools();

  const u = usage ?? {};
  const usageOut = {
    input_tokens: u.prompt_tokens ?? 0,
    input_tokens_details: { cached_tokens: u.prompt_cache_hit_tokens ?? u.cached_tokens ?? 0 },
    output_tokens: u.completion_tokens ?? 0,
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? u.completion_thinking_tokens ?? 0 },
    total_tokens: u.total_tokens ?? ((u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
  };

  const status = "completed";
  const hasToolCalls = completedItems.some((i) => i?.type === "function_call");
  const finalResponse = {
    ...created(status),
    output: completedItems,
    usage: usageOut,
    // 有工具调用时必须让 Codex 继续下一轮（end_turn=false）；
    // 否则 Codex 会在拿到工具结果前就结束回合。
    end_turn: !hasToolCalls,
    incomplete_details: finishReason === "length" ? { reason: "max_output_tokens" } : null,
  };

  yield { event: "response.completed", data: { type: "response.completed", sequence_number: next(), response: finalResponse } };
}

/**
 * 非流式聚合：把上游 SSE 聚合成一个完整 Chat Completions 对象。
 * 用于 /v1/chat/completions 兼容端点。
 */
export function aggregateChatStream(chunks) {
  let content = "";
  let reasoning = "";
  const toolCalls = new Map();
  let finishReason = null;
  let usage = null;
  let model = null;

  for (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    model = chunk.model ?? model;
    for (const choice of chunk.choices ?? []) {
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const d = choice.delta ?? {};
      if (typeof d.content === "string") content += d.content;
      const t = d.reasoning_content ?? d.reasoning ?? d.reasoning_text;
      if (typeof t === "string") reasoning += t;
      for (const tc of d.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const slot = toolCalls.get(idx) ?? { id: null, name: "", arguments: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = (slot.name ?? "") + tc.function.name;
        if (typeof tc.function?.arguments === "string") slot.arguments += tc.function.arguments;
        toolCalls.set(idx, slot);
      }
    }
  }

  const message = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v], i) => ({
      id: v.id ?? `call_${i}`,
      type: "function",
      function: { name: v.name, arguments: v.arguments },
    }));
    if (!finishReason) finishReason = "tool_calls";
  }

  return {
    id: rid("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model ?? "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** 把 Responses 事件对象序列化成 SSE 文本块。 */
export function toSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
