import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { HEARTBEAT_MS } from "../index.ts";
import {
  monitorSubagents, SUBAGENT_IDLE_GRACE_MS, SUBAGENT_MAX_FAILURES,
  SUBAGENT_POLL_MS, SUBAGENT_RPC_TIMEOUT_MS,
} from "../subagents.ts";
import { FRAME_MS } from "../title.ts";
import { harness } from "./helpers.ts";
import { advance, flush, subagentPeer } from "./subagent-helpers.ts";

const isFinal = (event: { event: string }) => event.event === "stop" || event.event === "stop_failure";

function monitorHarness(t: TestContext, withPeer = true) {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const bus = createEventBus();
  const originalOn = bus.on;
  let listeners = 0;
  t.mock.method(bus, "on", (name: string, handler: (data: unknown) => void) => {
    listeners++;
    const off = originalOn(name, handler);
    let active = true;
    return () => {
      if (active) listeners--;
      active = false;
      off();
    };
  });
  const peer = withPeer ? subagentPeer(bus) : undefined;
  const changes: (boolean | undefined)[] = [];
  const monitor = monitorSubagents(bus, "session-1", (active) => changes.push(active));
  t.after(() => { monitor.dispose(); peer?.dispose(); bus.clear(); });
  return {
    bus, peer, changes, monitor,
    get listeners() { return listeners; },
    tick: (ms: number) => t.mock.timers.tick(ms),
  };
}

test("without pi-subagents the probe expires, no polling starts, and normal animation is unchanged", async (t) => {
  const h = harness(t);
  const requests: unknown[] = [];
  h.bus.on("subagents:rpc:v1:request", (request) => requests.push(request));
  assert.equal(requests.length, 0);
  await h.start();
  assert.equal(requests.length, 1);
  await h.emit("agent_start");
  await h.settle(); // Must not wait for the unanswered probe timeout.
  assert.equal(h.events.at(-1)?.response, "初始会话 — 已完成");
  await advance(h, HEARTBEAT_MS * 2);
  assert.equal(requests.length, 1);
  await h.emit("agent_start");
  assert.match(h.title!, /^⠴ /);
  await h.settle();
  assert.equal(h.events.filter(isFinal).length, 2);
});

for (const loadOrder of ["before", "after"] as const) {
  test(`pi-subagents loaded ${loadOrder} warp-status restores current-session work`, async (t) => {
    const h = harness(t);
    if (loadOrder === "after") {
      await h.start("reload");
      await advance(h, SUBAGENT_RPC_TIMEOUT_MS);
    }
    const peer = subagentPeer(h.bus);
    peer.active = 1;
    t.after(peer.dispose);
    if (loadOrder === "before") {
      peer.ready(); // The ready event predates warp-status's session subscriptions.
      await h.start("resume");
    } else peer.ready();
    await flush();
    assert.match(h.title!, /^⠴ /);
    assert.deepEqual(h.events.map((event) => event.event), ["session_start", "prompt_submit"]);
    const title = h.title;
    await advance(h, FRAME_MS);
    assert.notEqual(h.title, title);
  });
}

test("background work keeps animation and heartbeats after parent settlement until the last child finishes", async (t) => {
  const h = harness(t);
  const peer = subagentPeer(h.bus);
  t.after(peer.dispose);
  await h.start();
  await flush();
  await h.emit("agent_start");
  peer.active = 2;
  // Even a missed launch event is discovered before settling the parent.
  await h.response();
  await h.settle();
  assert.equal(h.events.filter(isFinal).length, 0);
  await advance(h, HEARTBEAT_MS);
  assert.equal(h.events.filter((event) => event.event === "prompt_submit").length, 2);
  peer.active = 1;
  peer.hint("subagent:async-complete");
  peer.hint("subagent:async-complete");
  await flush();
  await advance(h, SUBAGENT_IDLE_GRACE_MS);
  assert.equal(h.events.filter(isFinal).length, 0);
  await h.rename("后台运行中改名");
  assert.match(h.title!, /^[⠴⠦⠖⠲] 后台运行中改名/);
  peer.active = 0;
  peer.hint("subagent:async-complete");
  await flush();
  await advance(h, SUBAGENT_IDLE_GRACE_MS);
  assert.equal(h.title, "后台运行中改名 - my-project");
  assert.equal(h.events.at(-1)?.response, "后台运行中改名 — 已完成");
  assert.equal(h.events.filter(isFinal).length, 1);
  const counts = [h.events.length, h.titles.length];
  await advance(h, HEARTBEAT_MS * 2);
  assert.deepEqual([h.events.length, h.titles.length], counts);
  assert.equal(JSON.stringify(h.events).includes("PRIVATE_"), false);
});

