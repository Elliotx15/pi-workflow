import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { groupName, sessionId } from "./context.js";
import type { ParentContext } from "./context.js";
import { CliError, hasCode } from "./errors.js";
import { isTaskState, transition } from "./state-machine.js";
import type { ReportState, TaskState } from "./state-machine.js";

export interface ParentIndex {
  version: 1;
  workspace: string;
  parentSessionId: string;
  childSessionIds: string[];
}
export interface StateSnapshot { sessionId: string; state: TaskState }

export async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new CliError("UNSAFE_PATH", `Expected a real directory, not a symlink: ${JSON.stringify(path)}`);
  }
}

/** Only creates one component, never follows an existing symlink. */
export async function ensureDirectory(path: string, privateDirectory = false): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  await assertDirectory(path);
  if (privateDirectory) await chmod(path, 0o700);
}

export async function readRegularFile(path: string, maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
  // NONBLOCK also prevents a concurrently substituted FIFO from hanging the caller.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) {
      throw new CliError("INVALID_FILE", `Expected a regular file of at most ${maxBytes} bytes: ${JSON.stringify(path)}`);
    }
    const content = await file.readFile();
    if (content.length > maxBytes) throw new CliError("INVALID_FILE", "File grew beyond its size limit while being read.");
    return content;
  } finally {
    await file.close();
  }
}

export async function readJson(path: string, maxBytes?: number): Promise<unknown> {
  const bytes = await readRegularFile(path, maxBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new CliError("CORRUPT_RECORD", `Invalid UTF-8 JSON: ${JSON.stringify(path)}. No task state was inferred.`);
  }
}

