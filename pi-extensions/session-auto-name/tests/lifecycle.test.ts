import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { assistant, flush, harness, namingModel, requestData, sessionModel } from "./helpers.ts";

const initial = { title: "修复 OAuth 登录问题" };
const refined = { action: "rename", title: "修复 OAuth 回调状态校验" };
const sessionRequest = { provider: sessionModel.provider, modelId: sessionModel.id, thinkingLevel: null };

function namingMetadata(h: ReturnType<typeof harness>) {
  return h.manager.getEntries().filter((entry) => entry.type === "custom")
    .filter((entry) => entry.customType === "session-auto-name").map((entry) => entry.data);
}

test("both stages run in the background, rename once each, and never repeat on later turns", async (t) => {
  const h = harness(t);
  await h.start();
  await h.begin("修复 OAuth 登录问题");
  assert.equal(h.calls.length, 1, "input processing returns while the naming request is unresolved");
  assert.equal(h.names.length, 0);
  await h.respond(0, initial);
  assert.deepEqual(h.names, [initial.title]);

  h.answer("已修复回调中的 state 参数校验。");
  await h.settle();
  await flush();
  assert.equal(h.calls.length, 2, "settlement returns while refinement is unresolved");
  assert.deepEqual(requestData(h.calls[1]!), {
    firstUserPrompt: "修复 OAuth 登录问题", initialTitle: initial.title,
    finalAssistantReply: "已修复回调中的 state 参数校验。",
  });
  await h.respond(1, refined);
  assert.deepEqual(h.names, [initial.title, refined.title]);
  await h.begin("下一件事，修改主题");
  h.answer("已修改主题");
  await h.settle();
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.warnings.length, 0);
  assert.equal(h.manager.getEntries().filter((entry) => entry.type === "message").length, 4);
  const states = h.manager.getEntries().filter((entry) => entry.type === "custom");
  assert.ok(states.length > 0);
  assert.ok(states.every((entry) => entry.customType === "session-auto-name"));
  assert.deepEqual(namingMetadata(h), ["initial_started", "initial_completed", "refinement_started", "completed"]
    .map((phase) => ({ version: 1, phase, ...sessionRequest })));
  assert.doesNotMatch(JSON.stringify(states), /OAuth|firstUserPrompt|finalAssistantReply/);
});

test("fast main reply waits for the first name, snapshots the reply, and preserves original input language", async (t) => {
  const h = harness(t);
  await h.start();
  await h.input("修复登录");
  await h.beforeStart("Expanded English skill instructions that must not replace the Chinese user prompt");
  h.manager.appendMessage({ role: "user", content: "修复登录", timestamp: Date.now() });
  h.answer("修复了 OAuth 回调校验");
  await h.settle();
  assert.equal(h.calls.length, 1);
  await h.begin("Now work on a different task");
  h.answer("Unrelated later answer");
  await h.settle();
  await h.respond(0, initial);
  assert.equal(h.calls.length, 2);
  assert.equal(requestData(h.calls[0]!).firstUserPrompt, "修复登录");
  assert.equal(requestData(h.calls[1]!).finalAssistantReply, "修复了 OAuth 回调校验");
  await h.respond(1, { action: "keep" });
  assert.deepEqual(h.names, [initial.title]);
});

test("a queued follow-up drained before settlement cannot replace the first answer", async (t) => {
  const h = harness(t);
  await h.start();
  await h.begin("First task");
  h.answer("First task result");
  await h.begin("Queued follow-up task");
  h.answer("Unrelated follow-up result");
  await h.settle();
  await h.respond(0, initial);
  assert.equal(requestData(h.calls[1]!).firstUserPrompt, "First task");
  assert.equal(requestData(h.calls[1]!).finalAssistantReply, "First task result");
  await h.respond(1, { action: "keep" });
});

