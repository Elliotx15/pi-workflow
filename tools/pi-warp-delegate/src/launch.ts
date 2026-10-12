import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, open, realpath, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  BINDING_PARENT, BINDING_SESSION, existingDirectory, modelSelection, nonempty, parentContext,
} from "./context.js";
import type { EnvironmentContext, ParentContext } from "./context.js";
import { argumentError, CliError, errorMessage, hasCode } from "./errors.js";
import { atomicWrite, ensureDirectory, readRegularFile, Store } from "./storage.js";

export interface Runtime extends EnvironmentContext {
  platform: NodeJS.Platform;
  nodePath: string;
  cliPath: string;
  openUri: (uri: string) => Promise<void>;
}

export function defaultRuntime(): Runtime {
  return {
    home: homedir(), cwd: process.cwd(), env: process.env, platform: process.platform,
    nodePath: process.execPath, cliPath: fileURLToPath(new URL("./cli.js", import.meta.url)),
    openUri: async (uri) => {
      await promisify(execFile)("/usr/bin/open", [uri], { timeout: 10_000, maxBuffer: 64 * 1024 });
    },
  };
}

export interface LaunchOptions {
  workspace?: string;
  parentSessionId?: string;
  cwd: string;
  promptFile: string;
  name: string;
  model?: string;
  thinking?: string;
  newWindow?: boolean;
  dryRun?: boolean;
}

export interface LaunchPlan {
  sessionId: string;
  parent: ParentContext;
  cwd: string;
  name: string;
  model: string;
  thinking: string;
  nodePath: string;
  cliPath: string;
  piPath: string;
  childDirectory: string;
  tabConfigPath: string;
  warpUri: string;
  prompt: Buffer;
  protocol: string;
  script: string;
  tabConfig: string;
}

