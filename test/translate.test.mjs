/**
 * 协议转换单元测试（node:test，零依赖）
 *   node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  responsesRequestToChat,
  responsesInputToMessages,
  responsesToolsToChat,
  responsesToolChoiceToChat,
  responsesReasoningToChat,
  chatStreamToResponses,
  aggregateChatStream,
} from "../src/translate.mjs";

/** 把上游 chunk 数组包成 chatStreamToResponses 需要的异步迭代器。 */
async function* feed(chunks) {
  for (const c of chunks) yield JSON.stringify(c);
}

/** 收集全部事件。 */
async function collect(chunks, opts) {
  const out = [];
  for await (const ev of chatStreamToResponses(feed(chunks), opts)) out.push(ev);
  return out;
}

// ---------------------------------------------------------------------------
// 请求方向
// ---------------------------------------------------------------------------

test("instructions 变成 system 消息，developer 也归为 system", () => {
  const { body } = responsesRequestToChat({
    model: "m1",
    instructions: "be terse",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "dev rules" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ],
  });
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[0].content, "be terse");
  assert.equal(body.messages[1].role, "system");
  assert.equal(body.messages[1].content, "dev rules");
  assert.equal(body.messages[2].role, "user");
  assert.equal(body.messages[2].content, "hi");
});

test("上游强制流式：始终 stream=true 且带 include_usage", () => {
  const { body } = responsesRequestToChat({ model: "m", input: [] });
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test("Codex 专有字段不泄漏到上游 body", () => {
  const { body } = responsesRequestToChat({
    model: "m",
    input: [],
    store: false,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "abc",
    previous_response_id: "resp_x",
    client_metadata: { a: 1 },
  });
  for (const k of ["store", "include", "prompt_cache_key", "previous_response_id", "client_metadata"]) {
    assert.equal(k in body, false, `${k} 不应出现在上游 body`);
  }
});

test("function_call + function_call_output 归并成 assistant.tool_calls 与 role:tool", () => {
  const { body } = responsesRequestToChat({
    model: "m",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "weather?" }] },
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"BJ"}' },
      { type: "function_call_output", call_id: "call_1", output: "sunny" },
    ],
  });
  const asst = body.messages.find((m) => m.role === "assistant");
  assert.ok(asst, "应有 assistant 消息");
  assert.equal(asst.tool_calls.length, 1);
  assert.equal(asst.tool_calls[0].id, "call_1");
  assert.equal(asst.tool_calls[0].function.name, "get_weather");
  const tool = body.messages.find((m) => m.role === "tool");
  assert.equal(tool.tool_call_id, "call_1");
  assert.equal(tool.content, "sunny");
});

test("namespace 工具被拍平并记录 alias", () => {
  const { tools, alias, dropped } = responsesToolsToChat([
    { type: "namespace", name: "multi_agent_v1", tools: [
      { type: "function", name: "spawn", description: "spawn", parameters: { type: "object", properties: {} } },
    ] },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].function.name, "multi_agent_v1__spawn");
  assert.deepEqual(alias.get("multi_agent_v1__spawn"), { namespace: "multi_agent_v1", name: "spawn" });
  assert.equal(dropped.length, 0);
});

test("web_search 被丢弃且进入 dropped 列表", () => {
  const { tools, dropped } = responsesToolsToChat([
    { type: "function", name: "f", parameters: { type: "object", properties: {} } },
    { type: "web_search" },
  ]);
  assert.equal(tools.length, 1);
  assert.deepEqual(dropped, ["web_search"]);
});

test("custom 自由格式工具被包成单字符串参数的 function", () => {
  const { tools } = responsesToolsToChat([
    { type: "custom", name: "apply_patch", description: "patch" },
  ]);
  assert.equal(tools[0].function.name, "apply_patch");
  assert.ok(tools[0].function.parameters.properties.input);
});

test("tool_choice 对象形式降级为字符串 auto（上游只接受字符串）", () => {
  assert.equal(responsesToolChoiceToChat({ type: "function", name: "f" }, { hasTools: true }), "auto");
  assert.equal(responsesToolChoiceToChat("required", { hasTools: true }), "required");
  assert.equal(responsesToolChoiceToChat("none", { hasTools: true }), "none");
  assert.equal(responsesToolChoiceToChat("auto", { hasTools: false }), undefined);
});

test("reasoning.effort 合法值透传，非法值丢弃", () => {
  assert.equal(responsesReasoningToChat({ effort: "high" }), "high");
  assert.equal(responsesReasoningToChat({ effort: "bogus" }), undefined);
  assert.equal(responsesReasoningToChat({ summary: "auto" }), undefined);
});

test("max_output_tokens 映射为上游 max_tokens", () => {
  const { body } = responsesRequestToChat({ model: "m", input: [], max_output_tokens: 512 });
  assert.equal(body.max_tokens, 512);
  assert.equal("max_output_tokens" in body, false);
});

test("空 input 不崩溃", () => {
  const { body } = responsesRequestToChat({ model: "m", input: [] });
  assert.deepEqual(body.messages, []);
});

test("reasoning 项被丢弃但不影响其它消息", () => {
  const { messages, dropped } = responsesInputToMessages([
    { type: "reasoning", summary: [] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "x" }] },
  ]);
  assert.equal(messages.length, 1);
  assert.ok(dropped.includes("reasoning"));
});

// ---------------------------------------------------------------------------
// 流方向
// ---------------------------------------------------------------------------

