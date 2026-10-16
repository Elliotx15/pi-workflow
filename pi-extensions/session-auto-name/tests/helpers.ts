import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { TestContext } from "node:test";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext, ExtensionEvent, InputSource, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import sessionAutoName from "../index.ts";

export const sessionModel: Model<Api> = {
  id: "session-model", name: "Session model", provider: "test-provider", api: "openai-completions",
  baseUrl: "https://example.invalid/v1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000, maxTokens: 8_192,
};
export const namingModel: Model<Api> = { ...sessionModel, id: "naming-model", name: "Naming model" };

export function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }],
    api: sessionModel.api, provider: sessionModel.provider, model: sessionModel.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason, timestamp: Date.now(),
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export const flush = () => setImmediate();

export function tempDirectory(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "pi-session-auto-name-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

export interface RequestCall {
  model: Model<Api>;
  context: Context;
  options: ModelsSimpleStreamOptions;
  result: ReturnType<typeof deferred<AssistantMessage>>;
}

export function harness(t: TestContext, options: { mode?: ExtensionContext["mode"]; trusted?: boolean; persistent?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-session-auto-name-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  let manager = options.persistent ? SessionManager.create(cwd, join(root, "sessions")) : SessionManager.inMemory(cwd);
  let model: Model<Api> | undefined = sessionModel;
  const calls: RequestCall[] = [];
  const names: string[] = [];
  const warnings: string[] = [];
  const handlers = new Map<string, ((event: ExtensionEvent, ctx: ExtensionContext) => unknown)[]>();
  const registry = {
    find: (provider: string, id: string) => [sessionModel, namingModel].find((item) => item.provider === provider && item.id === id),
    streamSimple: (selected: Model<Api>, context: Context, requestOptions?: ModelsSimpleStreamOptions) => {
      const result = deferred<AssistantMessage>();
      calls.push({ model: selected, context, options: requestOptions ?? {}, result });
      return { result: () => result.promise } as AssistantMessageEventStream;
    },
  };
  const ctx = {
    mode: options.mode ?? "tui", cwd,
    get sessionManager() { return manager; },
    get model() { return model; },
    modelRegistry: registry,
    isProjectTrusted: () => options.trusted ?? true,
    ui: { notify: (message: string) => warnings.push(message) },
  } as unknown as ExtensionContext;
  const pi = {
    on(name: string, handler: (event: ExtensionEvent, ctx: ExtensionContext) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); };
    },
    getSessionName: () => manager.getSessionName(),
    setSessionName: (name: string) => {
      names.push(name);
      manager.appendSessionInfo(name);
      void emit({ type: "session_info_changed", name: manager.getSessionName() });
    },
    appendEntry: (customType: string, data: unknown) => manager.appendCustomEntry(customType, data),
  } as unknown as ExtensionAPI;
  sessionAutoName(pi);

  const emit = async (event: ExtensionEvent) => {
    for (const handler of handlers.get(event.type) ?? []) await handler(event, ctx);
  };
  const rename = async (name: string) => {
    manager.appendSessionInfo(name);
    await emit({ type: "session_info_changed", name: manager.getSessionName() });
  };
  const beforeStart = async (prompt: string) => emit({
    type: "before_agent_start", messageType: "user", prompt, systemPrompt: "Never send this system prompt to the naming model",
    systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
  });
  const input = async (text: string, source: InputSource = "interactive") => emit({ type: "input", text, source });
  const begin = async (text: string, source: InputSource = "interactive") => {
    await input(text, source);
    await beforeStart(text);
    manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  };
  const start = (reason: SessionStartEvent["reason"] = "startup") => emit({ type: "session_start", reason });
  const answer = (text: string, stopReason?: AssistantMessage["stopReason"]) => manager.appendMessage(assistant(text, stopReason));
  const settle = (aborted = false) => emit({ type: "agent_settled", aborted });
  const respond = async (index: number, result: unknown) => {
    const call = calls[index];
    if (!call) throw new Error(`No request at index ${index}`);
    call.result.resolve(assistant(JSON.stringify(result)));
    await flush();
  };
  t.after(async () => {
    await emit({ type: "session_shutdown", reason: "quit" });
    await flush();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, agentDir, cwd, ctx, registry, calls, names, warnings, pi,
    get manager() { return manager; },
    setModel: (selected: Model<Api> | undefined) => { model = selected; },
    replaceSession: () => { manager = SessionManager.inMemory(cwd); },
    start, begin, input, beforeStart, answer, settle, respond, emit, rename,
  };
}

export function requestData(call: RequestCall): Record<string, unknown> {
  const message = call.context.messages[0];
  if (!message || typeof message.content !== "string") throw new Error("Expected a text-only naming input");
  return JSON.parse(message.content) as Record<string, unknown>;
}

export function entry(message: AssistantMessage) {
  return { type: "message" as const, id: randomUUID(), parentId: null, timestamp: new Date().toISOString(), message };
}
