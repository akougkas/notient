# Notient Vault Enrichment — Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the regex-based `nativeGraphBridge` with an AST-aware writeback module, populate the `daemon_write` provenance table on every approved write, delete the no-op `echoGuard` shim and its 25+ call sites, ship the awaken control plane (pause/resume/cancel/status), and introduce the per-vault TOML configuration file. Migrate the consumers that still read SQLite (`approvalService`, `historyService`, search) to SurrealDB so the daemon is fully on the new substrate.

**Architecture:** Three concurrent threads of work in this phase. (1) Markdown writeback: a single `src/core/markdown/writeback.ts` module replaces `nativeGraphBridge`, `relatedSection`, and `frontmatterWriter`. Both `applyApprovedLink` and `applyApprovedRelation` parse → mutate AST → stringify, and they record provenance in `daemon_write` BEFORE writing the file so Tier 1's wikilink reader can attribute the resulting wikilink to the agent that wrote it. (2) Awaken control plane: the `awaken_run` table from Phase 1's schema becomes the source of truth for an in-flight awaken. Pause/resume/cancel are writes to the row's `status` field that the worker subscribes to via `LIVE SELECT`. (3) Consumer DAL migration: `approvalService` writes `UPDATE supports SET approved = true` instead of moving a row from `staging_edges` to `graph_edges`. `historyService` and search consumers move to SurrealDB queries.

**Tech Stack:** unified/remark (already in Phase 2). SurrealDB live queries. Bun's `Bun.file` for atomic writes. `@iarna/toml` for parsing config (or `smol-toml` if smaller). No new substrate.

**Source of truth:**
- `docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md` — §3.5 daemon_write + awaken_run, §8.4 AST writeback, §9 awaken control plane, §10 configuration.
- `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-2.md` — markdown pipeline must be live and round-trip-stable before writeback can use it.
- `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-3.md` — Tier 2/3 must write to SurrealDB before approval flow can promote.

**Locked decisions (Phase 4, 2026-04-29):**

1. **Single `src/core/markdown/writeback.ts` module replaces three.** Both `applyApprovedLink({ notePath, target, heading?, block? })` and `applyApprovedRelation({ notePath, key, target })` live in one file with a shared internal parse-mutate-stringify helper. `relatedSection.ts`, `frontmatterWriter.ts`, `nativeGraphBridge.ts` are deleted in the same phase; their consumers update imports.
2. **The writeback round-trips through the unified pipeline.** No string regex mutation. The `## Related` section becomes a list-of-wikilinks AST node; frontmatter relations land as YAML strings under `notient.<key>` arrays. Idempotent: applying the same approved edge twice is a no-op.
3. **`daemon_write` is recorded BEFORE the file write.** The order is: parse → mutate → stringify → compute new SHA → INSERT INTO daemon_write → atomic file write → INSERT INTO history. If any step fails, no `daemon_write` row leaks because the writeback function does not commit until all DB writes succeed; if the file write fails after the daemon_write insert, the row stays and Tier 1 attributes the (still-old) content correctly. The 5-second window in `last_user_edit_at` derivation tolerates this race.
4. **EchoGuard shim is DELETED in this phase.** All 25+ consumer call sites (`echoGuard.mark(path, sha)`, `echoGuard.has(path, sha)`) are removed simultaneously. The replacement is implicit: Tier 1's wikilink reader cross-references `daemon_write` to attribute the wikilink's `source` field. Consumers that previously called `echoGuard.mark` now do nothing — the `daemon_write` insert in the writeback function covers it.
5. **Awaken control plane uses one row per run, never deleted.** `awaken_run` rows accumulate as a history log. The "current" run is identified by `status IN ('running','paused')`; at most one row matches at any time. `notient awaken --resume` finds the latest `paused` or `failed` row and updates it to `running`. `notient awaken --cancel` is destructive only of in-progress work; the row stays as `cancelled`.
6. **The awaken worker subscribes to the run's status via `LIVE SELECT`.** A single live query `LIVE SELECT status FROM $runId` notifies the worker of pause/cancel writes. The worker checks `status` between notes, not mid-note (mid-note pause would leave Tier 2/3 in inconsistent state).
7. **Pause is graceful, not forceful.** When the worker observes `status = 'paused'`, it finishes the current note's tier-3 if already started, then exits the work loop. SIGTERM on the daemon does the same: the worker notices the daemon is shutting down and writes `status = 'paused'` before exiting.
8. **Configuration file is per-vault, TOML, read once at daemon start.** `<vault>/.notient/config.toml`. No live-reload. Daemon restart picks up changes. Defaults from `concurrencyDefaults.ts` (Phase 3) override-able by the file.
9. **`notient init` writes a default config.toml** if one does not exist. Existing vaults already have `<vault>/.notient/`; the file is created on the first `notient awaken` if missing.
10. **Consumer migrations are split per file, one commit each.** `approvalService`, `historyService`, search consumers each get their own commit. Tests are migrated in the same commit as the consumer.
11. **Search consumers query SurrealDB's HNSW + full-text.** The vector search uses `<|K,EF|>`; full-text uses the `chunk_text` BM25 index defined in Phase 1's schema. Hybrid scoring (vector + BM25) is one SurrealQL with both predicates; the existing search-strategy code (quick/balanced/deep) keeps its public API but replaces SQL with SurrealQL.
12. **No new test scaffolding for migration.** Existing tests are updated to use the SurrealDB DAL (via the same fixture pattern from Phase 2/3 smokes). Tests that mocked the SQLite DB now mock the SurrealDB connection via the same fake pattern. No new mock framework.

---

## Hard rules (carry forward)

Same as prior phases. TS strict, no `any`, no abbreviations, no dash-clause prose, no emojis, one commit per logical step, kernel-only DAL slots.

---

## File structure

### Files created

