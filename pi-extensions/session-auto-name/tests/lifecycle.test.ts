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

for (const reason of ["startup", "new"] as const) {
  test(`${reason} with an initial name skips config, requests, and naming metadata`, async (t) => {
    const h = harness(t, { persistent: true });
    h.manager.appendSessionInfo("Initial name");
    writeFileSync(join(h.agentDir, "session-auto-name.json"), "broken");
    await h.start(reason);
    await h.begin("Fix login");
    h.answer("Fixed");
    await h.settle();
    assert.equal(h.manager.getSessionName(), "Initial name");
    assert.deepEqual(h.names, []);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.warnings, []);
    assert.deepEqual(namingMetadata(h), []);
    await h.rename("");
    await h.begin("A later prompt cannot re-enable naming");
    assert.deepEqual(h.calls, []);
  });
}

for (const boundary of ["input", "before_agent_start"] as const) {
  test(`a name set before ${boundary} prevents the first request, even without a notification`, async (t) => {
    const h = harness(t);
    await h.start();
    if (boundary === "before_agent_start") await h.input("Fix login");
    h.manager.appendSessionInfo("External name");
    if (boundary === "input") await h.input("Fix login");
    await h.beforeStart("Fix login");
    h.answer("Fixed");
    await h.settle();
    assert.equal(h.manager.getSessionName(), "External name");
    assert.deepEqual(h.calls, []);
    assert.deepEqual(namingMetadata(h), []);
  });
}

for (const stage of ["initial", "refinement"] as const) {
  for (const outcome of ["rename", "keep", "error"] as const) {
    test(`external naming cancels pending ${stage}, ignoring a late ${outcome} result`, async (t) => {
      const h = harness(t);
      await h.start();
      await h.begin("Fix login");
      if (stage === "refinement") await h.respond(0, initial);
      h.answer("Fixed callback validation");
      await h.settle();
      await flush();
      const index = stage === "initial" ? 0 : 1;
      const metadata = namingMetadata(h);
      await h.rename("External name");
      assert.equal(h.calls[index]!.options.signal?.aborted, true);
      if (outcome === "error") {
        h.calls[index]!.result.reject(new Error("Late provider failure"));
        await flush();
      } else {
        await h.respond(index, outcome === "keep" ? { action: "keep" } : stage === "initial" ? initial : refined);
      }
      assert.equal(h.manager.getSessionName(), "External name");
      assert.deepEqual(h.names, stage === "initial" ? [] : [initial.title]);
      assert.deepEqual(namingMetadata(h), metadata, "cancellation must not record completion or failure");
      assert.deepEqual(h.warnings, []);
      await h.rename("");
      await h.begin("A later prompt cannot re-enable naming");
      h.answer("Another answer");
      await h.settle();
      await flush();
      assert.equal(h.calls.length, index + 1);
      assert.equal(h.manager.getSessionName(), undefined);
    });
  }

  test(`a silent external write is protected when the ${stage} result arrives`, async (t) => {
    const h = harness(t);
    await h.start();
    await h.begin("Fix login");
    if (stage === "refinement") await h.respond(0, initial);
    h.answer("Fixed");
    await h.settle();
    await flush();
    const index = stage === "initial" ? 0 : 1;
    // Same text as our own/returned title must still count as an external write.
    h.manager.appendSessionInfo(initial.title);
    await h.respond(index, stage === "initial" ? initial : refined);
    assert.equal(h.manager.getSessionName(), initial.title);
    assert.deepEqual(h.names, stage === "initial" ? [] : [initial.title]);
    assert.equal(h.calls[index]!.options.signal?.aborted, true);
    assert.equal(h.calls.length, index + 1);
    assert.deepEqual(h.warnings, []);
  });
}

for (const firstResult of ["success", "failure"] as const) {
  test(`external naming after initial ${firstResult} prevents refinement`, async (t) => {
    const h = harness(t);
    await h.start();
    await h.begin("Fix login");
    if (firstResult === "success") await h.respond(0, initial);
    else {
      h.calls[0]!.result.reject(new Error("Initial failure"));
      await flush();
    }
    h.manager.appendSessionInfo("External name");
    h.answer("Fixed");
    await h.settle();
    await flush();
    assert.equal(h.calls.length, 1);
    assert.equal(h.manager.getSessionName(), "External name");
  });
}

test("setting the same title through an external API cancels refinement", async (t) => {
  const h = harness(t);
  await h.start();
  await h.begin("Fix login");
  await h.respond(0, initial);
  h.answer("Fixed");
  await h.settle();
  await flush();
  await h.rename(initial.title);
  assert.equal(h.calls[1]!.options.signal?.aborted, true);
  await h.respond(1, refined);
  assert.equal(h.manager.getSessionName(), initial.title);
  assert.deepEqual(h.names, [initial.title]);
});

test("synchronous external renaming during our own notification is not claimed as our write", async (t) => {
  const h = harness(t);
  const setName = h.pi.setSessionName;
  t.mock.method(h.pi, "setSessionName", (name: string) => {
    setName(name);
    h.manager.appendSessionInfo("External name");
  });
  await h.start();
  await h.begin("Fix login");
  h.answer("Fixed");
  await h.settle();
  await h.respond(0, initial);
  assert.equal(h.manager.getSessionName(), "External name");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.options.signal?.aborted, true);
  assert.deepEqual(namingMetadata(h), [{ version: 1, phase: "initial_started", ...sessionRequest }]);
});

test("delayed notifications for our own writes do not stop refinement", async (t) => {
  const h = harness(t);
  t.mock.method(h.pi, "setSessionName", (name: string) => {
    h.names.push(name);
    h.manager.appendSessionInfo(name);
  });
  await h.start();
  await h.begin("Fix login");
  await h.respond(0, initial);
  h.answer("Fixed");
  await h.settle();
  await flush();
  await h.respond(1, refined);
  // The first event may reach us only after the second write; use entries, not event text.
  await h.emit({ type: "session_info_changed", name: initial.title });
  await h.emit({ type: "session_info_changed", name: refined.title });
  assert.deepEqual(h.names, [initial.title, refined.title]);
  assert.equal(h.calls[1]!.options.signal?.aborted, false);
  assert.equal(h.manager.getSessionName(), refined.title);
});

test("identical automatically generated titles do not create duplicate name writes", async (t) => {
  const h = harness(t);
  await h.start();
  await h.begin("Fix login");
  await h.respond(0, initial);
  h.answer("Fixed");
  await h.settle();
  await flush();
  await h.respond(1, { action: "rename", title: initial.title });
  assert.deepEqual(h.names, [initial.title]);
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
