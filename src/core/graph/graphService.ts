import { DateTime, type Surreal } from "surrealdb";
import {
  type VaultAdapter,
  VaultPathError,
  VaultReadLimitError,
} from "../../adapters/vaultAdapter";
import {
  type Connection,
  type GraphNeighbors,
  type GraphPath,
  graphNeighborsSchema,
  graphPathSchema,
} from "../../api/graph";
import {
  type IndexingReadiness,
  searchCoverage,
  unknownIndexingReadiness,
} from "../../api/indexing";
import { contentRevision } from "../../api/notes";
import { operationInputs } from "../../api/operations";
import { proposalProvenanceSchema } from "../../api/proposals";
import { NoteApiError, type NoteReference, revisionSchema } from "../../api/schema";
import { isWritebackEdgeTable } from "../db/edgeTables";
import { STRUCTURAL_INDEX_VERSION } from "../markdown/types";
import { type StoredNoteNeighbor, readNoteNeighborPage } from "./noteNeighbors";

interface GraphDeps {
  db: Surreal;
  vault: Pick<VaultAdapter, "readBounded">;
  indexing?: () => IndexingReadiness;
  isExcluded?: (path: string) => boolean;
}
interface ReadNote {
  note: NoteReference;
  body: string;
  indexed: boolean;
}
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_NOTE_BYTES = 1024 * 1024;
const MAX_VISITED = 256;

/** Bounded, revision-checked graph access shared by operators and agents. */
export class GraphService {
  constructor(private readonly deps: GraphDeps) {}

  async neighbors(input: unknown, signal?: AbortSignal): Promise<GraphNeighbors> {
    const args = parseInput("graph.neighbors", input);
    const run = new GraphRead(this.deps, signal);
    const source = await run.read(args.path);
    if (!source)
      throw new NoteApiError(
        run.limited ? "LIMIT_EXCEEDED" : "NOT_FOUND",
        run.limited ? "source note exceeds the graph read budget" : "source note is unavailable",
      );
    const page = await run.connections(source, args.includeProposed, args.limit);
    await run.verify();
    return graphNeighborsSchema.parse({
      ok: true,
      note: source.note,
      connections: page.connections,
      coverage: run.coverage(),
      omitted: run.omitted,
      truncated: page.truncated || run.limited,
    });
  }

  async path(input: unknown, signal?: AbortSignal): Promise<GraphPath> {
    const args = parseInput("graph.path", input);
    const run = new GraphRead(this.deps, signal);
    const from = await run.read(args.from);
    const to = await run.read(args.to);
    if (!from || !to)
      throw new NoteApiError(
        run.limited ? "LIMIT_EXCEEDED" : "NOT_FOUND",
        run.limited
          ? "a path endpoint exceeds the graph read budget"
          : "a path endpoint is unavailable",
      );
    const parents = new Map<string, { from: string; edge: Connection }>();
    const visited = new Set([args.from]);
    const queue = [{ note: from, depth: 0 }];
    let found = args.from === args.to;
    let truncated = false;
    for (let cursor = 0; cursor < queue.length && !found; cursor++) {
      run.check();
      const next = queue[cursor];
      if (next.depth >= args.maxHops) continue;
      const page = await run.connections(next.note, false, 200);
      truncated ||= page.truncated;
      for (const edge of page.connections) {
        if (visited.has(edge.note.path)) continue;
        if (visited.size >= MAX_VISITED) {
          truncated = true;
          break;
        }
        visited.add(edge.note.path);
        parents.set(edge.note.path, { from: next.note.note.path, edge });
        if (edge.note.path === args.to) {
          found = true;
          break;
        }
        const note = await run.read(edge.note.path);
        if (note) queue.push({ note, depth: next.depth + 1 });
      }
      if (visited.size >= MAX_VISITED) break;
    }
    await run.verify();
    const steps: Connection[] = [];
    const path: NoteReference[] = found ? [to.note] : [];
    if (found) {
      let cursor = args.to;
      while (cursor !== args.from) {
        const parent = parents.get(cursor);
        if (!parent) throw new Error("graph path parent invariant failed");
        steps.unshift(parent.edge);
        const source = await run.read(parent.from);
        if (!source) throw new NoteApiError("CONFLICT", "path source changed");
        path.unshift(source.note);
        cursor = parent.from;
      }
    }
    const coverage = run.coverage();
    // A bounded search may return a valid route without proving it is the shortest.
    return graphPathSchema.parse({
      ok: true,
      from: args.from,
      to: args.to,
      path,
      steps,
      outcome: found
        ? "found"
        : truncated || run.limited || run.omitted || coverage.state !== "current"
          ? "incomplete"
          : "not-found",
      coverage,
      visited: visited.size,
    });
  }
}
function parseInput<K extends "graph.neighbors" | "graph.path">(method: K, input: unknown) {
  const result = operationInputs[method].safeParse(input);
  if (!result.success) throw new NoteApiError("INVALID_PARAMS", result.error.message);
  return result.data as K extends "graph.neighbors"
    ? { path: string; includeProposed: boolean; limit: number }
    : { from: string; to: string; maxHops: number };
}

