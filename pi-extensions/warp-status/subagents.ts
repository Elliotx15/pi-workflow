import { randomUUID } from "node:crypto";
import type { EventBus } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_POLL_MS = 2_000;
export const SUBAGENT_RPC_TIMEOUT_MS = 1_000;
export const SUBAGENT_IDLE_GRACE_MS = 1_500;
export const SUBAGENT_MAX_FAILURES = 3;

const REQUEST = "subagents:rpc:v1:request";
const READY = "subagents:rpc:v1:ready";
const REPLY = "subagents:rpc:v1:reply:";
const HINTS = [
  "subagent:async-started", "subagent:async-complete",
  "subagent:foreground-complete", "subagent:child-status",
];

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export interface SubagentMonitor {
  /** No waiting or periodic queries when a compatible owner has not been found. */
  refresh(): Promise<void> | undefined;
  dispose(): void;
}

/**
 * Optional, read-only pi-subagents RPC integration. No package imports, file
 * discovery, tool calls, or assumptions about the number/order of child events.
 * undefined means disconnected, not successful completion.
 * Create only from session_start, and dispose with that session.
 */
export function monitorSubagents(
  events: EventBus,
  sessionId: string,
  onChange: (active: boolean | undefined) => void,
): SubagentMonitor {
  let disposed = false;
  let connected = false;
  let generation = 0;
  let failures = 0;
  let published: boolean | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleReady = false;
  let refreshing: Promise<void> | undefined;
  let probing = false;
  let dirty = false;
  const pending = new Set<() => void>();

  function request(method: "ping" | "status"): Promise<unknown> {
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const cancel = () => finish(undefined);
      const unsubscribe = events.on(`${REPLY}${requestId}`, (raw) => {
        const reply = record(raw);
        if (reply?.version !== 1 || reply.requestId !== requestId
          || (reply.method !== undefined && reply.method !== method)) return;
        finish(reply.success === true ? reply.data : undefined);
      });
      const timer = setTimeout(cancel, SUBAGENT_RPC_TIMEOUT_MS);
      timer.unref();
      function finish(data: unknown): void {
        clearTimeout(timer);
        unsubscribe();
        pending.delete(cancel);
        resolve(data);
      }
      pending.add(cancel);
      try {
        events.emit(REQUEST, { version: 1, requestId, method, source: { extension: "pi-warp-status" } });
      } catch {
        cancel();
      }
    });
  }

  function clearIdle(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    idleReady = false;
  }

  function publish(active: boolean | undefined): void {
    if (published === active) return;
    published = active;
    onChange(active);
  }

  function disconnect(): void {
    generation++;
    connected = false;
    dirty = false;
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
    clearIdle();
    for (const cancel of pending) cancel();
    publish(undefined);
  }

  function applySnapshot(active: boolean): void {
    if (active || published !== true || idleReady) {
      clearIdle();
      publish(active);
    } else if (idleTimer === undefined) {
      // Completion notifications normally batch for up to 1s before waking the
      // parent. Keep working through that handoff, then confirm zero again.
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        idleReady = true;
        void refresh();
      }, SUBAGENT_IDLE_GRACE_MS);
      idleTimer.unref();
    }
  }

  function refresh(): Promise<void> | undefined {
    if (disposed || !connected) return undefined;
    dirty = true;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      while (dirty && connected && !disposed) {
        dirty = false;
        const epoch = generation;
        const data = record(await request("status"));
        if (disposed || epoch !== generation) return;
        // A hint arriving during a query may describe newer work than its reply.
        if (dirty) continue;
        const fleet = record(data?.fleet);
        const count = fleet?.totalActive;
        if (fleet?.version !== 1 || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
          clearIdle();
          if (++failures >= SUBAGENT_MAX_FAILURES) disconnect();
          continue;
        }
        failures = 0;
        applySnapshot(count > 0);
      }
    })().finally(() => {
      refreshing = undefined;
      if (dirty && connected && !disposed) void refresh();
    });
    return refreshing;
  }

  function acceptReady(raw: unknown): void {
    if (disposed) return;
    const data = record(raw);
    if (data?.version !== 1) return;
    const owner = record(data.session)?.sessionId;
    if (typeof owner !== "string") return;
    const capabilities = record(data.capabilities);
    if (owner !== sessionId || record(capabilities?.fleetStatus)?.version !== 1
      || record(capabilities?.statusProjection)?.version !== 1
      || record(capabilities?.statusProjection)?.untargeted !== "in-memory-when-ready") {
      if (connected) disconnect();
      return;
    }
    if (!connected) {
      generation++;
      connected = true;
      failures = 0;
      poll = setInterval(() => { void refresh(); }, SUBAGENT_POLL_MS);
      poll.unref();
    }
    void refresh();
  }

  async function probe(): Promise<void> {
    if (disposed || connected || probing) return;
    probing = true;
    const epoch = generation;
    try {
      const data = await request("ping");
      if (!disposed && epoch === generation) acceptReady(data);
    } finally {
      probing = false;
    }
  }

  const unsubscribes = [events.on(READY, acceptReady), ...HINTS.map((name) => events.on(name, () => {
    // Event payloads are neither authoritative counts nor consistently scoped.
    // Let the owner update its projection first, regardless of load order.
    clearIdle();
    if (connected) dirty = true;
    queueMicrotask(() => {
      if (connected) void refresh();
      else void probe();
    });
  }))];
  void probe();

  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      // Disposal is not a completion or disconnect notification.
      published = undefined;
      disconnect();
    },
  };
}
