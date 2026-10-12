import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { argumentError, CliError } from "./errors.js";

export const ROOT_NAME = ".pi-warp-delegate";
export const BINDING_PARENT = "PI_WARP_DELEGATE_PARENT_DIR";
export const BINDING_SESSION = "PI_WARP_DELEGATE_SESSION_ID";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface EnvironmentContext {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ParentContext {
  root: string;
  directory: string;
  workspace: string;
  parentSessionId: string;
}

export function nonempty(value: string, label: string): string {
  if (!value.trim() || value.includes("\0") || !value.isWellFormed()) {
    argumentError(`${label} must be nonempty, well-formed Unicode and contain no NUL bytes.`);
  }
  return value;
}

export function sessionId(value: string, label = "session ID"): string {
  if (value.length > 128 || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value)) {
    argumentError(`${label} must be 1–128 ASCII letters, digits, dots, underscores or hyphens, starting and ending with a letter or digit.`);
  }
  return value;
}

export async function existingDirectory(path: string, label: string): Promise<string> {
  nonempty(path, label);
  const absolute = await realpath(path);
  if (!(await stat(absolute)).isDirectory()) argumentError(`${label} must be an existing directory.`);
  return absolute;
}

/** Reversible escaping in the usual case; bound component size without dropping identity. */
export function groupName(workspace: string, parentSessionId: string): string {
  sessionId(parentSessionId, "parent session ID");
  const name = basename(workspace) || "root";
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const available = 250 - parentSessionId.length - 2;
  const safe = encoded.length <= available ? encoded :
    `${encoded.slice(0, available - 13)}~${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
  return `${safe}--${parentSessionId}`;
}

export async function rootPath(home: string): Promise<string> {
  return join(await existingDirectory(home, "HOME"), ROOT_NAME);
}

export async function parentContext(
  runtime: EnvironmentContext,
  options: { workspace?: string; parentSessionId?: string },
): Promise<ParentContext> {
  const id = options.parentSessionId ?? runtime.env.PI_SESSION_ID;
  if (!id) argumentError("Supply --parent-session-id, or invoke from the main Pi bash tool with PI_SESSION_ID.");
  const parentSessionId = sessionId(id, "parent session ID");
  const workspace = await existingDirectory(resolve(runtime.cwd, options.workspace ?? "."), "--workspace");
  const root = await rootPath(runtime.home);
  return { root, directory: join(root, groupName(workspace, parentSessionId)), workspace, parentSessionId };
}

export async function reportBinding(runtime: EnvironmentContext): Promise<{ root: string; directory: string; sessionId: string }> {
  const parent = runtime.env[BINDING_PARENT];
  const expected = runtime.env[BINDING_SESSION];
  const current = runtime.env.PI_SESSION_ID;
  if (!parent || !expected || !current) {
    throw new CliError("MISSING_BINDING", "report must run through the delegated Pi's bash tool with its launch binding and current PI_SESSION_ID.");
  }
  sessionId(expected, "bound child session ID");
  sessionId(current, "current Pi session ID");
  if (current !== expected) {
    throw new CliError("SESSION_MISMATCH", "Current Pi session is not the delegated session. Do not report after /new, /fork or switching to another session.");
  }
  const root = await rootPath(runtime.home);
  const directory = resolve(parent);
  if (parent !== directory || dirname(directory) !== root) {
    throw new CliError("INVALID_BINDING", "The bound parent directory must be a direct child of $HOME/.pi-warp-delegate.");
  }
  return { root, directory, sessionId: current };
}

export function modelSelection(env: NodeJS.ProcessEnv, model?: string, thinking?: string): Record<string, unknown> | undefined {
  if (model !== undefined) nonempty(model, "--model");
  if (thinking !== undefined && !THINKING_LEVELS.includes(thinking as typeof THINKING_LEVELS[number])) {
    argumentError(`--thinking must be one of: ${THINKING_LEVELS.join(", ")}.`);
  }
  const missing = [!model && "model", !thinking && "thinking"].filter((value): value is string => Boolean(value));
  if (!missing.length) return undefined;
  return {
    action: "needs_input",
    missing,
    provided: { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) },
    currentMainSession: {
      model: env.PI_PROVIDER && env.PI_MODEL ? `${env.PI_PROVIDER}/${env.PI_MODEL}` : null,
      thinking: THINKING_LEVELS.includes(env.PI_REASONING_LEVEL as typeof THINKING_LEVELS[number]) ? env.PI_REASONING_LEVEL : null,
    },
    instruction: "Ask the user to choose missing values, showing the actual current-main-session model and thinking. Then launch with explicit --model and --thinking. Do not choose silently. No task has been created.",
  };
}
