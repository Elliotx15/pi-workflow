import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILE, loadConfig, resolveModel } from "../config.ts";
import { namingModel, sessionModel, tempDirectory } from "./helpers.ts";

function files(t: Parameters<typeof tempDirectory>[0]) {
  const root = tempDirectory(t);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  return {
    agentDir, cwd,
    global: (value: unknown) => writeFileSync(join(agentDir, CONFIG_FILE), JSON.stringify(value)),
    project: (value: unknown) => writeFileSync(join(cwd, ".pi", CONFIG_FILE), JSON.stringify(value)),
  };
}

const configured = { provider: "test-provider", modelId: "naming-model" };

test("missing and empty configurations fall through", (t) => {
  const f = files(t);
  assert.equal(loadConfig(f.agentDir, f.cwd, true), undefined);
  f.global({});
  f.project({});
  assert.equal(loadConfig(f.agentDir, f.cwd, true), undefined);
  f.global(configured);
  assert.deepEqual(loadConfig(f.agentDir, f.cwd, true), configured);
});

test("a complete project model overrides global without reading a broken lower-priority file", (t) => {
  const f = files(t);
  writeFileSync(join(f.agentDir, CONFIG_FILE), "not json");
  f.project({ provider: " test-provider ", modelId: " naming-model " });
  assert.deepEqual(loadConfig(f.agentDir, f.cwd, true), configured);
});

test("untrusted project config is never used, even when malformed", (t) => {
  const f = files(t);
  f.global(configured);
  writeFileSync(join(f.cwd, ".pi", CONFIG_FILE), "broken");
  assert.deepEqual(loadConfig(f.agentDir, f.cwd, false), configured);
});

test("optional thinking levels are preserved without merging lower-priority settings", (t) => {
  const f = files(t);
  for (const thinkingLevel of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    f.global({ ...configured, thinkingLevel });
    assert.deepEqual(loadConfig(f.agentDir, f.cwd, true), { ...configured, thinkingLevel });
  }
  f.global({ ...configured, thinkingLevel: "low" });
  const project = { provider: "project-provider", modelId: "project-model" };
  f.project(project);
  assert.deepEqual(loadConfig(f.agentDir, f.cwd, true), project);
  f.project({ ...project, thinkingLevel: "high" });
  assert.deepEqual(loadConfig(f.agentDir, f.cwd, true), { ...project, thinkingLevel: "high" });
  assert.deepEqual(loadConfig(f.agentDir, f.cwd, false), { ...configured, thinkingLevel: "low" });
});

for (const thinkingLevel of [null, "", "LOW", " low ", "invalid", 1, false, [], {}]) {
  test(`invalid thinking level fails closed: ${JSON.stringify(thinkingLevel)}`, (t) => {
    const f = files(t);
    f.global(configured);
    f.project({ ...configured, thinkingLevel });
    assert.throws(() => loadConfig(f.agentDir, f.cwd, true), /thinkingLevel/);
  });
}

for (const invalid of [null, [], "text", { provider: "test" }, { modelId: "model" },
  { thinkingLevel: "low" }, { provider: "", modelId: "model" }, { provider: "p", modelId: 1 },
  { ...configured, apiKey: "secret" }]) {
  test(`invalid model configuration fails closed: ${JSON.stringify(invalid)}`, (t) => {
    const f = files(t);
    f.global(configured);
    f.project(invalid);
    assert.throws(() => loadConfig(f.agentDir, f.cwd, true), /配置/);
  });
}

test("malformed JSON and unreadable config are not treated as missing", (t) => {
  const f = files(t);
  writeFileSync(join(f.agentDir, CONFIG_FILE), "{");
  assert.throws(() => loadConfig(f.agentDir, f.cwd, true), /JSON/);
  mkdirSync(join(f.cwd, ".pi", CONFIG_FILE));
  assert.throws(() => loadConfig(f.agentDir, f.cwd, true), /无法读取/);
});

test("model fallback occurs only when no independent configuration exists", () => {
  const ctx = {
    model: sessionModel,
    modelRegistry: { find: (provider: string, id: string) => provider === configured.provider && id === configured.modelId ? namingModel : undefined },
  } as unknown as ExtensionContext;
  assert.equal(resolveModel(undefined, ctx), sessionModel);
  assert.equal(resolveModel(configured, ctx), namingModel);
  assert.throws(() => resolveModel({ ...configured, modelId: "missing" }, ctx), /未找到/);
  assert.throws(() => resolveModel(undefined, { ...ctx, model: undefined }), /尚未选择/);
});