| Path | Responsibility |
|---|---|
| `src/core/markdown/writeback.ts` | `applyApprovedLink`, `applyApprovedRelation`, both AST-round-trip |
| `src/core/markdown/writeback.test.ts` | Round-trip + idempotency on golden fixtures |
| `src/core/awaken/awakenRun.ts` | `createRun`, `findCurrent`, `updateStatus`, `subscribeToStatus` (live query helper) |
| `src/core/awaken/awakenRun.test.ts` | DAL tests against real SurrealDB |
| `src/core/awaken/awakenWorker.ts` | The actual run loop: walk vault, enqueue per tier, observe status changes |
| `src/core/awaken/awakenWorker.test.ts` | Smoke against fixture vault |
| `src/core/config/configFile.ts` | Read `<vault>/.notient/config.toml`, validate against TS schema, merge with defaults |
| `src/core/config/configFile.test.ts` | TOML parse + validation + default merging |
| `src/cli/commands/awakenStatus.ts` | `notient awaken --status` NDJSON tail |
| `src/cli/commands/awakenPause.ts` | `notient awaken --pause` writes `status='paused'` |
| `src/cli/commands/awakenResume.ts` | `notient awaken --resume` finds the latest non-completed run, updates status to `running` |
| `src/cli/commands/awakenCancel.ts` | `notient awaken --cancel` writes `status='cancelled'` |

### Files modified

| Path | Change |
|---|---|
| `src/core/db/surreal.ts` | Add `recordDaemonWrite`, `findRecentDaemonWrite`, awaken DAL helpers |
| `src/core/indexer/tier1.ts` | Cross-reference `daemon_write` when classifying wikilink edges; assign `source = '<agent>'` if the edge was just written by us |
| `src/core/approvals/approvalService.ts` | UPDATE row `approved = true` (was: move staging row to live table) |
| `src/core/approvals/approvalService.test.ts` | Migrate to SurrealDB |
| `src/core/history/historyService.ts` | Read/write `history` table via SurrealDB DAL |
| `src/core/history/historyService.test.ts` | Migrate |
| `src/core/history/inverters/noteCreate.ts`, `noteAppendSection.ts`, `noteFrontmatter.ts`, `noteMaturity.ts` | Each rewritten to operate on SurrealDB rows |
| `src/core/search/searchPipeline.ts`, `strategies/quick.ts`, `strategies/balanced.ts`, `strategies/deep.ts` | SurrealQL kNN + BM25 instead of sql.js + HNSW |
| `src/core/search/graphExpansion.ts` | Recursive `note.{..1}->wikilink->note` instead of recursive CTE |
| `src/cli/commands/awaken.ts` | Become the entry point that dispatches `--pause`/`--resume`/`--cancel`/`--status` to their handlers |
| `src/daemon/handlers/*.ts` | The five Phase D1 handlers (`agentAsk`, `agentBrief`, `agentDistill`, `agentEvents`, `session`) — DAL only, surface unchanged |
| All ~25 consumer files calling `echoGuard.mark` / `.has` | Remove the calls (no replacement) |

### Files deleted

- `src/core/services/echoGuard.ts` (the no-op shim from Phase 1)
- `src/core/graph/nativeGraphBridge.ts`
- `src/core/graph/nativeGraphBridge.test.ts`
- `src/core/graph/relatedSection.ts`
- `src/core/graph/relatedSection.test.ts`
- `src/core/graph/frontmatterWriter.ts`
- `src/core/graph/frontmatterWriter.test.ts`
- `src/core/history/inverters/edgeApprove.ts`, `edgeReject.ts`, `nodeApprove.ts`, `nodeReject.ts` (replaced by direct UPDATE/DELETE in `approvalService`)

### Files NOT touched (deferred to Phase 5)

- `src/core/db/database.ts`, `schema.ts`, `migrations.ts` — final SQLite cutover.
- `src/core/graph/graphStore.ts` — last consumer migrates in Phase 5; the file disappears with sql.js.

---

## Tasks

### Task 1: AST writeback module — `applyApprovedLink`

**Files:**
- Create: `src/core/markdown/writeback.ts`
- Create: `src/core/markdown/writeback.test.ts`
- Create: `src/core/markdown/__fixtures__/writeback-input.md`

- [ ] **Step 1: Failing test for the link path**

```typescript
// src/core/markdown/writeback.test.ts
import { describe, expect, test } from "bun:test";
import { applyApprovedLink, applyApprovedRelation } from "./writeback";

describe("writeback applyApprovedLink", () => {
  test("appends [[target]] under ## Related when section exists", () => {
    const input = `# Title\n\nBody.\n\n## Related\n\n- [[existing]]\n`;
    const out = applyApprovedLink(input, { target: "new-link" });
    expect(out).toContain("- [[existing]]");
    expect(out).toContain("- [[new-link]]");
    expect(out.indexOf("- [[new-link]]")).toBeGreaterThan(out.indexOf("## Related"));
  });

  test("creates ## Related section if missing", () => {
    const input = `# Title\n\nBody only.\n`;
    const out = applyApprovedLink(input, { target: "new-link" });
    expect(out).toContain("## Related");
    expect(out).toContain("- [[new-link]]");
  });

  test("idempotent: applying the same target twice is a no-op", () => {
    const input = `# Title\n\n## Related\n\n- [[x]]\n`;
    const once = applyApprovedLink(input, { target: "x" });
    const twice = applyApprovedLink(once, { target: "x" });
    expect(once).toBe(twice);
  });

  test("with heading qualifier emits [[target#heading]]", () => {
    const input = `# Title\n`;
    const out = applyApprovedLink(input, { target: "note", heading: "Section" });
    expect(out).toContain("[[note#Section]]");
  });
});

describe("writeback applyApprovedRelation", () => {
  test("merges into frontmatter notient.supports array", () => {
    const input = `---\ntitle: Test\n---\n\nBody.\n`;
    const out = applyApprovedRelation(input, { key: "supports", target: "alpha" });
    expect(out).toContain("notient:");
    expect(out).toContain("supports:");
    expect(out).toContain("[[alpha]]");
  });

  test("idempotent", () => {
    const input = `---\nnotient:\n  supports:\n    - "[[alpha]]"\n---\n\nBody.\n`;
    const out = applyApprovedRelation(input, { key: "supports", target: "alpha" });
    expect(out).toBe(input);
  });

  test("creates frontmatter if missing", () => {
    const input = `# Title\n\nNo frontmatter here.\n`;
    const out = applyApprovedRelation(input, { key: "extends", target: "beta" });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("[[beta]]");
  });
});
```

- [ ] **Step 2: Implement `applyApprovedLink`**

```typescript
// src/core/markdown/writeback.ts
import { parse, stringify } from "./pipeline";
import type { Root, Heading, List, ListItem, Paragraph, Yaml } from "mdast";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";

