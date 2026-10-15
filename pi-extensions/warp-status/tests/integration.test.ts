import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionError, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createWarpStatusExtension } from "../index.ts";
import type { WarpEvent } from "../protocol.ts";
import { decode, deferred, warpEnv } from "./helpers.ts";

const extensionDir = resolve(fileURLToPath(new URL("../", import.meta.url)));
const model: Model<Api> = {
  id: "warp-status-test", name: "Test model", provider: "warp-status-test", api: "warp-status-test",
  baseUrl: "https://example.invalid/v1", reasoning: false, input: ["text"],
  contextWindow: 128_000, maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function pendingResponse(signal?: AbortSignal) {
  const stream = createAssistantMessageEventStream();
  let finished = false;
  function complete(text: string, reason: "stop" | "error" | "aborted" = "stop") {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", abort);
    const message: AssistantMessage = {
      role: "assistant", content: [{ type: "text", text }],
      api: model.api, provider: model.provider, model: model.id,
      stopReason: reason, timestamp: Date.now(),
      usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      ...(reason === "error" ? { errorMessage: text } : {}),
    };
    stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    if (reason === "stop") {
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
    } else {
      stream.push({ type: "error", reason, error: message });
    }
  }
  function abort() { complete("", "aborted"); }
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return { stream, complete };
}

type PendingResponse = ReturnType<typeof pendingResponse>;

function lastUser(context: Context): string {
  const user = context.messages.findLast((message) => message.role === "user");
  if (!user) return "";
  return typeof user.content === "string" ? user.content : user.content
    .filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

async function realSession(t: TestContext, handleRequest: (text: string, response: PendingResponse) => void, options: {
  autoName?: boolean;
  retry?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-warp-status-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let activeSession: AgentSession | undefined;
  t.after(async () => {
    if (activeSession) {
      await activeSession.abort();
      await activeSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      activeSession.dispose();
    }
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", () => { throw new Error("Integration tests must not access the network"); });
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.registerProvider(model.provider, {
    api: model.api, baseUrl: model.baseUrl, apiKey: "test-only", models: [model],
    streamSimple(_model, context, requestOptions) {
      const response = pendingResponse(requestOptions?.signal);
      handleRequest(lastUser(context), response);
      return response.stream;
    },
  });
  const events: WarpEvent[] = [];
  const titles: string[] = [];
  const errors: ExtensionError[] = [];
  const warnings: string[] = [];
  const confirmation = deferred<boolean>();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, cacheWarming: "off", enableAnalytics: false,
    retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 10 },
  });
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    additionalExtensionPaths: options.autoName ? [resolve(extensionDir, "../session-auto-name/index.ts")] : [],
    extensionFactories: [
      createWarpStatusExtension({ platform: "darwin", env: warpEnv, write: (wire) => events.push(decode(wire)) }),
    ],
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", tools: [],
    settingsManager, sessionManager: manager, resourceLoader: loader,
  });
  activeSession = session;
  await session.bindExtensions({
    mode: "tui", onError: (error) => errors.push(error),
    uiContext: {
      setTitle: (title: string) => titles.push(title),
      notify: (message: string) => warnings.push(message),
      confirm: () => confirmation.promise,
    } as unknown as ExtensionUIContext,
  });
  return { session, manager, events, titles, errors, warnings, confirmation, cwd };
}

const finalEvents = (events: WarpEvent[]) => events.filter((event) => event.event === "stop" || event.event === "stop_failure");

test("the CLI installs the local package and the real loader discovers its public handlers", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-warp-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const result = spawnSync(process.execPath, [cli, "install", extensionDir], {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  assert.equal(resolve(agentDir, settings.packages[0]), extensionDir);
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0]!;
  for (const event of ["session_start", "agent_start", "agent_settled", "ui_prompt_start", "ui_prompt_end", "session_info_changed", "session_shutdown"]) {
    assert.ok(extension.handlers.has(event), `Missing ${event}`);
  }
  assert.equal(extension.tools.size, 0);
  assert.equal(extension.commands.size, 0);
});

