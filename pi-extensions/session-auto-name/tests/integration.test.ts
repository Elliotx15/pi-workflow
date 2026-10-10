import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionError, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { assistant, deferred, flush, sessionModel, tempDirectory } from "./helpers.ts";

const extensionDir = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("pi install accepts the extension directory and the real loader discovers its manifest", { timeout: 15_000 }, async (t) => {
  const cwd = tempDirectory(t);
  const agentDir = join(cwd, "agent");
  const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const installed = spawnSync(process.execPath, [cli, "install", extensionDir], {
    cwd, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
  });
  assert.equal(installed.status, 0, `${installed.error ?? ""}\n${installed.stdout}\n${installed.stderr}`);
  const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  assert.equal(settings.packages.length, 1);
  assert.equal(resolve(agentDir, settings.packages[0]), extensionDir);

  const loader = new DefaultResourceLoader({
    cwd, agentDir, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0]!;
  assert.equal(extension.path, join(extensionDir, "index.ts"));
  for (const name of ["session_start", "input", "before_agent_start", "agent_settled", "session_tree", "session_shutdown"]) {
    assert.ok(extension.handlers.has(name), `Missing ${name} handler`);
  }
});

test("real Pi lifecycle stays non-blocking and names the first exchange, not a queued follow-up", { timeout: 10_000 }, async (t) => {
  const cwd = tempDirectory(t);
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  // This test uses real Pi plumbing, but no network, credentials, or billable model calls.
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network access in integration test"); });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false,
  });
  const model = { ...sessionModel, api: "test-session-auto-name" };
  const namingInputs: Record<string, unknown>[] = [];
  let mainRequests = 0;
  let initialStream: AssistantMessageEventStream | undefined;
  function complete(stream: AssistantMessageEventStream, text: string): void {
    const result = { ...assistant(text), api: model.api };
    stream.push({ type: "start", partial: { ...result, content: [], stopReason: "pending" } });
    stream.push({ type: "text_start", contentIndex: 0, partial: result });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: result });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: result });
    stream.push({ type: "done", reason: "stop", message: result });
  }
  modelRuntime.registerProvider(model.provider, {
    api: model.api, baseUrl: model.baseUrl, apiKey: "not-a-real-key", models: [model],
    streamSimple(_model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.findLast((message) => message.role === "user")!;
      const text = typeof last.content === "string" ? last.content : last.content
        .filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (text.startsWith('{"firstUserPrompt":')) {
        const data = JSON.parse(text) as Record<string, unknown>;
        namingInputs.push(data);
        if ("finalAssistantReply" in data) {
          complete(stream, '{"action":"rename","title":"修复 OAuth 回调状态校验"}');
        } else {
          initialStream = stream;
        }
      } else {
        mainRequests++;
        if (mainRequests === 1) {
          // Queue the next exchange before completing this one, as TUI follow-up input does.
          void session.followUp("Now work on an unrelated task").then(() => {
            complete(stream, "已修复 OAuth 回调中的 state 参数校验。");
          });
        } else {
          complete(stream, "Completed the unrelated follow-up task.");
        }
      }
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", enableAnalytics: false,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, additionalExtensionPaths: [extensionDir],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const manager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime, model, thinkingLevel: "off", resourceLoader, settingsManager,
    sessionManager: manager, tools: [],
  });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  const errors: ExtensionError[] = [];
  const warnings: string[] = [];
  await session.bindExtensions({
    mode: "tui", onError: (error) => errors.push(error),
    uiContext: { notify: (message: string) => { warnings.push(message); } } as unknown as ExtensionUIContext,
  });
  const refined = deferred<void>();
  session.subscribe((event) => {
    if (event.type === "session_info_changed" && event.name === "修复 OAuth 回调状态校验") refined.resolve();
  });
  await session.prompt("修复 OAuth 登录问题");
  assert.equal(mainRequests, 2);
  assert.equal(session.getLastAssistantText(), "Completed the unrelated follow-up task.");
  assert.equal(manager.getSessionName(), undefined);
  assert.equal(namingInputs.length, 1);
  assert.ok(initialStream);
  complete(initialStream, '{"title":"修复 OAuth 登录问题"}');
  await refined.promise;
  await flush();
  assert.equal(manager.getSessionName(), "修复 OAuth 回调状态校验");
  assert.equal(namingInputs.length, 2);
  assert.deepEqual(namingInputs[1], {
    firstUserPrompt: "修复 OAuth 登录问题", initialTitle: "修复 OAuth 登录问题",
    finalAssistantReply: "已修复 OAuth 回调中的 state 参数校验。",
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});