test("steering during tool use stays part of the first response", async (t) => {
  const h = harness(t);
  await h.start();
  await h.begin("First task");
  h.answer("Inspecting files", "toolUse");
  await h.begin("Steering clarification");
  h.answer("Completed the first task with the clarification");
  await h.settle();
  await h.respond(0, initial);
  assert.equal(requestData(h.calls[1]!).finalAssistantReply, "Completed the first task with the clarification");
  await h.respond(1, { action: "keep" });
});

test("a failed first response is not replaced by a successful queued follow-up", async (t) => {
  const h = harness(t);
  await h.start();
  await h.begin("First task");
  h.answer("Failed first response", "error");
  await h.begin("Queued second task");
  h.answer("Successful second response");
  await h.settle();
  await h.respond(0, initial);
  assert.equal(h.calls.length, 1);
});

test("intermediate tool replies and agent_end do not start refinement", async (t) => {
  const h = harness(t);
  await h.start();
  await h.begin("Fix login");
  await h.respond(0, initial);
  const intermediate = assistant("I will inspect the code", "toolUse");
  intermediate.content.push({ type: "toolCall", id: "tool", name: "bash", arguments: { command: "SECRET arguments" } });
  h.manager.appendMessage(intermediate);
  await h.emit({ type: "message_end", message: intermediate });
  await h.emit({ type: "agent_end", messages: [intermediate] });
  assert.equal(h.calls.length, 1);
  h.manager.appendMessage({
    role: "toolResult", toolCallId: "tool", toolName: "bash", content: [{ type: "text", text: "SECRET raw output" }],
    isError: false, timestamp: Date.now(),
  });
  const final = assistant("Fixed the OAuth callback");
  final.content.unshift({ type: "thinking", thinking: "SECRET reasoning" });
  h.manager.appendMessage(final);
  await h.settle();
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(requestData(h.calls[1]!).finalAssistantReply, "Fixed the OAuth callback");
  assert.doesNotMatch(JSON.stringify(h.calls[1]!.context), /SECRET|inspect the code/);
  await h.respond(1, { action: "keep" });
});

test("recovery uses the eventual successful answer, not a failed agent_end", async (t) => {
  const h = harness(t);
  await h.start();
  await h.begin("Fix login");
  h.answer("Temporary failure", "error");
  await h.emit({ type: "agent_end", messages: [assistant("Temporary failure", "error")] });
  assert.equal(h.calls.length, 1);
  h.answer("Recovered final answer");
  await h.settle();
  await h.respond(0, initial);
  assert.equal(requestData(h.calls[1]!).finalAssistantReply, "Recovered final answer");
  await h.respond(1, { action: "keep" });
});

test("manual names neither disable naming nor cancel outstanding results", async (t) => {
  const h = harness(t);
  h.manager.appendSessionInfo("Manual before first prompt");
  await h.start();
  await h.begin("Fix login");
  h.manager.appendSessionInfo("Manual while initial naming runs");
  await h.respond(0, initial);
  assert.equal(h.manager.getSessionName(), initial.title);
  h.answer("Fixed callback validation");
  await h.settle();
  await flush();
  h.manager.appendSessionInfo("Manual while refinement runs");
  await h.respond(1, refined);
  assert.equal(h.manager.getSessionName(), refined.title);
});

test("keep leaves an intervening manual name intact", async (t) => {
  const h = harness(t);
  await h.start();
  await h.begin("Fix login");
  await h.respond(0, initial);
  h.answer("Fixed");
  await h.settle();
  await flush();
  h.manager.appendSessionInfo("Manual name");
  await h.respond(1, { action: "keep" });
  assert.equal(h.manager.getSessionName(), "Manual name");
  assert.deepEqual(h.names, [initial.title]);
});

test("identical titles do not create duplicate name writes", async (t) => {
  const h = harness(t);
  h.manager.appendSessionInfo(initial.title);
  await h.start();
  await h.begin("Fix login");
  await h.respond(0, initial);
  h.answer("Fixed");
  await h.settle();
  await flush();
  await h.respond(1, { action: "rename", title: initial.title });
  assert.equal(h.names.length, 0);
});

