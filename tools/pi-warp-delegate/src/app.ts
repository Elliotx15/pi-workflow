import { parseArgs } from "node:util";
import type { ParseArgsOptionDescriptor } from "node:util";
import { nonempty, parentContext, reportBinding, sessionId } from "./context.js";
import { argumentError, CliError, errorMessage } from "./errors.js";
import { help } from "./help.js";
import { defaultRuntime, launch } from "./launch.js";
import type { Runtime } from "./launch.js";
import { parseReportState } from "./state-machine.js";
import { Store } from "./storage.js";

export interface CliResponse { exitCode: number; stdout: string; stderr: string }
const COMMON: Record<string, ParseArgsOptionDescriptor> = {
  help: { type: "boolean", short: "h" }, json: { type: "boolean" },
};
const SCOPE: Record<string, ParseArgsOptionDescriptor> = {
  workspace: { type: "string" }, "parent-session-id": { type: "string" },
};
const OPTIONS: Record<string, Record<string, ParseArgsOptionDescriptor>> = {
  launch: {
    ...COMMON, ...SCOPE, cwd: { type: "string" }, "prompt-file": { type: "string" },
    name: { type: "string" }, model: { type: "string" }, thinking: { type: "string" },
    "new-window": { type: "boolean" }, "dry-run": { type: "boolean" },
  },
  status: { ...COMMON, ...SCOPE },
  report: { ...COMMON, state: { type: "string" } },
};

export async function runCli(argv: string[], runtime?: Runtime): Promise<CliResponse> {
  const jsonMode = argv.includes("--json");
  const success = (data: unknown): CliResponse => ({
    exitCode: 0, stdout: `${JSON.stringify(data, null, jsonMode ? undefined : 2)}\n`, stderr: "",
  });
  const showHelp = (command?: string): CliResponse => jsonMode ? success({ help: help(command) }) :
    { exitCode: 0, stdout: help(command), stderr: "" };
  try {
    const command = argv[0];
    if (!command || command === "--help" || command === "-h") return showHelp();
    if (command === "--version") return success({ name: "pi-warp-delegate", version: "0.1.0" });
    const options = OPTIONS[command];
    if (!options) argumentError(`Unknown command ${JSON.stringify(command)}. Use launch, status or report; see --help.`);
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({ args: argv.slice(1), options, strict: true, allowPositionals: true, tokens: true });
    } catch (error) {
      argumentError(errorMessage(error));
    }
    const seen = new Set<string>();
    for (const token of parsed.tokens ?? []) {
      if (token.kind !== "option") continue;
      if (seen.has(token.name)) argumentError(`Duplicate option --${token.name}.`);
      seen.add(token.name);
    }
    if (parsed.values.help) return showHelp(command);
    runtime ??= defaultRuntime();
    const string = (name: string): string | undefined => {
      const value = parsed.values[name];
      return typeof value === "string" ? nonempty(value, `--${name}`) : undefined;
    };
    const required = (name: string): string => string(name) ?? argumentError(`Missing --${name}; see ${command} --help.`);
    const scope = () => ({ workspace: string("workspace"), parentSessionId: string("parent-session-id") });
    if (command === "status") {
      if (parsed.positionals.length !== 1) argumentError("status requires exactly one child session ID.");
      const id = sessionId(parsed.positionals[0]!, "child session ID");
      return success(await new Store().status(await parentContext(runtime, scope()), id));
    }
    if (parsed.positionals.length) argumentError(`${command} does not accept positional arguments.`);
    if (command === "report") {
      const state = parseReportState(required("state"));
      const binding = await reportBinding(runtime);
      return success(await new Store().report(binding.root, binding.directory, binding.sessionId, state));
    }
    return success(await launch({
      ...scope(), cwd: required("cwd"), promptFile: required("prompt-file"), name: required("name"),
      model: string("model"), thinking: string("thinking"),
      newWindow: parsed.values["new-window"] === true, dryRun: parsed.values["dry-run"] === true,
    }, runtime));
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError("IO_ERROR", errorMessage(error));
    return {
      exitCode: failure.exitCode,
      stdout: jsonMode ? `${JSON.stringify({ error: { code: failure.code, message: failure.message, ...failure.details } })}\n` : "",
      stderr: `${failure.code}: ${failure.message}\n`,
    };
  }
}
