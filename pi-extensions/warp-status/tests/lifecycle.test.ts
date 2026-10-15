import assert from "node:assert/strict";
import test from "node:test";
import { HEARTBEAT_MS } from "../index.ts";
import { FRAME_MS } from "../title.ts";
import { harness } from "./helpers.ts";

const isFinal = (event: { event: string }) => event.event === "stop" || event.event === "stop_failure";

test("factory and idle startup do not start timers or announce work", async (t) => {
  const h = harness(t);
  h.tick(HEARTBEAT_MS * 2);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.titles, []);
  await h.start();
  assert.equal(h.title, "初始会话 - my-project");
  const count = h.titles.length;
  h.tick(HEARTBEAT_MS * 2);
  assert.equal(h.titles.length, count);
  await h.shutdown();
  h.tick(HEARTBEAT_MS * 2);
  assert.deepEqual(h.events, []);
  assert.equal(h.staleReads, 0);
});

test("one animation and heartbeat cover retries, compaction and queued continuations", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit("agent_start");
  assert.deepEqual(h.events.map((event) => event.event), ["session_start", "prompt_submit"]);
  assert.equal(h.title, "⠴ 初始会话 - my-project");
  await h.response("error");
  await h.emit("agent_end", { messages: [] });
  h.tick(HEARTBEAT_MS);
  assert.equal(h.events.filter((event) => event.event === "prompt_submit").length, 2);
  assert.equal(h.events.filter(isFinal).length, 0);
  await h.compact("overflow");
  await h.compacted("overflow");
  await h.emit("agent_start");
  await h.response();
  await h.emit("agent_end", { messages: [] });
  await h.emit("agent_start");
  await h.response();
  h.tick(HEARTBEAT_MS);
  assert.equal(h.events.filter((event) => event.event === "prompt_submit").length, 3);
  assert.equal(h.events.filter((event) => event.event === "session_start").length, 1);
  assert.equal(h.events.filter(isFinal).length, 0);
  await h.settle();
  await h.settle();
  assert.equal(h.events.filter(isFinal).length, 1);
  assert.equal(h.events.at(-1)?.response, "初始会话 — 已完成");
  assert.equal(h.title, "初始会话 - my-project");
  const counts = [h.events.length, h.titles.length];
  h.tick(HEARTBEAT_MS * 2);
  assert.deepEqual([h.events.length, h.titles.length], counts);
});

test("all UI prompt kinds pause both timers without depending on tool names", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit("agent_start");
  for (const kind of ["confirm", "select", "input", "editor", "custom"]) {
    await h.emit("ui_prompt_start", { kind, title: "PRIVATE_DIALOG" });
    assert.equal(h.events.at(-1)?.event, "question_asked");
    assert.equal(h.events.at(-1)?.summary, "初始会话 — 等待操作");
    assert.equal(h.title, "初始会话 - my-project");
    const counts = [h.events.length, h.titles.length];
    h.tick(HEARTBEAT_MS * 2);
    assert.deepEqual([h.events.length, h.titles.length], counts);
    await h.emit("ui_prompt_end", { kind });
    assert.equal(h.events.at(-1)?.event, "prompt_submit");
    assert.equal(h.title, "⠴ 初始会话 - my-project");
  }
  assert.equal(h.events.filter(isFinal).length, 0);
});

test("nested prompts resume only when the last one closes; idle menus do not notify", async (t) => {
  const h = harness(t);
  await h.start();
  await h.openPrompt();
  await h.closePrompt();
  assert.equal(h.events.length, 0);
  await h.emit("agent_start");
  await h.openPrompt();
  await h.openPrompt();
  assert.equal(h.events.filter((event) => event.event === "question_asked").length, 1);
  await h.closePrompt();
  const count = h.events.length;
  h.tick(HEARTBEAT_MS);
  assert.equal(h.events.length, count);
  await h.closePrompt();
  assert.equal(h.events.at(-1)?.event, "prompt_submit");
});

