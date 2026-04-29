/**
 * `notient links audit` CLI verb.
 *
 * Spec: docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md §11.1.
 *
 * Read-only NDJSON report of the three known link-health classes:
 *   - `unresolved-wikilink`: rows in `wikilink_unresolved`.
 *   - `unresolved-embed`:    rows in `embed_unresolved`.
 *   - `orphan-tag`:          tag rows with no incoming `tagged` edge.
 *
 * NDJSON is the default output. `--json` emits a single JSON array;
 * `--pretty` falls back to a human-readable line per finding for TTY
 * use. Empty result sets emit a `links:audit:empty` line in pretty
 * mode and zero NDJSON rows in NDJSON mode.
 */

import type { RecordId, Surreal } from "surrealdb";
import type { Emitter } from "../output";
import { connectVaultSurreal } from "./awakenSurrealClient";

export type LinksAuditMode = "ndjson" | "json" | "pretty";

export interface LinksAuditOptions {
  vaultPath: string;
  emitter: Emitter;
  mode: LinksAuditMode;
  clientIdentity?: string;
  /**
   * Test seam. Defaults to `process.stdout.write`. The runtime never threads
   * this from the dispatcher; tests override it to capture output.
   */
  writeStdout?: (line: string) => void;
}

interface UnresolvedRow {
  id: RecordId;
  in: RecordId;
  raw_target: string;
  source: string;
}

interface OrphanTagRow {
  id: RecordId;
  path: string;
}

interface AuditFinding {
  kind: "unresolved-wikilink" | "unresolved-embed" | "orphan-tag";
  id: string;
  details: Record<string, unknown>;
}

export async function runLinksAuditCommand(options: LinksAuditOptions): Promise<number> {
  const writeStdout =
    options.writeStdout ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  let connection: { db: Surreal; close: () => Promise<void> } | undefined;
  try {
    const opened = await connectVaultSurreal(options.vaultPath);
    connection = opened;
    const findings = await collectFindings(opened.db);

    if (options.mode === "json") {
      writeStdout(JSON.stringify(findings, null, 2));
      return 0;
    }
    if (options.mode === "pretty") {
      if (findings.length === 0) {
        writeStdout("links:audit:empty");
        return 0;
      }
      for (const finding of findings) {
        writeStdout(renderPretty(finding));
      }
      return 0;
    }
    // NDJSON default: one line per finding, zero lines when empty.
    for (const finding of findings) {
      writeStdout(JSON.stringify(finding));
    }
    return 0;
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "INTERNAL",
      message: `links audit failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  } finally {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
  }
}

async function collectFindings(db: Surreal): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  const [wikilinkRows] = await db
    .query<[Array<UnresolvedRow>]>("SELECT id, in, raw_target, source FROM wikilink_unresolved;")
    .collect<[Array<UnresolvedRow>]>();
  for (const row of wikilinkRows) {
    findings.push({
      kind: "unresolved-wikilink",
      id: row.id.toString(),
      details: {
        in: row.in.toString(),
        raw_target: row.raw_target,
        source: row.source,
      },
    });
  }

  const [embedRows] = await db
    .query<[Array<UnresolvedRow>]>("SELECT id, in, raw_target, source FROM embed_unresolved;")
    .collect<[Array<UnresolvedRow>]>();
  for (const row of embedRows) {
    findings.push({
      kind: "unresolved-embed",
      id: row.id.toString(),
      details: {
        in: row.in.toString(),
        raw_target: row.raw_target,
        source: row.source,
      },
    });
  }

  const [orphanRows] = await db
    .query<[Array<OrphanTagRow>]>(
      "SELECT id, path FROM tag WHERE id NOT IN (SELECT VALUE out FROM tagged);",
    )
    .collect<[Array<OrphanTagRow>]>();
  for (const row of orphanRows) {
    findings.push({
      kind: "orphan-tag",
      id: row.id.toString(),
      details: { path: row.path },
    });
  }

  findings.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return findings;
}

function renderPretty(finding: AuditFinding): string {
  const detailParts = Object.entries(finding.details).map(
    ([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
  return `${finding.kind} id=${finding.id} ${detailParts.join(" ")}`.trimEnd();
}