export interface ApplyLinkParams {
  target: string;
  heading?: string;
  block?: string;
}

export function applyApprovedLink(source: string, params: ApplyLinkParams): string {
  const ast = parse(source);
  const wikilink = formatWikilink(params);
  const relatedHeading = findHeading(ast, "Related");

  if (relatedHeading === null) {
    // Append a new ## Related section with one list item.
    ast.children.push(
      { type: "heading", depth: 2, children: [{ type: "text", value: "Related" }] },
      makeListItemList(wikilink),
    );
  } else {
    // Find the list under the Related heading, or create one.
    const listIndex = findListAfter(ast, relatedHeading);
    if (listIndex === null) {
      ast.children.splice(relatedHeading + 1, 0, makeListItemList(wikilink));
    } else {
      const list = ast.children[listIndex] as List;
      if (listAlreadyContains(list, wikilink)) return source; // idempotent
      list.children.push(makeListItem(wikilink));
    }
  }
  return stringify(ast);
}

export interface ApplyRelationParams {
  key: string;
  target: string;
}

export function applyApprovedRelation(source: string, params: ApplyRelationParams): string {
  const ast = parse(source);
  const wikilinkString = `[[${params.target}]]`;

  const yamlNodeIndex = ast.children.findIndex((c) => (c as { type: string }).type === "yaml");
  let frontmatter: Record<string, unknown> = {};
  if (yamlNodeIndex >= 0) {
    const node = ast.children[yamlNodeIndex] as Yaml;
    try { frontmatter = (parseYaml(node.value) as Record<string, unknown>) ?? {}; } catch { frontmatter = {}; }
  }

  const notient = (frontmatter.notient as Record<string, unknown> | undefined) ?? {};
  const arr = (notient[params.key] as string[] | undefined) ?? [];
  if (arr.includes(wikilinkString)) return source; // idempotent
  arr.push(wikilinkString);
  notient[params.key] = arr;
  frontmatter.notient = notient;

  const yamlText = stringifyYaml(frontmatter).trim();
  if (yamlNodeIndex >= 0) {
    (ast.children[yamlNodeIndex] as Yaml).value = yamlText;
  } else {
    ast.children.unshift({ type: "yaml", value: yamlText } as Yaml);
  }
  return stringify(ast);
}

function formatWikilink(params: ApplyLinkParams): string {
  if (params.block) return `[[${params.target}#^${params.block}]]`;
  if (params.heading) return `[[${params.target}#${params.heading}]]`;
  return `[[${params.target}]]`;
}

function findHeading(ast: Root, text: string): number | null {
  for (let i = 0; i < ast.children.length; i++) {
    const c = ast.children[i];
    if (c.type === "heading" && c.depth === 2) {
      const heading = c as Heading;
      const headingText = heading.children.map((ch) => (ch as { value?: string }).value ?? "").join("").trim();
      if (headingText === text) return i;
    }
  }
  return null;
}

function findListAfter(ast: Root, headingIndex: number): number | null {
  for (let i = headingIndex + 1; i < ast.children.length; i++) {
    const c = ast.children[i];
    if (c.type === "heading") return null;
    if (c.type === "list") return i;
  }
  return null;
}

function makeListItem(wikilinkText: string): ListItem {
  return {
    type: "listItem",
    spread: false,
    children: [{ type: "paragraph", children: [{ type: "text", value: wikilinkText }] } as Paragraph],
  };
}

function makeListItemList(wikilinkText: string): List {
  return { type: "list", ordered: false, spread: false, children: [makeListItem(wikilinkText)] };
}

function listAlreadyContains(list: List, wikilinkText: string): boolean {
  for (const item of list.children) {
    const para = item.children[0] as Paragraph;
    const text = para.children.map((c) => (c as { value?: string }).value ?? "").join("");
    if (text.trim() === wikilinkText) return true;
  }
  return false;
}
```

- [ ] **Step 3: Run test, fix until green, commit**

```bash
cd ~/projects/notient
bun test src/core/markdown/writeback.test.ts
git add src/core/markdown/writeback.ts src/core/markdown/writeback.test.ts
git commit -m "feat(markdown): AST-aware writeback for approved links and relations"
```

---

### Task 2: `daemon_write` DAL + Tier 1 cross-reference

**Files:**
- Modify: `src/core/db/surreal.ts`
- Modify: `src/core/indexer/tier1.ts`

- [ ] **Step 1: Add daemon_write DAL**

Append to `src/core/db/surreal.ts`:

```typescript
export interface DaemonWriteRow {
  id: RecordId<"daemon_write">;
  noteId: RecordId<"note">;
  sha: string;
  agent: string;
  targets: RecordId[];
  writtenAt: Date;
}

export async function recordDaemonWrite(db: Surreal, params: {
  noteId: RecordId<"note">;
  sha: string;
  agent: string;
  targets: RecordId[];
}): Promise<RecordId<"daemon_write">> {
  const result = await db.query<[Array<{ id: RecordId<"daemon_write"> }>]>(
    `CREATE daemon_write SET note = $n, sha = $s, agent = $a, targets = $t RETURN id;`,
    { n: params.noteId, s: params.sha, a: params.agent, t: params.targets },
  );
  return ((result[0] as Array<{ id: RecordId<"daemon_write"> }>)[0]).id;
}

