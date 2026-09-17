import { DateTime, RecordId, type Surreal } from "surrealdb";
import { type VaultAdapter, VaultPathError } from "../../adapters/vaultAdapter";
import type { GraphService } from "../../core/graph/graphService";
import { readNoteNeighbors } from "../../core/graph/noteNeighbors";
import { isCanonicalOrdinaryNotePath } from "../../core/vault/publicPath";
import { RpcError, type RpcRequestContext } from "../rpc";

export interface SentientHandlerDeps {
  db: Surreal;
  graph: Pick<GraphService, "path">;
  vault: Pick<VaultAdapter, "exists">;
}

export interface SwarmAgentStatus {
  readonly agent: string;
  readonly state: "running" | "ok" | "error" | "idle";
  readonly proposals: number;
  readonly finishedAt: number | null;
}

const SWARM_AGENTS = ["linker", "synthesizer", "contradictionHunter", "maturityAdvancer"] as const;

interface ActiveNoteRow {
  path: unknown;
  last_user_edit_at: unknown;
}

/**
 * The note the operator most recently edited, which is also the note the swarm
 * coordinator dispatches its agents against. Returns null on an empty or
 * never-edited vault.
 */
export async function readActiveNotePath(db: Surreal): Promise<string | null> {
  const result: unknown = await db
    .query(
      // SurrealDB requires the ORDER BY idiom to appear in the projection, so
      // `last_user_edit_at` is selected and integrity-checked with the path.
      "SELECT path, last_user_edit_at FROM note WHERE last_user_edit_at != NONE AND tombstoned_at = NONE ORDER BY last_user_edit_at DESC LIMIT 1;",
    )
    .collect();
  const rows = readSingleResultSlice(result, "active note");
  if (rows.length > 1) {
    throw new Error(`active note storage integrity: query returned ${rows.length} rows`);
  }
  const raw = rows[0];
  if (raw === undefined) return null;
  if (!isRecord(raw)) throw new Error("active note storage integrity: row is not an object");
  const row = raw as unknown as ActiveNoteRow;
  if (!(row.last_user_edit_at instanceof DateTime)) {
    throw new Error("active note storage integrity: edit time is not a native datetime");
  }
  const editedAt = row.last_user_edit_at.toDate().getTime();
  if (!Number.isSafeInteger(editedAt) || editedAt < 0) {
    throw new Error("active note storage integrity: edit time is invalid");
  }
  const notePath = parseNonBlankString(row.path, "active note path");
  if (!isCanonicalOrdinaryNotePath(notePath)) {
    throw new Error("active note storage integrity: path is private or invalid");
  }
  return notePath;
}

/**
 * Latest run per swarm agent. An agent with a started-but-unfinished row is
 * reported as `running`; one that has never run is `idle`.
 */
export async function readSwarmStatus(db: Surreal): Promise<SwarmAgentStatus[]> {
  const statuses: SwarmAgentStatus[] = [];
  for (const agent of SWARM_AGENTS) {
    const slices: unknown = await db
      .query(
        "SELECT agent, started_at, finished_at, ok, proposals_count FROM agent_run WHERE agent = $agent ORDER BY started_at DESC LIMIT 1;",
        { agent },
      )
      .collect();
    const rows = readSingleResultSlice(slices, `${agent} run`);
    if (rows.length > 1)
      throw new Error(`swarm storage integrity: ${agent} query returned two rows`);
    const row = rows[0];
    if (row === undefined) {
      statuses.push({ agent, state: "idle", proposals: 0, finishedAt: null });
      continue;
    }
    statuses.push(parseSwarmRun(row, agent));
  }
  return statuses;
}

function readSingleResultSlice(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
    throw new Error(`${label} storage integrity: invalid statement envelope`);
  }
  return raw[0];
}

