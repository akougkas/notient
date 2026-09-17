/**
 * Daemon RPC bridge for the MCP adapter.
 *
 * The MCP server is a thin translation layer: every tool call becomes one
 * daemon RPC over the same unix socket the CLI verbs use. This module owns
 * the two behaviours the adapter needs on top of `ClientHandle`:
 *
 *   1. Frame draining. `ClientHandle.call` yields `ack`, zero or more
 *      `event` frames, then exactly one `result` or `error`. `callRpc`
 *      collects the events and folds the terminal frame into a discriminated
 *      `RpcOutcome`, so tool handlers never see a raw frame stream and never
 *      throw on a handler-level failure.
 *   2. Single reconnect. When the daemon dies mid-session the client rejects
 *      with a `DAEMON_DISCONNECTED:` message. `createReconnectingCaller`
 *      re-dials once through the supplied factory and replays the call, but
 *      only for read-kind methods listed in `REPLAYABLE_METHODS`. A write may
 *      already have been applied by the daemon that died, so replaying it
 *      would duplicate the write or park a second approval. A second failure,
 *      or any failure on a non-replayable method, surfaces as a
 *      `DAEMON_DISCONNECTED` outcome rather than crashing the stdio server.
 *      The connect promise is memoized so concurrent first calls share one
 *      `ClientHandle` instead of leaking one of two.
 */

import { type ClientHandle, DISCONNECT_PREFIX, type RpcResponseFrame } from "../client";

export interface RpcSuccess {
  ok: true;
  /** Terminal `result` frame with the transport envelope keys stripped. */
  result: Record<string, unknown>;
  /** Every `event` frame observed before the terminal frame, in order. */
  events: RpcResponseFrame[];
}

export interface RpcFailure {
  ok: false;
  code: string;
  message: string;
}

export type RpcOutcome = RpcSuccess | RpcFailure;

export interface RpcCaller {
  call(method: string, params: Record<string, unknown>): Promise<RpcOutcome>;
  close(): Promise<void>;
}

/** Drops the transport envelope keys so tool payloads carry only handler data. */
function stripEnvelope(frame: RpcResponseFrame): Record<string, unknown> {
  const { id: _id, type: _type, ...rest } = frame;
  return rest;
}

export async function callRpc(
  handle: ClientHandle,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcOutcome> {
  const events: RpcResponseFrame[] = [];
  for await (const frame of handle.call(method, params)) {
    if (frame.type === "event") {
      events.push(frame);
      continue;
    }
    if (frame.type === "result") {
      return { ok: true, result: stripEnvelope(frame), events };
    }
    if (frame.type === "error") {
      return {
        ok: false,
        code: typeof frame.code === "string" ? frame.code : "INTERNAL",
        message: typeof frame.message === "string" ? frame.message : `${method} failed`,
      };
    }
  }
  return {
    ok: false,
    code: "INTERNAL",
    message: `${method} returned no terminal frame`,
  };
}

export function isDisconnect(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(DISCONNECT_PREFIX);
}

/**
 * Methods the bridge may safely re-send after a mid-call daemon death.
 *
 * A disconnect is ambiguous. The daemon may have died before the handler ran
 * or after it ran but before the result frame reached us. Replaying is only
 * safe when a second execution has no observable effect beyond the first, so
 * this allowlist contains only local database/configuration reads. A nominal
 * read that contacts a model or health endpoint is deliberately absent: an
 * ambiguous replay can duplicate billing and retransmit private note/query
 * material even though it does not mutate Notient's own database.
 * Every write or admin method (`notes.write`, `proposals.propose_link`,
 * `chat.*`, `agent.distill`, `awaken.*`, `reindex.*`,
 * `links.approve`, `session.grant`, …) is absent on purpose and surfaces
 * `DAEMON_DISCONNECTED` to the caller instead.
 */
const REPLAYABLE_METHODS: ReadonlySet<string> = new Set([
  "agent.events",
  "host.status",
  "host.context",
  "jobs.list",
  "jobs.get",
  "pipelines.list",
  "daemon.config_get",
  "graph.find_path",
  "history.list",
  "history.get",
  "notes.read",
  "links.proposals",
  "proposals.list",
  "proposals.get",
  "changes.get",
  "session.list",
  "vault.active_note",
  "vault.extraction",
  "vault.list",
  "vault.neighbors",
  "vault.stats",
  "vitals.get",
]);

/** True when a mid-call disconnect may be retried without duplicating an effect. */
export function isReplayable(method: string): boolean {
  return REPLAYABLE_METHODS.has(method);
}

/**
 * Wraps a connection factory in a caller that survives exactly one daemon
 * death per call for read-kind methods. The factory auto-spawns the daemon, so
 * the retry also covers "the daemon was restarted between two tool calls".
 * Non-replayable methods fail closed on the first disconnect.
 */
export function createReconnectingCaller(connect: () => Promise<ClientHandle>): RpcCaller {
  let handle: ClientHandle | null = null;
  let connecting: Promise<ClientHandle> | null = null;
  const retired = new WeakSet<ClientHandle>();

  async function current(): Promise<ClientHandle> {
    if (handle !== null) return handle;
    if (connecting === null) {
      connecting = connect()
        .then((open) => {
          handle = open;
          return open;
        })
        .finally(() => {
          connecting = null;
        });
    }
    return await connecting;
  }

  function disconnected(error: unknown): RpcFailure {
    return {
      ok: false,
      code: "DAEMON_DISCONNECTED",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  async function retire(used: ClientHandle | null): Promise<void> {
    if (used === null) return;
    if (handle === used) handle = null;
    if (retired.has(used)) return;
    retired.add(used);
    await used.close().catch(() => {});
  }

  return {
    async call(method, params) {
      let used: ClientHandle | null = null;
      try {
        used = await current();
        return await callRpc(used, method, params);
      } catch (error) {
        if (!isDisconnect(error)) throw error;
        await retire(used);
        if (!isReplayable(method)) return disconnected(error);
      }
      used = null;
      try {
        used = await current();
        return await callRpc(used, method, params);
      } catch (error) {
        if (!isDisconnect(error)) throw error;
        await retire(used);
        return disconnected(error);
      }
    },
    async close() {
      const open = handle;
      handle = null;
      if (open !== null) await open.close();
    },
  };
}
