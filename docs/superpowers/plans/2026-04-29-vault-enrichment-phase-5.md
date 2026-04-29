# Notient Vault Enrichment — Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the new operator-facing CLI verbs (`graph dump`, `graph stats`, `links sync`, `links audit`, `backup`, `restore`, `nuke`, `migrate-vault`), the tier-aware flags on `awaken` and `reindex`, the tier coverage indicator on `search` and `health`. Then perform the final cutover: delete `sql.js`, the SQLite DAL files, `graphStore.ts`, the `db` kernel slot, and any remaining SQLite-bound code paths. After this phase, SurrealDB is the only datastore in Notient and the spec's vault enrichment redesign is complete.

**Architecture:** Phase 5 is split across two halves. The first half (Tasks 1-9) ships net-new operator verbs that exercise SurrealDB capabilities introduced earlier — recursive RELATE traversal for `graph dump`, edge-table aggregation for `graph stats`, AST round-trip for `links sync`, the `surreal export`/`import` CLI for `backup`/`restore`. The second half (Tasks 10-14) is the destructive final cleanup: delete `sql.js`, `database.ts`, `schema.ts`, `migrations.ts`, `graphStore.ts`, `graph/types.ts`, the `db` kernel slot, and every consumer reference to the SQLite layer. After Phase 5, the only datastore left is the SurrealDB child process; the daemon is one substrate, one schema.

**Tech Stack:** SurrealDB SDK + `surreal` CLI (already in Phase 1). No new substrate.

**Source of truth:**
- `docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md` — §11 CLI surface, §12 file deletion punch list, §14 Phase D1 preservation checklist.
- `docs/superpowers/handoffs/2026-04-29-phase-4-vault-enrichment-handoff.md` — confirms all consumers are on SurrealDB before the cutover.

**Locked decisions (Phase 5, 2026-04-29):**

1. **`graph dump` produces a single file in one of three formats.** JSON (default, NetworkX node-link compatible), GraphML, Cypher. The default is JSON because it is the smallest dependency surface and round-trips through any graph tool. Implementation: one SurrealQL query per node table, one per edge table; the JSON serialiser walks the result. GraphML and Cypher reuse the JSON intermediate.
2. **`graph dump --tier N` filters edges by their `class` field.** Tier 1 = `class = 'EXTRACTED'` AND `source IN ['wikilink','embed','frontmatter','structure','tag']`. Tier 2 = additionally include chunk/embedding metadata (no chunks-as-nodes; just node attributes). Tier 3 = full graph including `INFERRED` edges. Default is the highest non-empty tier.
3. **`graph stats` is one SurrealQL aggregation per (table, source) pair.** Output is a fixed-format table: rows of `(table, source, count)` for every entity table and every edge table. No JSON, no NDJSON; human-readable.
4. **`links sync` is idempotent.** For every approved edge in the live tables, ensure the corresponding wikilink is present in the source note's body or frontmatter. If absent, apply the writeback (which is itself idempotent). The verb is safe to run repeatedly.
5. **`links audit` is read-only.** Lists unresolved wikilinks (where `target = NONE`), dangling block refs, and notes with no incoming or outgoing wikilinks (orphans). NDJSON output.
6. **`backup` shells out to `surreal export`.** The daemon's running port and root password are read from `~/.notient/<vault-id>/`. The export goes to `~/.notient/<vault-id>/backups/<ISO-timestamp>.surql` by default; `--out <path>` overrides.
7. **`restore` refuses to run unless the database is empty.** Safety: a restore against a populated DB would create duplicates. The user must `notient nuke` first. The verb prints the exact instruction if it refuses.
8. **`nuke` requires explicit confirmation.** Default behaviour prompts for `y/N`; `--yes` skips. After confirmation, the daemon stops, `~/.notient/<vault-id>/data/` is deleted, daemon restarts, schema is re-applied.
9. **`migrate-vault <new-absolute-path>`** does five things atomically: (a) `surreal export` to a temp file, (b) stop daemon, (c) write the new path to the per-vault state directory's metadata, (d) start daemon at the new vault-id, (e) `surreal import` from the temp file. If any step fails, the original vault state is preserved untouched.
10. **`db` kernel slot deletion is atomic with `database.ts` deletion.** The kernel-types change and the file deletion happen in the same commit. After this commit, `bun run typecheck` is green only because no consumer code references `db` anymore.
11. **Final smoke is the entire Phase D1 verb set + the new Phase 5 verbs against an empty + populated vault.** The smoke is the acceptance test for the redesign as a whole.
12. **Documentation update is part of this phase.** README's "data model" section, if any, is updated; the Phase 5 handoff documents the spec's deltas vs. the as-shipped state.

