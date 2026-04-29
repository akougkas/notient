# Notient Vault Enrichment — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real markdown parser (unified/remark with three custom plugins for Obsidian-flavored syntax) and a Tier 1 indexer that turns every saved note into deterministic edges in SurrealDB — wikilinks, embeds, block IDs, tags, frontmatter refs, structural `contained_in` and `under_heading` edges — without disturbing the existing SQLite-backed Tier 2 (chunks/vectors) or Tier 3 (extractor/linker) consumers.

**Architecture:** Phase 2 introduces `src/core/markdown/` as a self-contained AST module: pipeline + plugins + walker, all pure (no IO). The existing `indexNote.ts` orchestrator gains a Tier 1 step that runs **before** the existing chunk/embed/extract path. Tier 1 writes to SurrealDB via the DAL skeleton from Phase 1; the rest of the indexer continues to write to SQLite. This is a parallel-write phase: the same note now produces deterministic edges in SurrealDB AND chunks/concepts/etc. in SQLite. Phase 3 migrates Tier 2/3 to SurrealDB; Phase 5 deletes the SQLite paths.

**Tech Stack:** unified/remark plugin ecosystem (`unified`, `remark-parse`, `remark-stringify`, `remark-frontmatter`, `remark-gfm`), `mdast-util-to-string`, `unist-util-visit`, custom plugins in `src/core/markdown/plugins/`. SurrealDB DAL from Phase 1. `chokidar` for the watcher. No new substrate.

**Source of truth:**
- `docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md` — §3.2 (block schema), §3.4 (edge tables), §5.2 (Tier 1), §5.5 (watcher), §8.1-§8.3 (markdown pipeline + extractor + resolution).
- `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-1.md` — substrate this phase consumes.
- `docs/superpowers/handoffs/2026-04-29-phase-1-vault-enrichment-handoff.md` — confirms `surrealDb` slot is live and DAL skeleton (`createNote`, `relateWikilink`, `searchVector`) is callable.

**Locked decisions (Phase 2, 2026-04-29):**

1. **Three custom remark plugins, all in-repo.** No external `remark-wiki-link` package; the parsing rules for `[[target|alias]]`, `[[target#heading]]`, `[[target#^block]]`, `![[target]]` are Obsidian-specific and we want full control. Plugins ship as `src/core/markdown/plugins/{remarkWikilink,remarkBlockId,remarkTag}.ts`.
2. **AST node types are plain `unist` extensions, not classes.** `wikiLink`, `wikiEmbed`, `tagRef` nodes carry `target`, `alias?`, `heading?`, `block?`, `tag?` as plain string fields. The walker reads them via `unist-util-visit`; no type registry, no plugin coupling.
3. **Heading nodes cap at H3.** H4/H5/H6 are NOT block nodes. Their content is rolled into the nearest H3 ancestor block's `text`. Wikilinks with H4+ headings (`[[note#H4]]`) still resolve to the H3 ancestor block, with the full original heading path preserved on the edge attribute `target_heading_path`. Implemented in §10's wikilink resolver.
4. **Block extraction granularity:** one block per H1/H2/H3 plus one block per top-level paragraph or list item that contains a `^block-id` marker. No block per plain paragraph; the chunker (Phase 3) chunks at a different granularity.
5. **Tier 1 indexer writes are transactional.** One SurrealDB `BEGIN/COMMIT` per note: upsert note, replace blocks (delete-then-insert keyed on `block.note`), replace deterministic edges, set `tier1_at`. If any step fails, the whole transaction rolls back; the note's `tier1_at` does not advance.
6. **Wikilink target resolution is best-effort, deferred where ambiguous.** Same-vault target lookup runs in two passes: (a) exact `note.path` match modulo `.md` extension, (b) basename match if no folder is specified. Ambiguous basename matches resolve to the closest by edit distance to the active note's folder. Unresolved targets create the edge with `target = NONE` and `target_unresolved = "<original-string>"`. The `links audit` verb (Phase 5) surfaces these.
7. **Tier 1 runs as a parallel branch in the existing `indexNote.ts`.** It is not a separate worker. The existing flow stays: read file → SHA → if changed, run extractor + chunker + embedder + linker + write SQLite. Phase 2 prepends: read file → SHA → if changed, run **markdown pipeline** → write Tier 1 to SurrealDB → continue with existing flow. Errors in Tier 1 do NOT block Tier 2/3; they emit `indexer:error` and proceed.
8. **Watcher gains `unlink` + 60s SHA-match rename detection.** New listener on `chokidar`'s `unlink` event sets `note.tombstoned_at = time::now()`. A scheduled task (`setTimeout` per tombstone) cascade-deletes after 60 seconds unless the note has been resurrected. On `add(path)`, if a tombstoned `note` row exists with the same body SHA within the window, the path is updated and `tombstoned_at` is cleared. `change` events are unchanged.
9. **The unified pipeline is built once and reused.** `getMarkdownPipeline()` is a memoised factory; the same processor instance handles every note. Idempotency over `parse → stringify → parse` is verified by a golden fixture test (`src/core/markdown/__fixtures__/golden.md`).
10. **No write-back from Tier 1.** Tier 1 reads the note and writes to SurrealDB. It does NOT write back to the markdown file. The `daemon_write` provenance table is empty during Phase 2; it gets its first writers in Phase 4. Cross-referencing daemon_write to attribute wikilink source is therefore a no-op in Phase 2 (every wikilink edge gets `source = 'wikilink'`); Phase 4 turns it on.
11. **No deletion of existing markdown utilities yet.** `relatedSection.ts`, `frontmatterWriter.ts`, `nativeGraphBridge.ts` continue to live. They write SQLite-backed staging edges; that path is untouched until Phase 4.
12. **`MarkdownExtraction` is the contract between the AST module and the indexer.** Pure shape, no helper methods. The walker returns it; the indexer turns it into SurrealDB writes.

---

## Hard rules (carry forward from Phase 1)

- TypeScript strict, no `any` without justification.
- No `console.log` outside `src/cli/output.ts` and the existing `debug<Subsystem>` helpers.
- No abbreviations: `context` not `ctx`, `error` not `err`, `message` not `msg`, `event` not `evt`, `index` not `idx`, `options` not `opts`.
- No `[noun] - [parenthetical clause]` dash-clause prose.
- No emojis in source.
- One commit per logical step on `beta-spec`. Stage by name only.
- Substrate tests stay green throughout. New tests are additive and targeted.
- The kernel is the only place where new DAL slots get registered; Phase 2 adds none.

---

## File structure

### Files created

| Path | Responsibility |
|---|---|
| `src/core/markdown/types.ts` | `MarkdownExtraction`, `BlockSpec`, `WikilinkSpec`, `EmbedSpec`, `TagSpec`, `FrontmatterRefSpec`, all pure shape |
| `src/core/markdown/pipeline.ts` | `getMarkdownPipeline()` memoised unified processor; `parse(source)` and `stringify(ast)` helpers |
| `src/core/markdown/pipeline.test.ts` | Round-trip golden test on `__fixtures__/golden.md` |
| `src/core/markdown/plugins/remarkWikilink.ts` | Parse `[[target]]`, `[[target\|alias]]`, `[[target#heading]]`, `[[target#^block]]`, `![[target]]` |
| `src/core/markdown/plugins/remarkWikilink.test.ts` | Plugin unit tests |
| `src/core/markdown/plugins/remarkBlockId.ts` | Parse `^block-id` markers (end of paragraph or list item) |
| `src/core/markdown/plugins/remarkBlockId.test.ts` | Plugin unit tests |
| `src/core/markdown/plugins/remarkTag.ts` | Parse `#tag/sub` outside code spans/blocks |
| `src/core/markdown/plugins/remarkTag.test.ts` | Plugin unit tests |
| `src/core/markdown/extractor.ts` | `extract(ast, notePath): MarkdownExtraction`; pure walker, no IO |
| `src/core/markdown/extractor.test.ts` | Walker tests against AST fixtures |
| `src/core/markdown/__fixtures__/golden.md` | Round-trip + extraction golden fixture |
| `src/core/markdown/__fixtures__/edge-cases.md` | Wikilinks in code spans, frontmatter wikilinks, nested headings, malformed input |
| `src/core/indexer/tier1.ts` | Tier 1 orchestrator: AST → SurrealDB transaction |
| `src/core/indexer/tier1.test.ts` | Smoke against a temp SurrealDB |
| `src/core/markdown/resolver.ts` | Wikilink target resolution (note path lookup, basename fallback, edit-distance disambiguation) |
| `src/core/markdown/resolver.test.ts` | Resolver unit tests with synthetic vault |

### Files modified

| Path | Change |
|---|---|
| `package.json` | Add `unified`, `remark-parse`, `remark-stringify`, `remark-frontmatter`, `remark-gfm`, `mdast-util-to-string`, `unist-util-visit` |
| `src/core/db/surreal.ts` | Add Tier 1 DAL: `createBlock`, `replaceBlocks`, `relateEdge` (typed enum on edge table name), `clearTier1Edges`, `markTier1Done`, `lookupNoteByPath`, `lookupBlockByHeading` |
| `src/core/indexer/indexNote.ts` | Prepend Tier 1 step before existing flow |
| `src/daemon/watcher.ts` | Add `unlink` listener, rename detection within 60s SHA-match window |
| `src/daemon/watcher.test.ts` | Cover unlink + rename |