export async function findRecentDaemonWrite(db: Surreal, params: {
  noteId: RecordId<"note">;
  sha: string;
  withinSeconds?: number;
}): Promise<{ agent: string; targets: RecordId[] } | null> {
  const within = params.withinSeconds ?? 5;
  const result = await db.query<[Array<{ agent: string; targets: RecordId[] }>]>(
    `SELECT agent, targets FROM daemon_write
     WHERE note = $n AND sha = $s AND written_at > time::now() - ${within}s
     ORDER BY written_at DESC LIMIT 1;`,
    { n: params.noteId, s: params.sha },
  );
  const row = (result[0] as Array<{ agent: string; targets: RecordId[] }>)[0];
  return row ?? null;
}
```

- [ ] **Step 2: Update Tier 1 to cross-reference**

In `src/core/indexer/tier1.ts`, after computing the body SHA but before inserting wikilink edges:

```typescript
import { findRecentDaemonWrite } from "../db/surreal";

// Inside runTier1, after upsertNoteByPath:
const recentWrite = await findRecentDaemonWrite(db, { noteId, sha: ex.bodySha });
const overrideTargets = new Set<string>(
  recentWrite ? recentWrite.targets.map((t) => t.toString()) : [],
);
const overrideAgent = recentWrite?.agent ?? null;

// When inserting each wikilink edge:
const isOverridden = toId !== null && overrideTargets.has(toId.toString());
await relateEdge(db, table, {
  from: fromId, to: toId,
  source: isOverridden ? (overrideAgent === "linker" ? "linker" : "user") : (w.isEmbed ? "embed" : "wikilink"),
  agent: isOverridden ? overrideAgent ?? undefined : undefined,
  confidenceClass: "EXTRACTED", confidence: 1.0,
});
```

- [ ] **Step 3: Update tests + commit**

```bash
cd ~/projects/notient
bun test src/core/db/surreal.test.ts src/core/indexer/tier1.test.ts
git add src/core/db/surreal.ts src/core/indexer/tier1.ts
git commit -m "feat(indexer): tier 1 attributes wikilink source via daemon_write provenance"
```

---

### Task 3: Migrate `approvalService` to SurrealDB

**Files:**
- Modify: `src/core/approvals/approvalService.ts`
- Modify: `src/core/approvals/approvalService.test.ts`
- Delete: `src/core/history/inverters/edgeApprove.ts`
- Delete: `src/core/history/inverters/edgeReject.ts`
- Delete: `src/core/history/inverters/nodeApprove.ts`
- Delete: `src/core/history/inverters/nodeReject.ts`

- [ ] **Step 1: Read current `approvalService.ts`**

Identify: `approve(edgeId)` and `reject(edgeId)` methods, their current SQLite path, the inverters they invoke.

- [ ] **Step 2: Replace with direct SurrealDB writes**

```typescript
// approvalService.ts (relevant fragment)
import { applyApprovedLink, applyApprovedRelation } from "../markdown/writeback";
import { recordDaemonWrite } from "../db/surreal";

export class ApprovalService {
  async approveEdge(edgeRecord: RecordId, edgeTable: EdgeTable): Promise<void> {
    // 1. Mark approved.
    await this.db.query(`UPDATE $e SET approved = true;`, { e: edgeRecord });

    // 2. Resolve the source note path and target note path for writeback.
    const result = await this.db.query<[Array<{ inPath: string; outPath: string; agent: string }>]>(
      `SELECT in.path AS inPath, out.path AS outPath, agent FROM $e;`,
      { e: edgeRecord },
    );
    const row = (result[0] as Array<{ inPath: string; outPath: string; agent: string }>)[0];
    if (!row) return;

    // 3. Apply writeback (edge type drives whether this becomes a [[target]] in ## Related, or a frontmatter relation).
    const body = await this.facade.readNote(row.inPath);
    let next: string;
    if (edgeTable === "wikilink" || edgeTable === "embed") {
      next = applyApprovedLink(body, { target: stripMd(row.outPath) });
    } else {
      next = applyApprovedRelation(body, { key: edgeTable, target: stripMd(row.outPath) });
    }
    if (next === body) return;

    const sha = await sha256(next);
    const noteId = await lookupNoteByPath(this.db, row.inPath);
    if (!noteId) return;
    await recordDaemonWrite(this.db, {
      noteId, sha, agent: row.agent ?? "linker",
      targets: [await lookupNoteByPath(this.db, row.outPath) as RecordId],
    });
    await this.facade.writeNote(row.inPath, next);
    await this.history.record({ kind: `edge_approved:${edgeTable}`, target: row.inPath, before: body, after: next });
  }

  async rejectEdge(edgeRecord: RecordId, edgeTable: EdgeTable): Promise<void> {
    await this.db.query(`DELETE $e;`, { e: edgeRecord });
  }
}

function stripMd(path: string): string { return path.endsWith(".md") ? path.slice(0, -3) : path; }
```

- [ ] **Step 3: Delete the four inverters**

```bash
cd ~/projects/notient
git rm src/core/history/inverters/edgeApprove.ts src/core/history/inverters/edgeReject.ts src/core/history/inverters/nodeApprove.ts src/core/history/inverters/nodeReject.ts
```

Update `src/core/history/inverters/index.ts` (or the inverter registry) to drop these four entries. Update `historyService.ts` if it references their kinds explicitly.

- [ ] **Step 4: Migrate `approvalService.test.ts`**

Update mocks to use the SurrealDB fake from Phase 1's smoke pattern.

- [ ] **Step 5: Run tests, commit**

```bash
cd ~/projects/notient
bun test src/core/approvals/
git add src/core/approvals/approvalService.ts src/core/approvals/approvalService.test.ts src/core/history/inverters/index.ts
git commit -m "feat(approvals): SurrealDB DAL + AST writeback; drop staging inverters"
```

---

### Task 4: Migrate `historyService` to SurrealDB

**Files:**
- Modify: `src/core/history/historyService.ts`, `historyService.test.ts`
- Modify: `src/core/history/inverters/noteCreate.ts`, `noteAppendSection.ts`, `noteFrontmatter.ts`, `noteMaturity.ts`
- Modify: corresponding `.test.ts` files

- [ ] **Step 1: Replace SQLite queries with SurrealDB**

`history` table already exists in `schema.surql` (Phase 1 retained it). Update `historyService.ts` to:

```typescript
async record(input: { kind: string; target: string; before: string; after: string; clientIdentity?: string | null }): Promise<RecordId<"history">> {
  const result = await this.db.query<[Array<{ id: RecordId<"history"> }>]>(
    `CREATE history SET kind = $k, target = $t, before = $b, after = $a, client_identity = $c, created_at = time::now() RETURN id;`,
    { k: input.kind, t: input.target, b: input.before, a: input.after, c: input.clientIdentity ?? null },
  );
  return ((result[0] as Array<{ id: RecordId<"history"> }>)[0]).id;
}

