import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";
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
  for (const name of ["session_start", "session_info_changed", "input", "before_agent_start", "agent_settled", "session_tree", "session_shutdown"]) {
    assert.ok(extension.handlers.has(name), `Missing ${name} handler`);
  }
});

type Takeover = "none" | "startup" | "initial" | "refinement" | "extension" | "notification";

async function checkRealLifecycle(t: TestContext, takeover: Takeover, prelude?: "custom" | "handled-custom"): Promise<void> {
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
  let backgroundRequests = 0;
  const backgroundPrompt = "Background task before the first user prompt";
  const triggerTypes: string[] = [];
  let initialStream: AssistantMessageEventStream | undefined;
  let refinementStream: AssistantMessageEventStream | undefined;
  let namingSignal: AbortSignal | undefined;
  const externalName = "External name";
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
    streamSimple(_model, context, options) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.findLast((message) => message.role === "user")!;
      const text = typeof last.content === "string" ? last.content : last.content
        .filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (text.startsWith('{"firstUserPrompt":')) {
        const data = JSON.parse(text) as Record<string, unknown>;
        namingInputs.push(data);
        namingSignal = options?.signal;
        if ("finalAssistantReply" in data) {
          refinementStream = stream;
        } else {
          initialStream = stream;
        }
      } else if (text === backgroundPrompt) {
        backgroundRequests++;
        complete(stream, "Background task completed.");
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
    extensionFactories: [(pi) => {
      pi.registerCommand("external-name", {
        description: "Set a name from another extension",
        handler: async () => { pi.setSessionName(externalName); },
      });
      // File extensions load first, so auto-name observes this input before it is consumed.
      pi.on("input", (event) => {
        if (event.text === "Consumed locally") return { action: "handled" };
      });
      pi.on("before_agent_start", (event) => { triggerTypes.push(event.messageType); });
    }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const manager = SessionManager.inMemory(cwd);
  if (takeover === "startup") manager.appendSessionInfo(externalName);
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
    if (event.type !== "session_info_changed") return;
    if (event.name === "修复 OAuth 回调状态校验") refined.resolve();
    if (takeover === "notification" && event.name === "修复 OAuth 登录问题") session.setSessionName(externalName);
  });
  if (prelude) {
    if (prelude === "handled-custom") await session.prompt("Consumed locally");
    await session.sendCustomMessage({
      customType: "background-task", content: backgroundPrompt, display: false,
    }, { triggerTurn: true });
    await flush();
    assert.equal(mainRequests, 0);
    assert.equal(backgroundRequests, 1);
    assert.deepEqual(triggerTypes, ["custom"]);
    assert.equal(namingInputs.length, 0, "custom runs must not name a previously handled input");
    assert.equal(manager.getSessionName(), undefined);
    assert.equal(manager.getEntries().filter((entry) => entry.type === "custom" &&
      entry.customType === "session-auto-name").length, 0, "custom runs must not consume the naming cycle");
  }
  await session.prompt("修复 OAuth 登录问题");
  assert.equal(mainRequests, 2);
  assert.equal(session.getLastAssistantText(), "Completed the unrelated follow-up task.");
  if (takeover === "startup") {
    assert.equal(namingInputs.length, 0);
  } else {
    assert.equal(manager.getSessionName(), undefined);
    assert.equal(namingInputs.length, 1);
    assert.ok(initialStream);
    if (takeover === "initial") session.setSessionName(externalName);
    if (takeover === "extension") await session.prompt("/external-name");
    // The provider deliberately ignores cancellation and still delivers its late result.
    complete(initialStream, '{"title":"修复 OAuth 登录问题"}');
    await flush();
    if (takeover === "none" || takeover === "refinement") {
      assert.equal(namingInputs.length, 2);
      assert.deepEqual(namingInputs[1], {
        firstUserPrompt: "修复 OAuth 登录问题", initialTitle: "修复 OAuth 登录问题",
        finalAssistantReply: "已修复 OAuth 回调中的 state 参数校验。",
      });
      assert.ok(refinementStream);
      if (takeover === "refinement") session.setSessionName(externalName);
      complete(refinementStream, '{"action":"rename","title":"修复 OAuth 回调状态校验"}');
      if (takeover === "none") await refined.promise;
      await flush();
    } else {
      assert.equal(namingInputs.length, 1, "external naming must prevent refinement");
    }
    assert.equal(namingSignal?.aborted, takeover !== "none");
  }
  assert.equal(manager.getSessionName(), takeover === "none" ? "修复 OAuth 回调状态校验" : externalName);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
}

test("real Pi lifecycle stays non-blocking and names the first exchange, not a queued follow-up", { timeout: 10_000 },
  (t) => checkRealLifecycle(t, "none"));

for (const prelude of ["custom", "handled-custom"] as const) {
  test(`real Pi custom-message runs preserve first-user naming: ${prelude}`, { timeout: 10_000 },
    (t) => checkRealLifecycle(t, "none", prelude));
}

for (const takeover of ["startup", "initial", "refinement", "extension", "notification"] as const) {
  test(`real Pi lifecycle protects external names: ${takeover}`, { timeout: 10_000 },
    (t) => checkRealLifecycle(t, takeover));
}