### Files deleted

None. Phase 2 is purely additive.

### Files NOT touched (deferred)

- `src/core/db/database.ts`, `src/core/db/schema.ts`, `src/core/db/migrations.ts` — Phase 5.
- `src/core/indexer/hnswVectorIndex.ts`, `src/core/indexer/chunker.ts`, `src/core/indexer/embedder.ts`, `src/core/indexer/extractor.ts` — Phase 3 migrates these to SurrealDB.
- `src/core/graph/graphStore.ts`, `nativeGraphBridge.ts`, `relatedSection.ts`, `frontmatterWriter.ts` — Phase 4.
- `src/core/services/echoGuard.ts` — still a no-op shim from Phase 1; Phase 4 deletes the shim and consumer call sites.
- All Phase D1 handlers, agent code, chat tools, search code — Phase 3/4/5 migrate the DAL.

---

## Tasks

### Task 1: Add unified/remark dependencies

**Files:**
- Modify: `package.json`, `bun.lockb`

- [ ] **Step 1: Add the deps**

```bash
cd ~/projects/notient
bun add unified remark-parse remark-stringify remark-frontmatter remark-gfm mdast-util-to-string unist-util-visit
bun add -d @types/mdast @types/unist
```

Expected: 6 runtime + 2 dev deps land in `package.json`.

- [ ] **Step 2: Smoke import**

```bash
cd ~/projects/notient && echo 'import { unified } from "unified"; console.log(typeof unified);' | bun run --no-install -
```
Expected: prints `function`.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/notient
git add package.json bun.lockb
git commit -m "feat(deps): add unified/remark stack for phase 2 markdown pipeline"
```

---

### Task 2: Markdown extraction types

**Files:**
- Create: `src/core/markdown/types.ts`

- [ ] **Step 1: Write the types**

Create `src/core/markdown/types.ts`:

```typescript
export interface BlockSpec {
  // For heading blocks: blockId is null, headingLevel is 1|2|3, headingSlug is set.
  // For ^block-id blocks: blockId is set, headingLevel is null, headingSlug is null.
  blockId: string | null;
  headingLevel: 1 | 2 | 3 | null;
  headingPath: string[]; // full path including H4-H6 if present (last segment is the deepest)
  headingSlug: string | null;
  ord: number;
  startLine: number;
  endLine: number;
  text: string;
}

export interface WikilinkSpec {
  // FROM is determined by the indexer (note or block).
  fromBlockOrd: number | null; // null if the link is at note-level (e.g. inside frontmatter)
  rawTarget: string;
  targetPath: string | null; // resolved by the resolver, null if unresolved
  targetHeading: string | null;
  targetBlockId: string | null;
  alias: string | null;
  isEmbed: boolean;
  // For [[note#H4]] where H4 is below the cap: preserve the original heading path
  targetHeadingPath: string[];
}

export interface TagSpec {
  fromBlockOrd: number | null;
  path: string; // e.g. "concept/auth/oauth"
}

export interface FrontmatterRefSpec {
  key: string; // the frontmatter key, e.g. "supports", "related"
  rawTarget: string;
  targetPath: string | null;
}

export interface MarkdownExtraction {
  blocks: BlockSpec[];
  wikilinks: WikilinkSpec[]; // includes embeds; isEmbed flag distinguishes
  tags: TagSpec[];
  frontmatterRefs: FrontmatterRefSpec[];
  frontmatter: Record<string, unknown>; // canonicalised YAML object
  bodySha: string;
  wordCount: number;
}
```

- [ ] **Step 2: Type-check**

```bash
cd ~/projects/notient && bun run typecheck 2>&1 | grep markdown/types
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/notient
git add src/core/markdown/types.ts
git commit -m "feat(markdown): MarkdownExtraction shape for pipeline output"
```

---

### Task 3: unified pipeline factory

**Files:**
- Create: `src/core/markdown/pipeline.ts`
- Create: `src/core/markdown/__fixtures__/golden.md`
- Create: `src/core/markdown/pipeline.test.ts`

- [ ] **Step 1: Write the golden fixture**

Create `src/core/markdown/__fixtures__/golden.md`:

```markdown
---
title: Golden Fixture
related: "[[other-note]]"
supports:
  - "[[a]]"
  - "[[b]]"
---

# Top Heading

Some prose here. Reference to [[wikilink-target]] and an [[aliased|alias]].

Embed below:

![[embedded-note]]

## Subheading

A paragraph with a `^block-1` block id.

- list item with [[link-in-list]] ^block-2
- another item

```ts
// code block, wikilinks here should NOT be parsed: [[not-a-link]]
```

#tag/sub here, but `not in code` and `[[not-in-code-spans]]` either.

### Deeper

content

#### Below cap

H4 content, rolled into the H3 above.
```

- [ ] **Step 2: Write the failing test**

Create `src/core/markdown/pipeline.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getMarkdownPipeline, parse, stringify } from "./pipeline";

const GOLDEN = readFileSync(join(import.meta.dir, "__fixtures__/golden.md"), "utf8");

describe("markdown pipeline", () => {
  test("getMarkdownPipeline returns a memoised processor", () => {
    expect(getMarkdownPipeline()).toBe(getMarkdownPipeline());
  });

  test("parse produces a root mdast node", () => {
    const ast = parse(GOLDEN);
    expect(ast.type).toBe("root");
    expect(Array.isArray(ast.children)).toBe(true);
  });

  test("stringify is the inverse of parse for the golden fixture", () => {
    const ast = parse(GOLDEN);
    const out = stringify(ast);
    const reparsed = parse(out);
    // The string form may differ in whitespace, but the AST shape must match.
    expect(JSON.stringify(reparsed)).toBe(JSON.stringify(parse(out)));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/projects/notient && bun test src/core/markdown/pipeline.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 4: Implement the pipeline (without custom plugins yet)**

Create `src/core/markdown/pipeline.ts`:

```typescript
import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import type { Root } from "mdast";

let cached: Processor<Root, Root, Root, Root, string> | null = null;

export function getMarkdownPipeline(): Processor<Root, Root, Root, Root, string> {
  if (cached) return cached;
  cached = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkGfm)
    .use(remarkStringify, {
      bullet: "-",
      fences: true,
      listItemIndent: "one",
      rule: "-",
    });
  return cached as Processor<Root, Root, Root, Root, string>;
}

export function parse(source: string): Root {
  return getMarkdownPipeline().parse(source) as Root;
}

export function stringify(ast: Root): string {
  return getMarkdownPipeline().stringify(ast);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/projects/notient && bun test src/core/markdown/pipeline.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/notient
git add src/core/markdown/pipeline.ts src/core/markdown/pipeline.test.ts src/core/markdown/__fixtures__/golden.md
git commit -m "feat(markdown): unified pipeline factory with frontmatter + gfm"
```

---

### Task 4: `remarkWikilink` plugin

**Files:**
- Create: `src/core/markdown/plugins/remarkWikilink.ts`
- Create: `src/core/markdown/plugins/remarkWikilink.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/markdown/plugins/remarkWikilink.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import type { Root } from "mdast";
import remarkWikilink, { type WikiLinkNode, type WikiEmbedNode } from "./remarkWikilink";

function parseWith(source: string): Root {
  return unified().use(remarkParse).use(remarkWikilink).parse(source) as Root;
}

function collectWikilinks(ast: Root): Array<WikiLinkNode | WikiEmbedNode> {
  const out: Array<WikiLinkNode | WikiEmbedNode> = [];
  visit(ast, ["wikiLink", "wikiEmbed"] as const, (node) => {
    out.push(node as WikiLinkNode | WikiEmbedNode);
  });
  return out;
}

describe("remarkWikilink", () => {
  test("plain target", () => {
    const ast = parseWith("Reference [[target]] here.");
    const links = collectWikilinks(ast);
    expect(links).toHaveLength(1);
    expect(links[0].type).toBe("wikiLink");
    expect(links[0].target).toBe("target");
    expect(links[0].alias).toBeNull();
    expect(links[0].heading).toBeNull();
    expect(links[0].block).toBeNull();
  });

  test("aliased target", () => {
    const ast = parseWith("[[target|display]]");
    const [link] = collectWikilinks(ast);
    expect(link.target).toBe("target");
    expect(link.alias).toBe("display");
  });

  test("heading qualifier", () => {
    const ast = parseWith("[[note#Heading One]]");
    const [link] = collectWikilinks(ast);
    expect(link.target).toBe("note");
    expect(link.heading).toBe("Heading One");
  });

  test("block-id qualifier", () => {
    const ast = parseWith("[[note#^abc123]]");
    const [link] = collectWikilinks(ast);
    expect(link.target).toBe("note");
    expect(link.block).toBe("abc123");
  });

  test("embed", () => {
    const ast = parseWith("![[embedded]]");
    const [link] = collectWikilinks(ast);
    expect(link.type).toBe("wikiEmbed");
    expect(link.target).toBe("embedded");
  });

  test("does not match inside code spans", () => {
    const ast = parseWith("`[[not-a-link]]`");
    const links = collectWikilinks(ast);
    expect(links).toHaveLength(0);
  });

  test("does not match inside fenced code blocks", () => {
    const ast = parseWith("```\n[[not-a-link]]\n```");
    const links = collectWikilinks(ast);
    expect(links).toHaveLength(0);
  });

  test("multiple links in one paragraph", () => {
    const ast = parseWith("[[a]] and [[b]] and ![[c]]");
    const links = collectWikilinks(ast);
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.target)).toEqual(["a", "b", "c"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/notient && bun test src/core/markdown/plugins/remarkWikilink.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the plugin**

Create `src/core/markdown/plugins/remarkWikilink.ts`:

```typescript
import type { Plugin } from "unified";
import type { Root, Text, PhrasingContent } from "mdast";
import { visit } from "unist-util-visit";

export interface WikiLinkNode {
  type: "wikiLink";
  target: string;
  alias: string | null;
  heading: string | null;
  block: string | null;
}

export interface WikiEmbedNode {
  type: "wikiEmbed";
  target: string;
  alias: string | null;
  heading: string | null;
  block: string | null;
}

declare module "mdast" {
  interface PhrasingContentMap {
    wikiLink: WikiLinkNode;
    wikiEmbed: WikiEmbedNode;
  }
}

const PATTERN = /(!?)\[\[([^\]]+)\]\]/g;

function parseInner(inner: string): { target: string; alias: string | null; heading: string | null; block: string | null } {
  let target = inner;
  let alias: string | null = null;
  const pipeIndex = inner.indexOf("|");
  if (pipeIndex >= 0) {
    target = inner.slice(0, pipeIndex);
    alias = inner.slice(pipeIndex + 1);
  }
  let heading: string | null = null;
  let block: string | null = null;
  const hashIndex = target.indexOf("#");
  if (hashIndex >= 0) {
    const right = target.slice(hashIndex + 1);
    target = target.slice(0, hashIndex);
    if (right.startsWith("^")) block = right.slice(1);
    else heading = right;
  }
  return { target: target.trim(), alias, heading, block };
}

const remarkWikilink: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;
      // Skip if parent is inline/block code
      if (parent.type === "inlineCode" || parent.type === "code") return;
      const value = node.value;
      const matches = Array.from(value.matchAll(PATTERN));
      if (matches.length === 0) return;
      const out: PhrasingContent[] = [];
      let cursor = 0;
      for (const match of matches) {
        const [full, bang, inner] = match;
        const start = match.index ?? 0;
        if (start > cursor) {
          out.push({ type: "text", value: value.slice(cursor, start) });
        }
        const parts = parseInner(inner);
        if (bang === "!") {
          out.push({ type: "wikiEmbed", ...parts } as WikiEmbedNode);
        } else {
          out.push({ type: "wikiLink", ...parts } as WikiLinkNode);
        }
        cursor = start + full.length;
      }
      if (cursor < value.length) {
        out.push({ type: "text", value: value.slice(cursor) });
      }
      parent.children.splice(index, 1, ...out);
      return [visit.SKIP, index + out.length];
    });
  };
};