async getRecent(limit: number): Promise<HistoryRow[]> {
  const result = await this.db.query<[HistoryRow[]]>(
    `SELECT id, kind, target, before, after, client_identity, created_at FROM history ORDER BY created_at DESC LIMIT $l;`,
    { l: limit },
  );
  return result[0] as HistoryRow[];
}

async undoLast(): Promise<{ ok: boolean; reversed?: { id: RecordId<"history">; kind: string; target: string; createdAt: Date }; error?: string }> {
  // Same logic; just SurrealDB queries.
}
```

The four remaining inverters (`noteCreate`, `noteAppendSection`, `noteFrontmatter`, `noteMaturity`) get DAL-only updates: their `before` / `after` body is now applied through the markdown facade (unchanged) and the SurrealDB `note` row's `sha` field is updated.

- [ ] **Step 2: Migrate tests**

Update test fakes to the SurrealDB pattern.

- [ ] **Step 3: Run tests, commit**

```bash
cd ~/projects/notient
bun test src/core/history/
git add src/core/history/
git commit -m "feat(history): SurrealDB DAL for record/getRecent/undoLast + 4 inverters"
```

---

### Task 5: Delete `nativeGraphBridge`, `relatedSection`, `frontmatterWriter`

**Files:**
- Delete: `src/core/graph/nativeGraphBridge.ts`, `nativeGraphBridge.test.ts`
- Delete: `src/core/graph/relatedSection.ts`, `relatedSection.test.ts`
- Delete: `src/core/graph/frontmatterWriter.ts`, `frontmatterWriter.test.ts`

- [ ] **Step 1: Find all importers**

```bash
cd ~/projects/notient
grep -rln "nativeGraphBridge\|relatedSection\|frontmatterWriter" src/
```

Expected: `chatStream.ts`, `bootstrap.ts`, `synthesis.ts`, plus their tests.

- [ ] **Step 2: Migrate importers to `markdown/writeback.ts`**

For each importer, replace `bridge.applyApprovedLink(...)` / `bridge.applyApprovedRelation(...)` with direct calls to the writeback module functions (which take the body string in / return the body string out, and the caller handles the file write).

For consumers that wrote SHA-based echo marks, drop the echoGuard call (Phase 4 Task 6 deletes the shim).

- [ ] **Step 3: Delete the files**

```bash
cd ~/projects/notient
git rm src/core/graph/nativeGraphBridge.ts src/core/graph/nativeGraphBridge.test.ts
git rm src/core/graph/relatedSection.ts src/core/graph/relatedSection.test.ts
git rm src/core/graph/frontmatterWriter.ts src/core/graph/frontmatterWriter.test.ts
```

- [ ] **Step 4: Verify no references remain**

```bash
cd ~/projects/notient
grep -rln "nativeGraphBridge\|relatedSection\|frontmatterWriter" src/
```
Expected: empty.

- [ ] **Step 5: Run all tests, commit**

```bash
cd ~/projects/notient
bun test
git add src/
git commit -m "feat(graph): delete nativeGraphBridge + relatedSection + frontmatterWriter; consumers on markdown/writeback"
```

---

### Task 6: Delete the `echoGuard` shim and all consumer call sites

**Files:**
- Delete: `src/core/services/echoGuard.ts`
- Modify: ~25 consumer files

- [ ] **Step 1: List all call sites**

```bash
cd ~/projects/notient
grep -rln "echoGuard\|EchoGuard" src/
```

Expected: ~25 files.

- [ ] **Step 2: Remove all `mark` and `has` calls**

For each file in the grep output:
- Remove the `import { ... } from "../services/echoGuard"` line.
- Remove any `echoGuard.mark(...)` or `echoGuard.has(...)` invocations.
- Remove any `echoGuard` constructor parameter and store-it-on-this assignment.
- Remove any `kernel.set("echoGuard", ...)` registration in bootstrap.

This is mechanical. Each removal is 1-3 lines.

- [ ] **Step 3: Delete the shim**

```bash
cd ~/projects/notient
git rm src/core/services/echoGuard.ts
```

- [ ] **Step 4: Verify no references remain**

```bash
cd ~/projects/notient
grep -rln "echoGuard\|EchoGuard" src/
```
Expected: empty.

- [ ] **Step 5: Run all tests, commit**

```bash
cd ~/projects/notient
bun test
git add src/
git commit -m "feat(echoGuard): delete shim and 25 consumer call sites; daemon_write is the replacement"
```

---

### Task 7: Awaken DAL + run state machine

**Files:**
- Create: `src/core/awaken/awakenRun.ts`
- Create: `src/core/awaken/awakenRun.test.ts`

- [ ] **Step 1: Implement DAL**

```typescript
// src/core/awaken/awakenRun.ts
import type { Surreal, RecordId } from "surrealdb";

export type AwakenStatus = "running" | "paused" | "cancelled" | "completed" | "failed";

export interface AwakenRun {
  id: RecordId<"awaken_run">;
  status: AwakenStatus;
  total: number;
  processed: number;
  failed: number;
  tier_filter: number[];
  priority_globs: string[];
  cursor: string | null;
  started_at: Date;
  finished_at: Date | null;
  error: string | null;
}

export async function createRun(db: Surreal, params: { tierFilter: number[]; priorityGlobs: string[]; total: number }): Promise<RecordId<"awaken_run">> {
  const result = await db.query<[Array<{ id: RecordId<"awaken_run"> }>]>(
    `CREATE awaken_run SET status = "running", total = $t, tier_filter = $tf, priority_globs = $pg RETURN id;`,
    { t: params.total, tf: params.tierFilter, pg: params.priorityGlobs },
  );
  return ((result[0] as Array<{ id: RecordId<"awaken_run"> }>)[0]).id;
}