test("a failed first name still permits one refinement attempt", async (t) => {
  const h = harness(t);
  await h.start();
  await h.begin("Fix login");
  h.answer("Fixed callback validation");
  await h.settle();
  h.calls[0]!.result.reject(new Error("API_KEY=SECRET"));
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(requestData(h.calls[1]!).initialTitle, null);
  await h.respond(1, refined);
  assert.deepEqual(h.names, [refined.title]);
  assert.equal(h.warnings.length, 1);
  assert.doesNotMatch(h.warnings[0]!, /SECRET/);
  assert.deepEqual(namingMetadata(h), ["initial_started", "initial_failed", "refinement_started", "completed"]
    .map((phase) => ({ version: 1, phase, ...sessionRequest })));
  assert.doesNotMatch(JSON.stringify(namingMetadata(h)), /SECRET/);
});

test("failed refinement preserves the current name, never retries, and warns at most once", async (t) => {
  const h = harness(t);
  await h.start();
  await h.begin("Fix login");
  await h.respond(0, initial);
  h.answer("Fixed");
  await h.settle();
  await flush();
  await h.respond(1, { action: "rename", title: "" });
  await h.settle();
  await flush();
  assert.deepEqual(h.names, [initial.title]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.warnings.length, 1);
  assert.deepEqual(namingMetadata(h), ["initial_started", "initial_completed", "refinement_started", "refinement_failed"]
    .map((phase) => ({ version: 1, phase, ...sessionRequest })));
});

for (const scenario of ["aborted", "error", "empty"] as const) {
  test(`skip refinement for ${scenario} first reply, even if a later turn succeeds`, async (t) => {
    const h = harness(t);
    await h.start();
    await h.begin("Fix login");
    h.answer(scenario === "empty" ? "" : "Partial", scenario === "error" ? "error" : "stop");
    await h.settle(scenario === "aborted");
    await h.respond(0, initial);
    assert.deepEqual(namingMetadata(h).at(-1), { version: 1, phase: "refinement_skipped" });
    await h.begin("Try again");
    h.answer("Later success");
    await h.settle();
    await flush();
    assert.equal(h.calls.length, 1);
  });
}

for (const mode of ["rpc", "json", "print"] as const) {
  test(`${mode} mode does not read config or issue naming requests`, async (t) => {
    const h = harness(t, { mode });
    writeFileSync(join(h.agentDir, "session-auto-name.json"), "broken");
    await h.start();
    await h.begin("Fix login");
    h.answer("Fixed");
    await h.settle();
    assert.equal(h.calls.length, 0);
    assert.equal(h.warnings.length, 0);
  });
}

for (const reason of ["resume", "reload", "fork"] as const) {
  test(`${reason} never fills in missing naming stages`, async (t) => {
    const h = harness(t);
    await h.start(reason);
    await h.begin("Fix login");
    h.answer("Fixed");
    await h.settle();
    assert.equal(h.calls.length, 0);
  });
}

test("startup with history or a prior marker is not a new session, even on an empty branch", async (t) => {
  const h = harness(t);
  h.manager.appendMessage({ role: "user", content: "Old prompt", timestamp: Date.now() });
  h.manager.resetLeaf();
  await h.start();
  await h.begin("New branch prompt");
  assert.equal(h.calls.length, 0);
  h.replaceSession();
  h.manager.appendCustomEntry("session-auto-name", { version: 1, phase: "initial_failed" });
  await h.start();
  await h.begin("Another prompt");
  assert.equal(h.calls.length, 0);
});

test("startup distinguishes an allocated path from an existing session file", async (t) => {
  const h = harness(t, { persistent: true });
  const file = h.manager.getSessionFile()!;
  writeFileSync(file, JSON.stringify(h.manager.getHeader()) + "\n");
  h.manager.setSessionFile(file);
  await h.start();
  await h.begin("Do not name this existing file");
  assert.equal(h.calls.length, 0);
});