/** The temporary file and destination share a directory/filesystem. */
export async function atomicWrite(path: string, content: string | Buffer, exclusive = false): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    if (exclusive) {
      // link publishes a complete file without clobbering a pre-existing destination.
      await link(temporary, path);
    } else {
      const previous = await lstat(path).catch((error: unknown) => {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      });
      if (previous && (!previous.isFile() || previous.isSymbolicLink())) {
        throw new CliError("UNSAFE_PATH", `Refusing to replace a non-regular file: ${JSON.stringify(path)}`);
      }
      await rename(temporary, path);
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => { if (!hasCode(error, "ENOENT")) throw error; });
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Bounded cross-process lock. Never steal a lock based on PID or age. */
export async function withLock<T>(path: string, operation: () => Promise<T>, timeoutMs = 3_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let attempted = false;
  for (;;) {
    if (attempted && performance.now() >= deadline) {
      throw new CliError("STORE_BUSY", `Timed out waiting for ${JSON.stringify(path)}. A crashed writer may leave a lock; only remove it after confirming no writer is active.`);
    }
    attempted = true;
    try {
      await mkdir(path, { mode: 0o700 });
      break;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      // The owner may release it between mkdir and lstat.
      try { await assertDirectory(path); } catch (checkError) {
        if (!hasCode(checkError, "ENOENT")) throw checkError;
        continue;
      }
      await delay(15);
    }
  }
  try {
    return await operation();
  } finally {
    await rmdir(path);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateIndex(value: unknown, directory: string): ParentIndex {
  try {
    if (!isObject(value) || Object.keys(value).sort().join(",") !== "childSessionIds,parentSessionId,version,workspace" ||
      value.version !== 1 || typeof value.workspace !== "string" ||
      !isAbsolute(value.workspace) || resolve(value.workspace) !== value.workspace ||
      typeof value.parentSessionId !== "string" || !Array.isArray(value.childSessionIds)) throw new Error();
    sessionId(value.parentSessionId);
    for (const child of value.childSessionIds) {
      if (typeof child !== "string") throw new Error();
      sessionId(child);
      if (child === value.parentSessionId) throw new Error();
    }
    if (new Set(value.childSessionIds).size !== value.childSessionIds.length ||
      basename(directory) !== groupName(value.workspace, value.parentSessionId)) throw new Error();
    return value as unknown as ParentIndex;
  } catch {
    throw new CliError("CORRUPT_INDEX", `Invalid or mismatched parent index: ${JSON.stringify(join(directory, "index.json"))}`);
  }
}

export class Store {
  constructor(private readonly lockTimeoutMs = 3_000) {}

  private async loadIndex(root: string, directory: string, expected?: ParentContext): Promise<ParentIndex> {
    if (dirname(directory) !== root) throw new CliError("INVALID_BINDING", "Parent directory is outside the state root.");
    await assertDirectory(root);
    await assertDirectory(directory);
    const index = validateIndex(await readJson(join(directory, "index.json")), directory);
    if (expected && (index.workspace !== expected.workspace || index.parentSessionId !== expected.parentSessionId)) {
      throw new CliError("WORKSPACE_COLLISION", "This parent directory belongs to a different workspace or session. Refusing to merge records.");
    }
    return index;
  }

  async register(context: ParentContext, childId: string, prepare: (directory: string) => Promise<void>): Promise<void> {
    sessionId(childId, "child session ID");
    if (childId === context.parentSessionId) throw new CliError("SESSION_COLLISION", "A child session must differ from its parent.");
    await ensureDirectory(context.root, true);
    await ensureDirectory(context.directory, true);
    await withLock(join(context.directory, ".index.lock"), async () => {
      let index: ParentIndex;
      try {
        index = await this.loadIndex(context.root, context.directory, context);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
        if ((await readdir(context.directory)).some((entry) => entry !== ".index.lock")) {
          throw new CliError("MISSING_INDEX", "Parent index is missing but the directory is not empty; refusing to discard existing registrations.");
        }
        index = { version: 1, workspace: context.workspace, parentSessionId: context.parentSessionId, childSessionIds: [] };
      }
      if (index.childSessionIds.includes(childId)) throw new CliError("SESSION_COLLISION", "Child session is already registered.");
      const childDirectory = join(context.directory, childId);
      // No recursive mkdir: collisions must never overwrite existing task files.
      await mkdir(childDirectory, { mode: 0o700 });
      try {
        await atomicWrite(join(childDirectory, "state.json"), json({ state: "launching" }), true);
        await prepare(childDirectory);
        await atomicWrite(join(context.directory, "index.json"), json({
          ...index, childSessionIds: [...index.childSessionIds, childId],
        }));
      } catch (error) {
        // Only our newly allocated, unpublished directory is eligible for rollback.
        await rm(childDirectory, { recursive: true, force: true });
        throw error;
      }
    }, this.lockTimeoutMs);
  }

  private async registered(root: string, directory: string, childId: string, expected?: ParentContext): Promise<string> {
    sessionId(childId, "child session ID");
    const index = await this.loadIndex(root, directory, expected);
    if (!index.childSessionIds.includes(childId)) throw new CliError("NOT_REGISTERED", "Child session is not registered under this parent.");
    const childDirectory = join(directory, childId);
    await assertDirectory(childDirectory);
    return childDirectory;
  }

  private async readState(directory: string): Promise<TaskState> {
    const value = await readJson(join(directory, "state.json"), 4_096);
    if (!isObject(value) || Object.keys(value).length !== 1 || !isTaskState(value.state)) {
      throw new CliError("CORRUPT_STATE", "Invalid task state record. No replacement state was inferred.");
    }
    return value.state;
  }

  async status(context: ParentContext, childId: string): Promise<StateSnapshot> {
    const directory = await this.registered(context.root, context.directory, childId, context);
    return { sessionId: childId, state: await this.readState(directory) };
  }

  async report(root: string, parentDirectory: string, childId: string, requested: ReportState): Promise<StateSnapshot> {
    const directory = await this.registered(root, parentDirectory, childId);
    return withLock(join(directory, ".state.lock"), async () => {
      const current = await this.readState(directory);
      const next = transition(current, requested);
      if (current !== next) await atomicWrite(join(directory, "state.json"), json({ state: next }));
      return { sessionId: childId, state: next };
    }, this.lockTimeoutMs);
  }
}