export async function findCurrent(db: Surreal): Promise<AwakenRun | null> {
  const result = await db.query<[AwakenRun[]]>(
    `SELECT * FROM awaken_run WHERE status IN ['running','paused'] ORDER BY started_at DESC LIMIT 1;`,
  );
  return ((result[0] as AwakenRun[])[0]) ?? null;
}

export async function findLatestResumable(db: Surreal): Promise<AwakenRun | null> {
  const result = await db.query<[AwakenRun[]]>(
    `SELECT * FROM awaken_run WHERE status IN ['paused','failed'] ORDER BY started_at DESC LIMIT 1;`,
  );
  return ((result[0] as AwakenRun[])[0]) ?? null;
}

export async function updateStatus(db: Surreal, runId: RecordId<"awaken_run">, status: AwakenStatus, extra?: { processed?: number; failed?: number; cursor?: string; error?: string }): Promise<void> {
  const sets: string[] = [`status = $s`];
  const vars: Record<string, unknown> = { id: runId, s: status };
  if (extra?.processed !== undefined) { sets.push(`processed = $p`); vars.p = extra.processed; }
  if (extra?.failed !== undefined) { sets.push(`failed = $f`); vars.f = extra.failed; }
  if (extra?.cursor !== undefined) { sets.push(`cursor = $c`); vars.c = extra.cursor; }
  if (extra?.error !== undefined) { sets.push(`error = $e`); vars.e = extra.error; }
  if (status === "completed" || status === "cancelled" || status === "failed") {
    sets.push(`finished_at = time::now()`);
  }
  await db.query(`UPDATE $id SET ${sets.join(", ")};`, vars);
}

export interface StatusSubscription { close(): Promise<void> }

export async function subscribeToStatus(db: Surreal, runId: RecordId<"awaken_run">, onChange: (status: AwakenStatus) => void): Promise<StatusSubscription> {
  // SurrealDB live query on a single record's status field.
  const live = await db.live<{ status: AwakenStatus }>("awaken_run", (action, result) => {
    if (action === "UPDATE" && (result as { id: RecordId; status: AwakenStatus }).id.toString() === runId.toString()) {
      onChange((result as { status: AwakenStatus }).status);
    }
  });
  return { close: async () => { await db.kill(live); } };
}
```

- [ ] **Step 2: Test (DAL only — live query test in Task 8)**

Cover: createRun returns an id, findCurrent returns null when no run exists, findLatestResumable returns the right row, updateStatus advances state and sets finished_at on terminal states.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/notient
bun test src/core/awaken/awakenRun.test.ts
git add src/core/awaken/
git commit -m "feat(awaken): awaken_run DAL + live status subscription helper"
```

---

### Task 8: Awaken worker

**Files:**
- Create: `src/core/awaken/awakenWorker.ts`
- Create: `src/core/awaken/awakenWorker.test.ts`

- [ ] **Step 1: Implement the worker loop**

```typescript
// src/core/awaken/awakenWorker.ts
import type { Surreal, RecordId } from "surrealdb";
import type { IndexerQueue } from "../indexer/indexerQueue";
import type { VaultFacade } from "../vault/types";
import { createRun, updateStatus, subscribeToStatus, findLatestResumable, type AwakenStatus } from "./awakenRun";

export interface AwakenWorkerOptions {
  db: Surreal;
  vaultFacade: VaultFacade;
  indexerQueue: IndexerQueue;
  tierFilter: number[];
  priorityGlobs: string[];
  resume: boolean;
}

export async function runAwakenWorker(options: AwakenWorkerOptions): Promise<{ runId: RecordId<"awaken_run">; status: AwakenStatus }> {
  let runId: RecordId<"awaken_run">;
  let processed = 0;
  let failed = 0;

  if (options.resume) {
    const existing = await findLatestResumable(options.db);
    if (!existing) throw new Error("no resumable awaken run found");
    runId = existing.id;
    processed = existing.processed;
    failed = existing.failed;
    await updateStatus(options.db, runId, "running");
  } else {
    const allPaths = await options.vaultFacade.listAllNotePaths();
    runId = await createRun(options.db, { tierFilter: options.tierFilter, priorityGlobs: options.priorityGlobs, total: allPaths.length });
  }

  let status: AwakenStatus = "running";
  const sub = await subscribeToStatus(options.db, runId, (s) => { status = s; });

  try {
    const allPaths = await options.vaultFacade.listAllNotePaths();
    const sorted = sortByPriorityGlobs(allPaths, options.priorityGlobs);
    for (const path of sorted) {
      // Re-check status between notes.
      if (status === "paused" || status === "cancelled") break;
      try {
        // Enqueue at priority 0 to drain Tier 1 first; the queue itself enforces tier ordering.
        options.indexerQueue.enqueue(path, 0);
        // Wait for the queue to process this path (or use a per-path promise).
        await waitForPath(options.indexerQueue, path);
        processed++;
      } catch (error) {
        failed++;
      }
      if (processed % 10 === 0) {
        await updateStatus(options.db, runId, status, { processed, failed, cursor: path });
      }
    }
    if (status === "running") {
      await updateStatus(options.db, runId, "completed", { processed, failed });
      status = "completed";
    } else {
      await updateStatus(options.db, runId, status, { processed, failed });
    }
  } finally {
    await sub.close();
  }

  return { runId, status };
}

function sortByPriorityGlobs(paths: string[], globs: string[]): string[] {
  if (globs.length === 0) return paths;
  // Naive ordering: paths matching any glob first, in glob order; rest after.
  // Production: use minimatch or picomatch for the glob match.
  return paths;
}

async function waitForPath(queue: IndexerQueue, path: string): Promise<void> {
  // Hook into the queue's per-path completion event. Implementation depends on the queue's event surface.
  return new Promise((resolve) => queue.onComplete(path, resolve));
}
```