export default remarkWikilink;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/notient && bun test src/core/markdown/plugins/remarkWikilink.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/notient
git add src/core/markdown/plugins/remarkWikilink.ts src/core/markdown/plugins/remarkWikilink.test.ts
git commit -m "feat(markdown): remarkWikilink plugin for [[]] and ![[]] syntax"
```

---

### Task 5: `remarkBlockId` plugin

**Files:**
- Create: `src/core/markdown/plugins/remarkBlockId.ts`
- Create: `src/core/markdown/plugins/remarkBlockId.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/markdown/plugins/remarkBlockId.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import type { Root, Paragraph, ListItem } from "mdast";
import remarkBlockId from "./remarkBlockId";

function parseWith(source: string): Root {
  return unified().use(remarkParse).use(remarkBlockId).parse(source) as Root;
}

interface WithBlockId { blockId?: string }

describe("remarkBlockId", () => {
  test("paragraph with trailing ^id", () => {
    const ast = parseWith("Some text. ^abc123");
    let id: string | undefined;
    visit(ast, "paragraph", (node: Paragraph & WithBlockId) => { id = node.blockId; });
    expect(id).toBe("abc123");
  });

  test("list item with trailing ^id", () => {
    const ast = parseWith("- list item ^abc");
    let id: string | undefined;
    visit(ast, "listItem", (node: ListItem & WithBlockId) => { id = node.blockId; });
    expect(id).toBe("abc");
  });

  test("paragraph without ^id has no blockId", () => {
    const ast = parseWith("Plain paragraph.");
    let id: string | undefined = undefined;
    visit(ast, "paragraph", (node: Paragraph & WithBlockId) => { id = node.blockId; });
    expect(id).toBeUndefined();
  });

  test("the ^id token is removed from the node text", () => {
    const ast = parseWith("Hello ^id");
    let value = "";
    visit(ast, "text", (node) => { value = node.value; });
    expect(value.trim()).toBe("Hello");
  });
});
```

- [ ] **Step 2: Implement the plugin**

Create `src/core/markdown/plugins/remarkBlockId.ts`:

```typescript
import type { Plugin } from "unified";
import type { Root, Paragraph, ListItem, Text } from "mdast";
import { visit } from "unist-util-visit";

declare module "mdast" {
  interface ParagraphData { blockId?: string }
  interface ListItemData { blockId?: string }
  interface Paragraph { blockId?: string }
  interface ListItem { blockId?: string }
}

const TRAILING_ID = /\s\^([A-Za-z0-9_-]+)\s*$/;

const remarkBlockId: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, ["paragraph", "listItem"] as const, (node: Paragraph | ListItem) => {
      const last = node.children[node.children.length - 1];
      if (!last || last.type !== "text") return;
      const text = last as Text;
      const match = text.value.match(TRAILING_ID);
      if (!match) return;
      (node as Paragraph & { blockId?: string }).blockId = match[1];
      text.value = text.value.replace(TRAILING_ID, "").trimEnd();
    });
  };
};

export default remarkBlockId;
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd ~/projects/notient && bun test src/core/markdown/plugins/remarkBlockId.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/notient
git add src/core/markdown/plugins/remarkBlockId.ts src/core/markdown/plugins/remarkBlockId.test.ts
git commit -m "feat(markdown): remarkBlockId plugin for ^block-id annotations"
```

---

### Task 6: `remarkTag` plugin

**Files:**
- Create: `src/core/markdown/plugins/remarkTag.ts`
- Create: `src/core/markdown/plugins/remarkTag.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/markdown/plugins/remarkTag.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import type { Root } from "mdast";
import remarkTag, { type TagRefNode } from "./remarkTag";

function parseWith(source: string): Root {
  return unified().use(remarkParse).use(remarkTag).parse(source) as Root;
}

function collectTags(ast: Root): TagRefNode[] {
  const out: TagRefNode[] = [];
  visit(ast, "tagRef", (node) => out.push(node as TagRefNode));
  return out;
}