test("real Pi UI waits and asynchronous auto-naming coexist across a queued follow-up", { timeout: 15_000 }, async (t) => {
  let initialName: PendingResponse | undefined;
  const firstRun = deferred<PendingResponse>();
  const followUp = deferred<PendingResponse>();
  let mainRequests = 0;
  const h = await realSession(t, (text, response) => {
    if (text.startsWith('{"firstUserPrompt":')) {
      const input = JSON.parse(text);
      if ("finalAssistantReply" in input) response.complete('{"action":"rename","title":"最终自动命名"}');
      else initialName = response;
    } else {
      if (++mainRequests === 1) firstRun.resolve(response);
      else followUp.resolve(response);
    }
  }, { autoName: true });
  const run = h.session.prompt("PRIVATE_USER_PROMPT");
  const first = await firstRun.promise;
  assert.ok(initialName);
  initialName.complete('{"title":"首次自动命名"}');
  await setImmediate();
  assert.equal(h.manager.getSessionName(), "首次自动命名");
  assert.match(h.titles.at(-1)!, /^[⠴⠦⠖⠲] 首次自动命名 - project$/);

  const dialog = h.session.extensionRunner.getUIContext().confirm("PRIVATE_DIALOG", "PRIVATE_PERMISSION");
  await setImmediate();
  assert.equal(h.events.at(-1)?.event, "question_asked");
  assert.equal(h.titles.at(-1), "首次自动命名 - project");
  h.session.setSessionName("等待期间改名");
  await setImmediate();
  assert.equal(h.titles.at(-1), "等待期间改名 - project");
  h.confirmation.resolve(true);
  await dialog;
  await setImmediate();
  assert.equal(h.events.at(-1)?.event, "prompt_submit");
  assert.match(h.titles.at(-1)!, /^⠴ 等待期间改名/);

  await h.session.followUp("PRIVATE_FOLLOW_UP");
  first.complete("PRIVATE_FIRST_REPLY");
  const second = await followUp.promise;
  assert.equal(finalEvents(h.events).length, 0);
  second.complete("PRIVATE_SECOND_REPLY");
  await run;
  await setImmediate();
  await setImmediate();
  assert.equal(mainRequests, 2);
  assert.equal(h.manager.getSessionName(), "最终自动命名");
  assert.equal(h.titles.at(-1), "最终自动命名 - project");
  assert.equal(finalEvents(h.events).length, 1);
  assert.match(finalEvents(h.events)[0]!.response!, / — 已完成$/);
  assert.equal(JSON.stringify(h.events).includes("PRIVATE_"), false);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.warnings, []);
});

test("real automatic retry emits no final notification between low-level runs", { timeout: 15_000 }, async (t) => {
  const retried = deferred<PendingResponse>();
  let requests = 0;
  const h = await realSession(t, (_text, response) => {
    if (++requests === 1) response.complete("429 Too Many Requests: PRIVATE_ERROR", "error");
    else retried.resolve(response);
  }, { retry: true });
  const run = h.session.prompt("PRIVATE_RETRY_PROMPT");
  const response = await retried.promise;
  assert.equal(finalEvents(h.events).length, 0);
  assert.match(h.titles.at(-1)!, /^[⠴⠦⠖⠲] /);
  response.complete("PRIVATE_RECOVERED_REPLY");
  await run;
  assert.equal(finalEvents(h.events).length, 1);
  assert.equal(finalEvents(h.events)[0]?.event, "stop");
  assert.equal(h.titles.at(-1), basename(h.cwd));
  assert.deepEqual(h.errors, []);
});

test("real abort while a UI prompt remains open clears the badge and cannot resume on late dismissal", { timeout: 15_000 }, async (t) => {
  const started = deferred<void>();
  const h = await realSession(t, () => started.resolve());
  const run = h.session.prompt("PRIVATE_CANCEL_PROMPT");
  await started.promise;
  const dialog = h.session.extensionRunner.getUIContext().confirm("PRIVATE_DIALOG", "PRIVATE_PERMISSION");
  await setImmediate();
  assert.equal(h.events.at(-1)?.event, "question_asked");
  await h.session.abort();
  await run;
  assert.equal(h.events.at(-1)?.response, "project — 已取消");
  const count = h.events.length;
  h.confirmation.resolve(false);
  await dialog;
  await setImmediate();
  assert.equal(h.events.length, count);
  assert.equal(h.titles.at(-1), "project");
  assert.equal(finalEvents(h.events).length, 1);
  assert.deepEqual(h.errors, []);
});

test("a real manual compaction failure before preparation reports failure without starting timers", { timeout: 15_000 }, async (t) => {
  const h = await realSession(t, () => assert.fail("An empty session must not make a model request"));
  await assert.rejects(h.session.compact());
  assert.equal(h.events.at(-1)?.event, "stop_failure");
  assert.equal(h.events.at(-1)?.response, "project — 执行失败");
  assert.equal(h.titles.at(-1), "project");
  assert.deepEqual(h.errors, []);
});