export function shellQuote(value: string): string {
  if (value.includes("\0")) argumentError("Shell arguments cannot contain NUL bytes.");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function shellCommand(args: readonly string[]): string {
  return args.map(shellQuote).join(" ");
}

/** JSON escapes are a subset of TOML basic-string escapes; escape DEL/C1 as well. */
export function tomlString(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export async function resolvePi(runtime: Runtime): Promise<string> {
  for (const entry of (runtime.env.PATH ?? "").split(":")) {
    const candidate = resolve(runtime.cwd, entry || ".", "pi");
    let path: string;
    try {
      path = await realpath(candidate);
      await access(path, constants.X_OK | constants.R_OK);
      if (!(await stat(path)).isFile()) continue;
    } catch (error) {
      if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR") || hasCode(error, "EACCES")) continue;
      throw error;
    }
    const file = await open(path, "r");
    try {
      const prefix = Buffer.alloc(512);
      const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
      if (!/^#![^\n]*\bnode(?:\s|$)/.test(prefix.subarray(0, bytesRead).toString("utf8"))) {
        throw new CliError("UNSUPPORTED_PI_ENTRY", `pi on PATH is not a Node CLI entry: ${JSON.stringify(path)}. Put the actual Node-based Pi executable on PATH, not a shell shim.`);
      }
    } finally {
      await file.close();
    }
    return path;
  }
  throw new CliError("PI_NOT_FOUND", "Cannot find a Node-based pi executable on PATH. No Pi process was invoked.");
}

function protocol(plan: Pick<LaunchPlan, "sessionId" | "nodePath" | "cliPath" | "parent">): string {
  const report = shellCommand([plan.nodePath, plan.cliPath, "report"]);
  const query = shellCommand([
    plan.nodePath, plan.cliPath, "status", plan.sessionId,
    "--workspace", plan.parent.workspace, "--parent-session-id", plan.parent.parentSessionId, "--json",
  ]);
  return `# 委派任务状态协议\n\n` +
    `本会话 ${plan.sessionId} 只关联启动时附带的一个委派任务。你是普通 Pi 交互会话，用户可以接手。\n` +
    `主 Pi 只查询状态，不接收结果、问题正文、文件清单或报告。请使用现有 bash 工具主动调用以下命令。\n` +
    `这些调用路径已确定，不依赖 PATH；不要另写状态文件，也不要创建新的模型工具。\n\n` +
    `- 开始或恢复原任务：${report} --state in_progress --json\n` +
    `- 需要用户回答或确认：${report} --state waiting_user --json\n` +
    `- 被外部条件阻塞：${report} --state blocked --json\n` +
    `- 原任务完成：${report} --state completed --json\n` +
    `- 明确无法完成并结束原任务：${report} --state failed --json\n` +
    `- 用户明确要求放弃原任务：${report} --state cancelled --json\n\n` +
    `先报告 in_progress，再执行任务。问题和结果正常呈现在本 TUI 中，不通过 report 传送正文。\n` +
    `工具错误、重试、回复结束、等待输入或 Escape 不等于结案；可恢复的错误不要报 failed。\n` +
    `状态上报必须等待命令成功，不要并行发送相互矛盾的状态；失败时不能声称已上报。\n` +
    `completed/failed/cancelled 是不可更改的终态。结案后用户继续聊天不属于这个委派任务，不再上报。\n` +
    `如果不确定原任务是否已结案，可查询：${query}\n` +
    `如果 report 返回 TERMINAL_STATE，原任务已结案；不要重置、重试其他状态或创建替代记录。\n`;
}

export function launchScript(plan: Pick<LaunchPlan, "sessionId" | "parent" | "cwd" | "name" | "model" | "thinking" | "nodePath" | "cliPath" | "piPath" | "childDirectory">): string {
  const query = shellCommand([
    plan.nodePath, plan.cliPath, "status", plan.sessionId,
    "--workspace", plan.parent.workspace, "--parent-session-id", plan.parent.parentSessionId, "--json",
  ]);
  const pi = shellCommand([
    plan.nodePath, plan.piPath,
    "--session-id", plan.sessionId, "--name", plan.name,
    "--model", plan.model, "--thinking", plan.thinking,
    "--append-system-prompt", join(plan.childDirectory, "protocol.md"),
    "--", `@${join(plan.childDirectory, "prompt.md")}`,
    "请执行随附任务文档中的委派任务，并按委派任务状态协议主动上报状态。",
  ]);
  return `#!/bin/sh\nset -eu\numask 077\n` +
    `if [ ! -t 0 ] || [ ! -t 1 ]; then\n  printf '%s\\n' 'Refusing non-TTY launch: delegated Pi must remain interactive.' >&2\n  exit 1\nfi\n` +
    `test -x ${shellQuote(plan.nodePath)}\ntest -r ${shellQuote(plan.piPath)}\ntest -d ${shellQuote(plan.cwd)}\n` +
    // A config can appear in Warp's menu before publication of the parent index.
    `${query} >/dev/null\n` +
    `if ! /bin/mkdir ${shellQuote(join(plan.childDirectory, ".launch-claimed"))}; then\n  printf '%s\\n' 'This delegation already claimed its one-time launch. Create a new task; do not reopen this Tab Config.' >&2\n  exit 1\nfi\n` +
    `export ${BINDING_PARENT}=${shellQuote(plan.parent.directory)}\n` +
    `export ${BINDING_SESSION}=${shellQuote(plan.sessionId)}\n` +
    // Never leak stale parent markers. Pi injects fresh values into its bash tool.
    `unset PI_SESSION_ID PI_SESSION_FILE PI_PROVIDER PI_MODEL PI_REASONING_LEVEL\n` +
    `export PATH=${shellQuote(dirname(plan.nodePath))}:"$PATH"\n` +
    `cd ${shellQuote(plan.cwd)}\nexec ${pi}\n`;
}

export function tabConfig(plan: Pick<LaunchPlan, "name" | "cwd" | "childDirectory">): string {
  const displayName = plan.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replaceAll("{{", "｛｛");
  // Warp expands {{params}} AFTER parsing TOML, including inside shell quotes.
  // Encode only the script path as data (not executable code); no eval is used.
  // Its fixed launch.sh suffix also avoids command substitution's trailing-LF removal.
  const encoded = Buffer.from(join(plan.childDirectory, "launch.sh"), "utf8").toString("base64");
  const command = `/bin/sh "$(/usr/bin/printf '%s' '${encoded}' | /usr/bin/base64 --decode)"`;
  // The script always cd's to the real target. Don't let Warp interpret a literal
  // {{...}} in a directory as a template or prompt for parameters.
  const directory = plan.cwd.includes("{{") ? "/" : plan.cwd;
  return `name = ${tomlString(displayName)}\ntitle = ${tomlString(displayName)}\n\n` +
    `[[panes]]\nid = "main"\ntype = "terminal"\nshell = "zsh"\n` +
    `directory = ${tomlString(directory)}\ncommands = [${tomlString(command)}]\n`;
}

export async function prepareLaunch(options: LaunchOptions, runtime: Runtime): Promise<LaunchPlan> {
  if (runtime.platform !== "darwin") throw new CliError("UNSUPPORTED_PLATFORM", "Launching is supported only on macOS with Warp Stable Tab Configs.");
  nonempty(options.name, "--name");
  const parent = await parentContext(runtime, options);
  const cwd = await existingDirectory(resolve(runtime.cwd, options.cwd), "--cwd");
  const promptPath = await realpath(resolve(runtime.cwd, nonempty(options.promptFile, "--prompt-file")));
  const prompt = await readRegularFile(promptPath);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(prompt); } catch {
    argumentError("--prompt-file must contain valid UTF-8 text.");
  }
  nonempty(text, "--prompt-file contents");
  const nodePath = await realpath(runtime.nodePath);
  const cliPath = await realpath(runtime.cliPath);
  await access(nodePath, constants.X_OK);
  await access(cliPath, constants.R_OK);
  const piPath = await resolvePi(runtime);
  let id = randomUUID();
  while (id === parent.parentSessionId) id = randomUUID();
  const childDirectory = join(parent.directory, id);
  const configName = `pi_delegate_${id.replaceAll("-", "_")}`;
  const plan: LaunchPlan = {
    sessionId: id, parent, cwd, name: options.name, model: options.model!, thinking: options.thinking!,
    nodePath, cliPath, piPath, childDirectory, prompt,
    tabConfigPath: join(dirname(parent.root), ".warp", "tab_configs", `${configName}.toml`),
    warpUri: `warp://tab_config/${configName}${options.newWindow ? "?new_window=true" : ""}`,
    protocol: "", script: "", tabConfig: "",
  };
  plan.protocol = protocol(plan);
  plan.script = launchScript(plan);
  plan.tabConfig = tabConfig(plan);
  return plan;
}

export async function launch(options: LaunchOptions, runtime: Runtime, store = new Store()): Promise<Record<string, unknown>> {
  const selection = modelSelection(runtime.env, options.model, options.thinking);
  if (selection) return selection;
  const plan = await prepareLaunch(options, runtime);
  if (options.dryRun) {
    return {
      action: "dry_run", persisted: false, plannedSessionId: plan.sessionId,
      parentDirectory: plan.parent.directory, childDirectory: plan.childDirectory,
      cwd: plan.cwd, name: plan.name, model: plan.model, thinking: plan.thinking,
      nodePath: plan.nodePath, piPath: plan.piPath,
      warpUri: plan.warpUri, tabConfigPath: plan.tabConfigPath,
      tabConfig: plan.tabConfig, launchScript: plan.script,
    };
  }
  let configPublished = false;
  try {
    await store.register(plan.parent, plan.sessionId, async (directory) => {
      await atomicWrite(join(directory, "prompt.md"), plan.prompt, true);
      await atomicWrite(join(directory, "protocol.md"), plan.protocol, true);
      await atomicWrite(join(directory, "launch.sh"), plan.script, true);
      const configDirectory = dirname(plan.tabConfigPath);
      await ensureDirectory(dirname(configDirectory));
      await ensureDirectory(configDirectory);
      await atomicWrite(plan.tabConfigPath, plan.tabConfig, true);
      configPublished = true;
    });
  } catch (error) {
    if (configPublished) await unlink(plan.tabConfigPath).catch((cleanupError: unknown) => {
      if (!hasCode(cleanupError, "ENOENT")) throw cleanupError;
    });
    throw error;
  }
  try {
    await runtime.openUri(plan.warpUri);
  } catch (error) {
    // open can race with a successfully started Pi. Never roll back its state or
    // remove files it may already be reading. Never retry automatically.
    throw new CliError("OPEN_FAILED", `Warp launch request failed or timed out: ${errorMessage(error)}. The task record is retained; inspect its state before taking any further action.`, 1, {
      sessionId: plan.sessionId, parentDirectory: plan.parent.directory,
    });
  }
  return { action: "launch_requested", sessionId: plan.sessionId };
}
