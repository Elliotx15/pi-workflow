import { existsSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, InputEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveModel } from "./config.ts";
import type { ModelConfig } from "./config.ts";
import { extractFinalReply, MAX_PROMPT_CHARS, MAX_REPLY_CHARS, requestName, truncateText } from "./naming.ts";

const STATE_TYPE = "session-auto-name";

interface SessionState {
  id: string;
  controller: AbortController;
  config?: ModelConfig;
  pendingInput?: Pick<InputEvent, "text" | "source">;
  started: boolean;
  settled: boolean;
  warned: boolean;
  prompt: string;
  firstTitle?: string;
  initialTask?: Promise<void>;
}

function isNewSession(event: SessionStartEvent, ctx: ExtensionContext): boolean {
  if (event.reason !== "startup" && event.reason !== "new") return false;
  if (ctx.sessionManager.getHeader()?.parentSession) return false;
  // A newly allocated session has a path but Pi does not write it until a conversation starts.
  const file = ctx.sessionManager.getSessionFile();
  if (event.reason === "startup" && file && existsSync(file)) return false;
  // Eligibility is session-wide, not branch-relative: /tree must not make an old session new.
  return !ctx.sessionManager.getEntries().some((entry) =>
    (entry.type === "custom" && entry.customType === STATE_TYPE) ||
    (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) ||
    entry.type === "compaction" || entry.type === "branch_summary",
  );
}

export default function sessionAutoName(pi: ExtensionAPI): void {
  let state: SessionState | undefined;

  function cancel(): void {
    const previous = state;
    state = undefined;
    previous?.controller.abort();
  }

  function active(current: SessionState, ctx: ExtensionContext): boolean {
    // Check local identity first: accessing ctx after runtime replacement can itself throw.
    return state === current && !current.controller.signal.aborted &&
      ctx.mode === "tui" && ctx.sessionManager.getSessionId() === current.id;
  }

  function warn(current: SessionState, ctx: ExtensionContext, message: string): void {
    if (!active(current, ctx) || current.warned) return;
    current.warned = true;
    ctx.ui.notify(`session-auto-name：${message}`, "warning");
  }

  function record(current: SessionState, ctx: ExtensionContext, phase: string): void {
    if (!active(current, ctx)) return;
    try {
      pi.appendEntry(STATE_TYPE, { version: 1, phase });
    } catch {
      warn(current, ctx, "无法保存命名状态");
    }
  }

  function applyTitle(current: SessionState, ctx: ExtensionContext, title: string): void {
    if (active(current, ctx) && pi.getSessionName() !== title) pi.setSessionName(title);
  }

  async function nameInitially(current: SessionState, ctx: ExtensionContext): Promise<void> {
    try {
      const decision = await requestName(ctx.modelRegistry, resolveModel(current.config, ctx), {
        stage: "initial", prompt: current.prompt,
      }, current.controller.signal);
      if (!active(current, ctx)) return;
      if (decision.action === "rename") {
        applyTitle(current, ctx, decision.title);
        current.firstTitle = decision.title;
      }
      record(current, ctx, "initial_completed");
    } catch (error) {
      if (!active(current, ctx)) return;
      warn(current, ctx, error instanceof Error ? error.message : "第一次命名失败");
      record(current, ctx, "initial_failed");
    }
  }

  async function refine(current: SessionState, ctx: ExtensionContext, reply: string | undefined): Promise<void> {
    await current.initialTask;
    if (!active(current, ctx)) return;
    if (!reply) {
      record(current, ctx, "refinement_skipped");
      return;
    }
    record(current, ctx, "refinement_started");
    try {
      const decision = await requestName(ctx.modelRegistry, resolveModel(current.config, ctx), {
        stage: "refine", prompt: current.prompt, firstTitle: current.firstTitle, reply,
      }, current.controller.signal);
      if (!active(current, ctx)) return;
      // "keep" deliberately does not restore the first title over a later manual name.
      if (decision.action === "rename") applyTitle(current, ctx, decision.title);
      record(current, ctx, "completed");
    } catch (error) {
      if (!active(current, ctx)) return;
      warn(current, ctx, error instanceof Error ? error.message : "第二次命名失败");
      record(current, ctx, "refinement_failed");
    }
  }

  pi.on("session_start", (event, ctx) => {
    cancel();
    if (ctx.mode !== "tui" || !isNewSession(event, ctx)) return;
    const current: SessionState = {
      id: ctx.sessionManager.getSessionId(),
      controller: new AbortController(),
      started: false, settled: false, warned: false, prompt: "",
    };
    state = current;
    try {
      current.config = loadConfig(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
    } catch (error) {
      warn(current, ctx, error instanceof Error ? error.message : "无法读取配置");
      cancel();
    }
  });

  pi.on("input", (event, ctx) => {
    const current = state;
    if (!current || !active(current, ctx) || current.started) return;
    // Replace a candidate if a preceding input was handled by another extension or failed preflight.
    current.pendingInput = { text: event.text, source: event.source };
  });

  pi.on("before_agent_start", (_event, ctx) => {
    const current = state;
    if (!current || !active(current, ctx) || current.started) return;
    const input = current.pendingInput;
    current.pendingInput = undefined;
    current.started = true;
    if (!input || input.source !== "interactive" || !input.text.trim()) {
      record(current, ctx, "skipped");
      cancel();
      return;
    }
    current.prompt = truncateText(input.text.trim(), MAX_PROMPT_CHARS);
    record(current, ctx, "initial_started");
    // Do not return/await this promise: Pi awaits event handlers on the main conversation path.
    current.initialTask = nameInitially(current, ctx);
  });

  pi.on("agent_settled", (event, ctx) => {
    const current = state;
    if (!current || !active(current, ctx) || !current.started || current.settled) return;
    current.settled = true;
    const reply = event.aborted ? undefined : extractFinalReply(ctx.sessionManager.getBranch());
    // Snapshot before awaiting the first request; a subsequent turn must not replace this reply.
    void refine(current, ctx, reply ? truncateText(reply, MAX_REPLY_CHARS) : undefined);
  });

  pi.on("session_tree", cancel);
  pi.on("session_shutdown", cancel);
}
