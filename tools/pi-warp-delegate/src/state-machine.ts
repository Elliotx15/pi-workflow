import { argumentError, CliError } from "./errors.js";

export const REPORT_STATES = [
  "in_progress", "waiting_user", "blocked", "completed", "failed", "cancelled",
] as const;
export type ReportState = typeof REPORT_STATES[number];
export type TaskState = "launching" | ReportState;
export const TASK_STATES: readonly TaskState[] = ["launching", ...REPORT_STATES];
const TERMINAL_STATES: readonly TaskState[] = ["completed", "failed", "cancelled"];

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && TASK_STATES.includes(value as TaskState);
}

export function parseReportState(value: string): ReportState {
  if (!REPORT_STATES.includes(value as ReportState)) {
    argumentError(`--state must be one of: ${REPORT_STATES.join(", ")}. launching is initialization-only.`);
  }
  return value as ReportState;
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Explicit reports, not session lifecycle events, drive every post-initialization transition. */
export function transition(current: TaskState, requested: ReportState): TaskState {
  if (current === requested) return current;
  if (isTerminal(current)) {
    throw new CliError("TERMINAL_STATE", `Task is already ${current}; its state cannot change.`, 1, {
      currentState: current, requestedState: requested,
    });
  }
  // launching means "not yet reported", not proof the task has not executed.
  // Short tasks may report a terminal state without inventing an intermediate report.
  return requested;
}
