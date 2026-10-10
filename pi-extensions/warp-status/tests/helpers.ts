import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { createWarpStatusExtension } from "../index.ts";
import type { WarpEvent } from "../protocol.ts";

export const warpEnv = { TERM_PROGRAM: "WarpTerminal", WARP_CLI_AGENT_PROTOCOL_VERSION: "1" };

export function decode(sequence: string): WarpEvent {
  const prefix = "\x1b]777;notify;warp://cli-agent;";
  assert.ok(sequence.startsWith(prefix));
  assert.ok(sequence.endsWith("\x07"));
  return JSON.parse(sequence.slice(prefix.length, -1)) as WarpEvent;
}

export function harness(t: TestContext, options: {
  mode?: ExtensionContext["mode"];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  write?: (sequence: string) => void;
  setTitle?: (title: string) => void;
} = {}) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let id = "session-1";
  let name: string | undefined = "初始会话";
  let valid = true;
  let staleReads = 0;
  let mode = options.mode ?? "tui";
  const abortController = new AbortController();
  const cwd = "/workspace/my-project";
  const titles: string[] = [];
  const events: WarpEvent[] = [];
  const handlers = new Map<string, ((event: ExtensionEvent, ctx: ExtensionContext) => unknown)[]>();
  const assertActive = () => {
    if (!valid) staleReads++;
    assert.ok(valid, "A stale session context was used");
  };
  const ctx = {
    get mode() { return mode; }, cwd,
    get signal() { assertActive(); return abortController.signal; },
    sessionManager: {
      getSessionId: () => { assertActive(); return id; },
      getCwd: () => { assertActive(); return cwd; },
    },
    ui: { setTitle: options.setTitle ?? ((title: string) => { assertActive(); titles.push(title); }) },
  } as unknown as ExtensionContext;
  const pi = {
    on(type: string, handler: (event: ExtensionEvent, ctx: ExtensionContext) => unknown) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
      return () => { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); };
    },
    getSessionName: () => { assertActive(); return name; },
    setSessionName: () => assert.fail("warp-status must never rename a session"),
  } as unknown as ExtensionAPI;
  const factory = createWarpStatusExtension({
    platform: options.platform ?? "darwin", env: options.env ?? warpEnv,
    write: options.write ?? ((sequence) => events.push(decode(sequence))),
  });
  factory(pi);
  async function emit(type: ExtensionEvent["type"], values: Record<string, unknown> = {}): Promise<void> {
    for (const handler of handlers.get(type) ?? []) await handler({ type, ...values } as ExtensionEvent, ctx);
  }
  async function start(reason = "startup"): Promise<void> {
    valid = true;
    await emit("session_start", { reason });
  }
  async function shutdown(): Promise<void> {
    if (!valid) return;
    await emit("session_shutdown", { reason: "quit" });
    valid = false;
  }
  t.after(shutdown);
  return {
    cwd, titles, events, handlers, emit, start, shutdown,
    tick: (ms: number) => t.mock.timers.tick(ms),
    get title() { return titles.at(-1); },
    get staleReads() { return staleReads; },
    abort: () => abortController.abort(),
    setMode: (value: ExtensionContext["mode"]) => { mode = value; },
    setName: (value: string | undefined) => { name = value; },
    rename: async (value: string | undefined) => { name = value; await emit("session_info_changed", { name: value }); },
    switchSession: (value: string) => { id = value; name = undefined; },
    response: (stopReason = "stop") => emit("message_end", {
      message: { role: "assistant", stopReason, content: [{ type: "text", text: "PRIVATE_REPLY" }], errorMessage: "PRIVATE_ERROR" },
    }),
    settle: (aborted = false) => emit("agent_settled", { aborted }),
    compact: (reason = "manual") => emit("session_before_compact", { reason }),
    compacted: (reason = "manual") => emit("session_compact", { reason }),
    compactionFailed: (reason = "manual", aborted = false) => emit("session_compact_failed", { reason, aborted, errorMessage: "PRIVATE_COMPACTION_ERROR" }),
    openPrompt: () => emit("ui_prompt_start", { kind: "confirm", reason: "ui_prompt", title: "PRIVATE_APPROVAL" }),
    closePrompt: () => emit("ui_prompt_end", { kind: "confirm", reason: "ui_prompt", title: "PRIVATE_APPROVAL" }),
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