function parseSwarmRun(
  raw: unknown,
  expectedAgent: (typeof SWARM_AGENTS)[number],
): SwarmAgentStatus {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`swarm storage integrity: ${expectedAgent} run is not an object`);
  }
  const row = raw as Record<string, unknown>;
  if (row.agent !== expectedAgent) {
    throw new Error(`swarm storage integrity: ${expectedAgent} query returned another agent`);
  }
  const proposals = row.proposals_count;
  if (typeof proposals !== "number" || !Number.isSafeInteger(proposals) || proposals < 0) {
    throw new Error(`swarm storage integrity: ${expectedAgent} proposal count is invalid`);
  }
  const startedAt = row.started_at;
  if (typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) || startedAt < 0) {
    throw new Error(`swarm storage integrity: ${expectedAgent} start time is invalid`);
  }
  if (row.finished_at === null || row.ok === null) {
    throw new Error(`swarm storage integrity: ${expectedAgent} row uses null instead of NONE`);
  }
  const hasFinished = row.finished_at !== undefined;
  if (!hasFinished) {
    if (row.ok !== undefined) {
      throw new Error(`swarm storage integrity: ${expectedAgent} running row has a final result`);
    }
    return { agent: expectedAgent, state: "running", proposals, finishedAt: null };
  }
  const finishedAt = row.finished_at;
  if (
    typeof finishedAt !== "number" ||
    !Number.isSafeInteger(finishedAt) ||
    finishedAt < startedAt ||
    typeof row.ok !== "boolean"
  ) {
    throw new Error(`swarm storage integrity: ${expectedAgent} finished row is incomplete`);
  }
  return {
    agent: expectedAgent,
    state: row.ok ? "ok" : "error",
    proposals,
    finishedAt,
  };
}

function parseNonBlankString(raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${label} must be a non-blank string`);
  }
  return raw;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

export function makeSentientHandlers(deps: SentientHandlerDeps) {
  return {
    neighbors: async ({ params, signal }: RpcRequestContext) => {
      const notePath = typeof params.notePath === "string" ? params.notePath : "";
      await assertAccessiblePublicNote(deps.vault, notePath);
      await assertIndexedNote(deps.db, notePath);
      const includePending = params.includePending === true;
      return {
        ok: true,
        notePath,
        neighbors: await readNoteNeighbors(deps.db, notePath, { includePending, signal }),
      };
    },
    findPath: async ({ params, signal }: RpcRequestContext) => {
      const result = await deps.graph.path(
        { from: params.fromNotePath, to: params.toNotePath, maxHops: params.maxHops },
        signal,
      );
      if (result.outcome === "incomplete")
        throw new RpcError(
          "LIMIT_EXCEEDED",
          "Graph search is incomplete; use graph.path for coverage details.",
        );
      return { ok: true, path: result.path.map((note) => note.path), hops: result.steps.length };
    },
    activeNote: async (_request: RpcRequestContext) => {
      const notePath = await readActiveNotePath(deps.db);
      const swarm = await readSwarmStatus(deps.db);
      if (notePath === null) return { ok: true, notePath: null, neighbors: [], swarm };
      return {
        ok: true,
        notePath,
        neighbors: await readNoteNeighbors(deps.db, notePath),
        swarm,
      };
    },
  };
}

async function assertAccessiblePublicNote(
  vault: Pick<VaultAdapter, "exists">,
  notePath: string,
): Promise<void> {
  if (!isCanonicalOrdinaryNotePath(notePath)) {
    throw new RpcError(
      "INVALID_PARAMS",
      "notePath must be an exact ordinary public vault-relative Markdown note path",
    );
  }
  let exists: boolean;
  try {
    exists = await vault.exists(notePath);
  } catch (error) {
    if (error instanceof VaultPathError) {
      throw new RpcError("INVALID_PARAMS", `note is not accessible: ${notePath}`);
    }
    throw error;
  }
  if (!exists) {
    throw new RpcError("INVALID_PARAMS", `note is not accessible: ${notePath}`);
  }
}

async function assertIndexedNote(db: Surreal, notePath: string): Promise<void> {
  const raw: unknown = await db
    .query("SELECT id, path FROM note WHERE path = $path AND tombstoned_at = NONE LIMIT 2;", {
      path: notePath,
    })
    .collect();
  const rows = readSingleResultSlice(raw, "neighbor note lookup");
  if (rows.length === 0) {
    throw new RpcError("INVALID_PARAMS", `note not indexed: ${notePath}`);
  }
  if (rows.length !== 1) {
    throw new Error("neighbor note storage integrity: path resolved more than one row");
  }
  const row = rows[0];
  if (
    !isRecord(row) ||
    Object.keys(row).length !== 2 ||
    !Object.hasOwn(row, "id") ||
    !Object.hasOwn(row, "path") ||
    !(row.id instanceof RecordId) ||
    row.id.table.name !== "note" ||
    row.path !== notePath
  ) {
    throw new Error("neighbor note storage integrity: lookup returned a malformed row");
  }
}
