import { DateTime, type Surreal } from "surrealdb";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import { sha256Hex } from "../utils/sha256";

interface RestoredNoteIdentity {
  path: string;
  sha: string;
  tier1_at: DateTime;
  tier2_at: DateTime;
  tier3_at: DateTime;
  tombstoned_at?: DateTime;
  linker_refresh_pending: boolean;
}

export interface ReconcileRestoredNotesResult {
  notes: number;
}

export class RestoreSnapshotMismatchError extends Error {
  constructor(message: string) {
    super(`restore snapshot mismatch: ${message}`);
    this.name = "RestoreSnapshotMismatchError";
  }
}

/**
 * Fail closed unless restored note identities exactly match the Markdown
 * currently inside the public vault boundary.
 *
 * A graph dump is not a Markdown backup. Importing it over a different file
 * snapshot would let retrieval serve chunks for deleted or edited content,
 * especially because the already-running watcher used `ignoreInitial` at
 * bootstrap. Exact set and SHA equality is therefore a restore invariant,
 * checked both before intent replay and again before success is reported.
 */
export async function reconcileRestoredNotes(
  db: Surreal,
  vault: Pick<VaultAdapter, "listMarkdown" | "read">,
): Promise<ReconcileRestoredNotesResult> {
  const restored = await readRestoredNoteIdentities(db);
  const listed = await vault.listMarkdown();
  const paths = listed.map((entry) => entry.path).sort((left, right) => left.localeCompare(right));
  const duplicatePath = paths.find((path, index) => index > 0 && paths[index - 1] === path);
  if (duplicatePath !== undefined) {
    throw new RestoreSnapshotMismatchError(`vault listing repeated '${duplicatePath}'`);
  }

  const restoredPaths = [...restored.keys()].sort((left, right) => left.localeCompare(right));
  const missingFromVault = restoredPaths.filter((path) => !paths.includes(path));
  const missingFromBackup = paths.filter((path) => !restored.has(path));
  if (missingFromVault.length > 0 || missingFromBackup.length > 0) {
    throw new RestoreSnapshotMismatchError(
      formatSetDifference(missingFromVault, missingFromBackup),
    );
  }

  const changed: string[] = [];
  for (const path of paths) {
    const expectedSha = restored.get(path);
    if (expectedSha === undefined) {
      throw new RestoreSnapshotMismatchError(`backup identity disappeared for '${path}'`);
    }
    const body = await vault.read(path);
    if ((await sha256Hex(body)) !== expectedSha) changed.push(path);
  }
  if (changed.length > 0) {
    throw new RestoreSnapshotMismatchError(`Markdown SHA differs for ${formatPaths(changed)}`);
  }
  return { notes: paths.length };
}

async function readRestoredNoteIdentities(db: Surreal): Promise<Map<string, string>> {
  const result: unknown = await db
    .query(
      "SELECT path, sha, tier1_at, tier2_at, tier3_at, tombstoned_at, linker_refresh_pending FROM note ORDER BY path;",
    )
    .collect();
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0])) {
    throw new Error("restore note reconciliation returned an invalid statement envelope");
  }
  const identities = new Map<string, string>();
  for (const raw of result[0]) {
    const identity = parseRestoredNoteIdentity(raw);
    if (identities.has(identity.path)) {
      throw new Error(`restore note reconciliation returned duplicate path '${identity.path}'`);
    }
    identities.set(identity.path, identity.sha);
  }
  return identities;
}

function parseRestoredNoteIdentity(raw: unknown): { path: string; sha: string } {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("restore note reconciliation returned a non-object row");
  }
  const row = raw as Partial<RestoredNoteIdentity>;
  assertCompleteRestoredNote(row);
  const tier1 = row.tier1_at.toDate().getTime();
  const tier2 = row.tier2_at.toDate().getTime();
  const tier3 = row.tier3_at.toDate().getTime();
  if (tier1 > tier2 || tier2 > tier3) {
    throw new RestoreSnapshotMismatchError(
      `note '${row.path}' has out-of-order Tier 1/2/3 generation stamps`,
    );
  }
  return { path: row.path, sha: row.sha };
}

function assertCompleteRestoredNote(
  row: Partial<RestoredNoteIdentity>,
): asserts row is RestoredNoteIdentity {
  if (
    typeof row.path !== "string" ||
    row.path.length === 0 ||
    row.path.trim() !== row.path ||
    typeof row.sha !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.sha) ||
    !(row.tier1_at instanceof DateTime) ||
    !(row.tier2_at instanceof DateTime) ||
    !(row.tier3_at instanceof DateTime) ||
    row.tombstoned_at !== undefined ||
    row.linker_refresh_pending !== false
  ) {
    throw new RestoreSnapshotMismatchError(
      `note '${typeof row.path === "string" ? row.path : "<invalid>"}' is not a complete, non-tombstoned Tier 1/2/3 generation`,
    );
  }
}

function formatSetDifference(missingFromVault: string[], missingFromBackup: string[]): string {
  const parts: string[] = [];
  if (missingFromVault.length > 0) {
    parts.push(`backup-only ${formatPaths(missingFromVault)}`);
  }
  if (missingFromBackup.length > 0) {
    parts.push(`vault-only ${formatPaths(missingFromBackup)}`);
  }
  return parts.join("; ");
}

function formatPaths(paths: string[]): string {
  const shown = paths.slice(0, 10).map((path) => `'${path}'`);
  const suffix = paths.length > shown.length ? ` and ${paths.length - shown.length} more` : "";
  return `${shown.join(", ")}${suffix}`;
}