test("completion handoff to a woken parent never stops and restarts the animation", async (t) => {
  const h = harness(t);
  const peer = subagentPeer(h.bus);
  t.after(peer.dispose);
  peer.active = 1;
  await h.start();
  await flush();
  peer.active = 0;
  peer.hint("subagent:async-complete");
  await flush();
  await advance(h, 1_000);
  assert.equal(h.events.filter(isFinal).length, 0);
  await h.emit("agent_start");
  await advance(h, SUBAGENT_IDLE_GRACE_MS);
  assert.equal(h.events.filter(isFinal).length, 0);
  assert.equal(h.events.filter((event) => event.event === "prompt_submit").length, 1);
  await h.response();
  await h.settle();
  assert.equal(h.events.filter(isFinal).length, 1);
  assert.equal(h.title, "初始会话 - my-project");
});

test("UI prompts block background-only work; cancelling the parent does not cancel its children", async (t) => {
  const h = harness(t);
  const peer = subagentPeer(h.bus);
  t.after(peer.dispose);
  peer.active = 1;
  await h.start();
  await flush();
  await h.emit("agent_start");
  await h.openPrompt();
  h.abort();
  await h.closePrompt();
  assert.equal(h.events.at(-1)?.event, "question_asked");
  await h.settle(true);
  assert.equal(h.events.at(-1)?.event, "prompt_submit");
  assert.equal(h.events.filter(isFinal).length, 0);
  // The old, aborted parent signal must not strand a new background-only dialog.
  await h.openPrompt();
  await h.openPrompt();
  await h.closePrompt();
  assert.equal(h.events.at(-1)?.event, "question_asked");
  const counts = [h.events.length, h.titles.length];
  await advance(h, HEARTBEAT_MS);
  assert.deepEqual([h.events.length, h.titles.length], counts);
  await h.closePrompt();
  assert.equal(h.events.at(-1)?.event, "prompt_submit");
  peer.active = 0;
  peer.hint("subagent:async-complete");
  await flush();
  await advance(h, SUBAGENT_IDLE_GRACE_MS);
  assert.equal(h.events.at(-1)?.response, "初始会话 — 已取消");
});

test("an idle snapshot is reconfirmed after the grace period, not treated as permanent", async (t) => {
  const h = monitorHarness(t);
  const peer = h.peer!;
  peer.active = 1;
  await flush(); // The initial ping discovers the peer before taking the status snapshot.
  assert.deepEqual(h.changes, [true]);
  peer.active = 0;
  await h.monitor.refresh();
  peer.active = 1; // A new launch with no event must invalidate the pending idle.
  await advance(h, SUBAGENT_IDLE_GRACE_MS);
  assert.deepEqual(h.changes, [true]);
  peer.active = 0;
  await advance(h, SUBAGENT_POLL_MS + SUBAGENT_IDLE_GRACE_MS);
  assert.deepEqual(h.changes, [true, false]);
});

test("an event during an in-flight query invalidates its older snapshot and coalesces another query", async (t) => {
  const h = monitorHarness(t);
  await flush();
  const peer = h.peer!;
  peer.statusMode = "hold";
  const refresh = h.monitor.refresh();
  const first = peer.pending.shift()!;
  peer.active = 1;
  peer.hint();
  peer.hint();
  peer.hint();
  await flush();
  assert.equal(peer.pending.length, 0);
  peer.reply(first, { fleet: { version: 1, totalActive: 0 } });
  await flush();
  assert.deepEqual(h.changes, [false]);
  assert.equal(peer.pending.length, 1);
  peer.reply(peer.pending.shift()!, peer.snapshot());
  await refresh;
  assert.deepEqual(h.changes, [false, true]);
});

test("hint refreshes run after all owner event handlers even when registered in reverse order", async (t) => {
  const h = monitorHarness(t);
  await flush();
  h.bus.on("subagent:async-started", () => { h.peer!.active = 1; });
  h.peer!.hint();
  await flush();
  assert.deepEqual(h.changes, [false, true]);
});

