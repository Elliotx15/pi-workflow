import assert from "node:assert/strict";
import test from "node:test";
import { FRAME_MS, piTitle, TitleAnimation } from "../title.ts";

test("titles omit the application prefix and preserve the current session name and repository", () => {
  assert.equal(piTitle("新名称", "/workspace/repo"), "新名称 - repo");
  assert.equal(piTitle(undefined, "/workspace/repo"), "repo");
  assert.equal(piTitle("", "/workspace/repo"), "repo");
  assert.equal(piTitle(" \n\t ", "/workspace/repo"), "repo");
  assert.equal(piTitle("\x1b[32m名称\x1b[0m\x07", "/workspace/repo"), "名称 - repo");
  assert.equal(piTitle("π - 计算", "/workspace/repo"), "π - 计算 - repo");
});

test("each frame and restore re-read the name; start, pause and dispose are idempotent", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let name = "初始名称";
  const titles: string[] = [];
  const animation = new TitleAnimation(() => piTitle(name, "/workspace/repo"), (title) => titles.push(title));
  t.after(() => animation.dispose());
  animation.start();
  assert.equal(titles.at(-1), "⠴ 初始名称 - repo");
  animation.start();
  assert.equal(titles.length, 1);
  name = "自动改名";
  t.mock.timers.tick(FRAME_MS);
  assert.equal(titles.at(-1), "⠦ 自动改名 - repo");
  name = "最终名称";
  animation.pause();
  assert.equal(titles.at(-1), "最终名称 - repo");
  const paused = titles.length;
  t.mock.timers.tick(FRAME_MS * 20);
  assert.equal(titles.length, paused);
  animation.start();
  assert.equal(titles.at(-1), "⠴ 最终名称 - repo");
  animation.dispose();
  assert.equal(titles.at(-1), "最终名称 - repo");
  const disposed = titles.length;
  animation.dispose();
  animation.start();
  animation.pause();
  animation.refresh();
  t.mock.timers.tick(FRAME_MS * 20);
  assert.equal(titles.length, disposed);
});

test("session replacement can dispose without restoring an obsolete title", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const titles: string[] = [];
  const animation = new TitleAnimation(() => "old", (title) => titles.push(title));
  animation.start();
  animation.dispose(false);
  t.mock.timers.tick(FRAME_MS * 10);
  assert.deepEqual(titles, ["⠴ old"]);
});

test("title getters and terminal failures are isolated from the agent", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const failure of ["get", "set"]) {
    const animation = new TitleAnimation(
      () => { if (failure === "get") throw new Error("stale context"); return "title"; },
      () => { throw new Error("terminal closed"); },
    );
    assert.doesNotThrow(() => {
      animation.start();
      t.mock.timers.tick(FRAME_MS * 3);
      animation.dispose();
    });
  }
});