test("纯文本流：事件顺序正确且必达 response.completed", async () => {
  const evs = await collect([
    { model: "m", choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { model: "m", choices: [{ delta: { content: "你" } }] },
    { model: "m", choices: [{ delta: { content: "好" }, finish_reason: "stop" }] },
    { model: "m", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ]);
  const types = evs.map((e) => e.event);
  assert.equal(types[0], "response.created");
  assert.ok(types.includes("response.output_text.delta"));
  assert.ok(types.includes("response.output_item.done"));
  assert.equal(types.at(-1), "response.completed");

  const text = evs.filter((e) => e.event === "response.output_text.delta").map((e) => e.data.delta).join("");
  assert.equal(text, "你好");

  const completed = evs.at(-1).data.response;
  assert.equal(completed.usage.input_tokens, 3);
  assert.equal(completed.usage.output_tokens, 2);
  assert.equal(completed.usage.total_tokens, 5);
  assert.equal(completed.end_turn, true);

  // 消息项必须出现在 output 里（Codex 靠 output_item.done 入库）
  const msg = completed.output.find((i) => i.type === "message");
  assert.ok(msg, "completed.output 应包含 message");
  assert.equal(msg.content[0].text, "你好");
});

test("工具调用流：arguments 分片拼接并出现在 output_item.done", async () => {
  const evs = await collect([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "get_weather", arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"BJ"}' } }] }, finish_reason: "tool_calls" }] },
  ], { model: "m" });
  const completed = evs.at(-1).data.response;
  const fc = completed.output.find((i) => i.type === "function_call");
  assert.ok(fc, "completed.output 应包含 function_call");
  assert.equal(fc.name, "get_weather");
  assert.equal(fc.arguments, '{"city":"BJ"}');
  assert.equal(fc.call_id, "call_9");
  assert.equal(completed.end_turn, false, "有工具调用时 end_turn 应为 false");
});

test("文本与工具调用同时存在时 output_index 不冲突", async () => {
  const evs = await collect([
    { choices: [{ delta: { content: "let me check" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
  ], { model: "m" });
  const done = evs.filter((e) => e.event === "response.output_item.done");
  const idx = done.map((e) => e.data.output_index);
  assert.equal(new Set(idx).size, idx.length, `output_index 应互不相同，实际 ${idx.join(",")}`);
  const msgIdx = done.find((e) => e.data.item.type === "message").data.output_index;
  const fcIdx = done.find((e) => e.data.item.type === "function_call").data.output_index;
  assert.notEqual(msgIdx, fcIdx);
});

test("sequence_number 严格单调递增", async () => {
  const evs = await collect([
    { choices: [{ delta: { content: "a" } }] },
    { choices: [{ delta: { reasoning_content: "think" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: "{}" } }] } }] },
  ], { model: "m" });
  const seqs = evs.map((e) => e.data.sequence_number);
  assert.ok(seqs.every((n) => typeof n === "number"), "每个事件都应有 sequence_number");
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i] > seqs[i - 1], `sequence_number 必须在 ${i} 处递增：${seqs[i - 1]} -> ${seqs[i]}`);
  }
});

test("上游错误 chunk 转为 response.failed", async () => {
  const evs = await collect([{ code: 11101, msg: "Non-stream chat request is currently not supported" }], { model: "m" });
  assert.equal(evs.at(-1).event, "response.failed");
  assert.match(evs.at(-1).data.response.error.message, /Non-stream/);
});

test("空流也会发 response.completed（避免 Codex 报 stream closed）", async () => {
  const evs = await collect([], { model: "m" });
  assert.equal(evs.at(-1).event, "response.completed");
});

test("tool_calls index 乱序与重复不会丢数据", async () => {
  const evs = await collect([
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "b", arguments: "{}" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "a", arguments: "{}" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "" } }] } }] },
  ], { model: "m" });
  const fcs = evs.at(-1).data.response.output.filter((i) => i.type === "function_call");
  assert.equal(fcs.length, 2, "两个工具调用都应在 output 里");
  const names = fcs.map((f) => f.name).sort();
  assert.deepEqual(names, ["a", "b"]);
});

test("reasoning_content 以 summary 事件发出", async () => {
  const evs = await collect([{ choices: [{ delta: { reasoning_content: "thinking..." } }] }], { model: "m" });
  const types = evs.map((e) => e.event);
  assert.ok(types.includes("response.reasoning_summary_text.delta"));
  assert.ok(types.includes("response.reasoning_summary_text.done"));
});

test("关闭 reasoningSummary 时不发 summary 事件", async () => {
  const evs = await collect([{ choices: [{ delta: { reasoning_content: "t" } }] }], { model: "m", reasoningSummary: false });
  const types = evs.map((e) => e.event);
  assert.equal(types.includes("response.reasoning_summary_text.delta"), false);
});

// ---------------------------------------------------------------------------
// 非流式聚合
// ---------------------------------------------------------------------------

test("aggregateChatStream 聚合文本与 usage", () => {
  const agg = aggregateChatStream([
    { model: "m", choices: [{ delta: { content: "he" } }] },
    { model: "m", choices: [{ delta: { content: "llo" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
  ]);
  assert.equal(agg.choices[0].message.content, "hello");
  assert.equal(agg.choices[0].finish_reason, "stop");
  assert.equal(agg.usage.total_tokens, 3);
});

test("aggregateChatStream 聚合工具调用并修正 finish_reason", () => {
  const agg = aggregateChatStream([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: '{"a"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] },
  ]);
  assert.equal(agg.choices[0].message.tool_calls[0].function.arguments, '{"a":1}');
  assert.equal(agg.choices[0].finish_reason, "tool_calls");
});