test("a genuinely new persistent session names and persists metadata", async (t) => {
  const h = harness(t, { persistent: true });
  await h.start();
  await h.begin("Fix login");
  await h.respond(0, initial);
  assert.equal(h.manager.getSessionName(), initial.title);
  assert.ok(h.manager.getEntries().some((entry) => entry.type === "session_info" && entry.name === initial.title));
  h.answer("Fixed");
  await h.settle();
  await flush();
  await h.respond(1, { action: "keep" });
  const persisted = readFileSync(h.manager.getSessionFile()!, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "custom" && entry.customType === "session-auto-name")
    .map((entry) => entry.data);
  assert.deepEqual(persisted, ["initial_started", "initial_completed", "refinement_started", "completed"]
    .map((phase) => ({ version: 1, phase, ...sessionRequest })));
});

for (const reason of ["new", "resume", "fork", "reload", "quit"] as const) {
  test(`shutdown for ${reason} cancels initial work and prevents late writes`, async (t) => {
    const h = harness(t);
    await h.start();
    await h.begin("Fix login");
    h.answer("Fixed");
    await h.settle();
    await h.emit({ type: "session_shutdown", reason });
    assert.equal(h.calls[0]!.options.signal?.aborted, true);
    h.replaceSession();
    await h.respond(0, initial);
    assert.equal(h.calls.length, 1);
    assert.equal(h.names.length, 0);
    assert.equal(h.warnings.length, 0);
    assert.deepEqual(namingMetadata(h), [], "late requests must not write metadata into another session");
  });
}

test("late results do not even access invalidated extension contexts", async (t) => {
  const h = harness(t);
  await h.start();
  await h.begin("Task");
  h.answer("Final answer");
  await h.settle();
  await h.emit({ type: "session_shutdown", reason: "reload" });
  Object.defineProperty(h.ctx, "mode", { get() { throw new Error("Stale extension context"); } });
  await h.respond(0, initial);
  assert.equal(h.names.length, 0);
  assert.equal(h.warnings.length, 0);
});

test("cancel refinement on tree navigation, with no later rerun", async (t) => {
  const h = harness(t);
  await h.start();
  await h.begin("Fix login");
  await h.respond(0, initial);
  h.answer("Fixed");
  await h.settle();
  await flush();
  await h.emit({ type: "session_tree", oldLeafId: null, newLeafId: null });
  assert.equal(h.calls[1]!.options.signal?.aborted, true);
  await h.respond(1, refined);
  await h.begin("Different branch");
  h.answer("Different answer");
  await h.settle();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.names, [initial.title]);
});

test("new session can start its own naming while old results are still in flight", async (t) => {
  const h = harness(t);
  await h.start();
  await h.begin("Old session task");
  await h.emit({ type: "session_shutdown", reason: "new" });
  h.replaceSession();
  await h.start("new");
  await h.begin("新任务");
  await h.respond(0, { title: "Stale title" });
  assert.equal(h.names.length, 0);
  await h.respond(1, { title: "完成新任务" });
  assert.deepEqual(h.names, ["完成新任务"]);
});

test("configured model and thinking level are independent; unconfigured model follows the session", async (t) => {
  const h = harness(t);
  await h.start();
  await h.begin("Task");
  assert.equal(h.calls[0]!.model, sessionModel);
  assert.equal(h.calls[0]!.options.reasoning, undefined);
  assert.deepEqual(namingMetadata(h), [{ version: 1, phase: "initial_started", ...sessionRequest }]);
  h.setModel(namingModel);
  await h.respond(0, initial);
  h.answer("Final");
  await h.settle();
  await flush();
  assert.equal(h.calls[1]!.model, namingModel);
  h.setModel(sessionModel);
  await h.respond(1, { action: "keep" });
  assert.deepEqual(namingMetadata(h), [
    { version: 1, phase: "initial_started", ...sessionRequest },
    { version: 1, phase: "initial_completed", ...sessionRequest },
    { version: 1, phase: "refinement_started", ...sessionRequest, modelId: namingModel.id },
    { version: 1, phase: "completed", ...sessionRequest, modelId: namingModel.id },
  ], "metadata must retain each request's model even when the main model changes while it is pending");

  await h.emit({ type: "session_shutdown", reason: "new" });
  h.replaceSession();
  h.setModel(sessionModel);
  writeFileSync(join(h.agentDir, "session-auto-name.json"), JSON.stringify({
    provider: namingModel.provider, modelId: namingModel.id, thinkingLevel: "low",
  }));
  await h.start("new");
  await h.begin("Another task");
  assert.equal(h.calls[2]!.model, namingModel);
  assert.equal(h.calls[2]!.options.reasoning, "low");
  await h.respond(2, initial);
  h.answer("Final");
  await h.settle();
  await flush();
  assert.equal(h.calls[3]!.model, namingModel);
  assert.equal(h.calls[3]!.options.reasoning, "low");
  assert.equal(h.ctx.model, sessionModel, "naming must not change the main model");
  await h.respond(3, { action: "keep" });
  assert.deepEqual(namingMetadata(h), ["initial_started", "initial_completed", "refinement_started", "completed"]
    .map((phase) => ({ version: 1, phase, provider: namingModel.provider, modelId: namingModel.id, thinkingLevel: "low" })));
});