class GraphRead {
  private readonly before: IndexingReadiness;
  private readonly signal: AbortSignal;
  private readonly notes = new Map<string, ReadNote | null>();
  private bytes = 0;
  omitted = 0;
  limited = false;
  constructor(
    private readonly deps: GraphDeps,
    signal?: AbortSignal,
  ) {
    this.before = deps.indexing?.() ?? unknownIndexingReadiness();
    this.signal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000);
  }
  check(): void {
    if (this.signal.aborted)
      throw new NoteApiError("CANCELLED", "graph read cancelled or timed out");
  }
  coverage() {
    const result = searchCoverage(
      this.before,
      this.deps.indexing?.() ?? unknownIndexingReadiness(),
    );
    if (this.omitted || this.limited)
      return {
        ...result,
        state: "incomplete" as const,
        message:
          "Some connections could not be verified against current files or exceeded read limits. Results are incomplete.",
      };
    return result.state === "current"
      ? result
      : {
          ...result,
          message:
            result.indexing.state === "current"
              ? "Connections changed while this view was loading. Refresh to check the current links."
              : result.indexing.state === "unknown"
                ? "Connection indexing status is unavailable; displayed connections may be incomplete."
                : `Connection indexing ${result.indexing.state} · ${result.indexing.current}/${result.indexing.total ?? "?"} notes current. Displayed connections may be incomplete.`,
        };
  }
  async read(path: string): Promise<ReadNote | null> {
    this.check();
    if (this.notes.has(path)) return this.notes.get(path) ?? null;
    if (this.deps.isExcluded?.(path)) return null;
    if (this.notes.size >= MAX_VISITED) {
      this.limited = true;
      return null;
    }
    const body = await this.readBody(path);
    if (body === null) {
      this.notes.set(path, null);
      return null;
    }
    const result: unknown = await this.deps.db
      .query(
        "SELECT sha, tier1_at, structural_version FROM note WHERE path = $path AND tombstoned_at IS NONE LIMIT 2 TIMEOUT 2s;",
        { path },
      )
      .collect();
    if (
      !Array.isArray(result) ||
      result.length !== 1 ||
      !Array.isArray(result[0]) ||
      result[0].length > 1
    )
      throw new Error("graph storage integrity: invalid source revision envelope");
    const row = result[0][0];
    if (
      row !== undefined &&
      (typeof row !== "object" || row === null || !revisionSchema.safeParse(row.sha).success)
    )
      throw new Error("graph storage integrity: invalid indexed revision");
    const revision = contentRevision(body);
    const note = {
      note: { path, revision },
      body,
      indexed:
        row?.sha === revision &&
        row?.tier1_at instanceof DateTime &&
        row?.structural_version === STRUCTURAL_INDEX_VERSION,
    };
    this.notes.set(path, note);
    this.check();
    return note;
  }
  private async readBody(path: string, verifying = false): Promise<string | null> {
    this.check();
    const ceiling = verifying ? MAX_BYTES : MAX_BYTES / 2;
    if (this.bytes >= ceiling) {
      this.limited = true;
      return null;
    }
    try {
      const body = await this.deps.vault.readBounded(
        path,
        Math.min(MAX_NOTE_BYTES, ceiling - this.bytes),
      );
      this.bytes += Buffer.byteLength(body);
      this.check();
      return body;
    } catch (error) {
      if (error instanceof VaultReadLimitError) {
        this.limited = true;
        return null;
      }
      if (error instanceof VaultPathError || (error as NodeJS.ErrnoException).code === "ENOENT")
        return null;
      throw error;
    }
  }
  async connections(source: ReadNote, proposed: boolean, limit: number) {
    if (!source.indexed) {
      this.omitted++;
      return { connections: [], truncated: false };
    }
    const page = await readNoteNeighborPage(this.deps.db, source.note.path, {
      includePending: proposed,
      limit,
      signal: this.signal,
    });
    const connections: Connection[] = [];
    for (const row of page.neighbors) {
      this.check();
      const target = await this.read(row.notePath);
      if (!target?.indexed) {
        this.omitted++;
        continue;
      }
      connections.push(await this.connection(row, target));
    }
    return { connections, truncated: page.truncated };
  }
  private async connection(row: StoredNoteNeighbor, target: ReadNote): Promise<Connection> {
    const semantic = isWritebackEdgeTable(row.table);
    const result: Connection = {
      id: row.id,
      note: target.note,
      relation: row.table,
      direction: row.direction,
      state: row.proposed ? "proposed" : semantic ? "approved" : "authored",
      assessment: semantic ? row.confidence : null,
      author: row.agent,
      rationale: null,
      evidence: [],
      evidenceState: "unavailable",
    };
    if (row.provenance === null) return result;
    let raw: unknown;
    try {
      raw = JSON.parse(row.provenance);
    } catch {
      throw new Error("graph storage integrity: invalid provenance JSON");
    }
    const parsed = proposalProvenanceSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error("graph storage integrity: invalid relationship provenance");
    result.rationale = parsed.data.rationale;
    let current = true;
    let available = true;
    for (const ref of parsed.data.sources) {
      const note = await this.read(ref.path);
      if (!note) available = false;
      else if (note.note.revision !== ref.revision) current = false;
    }
    for (const evidence of parsed.data.evidence) {
      const note = await this.read(evidence.path);
      if (!note) {
        available = false;
        continue;
      }
      if (
        note.note.revision !== evidence.revision ||
        note.body.slice(evidence.range.start, evidence.range.end) !== evidence.quote
      )
        current = false;
    }
    result.evidenceState = !current ? "stale" : available ? "current" : "unavailable";
    if (current && available) result.evidence = parsed.data.evidence.slice(0, 20);
    return result;
  }
  async verify(): Promise<void> {
    // Read again after graph traversal; a concurrent edit must not publish a stale route.
    for (const [path, note] of this.notes) {
      if (!note) continue;
      const body = await this.readBody(path, true);
      if (body === null)
        throw new NoteApiError(
          "LIMIT_EXCEEDED",
          "graph verification exceeded its read budget or a source disappeared; use a smaller query",
        );
      if (contentRevision(body) !== note.note.revision)
        throw new NoteApiError(
          "CONFLICT",
          "a graph source changed during this read; refresh connections",
        );
    }
    this.check();
  }
}