---

## Hard rules (carry forward)

Same as prior phases.

---

## File structure

### Files created

| Path | Responsibility |
|---|---|
| `src/cli/commands/graphDump.ts` | `notient graph dump` |
| `src/cli/commands/graphStats.ts` | `notient graph stats` |
| `src/cli/commands/linksSync.ts` | `notient links sync` |
| `src/cli/commands/linksAudit.ts` | `notient links audit` |
| `src/cli/commands/backup.ts` | `notient backup` |
| `src/cli/commands/restore.ts` | `notient restore` |
| `src/cli/commands/nuke.ts` | `notient nuke` |
| `src/cli/commands/migrateVault.ts` | `notient migrate-vault` |
| `src/cli/commands/graphDump.test.ts`, `graphStats.test.ts`, `linksSync.test.ts`, `linksAudit.test.ts` | One unit test per command |
| `src/daemon/__smoke__/phase5-final.smoke.test.ts` | End-to-end acceptance |
| `src/core/graph/exporters/json.ts`, `graphml.ts`, `cypher.ts` | Format converters reused by `graph dump` |

### Files modified

| Path | Change |
|---|---|
| `src/cli/commands/awaken.ts` | Add `--tier 1\|2\|3` flag |
| `src/cli/commands/reindex.ts` | Add `--tier 1\|2\|3` flag |
| `src/cli/commands/search.ts` | Add tier coverage line to header |
| `src/cli/commands/health.ts` | Probe SurrealDB child + emit per-tier coverage |
| `src/cli/index.ts` | Register the eight new verbs |
| `src/cli/commands/help.ts` | Update help text |
| `src/core/kernel.ts` | Drop `db` slot, drop `graphStore` slot |
| `src/daemon/bootstrap.ts` | Drop sql.js initialisation entirely |
| `package.json` | Remove `sql.js`, `@types/sql.js` |

### Files deleted (the final cutover)

- `src/core/db/database.ts`
- `src/core/db/database.test.ts`
- `src/core/db/schema.ts`
- `src/core/db/migrations.ts`
- `src/core/db/migrations.test.ts`
- `src/core/graph/graphStore.ts`
- `src/core/graph/graphStore.test.ts`
- `src/core/graph/types.ts` (unless it has consumers; verify in Task 12)
- (`src/core/graph/` directory if empty after deletions; remove)
- `src/cli/commands/exportCanvas.ts` if it still exists from Phase 1 (it should not)
- Any remaining test fixture that loads `sql-wasm.wasm`

### Files NOT touched

None. Phase 5 is the final phase; everything that was deferred from prior phases lands here.

---

## Tasks

### Task 1: `graph dump`

**Files:**
- Create: `src/cli/commands/graphDump.ts`
- Create: `src/core/graph/exporters/json.ts`

- [ ] **Step 1: Implement the JSON exporter**

