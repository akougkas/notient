import type { RecordId, Surreal } from "surrealdb";

export interface DeletePendingProposalsInput {
  /** Edge tables the agent writes into. */
  readonly tables: ReadonlyArray<string>;
  /** Autonomous authority written to both `agent` and `source`. */
  readonly agent: string;
  /** When set, only edges touching this note are cleared. */
  readonly noteId?: RecordId<"note">;
}

/**
 * Drop an agent's still-unapproved edge proposals before it proposes again.
 *
 * Every swarm cycle re-runs the reasoning model over the same substrate, so
 * without this the proposal tables grow one duplicate row per cycle forever.
 * Approved edges are never touched, and edges proposed by a different agent
 * are left alone so agents cannot clobber each other's pending work.
 */
export async function deletePendingProposals(
  db: Surreal,
  input: DeletePendingProposalsInput,
): Promise<void> {
  const scoped = input.noteId !== undefined;
  for (const table of input.tables) {
    const clauses = [
      "approved = false",
      "source = $agent",
      "agent = $agent",
      ...(scoped ? ["(in = $note OR out = $note)"] : []),
    ];
    const bindings: Record<string, unknown> = { agent: input.agent };
    if (scoped) bindings.note = input.noteId;
    await db.query(`DELETE ${table} WHERE ${clauses.join(" AND ")};`, bindings).collect();
  }
}
