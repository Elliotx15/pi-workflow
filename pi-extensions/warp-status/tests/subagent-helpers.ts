import { setImmediate } from "node:timers/promises";
import type { EventBus } from "@earendil-works/pi-coding-agent";

interface Request {
  version: number;
  requestId: string;
  method: "ping" | "status";
}

/** A peer implementing only the documented, read-only pi-subagents RPC seam. */
export function subagentPeer(bus: EventBus) {
  const requests: Request[] = [];
  const pending: Request[] = [];
  const peer = {
    sessionId: "session-1",
    active: 0,
    capabilities: {
      fleetStatus: { version: 1 },
      statusProjection: { version: 1, untargeted: "in-memory-when-ready" },
    },
    statusMode: "reply" as "reply" | "error" | "silent" | "hold",
    requests, pending,
    snapshot: (): unknown => ({
      fleet: { version: 1, entries: [], totalActive: peer.active, omitted: peer.active },
      text: "PRIVATE_STATUS", details: { task: "PRIVATE_TASK" },
    }),
    info: () => ({ version: 1, session: { sessionId: peer.sessionId }, capabilities: peer.capabilities }),
    ready: () => bus.emit("subagents:rpc:v1:ready", peer.info()),
    hint: (name = "subagent:async-started") => bus.emit(name, { task: "PRIVATE_TASK" }),
    reply: (request: Request, data: unknown) => bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1, requestId: request.requestId, method: request.method, success: true, data,
    }),
    dispose: () => unsubscribe(),
  };
  const unsubscribe = bus.on("subagents:rpc:v1:request", (raw) => {
    const request = raw as Request;
    requests.push(request);
    if (request.method === "status") {
      if (peer.statusMode === "silent") return;
      if (peer.statusMode === "hold") { pending.push(request); return; }
      if (peer.statusMode === "error") {
        queueMicrotask(() => bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
          version: 1, requestId: request.requestId, success: false,
          error: { code: "execution_failed", message: "PRIVATE_ERROR" },
        }));
        return;
      }
    }
    // Like the real RPC bridge: capture first, reply after awaiting its handler.
    const data = request.method === "ping" ? peer.info() : peer.snapshot();
    queueMicrotask(() => peer.reply(request, data));
  });
  return peer;
}

export const flush = () => setImmediate();

/** Let RPC replies drain between timer ticks, as they would in the real loop. */
export async function advance(clock: { tick(ms: number): void }, ms: number): Promise<void> {
  while (ms > 0) {
    const step = Math.min(ms, 100);
    clock.tick(step);
    await flush();
    ms -= step;
  }
}