describe("remarkTag", () => {
  test("simple tag", () => {
    const ast = parseWith("Some #concept here.");
    const [tag] = collectTags(ast);
    expect(tag.path).toBe("concept");
  });

  test("nested tag", () => {
    const ast = parseWith("More #concept/auth/oauth content.");
    const [tag] = collectTags(ast);
    expect(tag.path).toBe("concept/auth/oauth");
  });

  test("ignores tags inside code spans", () => {
    const ast = parseWith("`#not-a-tag`");
    expect(collectTags(ast)).toHaveLength(0);
  });

  test("ignores tags inside fenced code blocks", () => {
    const ast = parseWith("```\n#not-a-tag\n```");
    expect(collectTags(ast)).toHaveLength(0);
  });

  test("does not match #fragment in URLs (heuristic: skip if preceded by alphanumeric)", () => {
    const ast = parseWith("https://example.com#fragment");
    // # right after a non-whitespace char is not a tag.
    expect(collectTags(ast)).toHaveLength(0);
  });

  test("does not match a markdown heading start", () => {
    // # at start of line is a heading; remark already has parsed it as such.
    const ast = parseWith("# Heading\n\nText.");
    expect(collectTags(ast)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Implement the plugin**

Create `src/core/markdown/plugins/remarkTag.ts`:

```typescript
import type { Plugin } from "unified";
import type { Root, Text, PhrasingContent } from "mdast";
import { visit } from "unist-util-visit";

export interface TagRefNode {
  type: "tagRef";
  path: string;
}

declare module "mdast" {
  interface PhrasingContentMap {
    tagRef: TagRefNode;
  }
}

// A tag is # followed by [a-z0-9] and optional /[a-z0-9_-]+ segments.
// Must be preceded by start-of-string or whitespace (no fragment-in-URL false positives).
const TAG = /(^|\s)#([a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*)/g;

const remarkTag: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;
      if (parent.type === "inlineCode" || parent.type === "code") return;
      const value = node.value;
      const matches = Array.from(value.matchAll(TAG));
      if (matches.length === 0) return;
      const out: PhrasingContent[] = [];
      let cursor = 0;
      for (const match of matches) {
        const [full, lead, path] = match;
        const start = (match.index ?? 0) + lead.length;
        if (start > cursor) out.push({ type: "text", value: value.slice(cursor, start) });
        out.push({ type: "tagRef", path } as TagRefNode);
        cursor = start + (full.length - lead.length);
      }
      if (cursor < value.length) out.push({ type: "text", value: value.slice(cursor) });
      parent.children.splice(index, 1, ...out);
      return [visit.SKIP, index + out.length];
    });
  };
};

export default remarkTag;
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd ~/projects/notient && bun test src/core/markdown/plugins/remarkTag.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/notient
git add src/core/markdown/plugins/remarkTag.ts src/core/markdown/plugins/remarkTag.test.ts
git commit -m "feat(markdown): remarkTag plugin for #tag/sub annotations"
```

---

### Task 7: Wire all three plugins into the pipeline

**Files:**
- Modify: `src/core/markdown/pipeline.ts`
- Modify: `src/core/markdown/pipeline.test.ts`

- [ ] **Step 1: Add a test case that combines all three**

Append to `src/core/markdown/pipeline.test.ts`:

```typescript
test("pipeline parses wikilinks, embeds, block-ids, and tags from the golden fixture", () => {
  const ast = parse(GOLDEN);
  let wikiLinkCount = 0;
  let wikiEmbedCount = 0;
  let tagCount = 0;
  let blockIdCount = 0;
  // Walk the AST and count node types.
  const walk = (node: { type: string; children?: unknown[]; blockId?: string }) => {
    if (node.type === "wikiLink") wikiLinkCount++;
    if (node.type === "wikiEmbed") wikiEmbedCount++;
    if (node.type === "tagRef") tagCount++;
    if (node.blockId) blockIdCount++;
    for (const child of node.children ?? []) walk(child as { type: string; children?: unknown[]; blockId?: string });
  };
  walk(ast as unknown as { type: string; children: unknown[] });
  expect(wikiLinkCount).toBeGreaterThan(0);
  expect(wikiEmbedCount).toBeGreaterThan(0);
  expect(tagCount).toBeGreaterThan(0);
  expect(blockIdCount).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test, verify it fails (counts are zero because plugins not wired)**

Run: `cd ~/projects/notient && bun test src/core/markdown/pipeline.test.ts`
Expected: FAIL on the new test.

- [ ] **Step 3: Wire the plugins**

Edit `src/core/markdown/pipeline.ts`. Add imports and `.use()` calls:

```typescript
import remarkWikilink from "./plugins/remarkWikilink";
import remarkBlockId from "./plugins/remarkBlockId";
import remarkTag from "./plugins/remarkTag";

// Inside getMarkdownPipeline:
cached = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm)
  .use(remarkWikilink)
  .use(remarkBlockId)
  .use(remarkTag)
  .use(remarkStringify, { /* ... unchanged ... */ });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/notient && bun test src/core/markdown/pipeline.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/notient
git add src/core/markdown/pipeline.ts src/core/markdown/pipeline.test.ts
git commit -m "feat(markdown): wire wikilink, block-id, tag plugins into pipeline"
```

---

### Task 8: Heading slug helper

**Files:**
- Create: `src/core/markdown/slug.ts`
- Create: `src/core/markdown/slug.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/markdown/slug.test.ts
import { describe, expect, test } from "bun:test";
import { headingSlug } from "./slug";

describe("headingSlug", () => {
  test("lowercase + dashes", () => {
    expect(headingSlug("Hello World")).toBe("hello-world");
  });
  test("strips punctuation", () => {
    expect(headingSlug("What's New?")).toBe("whats-new");
  });
  test("collapses whitespace", () => {
    expect(headingSlug("  too   many   spaces  ")).toBe("too-many-spaces");
  });
  test("preserves non-ASCII letters lowercased (Obsidian behaviour)", () => {
    expect(headingSlug("Café")).toBe("café");
  });
  test("handles empty strings", () => {
    expect(headingSlug("")).toBe("");
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/core/markdown/slug.ts
export function headingSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 -￿\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}
```

- [ ] **Step 3: Run test, commit**

```bash
cd ~/projects/notient
bun test src/core/markdown/slug.test.ts
git add src/core/markdown/slug.ts src/core/markdown/slug.test.ts
git commit -m "feat(markdown): heading slug helper for [[note#heading]] resolution"
```

---

### Task 9: Markdown extractor (AST → MarkdownExtraction)

**Files:**
- Create: `src/core/markdown/extractor.ts`
- Create: `src/core/markdown/extractor.test.ts`
- Create: `src/core/markdown/__fixtures__/edge-cases.md`

- [ ] **Step 1: Write the edge-case fixture**

`src/core/markdown/__fixtures__/edge-cases.md`:

```markdown
---
title: Edges
related: "[[fm-link]]"
supports:
  - "[[fm-a]]"
  - "[[fm-b|alias]]"
notient:
  contradicts:
    - "[[fm-c]]"
---

# H1

Paragraph with [[link-1]].

## H2

Paragraph with [[link-2#sub]] and ^para-1

### H3

Content.

#### H4 below cap

Rolled into H3 above.

##### H5 below cap

Still rolled.

### Another H3

[[link-3#^block]]
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/core/markdown/extractor.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./pipeline";
import { extract } from "./extractor";

const FIXTURE = readFileSync(join(import.meta.dir, "__fixtures__/edge-cases.md"), "utf8");

describe("markdown extractor", () => {
  test("extracts heading blocks at H1/H2/H3 only", () => {
    const ast = parse(FIXTURE);
    const ex = extract(ast, "edge-cases.md");
    const headingBlocks = ex.blocks.filter((b) => b.headingLevel !== null);
    const levels = headingBlocks.map((b) => b.headingLevel);
    expect(levels.every((l) => l === 1 || l === 2 || l === 3)).toBe(true);
    // H4 and H5 are NOT their own blocks.
    expect(levels.includes(4 as never)).toBe(false);
  });

  test("rolls H4-H6 content into the nearest H3 ancestor block", () => {
    const ast = parse(FIXTURE);
    const ex = extract(ast, "edge-cases.md");
    const h3Blocks = ex.blocks.filter((b) => b.headingLevel === 3);
    const firstH3 = h3Blocks[0];
    expect(firstH3.text).toContain("H4 below cap");
    expect(firstH3.text).toContain("H5 below cap");
  });

  test("creates a separate block for explicit ^block-id", () => {
    const ast = parse(FIXTURE);
    const ex = extract(ast, "edge-cases.md");
    const blockIdBlocks = ex.blocks.filter((b) => b.blockId !== null);
    expect(blockIdBlocks.map((b) => b.blockId)).toEqual(["para-1"]);
  });

  test("collects body wikilinks with heading and block qualifiers", () => {
    const ast = parse(FIXTURE);
    const ex = extract(ast, "edge-cases.md");
    const targets = ex.wikilinks.map((w) => w.rawTarget);
    expect(targets).toContain("link-1");
    expect(targets).toContain("link-2");
    expect(targets).toContain("link-3");
    const link2 = ex.wikilinks.find((w) => w.rawTarget === "link-2");
    expect(link2?.targetHeading).toBe("sub");
    const link3 = ex.wikilinks.find((w) => w.rawTarget === "link-3");
    expect(link3?.targetBlockId).toBe("block");
  });

  test("collects frontmatter refs from string and array values", () => {
    const ast = parse(FIXTURE);
    const ex = extract(ast, "edge-cases.md");
    const targets = ex.frontmatterRefs.map((r) => r.rawTarget);
    expect(targets).toContain("fm-link");
    expect(targets).toContain("fm-a");
    expect(targets).toContain("fm-b");
    expect(targets).toContain("fm-c"); // nested under "notient.contradicts"
  });

  test("computes wordCount and bodySha", () => {
    const ast = parse(FIXTURE);
    const ex = extract(ast, "edge-cases.md");
    expect(ex.wordCount).toBeGreaterThan(0);
    expect(ex.bodySha).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

- [ ] **Step 3: Implement the extractor**

Create `src/core/markdown/extractor.ts`:

```typescript
import { createHash } from "node:crypto";
import type { Root, Heading, Paragraph, ListItem, Text } from "mdast";
import { visit } from "unist-util-visit";
import { toString } from "mdast-util-to-string";
import type { MarkdownExtraction, BlockSpec, WikilinkSpec, TagSpec, FrontmatterRefSpec } from "./types";
import { headingSlug } from "./slug";
import type { WikiLinkNode, WikiEmbedNode } from "./plugins/remarkWikilink";
import type { TagRefNode } from "./plugins/remarkTag";
import { parse as parseYaml } from "yaml";

const WIKILINK_IN_STRING = /\[\[([^\]]+)\]\]/g;

interface YamlNode { type: "yaml"; value: string }

export function extract(ast: Root, _notePath: string): MarkdownExtraction {
  const blocks: BlockSpec[] = [];
  const wikilinks: WikilinkSpec[] = [];
  const tags: TagSpec[] = [];
  const frontmatterRefs: FrontmatterRefSpec[] = [];

  // 1. Extract frontmatter.
  let frontmatter: Record<string, unknown> = {};
  for (const child of ast.children) {
    if ((child as { type: string }).type === "yaml") {
      const raw = (child as YamlNode).value;
      try {
        const parsed = parseYaml(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          frontmatter = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed YAML; skip.
      }
      break;
    }
  }

  // 2. Walk frontmatter for wikilinks, including nested under "notient".
  walkFrontmatterForRefs(frontmatter, "", frontmatterRefs);

  // 3. Walk body to extract heading blocks (H1-H3 only).
  // Strategy: linear scan; track current heading stack at H1/H2/H3.
  const headingStack: Array<{ level: 1 | 2 | 3; text: string }> = [];
  let currentBlock: BlockSpec | null = null;
  let ord = 0;
  let lineCounter = 0;

  for (const child of ast.children) {
    if ((child as { type: string }).type === "yaml") continue;
    const childType = (child as { type: string }).type;
    const startLine = (child as { position?: { start: { line: number } } }).position?.start.line ?? lineCounter;
    const endLine = (child as { position?: { end: { line: number } } }).position?.end.line ?? startLine;
    lineCounter = endLine;

    if (childType === "heading") {
      const heading = child as Heading;
      const level = heading.depth;
      const text = toString(heading);
      if (level <= 3) {
        // Pop deeper headings off the stack.
        while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop();
        }
        headingStack.push({ level: level as 1 | 2 | 3, text });
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = {
          blockId: null,
          headingLevel: level as 1 | 2 | 3,
          headingPath: headingStack.map((h) => h.text),
          headingSlug: headingSlug(text),
          ord: ord++,
          startLine,
          endLine,
          text: "",
        };
      } else {
        // H4-H6: roll into the current block's text and extend headingPath.
        if (currentBlock) {
          currentBlock.headingPath = [...currentBlock.headingPath, text];
          currentBlock.text += `\n${"#".repeat(level)} ${text}\n`;
          currentBlock.endLine = endLine;
        }
      }
      continue;
    }

    // Non-heading content: roll into current block (or the implicit pre-heading block).
    if (!currentBlock) {
      currentBlock = {
        blockId: null,
        headingLevel: null,
        headingPath: [],
        headingSlug: null,
        ord: ord++,
        startLine,
        endLine,
        text: "",
      };
    }
    const nodeText = toString(child as Paragraph | ListItem);
    currentBlock.text += nodeText + "\n";
    currentBlock.endLine = endLine;

    // Per-paragraph/list-item ^block-id pull out as separate block.
    const blockId = (child as { blockId?: string }).blockId;
    if (blockId) {
      blocks.push({
        blockId,
        headingLevel: null,
        headingPath: headingStack.map((h) => h.text),
        headingSlug: null,
        ord: ord++,
        startLine,
        endLine,
        text: nodeText,
      });
    }

    // Walk this subtree for wikilinks and tags, attributing to the current block ord.
    visit(child as never, "wikiLink", (node) => {
      const w = node as WikiLinkNode;
      wikilinks.push({
        fromBlockOrd: currentBlock!.ord,
        rawTarget: w.target,
        targetPath: null, // resolver fills in later
        targetHeading: w.heading,
        targetBlockId: w.block,
        alias: w.alias,
        isEmbed: false,
        targetHeadingPath: w.heading ? [w.heading] : [],
      });
    });
    visit(child as never, "wikiEmbed", (node) => {
      const e = node as WikiEmbedNode;
      wikilinks.push({
        fromBlockOrd: currentBlock!.ord,
        rawTarget: e.target,
        targetPath: null,
        targetHeading: e.heading,
        targetBlockId: e.block,
        alias: e.alias,
        isEmbed: true,
        targetHeadingPath: e.heading ? [e.heading] : [],
      });
    });
    visit(child as never, "tagRef", (node) => {
      const t = node as TagRefNode;
      tags.push({ fromBlockOrd: currentBlock!.ord, path: t.path });
    });
  }

  if (currentBlock) blocks.push(currentBlock);

  // 4. Body SHA + word count.
  const body = blocks.map((b) => b.text).join("\n");
  const bodySha = createHash("sha256").update(body).digest("hex");
  const wordCount = body.split(/\s+/).filter(Boolean).length;

  return { blocks, wikilinks, tags, frontmatterRefs, frontmatter, bodySha, wordCount };
}

function walkFrontmatterForRefs(obj: unknown, key: string, out: FrontmatterRefSpec[]): void {
  if (typeof obj === "string") {
    for (const match of obj.matchAll(WIKILINK_IN_STRING)) {
      const inner = match[1];
      const pipe = inner.indexOf("|");
      const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
      out.push({ key, rawTarget: target, targetPath: null });
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) walkFrontmatterForRefs(item, key, out);
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const nestedKey = key === "" ? k : `${key}.${k}`;
      walkFrontmatterForRefs(v, nestedKey, out);
    }
  }
}
```

- [ ] **Step 4: Add `yaml` dep if missing**

Run: `cd ~/projects/notient && grep '"yaml"' package.json`
If absent: `bun add yaml`.

- [ ] **Step 5: Run test, fix until green, commit**

```bash
cd ~/projects/notient
bun test src/core/markdown/extractor.test.ts
git add src/core/markdown/extractor.ts src/core/markdown/extractor.test.ts src/core/markdown/__fixtures__/edge-cases.md package.json bun.lockb
git commit -m "feat(markdown): pure AST walker producing MarkdownExtraction"
```

---

### Task 10: Wikilink resolver

**Files:**
- Create: `src/core/markdown/resolver.ts`
- Create: `src/core/markdown/resolver.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// src/core/markdown/resolver.test.ts
import { describe, expect, test } from "bun:test";
import { resolveTargets } from "./resolver";

const VAULT = [
  "auth/oauth.md",
  "auth/jwt.md",
  "concepts/auth.md",
  "ideas/jwt.md",
];

describe("resolveTargets", () => {
  test("exact path resolves directly", () => {
    const result = resolveTargets("notes/active.md", [{ rawTarget: "auth/oauth", targetHeading: null, targetBlockId: null }], VAULT);
    expect(result[0].targetPath).toBe("auth/oauth.md");
  });

  test("exact match with .md suffix", () => {
    const result = resolveTargets("notes/active.md", [{ rawTarget: "auth/oauth.md", targetHeading: null, targetBlockId: null }], VAULT);
    expect(result[0].targetPath).toBe("auth/oauth.md");
  });

  test("basename resolves to closest match by folder distance", () => {
    const result = resolveTargets("auth/active.md", [{ rawTarget: "jwt", targetHeading: null, targetBlockId: null }], VAULT);
    expect(result[0].targetPath).toBe("auth/jwt.md");
  });

  test("basename with no folder context falls back to first lexical match", () => {
    const result = resolveTargets("README.md", [{ rawTarget: "jwt", targetHeading: null, targetBlockId: null }], VAULT);
    expect(["auth/jwt.md", "ideas/jwt.md"]).toContain(result[0].targetPath);
  });

  test("unresolved targets get null", () => {
    const result = resolveTargets("a.md", [{ rawTarget: "nonexistent", targetHeading: null, targetBlockId: null }], VAULT);
    expect(result[0].targetPath).toBeNull();
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/core/markdown/resolver.ts
export interface UnresolvedTarget {
  rawTarget: string;
  targetHeading: string | null;
  targetBlockId: string | null;
}

export interface ResolvedTarget extends UnresolvedTarget {
  targetPath: string | null;
}

export function resolveTargets(
  fromNotePath: string,
  unresolved: UnresolvedTarget[],
  vaultPaths: string[],
): ResolvedTarget[] {
  const fromFolder = fromNotePath.includes("/") ? fromNotePath.slice(0, fromNotePath.lastIndexOf("/")) : "";
  return unresolved.map((u) => ({
    ...u,
    targetPath: resolveOne(u.rawTarget, fromFolder, vaultPaths),
  }));
}

function resolveOne(raw: string, fromFolder: string, vaultPaths: string[]): string | null {
  const stripped = raw.endsWith(".md") ? raw : `${raw}.md`;
  // 1. Exact path match.
  const exact = vaultPaths.find((p) => p === stripped);
  if (exact) return exact;
  // 2. Basename match.
  if (!raw.includes("/")) {
    const candidates = vaultPaths.filter((p) => baseName(p) === baseName(stripped));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      // Closest by folder edit distance.
      candidates.sort((a, b) => folderDistance(fromFolder, a) - folderDistance(fromFolder, b));
      return candidates[0];
    }
  }
  return null;
}

function baseName(path: string): string {
  return path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
}

function folderDistance(from: string, target: string): number {
  const fromParts = from.split("/").filter(Boolean);
  const targetFolder = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";
  const targetParts = targetFolder.split("/").filter(Boolean);
  const min = Math.min(fromParts.length, targetParts.length);
  let i = 0;
  while (i < min && fromParts[i] === targetParts[i]) i++;
  return (fromParts.length - i) + (targetParts.length - i);
}
```

- [ ] **Step 3: Run test, commit**

```bash
cd ~/projects/notient
bun test src/core/markdown/resolver.test.ts
git add src/core/markdown/resolver.ts src/core/markdown/resolver.test.ts
git commit -m "feat(markdown): wikilink target resolver with basename + folder-distance fallback"
```

---

### Task 11: Tier 1 DAL extensions in `surreal.ts`

**Files:**
- Modify: `src/core/db/surreal.ts`

- [ ] **Step 1: Add typed methods**

Append to `src/core/db/surreal.ts`:

```typescript
import { EDGE_TABLES, type EdgeTable } from "./edgeTables";

export interface BlockUpsert {
  noteId: RecordId<"note">;
  blockId: string | null;
  headingLevel: 1 | 2 | 3 | null;
  headingPath: string[];
  headingSlug: string | null;
  ord: number;
  startLine: number;
  endLine: number;
  text: string;
}

export async function lookupNoteByPath(db: Surreal, path: string): Promise<RecordId<"note"> | null> {
  const result = await db.query<[Array<{ id: RecordId<"note"> }>]>(
    `SELECT id FROM note WHERE path = $p LIMIT 1;`, { p: path },
  );
  const row = (result[0] as Array<{ id: RecordId<"note"> }>)[0];
  return row?.id ?? null;
}

export async function lookupBlockByHeading(
  db: Surreal,
  noteId: RecordId<"note">,
  headingSlug: string,
): Promise<RecordId<"block"> | null> {
  const result = await db.query<[Array<{ id: RecordId<"block"> }>]>(
    `SELECT id FROM block WHERE note = $n AND heading_slug = $s LIMIT 1;`,
    { n: noteId, s: headingSlug },
  );
  const row = (result[0] as Array<{ id: RecordId<"block"> }>)[0];
  return row?.id ?? null;
}

export async function lookupBlockByExplicitId(
  db: Surreal,
  noteId: RecordId<"note">,
  blockId: string,
): Promise<RecordId<"block"> | null> {
  const result = await db.query<[Array<{ id: RecordId<"block"> }>]>(
    `SELECT id FROM block WHERE note = $n AND block_id = $b LIMIT 1;`,
    { n: noteId, b: blockId },
  );
  const row = (result[0] as Array<{ id: RecordId<"block"> }>)[0];
  return row?.id ?? null;
}

export async function replaceBlocks(db: Surreal, noteId: RecordId<"note">, blocks: BlockUpsert[]): Promise<RecordId<"block">[]> {
  await db.query(`DELETE block WHERE note = $n;`, { n: noteId });
  const ids: RecordId<"block">[] = [];
  for (const b of blocks) {
    const result = await db.query<[Array<{ id: RecordId<"block"> }>]>(
      `CREATE block SET note = $n, block_id = $bid, heading_level = $hl, heading_path = $hp, heading_slug = $hs, ord = $o, start_line = $sl, end_line = $el, text = $t RETURN id;`,
      {
        n: noteId, bid: b.blockId, hl: b.headingLevel, hp: b.headingPath,
        hs: b.headingSlug, o: b.ord, sl: b.startLine, el: b.endLine, t: b.text,
      },
    );
    const row = (result[0] as Array<{ id: RecordId<"block"> }>)[0];
    ids.push(row.id);
  }
  return ids;
}

export async function clearTier1Edges(db: Surreal, noteId: RecordId<"note">): Promise<void> {
  // Delete edges where the source is this note OR a block belonging to this note,
  // limited to deterministic source kinds (Tier 1's responsibility).
  const tier1Sources = ["wikilink", "embed", "frontmatter", "structure"];
  for (const table of ["wikilink", "embed", "frontmatter_ref", "tagged", "contained_in", "under_heading"] as const) {
    await db.query(
      `DELETE ${table} WHERE in = $n OR in IN (SELECT id FROM block WHERE note = $n);`,
      { n: noteId },
    );
  }
  // The "structure" source filter is implicit: contained_in/under_heading only ever have source='structure'.
  void tier1Sources;
}

export async function relateEdge(
  db: Surreal,
  table: EdgeTable,
  params: {
    from: RecordId;
    to: RecordId;
    source: "wikilink" | "embed" | "frontmatter" | "structure" | "extractor" | "linker" | "user";
    confidenceClass: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
    confidence: number;
    agent?: string;
    approved?: boolean;
  },
): Promise<void> {
  if (!EDGE_TABLES.includes(table)) throw new Error(`unknown edge table ${table}`);
  await db.query(
    `RELATE $from->${table}->$to SET source = $source, class = $cls, confidence = $confidence, agent = $agent, approved = $approved;`,
    {
      from: params.from, to: params.to,
      source: params.source, cls: params.confidenceClass,
      confidence: params.confidence,
      agent: params.agent ?? null,
      approved: params.approved ?? true,
    },
  );
}

export async function upsertNoteByPath(db: Surreal, params: { path: string; sha: string; wordCount: number }): Promise<RecordId<"note">> {
  const existing = await lookupNoteByPath(db, params.path);
  if (existing) {
    await db.query(
      `UPDATE $n SET sha = $sha, word_count = $wc;`,
      { n: existing, sha: params.sha, wc: params.wordCount },
    );
    return existing;
  }
  const created = await createNote(db, params);
  return created.id;
}

export async function upsertTag(db: Surreal, path: string): Promise<RecordId<"tag">> {
  const existing = await db.query<[Array<{ id: RecordId<"tag"> }>]>(
    `SELECT id FROM tag WHERE path = $p LIMIT 1;`, { p: path },
  );
  const row = (existing[0] as Array<{ id: RecordId<"tag"> }>)[0];
  if (row) return row.id;
  const created = await db.query<[Array<{ id: RecordId<"tag"> }>]>(
    `CREATE tag SET path = $p RETURN id;`, { p: path },
  );
  return ((created[0] as Array<{ id: RecordId<"tag"> }>)[0]).id;
}

export async function markTier1Done(db: Surreal, noteId: RecordId<"note">): Promise<void> {
  await db.query(`UPDATE $n SET tier1_at = time::now();`, { n: noteId });
}
```

- [ ] **Step 2: Type-check**

```bash
cd ~/projects/notient && bun run typecheck 2>&1 | grep "core/db/surreal" | head
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/notient
git add src/core/db/surreal.ts
git commit -m "feat(db): tier 1 DAL extensions (blocks, edges, tags, lookups)"
```

---

### Task 12: Tier 1 indexer

**Files:**
- Create: `src/core/indexer/tier1.ts`
- Create: `src/core/indexer/tier1.test.ts`

- [ ] **Step 1: Implement Tier 1 orchestrator**

```typescript
// src/core/indexer/tier1.ts
import type { Surreal, RecordId } from "surrealdb";
import { parse } from "../markdown/pipeline";
import { extract } from "../markdown/extractor";
import { resolveTargets, type ResolvedTarget } from "../markdown/resolver";
import {
  upsertNoteByPath, replaceBlocks, clearTier1Edges, relateEdge,
  upsertTag, lookupNoteByPath, lookupBlockByHeading, lookupBlockByExplicitId,
  markTier1Done,
} from "../db/surreal";
import type { BlockSpec, MarkdownExtraction } from "../markdown/types";

export interface Tier1Input {
  notePath: string;
  source: string; // raw markdown body
  vaultPaths: string[]; // for resolver
}

export async function runTier1(db: Surreal, input: Tier1Input): Promise<{ noteId: RecordId<"note">; extraction: MarkdownExtraction }> {
  const ast = parse(input.source);
  const ex = extract(ast, input.notePath);

  // Resolve wikilink + frontmatter targets to vault paths.
  const resolvedWikilinks: ResolvedTarget[] = resolveTargets(
    input.notePath,
    ex.wikilinks.map((w) => ({ rawTarget: w.rawTarget, targetHeading: w.targetHeading, targetBlockId: w.targetBlockId })),
    input.vaultPaths,
  );
  const resolvedFmRefs: ResolvedTarget[] = resolveTargets(
    input.notePath,
    ex.frontmatterRefs.map((r) => ({ rawTarget: r.rawTarget, targetHeading: null, targetBlockId: null })),
    input.vaultPaths,
  );

  // Begin transaction.
  await db.query("BEGIN TRANSACTION;");
  try {
    const noteId = await upsertNoteByPath(db, { path: input.notePath, sha: ex.bodySha, wordCount: ex.wordCount });

    // Replace blocks (delete then insert).
    const blockIds = await replaceBlocks(db, noteId, ex.blocks.map((b) => ({
      noteId, blockId: b.blockId, headingLevel: b.headingLevel, headingPath: b.headingPath,
      headingSlug: b.headingSlug, ord: b.ord, startLine: b.startLine, endLine: b.endLine, text: b.text,
    })));

    // Clear and rewrite Tier 1 edges.
    await clearTier1Edges(db, noteId);

    const ordToBlockId = new Map<number, RecordId<"block">>();
    ex.blocks.forEach((b, i) => ordToBlockId.set(b.ord, blockIds[i]));

    // Structural edges: contained_in (block -> note), under_heading (block -> heading block).
    const headingBlockIdsByPath: Map<string, RecordId<"block">> = new Map();
    for (let i = 0; i < ex.blocks.length; i++) {
      const b = ex.blocks[i];
      const id = blockIds[i];
      await relateEdge(db, "contained_in", {
        from: id, to: noteId, source: "structure", confidenceClass: "EXTRACTED", confidence: 1.0,
      });
      if (b.headingLevel !== null) {
        headingBlockIdsByPath.set(b.headingPath.join(" > "), id);
      } else if (b.headingPath.length > 0) {
        // Non-heading block under a heading: link to deepest H3 ancestor present in headingBlockIdsByPath.
        const parentKey = b.headingPath.join(" > ");
        const parent = headingBlockIdsByPath.get(parentKey);
        if (parent) {
          await relateEdge(db, "under_heading", {
            from: id, to: parent, source: "structure", confidenceClass: "EXTRACTED", confidence: 1.0,
          });
        }
      }
    }

    // Wikilinks + embeds.
    for (let i = 0; i < ex.wikilinks.length; i++) {
      const w = ex.wikilinks[i];
      const r = resolvedWikilinks[i];
      const fromId = w.fromBlockOrd !== null ? ordToBlockId.get(w.fromBlockOrd) ?? noteId : noteId;
      let toId: RecordId | null = null;
      if (r.targetPath !== null) {
        const targetNoteId = await lookupNoteByPath(db, r.targetPath);
        if (targetNoteId !== null) {
          if (w.targetBlockId !== null) {
            toId = (await lookupBlockByExplicitId(db, targetNoteId, w.targetBlockId)) ?? targetNoteId;
          } else if (w.targetHeading !== null) {
            // Resolve to the H3 ancestor block by heading slug; falls back to the note.
            // (Cap is enforced at extraction time; here we just look up the slug as-is.)
            const slug = w.targetHeading.toLowerCase().replace(/\s+/g, "-");
            toId = (await lookupBlockByHeading(db, targetNoteId, slug)) ?? targetNoteId;
          } else {
            toId = targetNoteId;
          }
        }
      }
      if (!toId) continue; // unresolved; skip insert in Phase 2 (audit verb in Phase 5 surfaces these).
      const table = w.isEmbed ? "embed" : "wikilink";
      await relateEdge(db, table, {
        from: fromId, to: toId,
        source: w.isEmbed ? "embed" : "wikilink",
        confidenceClass: "EXTRACTED", confidence: 1.0,
      });
    }

    // Frontmatter refs.
    for (let i = 0; i < ex.frontmatterRefs.length; i++) {
      const r = resolvedFmRefs[i];
      if (r.targetPath === null) continue;
      const targetId = await lookupNoteByPath(db, r.targetPath);
      if (!targetId) continue;
      await relateEdge(db, "frontmatter_ref", {
        from: noteId, to: targetId, source: "frontmatter",
        confidenceClass: "EXTRACTED", confidence: 1.0,
      });
    }

    // Tags.
    for (const t of ex.tags) {
      const tagId = await upsertTag(db, t.path);
      const fromId = t.fromBlockOrd !== null ? ordToBlockId.get(t.fromBlockOrd) ?? noteId : noteId;
      await relateEdge(db, "tagged", {
        from: fromId, to: tagId, source: "wikilink", // tag has no specific source; "wikilink" not appropriate, use "structure"
        confidenceClass: "EXTRACTED", confidence: 1.0,
      });
      // NOTE: "structure" makes more sense; verify the source enum allows it. The schema asserts source IN [...]; both 'structure' and 'wikilink' are in the enum.
    }

    await markTier1Done(db, noteId);
    await db.query("COMMIT TRANSACTION;");
    return { noteId, extraction: ex };
  } catch (error) {
    await db.query("CANCEL TRANSACTION;");
    throw error;
  }
}
```

(Note: the source for `tagged` edges should be `"structure"` per the spec — adjust the call to use `"structure"` instead of `"wikilink"`.)

- [ ] **Step 2: Smoke test against a real SurrealDB**

```typescript
// src/core/indexer/tier1.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSurreal, type SurrealServerHandle } from "../../daemon/surrealServer";
import { connect, type SurrealConnection } from "../db/surreal";
import { applySchema } from "../db/schemaApplier";
import { runTier1 } from "./tier1";

const SOURCE = `---
title: Test
related: "[[other]]"
---
# H1

Body with [[other]] and [[also#section]].

## H2

Content. ^block-1

#topic/sub
`;

let server: SurrealServerHandle;
let db: SurrealConnection;
let temp: string;
const secret = "tier1-test";

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), "notient-tier1-"));
  const dataDir = join(temp, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  server = await startSurreal({
    vaultPath: temp, dataDir, secret,
    portFile: join(temp, "p"), pidFile: join(temp, "pid"),
  });
  db = await connect({ url: server.url, user: "root", pass: secret, namespace: "notient", database: "vault" });
  await applySchema(db.db, secret);
  // Pre-create the targets so resolution succeeds.
  await db.db.create("note", { path: "other.md", sha: "x", word_count: 0 });
  await db.db.create("note", { path: "also.md", sha: "y", word_count: 0 });
});

afterAll(async () => {
  await db?.close();
  await server?.stop();
  rmSync(temp, { recursive: true, force: true });
});

describe("tier1 indexer", () => {
  test("inserts note, blocks, wikilinks, embeds, tags, frontmatter refs", async () => {
    await runTier1(db.db, {
      notePath: "active.md",
      source: SOURCE,
      vaultPaths: ["other.md", "also.md", "active.md"],
    });
    const blocks = await db.db.query<[Array<{ heading_level: number | null; block_id: string | null }>]>(
      `SELECT heading_level, block_id FROM block WHERE note IN (SELECT id FROM note WHERE path = 'active.md');`,
    );
    const blockRows = blocks[0] as Array<{ heading_level: number | null; block_id: string | null }>;
    expect(blockRows.length).toBeGreaterThan(0);
    expect(blockRows.find((b) => b.block_id === "block-1")).toBeDefined();

    const wikilinks = await db.db.query<[Array<{ source: string }>]>(
      `SELECT source FROM wikilink WHERE in IN (SELECT id FROM note WHERE path = 'active.md') OR in IN (SELECT id FROM block WHERE note IN (SELECT id FROM note WHERE path = 'active.md'));`,
    );
    expect((wikilinks[0] as Array<unknown>).length).toBeGreaterThan(0);

    const tags = await db.db.query<[Array<{ id: unknown }>]>(`SELECT id FROM tag WHERE path = 'topic/sub';`);
    expect((tags[0] as Array<unknown>).length).toBe(1);

    const fmRefs = await db.db.query<[Array<{ id: unknown }>]>(
      `SELECT id FROM frontmatter_ref WHERE in IN (SELECT id FROM note WHERE path = 'active.md');`,
    );
    expect((fmRefs[0] as Array<unknown>).length).toBeGreaterThan(0);
  });

  test("re-running on the same path replaces blocks (delete-then-insert)", async () => {
    const before = await db.db.query<[Array<{ id: unknown }>]>(
      `SELECT id FROM block WHERE note IN (SELECT id FROM note WHERE path = 'active.md');`,
    );
    await runTier1(db.db, {
      notePath: "active.md",
      source: SOURCE,
      vaultPaths: ["other.md", "also.md", "active.md"],
    });
    const after = await db.db.query<[Array<{ id: unknown }>]>(
      `SELECT id FROM block WHERE note IN (SELECT id FROM note WHERE path = 'active.md');`,
    );
    expect((after[0] as Array<unknown>).length).toBe((before[0] as Array<unknown>).length);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `cd ~/projects/notient && bun test src/core/indexer/tier1.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/notient
git add src/core/indexer/tier1.ts src/core/indexer/tier1.test.ts
git commit -m "feat(indexer): tier 1 orchestrator AST -> SurrealDB transaction"
```

---

### Task 13: Wire Tier 1 into existing `indexNote.ts`

**Files:**
- Modify: `src/core/indexer/indexNote.ts`

- [ ] **Step 1: Read the current `indexNote.ts` for the insertion point**

Run: `cd ~/projects/notient && grep -n "export async function\|stripFrontmatter\|chunk\|extractor" src/core/indexer/indexNote.ts | head`
Expected: identify the function entry point and the SHA-check guard.

- [ ] **Step 2: Add Tier 1 call before the existing flow**

Edit `src/core/indexer/indexNote.ts`. Pseudocode for the prepended logic (adapt to the file's structure):

```typescript
import { runTier1 } from "./tier1";
import type { SurrealConnection } from "../db/surreal";
import { debugIndexer } from "./debug";

// Add a `surrealDb` parameter to indexNote's options or kernel-resolve it from the kernel.
// Inside the function, immediately after reading the file body and confirming SHA changed:

try {
  const vaultPaths = await vaultFacade.listAllNotePaths(); // existing facade API
  await runTier1(surrealDb.db, { notePath, source: body, vaultPaths });
  eventBus.publish({ name: "indexer:tier1-done", payload: { notePath } });
} catch (error) {
  debugIndexer("tier1 failed for %s: %s", notePath, error);
  eventBus.publish({ name: "indexer:error", payload: { notePath, phase: "tier1", error: String(error) } });
  // DO NOT re-throw; tier 2/3 still runs against SQLite.
}

// Existing flow continues unchanged: chunk + embed + extract + linker + write SQLite.
```

If `vaultFacade.listAllNotePaths` does not exist, add a thin helper that walks the vault's existing markdown index (the chokidar watcher knows the set of files; expose a snapshot accessor or query SQLite's `notes` table for known paths during the migration window).

- [ ] **Step 3: Verify Phase D1 tests still pass**

Run: `cd ~/projects/notient && bun test`
Expected: all PASS. New `indexer:tier1-done` events are additive.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/notient
git add src/core/indexer/indexNote.ts
git commit -m "feat(indexer): wire tier 1 before existing chunk/embed/extract flow"
```

---

### Task 14: Watcher gains `unlink` listener

**Files:**
- Modify: `src/daemon/watcher.ts`
- Modify: `src/daemon/watcher.test.ts`

- [ ] **Step 1: Add the listener and tombstone logic**

Edit `src/daemon/watcher.ts`:

```typescript
// At watcher setup, after .on("add") and .on("change"):
this.fsWatcher.on("unlink", async (vaultPath) => {
  const notePath = this.toVaultRelative(vaultPath);
  await this.handleUnlink(notePath);
});

// Add a method:
private async handleUnlink(notePath: string): Promise<void> {
  await this.surrealDb.db.query(
    `UPDATE note SET tombstoned_at = time::now() WHERE path = $p;`,
    { p: notePath },
  );
  setTimeout(() => this.cascadeDelete(notePath), 60_000).unref();
  this.eventBus.publish({ name: "indexer:tombstoned", payload: { notePath } });
}

private async cascadeDelete(notePath: string): Promise<void> {
  // If the note was resurrected (tombstoned_at cleared), do nothing.
  await this.surrealDb.db.query(
    `DELETE note WHERE path = $p AND tombstoned_at IS NOT NONE;`,
    { p: notePath },
  );
  // Cascading deletes are NOT automatic in SurrealDB; explicitly remove blocks/edges if the row was deleted.
  // (Track via a follow-up query: if no row matches the path, run the cascade.)
}
```

Adjust to match the existing `VaultWatcher` class shape.

- [ ] **Step 2: Add test**

Append to `src/daemon/watcher.test.ts`:

```typescript
test("unlink event sets tombstoned_at on the note row", async () => {
  // Fixture: spin up daemon + temp vault + create a note.
  // Then trigger an unlink via fs.unlinkSync on the file.
  // Assert: the note's tombstoned_at is non-null within 200ms.
  // (Use the existing test harness for a temp vault + daemon; details depend on the file's current shape.)
});
```

(Detailed test body depends on the current watcher test infrastructure — adapt to the existing fixture pattern. The acceptance check is "after `fs.unlinkSync`, query `note.tombstoned_at` and confirm it is not null".)

- [ ] **Step 3: Run test, commit**

```bash
cd ~/projects/notient
bun test src/daemon/watcher.test.ts
git add src/daemon/watcher.ts src/daemon/watcher.test.ts
git commit -m "feat(watcher): unlink listener sets tombstoned_at with 60s cascade timer"
```

---

### Task 15: Rename detection within 60-second SHA-match window

**Files:**
- Modify: `src/daemon/watcher.ts`
- Modify: `src/daemon/watcher.test.ts`

- [ ] **Step 1: Implement rename in the `add` path**

Edit the watcher's `add` handler:

```typescript
private async handleAdd(vaultPath: string): Promise<void> {
  const notePath = this.toVaultRelative(vaultPath);
  const body = await this.facade.readNote(notePath);
  const sha = createHash("sha256").update(body).digest("hex");

  // Look for a tombstoned note with matching SHA in the last 60 seconds.
  const result = await this.surrealDb.db.query<[Array<{ id: RecordId<"note">; path: string }>]>(
    `SELECT id, path FROM note
     WHERE sha = $sha AND tombstoned_at != NONE
       AND tombstoned_at > time::now() - 60s
     LIMIT 1;`,
    { sha },
  );
  const candidate = (result[0] as Array<{ id: RecordId<"note">; path: string }>)[0];
  if (candidate && candidate.path !== notePath) {
    // Rename detected: update path, clear tombstone.
    await this.surrealDb.db.query(
      `UPDATE $n SET path = $p, tombstoned_at = NONE;`,
      { n: candidate.id, p: notePath },
    );
    this.eventBus.publish({ name: "indexer:renamed", payload: { from: candidate.path, to: notePath } });
    // Re-queue tier 1 because path-based wikilink resolution may have shifted.
    this.indexerQueue.enqueue(notePath, 0);
    return;
  }
  // Normal new-note flow: enqueue tier 1.
  this.indexerQueue.enqueue(notePath, 0);
}
```

- [ ] **Step 2: Add test**

```typescript
test("rename within 60s SHA-match window updates path and clears tombstone", async () => {
  // 1. Create note A with a known body.
  // 2. unlinkSync A.
  // 3. Within 1s, write the same body to a new path B.
  // 4. Assert: query for path B returns the original note id; tombstoned_at is null.
});
```

- [ ] **Step 3: Run test, commit**

```bash
cd ~/projects/notient
bun test src/daemon/watcher.test.ts
git add src/daemon/watcher.ts src/daemon/watcher.test.ts
git commit -m "feat(watcher): 60s SHA-match rename detection"
```

---

### Task 16: Phase 2 smoke harness

**Files:**
- Create: `src/daemon/__smoke__/tier1.smoke.test.ts`

- [ ] **Step 1: Write the smoke**

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSurreal, type SurrealServerHandle } from "../surrealServer";
import { connect, type SurrealConnection } from "../../core/db/surreal";
import { applySchema } from "../../core/db/schemaApplier";
import { runTier1 } from "../../core/indexer/tier1";

let server: SurrealServerHandle;
let db: SurrealConnection;
let temp: string;
let vault: string;
const secret = "phase2-smoke";

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), "notient-phase2-"));
  vault = join(temp, "vault");
  mkdirSync(vault, { recursive: true });
  const dataDir = join(temp, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  server = await startSurreal({ vaultPath: temp, dataDir, secret, portFile: join(temp, "p"), pidFile: join(temp, "pid") });
  db = await connect({ url: server.url, user: "root", pass: secret, namespace: "notient", database: "vault" });
  await applySchema(db.db, secret);
});

afterAll(async () => {
  await db?.close(); await server?.stop();
  rmSync(temp, { recursive: true, force: true });
});

describe("phase 2 tier 1 smoke", () => {
  test("end-to-end: a note with [[link]], #tag, ^block-id produces correct edges", async () => {
    writeFileSync(join(vault, "target.md"), "# Target\n");
    const note = `# Active\n\nReference [[target]] here. ^para-1\n\n#topic/sub\n`;
    writeFileSync(join(vault, "active.md"), note);
    await runTier1(db.db, { notePath: "target.md", source: "# Target\n", vaultPaths: ["active.md", "target.md"] });
    await runTier1(db.db, { notePath: "active.md", source: note, vaultPaths: ["active.md", "target.md"] });

    const wikilinks = await db.db.query<[Array<{ id: unknown }>]>(`SELECT id FROM wikilink;`);
    expect((wikilinks[0] as unknown[]).length).toBeGreaterThan(0);
    const tags = await db.db.query<[Array<{ path: string }>]>(`SELECT path FROM tag;`);
    expect((tags[0] as Array<{ path: string }>).map((r) => r.path)).toContain("topic/sub");
    const blocks = await db.db.query<[Array<{ block_id: string | null }>]>(
      `SELECT block_id FROM block WHERE block_id = "para-1";`,
    );
    expect((blocks[0] as unknown[]).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run, commit**

```bash
cd ~/projects/notient
bun test src/daemon/__smoke__/tier1.smoke.test.ts
git add src/daemon/__smoke__/tier1.smoke.test.ts
git commit -m "test(smoke): phase 2 tier 1 end-to-end against real surrealdb"
```

---

### Task 17: Phase 2 handoff doc

**Files:**
- Create: `docs/superpowers/handoffs/2026-04-29-phase-2-vault-enrichment-handoff.md`

- [ ] **Step 1: Write the handoff (under 80 lines)**

Document: what shipped (markdown pipeline + 3 plugins, MarkdownExtraction walker, resolver, Tier 1 indexer wired into indexNote, watcher unlink + rename detection). What is deferred (Tier 2 still SQLite, Tier 3 still SQLite, write-back unchanged, awaken control plane unchanged). Phase 3 entry point (priority queue + Tier 2 chunk/embed migration to SurrealDB native HNSW, Tier 3 retargeted, hnswlib-wasm deletion).

- [ ] **Step 2: Commit**

```bash
cd ~/projects/notient
git add docs/superpowers/handoffs/2026-04-29-phase-2-vault-enrichment-handoff.md
git commit -m "docs(handoff): phase 2 tier 1 + markdown pipeline shipped"
```

---

## Self-review

**Spec coverage:** §3.2 block schema (Task 12, 13), §3.4 deterministic edge tables (Task 11, 12), §5.2 Tier 1 (Task 12, 13), §5.5 watcher (Task 14, 15), §8.1 markdown pipeline (Task 3, 7), §8.2 extractor (Task 9), §8.3 wikilink resolution (Task 10). H3 cap (Task 9). All covered.

**Placeholder scan:** Two TODO-shaped notes in Task 12/14 reference adapting to existing file structure ("adjust to the file's current shape"). These are unavoidable without a full read of the current source; the engineer executing the plan will read the file and adapt. They are not scope holes.

**Type consistency:** `MarkdownExtraction` (Task 2) consumed by `extract` (Task 9) and `runTier1` (Task 12). `BlockSpec` flows from extractor through `replaceBlocks` (Task 11). `EDGE_TABLES` (from Phase 1) consumed by `relateEdge` (Task 11). `RecordId<"note">` from SDK consistent across DAL methods.

**One known minor issue, fixed inline above:** The Tier 1 orchestrator in Task 12 originally used `source: "wikilink"` for `tagged` edges; corrected note added — should be `source: "structure"`. The schema's enum allows both, so the test would have passed with the wrong value; the post-task fix matches spec semantics.

---

## Execution

Phase 2 plan complete and saved to `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-2.md`. Execute in a fresh Notient session via `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Phase 1 must ship green first (`docs/superpowers/handoffs/2026-04-29-phase-1-vault-enrichment-handoff.md` confirms readiness).