for (const failure of ["error", "silent", "malformed"] as const) {
  test(`${failure} status preserves work briefly, then falls back without claiming success`, async (t) => {
    const h = harness(t);
    const peer = subagentPeer(h.bus);
    t.after(peer.dispose);
    peer.active = 1;
    await h.start();
    await flush();
    if (failure === "malformed") peer.snapshot = () => ({ fleet: { version: 1, totalActive: -1 } });
    else peer.statusMode = failure;
    await advance(h, SUBAGENT_POLL_MS + SUBAGENT_RPC_TIMEOUT_MS);
    assert.match(h.title!, /^[⠴⠦⠖⠲] /);
    await advance(h, (SUBAGENT_POLL_MS + SUBAGENT_RPC_TIMEOUT_MS) * SUBAGENT_MAX_FAILURES);
    assert.equal(h.title, "初始会话 - my-project");
    assert.equal(h.events.filter(isFinal).length, 0);
    const count = peer.requests.length;
    await advance(h, SUBAGENT_POLL_MS * 4);
    assert.equal(peer.requests.length, count);
    await h.emit("agent_start");
    await h.settle();
    assert.equal(h.events.at(-1)?.response, "初始会话 — 已完成");
    peer.statusMode = "reply";
    peer.snapshot = () => ({ fleet: { version: 1, totalActive: 1 } });
    peer.ready();
    await flush();
    assert.match(h.title!, /^⠴ /);
  });
}

test("a failed idle confirmation never announces completion and recovers on a later snapshot", async (t) => {
  const h = monitorHarness(t);
  const peer = h.peer!;
  peer.active = 1;
  await flush();
  peer.active = 0;
  await h.monitor.refresh();
  peer.statusMode = "error";
  await advance(h, SUBAGENT_IDLE_GRACE_MS);
  assert.deepEqual(h.changes, [true]);
  peer.statusMode = "reply";
  await advance(h, SUBAGENT_POLL_MS + SUBAGENT_IDLE_GRACE_MS);
  assert.deepEqual(h.changes, [true, false]);
});

test("unsupported capability and foreign-session discovery never enable status polling", async (t) => {
  const h = monitorHarness(t, false);
  await advance(h, SUBAGENT_RPC_TIMEOUT_MS);
  const peer = subagentPeer(h.bus);
  t.after(peer.dispose);
  peer.active = 1;
  peer.capabilities.fleetStatus.version = 2;
  peer.ready();
  await advance(h, SUBAGENT_POLL_MS * 2);
  assert.deepEqual(h.changes, []);
  assert.equal(peer.requests.length, 0);
  peer.capabilities.fleetStatus.version = 1;
  peer.sessionId = "other-session";
  peer.ready();
  await advance(h, SUBAGENT_POLL_MS * 2);
  assert.deepEqual(h.changes, []);
  assert.equal(peer.requests.length, 0);
  peer.sessionId = "session-1";
  peer.ready();
  await flush();
  assert.deepEqual(h.changes, [true]);
  peer.sessionId = "other-session";
  peer.ready();
  await advance(h, SUBAGENT_POLL_MS * 2);
  assert.deepEqual(h.changes, [true, undefined]);
});

test("wrong reply identity, version, and method cannot change activity", async (t) => {
  const h = monitorHarness(t);
  await flush();
  const peer = h.peer!;
  peer.statusMode = "hold";
  const refresh = h.monitor.refresh();
  const request = peer.pending.shift()!;
  for (const fields of [{ requestId: "other" }, { version: 2 }, { method: "spawn" }]) {
    h.bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1, requestId: request.requestId, method: "status", success: true,
      data: { fleet: { version: 1, totalActive: 1 } }, ...fields,
    });
  }
  await flush();
  assert.deepEqual(h.changes, [false]);
  peer.reply(request, { fleet: { version: 1, totalActive: 1 } });
  await refresh;
  assert.deepEqual(h.changes, [false, true]);
});