test("explicit off is distinguishable from an unspecified level, without copying model secrets", async (t) => {
  const h = harness(t);
  writeFileSync(join(h.agentDir, "session-auto-name.json"), JSON.stringify({
    provider: namingModel.provider, modelId: namingModel.id, thinkingLevel: "off",
  }));
  t.mock.method(h.registry, "find", () => ({
    ...namingModel, headers: { Authorization: "SECRET" }, baseUrl: "https://example.invalid/SECRET",
  }));
  await h.start();
  await h.begin("SECRET prompt");
  assert.equal(h.calls[0]!.options.reasoning, undefined);
  await h.respond(0, initial);
  assert.deepEqual(namingMetadata(h), ["initial_started", "initial_completed"].map((phase) => ({
    version: 1, phase, provider: namingModel.provider, modelId: namingModel.id, thinkingLevel: "off",
  })));
  assert.doesNotMatch(JSON.stringify(namingMetadata(h)), /SECRET|Authorization|baseUrl|headers/);
});

test("bad configuration and unknown models never silently fall back", async (t) => {
  const h = harness(t);
  writeFileSync(join(h.agentDir, "session-auto-name.json"), "broken");
  await h.start();
  await h.begin("Task");
  assert.equal(h.calls.length, 0);
  assert.equal(h.warnings.length, 1);
  h.replaceSession();
  writeFileSync(join(h.agentDir, "session-auto-name.json"), '{"provider":"missing","modelId":"missing"}');
  await h.start("new");
  await h.begin("Another task");
  h.answer("Final");
  await h.settle();
  await flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.warnings.length, 2, "one warning per session, not per failed stage");
  assert.deepEqual(namingMetadata(h), [
    { version: 1, phase: "initial_failed" },
    { version: 1, phase: "refinement_failed" },
  ], "a failure before model resolution must not claim that a model request started");
});

test("handled input is replaced by the next accepted prompt before naming", async (t) => {
  const h = harness(t);
  await h.start();
  await h.input("Input consumed by another extension");
  assert.equal(h.calls.length, 0);
  await h.begin("Actual prompt");
  assert.equal(requestData(h.calls[0]!).firstUserPrompt, "Actual prompt");
});

for (const source of ["extension", "rpc"] as const) {
  test(`synthetic ${source} input does not claim the first-user naming cycle`, async (t) => {
    const h = harness(t);
    await h.start();
    await h.begin("Synthetic input", source);
    h.answer("Answer");
    await h.settle();
    await h.begin("Later interactive input");
    assert.equal(h.calls.length, 0);
  });
}

test("image-only first input skips the cycle rather than naming a later prompt", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit({ type: "input", text: "", source: "interactive", images: [{ type: "image", data: "not-sent", mimeType: "image/png" }] });
  await h.beforeStart("");
  h.answer("Description of the image");
  await h.settle();
  await h.begin("A later prompt");
  assert.equal(h.calls.length, 0);
});