test("each frame, paused rename and final restore use the newest name", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit("agent_start");
  h.setName("第一次命名");
  h.tick(FRAME_MS);
  assert.equal(h.title, "⠦ 第一次命名 - my-project");
  await h.rename("运行中改名");
  assert.equal(h.title, "⠦ 运行中改名 - my-project");
  await h.openPrompt();
  await h.rename("等待期间改名");
  assert.equal(h.title, "等待期间改名 - my-project");
  await h.closePrompt();
  h.setName("最终命名");
  await h.settle();
  assert.equal(h.title, "最终命名 - my-project");
  assert.equal(h.events.at(-1)?.response, "最终命名 — 已完成");
  const count = h.events.length;
  await h.rename("后台完善名称");
  assert.equal(h.title, "后台完善名称 - my-project");
  h.tick(HEARTBEAT_MS);
  assert.equal(h.events.length, count);
  await h.rename(undefined);
  assert.equal(h.title, "my-project");
});

test("notifications never read prompts, replies, errors, dialog titles or tool inputs", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit("before_agent_start", { prompt: "PRIVATE_PROMPT", systemPrompt: "PRIVATE_SYSTEM" });
  await h.emit("agent_start");
  await h.emit("tool_call", { toolName: "read", input: { path: "PRIVATE_PATH" } });
  await h.emit("tool_execution_end", { toolName: "read", isError: true });
  await h.openPrompt();
  await h.closePrompt();
  await h.response("error");
  await h.compact("overflow");
  await h.compactionFailed("overflow");
  await h.settle();
  assert.equal(h.events.at(-1)?.event, "stop_failure");
  assert.equal(h.events.at(-1)?.response, "初始会话 — 执行失败");
  assert.equal(JSON.stringify(h.events).includes("PRIVATE_"), false);
  assert.ok(h.events.every((event) => !("query" in event) && !("tool_input" in event)));
  assert.ok(h.events.every((event) => event.summary === undefined || event.event === "question_asked"));
});

test("failed tools alone do not fail a run, and an error recovered by a retry is not reported", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit("agent_start");
  await h.response("error");
  await h.emit("agent_end", { messages: [] });
  await h.emit("agent_start");
  await h.emit("tool_execution_end", { toolName: "bash", isError: true });
  await h.response();
  await h.settle();
  assert.deepEqual(h.events.filter(isFinal).map((event) => event.event), ["stop"]);
});

test("Escape while blocked produces one cancelled stop without a transient resume", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit("agent_start");
  await h.openPrompt();
  await h.response("aborted");
  await h.settle(true);
  await h.closePrompt();
  assert.equal(h.events.at(-1)?.event, "stop");
  assert.equal(h.events.at(-1)?.response, "初始会话 — 已取消");
  assert.equal(h.events.filter((event) => event.event === "prompt_submit").length, 1);
  const counts = [h.events.length, h.titles.length];
  h.tick(HEARTBEAT_MS * 2);
  assert.deepEqual([h.events.length, h.titles.length], counts);
  await h.emit("agent_start");
  assert.match(h.title!, /^⠴ /);
});

test("a prompt closing during abort cannot restart animation before final settlement", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit("agent_start");
  await h.openPrompt();
  h.abort();
  await h.closePrompt();
  const counts = [h.events.length, h.titles.length];
  h.tick(HEARTBEAT_MS * 2);
  assert.deepEqual([h.events.length, h.titles.length], counts);
  assert.equal(h.events.at(-1)?.event, "question_asked");
  await h.settle(true);
  assert.equal(h.events.at(-1)?.response, "初始会话 — 已取消");
});

test("compaction uses its own abort signal when its UI prompt closes", async (t) => {
  const h = harness(t);
  const controller = new AbortController();
  await h.start();
  await h.emit("session_before_compact", { reason: "manual", signal: controller.signal });
  await h.openPrompt();
  controller.abort();
  await h.closePrompt();
  const counts = [h.events.length, h.titles.length];
  h.tick(HEARTBEAT_MS * 2);
  assert.deepEqual([h.events.length, h.titles.length], counts);
  await h.compactionFailed("manual", true);
  assert.equal(h.events.at(-1)?.response, "初始会话 — 已取消");
  await h.emit("agent_start");
  await h.openPrompt();
  await h.closePrompt();
  assert.equal(h.events.at(-1)?.event, "prompt_submit");
});

