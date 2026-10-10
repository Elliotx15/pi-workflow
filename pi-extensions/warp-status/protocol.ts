import * as fs from "node:fs";
import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Outcome } from "./state.ts";
import { plainText } from "./title.ts";

export type WarpSignal = "session_start" | "working" | "blocked" | Outcome;
export interface SessionIdentity {
  id: string;
  cwd: string;
  name?: string;
}

export interface WarpEvent {
  v: 1;
  agent: "pi";
  event: "session_start" | "prompt_submit" | "question_asked" | "stop" | "stop_failure";
  session_id: string;
  cwd: string;
  project: string;
  response?: string;
  summary?: string;
  error_type?: string;
}

export function supportsWarp(
  mode: ExtensionContext["mode"],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (mode !== "tui" || platform !== "darwin" || env.TERM_PROGRAM !== "WarpTerminal") return false;
  if (env.TMUX || env.STY || env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
  const version = env.WARP_CLI_AGENT_PROTOCOL_VERSION;
  return !!version && /^[1-9]\d*$/.test(version);
}

export function makeEvent(identity: SessionIdentity, signal: WarpSignal): WarpEvent {
  const event: WarpEvent = {
    v: 1, agent: "pi",
    event: signal === "working" ? "prompt_submit"
      : signal === "blocked" ? "question_asked"
        : signal === "failed" ? "stop_failure"
          : signal === "session_start" ? "session_start" : "stop",
    session_id: identity.id,
    cwd: identity.cwd,
    project: plainText(basename(identity.cwd)),
  };
  const label = Array.from(plainText(identity.name || basename(identity.cwd))).slice(0, 200).join("");
  // Omit query entirely. Warp can otherwise prefer it over the OSC 0 title.
  if (signal === "blocked") {
    // question_asked uses summary as the blocked message, not as a sticky tab title.
    event.summary = `${label} — 等待操作`;
  } else if (signal === "completed" || signal === "cancelled" || signal === "failed") {
    const status = { completed: "已完成", cancelled: "已取消", failed: "执行失败" }[signal];
    event.response = `${label} — ${status}`;
    if (signal === "failed") event.error_type = "error";
  }
  return event;
}

export function encodeEvent(event: WarpEvent): string {
  return `\x1b]777;notify;warp://cli-agent;${JSON.stringify(event)}\x07`;
}

export interface TerminalIO {
  openSync(path: string, flags: number): number;
  writeSync(fd: number, data: Uint8Array, offset: number, length: number): number;
  closeSync(fd: number): void;
}

/** Use the controlling terminal without writing into Pi's captured stdout. */
export function writeTerminal(sequence: string, io: TerminalIO = fs): void {
  let fd: number | undefined;
  try {
    fd = io.openSync("/dev/tty", fs.constants.O_WRONLY | fs.constants.O_NOCTTY);
    const bytes = Buffer.from(sequence);
    let offset = 0;
    while (offset < bytes.length) {
      const written = io.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) break;
      offset += written;
    }
  } catch {
    // A missing or disconnected terminal is not an agent error.
  } finally {
    if (fd !== undefined) {
      try { io.closeSync(fd); } catch { /* Already disconnected. */ }
    }
  }
}