test("disposing cancels pending queries, removes subscriptions, and ignores queued hints and replies", async (t) => {
  const h = monitorHarness(t);
  await flush();
  const peer = h.peer!;
  peer.statusMode = "hold";
  const refresh = h.monitor.refresh();
  const request = peer.pending.shift()!;
  peer.hint(); // A microtask is still queued when dispose runs.
  h.monitor.dispose();
  h.monitor.dispose();
  await refresh;
  assert.equal(h.listeners, 1); // Only the peer's request handler remains.
  const count = peer.requests.length;
  peer.reply(request, { fleet: { version: 1, totalActive: 10 } });
  peer.ready();
  peer.hint();
  await advance(h, SUBAGENT_POLL_MS * 5);
  assert.equal(peer.requests.length, count);
  assert.deepEqual(h.changes, [false]);
});

test("disposal also clears an unanswered initial probe and a pending idle confirmation", async (t) => {
  const h = monitorHarness(t, false);
  h.monitor.dispose();
  assert.equal(h.listeners, 0);
  await advance(h, SUBAGENT_RPC_TIMEOUT_MS * 2);
  assert.deepEqual(h.changes, []);

  const peer = subagentPeer(h.bus);
  t.after(peer.dispose);
  peer.active = 1;
  const monitor = monitorSubagents(h.bus, "session-1", (active) => h.changes.push(active));
  t.after(() => monitor.dispose());
  await flush();
  peer.active = 0;
  await monitor.refresh();
  monitor.dispose();
  assert.equal(h.listeners, 1);
  const count = peer.requests.length;
  await advance(h, SUBAGENT_POLL_MS * 2);
  assert.equal(peer.requests.length, count);
  assert.deepEqual(h.changes, [true]);
});

test("shutdown with only background work sends cancellation once and stops all monitoring", async (t) => {
  const h = harness(t);
  const peer = subagentPeer(h.bus);
  t.after(peer.dispose);
  peer.active = 1;
  await h.start();
  await flush();
  await h.shutdown();
  await h.shutdown();
  assert.equal(h.events.at(-1)?.response, "初始会话 — 已取消");
  const counts = [h.events.length, h.titles.length, peer.requests.length];
  peer.ready();
  peer.hint();
  await advance(h, HEARTBEAT_MS * 2);
  assert.deepEqual([h.events.length, h.titles.length, peer.requests.length], counts);
  assert.equal(h.staleReads, 0);
});

test("late replies and settlement from an old session cannot affect its replacement", async (t) => {
  const h = harness(t);
  const peer = subagentPeer(h.bus);
  t.after(peer.dispose);
  peer.active = 1;
  await h.start();
  await flush();
  await h.emit("agent_start");
  peer.statusMode = "hold";
  const settling = h.settle();
  const request = peer.pending.shift()!;
  await h.shutdown();
  await settling;
  h.switchSession("session-2");
  peer.sessionId = "session-2";
  peer.active = 0;
  peer.statusMode = "reply";
  await h.start("new");
  await flush();
  const count = h.events.length;
  peer.reply(request, { fleet: { version: 1, totalActive: 4 } });
  await advance(h, SUBAGENT_POLL_MS * 2);
  assert.equal(h.events.length, count);
  assert.equal(h.title, "my-project");
  assert.equal(h.staleReads, 0);
});

test("a parent starting during an asynchronous settlement check cannot be retired by the old settlement", async (t) => {
  const h = harness(t);
  const peer = subagentPeer(h.bus);
  t.after(peer.dispose);
  await h.start();
  await flush();
  await h.emit("agent_start");
  peer.statusMode = "hold";
  const settling = h.settle();
  const request = peer.pending.shift()!;
  await h.emit("agent_start");
  peer.reply(request, peer.snapshot());
  await settling;
  assert.equal(h.events.filter(isFinal).length, 0);
  assert.match(h.title!, /^[⠴⠦⠖⠲] /);
  peer.statusMode = "reply";
  await h.settle();
  assert.equal(h.events.filter(isFinal).length, 1);
});

for (const mode of ["rpc", "json", "print"] as const) {
  test(`${mode} mode does not probe pi-subagents or start background rendering`, async (t) => {
    const h = harness(t, { mode });
    const peer = subagentPeer(h.bus);
    t.after(peer.dispose);
    peer.active = 1;
    await h.start();
    peer.ready();
    peer.hint();
    await advance(h, HEARTBEAT_MS);
    assert.deepEqual(peer.requests, []);
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.titles, []);
  });
}