- [ ] **Step 2: Smoke test** (small fixture vault, mocked indexer queue, assert pause + resume + cancel transitions).

- [ ] **Step 3: Commit**

```bash
cd ~/projects/notient
bun test src/core/awaken/awakenWorker.test.ts
git add src/core/awaken/awakenWorker.ts src/core/awaken/awakenWorker.test.ts
git commit -m "feat(awaken): worker loop with live status subscription + cursor checkpoints"
```

---

### Task 9: CLI commands for awaken control

**Files:**
- Create: `src/cli/commands/awakenStatus.ts`, `awakenPause.ts`, `awakenResume.ts`, `awakenCancel.ts`
- Modify: `src/cli/commands/awaken.ts`

- [ ] **Step 1: Implement each command (~30 lines each)**

```typescript
// src/cli/commands/awakenPause.ts
import { findCurrent, updateStatus } from "../../core/awaken/awakenRun";
import { connectToDaemon } from "../client";

export async function awakenPauseCommand(): Promise<number> {
  const { surrealDb } = await connectToDaemon();
  const current = await findCurrent(surrealDb.db);
  if (!current) { console.error("no active awaken run"); return 1; }
  await updateStatus(surrealDb.db, current.id, "paused");
  console.log(`paused run ${current.id} at ${current.processed}/${current.total}`);
  return 0;
}
```

(Similar for resume, cancel, status. Status emits NDJSON every 1s by polling the run row until status terminal.)

- [ ] **Step 2: Update `awaken.ts` to dispatch flags**

```typescript
// awaken.ts
import { awakenPauseCommand } from "./awakenPause";
import { awakenResumeCommand } from "./awakenResume";
import { awakenCancelCommand } from "./awakenCancel";
import { awakenStatusCommand } from "./awakenStatus";
import { runAwakenWorker } from "../../core/awaken/awakenWorker";

export async function awakenCommand(args: { pause?: boolean; resume?: boolean; cancel?: boolean; status?: boolean; tier?: number[]; priority?: string[]; background?: boolean }): Promise<number> {
  if (args.pause) return awakenPauseCommand();
  if (args.resume) return awakenResumeCommand({ tierFilter: args.tier ?? [1, 2, 3], priorityGlobs: args.priority ?? [] });
  if (args.cancel) return awakenCancelCommand();
  if (args.status) return awakenStatusCommand();
  // Default: start a fresh run (block until done unless --background).
  const { runId, status } = await runAwakenWorker({ /* ... */ });
  console.log(`awaken ${status}: ${runId}`);
  return status === "completed" ? 0 : 1;
}
```

- [ ] **Step 3: Wire into CLI dispatcher in `src/cli/index.ts`**

- [ ] **Step 4: Smoke + commit**

```bash
cd ~/projects/notient
bun run src/cli/index.ts awaken --status
git add src/cli/commands/awaken*.ts src/cli/index.ts
git commit -m "feat(cli): awaken --pause/--resume/--cancel/--status verbs"
```

---

### Task 10: Per-vault TOML config

**Files:**
- Create: `src/core/config/configFile.ts`
- Create: `src/core/config/configFile.test.ts`
- Add dep: `smol-toml` (or `@iarna/toml`)
- Modify: `src/core/indexer/indexerQueue.ts`, `src/core/indexer/embedder.ts`, `src/core/indexer/concurrencyDefaults.ts` to read overrides

- [ ] **Step 1: Add the dep**

```bash
cd ~/projects/notient
bun add smol-toml
```

- [ ] **Step 2: Implement the loader**

```typescript
// src/core/config/configFile.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { CONCURRENCY, CHUNK } from "../indexer/concurrencyDefaults";

export interface VaultConfig {
  indexer: {
    debounce_ms: number;
    concurrency: { embed: number; extract: number };
    chunk: { target_tokens: number; max_tokens: number };
  };
  awaken: {
    default_tier_filter: number[];
    default_priority_globs: string[];
  };
  surrealdb: {
    hnsw_cache_mib: number;
    log_level: "warn" | "info" | "debug";
  };
}

const DEFAULTS: VaultConfig = {
  indexer: {
    debounce_ms: 500,
    concurrency: { embed: CONCURRENCY.embed, extract: CONCURRENCY.extract },
    chunk: { target_tokens: CHUNK.targetTokens, max_tokens: CHUNK.maxTokens },
  },
  awaken: { default_tier_filter: [1, 2, 3], default_priority_globs: [] },
  surrealdb: { hnsw_cache_mib: 512, log_level: "warn" },
};

export function loadVaultConfig(vaultPath: string): VaultConfig {
  const path = join(vaultPath, ".notient", "config.toml");
  if (!existsSync(path)) return DEFAULTS;
  const raw = readFileSync(path, "utf8");
  let parsed: Record<string, unknown>;
  try { parsed = parseToml(raw) as Record<string, unknown>; } catch { return DEFAULTS; }
  return mergeDeep(DEFAULTS, parsed) as VaultConfig;
}

function mergeDeep(base: unknown, override: unknown): unknown {
  if (typeof override !== "object" || override === null || Array.isArray(override)) return override;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return override;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    out[k] = mergeDeep((base as Record<string, unknown>)[k], v);
  }
  return out;
}
```

- [ ] **Step 3: Test merging + missing-file fallback**

- [ ] **Step 4: Wire into bootstrap**

In `src/daemon/bootstrap.ts`, read config once and pass into `IndexerQueue`, `embedAll`, `awakenWorker`. Set `SURREAL_HNSW_CACHE_SIZE` env var on the `surreal start` spawn from `config.surrealdb.hnsw_cache_mib`.

- [ ] **Step 5: Update `notient init` to write a default config.toml**

- [ ] **Step 6: Commit**

```bash
cd ~/projects/notient
bun test src/core/config/
git add src/core/config/ src/daemon/bootstrap.ts src/cli/commands/init.ts package.json bun.lockb
git commit -m "feat(config): per-vault TOML config with concurrency, chunk, awaken, surrealdb sections"
```

---

### Task 11: Migrate search consumers to SurrealDB

