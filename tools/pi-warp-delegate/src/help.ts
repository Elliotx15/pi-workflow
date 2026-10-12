const WORKFLOW = `WORKFLOW (for the main Pi)
  1. Prepare a self-contained UTF-8 task file. Do not copy the full session history.
  2. Choose a short name; the user's explicit name takes precedence.
  3. Model and thinking are USER choices. If already specified, use them directly.
     Otherwise show the actual current provider/model + thinking to the user.
     launch without either value returns action=needs_input and creates NOTHING.
     Ask in the main Pi conversation, not in an interactive CLI menu. Relaunch
     with both explicit values only after confirmation. Never silently choose.
  4. launch returns action=launch_requested and a NEW child sessionId. This is
     not proof Pi started or the task succeeded. Keep the sessionId / parent scope.
  5. Query status as needed. The main Pi decides whether to delegate another task.
     Each new task needs a new session. This tool does not schedule, poll, notify,
     feed existing TUIs, create worktrees, cancel processes, or verify results.

STATE CONTRACT
  launching     Registered launch; no accepted child report yet.
  in_progress   Child says the original task is being worked on.
  waiting_user  Child needs human input/approval (no question text is reported).
  blocked       Child cannot continue until an external condition changes.
  completed     Child explicitly declares completion, NOT independent acceptance.
  failed        Child explicitly abandons the task as unsuccessful; not a retry.
  cancelled     Child reports the user's explicit decision to abandon the task.
  The last three are immutable terminal states. Repeating the same state is
  idempotent. Active states can change to another active state or a terminal
  state. The first report may directly be terminal. launching cannot be reported.
  Escape, errors, replies ending, agent_settled, quitting, and timeouts NEVER
  determine a task state. Later conversation cannot overwrite a closed task.

PURE EXPLICIT REPORTING
  State is the LAST ACCEPTED REPORT, not live process health. A crash or missing
  report can leave launching/in_progress forever. There is no heartbeat, exit
  detection, Pi extension, custom model tool, daemon, or automatic retry.
  A caller's wait timeout is NOT proof that the child stopped.
  No results, report bodies, files, diagnostics or thinking are reported by Pi.

STORAGE
  $HOME/.pi-warp-delegate/<encoded-workspace-name>--<parent-session-id>/
    index.json                  Parent workspace and registered child IDs only.
    <child-session-id>/
      state.json                Sole authoritative task state: {"state":"..."}.
      prompt.md                 Independent copy of launch input, NOT a result.
      protocol.md / launch.sh    Generated startup instructions / script.
  The parent workspace, NOT the child's --cwd, determines the group.
  Names are safely encoded; index identity is checked to reject name collisions.
  Warp startup TOML is generated separately in ~/.warp/tab_configs/ as required
  by Warp's official URI interface. Do not delete files while they may be in use.
  Crashed writers may leave .index.lock or .state.lock directories. Operations
  fail after a bounded lock wait; locks are never stolen by age or PID. Remove
  such a lock manually ONLY after confirming no writer can still use it.

OUTPUT / ERRORS
  --json: exactly one JSON response on stdout; diagnostics go to stderr.
  Without --json, data is pretty-printed JSON and help is plain text.
  Exit 0: command succeeded, including needs_input, dry_run, terminal-task queries
          and idempotent reports. Inspect action; exit 0 does not mean launched.
  Exit 1: environment, storage, lookup, binding, state-transition or open error.
  Exit 2: invalid/missing arguments. Task state failed is not a CLI failure.
  An open failure retains the child record and returns its sessionId; never
  blindly retry. Read its state first. Status queries never mutate state.
`;

