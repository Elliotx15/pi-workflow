import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { ActivityState } from "./state.ts";
import type { Outcome, Phase } from "./state.ts";
import { encodeEvent, makeEvent, supportsWarp, writeTerminal } from "./protocol.ts";
import type { WarpSignal } from "./protocol.ts";
import { piTitle, TitleAnimation } from "./title.ts";
import { monitorSubagents } from "./subagents.ts";
import type { SubagentMonitor } from "./subagents.ts";

export const HEARTBEAT_MS = 15_000;

interface SessionRuntime {
  id: string;
  cwd: string;
  ctx: ExtensionContext;
  activity: ActivityState;
  title: TitleAnimation;
  phase: Phase;
  announced: boolean;
  runGeneration: number;
  subagents?: SubagentMonitor;
  heartbeat?: ReturnType<typeof setInterval>;
  compactionSignal?: AbortSignal;
}

interface RuntimeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  write?: (sequence: string) => void;
}

export function createWarpStatusExtension(options: RuntimeOptions = {}): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    let current: SessionRuntime | undefined;
    const write = options.write ?? writeTerminal;

    function send(session: SessionRuntime, signal: WarpSignal): void {
      if (current !== session) return;
      try {
        write(encodeEvent(makeEvent({
          id: session.id, cwd: session.cwd, name: pi.getSessionName(),
        }, signal)));
      } catch {
        // Status delivery is best-effort, including during terminal shutdown.
      }
    }

    function announce(session: SessionRuntime): void {
      if (session.announced) return;
      session.announced = true;
      send(session, "session_start");
    }

    function clearHeartbeat(session: SessionRuntime): void {
      if (session.heartbeat !== undefined) clearInterval(session.heartbeat);
      session.heartbeat = undefined;
    }

    function update(session: SessionRuntime, outcome?: Outcome): void {
      if (current !== session) return;
      const phase = session.activity.phase;
      if (phase !== session.phase) {
        clearHeartbeat(session);
        if (phase === "working") {
          announce(session);
          send(session, "working");
          session.title.start();
          session.heartbeat = setInterval(() => {
            if (current === session && session.activity.phase === "working") send(session, "working");
          }, HEARTBEAT_MS);
          session.heartbeat.unref();
        } else {
          if (phase === "blocked") {
            announce(session);
            send(session, "blocked");
          }
          session.title.pause();
        }
        session.phase = phase;
      }
      if (outcome !== undefined) {
        announce(session);
        send(session, outcome);
        session.title.refresh();
      }
    }

    function useSession(ctx: ExtensionContext): SessionRuntime | undefined {
      if (!current || ctx.mode !== "tui" || current.id !== ctx.sessionManager.getSessionId()) return undefined;
      current.ctx = ctx;
      return current;
    }

    function dispose(restore: boolean): void {
      const session = current;
      if (!session) return;
      clearHeartbeat(session);
      session.subagents?.dispose();
      session.title.dispose(restore);
      current = undefined;
    }

    pi.on("session_start", (_event, ctx) => {
      dispose(false);
      if (!supportsWarp(ctx.mode, options.platform, options.env)) return;
      const cwd = ctx.sessionManager.getCwd();
      const session: SessionRuntime = {
        id: ctx.sessionManager.getSessionId(), cwd, ctx,
        activity: new ActivityState(), phase: "idle", announced: false, runGeneration: 0,
        title: new TitleAnimation(
          () => piTitle(pi.getSessionName(), cwd),
          (title) => { if (current === session) session.ctx.ui.setTitle(title); },
        ),
      };
      current = session;
      session.title.refresh();
      session.subagents = monitorSubagents(pi.events, session.id, (active) => {
        if (current !== session) return;
        update(session, session.activity.setBackground(active));
      });
    });

    pi.on("session_info_changed", (_event, ctx) => {
      useSession(ctx)?.title.refresh();
    });

    pi.on("agent_start", (_event, ctx) => {
      const session = useSession(ctx);
      if (!session) return;
      session.runGeneration++;
      session.activity.startRun();
      update(session);
    });

    pi.on("message_end", (event, ctx) => {
      const session = useSession(ctx);
      if (!session || event.message.role !== "assistant") return;
      const reason = event.message.stopReason;
      session.activity.recordResponse(reason === "error" ? "failed" : reason === "aborted" ? "cancelled" : "completed");
    });

    pi.on("agent_settled", async (event, ctx) => {
      const session = useSession(ctx);
      if (!session) return;
      const generation = session.runGeneration;
      // Refresh before retiring the parent, including launches not yet polled.
      // An absent/unsupported companion does not delay normal settlement.
      const refresh = session.subagents?.refresh();
      if (refresh) await refresh;
      if (current !== session || generation !== session.runGeneration) return;
      update(session, session.activity.settle(event.aborted));
    });

    pi.on("session_before_compact", (event, ctx) => {
      const session = useSession(ctx);
      if (!session) return;
      session.compactionSignal = event.signal;
      session.activity.startCompaction(event.reason === "manual");
      update(session);
    });

    pi.on("session_compact", (event, ctx) => {
      const session = useSession(ctx);
      if (!session) return;
      session.compactionSignal = undefined;
      update(session, session.activity.finishCompaction(event.reason === "manual", "completed"));
    });

    pi.on("session_compact_failed", (event, ctx) => {
      const session = useSession(ctx);
      if (!session) return;
      session.compactionSignal = undefined;
      update(session, session.activity.finishCompaction(event.reason === "manual", event.aborted ? "cancelled" : "failed"));
    });

    pi.on("ui_prompt_start", (_event, ctx) => {
      const session = useSession(ctx);
      if (!session) return;
      session.activity.openPrompt();
      update(session);
    });

    pi.on("ui_prompt_end", (_event, ctx) => {
      const session = useSession(ctx);
      if (!session) return;
      // An aborted dialog can close before the cancelled operation has settled.
      if (session.activity.foregroundActive && (ctx.signal?.aborted || session.compactionSignal?.aborted)) return;
      session.activity.closePrompt();
      update(session);
    });

    pi.on("session_shutdown", (_event, ctx) => {
      const session = current;
      if (!session || session.id !== ctx.sessionManager.getSessionId()) return;
      session.ctx = ctx;
      if (ctx.mode === "tui" && session.activity.active) send(session, "cancelled");
      dispose(ctx.mode === "tui");
    });
  };
}

export default createWarpStatusExtension();