**Files:**
- Modify: `src/core/search/searchPipeline.ts`, `src/core/search/strategies/{quick,balanced,deep}.ts`, `src/core/search/graphExpansion.ts`, `src/core/search/filters.ts`, `src/core/search/synthesis.ts`
- Modify: corresponding `.test.ts` files

- [ ] **Step 1: Replace SQLite + HNSW with SurrealQL in the kNN path**

In each strategy, replace the existing `hnswVectorIndex.search(...)` + sql.js follow-up with one SurrealQL:

```typescript
const result = await db.query<[Array<{ note: string; chunkText: string; d: number }>]>(
  `SELECT note.path AS note, text AS chunkText, vector::distance::knn() AS d
     FROM chunk WHERE vector <|${k},${ef}|> $q
     ORDER BY d LIMIT $k;`,
  { q: queryVector, k },
);
```

For `deep` strategy: combine vector + BM25 in one query using both predicates.

- [ ] **Step 2: Replace `graphExpansion`'s recursive CTE with recursive SurrealQL**

```typescript
const result = await db.query<[Array<{ path: string }>]>(
  `SELECT note.{..1}->wikilink->note.path AS path FROM $seedNote;`,
);
```

- [ ] **Step 3: Run search tests**

```bash
cd ~/projects/notient
bun test src/core/search/
```

- [ ] **Step 4: Commit (split into 2-3 commits if the change spans many files)**

```bash
git add src/core/search/
git commit -m "feat(search): migrate strategies + graphExpansion to SurrealDB native HNSW + recursive RELATE"
```

---

### Task 12: Migrate Phase D1 handlers' DAL

**Files:**
- Modify: `src/daemon/handlers/agentAsk.ts`, `agentBrief.ts`, `agentDistill.ts`, `agentEvents.ts`, `session.ts`, `sessionGrant.ts`, `sessionList.ts`, `sessionRevoke.ts`
- Modify: corresponding tests

- [ ] **Step 1: For each handler, swap the SQLite DAL for SurrealDB**

The handlers' RPC shapes are unchanged. Only the queries they issue change. `agent_event`, `agent_session`, `agent_run` tables exist in `schema.surql`; their shape is preserved.

- [ ] **Step 2: Run Phase D1 smoke tests**

```bash
cd ~/projects/notient
bun test src/daemon/handlers/
bun run smoke:cli:phaseD  # if this script exists from Phase D1; otherwise the equivalent
```

Expected: every Phase D1 verb green against new schema.

- [ ] **Step 3: Commit (one per handler family or one big commit if changes are mechanical)**

```bash
git add src/daemon/handlers/
git commit -m "feat(d1): migrate ask/brief/distill/events/session handlers to SurrealDB DAL"
```

---

### Task 13: Phase 4 smoke harness

**Files:**
- Create: `src/daemon/__smoke__/phase4.smoke.test.ts`

- [ ] **Step 1: End-to-end smoke**

A test that:
1. Starts a fresh awaken run.
2. Pauses mid-flight via a separate `awaken --pause` CLI invocation.
3. Asserts `awaken_run.status = 'paused'` and `processed > 0`.
4. Resumes via `awaken --resume`.
5. Asserts the run reaches `completed`.
6. Approves a linker proposal via the approval service.
7. Reads the source note's body and asserts the new wikilink lands in `## Related`.
8. Reads `daemon_write` and asserts a row exists with the right SHA, agent, and target.
9. Saves the note again (simulating user save) and asserts Tier 1 attributes the wikilink with `source = 'linker'` (because of the daemon_write match).

- [ ] **Step 2: Run, commit**

```bash
cd ~/projects/notient
bun test src/daemon/__smoke__/phase4.smoke.test.ts
git add src/daemon/__smoke__/phase4.smoke.test.ts
git commit -m "test(smoke): phase 4 awaken control plane + AST writeback + provenance"
```

---

### Task 14: Phase 4 handoff doc

**Files:**
- Create: `docs/superpowers/handoffs/2026-04-29-phase-4-vault-enrichment-handoff.md`

- [ ] **Step 1: Write under 80 lines**

Document: AST writeback shipped, daemon_write provenance live, echoGuard fully removed, awaken control plane functional, search consumers on SurrealDB, Phase D1 verbs green against new schema, config file in place. Phase 5 entry point: new CLI verbs (graph dump/stats, links sync/audit, backup/restore/nuke, migrate-vault), final SQLite cutover (delete database.ts, schema.ts, migrations.ts, hnswVectorIndex.ts, graphStore.ts; remove sql.js dep).

- [ ] **Step 2: Commit**

```bash
cd ~/projects/notient
git add docs/superpowers/handoffs/2026-04-29-phase-4-vault-enrichment-handoff.md
git commit -m "docs(handoff): phase 4 awaken + writeback + consumer migration shipped"
```

---

## Self-review

**Spec coverage:** §3.5 daemon_write + awaken_run (Tasks 2, 7), §8.4 AST writeback (Task 1), §9 awaken control plane (Tasks 7, 8, 9), §10 configuration (Task 10). Consumer migrations (Tasks 3, 4, 11, 12). Echo guard final removal (Task 6). All covered.

**Placeholder scan:** Several "implementation depends on the file structure" pointers in the consumer-migration tasks. These are unavoidable adapt-to-existing-code points. The shapes are documented (SurrealDB-equivalents of the SQLite calls); the executor reads each file and adapts.

**Type consistency:** `applyApprovedLink` / `applyApprovedRelation` return strings consumed by `approvalService` write path (Task 3). `daemon_write` row structure consistent across `recordDaemonWrite` (Task 2) and `findRecentDaemonWrite` (Task 2 / Tier 1). `AwakenStatus` enum consistent across DAL (Task 7), worker (Task 8), and CLI (Task 9).

**Known transient state during phase:** Between Tasks 3 and 5, `nativeGraphBridge` is unused but not yet deleted. This is one-commit-distance, so the executor merges Tasks 3-5 into a contiguous PR.

---

## Execution

Phase 4 plan complete and saved to `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-4.md`. Execute via `superpowers:subagent-driven-development` after Phase 3 ships green.