test("manual compaction reports success, failure and cancellation independently", async (t) => {
  const h = harness(t);
  await h.start();
  await h.compact();
  assert.match(h.title!, /^⠴ /);
  await h.compacted();
  assert.equal(h.events.at(-1)?.response, "初始会话 — 已完成");
  await h.compact();
  await h.compactionFailed();
  assert.equal(h.events.at(-1)?.event, "stop_failure");
  await h.compact();
  await h.compactionFailed("manual", true);
  assert.equal(h.events.at(-1)?.response, "初始会话 — 已取消");
  assert.equal(h.title, "初始会话 - my-project");
});

test("automatic compaction before agent_start never sends an early completion", async (t) => {
  const h = harness(t);
  await h.start();
  await h.compact("threshold");
  await h.compacted("threshold");
  h.tick(FRAME_MS * 3);
  assert.match(h.title!, /^[⠴⠦⠖⠲] /);
  assert.equal(h.events.filter(isFinal).length, 0);
  await h.emit("agent_start");
  await h.response();
  await h.settle();
  assert.equal(h.events.filter(isFinal).length, 1);
});

for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
  test(`${reason} shutdown clears timers and never reuses the disposed context`, async (t) => {
    const h = harness(t);
    await h.start();
    await h.emit("agent_start");
    await h.emit("session_shutdown", { reason });
    await h.shutdown();
    const counts = [h.events.length, h.titles.length];
    h.tick(HEARTBEAT_MS * 2);
    assert.deepEqual([h.events.length, h.titles.length], counts);
    assert.equal(h.staleReads, 0);
    assert.equal(h.events.at(-1)?.response, "初始会话 — 已取消");
    assert.equal(h.title, "初始会话 - my-project");
  });
}

test("shutdown still cleans up if the host rebinds away from TUI mode", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit("agent_start");
  h.setMode("rpc");
  const counts = [h.events.length, h.titles.length];
  await h.shutdown();
  h.tick(HEARTBEAT_MS * 2);
  assert.deepEqual([h.events.length, h.titles.length], counts);
  assert.equal(h.staleReads, 0);
});

test("replacing a session does not let an old heartbeat announce the new session", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit("agent_start");
  h.switchSession("session-2");
  await h.start("new");
  const count = h.events.length;
  h.tick(HEARTBEAT_MS * 2);
  assert.equal(h.events.length, count);
  await h.emit("agent_start");
  assert.equal(h.events.at(-1)?.session_id, "session-2");
  assert.equal(h.title, "⠴ my-project");
});

for (const mode of ["rpc", "json", "print"] as const) {
  test(`${mode} mode never writes titles or notifications`, async (t) => {
    const h = harness(t, { mode });
    await h.start();
    await h.emit("agent_start");
    await h.openPrompt();
    await h.closePrompt();
    await h.compact();
    await h.compacted();
    await h.response();
    await h.settle();
    h.tick(HEARTBEAT_MS * 2);
    assert.deepEqual(h.titles, []);
    assert.deepEqual(h.events, []);
  });
}

test("unsupported terminals and transports do not activate any rendering", async (t) => {
  const h = harness(t, { env: { TERM_PROGRAM: "WarpTerminal" } });
  await h.start();
  await h.emit("agent_start");
  await h.compact();
  h.tick(HEARTBEAT_MS);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.titles, []);
});

test("transport and title failures never break lifecycle handlers or timer callbacks", async (t) => {
  const h = harness(t, {
    write: () => { throw new Error("tty closed"); },
    setTitle: () => { throw new Error("UI disposed"); },
  });
  await h.start();
  await h.emit("agent_start");
  h.tick(HEARTBEAT_MS * 2);
  await h.openPrompt();
  await h.closePrompt();
  await h.settle();
  await h.shutdown();
});