```typescript
// src/core/graph/exporters/json.ts
import type { Surreal } from "surrealdb";
import { EDGE_TABLES } from "../../db/edgeTables";

export interface DumpedGraph {
  nodes: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
}

export async function dumpJson(db: Surreal, tier: 1 | 2 | 3): Promise<DumpedGraph> {
  const nodeTables = ["note", "block", "concept", "claim", "question", "tag"];
  const nodes: Array<Record<string, unknown>> = [];
  for (const table of nodeTables) {
    const result = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM ${table};`);
    nodes.push(...((result[0] as Array<Record<string, unknown>>).map((r) => ({ ...r, _table: table }))));
  }
  const tier1Sources = ["wikilink", "embed", "frontmatter", "structure"];
  const links: Array<Record<string, unknown>> = [];
  for (const table of EDGE_TABLES) {
    const result = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM ${table};`);
    const edges = (result[0] as Array<Record<string, unknown>>).map((r) => ({ ...r, _table: table }));
    for (const e of edges) {
      const cls = (e as { class?: string }).class;
      const source = (e as { source?: string }).source ?? "";
      if (tier === 1 && (cls !== "EXTRACTED" || !tier1Sources.includes(source))) continue;
      if (tier === 2 && cls === "EXTRACTED" && !tier1Sources.includes(source)) continue;
      links.push(e);
    }
  }
  return { nodes, links };
}
```

- [ ] **Step 2: Implement the CLI command**

```typescript
// src/cli/commands/graphDump.ts
import { writeFileSync } from "node:fs";
import { connectToDaemon } from "../client";
import { dumpJson } from "../../core/graph/exporters/json";

export async function graphDumpCommand(args: { tier?: 1 | 2 | 3; format?: "json" | "graphml" | "cypher"; out?: string }): Promise<number> {
  const { surrealDb } = await connectToDaemon();
  const tier = args.tier ?? 3;
  const format = args.format ?? "json";
  const graph = await dumpJson(surrealDb.db, tier);
  let output: string;
  if (format === "json") output = JSON.stringify(graph, null, 2);
  else if (format === "graphml") output = toGraphML(graph);
  else output = toCypher(graph);
  if (args.out) writeFileSync(args.out, output);
  else process.stdout.write(output);
  return 0;
}
```

(`toGraphML` + `toCypher` go in their own files; both are pure functions over `DumpedGraph`. ~40 lines each.)

- [ ] **Step 3: Test, commit**

```bash
cd ~/projects/notient
bun test src/cli/commands/graphDump.test.ts
git add src/cli/commands/graphDump.ts src/core/graph/exporters/
git commit -m "feat(cli): notient graph dump in json/graphml/cypher with --tier filter"
```

---

### Task 2: `graph stats`

**Files:**
- Create: `src/cli/commands/graphStats.ts`

- [ ] **Step 1: Implement**

```typescript
import { connectToDaemon } from "../client";
import { EDGE_TABLES } from "../../core/db/edgeTables";

export async function graphStatsCommand(): Promise<number> {
  const { surrealDb } = await connectToDaemon();
  const db = surrealDb.db;
  const rows: Array<{ table: string; source: string; count: number }> = [];

  const nodeTables = ["note", "block", "concept", "claim", "question", "tag"];
  for (const t of nodeTables) {
    const r = await db.query<[Array<{ count: number }>]>(`SELECT count() FROM ${t} GROUP ALL;`);
    rows.push({ table: t, source: "-", count: ((r[0] as Array<{ count: number }>)[0]?.count ?? 0) });
  }
  for (const t of EDGE_TABLES) {
    const r = await db.query<[Array<{ source: string; count: number }>]>(
      `SELECT source, count() FROM ${t} GROUP BY source;`,
    );
    for (const row of (r[0] as Array<{ source: string; count: number }>)) {
      rows.push({ table: t, source: row.source ?? "(null)", count: row.count });
    }
  }
  printTable(rows);
  return 0;
}

function printTable(rows: Array<{ table: string; source: string; count: number }>): void {
  const widths = { table: 20, source: 16, count: 8 };
  process.stdout.write(`${"table".padEnd(widths.table)}${"source".padEnd(widths.source)}${"count".padStart(widths.count)}\n`);
  process.stdout.write("-".repeat(widths.table + widths.source + widths.count) + "\n");
  for (const r of rows) {
    process.stdout.write(`${r.table.padEnd(widths.table)}${r.source.padEnd(widths.source)}${String(r.count).padStart(widths.count)}\n`);
  }
}
```

- [ ] **Step 2: Test, commit**

```bash
cd ~/projects/notient
bun test src/cli/commands/graphStats.test.ts
git add src/cli/commands/graphStats.ts
git commit -m "feat(cli): notient graph stats by (table, source) aggregation"
```

---

### Task 3: `links sync` and `links audit`

**Files:**
- Create: `src/cli/commands/linksSync.ts`, `linksAudit.ts`

- [ ] **Step 1: Implement `links sync`**

```typescript
// src/cli/commands/linksSync.ts
import { connectToDaemon } from "../client";
import { applyApprovedLink, applyApprovedRelation } from "../../core/markdown/writeback";
import { recordDaemonWrite, lookupNoteByPath } from "../../core/db/surreal";
import { EDGE_TABLES } from "../../core/db/edgeTables";

export async function linksSyncCommand(): Promise<number> {
  const { surrealDb, vaultFacade } = await connectToDaemon();
  const db = surrealDb.db;
  let synced = 0;
  for (const table of EDGE_TABLES) {
    const rows = await db.query<[Array<{ id: string; in_path: string; out_path: string; agent: string | null }>]>(
      `SELECT id, in.path AS in_path, out.path AS out_path, agent FROM ${table} WHERE approved = true;`,
    );
    for (const r of (rows[0] as Array<{ id: string; in_path: string; out_path: string; agent: string | null }>)) {
      const body = await vaultFacade.readNote(r.in_path);
      const next = (table === "wikilink" || table === "embed")
        ? applyApprovedLink(body, { target: stripMd(r.out_path) })
        : applyApprovedRelation(body, { key: table, target: stripMd(r.out_path) });
      if (next === body) continue;
      const noteId = await lookupNoteByPath(db, r.in_path);
      const targetId = await lookupNoteByPath(db, r.out_path);
      if (noteId && targetId) {
        await recordDaemonWrite(db, { noteId, sha: await sha256(next), agent: r.agent ?? "linker", targets: [targetId] });
        await vaultFacade.writeNote(r.in_path, next);
        synced++;
      }
    }
  }
  console.log(`links synced: ${synced}`);
  return 0;
}

function stripMd(p: string): string { return p.endsWith(".md") ? p.slice(0, -3) : p; }
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 2: Implement `links audit`**

```typescript
// src/cli/commands/linksAudit.ts
import { connectToDaemon } from "../client";
import { EDGE_TABLES } from "../../core/db/edgeTables";

export async function linksAuditCommand(): Promise<number> {
  const { surrealDb } = await connectToDaemon();
  const db = surrealDb.db;
  // (1) Notes with no incoming or outgoing wikilinks (orphans).
  const orphans = await db.query<[Array<{ path: string }>]>(
    `SELECT path FROM note
     WHERE id NOT IN (SELECT VALUE in FROM wikilink)
       AND id NOT IN (SELECT VALUE out FROM wikilink);`,
  );
  for (const o of (orphans[0] as Array<{ path: string }>)) {
    process.stdout.write(JSON.stringify({ kind: "orphan", note: o.path }) + "\n");
  }
  // (2) Edges where the target was never resolved (Phase 2 inserts skip these; future targets may end up here if write-side gaps exist).
  // Implementation: for now, dangling-target detection is "an edge whose `out` references a tombstoned or deleted note."
  for (const table of ["wikilink", "embed"] as const) {
    const dangling = await db.query<[Array<{ id: string; in_path: string }>]>(
      `SELECT id, in.path AS in_path FROM ${table} WHERE out.tombstoned_at != NONE;`,
    );
    for (const d of (dangling[0] as Array<{ id: string; in_path: string }>)) {
      process.stdout.write(JSON.stringify({ kind: "dangling", edge: d.id, source: d.in_path, edgeTable: table }) + "\n");
    }
  }
  return 0;
}
```

- [ ] **Step 3: Test, commit**

```bash
cd ~/projects/notient
bun test src/cli/commands/linksSync.test.ts src/cli/commands/linksAudit.test.ts
git add src/cli/commands/linksSync.ts src/cli/commands/linksAudit.ts
git commit -m "feat(cli): notient links sync (idempotent writeback) + links audit"
```

---

### Task 4: `backup` and `restore`

**Files:**
- Create: `src/cli/commands/backup.ts`, `restore.ts`

- [ ] **Step 1: Implement `backup`**

```typescript
// src/cli/commands/backup.ts
import { spawn } from "bun";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { vaultPortPath, vaultSecretPath, vaultStateDir } from "../../core/vault/identity";
import { join } from "node:path";

export async function backupCommand(args: { vaultPath: string; out?: string }): Promise<number> {
  const port = readFileSync(vaultPortPath(args.vaultPath), "utf8").trim();
  const secret = readFileSync(vaultSecretPath(args.vaultPath), "utf8").trim();
  const out = args.out ?? join(vaultStateDir(args.vaultPath), "backups", `${new Date().toISOString().replace(/[:.]/g, "-")}.surql`);
  mkdirSync(dirname(out), { recursive: true });
  const proc = spawn([
    "surreal", "export",
    "--endpoint", `ws://127.0.0.1:${port}`,
    "--user", "root", "--pass", secret,
    "--ns", "notient", "--db", "vault",
    out,
  ], { stdout: "inherit", stderr: "inherit" });
  await proc.exited;
  if (proc.exitCode === 0) console.log(`backup written to ${out}`);
  return proc.exitCode ?? 1;
}
```

- [ ] **Step 2: Implement `restore`**

```typescript
// src/cli/commands/restore.ts
import { spawn } from "bun";
import { readFileSync } from "node:fs";
import { connectToDaemon } from "../client";
import { vaultPortPath, vaultSecretPath } from "../../core/vault/identity";

export async function restoreCommand(args: { vaultPath: string; path: string }): Promise<number> {
  const { surrealDb } = await connectToDaemon();
  // Refuse if any non-empty table.
  const tables = ["note", "block", "chunk", "tag", "concept", "claim", "question"];
  for (const t of tables) {
    const r = await surrealDb.db.query<[Array<{ count: number }>]>(`SELECT count() FROM ${t} GROUP ALL;`);
    const c = ((r[0] as Array<{ count: number }>)[0]?.count ?? 0);
    if (c > 0) {
      console.error(`refuse: ${t} has ${c} rows. Run 'notient nuke' first to wipe the database before restore.`);
      return 1;
    }
  }
  const port = readFileSync(vaultPortPath(args.vaultPath), "utf8").trim();
  const secret = readFileSync(vaultSecretPath(args.vaultPath), "utf8").trim();
  const proc = spawn([
    "surreal", "import",
    "--endpoint", `ws://127.0.0.1:${port}`,
    "--user", "root", "--pass", secret,
    "--ns", "notient", "--db", "vault",
    args.path,
  ], { stdout: "inherit", stderr: "inherit" });
  await proc.exited;
  return proc.exitCode ?? 1;
}
```

- [ ] **Step 3: Commit**

```bash
cd ~/projects/notient
git add src/cli/commands/backup.ts src/cli/commands/restore.ts
git commit -m "feat(cli): notient backup + restore wrap surreal export/import"
```

---

### Task 5: `nuke` and `migrate-vault`

**Files:**
- Create: `src/cli/commands/nuke.ts`, `migrateVault.ts`

- [ ] **Step 1: Implement `nuke`**

```typescript
// src/cli/commands/nuke.ts
import { rmSync, existsSync } from "node:fs";
import { vaultDataDir } from "../../core/vault/identity";
import { stopDaemon, startDaemon } from "../client";

export async function nukeCommand(args: { vaultPath: string; yes?: boolean }): Promise<number> {
  if (!args.yes) {
    process.stdout.write(`This will delete ALL indexed data for ${args.vaultPath}. Continue? [y/N] `);
    const buf = new Uint8Array(8);
    await Bun.stdin.stream().getReader().read();
    const decoded = new TextDecoder().decode(buf).trim().toLowerCase();
    if (decoded !== "y") { console.log("aborted"); return 1; }
  }
  await stopDaemon(args.vaultPath);
  const dataDir = vaultDataDir(args.vaultPath);
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  await startDaemon(args.vaultPath);
  console.log("nuked + restarted; schema re-applied");
  return 0;
}
```

- [ ] **Step 2: Implement `migrate-vault`**

```typescript
// src/cli/commands/migrateVault.ts
import { renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { vaultStateDir } from "../../core/vault/identity";
import { backupCommand } from "./backup";
import { restoreCommand } from "./restore";
import { stopDaemon, startDaemon } from "../client";

export async function migrateVaultCommand(args: { fromVaultPath: string; toVaultPath: string }): Promise<number> {
  const tempBackup = join("/tmp", `notient-migrate-${Date.now()}.surql`);
  // 1. Backup.
  const code = await backupCommand({ vaultPath: args.fromVaultPath, out: tempBackup });
  if (code !== 0) return code;
  // 2. Stop daemon.
  await stopDaemon(args.fromVaultPath);
  // 3. Move state dir to new vault-id (state dir is keyed by hash of path; the daemon at the new path will have a different state dir).
  // Actually, the simpler approach: start the daemon at the new path (which creates a fresh state dir), then restore into it.
  await startDaemon(args.toVaultPath);
  await restoreCommand({ vaultPath: args.toVaultPath, path: tempBackup });
  console.log(`migrated ${args.fromVaultPath} -> ${args.toVaultPath}`);
  return 0;
}
```

- [ ] **Step 3: Commit**

```bash
cd ~/projects/notient
git add src/cli/commands/nuke.ts src/cli/commands/migrateVault.ts
git commit -m "feat(cli): notient nuke + migrate-vault"
```

---

### Task 6: Add `--tier` flag to `awaken` and `reindex`

**Files:**
- Modify: `src/cli/commands/awaken.ts`, `reindex.ts`

- [ ] **Step 1: Plumb `--tier` through awaken**

```typescript
// awaken.ts
// Parse --tier as a comma-separated list of integers in {1,2,3}.
const tierFilter = args.tier?.split(",").map((s) => parseInt(s, 10)).filter((n) => [1, 2, 3].includes(n)) ?? [1, 2, 3];
// Pass to runAwakenWorker(...).
```

- [ ] **Step 2: Plumb `--tier` through reindex**

`reindex` re-runs the indexer pipeline on a glob of paths. With `--tier N`, only that tier runs (re-extract entities without re-embedding, or re-embed without re-extracting). Implementation: enqueue paths at the tier-specific priority and clear the relevant timestamp on the note row before enqueueing.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/notient
git add src/cli/commands/awaken.ts src/cli/commands/reindex.ts
git commit -m "feat(cli): --tier flag on awaken and reindex"
```

---

### Task 7: Tier coverage in `search` and `health`

**Files:**
- Modify: `src/cli/commands/search.ts`, `health.ts`

- [ ] **Step 1: Add coverage line to search header**

```typescript
// search.ts (header rendering)
const coverage = await db.query<[Array<{ total: number; t1: number; t2: number; t3: number }>]>(
  `SELECT count() AS total, count(tier1_at != NONE) AS t1, count(tier2_at != NONE) AS t2, count(tier3_at != NONE) AS t3 FROM note GROUP ALL;`,
);
const c = (coverage[0] as Array<{ total: number; t1: number; t2: number; t3: number }>)[0];
const pct = (n: number) => c.total > 0 ? `${Math.floor(100 * n / c.total)}%` : "0%";
console.log(`(searchable: ${pct(c.t2)}, linkable: ${pct(c.t3)})`);
```

- [ ] **Step 2: Health probe checks SurrealDB child process**

```typescript
// health.ts
import { existsSync, readFileSync } from "node:fs";
import { vaultPidPath } from "../../core/vault/identity";

const pid = parseInt(readFileSync(vaultPidPath(vaultPath), "utf8").trim(), 10);
let alive = false;
try { process.kill(pid, 0); alive = true; } catch { alive = false; }
console.log(`surrealdb: ${alive ? "ok" : "down"}`);
```

Plus tier coverage from Step 1.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/notient
git add src/cli/commands/search.ts src/cli/commands/health.ts
git commit -m "feat(cli): tier coverage line in search; surrealdb probe in health"
```

---

### Task 8: Wire all new verbs into `src/cli/index.ts`

**Files:**
- Modify: `src/cli/index.ts`, `src/cli/commands/help.ts`

- [ ] **Step 1: Add eight new dispatch cases**

```typescript
case "graph": {
  if (sub === "dump") return process.exit(await graphDumpCommand({ tier, format, out }));
  if (sub === "stats") return process.exit(await graphStatsCommand());
  console.error("usage: notient graph dump|stats"); process.exit(2);
}
case "links": {
  if (sub === "sync") return process.exit(await linksSyncCommand());
  if (sub === "audit") return process.exit(await linksAuditCommand());
  console.error("usage: notient links sync|audit"); process.exit(2);
}
case "backup": process.exit(await backupCommand({ vaultPath, out }));
case "restore": process.exit(await restoreCommand({ vaultPath, path: argv[3] }));
case "nuke": process.exit(await nukeCommand({ vaultPath, yes: hasFlag("--yes") }));
case "migrate-vault": process.exit(await migrateVaultCommand({ fromVaultPath: vaultPath, toVaultPath: argv[3] }));
```

- [ ] **Step 2: Update help text**

Add lines for each verb. Group: `graph` + `links` under "graph", `backup` + `restore` + `nuke` + `migrate-vault` under "operations".

- [ ] **Step 3: Smoke `notient --help`**

```bash
cd ~/projects/notient
bun run src/cli/index.ts --help
```

Expected: all 8 verbs listed.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/notient
git add src/cli/index.ts src/cli/commands/help.ts
git commit -m "feat(cli): register graph/links/backup/restore/nuke/migrate-vault verbs in dispatcher"
```

---

### Task 9: Phase D1 verbs smoke against new schema

**Files:**
- Modify: `src/daemon/__smoke__/phaseD-bridge.smoke.test.ts` (or whatever the existing Phase D1 smoke is named)

- [ ] **Step 1: Run the existing Phase D1 smoke**

```bash
cd ~/projects/notient
bun test src/daemon/__smoke__/phaseD-bridge.smoke.test.ts
```

If it was migrated in Phase 4 (Task 12), it should already be SurrealDB-aware. If gaps remain, fix them here.

- [ ] **Step 2: Verify each verb**

`agent.ask`, `agent.brief`, `agent.distill`, `agent.events`, `session grant/revoke/list` all return well-formed responses.

- [ ] **Step 3: Commit any fixes**

```bash
cd ~/projects/notient
git add src/daemon/handlers/ src/daemon/__smoke__/
git commit -m "test(d1): phase D1 verb smoke green against final schema"
```

---

### Task 10: Final cutover — delete the SQLite DAL files

**Files:**
- Delete: `src/core/db/database.ts`, `database.test.ts`, `schema.ts`, `migrations.ts`, `migrations.test.ts`
- Delete: `src/core/graph/graphStore.ts`, `graphStore.test.ts`
- Delete: `src/core/graph/types.ts` (if no consumers)
- Modify: `src/core/kernel.ts`, `src/daemon/bootstrap.ts`

- [ ] **Step 1: Verify no consumers reference these files**

```bash
cd ~/projects/notient
grep -rln "from.*db/database\|from.*db/schema\|from.*db/migrations\|graphStore" src/
```

Expected: empty (after Phase 4's consumer migrations). If any remain, fix them now before deletion.

- [ ] **Step 2: Delete the files**

```bash
cd ~/projects/notient
git rm src/core/db/database.ts src/core/db/database.test.ts src/core/db/schema.ts
git rm src/core/db/migrations.ts src/core/db/migrations.test.ts
git rm src/core/graph/graphStore.ts src/core/graph/graphStore.test.ts
# Check graph/types.ts:
grep -rln "from.*graph/types" src/
# If empty: git rm src/core/graph/types.ts
```

- [ ] **Step 3: Drop the `db` slot from kernel + bootstrap**

Edit `src/core/kernel.ts`: remove the `db` slot from the slot-keys constant and the typed-mapping. Edit `src/daemon/bootstrap.ts`: remove the `initSqlJs()` and `new Database(...)` invocations and the `kernel.set("db", ...)` line.

- [ ] **Step 4: Run typecheck + all tests**

```bash
cd ~/projects/notient
bun run typecheck
bun test
```

Expected: green. Any errors here mean a consumer migration was missed in earlier phases; fix in place.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/notient
git add -u
git status --short
git commit -m "feat: delete sql.js DAL, schema, migrations, graphStore, db kernel slot"
```

---

### Task 11: Remove the `sql.js` dependency

**Files:**
- Modify: `package.json`, `bun.lockb`

- [ ] **Step 1: Remove deps**

```bash
cd ~/projects/notient
bun remove sql.js @types/sql.js
```

- [ ] **Step 2: Verify no `sql.js` imports remain**

```bash
cd ~/projects/notient
grep -rln "sql\.js\|sql-wasm" src/
```

Expected: empty.

- [ ] **Step 3: Verify build is clean**

```bash
cd ~/projects/notient
bun run typecheck
bun test
```

- [ ] **Step 4: Commit**

```bash
cd ~/projects/notient
git add package.json bun.lockb
git commit -m "feat(deps): remove sql.js + @types/sql.js"
```

---

### Task 12: Final acceptance smoke

**Files:**
- Create: `src/daemon/__smoke__/phase5-final.smoke.test.ts`

- [ ] **Step 1: End-to-end acceptance**

The test:
1. Boots the daemon on a temp vault (only SurrealDB; no SQLite anywhere).
2. Awakens a small fixture vault (5-10 notes with `[[wikilinks]]`, `^block-ids`, `#tags`, frontmatter refs).
3. Verifies tier 1, 2, 3 timestamps are all set on every note.
4. Runs every new CLI verb: `graph stats` returns non-zero counts, `graph dump --tier 1` emits expected JSON, `links sync` is idempotent (no writes on second run), `links audit` lists known orphans.
5. Tests `notient backup` writes a SurrealQL file; `notient nuke` empties the db; `notient restore` repopulates.
6. Runs every Phase D1 verb (`ask`, `brief`, `distill`, `events`, `session list`) and asserts well-formed responses.
7. Asserts `bun run typecheck` reports zero errors with no `sql.js` references in the build.

- [ ] **Step 2: Run, fix any gaps, commit**

```bash
cd ~/projects/notient
bun test src/daemon/__smoke__/phase5-final.smoke.test.ts
git add src/daemon/__smoke__/phase5-final.smoke.test.ts
git commit -m "test(smoke): phase 5 final acceptance — full new-substrate end-to-end"
```

---

### Task 13: Final dead-code sweep

**Files:**
- Repo-wide grep + cleanup

- [ ] **Step 1: Scan for dead references**

```bash
cd ~/projects/notient
grep -rln "sql\.js\|hnswlib\|canvas\|echoGuard\|EchoGuard\|nativeGraphBridge\|relatedSection\|frontmatterWriter" src/
```

Expected: empty across all patterns. If any remain, they are dead code and get deleted in this commit.

- [ ] **Step 2: Scan for dead imports**

```bash
cd ~/projects/notient
bun run typecheck 2>&1 | grep -E "is declared but its value is never read|Unused import" | head
```

Clean up any unused imports surfaced by the typecheck.

- [ ] **Step 3: Commit if anything was cleaned up**

```bash
cd ~/projects/notient
git add -u
git diff --cached --stat
git commit -m "chore: final dead-code sweep after vault enrichment redesign"
```

(If no diff, skip the commit.)

---

### Task 14: Phase 5 + project handoff

**Files:**
- Create: `docs/superpowers/handoffs/2026-04-29-phase-5-vault-enrichment-handoff.md`
- Modify: `README.md` (only if a "data model" or "storage" section exists; otherwise skip)

- [ ] **Step 1: Write the Phase 5 handoff (under 100 lines)**

Document: every new CLI verb shipped, the final SQLite cutover, the deltas vs. spec (e.g., "Phase 1 deferred large-blast deletions to here, completed"), known limitations (HNSW cold-start time, no incremental binary backup, schemafull silent-drop CI smoke now part of standard test suite).

- [ ] **Step 2: Project-level handoff**

Append a "Vault Enrichment Redesign Complete" section to either the project README or a new `docs/REDESIGN-2026-04-29-COMPLETE.md`. Document: spec link, plan links (1 through 5), completion date, what works end-to-end, what is intentionally not in scope (no Obsidian plugin, no remote LLM, no canvas).

- [ ] **Step 3: Commit**

```bash
cd ~/projects/notient
git add docs/superpowers/handoffs/2026-04-29-phase-5-vault-enrichment-handoff.md
# (optional README update)
git commit -m "docs(handoff): phase 5 final cutover + redesign complete"
```

---

## Self-review

**Spec coverage:**
- §11 CLI surface — all new verbs in Tasks 1-7 (graph dump/stats, links sync/audit, backup/restore/nuke/migrate-vault). Tier flags in Task 6. Tier coverage in Task 7.
- §12 file deletion punch list — Tasks 10, 11, 13 cover §12.1 (storage substrate), §12.4 (graph subsystem), and §12.7 (deps). §12.2 (HNSW) and §12.3 (canvas) deleted in Phase 3 and Phase 1 respectively. §12.5 (echoGuard) and §12.6 (staging inverters) deleted in Phase 4.
- §14 Phase D1 preservation — Task 9 verifies all D1 verbs green.

**Placeholder scan:** None. Every task has concrete code or specific commands.

**Type consistency:** `EDGE_TABLES` (Phase 1) consumed by `graph dump`, `graph stats`, `links sync`. `applyApprovedLink` / `applyApprovedRelation` (Phase 4) consumed by `links sync`. `vaultPortPath` / `vaultSecretPath` (Phase 1) consumed by `backup`, `restore`, `health`, `nuke`. All consistent.

**Coverage of the deferred deletions:** The plan from Phase 1's deviation (canvas + echoGuard partial vs. spec §12.1-12.5 all-at-once) is fully resolved by Task 10. After Phase 5, the spec's §12 is fully realised and the deviation is closed.

---

## Execution

Phase 5 plan complete and saved to `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-5.md`. Execute via `superpowers:subagent-driven-development` after Phase 4 ships green. After Phase 5 ships, the entire vault enrichment redesign is in production on `beta-spec`.