const LAUNCH = `LAUNCH
  pi-warp-delegate launch --cwd DIR --prompt-file FILE --name NAME
    [--workspace DIR] [--parent-session-id ID]
    [--model PROVIDER/MODEL] [--thinking LEVEL]
    [--new-window] [--dry-run] [--json]

  --workspace          Main workspace; defaults to this command's working dir.
                       If invoking from elsewhere, specify it explicitly.
  --parent-session-id  Defaults to the main Pi bash tool's PI_SESSION_ID. Required
                       explicitly in ordinary shells when that variable is absent.
  --cwd                Existing directory for the CHILD Pi; no worktree creation.
  --prompt-file        Nonempty UTF-8 text, at most 16 MiB. The original is untouched.
  --name               Explicit session name. Main Pi may propose it; user wins.
  --model              Explicit user-selected model; prefer provider/model-id.
  --thinking           off|minimal|low|medium|high|xhigh|max; Pi applies model limits.
  --new-window         New Warp window; otherwise a new tab in the active window.
  --dry-run            Read-only plan: no directories/files, open, Pi or model calls.
                       Missing model/thinking still returns needs_input.

  Requires macOS, Warp Stable with Tab Config URI support, and a Node-based pi
  executable on PATH (Pi 1.1.0 is the initial compatibility target). Pi is not run
  during preflight. The resolved Node/Pi entries are used explicitly in Warp;
  no shell aliases or shim scripts. No key or temporary credential is copied.
  New Pi uses its ordinary credentials and project trust; no --approve override.
  The generated TTY-only script claims its launch once, then execs ordinary Pi.
  Do not reopen the saved Tab Config or retry a launch to resume an existing task.

  Example:
    pi-warp-delegate launch --workspace /projects/app --cwd /worktrees/app-fix \\
      --prompt-file /tmp/task.md --name '修复登录' \\
      --model provider/model-id --thinking high --json
`;

const STATUS = `STATUS
  pi-warp-delegate status CHILD_SESSION_ID
    [--workspace MAIN_DIR] [--parent-session-id MAIN_ID] [--json]

  Scope defaults match launch: command working directory and PI_SESSION_ID.
  When querying from another directory/session or a normal shell, provide scope.
  Returns only {"sessionId":"...","state":"..."}. Missing/corrupt records are
  query errors, never invented failed/unknown task states. Read-only: no locks,
  writes, process checks or implicit repair. Parent index lists the child IDs.
`;

const REPORT = `REPORT (delegated child Pi only)
  pi-warp-delegate report --state STATE [--json]

  STATE: in_progress|waiting_user|blocked|completed|failed|cancelled
  No body, reason, file, result or target-session parameter is accepted.
  Run with the EXISTING Pi bash tool; no new model tool is needed.
  The generated protocol contains an absolute Node + CLI command, so PATH setup
  is unnecessary. Launch supplies PI_WARP_DELEGATE_PARENT_DIR and
  PI_WARP_DELEGATE_SESSION_ID (custom variables). Pi supplies the current
  PI_SESSION_ID to its model-callable bash tool. All must match a registered child.
  Ordinary shells and Pi !/!! commands do not automatically get PI_SESSION_ID.
  /new, /fork or switching to another session cannot write the old task.
  Binding checks prevent accidental cross-writes, not attacks by the same OS user.

  Examples inside the delegated Pi's bash tool:
    pi-warp-delegate report --state in_progress --json
    pi-warp-delegate report --state waiting_user --json
    pi-warp-delegate report --state completed --json
`;

export function help(command?: string): string {
  const introduction = `pi-warp-delegate — Warp 专用的独立 Pi 交互会话任务委派与状态查询\n\n`;
  const usage = `USAGE\n  pi-warp-delegate <launch|status|report> [options]\n  pi-warp-delegate [--help | --version]\n\n`;
  if (command === "launch") return introduction + LAUNCH + "\n" + WORKFLOW;
  if (command === "status") return introduction + STATUS + "\n" + WORKFLOW;
  if (command === "report") return introduction + REPORT + "\n" + WORKFLOW;
  return introduction + usage + WORKFLOW + "\n" + LAUNCH + "\n" + STATUS + "\n" + REPORT;
}
