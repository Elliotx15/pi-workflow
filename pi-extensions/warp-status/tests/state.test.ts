import assert from "node:assert/strict";
import test from "node:test";
import { ActivityState } from "../state.ts";

test("repeated low-level starts preserve one outer activity until settlement", () => {
  const state = new ActivityState();
  assert.equal(state.phase, "idle");
  state.startRun();
  state.recordResponse("failed");
  state.startRun();
  assert.equal(state.phase, "working");
  state.recordResponse("completed");
  assert.equal(state.settle(false), "completed");
  assert.equal(state.phase, "idle");
  assert.equal(state.settle(false), undefined);
});

test("only the latest assistant result or a later failed compaction determines the result", () => {
  const state = new ActivityState();
  state.startRun();
  state.recordResponse("failed");
  state.startCompaction(false);
  assert.equal(state.finishCompaction(false, "completed"), undefined);
  assert.equal(state.settle(false), "failed");
  state.startRun();
  state.recordResponse("completed");
  state.startCompaction(false);
  assert.equal(state.finishCompaction(false, "failed"), undefined);
  assert.equal(state.settle(false), "failed");
});

test("cancellation wins over errors, and the next run starts cleanly", () => {
  const state = new ActivityState();
  state.startRun();
  state.recordResponse("failed");
  state.openPrompt();
  assert.equal(state.settle(true), "cancelled");
  state.closePrompt();
  state.startRun();
  assert.equal(state.phase, "working");
  assert.equal(state.settle(false), "completed");
});

test("all outstanding prompts must close, and idle dialogs are not active work", () => {
  const state = new ActivityState();
  state.openPrompt();
  assert.equal(state.phase, "idle");
  state.closePrompt();
  state.startRun();
  state.openPrompt();
  state.openPrompt();
  assert.equal(state.phase, "blocked");
  state.closePrompt();
  assert.equal(state.phase, "blocked");
  state.closePrompt();
  state.closePrompt();
  assert.equal(state.phase, "working");
});

test("manual compaction is independent; automatic preflight waits for the run to settle", () => {
  const state = new ActivityState();
  state.startCompaction(true);
  assert.equal(state.phase, "working");
  assert.equal(state.finishCompaction(true, "completed"), "completed");
  assert.equal(state.phase, "idle");
  state.startCompaction(false);
  assert.equal(state.finishCompaction(false, "completed"), undefined);
  assert.equal(state.phase, "working");
  state.startRun();
  state.recordResponse("completed");
  assert.equal(state.settle(false), "completed");
});
