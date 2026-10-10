import assert from "node:assert/strict";
import { constants } from "node:fs";
import test from "node:test";
import { encodeEvent, makeEvent, supportsWarp, writeTerminal } from "../protocol.ts";
import type { TerminalIO, WarpSignal } from "../protocol.ts";
import { decode, warpEnv } from "./helpers.ts";

const identity = { id: "session-1", cwd: "/workspace/project", name: "会话名称" };

test("only local macOS Warp TUI with an advertised compatible protocol is enabled", () => {
  assert.equal(supportsWarp("tui", "darwin", warpEnv), true);
  assert.equal(supportsWarp("tui", "darwin", { ...warpEnv, WARP_CLI_AGENT_PROTOCOL_VERSION: "2" }), true);
  for (const mode of ["rpc", "json", "print"] as const) assert.equal(supportsWarp(mode, "darwin", warpEnv), false);
  for (const platform of ["linux", "win32"] as const) assert.equal(supportsWarp("tui", platform, warpEnv), false);
  assert.equal(supportsWarp("tui", "darwin", { ...warpEnv, TERM_PROGRAM: "iTerm.app" }), false);
  for (const version of [undefined, "", "0", "-1", "x", "1bad", "1.5"]) {
    assert.equal(supportsWarp("tui", "darwin", { ...warpEnv, WARP_CLI_AGENT_PROTOCOL_VERSION: version }), false);
  }
  for (const key of ["TMUX", "STY", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) {
    assert.equal(supportsWarp("tui", "darwin", { ...warpEnv, [key]: "present" }), false);
  }
});

test("signals encode Warp v1 events without a query or sticky permission summary", () => {
  const expected = {
    session_start: "session_start", working: "prompt_submit", blocked: "question_asked",
    completed: "stop", failed: "stop_failure", cancelled: "stop",
  } as const;
  for (const [signal, eventName] of Object.entries(expected)) {
    const event = makeEvent(identity, signal as WarpSignal);
    assert.equal(event.event, eventName);
    assert.equal(event.v, 1);
    assert.equal(event.agent, "pi");
    assert.equal(event.session_id, identity.id);
    assert.equal(event.cwd, identity.cwd);
    assert.equal(event.project, "project");
    assert.equal("query" in event, false);
    assert.equal("tool_input" in event, false);
    assert.equal("transcript_path" in event, false);
    assert.equal("summary" in event, signal === "blocked");
    assert.deepEqual(decode(encodeEvent(event)), event);
  }
  assert.equal(makeEvent(identity, "blocked").summary, "会话名称 — 等待操作");
  assert.equal(makeEvent(identity, "completed").response, "会话名称 — 已完成");
  assert.equal(makeEvent(identity, "failed").response, "会话名称 — 执行失败");
  assert.equal(makeEvent(identity, "cancelled").response, "会话名称 — 已取消");
  assert.equal(makeEvent({ ...identity, name: undefined }, "completed").response, "project — 已完成");
});

test("notification names are plain, bounded text and JSON cannot terminate an OSC early", () => {
  const event = makeEvent({
    id: "id\x07\x1b", cwd: "/workspace/dir\x07", name: "\x1b[31m名称\x1b[0m\n\x07尾部",
  }, "completed");
  assert.equal(event.response, "名称  尾部 — 已完成");
  const wire = encodeEvent(event);
  assert.equal([...wire].filter((char) => char === "\x1b").length, 1);
  assert.equal([...wire].filter((char) => char === "\x07").length, 1);
  assert.deepEqual(decode(wire), event);
  const long = makeEvent({ ...identity, name: "😀".repeat(1000) }, "blocked");
  assert.equal(long.summary, `${"😀".repeat(200)} — 等待操作`);
});

test("terminal transport handles partial UTF-8 writes and always closes its descriptor", () => {
  const operations: string[] = [];
  const buffers: Buffer[] = [];
  const io: TerminalIO = {
    openSync(path, flags) {
      assert.equal(path, "/dev/tty");
      assert.equal(flags & constants.O_CREAT, 0);
      operations.push("open");
      return 7;
    },
    writeSync(fd, data, offset, length) {
      assert.equal(fd, 7);
      const count = Math.min(3, length);
      buffers.push(Buffer.from(data.slice(offset, offset + count)));
      operations.push("write");
      return count;
    },
    closeSync(fd) { assert.equal(fd, 7); operations.push("close"); },
  };
  const wire = encodeEvent(makeEvent(identity, "completed"));
  writeTerminal(wire, io);
  assert.equal(Buffer.concat(buffers).toString("utf8"), wire);
  assert.equal(operations[0], "open");
  assert.equal(operations.at(-1), "close");
  assert.equal(operations.filter((op) => op === "close").length, 1);
});

test("open, write, zero-write and close failures never propagate", () => {
  for (const failure of ["open", "write", "zero", "close"]) {
    let closed = false;
    let writes = 0;
    const io: TerminalIO = {
      openSync() { if (failure === "open") throw new Error("no tty"); return 3; },
      writeSync(_fd, _data, _offset, length) {
        writes++;
        if (failure === "write") throw new Error("disconnected");
        return failure === "zero" ? 0 : length;
      },
      closeSync() { closed = true; if (failure === "close") throw new Error("closed"); },
    };
    assert.doesNotThrow(() => writeTerminal("test", io));
    assert.equal(closed, failure !== "open");
    assert.ok(writes <= 1);
  }
});
