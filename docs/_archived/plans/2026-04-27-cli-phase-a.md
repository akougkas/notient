# Notient v0.1 Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple Notient from Obsidian. Archive every UI-coupled file to `.nuked/`, rebind the substrate to a `VaultAdapter` interface backed by an `FsVault` implementation, and stand up a daemon-plus-CLI skeleton that opens a Unix socket and answers `daemon.{status,shutdown,config_get,config_set}` over NDJSON.

**Architecture:** One daemon per vault, many thin CLI clients. Daemon entry is `src/daemon/index.ts`; clients live under `src/cli/`. The substrate (`src/core/**`) is locked. Only three files under `src/core/` and `src/adapters/` import obsidian today (`kernel.ts`, `agents/maturityAdvancer.ts`, `settings/settingsService.ts`); the remaining "consumers" already accept narrow facade-shaped interfaces, so the rebind is concentrated in the new `daemon/bootstrap.ts` wiring rather than per-consumer edits.

**Tech Stack:** Bun (runtime + compile), TypeScript strict, `node:net` for the Unix socket, `node:fs/promises` for the FS adapter, sql.js + sql-wasm.wasm (locked), hnswlib-wasm (locked). New deps: `chokidar@^4` (Phase B watcher; declared in Phase A so the build:cli compile graph resolves), `unpdf@^0` (Phase C), `@opentui/core@0.1.105` + `@opentui/react@0.1.105` (Phase C, pinned). Dropped deps: `obsidian`, `preact`, `@preact/signals`, `marked`, `prismjs`, `@types/prismjs`, `preact-render-to-string`.

**Source of truth:** `docs/superpowers/specs/2026-04-27-notient-cli-design.md` Section 6, 7, 8. Spec is locked.

---

## Hard rules (every task obeys these)

- TypeScript strict. No `any` without justification.
- No `console.log` outside `src/cli/output.ts` or the existing `debug<Subsystem>` helpers (`debugCoAuthor`, `debugChat`, `debugStream`, `debugVitals`, `debugSearch`).
- No abbreviations: `context` not `ctx`, `error` not `err`, `message` not `msg`, `event` not `evt`, `index` not `idx`, `options` not `opts`.
- No `[noun] - [parenthetical clause]` dash-clause prose anywhere (code, comments, commit messages, docs, `--help` text). Use a full sentence or a colon.
- No emojis in source.
- One commit per logical step on `beta-spec`. No `git add -A`. Stage by name only.
- Substrate tests stay green throughout. UI tests die with the UI under `.nuked/`.
- All "move" operations use `mv source .nuked/source` (preserving the path under `.nuked/`). Never `git rm`. Recovery is `mv .nuked/path path`.

---

## Risks (carried from spec section 6 + section 9)

| Risk | Tasks affected | Mitigation in this plan |
|---|---|---|
| Bun `--compile` cannot bundle `sql-wasm.wasm` + `hnswlib-wasm` cleanly | Task 23 (build:cli), Task 25 (smoke harness), Task 26 (gate) | Day-1 verification in Task 23 step 4. Fallback: keep `bun run dist/notient.js` + a shell wrapper that copies wasm next to the entry. Documented in Task 23. |
| `SettingsService` rebind ripples through ~20 callsites | Task 5 | Old `main.ts` is the only callsite of the old constructor; main.ts moves to `.nuked/` in Task 8. Daemon `bootstrap.ts` (Task 15) is the only new callsite. All consumer reads of settings already go through `() => settings.get()` lambdas, untouched by the rebind. |
| Kernel imports `CanvasFromResults` from `src/ui/search/` so the UI nuke would break the kernel typecheck | Task 2 (lift), Task 7 (kernel rebind), Task 10 (UI archive) | Lift the file to `src/core/canvas/canvasFromResults.ts` BEFORE the UI archive. Task 2 runs before Task 10; the UI archive's typecheck verifies the lift worked. |
| Undiscovered `obsidian` imports in substrate code | Task 7, Task 10 | After UI archive (Task 10), run `grep -rn 'from "obsidian"\|from "\\.\\./.*obsidianFacade"' src/` and fix any survivor before claiming Group 6 done. Step is explicit in Task 10. |
| Test files reference UI components that move to `.nuked/` | Task 10 | UI tests move with their UI components into `.nuked/`. The tsconfig `exclude` and biome `ignore` settle the toolchain. Substrate test files do not import UI. |
| Bun/Node socket path differences on WSL2 | Task 12 (socket.ts) | Spec section 4.1 mandates `<vault>/.notient/notient.sock` on Linux/macOS/WSL2 and `\\.\pipe\notient-<sha8(...)>` on Windows native. Implemented per spec; WSL2 uses Linux semantics. |

---

## File structure (Phase A landing state)

```
src/
├── adapters/
│   ├── vaultAdapter.ts         # NEW — VaultAdapter interface (extracted VaultIO + extensions)
│   └── fsVault.ts              # NEW — FS implementation
├── cli/
│   ├── index.ts                # NEW — binary entry, arg parser, mode dispatcher
│   ├── client.ts               # NEW — daemon RPC client (auto-spawn, NDJSON match-by-id)
│   ├── output.ts               # NEW — JSON / NDJSON / pretty emitter
│   ├── env.ts                  # NEW — vault resolution
│   └── commands/
│       ├── init.ts             # NEW — bootstraps a vault (no daemon)
│       └── daemon.ts           # NEW — daemon start | stop | status | list
├── daemon/
│   ├── index.ts                # NEW — entry: bootstrap → seal kernel → open socket
│   ├── bootstrap.ts            # NEW — kernel wiring, extracted from old main.ts
│   ├── rpc.ts                  # NEW — NDJSON-over-socket protocol, method dispatch
│   ├── socket.ts               # NEW — platform-aware socket path resolver
│   └── lifecycle.ts            # NEW — idle-exit timer, PID file
├── bridge/                     # NEW (empty in Phase A; Phase B fills it)
├── agent/                      # NEW (empty in Phase A; Phase C fills it)
└── core/
    ├── canvas/
    │   └── canvasFromResults.ts  # MOVED from src/ui/search/canvasFromResults.ts
    ├── settings/
    │   └── settingsService.ts    # REWRITTEN — generic ConfigStore injection
    ├── agents/
    │   └── maturityAdvancer.ts   # MODIFIED — VaultAdapter type
    ├── kernel.ts                 # MODIFIED — VaultAdapter type, lifted import path
    └── ... (rest unchanged)

tests/
└── fixtures/
    └── sentient-vault/         # NEW — ~10 markdown notes for smoke + Phase B awaken

scripts/
└── smoke-cli-phaseA.ts         # NEW — Phase A gate harness

.nuked/
├── manifest.json
└── src/
    ├── main.ts
    ├── styles.css
    ├── adapters/
    │   ├── obsidianFacade.ts
    │   └── obsidianFacade.test.ts
    ├── core/
    │   └── settings/
    │       └── SettingsTab.ts
    └── ui/                       # entire tree
```

---

## Task DAG

```
Group 1: Housekeeping (sequential, blocks every move)
  Task 1: .gitignore + tsconfig.json + biome.json + CLAUDE.md Archive subsection

Group 2: Adapter foundation (sequential, blocks Group 5 and Group 6)
  Task 2: Lift canvasFromResults → src/core/canvas/canvasFromResults.ts
  Task 3: Create src/adapters/vaultAdapter.ts (VaultAdapter interface)
  Task 4: Create src/adapters/fsVault.ts + tests

Group 3: SettingsService rebind (sequential, blocks Task 15)
  Task 5: Rewrite settingsService.ts to accept ConfigStore; rewrite test

Group 4: MaturityAdvancer rebind (sequential, blocks Task 7 because kernel re-typechecks)
  Task 6: Replace ObsidianFacade type in maturityAdvancer.ts

Group 5: Kernel rebind (sequential after 2, 3, 6)
  Task 7: kernel.ts → VaultAdapter type, new canvas import path

Group 6: Archive moves (sequential after 5, 6, 7 land green typecheck)
  Task 8:  Move src/main.ts → .nuked/src/main.ts
  Task 9:  Move src/adapters/obsidianFacade.ts + test → .nuked/src/adapters/
  Task 10: Move src/ui/** + verify no orphan obsidian imports
  Task 11: Move src/styles.css, manifest.json, src/core/settings/SettingsTab.ts → .nuked/

Group 7: Daemon skeleton (Task 12, 13, 14 PARALLEL; 15 after 14+adapters+settings; 16 after 15)
  Task 12: src/daemon/socket.ts                           [parallel-safe]
  Task 13: src/daemon/lifecycle.ts                        [parallel-safe]
  Task 14: src/daemon/rpc.ts (skeleton)                   [parallel-safe]
  Task 15: src/daemon/bootstrap.ts (kernel wiring)        [needs 4, 5, 7, 12, 13]
  Task 16: src/daemon/index.ts (entry)                    [needs 14, 15]

Group 8: CLI skeleton (Task 17, 18 PARALLEL; 19 needs 17; 20 needs 17+18; 21 needs 19; 22 last)
  Task 17: src/cli/output.ts                              [parallel-safe]
  Task 18: src/cli/env.ts                                 [parallel-safe]
  Task 19: src/cli/client.ts                              [needs 17]
  Task 20: src/cli/commands/init.ts                       [needs 17, 18]
  Task 21: src/cli/commands/daemon.ts                     [needs 19]
  Task 22: src/cli/index.ts                               [needs 17, 18, 19, 20, 21]

Group 9: Package + fixtures + smoke (Task 23 sequential gate; 24 + 25 PARALLEL after 23; 26 last)
  Task 23: package.json (drop deps, add deps, bin, scripts)
  Task 24: tests/fixtures/sentient-vault/                 [parallel-safe with 25]
  Task 25: scripts/smoke-cli-phaseA.ts                    [needs 16, 22]
  Task 26: Phase A gate run + live invocation
```

**Parallelism rules for subagent-driven-development.** Independent tasks can dispatch in parallel:
- Within Group 7: Tasks 12, 13, 14 are independent files, no shared imports.
- Within Group 8: Tasks 17 and 18 are independent. Tasks 20 and 21 can run in parallel after Task 19 lands.
- Within Group 9: Tasks 24 and 25 are independent (24 just writes markdown fixtures).
- Across Group 6: archive-move commits should land sequentially because each move runs `bun run typecheck` to confirm no breakage. Subagents must not race the typecheck baseline.

Sequential tasks must serialize: housekeeping must precede archive (Group 1 → Group 6); Group 5 (kernel) must follow Group 2 + Task 6; Group 6 (archive) must follow Group 5; Group 7+8 can start once Group 6 is green; Task 25 (smoke) needs Task 16 + Task 22 + Task 23 + Task 24 done.

---

## Group 1: Housekeeping

### Task 1: First-commit housekeeping (gitignore + tsconfig + biome + CLAUDE.md Archive)

**Files:**
- Modify: `/home/akougkas/projects/notient/.gitignore`
- Modify: `/home/akougkas/projects/notient/tsconfig.json`
- Modify: `/home/akougkas/projects/notient/biome.json`
- Modify: `/home/akougkas/projects/notient/.claude/CLAUDE.md`

- [ ] **Step 1: Append `/.nuked/` to `.gitignore`**

Open `.gitignore`. Add at the very end:

```
# Notient v0.1 archive
/.nuked/
```

- [ ] **Step 2: Add `.nuked` to `tsconfig.json` exclude**

Edit `tsconfig.json`. Replace the `"exclude"` line `"exclude": ["node_modules", "dist"]` with:

```json
  "exclude": ["node_modules", "dist", ".nuked"]
```

- [ ] **Step 3: Add `.nuked/**` to `biome.json` files.ignore**

Edit `biome.json`. Replace the existing `"files"` block with:

```json
  "files": {
    "ignore": [
      "node_modules/**",
      "dist/**",
      "main.js",
      "*.md",
      ".nuked/**"
    ]
  }
```

- [ ] **Step 4: Add Archive subsection to `.claude/CLAUDE.md`**

Append a new section to `.claude/CLAUDE.md` after the existing content, before the trailing blank lines:

```markdown
## Archive (.nuked/)

`.nuked/` holds pre-pivot code retained for reference. Never import from it. Never restore without explicit approval. The directory is gitignored and excluded from tsc and biome.
```

- [ ] **Step 5: Run typecheck baseline (must be green BEFORE any move)**

Run: `bun run typecheck`
Expected: Green. The baseline must pass on `beta-spec` before Task 8 moves anything.

- [ ] **Step 6: Commit**

```bash
git add .gitignore tsconfig.json biome.json .claude/CLAUDE.md
git commit -m "$(cat <<'EOF'
chore(phase-a): housekeeping for .nuked/ archive policy

Add /.nuked/ to .gitignore, ".nuked" to tsconfig.json exclude,
.nuked/** to biome.json files.ignore, and the Archive subsection
to .claude/CLAUDE.md so subsequent move commits land cleanly.
EOF
)"
```

---

## Group 2: Adapter foundation

### Task 2: Lift `canvasFromResults` from `src/ui/search/` to `src/core/canvas/`

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/kernel.ts` (later in Task 7; not here)
- Move: `/home/akougkas/projects/notient/src/ui/search/canvasFromResults.ts` → `/home/akougkas/projects/notient/src/core/canvas/canvasFromResults.ts`
- Move: `/home/akougkas/projects/notient/src/ui/search/canvasFromResults.test.ts` → `/home/akougkas/projects/notient/src/core/canvas/canvasFromResults.test.ts`

The file imports `../../core/canvas/canvasGenerator` and `../../core/canvas/types` and `../../core/search/types`. After the move, the relative paths become `./canvasGenerator`, `./types`, and `../search/types`.

- [ ] **Step 1: Move the source file with the right destination path**

```bash
mkdir -p src/core/canvas
git mv src/ui/search/canvasFromResults.ts src/core/canvas/canvasFromResults.ts
git mv src/ui/search/canvasFromResults.test.ts src/core/canvas/canvasFromResults.test.ts
```

- [ ] **Step 2: Fix relative imports inside the moved files**

Edit `src/core/canvas/canvasFromResults.ts`. Replace:
```typescript
import { generateSearchResultsCanvas } from "../../core/canvas/canvasGenerator";
import type { CanvasFile } from "../../core/canvas/types";
import type { SearchResult } from "../../core/search/types";
```
with:
```typescript
import type { SearchResult } from "../search/types";
import { generateSearchResultsCanvas } from "./canvasGenerator";
import type { CanvasFile } from "./types";
```

Open `src/core/canvas/canvasFromResults.test.ts` and update its `import { … } from "./canvasFromResults"`-relative imports the same way. The test file was previously at `src/ui/search/`, so any `../../core/canvas/...` path becomes `./...` and any `../../core/search/...` becomes `../search/...`.

- [ ] **Step 3: Run the canvas-from-results test to confirm the move**

Run: `bun test src/core/canvas/canvasFromResults.test.ts`
Expected: Green.

- [ ] **Step 4: Run the full test suite — no other consumer should break since kernel still imports the old path**

Run: `bun test`
Expected: Green except for `kernel.ts`'s import of `./ui/search/canvasFromResults`. The kernel rebind in Task 7 fixes this. If other tests fail at this step, stop and investigate.

NOTE: kernel.ts will fail typecheck at this point because the import path is stale. That is expected and intentional. Task 7 fixes it. Do not run typecheck between Task 2 and Task 7.

- [ ] **Step 5: Commit**

```bash
git add src/core/canvas/canvasFromResults.ts src/core/canvas/canvasFromResults.test.ts
git commit -m "$(cat <<'EOF'
refactor(canvas): lift canvasFromResults out of src/ui/

The kernel imports CanvasFromResults; the UI archive in Phase A
would otherwise break the kernel typecheck. Lift the file to
src/core/canvas/canvasFromResults.ts with corrected relative
imports. Kernel import path rebind follows in a later commit.
EOF
)"
```

---

### Task 3: Create `src/adapters/vaultAdapter.ts`

**Files:**
- Create: `/home/akougkas/projects/notient/src/adapters/vaultAdapter.ts`

The interface extracts `VaultIO` from `obsidianFacade.ts` plus the extensions present on `ObsidianFacade` that other consumers actually use: `readNote`, `writeNote`, `updateFrontmatter`, `createFolder`, `list`. Sidecar/raw-binary access is needed for the conversation index, vector persistence, and lock; expose those too.

- [ ] **Step 1: Write the file**

Create `/home/akougkas/projects/notient/src/adapters/vaultAdapter.ts` with this content:

```typescript
/**
 * VaultAdapter is the substrate's only door to vault content.
 *
 * The interface extracts the contract previously embedded in
 * ObsidianFacade so the substrate stays IO-agnostic. FsVault implements
 * it over node:fs for the daemon. A future ObsidianBridgeAdapter will
 * implement a subset of it via the obsidian CLI when the editor is
 * running.
 */

export interface VaultListing {
  files: string[];
  folders: string[];
}

export interface VaultAdapter {
  /** Returns markdown files in the entire vault with their mtimes. */
  listMarkdown(): Promise<{ path: string; mtime: number }[]>;

  /** Read a UTF-8 markdown file by vault-relative path. */
  read(path: string): Promise<string>;

  /** Phase 4 alias for read; kept for substrate consumer parity. */
  readNote(path: string): Promise<string>;

  /** Atomic write of a UTF-8 markdown file. */
  write(path: string, content: string): Promise<void>;

  /** Phase 4 alias for write. */
  writeNote(path: string, content: string): Promise<void>;

  /**
   * Read-modify-atomic-write of YAML frontmatter. Implementations must
   * use the same mergeFrontmatter semantics so VitalsService and
   * NativeGraphBridge produce identical bytes regardless of adapter.
   */
  updateFrontmatter(path: string, patch: Record<string, unknown>): Promise<void>;

  /** Delete a file. Implementations decide trash vs permanent. */
  remove(path: string): Promise<void>;

  /** True iff the vault-relative path resolves to an existing entry. */
  exists(path: string): Promise<boolean>;

  /** Create a folder at the vault-relative path. No-op if it exists. */
  createFolder(path: string): Promise<void>;

  /** Shallow listing of a folder. Files and folders carry vault-relative paths. */
  list(folder: string): Promise<VaultListing>;

  /** Read raw bytes for sidecars, wasm, vector index, lock files. */
  readBinary(path: string): Promise<ArrayBuffer | null>;

  /** Write raw bytes atomically. */
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;

  /** Rename a file or folder. Used by atomicWrite tmp→final swap. */
  rename(from: string, to: string): Promise<void>;
}
```

- [ ] **Step 2: Run typecheck on the new file**

Run: `bun run typecheck`
Expected: Green if Task 7 has not started yet. **NOTE:** typecheck will be red between Task 2 and Task 7 because of the stale kernel import; if you ran Task 2 already, skip this step. Otherwise the new interface compiles standalone.

- [ ] **Step 3: Commit**

```bash
git add src/adapters/vaultAdapter.ts
git commit -m "$(cat <<'EOF'
feat(adapters): VaultAdapter interface

Extracts the substrate's vault contract from ObsidianFacade so the
backend stays IO-agnostic. Surfaces listMarkdown, read/write, frontmatter
merge, listing, and binary IO that the substrate consumers already
expect via narrow facade shapes.
EOF
)"
```

---

### Task 4: Create `src/adapters/fsVault.ts` + tests

**Files:**
- Create: `/home/akougkas/projects/notient/src/adapters/fsVault.ts`
- Create: `/home/akougkas/projects/notient/src/adapters/fsVault.test.ts`

`FsVault` implements `VaultAdapter` over `node:fs/promises`. Atomic writes go through the existing `src/core/utils/atomicWrite.ts` so the substrate's atomic semantics stay in lockstep. `listMarkdown` walks the vault recursively, skipping `.notient/`, `.obsidian/`, `node_modules/`, and any path matching the indexer's `excludePaths` shape.

- [ ] **Step 1: Write the failing test first**

Create `/home/akougkas/projects/notient/src/adapters/fsVault.test.ts` with this content:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsVault } from "./fsVault";

describe("FsVault", () => {
  let root: string;
  let vault: FsVault;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-fsvault-"));
    vault = new FsVault(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("read/write roundtrip preserves bytes", async () => {
    await vault.write("notes/hello.md", "# Hello\n\nworld\n");
    const content = await vault.read("notes/hello.md");
    expect(content).toBe("# Hello\n\nworld\n");
  });

  test("write is atomic: tmp file does not survive on success", async () => {
    await vault.write("notes/atomic.md", "ok");
    const dirEntries = await import("node:fs/promises").then((module) =>
      module.readdir(join(root, "notes")),
    );
    expect(dirEntries.some((entry) => entry.endsWith(".md"))).toBe(true);
    expect(dirEntries.some((entry) => entry.includes("notient-tmp"))).toBe(false);
  });

  test("listMarkdown skips dot-prefixed folders", async () => {
    await mkdir(join(root, ".notient"), { recursive: true });
    await writeFile(join(root, ".notient", "config.json"), "{}");
    await mkdir(join(root, ".obsidian"), { recursive: true });
    await writeFile(join(root, ".obsidian", "workspace.json"), "{}");
    await vault.write("a.md", "a");
    await vault.write("nested/b.md", "b");
    const listing = await vault.listMarkdown();
    const paths = listing.map((entry) => entry.path).sort();
    expect(paths).toEqual(["a.md", "nested/b.md"]);
  });

  test("exists is true for files and folders, false for missing", async () => {
    await vault.write("present.md", "p");
    expect(await vault.exists("present.md")).toBe(true);
    expect(await vault.exists("missing.md")).toBe(false);
    await vault.createFolder("folder");
    expect(await vault.exists("folder")).toBe(true);
  });

  test("updateFrontmatter merges YAML and rewrites atomically", async () => {
    await vault.write("note.md", "---\ntitle: Old\n---\n\nbody\n");
    await vault.updateFrontmatter("note.md", { title: "New", tag: "ok" });
    const after = await vault.read("note.md");
    expect(after).toContain("title: New");
    expect(after).toContain("tag: ok");
    expect(after).toContain("body");
  });

  test("readBinary returns null for missing path", async () => {
    expect(await vault.readBinary("missing.bin")).toBeNull();
  });

  test("readBinary roundtrip", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    await vault.writeBinary("blob.bin", payload.buffer);
    const back = await vault.readBinary("blob.bin");
    expect(back).not.toBeNull();
    expect(new Uint8Array(back as ArrayBuffer)).toEqual(payload);
  });

  test("list returns shallow files and folders", async () => {
    await vault.write("folder/a.md", "a");
    await vault.write("folder/b.md", "b");
    await vault.createFolder("folder/sub");
    const listing = await vault.list("folder");
    expect(listing.files.sort()).toEqual(["folder/a.md", "folder/b.md"]);
    expect(listing.folders).toEqual(["folder/sub"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/adapters/fsVault.test.ts`
Expected: FAIL because `fsVault.ts` does not exist.

- [ ] **Step 3: Implement `FsVault`**

Create `/home/akougkas/projects/notient/src/adapters/fsVault.ts` with this content:

```typescript
import { readFile, readdir, rename, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { mergeFrontmatter } from "../core/chat/tools/notes";
import { type AtomicFs, atomicWrite } from "../core/utils/atomicWrite";
import type { VaultAdapter, VaultListing } from "./vaultAdapter";

const DOT_PREFIXES = new Set([".notient", ".obsidian", ".git"]);
const HARD_SKIP = new Set(["node_modules"]);

export class FsVault implements VaultAdapter {
  private readonly atomic: AtomicFs;

  constructor(private readonly root: string) {
    this.atomic = {
      writeBinary: (path, data) => this.writeBinary(path, data),
      rename: (from, to) => this.rename(from, to),
      remove: (path) => this.remove(path),
    };
  }

  async listMarkdown(): Promise<{ path: string; mtime: number }[]> {
    const results: { path: string; mtime: number }[] = [];
    await this.walk(this.root, async (absolute, isDirectory) => {
      if (isDirectory) return;
      if (!absolute.endsWith(".md")) return;
      const stats = await stat(absolute);
      results.push({ path: this.toVaultPath(absolute), mtime: stats.mtimeMs });
    });
    return results;
  }

  async read(path: string): Promise<string> {
    return await readFile(this.toAbsolute(path), "utf-8");
  }

  async readNote(path: string): Promise<string> {
    return this.read(path);
  }

  async write(path: string, content: string): Promise<void> {
    await this.ensureParent(path);
    await atomicWrite(this.atomic, path, content);
  }

  async writeNote(path: string, content: string): Promise<void> {
    return this.write(path, content);
  }

  async updateFrontmatter(path: string, patch: Record<string, unknown>): Promise<void> {
    const before = (await this.exists(path)) ? await this.read(path) : "";
    const next = mergeFrontmatter(before, patch);
    if (next === before) return;
    await this.write(path, next);
  }

  async remove(path: string): Promise<void> {
    await rm(this.toAbsolute(path), { force: true });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.toAbsolute(path));
      return true;
    } catch {
      return false;
    }
  }

  async createFolder(path: string): Promise<void> {
    await mkdir(this.toAbsolute(path), { recursive: true });
  }

  async list(folder: string): Promise<VaultListing> {
    const absolute = this.toAbsolute(folder);
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return { files: [], folders: [] };
    }
    const files: string[] = [];
    const folders: string[] = [];
    for (const entry of entries) {
      const childPath = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory()) {
        folders.push(childPath);
      } else {
        files.push(childPath);
      }
    }
    return { files, folders };
  }

  async readBinary(path: string): Promise<ArrayBuffer | null> {
    try {
      const buffer = await readFile(this.toAbsolute(path));
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer;
    } catch {
      return null;
    }
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const absolute = this.toAbsolute(path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, new Uint8Array(data));
  }

  async rename(from: string, to: string): Promise<void> {
    const fromAbsolute = this.toAbsolute(from);
    const toAbsolute = this.toAbsolute(to);
    await mkdir(dirname(toAbsolute), { recursive: true });
    await rename(fromAbsolute, toAbsolute);
  }

  private toAbsolute(path: string): string {
    return join(this.root, ...path.split("/"));
  }

  private toVaultPath(absolute: string): string {
    const relativePath = relative(this.root, absolute);
    return relativePath.split(sep).join(posix.sep);
  }

  private async ensureParent(path: string): Promise<void> {
    const absolute = this.toAbsolute(path);
    await mkdir(dirname(absolute), { recursive: true });
  }

  private async walk(
    dir: string,
    visit: (absolutePath: string, isDirectory: boolean) => Promise<void>,
  ): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (DOT_PREFIXES.has(entry.name)) continue;
        if (HARD_SKIP.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;
        await visit(absolute, true);
        await this.walk(absolute, visit);
      } else {
        await visit(absolute, false);
      }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/adapters/fsVault.test.ts`
Expected: PASS, all 8 cases.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/fsVault.ts src/adapters/fsVault.test.ts
git commit -m "$(cat <<'EOF'
feat(adapters): FsVault implementation over node:fs

Implements VaultAdapter with atomic writes via the existing
atomicWrite helper, recursive markdown walk that skips dot-prefixed
folders, frontmatter merge identical to ObsidianFacade.updateFrontmatter,
and binary IO for sidecars and wasm.
EOF
)"
```

---

## Group 3: SettingsService rebind

### Task 5: Rewrite `SettingsService` to take a generic `ConfigStore`

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/settings/settingsService.ts`
- Modify: `/home/akougkas/projects/notient/src/core/settings/settingsService.test.ts`

The new shape removes the `Plugin` import and replaces it with an injected `ConfigStore` of `{ load(): Promise<unknown>; save(value: unknown): Promise<void> }`. Daemon `bootstrap.ts` (Task 15) wires the store to `<vault>/.notient/config.json` via `FsVault.read` + `FsVault.write` (JSON-encoded).

- [ ] **Step 1: Update the test first to drive the new shape**

Replace the entire content of `/home/akougkas/projects/notient/src/core/settings/settingsService.test.ts` with:

```typescript
import { describe, expect, test } from "bun:test";
import { EventBus } from "../events/eventBus";
import { SettingsService } from "./settingsService";
import { DEFAULT_SETTINGS } from "./types";

interface FakeStore {
  data: unknown;
  load: () => Promise<unknown>;
  save: (value: unknown) => Promise<void>;
}

function makeStore(initial: unknown): FakeStore {
  const store: FakeStore = {
    data: initial,
    load: async () => store.data,
    save: async (value) => {
      store.data = value;
    },
  };
  return store;
}

describe("SettingsService merge", () => {
  test("falls back to defaults when persisted data is partial", async () => {
    const store = makeStore({ approvals: { confidenceThreshold: 0.9 } });
    const service = new SettingsService(store, new EventBus());
    const loaded = await service.load();

    expect(loaded.approvals.confidenceThreshold).toBe(0.9);
    expect(loaded.stream).toEqual(DEFAULT_SETTINGS.stream);
    expect(loaded.vitals.healthWeights).toEqual(DEFAULT_SETTINGS.vitals.healthWeights);
    expect(loaded.search.balanced).toEqual(DEFAULT_SETTINGS.search.balanced);
    expect(loaded.chat.context).toEqual(DEFAULT_SETTINGS.chat.context);
    expect(loaded.indexer.excludePaths).toEqual(DEFAULT_SETTINGS.indexer.excludePaths);
  });

  test("preserves persisted nested fields while filling gaps from defaults", async () => {
    const store = makeStore({
      vitals: { freshnessHalfLifeDays: 30 },
      search: { balanced: { topK: 50 } },
    });
    const service = new SettingsService(store, new EventBus());
    const loaded = await service.load();

    expect(loaded.vitals.freshnessHalfLifeDays).toBe(30);
    expect(loaded.vitals.healthWeights).toEqual(DEFAULT_SETTINGS.vitals.healthWeights);
    expect(loaded.search.balanced.topK).toBe(50);
    expect(loaded.search.balanced.rerankTopN).toBe(DEFAULT_SETTINGS.search.balanced.rerankTopN);
    expect(loaded.search.deep).toEqual(DEFAULT_SETTINGS.search.deep);
  });

  test("update writes through to the store and emits settings:changed", async () => {
    const store = makeStore(null);
    const bus = new EventBus();
    const events: string[] = [];
    bus.on("settings:changed", (event) => {
      events.push(event.key);
    });
    const service = new SettingsService(store, bus);
    await service.load();
    await service.update({ approvals: { confidenceThreshold: 0.42 } });

    expect(service.get().approvals.confidenceThreshold).toBe(0.42);
    expect(store.data).not.toBeNull();
    expect(events).toEqual(["approvals"]);
  });
});
```

- [ ] **Step 2: Run the new test against the old implementation to verify it fails**

Run: `bun test src/core/settings/settingsService.test.ts`
Expected: FAIL because the old constructor expects `Plugin`. The compile error / test failure is the signal to proceed.

- [ ] **Step 3: Rewrite `SettingsService`**

Replace the entire content of `/home/akougkas/projects/notient/src/core/settings/settingsService.ts` with:

```typescript
import type { EventBus } from "../events/eventBus";
import { DEFAULT_SETTINGS, type NotientSettings } from "./types";

/**
 * SettingsService persists Notient configuration through an injected
 * ConfigStore. The daemon wires the store to <vault>/.notient/config.json
 * via FsVault. Tests use an in-memory fake.
 */
export interface ConfigStore {
  load(): Promise<unknown>;
  save(value: unknown): Promise<void>;
}

export class SettingsService {
  private current: NotientSettings = DEFAULT_SETTINGS;

  constructor(
    private readonly store: ConfigStore,
    private readonly bus: EventBus,
  ) {}

  async load(): Promise<NotientSettings> {
    const raw = (await this.store.load()) as Partial<NotientSettings> | null;
    this.current = mergeSettings(DEFAULT_SETTINGS, raw ?? {});
    return this.current;
  }

  get(): NotientSettings {
    return this.current;
  }

  async update(patch: Partial<NotientSettings>): Promise<void> {
    this.current = mergeSettings(this.current, patch);
    await this.store.save(this.current);
    this.bus.emit({ type: "settings:changed", key: Object.keys(patch).join(",") });
  }
}

function mergeSettings(base: NotientSettings, patch: Partial<NotientSettings>): NotientSettings {
  return {
    primary: { ...base.primary, ...(patch.primary ?? {}) },
    deep: { ...base.deep, ...(patch.deep ?? {}) },
    embedding: { ...base.embedding, ...(patch.embedding ?? {}) },
    agents: { ...base.agents, ...(patch.agents ?? {}) },
    coAuthor: { ...base.coAuthor, ...(patch.coAuthor ?? {}) },
    approvals: { ...base.approvals, ...(patch.approvals ?? {}) },
    awakenedAt: patch.awakenedAt !== undefined ? patch.awakenedAt : base.awakenedAt,
    stream: { ...base.stream, ...(patch.stream ?? {}) },
    vitals: mergeVitals(base.vitals, patch.vitals),
    decorations: { ...base.decorations, ...(patch.decorations ?? {}) },
    nativeGraph: { ...base.nativeGraph, ...(patch.nativeGraph ?? {}) },
    search: mergeSearch(base.search, patch.search),
    chat: mergeChat(base.chat, patch.chat),
    history: { ...base.history, ...(patch.history ?? {}) },
    indexer: { ...base.indexer, ...(patch.indexer ?? {}) },
  };
}

function mergeVitals(
  base: NotientSettings["vitals"],
  patch: Partial<NotientSettings["vitals"]> | undefined,
): NotientSettings["vitals"] {
  return {
    ...base,
    ...(patch ?? {}),
    healthWeights: { ...base.healthWeights, ...(patch?.healthWeights ?? {}) },
    connectivityThresholds: {
      ...base.connectivityThresholds,
      ...(patch?.connectivityThresholds ?? {}),
    },
  };
}

function mergeSearch(
  base: NotientSettings["search"],
  patch: Partial<NotientSettings["search"]> | undefined,
): NotientSettings["search"] {
  return {
    ...base,
    ...(patch ?? {}),
    balanced: { ...base.balanced, ...(patch?.balanced ?? {}) },
    deep: { ...base.deep, ...(patch?.deep ?? {}) },
    history: { ...base.history, ...(patch?.history ?? {}) },
  };
}

function mergeChat(
  base: NotientSettings["chat"],
  patch: Partial<NotientSettings["chat"]> | undefined,
): NotientSettings["chat"] {
  return {
    ...base,
    ...(patch ?? {}),
    toolModeByModel: { ...base.toolModeByModel, ...(patch?.toolModeByModel ?? {}) },
    context: { ...base.context, ...(patch?.context ?? {}) },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/core/settings/settingsService.test.ts`
Expected: PASS, all 3 cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/settings/settingsService.ts src/core/settings/settingsService.test.ts
git commit -m "$(cat <<'EOF'
refactor(settings): inject a generic ConfigStore

Drops the obsidian Plugin dependency from SettingsService. The daemon
wires the store to <vault>/.notient/config.json via FsVault. Tests
use an in-memory fake. The new update() roundtrip is covered.
EOF
)"
```

---

## Group 4: MaturityAdvancer rebind

### Task 6: Replace `ObsidianFacade` type with `VaultAdapter` in MaturityAdvancer

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/agents/maturityAdvancer.ts`

The agent uses `Pick<ObsidianFacade, "read" | "write">`. The same Pick over `VaultAdapter` works because both interfaces declare `read` and `write` with identical signatures.

- [ ] **Step 1: Edit the import and type**

In `src/core/agents/maturityAdvancer.ts`, replace line 1:

```typescript
import type { ObsidianFacade } from "../../adapters/obsidianFacade";
```

with:

```typescript
import type { VaultAdapter } from "../../adapters/vaultAdapter";
```

Then in the `MaturityAdvancerOptions` interface, replace:

```typescript
  facade: Pick<ObsidianFacade, "read" | "write">;
```

with:

```typescript
  facade: Pick<VaultAdapter, "read" | "write">;
```

- [ ] **Step 2: Run the maturityAdvancer test**

Run: `bun test src/core/agents/maturityAdvancer.test.ts`
Expected: PASS. The test fakes `read` and `write`, so the type-only swap is invisible.

- [ ] **Step 3: Commit**

```bash
git add src/core/agents/maturityAdvancer.ts
git commit -m "$(cat <<'EOF'
refactor(agents): MaturityAdvancer takes VaultAdapter

Drops the type-only ObsidianFacade import. The Pick narrows to read +
write, identical between ObsidianFacade and VaultAdapter, so the test
fakes are unchanged.
EOF
)"
```

---

## Group 5: Kernel rebind

### Task 7: Rebind `kernel.ts` to `VaultAdapter` and the new canvas import path

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/kernel.ts`

The kernel imports `ObsidianFacade` and `CanvasFromResults`. Switch the type to `VaultAdapter`; rename the registry field from `facade` to `vault` to make the abstraction explicit; relocate the canvas import.

- [ ] **Step 1: Edit imports**

In `src/core/kernel.ts`, replace lines 1-2:

```typescript
import type { ObsidianFacade } from "../adapters/obsidianFacade";
import type { CanvasFromResults } from "../ui/search/canvasFromResults";
```

with:

```typescript
import type { VaultAdapter } from "../adapters/vaultAdapter";
import type { CanvasFromResults } from "./canvas/canvasFromResults";
```

- [ ] **Step 2: Replace the `facade` field with `vault`**

In `ServiceRegistry`, replace:

```typescript
  facade: ObsidianFacade;
```

with:

```typescript
  vault: VaultAdapter;
```

In `REQUIRED_KEYS`, replace `"facade",` with `"vault",`.

- [ ] **Step 3: Verify there are no other `facade:` references in this file**

Run: `grep -n "facade" src/core/kernel.ts`
Expected: No matches. If any survive, replace them with `vault` consistently.

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: There will be type errors in `src/main.ts` (which references `kernel.get('facade')`), `src/ui/**`, and a handful of test files referencing the old key. These are fine: `main.ts` and `src/ui/**` archive in Group 6 (Tasks 8–11). Only fix typecheck errors that remain in non-archived files. After Group 6 the typecheck must be green.

If a substrate test (under `src/core/**`) references `kernel.get('facade')`, fix that test in this commit by replacing the key with `'vault'`. Substrate tests stay green throughout.

- [ ] **Step 5: Commit**

```bash
git add src/core/kernel.ts
git commit -m "$(cat <<'EOF'
refactor(kernel): bind to VaultAdapter; relocate canvas import

The ServiceRegistry.facade field is renamed to vault and typed against
VaultAdapter. CanvasFromResults moves to src/core/canvas/, so the import
follows. Wiring updates in daemon/bootstrap.ts (later commit). Tests
under src/core that referenced kernel.get("facade") flip to "vault" in
the same commit.
EOF
)"
```

---

## Group 6: Archive moves

Each move uses `mv` (or `git mv` for files git already tracks). Stage by name. Each commit message follows the spec section 7 format. Run `bun run typecheck` after each move to confirm nothing else collapsed.

### Task 8: Archive `src/main.ts`

**Files:**
- Move: `/home/akougkas/projects/notient/src/main.ts` → `/home/akougkas/projects/notient/.nuked/src/main.ts`

- [ ] **Step 1: Create the archive directory tree**

```bash
mkdir -p .nuked/src
```

- [ ] **Step 2: Move the file**

```bash
git mv src/main.ts .nuked/src/main.ts
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: Errors localized to `src/ui/**` (which references compile-time identifiers from `main.ts`). Substrate must be green. If any substrate file still imports from `../main` or `./main`, stop and investigate.

- [ ] **Step 4: Commit**

```bash
git add -- src/main.ts .nuked/src/main.ts
git commit -m "$(cat <<'EOF'
chore(nuke): archive Obsidian plugin entry to .nuked/

Moved (not deleted):
- src/main.ts → .nuked/src/main.ts
EOF
)"
```

---

### Task 9: Archive `src/adapters/obsidianFacade.ts` + test

**Files:**
- Move: `/home/akougkas/projects/notient/src/adapters/obsidianFacade.ts` → `/home/akougkas/projects/notient/.nuked/src/adapters/obsidianFacade.ts`
- Move: `/home/akougkas/projects/notient/src/adapters/obsidianFacade.test.ts` → `/home/akougkas/projects/notient/.nuked/src/adapters/obsidianFacade.test.ts`

- [ ] **Step 1: Move both files**

```bash
mkdir -p .nuked/src/adapters
git mv src/adapters/obsidianFacade.ts .nuked/src/adapters/obsidianFacade.ts
git mv src/adapters/obsidianFacade.test.ts .nuked/src/adapters/obsidianFacade.test.ts
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: Substrate green. Errors only in `src/ui/**`.

- [ ] **Step 3: Run substrate tests**

Run: `bun test src/core src/adapters`
Expected: Green.

- [ ] **Step 4: Commit**

```bash
git add -- src/adapters/obsidianFacade.ts src/adapters/obsidianFacade.test.ts .nuked/src/adapters/obsidianFacade.ts .nuked/src/adapters/obsidianFacade.test.ts
git commit -m "$(cat <<'EOF'
chore(nuke): archive ObsidianFacade adapter to .nuked/

Moved (not deleted):
- src/adapters/obsidianFacade.ts → .nuked/src/adapters/obsidianFacade.ts
- src/adapters/obsidianFacade.test.ts → .nuked/src/adapters/obsidianFacade.test.ts

The substrate now binds to VaultAdapter. FsVault is the production
implementation; an Obsidian bridge adapter lands in Phase B.
EOF
)"
```

---

### Task 10: Archive `src/ui/**` and verify no orphan obsidian imports

**Files:**
- Move: `/home/akougkas/projects/notient/src/ui/` → `/home/akougkas/projects/notient/.nuked/src/ui/`

- [ ] **Step 1: Move the entire UI tree**

```bash
mkdir -p .nuked/src
git mv src/ui .nuked/src/ui
```

- [ ] **Step 2: Verify no substrate file still imports obsidian or from ui/**

Run:

```bash
grep -rn 'from "obsidian"' src/ 2>&1 || true
grep -rn 'from "\\./ui\|from "\\.\\./ui\|from "\\.\\./\\.\\./ui' src/ 2>&1 || true
grep -rn 'from "\\.\\./adapters/obsidianFacade\|from "\\.\\./\\.\\./adapters/obsidianFacade' src/ 2>&1 || true
```

Expected: No matches in any case. If any survive, fix them in this commit by replacing the import with the equivalent VaultAdapter call before committing.

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: Green. The substrate tree now compiles cleanly without any UI references.

- [ ] **Step 4: Run the full test suite**

Run: `bun test`
Expected: Green. Substrate-only tests are the only ones running.

- [ ] **Step 5: Commit**

```bash
git add -- src/ui .nuked/src/ui
git commit -m "$(cat <<'EOF'
chore(nuke): archive src/ui to .nuked/

Moved (not deleted):
- src/ui/** → .nuked/src/ui/**

Phase A drops the entire Obsidian sidebar, modals, decorations,
search UI, chat UI, approvals UI, history modal, onboarding wizard,
and editor decorations. The substrate is UI-agnostic from this commit
forward.
EOF
)"
```

---

### Task 11: Archive remaining plugin shell (styles.css, manifest.json, SettingsTab)

**Files:**
- Move: `/home/akougkas/projects/notient/src/styles.css` → `/home/akougkas/projects/notient/.nuked/src/styles.css`
- Move: `/home/akougkas/projects/notient/manifest.json` → `/home/akougkas/projects/notient/.nuked/manifest.json`
- Move: `/home/akougkas/projects/notient/src/core/settings/SettingsTab.ts` → `/home/akougkas/projects/notient/.nuked/src/core/settings/SettingsTab.ts`

- [ ] **Step 1: Move all three**

```bash
mkdir -p .nuked/src/core/settings
git mv src/styles.css .nuked/src/styles.css
git mv manifest.json .nuked/manifest.json
git mv src/core/settings/SettingsTab.ts .nuked/src/core/settings/SettingsTab.ts
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 3: Run lint**

Run: `bun run lint`
Expected: Green. The biome ignore for `.nuked/**` keeps archive content out of scope.

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: Green.

- [ ] **Step 5: Commit**

```bash
git add -- src/styles.css manifest.json src/core/settings/SettingsTab.ts .nuked/src/styles.css .nuked/manifest.json .nuked/src/core/settings/SettingsTab.ts
git commit -m "$(cat <<'EOF'
chore(nuke): archive plugin shell to .nuked/

Moved (not deleted):
- src/styles.css → .nuked/src/styles.css
- manifest.json → .nuked/manifest.json
- src/core/settings/SettingsTab.ts → .nuked/src/core/settings/SettingsTab.ts

The plugin shell is gone. SettingsService now takes a generic
ConfigStore wired to <vault>/.notient/config.json by the daemon
bootstrap.
EOF
)"
```

---

## Group 7: Daemon skeleton

Tasks 12, 13, 14 are independent and can dispatch in parallel. Tasks 15 and 16 are sequential.

### Task 12: `src/daemon/socket.ts` — platform-aware socket path resolver

**Files:**
- Create: `/home/akougkas/projects/notient/src/daemon/socket.ts`
- Create: `/home/akougkas/projects/notient/src/daemon/socket.test.ts`

- [ ] **Step 1: Write the test**

Create `src/daemon/socket.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { resolveSocketPath } from "./socket";

describe("resolveSocketPath", () => {
  test("Linux/macOS/WSL2 returns <vault>/.notient/notient.sock", () => {
    const result = resolveSocketPath("/home/user/notes", "linux");
    expect(result).toBe("/home/user/notes/.notient/notient.sock");
  });

  test("Windows native returns named pipe with sha8 hash", () => {
    const result = resolveSocketPath("C:\\Users\\user\\notes", "win32");
    expect(result.startsWith("\\\\.\\pipe\\notient-")).toBe(true);
    expect(result.length).toBe("\\\\.\\pipe\\notient-".length + 8);
  });

  test("hash is stable across calls", () => {
    const a = resolveSocketPath("C:\\Users\\user\\notes", "win32");
    const b = resolveSocketPath("C:\\Users\\user\\notes", "win32");
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/daemon/socket.test.ts`
Expected: FAIL because `socket.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/daemon/socket.ts`:

```typescript
import { createHash } from "node:crypto";

export type Platform = "linux" | "darwin" | "win32";

/**
 * Returns the platform-appropriate socket path for a daemon serving the given
 * absolute vault path. Linux, macOS, and WSL2 use a Unix socket inside the
 * vault's .notient/ folder. Windows native uses a named pipe whose suffix is
 * the first eight hex chars of sha256(absoluteVaultPath).
 */
export function resolveSocketPath(absoluteVaultPath: string, platform: Platform): string {
  if (platform === "win32") {
    const hash = createHash("sha256")
      .update(absoluteVaultPath)
      .digest("hex")
      .slice(0, 8);
    return `\\\\.\\pipe\\notient-${hash}`;
  }
  return `${absoluteVaultPath}/.notient/notient.sock`;
}

export function currentPlatform(): Platform {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/daemon/socket.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/socket.ts src/daemon/socket.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): platform-aware socket path resolver

Linux/macOS/WSL2 use a Unix socket at <vault>/.notient/notient.sock;
Windows native uses a named pipe keyed by sha8 of the absolute vault
path. Test covers both branches plus hash stability.
EOF
)"
```

---

### Task 13: `src/daemon/lifecycle.ts` — idle-exit timer + PID file

**Files:**
- Create: `/home/akougkas/projects/notient/src/daemon/lifecycle.ts`
- Create: `/home/akougkas/projects/notient/src/daemon/lifecycle.test.ts`

The lifecycle module owns three things: a timer that fires `onIdleExit` after `idleExitMs` of no activity, a `markActive()` accessor that resets the timer, and a `writePidFile` / `removePidFile` pair for `<vault>/.notient/notient.lock`.

- [ ] **Step 1: Write the test**

Create `src/daemon/lifecycle.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdleExitTimer, removePidFile, writePidFile } from "./lifecycle";

describe("IdleExitTimer", () => {
  test("fires after idleMs with no markActive", async () => {
    let fired = false;
    const timer = new IdleExitTimer({
      idleMs: 30,
      onIdleExit: () => {
        fired = true;
      },
    });
    timer.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fired).toBe(true);
    timer.stop();
  });

  test("markActive resets the deadline", async () => {
    let fired = false;
    const timer = new IdleExitTimer({
      idleMs: 50,
      onIdleExit: () => {
        fired = true;
      },
    });
    timer.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    timer.markActive();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fired).toBe(false);
    timer.stop();
  });
});

describe("PID file", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-pid-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("write creates a JSON record at the path", async () => {
    const path = join(root, "notient.lock");
    await writePidFile(path, {
      pid: 1234,
      instanceId: "abc",
      socketPath: "/tmp/sock",
      startedAt: 1000,
      version: "0.1.0",
    });
    const raw = await readFile(path, "utf-8");
    expect(JSON.parse(raw)).toEqual({
      pid: 1234,
      instanceId: "abc",
      socketPath: "/tmp/sock",
      startedAt: 1000,
      version: "0.1.0",
    });
  });

  test("remove deletes the file silently when missing", async () => {
    await removePidFile(join(root, "missing.lock"));
    expect(true).toBe(true);
  });

  test("remove deletes the file when present", async () => {
    const path = join(root, "notient.lock");
    await writePidFile(path, {
      pid: 1,
      instanceId: "x",
      socketPath: "/tmp/sock",
      startedAt: 0,
      version: "0",
    });
    await removePidFile(path);
    let exists = true;
    try {
      await stat(path);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/daemon/lifecycle.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `src/daemon/lifecycle.ts`:

```typescript
import { rm, writeFile } from "node:fs/promises";

export interface IdleExitTimerOptions {
  idleMs: number;
  onIdleExit: () => void;
}

export class IdleExitTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: IdleExitTimerOptions) {}

  start(): void {
    this.markActive();
  }

  markActive(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.options.onIdleExit(), this.options.idleMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export interface PidRecord {
  pid: number;
  instanceId: string;
  socketPath: string;
  startedAt: number;
  version: string;
}

export async function writePidFile(path: string, record: PidRecord): Promise<void> {
  await writeFile(path, JSON.stringify(record), "utf-8");
}

export async function removePidFile(path: string): Promise<void> {
  await rm(path, { force: true });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/daemon/lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/lifecycle.ts src/daemon/lifecycle.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): idle-exit timer + PID file IO

IdleExitTimer fires onIdleExit after idleMs of no markActive() calls.
writePidFile / removePidFile manage <vault>/.notient/notient.lock. Phase
A wires both into daemon/index.ts; tunable via config.json
daemon.idleExitHours arrives in Phase B.
EOF
)"
```

---

### Task 14: `src/daemon/rpc.ts` — NDJSON protocol skeleton

**Files:**
- Create: `/home/akougkas/projects/notient/src/daemon/rpc.ts`
- Create: `/home/akougkas/projects/notient/src/daemon/rpc.test.ts`

`rpc.ts` exports two units: an envelope-encoder/decoder pair plus a `MethodDispatcher`. Phase A only registers `daemon.status`, `daemon.shutdown`, `daemon.config_get`, `daemon.config_set`. Other methods return error code `INVALID_PARAMS` with `message: "method not implemented in Phase A"`.

- [ ] **Step 1: Write the test**

Create `src/daemon/rpc.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
  type RpcEnvelope,
  MethodDispatcher,
  encodeAck,
  encodeError,
  encodeEvent,
  encodeResult,
  parseEnvelope,
} from "./rpc";

describe("envelope codec", () => {
  test("parseEnvelope accepts a well-formed request", () => {
    const line = JSON.stringify({ id: "req-1", method: "daemon.status", params: {} });
    const result = parseEnvelope(line);
    expect(result).toEqual({
      ok: true,
      envelope: { id: "req-1", method: "daemon.status", params: {} },
    });
  });

  test("parseEnvelope rejects non-JSON", () => {
    const result = parseEnvelope("not json");
    expect(result.ok).toBe(false);
  });

  test("parseEnvelope rejects missing id or method", () => {
    expect(parseEnvelope(JSON.stringify({ method: "x" })).ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ id: "x" })).ok).toBe(false);
  });

  test("encodeAck/event/result/error produce stable shapes", () => {
    expect(JSON.parse(encodeAck("req-1", "daemon.status"))).toEqual({
      id: "req-1",
      type: "ack",
      method: "daemon.status",
    });
    expect(JSON.parse(encodeEvent("req-1", "indexer:queued", { path: "a.md" }))).toEqual({
      id: "req-1",
      type: "event",
      event: "indexer:queued",
      path: "a.md",
    });
    expect(JSON.parse(encodeResult("req-1", { ok: true }))).toEqual({
      id: "req-1",
      type: "result",
      ok: true,
    });
    expect(JSON.parse(encodeError("req-1", "INVALID_PARAMS", "bad", { detail: 1 }))).toEqual({
      id: "req-1",
      type: "error",
      code: "INVALID_PARAMS",
      message: "bad",
      detail: { detail: 1 },
    });
  });
});

describe("MethodDispatcher", () => {
  test("dispatches a registered method", async () => {
    const dispatcher = new MethodDispatcher();
    dispatcher.register("daemon.status", async () => ({ pid: 42 }));
    const lines: string[] = [];
    const envelope: RpcEnvelope = { id: "req-1", method: "daemon.status", params: {} };
    await dispatcher.dispatch(envelope, (line) => {
      lines.push(line);
    });
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).type).toBe("ack");
    expect(JSON.parse(lines[1])).toEqual({
      id: "req-1",
      type: "result",
      pid: 42,
    });
  });

  test("returns INVALID_PARAMS for unregistered method", async () => {
    const dispatcher = new MethodDispatcher();
    const lines: string[] = [];
    const envelope: RpcEnvelope = { id: "req-9", method: "chat.send", params: {} };
    await dispatcher.dispatch(envelope, (line) => {
      lines.push(line);
    });
    expect(JSON.parse(lines[0]).type).toBe("ack");
    expect(JSON.parse(lines[1])).toEqual({
      id: "req-9",
      type: "error",
      code: "INVALID_PARAMS",
      message: "method not implemented in Phase A",
      detail: { method: "chat.send" },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/daemon/rpc.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `rpc.ts`**

Create `src/daemon/rpc.ts`:

```typescript
export interface RpcEnvelope {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export type ParseResult =
  | { ok: true; envelope: RpcEnvelope }
  | { ok: false; reason: string };

export function parseEnvelope(line: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "envelope is not an object" };
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.id !== "string") return { ok: false, reason: "id must be string" };
  if (typeof candidate.method !== "string") return { ok: false, reason: "method must be string" };
  const params =
    candidate.params && typeof candidate.params === "object" && !Array.isArray(candidate.params)
      ? (candidate.params as Record<string, unknown>)
      : {};
  return { ok: true, envelope: { id: candidate.id, method: candidate.method, params } };
}

export function encodeAck(id: string, method: string): string {
  return JSON.stringify({ id, type: "ack", method });
}

export function encodeEvent(
  id: string,
  event: string,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify({ id, type: "event", event, ...payload });
}

export function encodeResult(id: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ id, type: "result", ...payload });
}

export function encodeError(
  id: string,
  code: string,
  message: string,
  detail?: Record<string, unknown>,
): string {
  return JSON.stringify({
    id,
    type: "error",
    code,
    message,
    detail: detail ?? {},
  });
}

export type MethodHandler = (
  params: Record<string, unknown>,
  emit: (line: string) => void,
  envelopeId: string,
) => Promise<Record<string, unknown>>;

export class MethodDispatcher {
  private readonly handlers = new Map<string, MethodHandler>();

  register(method: string, handler: MethodHandler): void {
    this.handlers.set(method, handler);
  }

  async dispatch(envelope: RpcEnvelope, emit: (line: string) => void): Promise<void> {
    emit(encodeAck(envelope.id, envelope.method));
    const handler = this.handlers.get(envelope.method);
    if (!handler) {
      emit(
        encodeError(envelope.id, "INVALID_PARAMS", "method not implemented in Phase A", {
          method: envelope.method,
        }),
      );
      return;
    }
    try {
      const payload = await handler(envelope.params, emit, envelope.id);
      emit(encodeResult(envelope.id, payload));
    } catch (error) {
      emit(
        encodeError(
          envelope.id,
          "INTERNAL",
          error instanceof Error ? error.message : String(error),
          {},
        ),
      );
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/daemon/rpc.test.ts`
Expected: PASS, all 6 cases.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/rpc.ts src/daemon/rpc.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): NDJSON protocol skeleton

Envelope parser, ack/event/result/error encoders, and a
MethodDispatcher that turns one request envelope into one ack plus
one terminal frame. Unregistered methods return INVALID_PARAMS.
Phase B onwards registers awaken, search, vitals, chat handlers.
EOF
)"
```

---

### Task 15: `src/daemon/bootstrap.ts` — kernel wiring

**Files:**
- Create: `/home/akougkas/projects/notient/src/daemon/bootstrap.ts`

This file extracts the kernel wiring previously in `src/main.ts`. It accepts a `vaultPath` and returns a sealed kernel plus a `close()` to shut everything down. It uses `FsVault` for vault IO, a JSON `ConfigStore` for settings, and the existing substrate constructors for everything else.

Phase A drops Coordinator wiring (it lights up in Phase B) and chat / approvals / co-author wiring (Phase C). It does still construct services the daemon needs to answer `daemon.status` and `daemon.config_get/set`: SettingsService, EventBus, EchoGuard, Database, GraphStore, VaultLock, HealthMonitor, primaryLLM, deepLLM, embeddingLLM. Everything else can remain unwired in Phase A as long as the kernel can be sealed; the spec says Phase A only requires `daemon.{status,shutdown,config_get,config_set}`.

We will introduce a simpler `MinimalKernel` for Phase A and grow it into the full Kernel in Phase B/C. **However** the full `Kernel.seal()` requires every key in `REQUIRED_KEYS`. So we either:
(a) downgrade `Kernel.seal()` to allow a Phase-A subset (cleaner; kernel is locked spec-wise, but `REQUIRED_KEYS` is implementation detail and not in the spec), OR
(b) wire stub services (cheap, but produces dead code that ships).

**Decision (locked in spec section 2.4 + 6 Phase A goal):** the substrate is locked but `REQUIRED_KEYS` is wiring scaffolding, not substrate. We can soften it to "REQUIRED_PHASE_A_KEYS" by introducing a phase parameter on `seal()`. The cleanest path: introduce a `seal({ phase: "A" | "B" | "C" })` argument that toggles which keys are required, defaulting to phase A in Phase A. Phase B promotes more keys; Phase C promotes the rest.

This is an intentional kernel API change scoped inside Phase A; flag it loudly in the commit message.

- [ ] **Step 1: Soften `Kernel.seal()` to accept a phase**

Edit `src/core/kernel.ts`. After the `REQUIRED_KEYS` constant, add:

```typescript
const PHASE_A_KEYS: ServiceKey[] = [
  "bus",
  "settings",
  "vault",
  "database",
  "graph",
  "primaryLLM",
  "deepLLM",
  "embeddingLLM",
  "health",
  "lock",
  "echoGuard",
];
```

Then change the `seal()` method on `Kernel`:

```typescript
  seal(options: { phase?: "A" | "B" | "C" } = {}): void {
    const required = options.phase === "A" ? PHASE_A_KEYS : REQUIRED_KEYS;
    const missing = required.filter((key) => this.services[key] === undefined);
    if (missing.length > 0) {
      throw new Error(`Kernel.seal(): missing required services: ${missing.join(", ")}`);
    }
    this.sealed = true;
  }
```

Run: `bun run typecheck && bun test src/core/kernel.test.ts || bun test src/core`
Expected: Green. The change is backwards-compatible because the default phase is the full set.

Commit this kernel softening as its own commit:

```bash
git add src/core/kernel.ts
git commit -m "$(cat <<'EOF'
refactor(kernel): seal() accepts a phase argument

Phase A wires only a substrate subset (no coordinator, chat, approvals,
streamService, etc). The new options.phase narrows REQUIRED_KEYS so
Phase A bootstrap can seal cleanly. Default behaviour is unchanged when
the argument is omitted.
EOF
)"
```

- [ ] **Step 2: Write `src/daemon/bootstrap.ts`**

Create `src/daemon/bootstrap.ts`:

```typescript
import { join } from "node:path";
import { FsVault } from "../adapters/fsVault";
import { Database } from "../core/db/database";
import { EventBus } from "../core/events/eventBus";
import { GraphStore } from "../core/graph/graphStore";
import { Kernel } from "../core/kernel";
import { LMStudioProvider } from "../core/llm/lmStudioProvider";
import { EchoGuard } from "../core/services/echoGuard";
import { HealthMonitor } from "../core/services/healthMonitor";
import { VaultLock, type VaultLockHandle } from "../core/services/vaultLock";
import { type ConfigStore, SettingsService } from "../core/settings/settingsService";

export interface BootstrapOptions {
  vaultPath: string;
}

export interface BootstrapResult {
  kernel: Kernel;
  close: () => Promise<void>;
}

const NOTIENT_DIR = ".notient";
const DB_PATH = `${NOTIENT_DIR}/notient.db`;
const WASM_PATH = `${NOTIENT_DIR}/sql-wasm.wasm`;
const LOCK_PATH = `${NOTIENT_DIR}/notient.lock`;
const VECTOR_PATH = `${NOTIENT_DIR}/vectors.bin`;
const CONFIG_PATH = `${NOTIENT_DIR}/config.json`;

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const vault = new FsVault(options.vaultPath);
  const bus = new EventBus();
  const echoGuard = new EchoGuard();

  const configStore: ConfigStore = {
    load: async () => {
      const raw = await vault.read(CONFIG_PATH).catch(() => null);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    },
    save: async (value) => {
      await vault.write(CONFIG_PATH, JSON.stringify(value, null, 2));
    },
  };
  const settings = new SettingsService(configStore, bus);
  await settings.load();

  const lockFs = {
    exists: (path: string) => vault.exists(path),
    read: (path: string) => vault.read(path),
    writeBinary: (path: string, data: ArrayBuffer) => vault.writeBinary(path, data),
    remove: (path: string) => vault.remove(path),
  };
  const lock = new VaultLock(
    lockFs,
    LOCK_PATH,
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const lockHandle: VaultLockHandle = await lock.acquire();

  const database = new Database(
    {
      readBinary: (path) => vault.readBinary(path),
      writeBinary: (path, data) => vault.writeBinary(path, data),
    },
    { dbPath: DB_PATH, wasmPath: WASM_PATH },
  );
  await database.init();
  const graph = new GraphStore(database);

  const current = settings.get();
  const primaryLLM = new LMStudioProvider({ baseUrl: current.primary.baseUrl });
  const deepLLM = new LMStudioProvider({ baseUrl: current.deep.baseUrl });
  const embeddingLLM = new LMStudioProvider({ baseUrl: current.embedding.baseUrl });

  const health = new HealthMonitor(
    [
      { label: "primary", baseUrl: current.primary.baseUrl, provider: primaryLLM },
      { label: "deep", baseUrl: current.deep.baseUrl, provider: deepLLM },
      { label: "embedding", baseUrl: current.embedding.baseUrl, provider: embeddingLLM },
    ],
    bus,
    { intervalMs: 30_000 },
  );

  const kernel = new Kernel();
  kernel.register("bus", bus);
  kernel.register("settings", settings);
  kernel.register("vault", vault);
  kernel.register("database", database);
  kernel.register("graph", graph);
  kernel.register("primaryLLM", primaryLLM);
  kernel.register("deepLLM", deepLLM);
  kernel.register("embeddingLLM", embeddingLLM);
  kernel.register("health", health);
  kernel.register("lock", lockHandle);
  kernel.register("echoGuard", echoGuard);
  kernel.seal({ phase: "A" });

  health.start();

  const close = async (): Promise<void> => {
    health.stop();
    await database.persist();
    await database.close();
    await lockHandle.release();
    void join(options.vaultPath, VECTOR_PATH);
  };

  return { kernel, close };
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/bootstrap.ts
git commit -m "$(cat <<'EOF'
feat(daemon): kernel bootstrap for Phase A

Wires FsVault, ConfigStore-backed SettingsService, EventBus, EchoGuard,
Database (sql.js), GraphStore, three LMStudioProvider instances, and
HealthMonitor. Seals the kernel with phase: "A" so Coordinator, chat,
approvals, and other Phase B+ services do not have to be wired yet.
The close() handle persists the database and releases the vault lock.
EOF
)"
```

---

### Task 16: `src/daemon/index.ts` — entry point

**Files:**
- Create: `/home/akougkas/projects/notient/src/daemon/index.ts`

The entry script: parses `--vault <path>`, runs `bootstrap`, opens the Unix socket via `node:net`, registers Phase A method handlers, manages the idle-exit timer, writes the PID file, and handles SIGINT/SIGTERM.

- [ ] **Step 1: Write `src/daemon/index.ts`**

Create `src/daemon/index.ts`:

```typescript
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { bootstrap } from "./bootstrap";
import { IdleExitTimer, removePidFile, writePidFile } from "./lifecycle";
import { MethodDispatcher, parseEnvelope } from "./rpc";
import { currentPlatform, resolveSocketPath } from "./socket";

const VERSION = "0.1.0-phaseA";
const DEFAULT_IDLE_HOURS = 4;

interface DaemonArgs {
  vaultPath: string;
}

function parseArgs(argv: string[]): DaemonArgs {
  const flagIndex = argv.indexOf("--vault");
  if (flagIndex === -1 || flagIndex === argv.length - 1) {
    throw new Error("Daemon entry requires --vault <absolute-path>.");
  }
  const vaultPath = argv[flagIndex + 1];
  return { vaultPath };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const platform = currentPlatform();
  const socketPath = resolveSocketPath(args.vaultPath, platform);

  const { kernel, close: closeBootstrap } = await bootstrap({ vaultPath: args.vaultPath });
  const startedAt = Date.now();
  const instanceId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const pidPath = `${args.vaultPath}/.notient/notient.lock.daemon`;

  await mkdir(`${args.vaultPath}/.notient`, { recursive: true });
  await rm(socketPath, { force: true });

  const dispatcher = new MethodDispatcher();
  const idleTimer = new IdleExitTimer({
    idleMs: DEFAULT_IDLE_HOURS * 60 * 60 * 1000,
    onIdleExit: () => {
      void shutdown("idle-exit");
    },
  });

  let shuttingDown = false;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      idleTimer.markActive();
      buffer += chunk.toString("utf-8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) handleLine(socket, line);
        newlineIndex = buffer.indexOf("\n");
      }
    });
  });

  function handleLine(socket: Socket, line: string): void {
    const parsed = parseEnvelope(line);
    if (!parsed.ok) {
      socket.write(
        `${JSON.stringify({
          id: "unknown",
          type: "error",
          code: "INVALID_PARAMS",
          message: parsed.reason,
          detail: {},
        })}\n`,
      );
      return;
    }
    void dispatcher.dispatch(parsed.envelope, (frame) => {
      socket.write(`${frame}\n`);
    });
  }

  dispatcher.register("daemon.status", async () => {
    return {
      ok: true,
      vault: args.vaultPath,
      pid: process.pid,
      socketPath,
      startedAt,
      version: VERSION,
      sealed: kernel.isSealed(),
    };
  });

  dispatcher.register("daemon.shutdown", async () => {
    setImmediate(() => {
      void shutdown("client-request");
    });
    return { ok: true };
  });

  const settings = kernel.get("settings");
  dispatcher.register("daemon.config_get", async () => {
    return { ok: true, config: settings.get() };
  });

  dispatcher.register("daemon.config_set", async (params) => {
    const patch = params as Record<string, unknown>;
    await settings.update(patch);
    return { ok: true, config: settings.get() };
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  await writePidFile(pidPath, {
    pid: process.pid,
    instanceId,
    socketPath,
    startedAt,
    version: VERSION,
  });

  idleTimer.start();

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    idleTimer.stop();
    for (const socket of sockets) socket.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(socketPath, { force: true }).catch(() => {});
    await closeBootstrap();
    await removePidFile(pidPath).catch(() => {});
    process.stdout.write(
      `${JSON.stringify({ type: "daemon:shutting_down", reason, vault: args.vaultPath })}\n`,
    );
    process.exit(0);
  }

  process.stdout.write(
    `${JSON.stringify({
      type: "daemon:ready",
      vault: args.vaultPath,
      version: VERSION,
      socketPath,
      pid: process.pid,
    })}\n`,
  );
}

void dirname; // keep import; bun --compile is finicky with unused identifiers in some bundles
void main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      type: "daemon:error",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
```

NOTE: The `process.stdout.write(...)` call for `daemon:ready` is the **only** allowed direct stdout write outside `src/cli/output.ts`. It is part of the daemon emitter, not CLI emitter, and produces NDJSON. Document this exception in the commit message.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/index.ts
git commit -m "$(cat <<'EOF'
feat(daemon): entry process opens Unix socket and serves Phase A RPC

Parses --vault <path>, runs bootstrap(), opens the platform-aware
socket, registers daemon.status, daemon.shutdown, daemon.config_get,
daemon.config_set, and idles out after 4 hours of inactivity. NDJSON
frames flow through MethodDispatcher; the daemon also writes
daemon:ready and daemon:shutting_down lifecycle frames to stdout
exactly once each. SIGINT/SIGTERM trigger graceful shutdown.
EOF
)"
```

---

## Group 8: CLI skeleton

Tasks 17 and 18 are independent. Task 19 depends on 17. Task 20 depends on 17 and 18. Task 21 depends on 19. Task 22 depends on 17–21.

### Task 17: `src/cli/output.ts` — emitter

**Files:**
- Create: `/home/akougkas/projects/notient/src/cli/output.ts`
- Create: `/home/akougkas/projects/notient/src/cli/output.test.ts`

The only legitimate `console.log` consumer in the entire repo (per spec section 8). Three modes: `json` (single JSON object then newline; default for non-TTY), `ndjson` (one JSON per event), `pretty` (default for TTY; pretty-prints highlights and skips noise).

- [ ] **Step 1: Write the test**

Create `src/cli/output.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { type EmitterMode, type StructuredEvent, makeEmitter } from "./output";

function captureMode(mode: EmitterMode): { lines: string[]; emit: (event: StructuredEvent) => void } {
  const lines: string[] = [];
  const emitter = makeEmitter({
    mode,
    write: (line) => {
      lines.push(line);
    },
  });
  return { lines, emit: emitter.emit };
}

describe("makeEmitter", () => {
  test("ndjson mode emits one JSON object per event", () => {
    const { lines, emit } = captureMode("ndjson");
    emit({ type: "indexer:queued", path: "a.md" });
    emit({ type: "indexer:queued", path: "b.md" });
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toEqual({ type: "indexer:queued", path: "a.md" });
    expect(JSON.parse(lines[1])).toEqual({ type: "indexer:queued", path: "b.md" });
  });

  test("json mode emits a single object on flush", () => {
    const { lines, emit } = captureMode("json");
    emit({ type: "result", data: { foo: 1 } });
    expect(lines).toEqual([JSON.stringify({ type: "result", data: { foo: 1 } })]);
  });

  test("pretty mode renders type prefix", () => {
    const { lines, emit } = captureMode("pretty");
    emit({ type: "daemon:ready", vault: "/tmp/v" });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("daemon:ready");
    expect(lines[0]).toContain("/tmp/v");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/cli/output.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `src/cli/output.ts`:

```typescript
export type EmitterMode = "json" | "ndjson" | "pretty";

export interface StructuredEvent {
  type: string;
  [key: string]: unknown;
}

export interface EmitterOptions {
  mode: EmitterMode;
  write?: (line: string) => void;
}

export interface Emitter {
  emit: (event: StructuredEvent) => void;
}

export function makeEmitter(options: EmitterOptions): Emitter {
  const write =
    options.write ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });

  if (options.mode === "ndjson") {
    return {
      emit: (event) => {
        write(JSON.stringify(event));
      },
    };
  }

  if (options.mode === "json") {
    return {
      emit: (event) => {
        write(JSON.stringify(event));
      },
    };
  }

  return {
    emit: (event) => {
      const detail = Object.entries(event)
        .filter(([key]) => key !== "type")
        .map(([key, value]) => `${key}=${formatValue(value)}`)
        .join(" ");
      write(detail.length > 0 ? `${event.type} ${detail}` : event.type);
    },
  };
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function defaultMode(isTty: boolean): EmitterMode {
  return isTty ? "pretty" : "json";
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/cli/output.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/output.ts src/cli/output.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): structured output emitter

Three modes: json (single object), ndjson (one per event), pretty (TTY
default). The write sink is injectable so tests capture lines without
touching stdout. defaultMode picks json for non-TTY, pretty for TTY.
This is the only allowed console.log path per Phase A hard rules.
EOF
)"
```

---

### Task 18: `src/cli/env.ts` — vault resolution

**Files:**
- Create: `/home/akougkas/projects/notient/src/cli/env.ts`
- Create: `/home/akougkas/projects/notient/src/cli/env.test.ts`

Resolution order from spec section 5.3:
1. `--vault <path>` flag wins.
2. `NOTIENT_VAULT` env var.
3. Cwd has `.notient/` or `.obsidian/`.
4. Walk up parents.
5. `~/.config/notient/state.json` `lastVault`.
6. Fail.

- [ ] **Step 1: Write the test**

Create `src/cli/env.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVault } from "./env";

describe("resolveVault", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-env-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("--vault wins over env and cwd", async () => {
    const flagPath = join(root, "from-flag");
    await mkdir(flagPath, { recursive: true });
    const result = await resolveVault({
      flagVault: flagPath,
      env: { NOTIENT_VAULT: join(root, "from-env") },
      cwd: join(root, "from-cwd"),
      stateLoader: async () => null,
    });
    expect(result).toBe(flagPath);
  });

  test("env var fires when no flag", async () => {
    const envPath = join(root, "from-env");
    await mkdir(envPath, { recursive: true });
    const result = await resolveVault({
      flagVault: null,
      env: { NOTIENT_VAULT: envPath },
      cwd: join(root, "from-cwd"),
      stateLoader: async () => null,
    });
    expect(result).toBe(envPath);
  });

  test("cwd with .notient/ wins over state", async () => {
    const cwd = join(root, "vault-cwd");
    await mkdir(join(cwd, ".notient"), { recursive: true });
    const result = await resolveVault({
      flagVault: null,
      env: {},
      cwd,
      stateLoader: async () => "/some/other",
    });
    expect(result).toBe(cwd);
  });

  test("walks up parents to find .obsidian/", async () => {
    const parent = join(root, "parent");
    const child = join(parent, "child");
    await mkdir(join(parent, ".obsidian"), { recursive: true });
    await mkdir(child, { recursive: true });
    const result = await resolveVault({
      flagVault: null,
      env: {},
      cwd: child,
      stateLoader: async () => null,
    });
    expect(result).toBe(parent);
  });

  test("falls back to last vault from state", async () => {
    const lastVault = join(root, "last");
    await mkdir(lastVault, { recursive: true });
    const result = await resolveVault({
      flagVault: null,
      env: {},
      cwd: join(root, "stranger"),
      stateLoader: async () => lastVault,
    });
    expect(result).toBe(lastVault);
  });

  test("throws helpful error when nothing matches", async () => {
    await expect(
      resolveVault({
        flagVault: null,
        env: {},
        cwd: join(root, "stranger"),
        stateLoader: async () => null,
      }),
    ).rejects.toThrow("No vault");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/cli/env.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `src/cli/env.ts`:

```typescript
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface ResolveVaultOptions {
  flagVault: string | null;
  env: Record<string, string | undefined>;
  cwd: string;
  stateLoader: () => Promise<string | null>;
}

export async function resolveVault(options: ResolveVaultOptions): Promise<string> {
  if (options.flagVault) return absolutize(options.flagVault, options.cwd);

  const envValue = options.env.NOTIENT_VAULT;
  if (envValue) return absolutize(envValue, options.cwd);

  const climbed = await climbForVault(options.cwd);
  if (climbed) return climbed;

  const fromState = await options.stateLoader();
  if (fromState) return fromState;

  throw new Error("No vault. Run 'notient init <path>' first.");
}

async function climbForVault(start: string): Promise<string | null> {
  let current = start;
  while (true) {
    if (await isVaultRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function isVaultRoot(path: string): Promise<boolean> {
  return (await pathExists(join(path, ".notient"))) || (await pathExists(join(path, ".obsidian")));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function absolutize(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function defaultStateLoader(): () => Promise<string | null> {
  const path = join(homedir(), ".config", "notient", "state.json");
  return async () => {
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as { lastVault?: string };
      return parsed.lastVault ?? null;
    } catch {
      return null;
    }
  };
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/cli/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/env.ts src/cli/env.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): vault resolution per spec 5.3

Resolves the active vault via flag > env > cwd-with-.notient-or-.obsidian
> parent walk > ~/.config/notient/state.json > fail with helpful error.
defaultStateLoader covers the production state file; tests inject the
loader so they never touch the user's home directory.
EOF
)"
```

---

### Task 19: `src/cli/client.ts` — daemon RPC client with auto-spawn

**Files:**
- Create: `/home/akougkas/projects/notient/src/cli/client.ts`

The client connects to the socket. On `ENOENT` or `ECONNREFUSED`, it forks `notient daemon start --vault <path> --detached`, polls the socket for up to 3 seconds, then connects. Once connected, it writes one line per request and matches frames by `id`.

- [ ] **Step 1: Write the implementation**

Create `src/cli/client.ts`:

```typescript
import { type ChildProcess, spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";

export interface ClientOptions {
  socketPath: string;
  vaultPath: string;
  /** Override for the daemon binary path; default uses `process.execPath` argv[0]. */
  daemonCommand?: string;
  daemonArgs?: string[];
  spawnTimeoutMs?: number;
}

export interface RpcResponseFrame {
  id: string;
  type: "ack" | "event" | "result" | "error";
  [key: string]: unknown;
}

export interface ClientHandle {
  call(method: string, params: Record<string, unknown>): AsyncIterable<RpcResponseFrame>;
  close(): Promise<void>;
}

const SPAWN_DEFAULT_MS = 3000;

export async function connectClient(options: ClientOptions): Promise<ClientHandle> {
  const socket = await connectOrSpawn(options);
  let buffer = "";
  const queues = new Map<string, RpcResponseFrame[]>();
  const waiters = new Map<string, ((frame: RpcResponseFrame) => void)[]>();

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) deliver(line);
      newlineIndex = buffer.indexOf("\n");
    }
  });

  let nextId = 1;

  function deliver(line: string): void {
    let frame: RpcResponseFrame;
    try {
      frame = JSON.parse(line) as RpcResponseFrame;
    } catch {
      return;
    }
    const id = frame.id;
    const waitingForId = waiters.get(id);
    if (waitingForId && waitingForId.length > 0) {
      const waiter = waitingForId.shift();
      if (waiter) waiter(frame);
      return;
    }
    const queue = queues.get(id) ?? [];
    queue.push(frame);
    queues.set(id, queue);
  }

  async function* call(method: string, params: Record<string, unknown>): AsyncIterable<RpcResponseFrame> {
    const id = `req-${nextId++}`;
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
    while (true) {
      const frame = await nextFrame(id);
      yield frame;
      if (frame.type === "result" || frame.type === "error") return;
    }
  }

  function nextFrame(id: string): Promise<RpcResponseFrame> {
    const queue = queues.get(id);
    if (queue && queue.length > 0) {
      const frame = queue.shift();
      if (frame) return Promise.resolve(frame);
    }
    return new Promise((resolve) => {
      const list = waiters.get(id) ?? [];
      list.push(resolve);
      waiters.set(id, list);
    });
  }

  async function close(): Promise<void> {
    socket.end();
  }

  return { call, close };
}

async function connectOrSpawn(options: ClientOptions): Promise<Socket> {
  try {
    return await openSocket(options.socketPath);
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }

  spawnDaemon(options);
  const deadline = Date.now() + (options.spawnTimeoutMs ?? SPAWN_DEFAULT_MS);
  while (Date.now() < deadline) {
    if (await pathExists(options.socketPath)) {
      try {
        return await openSocket(options.socketPath);
      } catch {
        // fallthrough; the daemon may still be opening the socket file
      }
    }
    await sleep(50);
  }
  throw new Error(`Daemon failed to start within ${options.spawnTimeoutMs ?? SPAWN_DEFAULT_MS}ms`);
}

function spawnDaemon(options: ClientOptions): ChildProcess {
  const command = options.daemonCommand ?? process.execPath;
  const args = options.daemonArgs ?? [
    new URL("../daemon/index.ts", import.meta.url).pathname,
    "--vault",
    options.vaultPath,
  ];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return child;
}

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function useDirname(): string {
  return dirname(new URL(import.meta.url).pathname);
}
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 3: Commit**

```bash
git add src/cli/client.ts
git commit -m "$(cat <<'EOF'
feat(cli): NDJSON RPC client with auto-spawn

connectClient opens the daemon socket. On ENOENT/ECONNREFUSED it
spawns notient daemon start --vault <path> --detached, polls for
socket readiness up to 3 seconds, then connects. Each call() returns
an AsyncIterable of frames matched by envelope id; the iterable
closes after the terminal result/error frame.
EOF
)"
```

---

### Task 20: `src/cli/commands/init.ts` — bootstraps a vault

**Files:**
- Create: `/home/akougkas/projects/notient/src/cli/commands/init.ts`

`init` is daemon-less. It creates `<vault>/.notient/`, copies `sql-wasm.wasm` from the package root, writes `<vault>/.notient/config.json` with `DEFAULT_SETTINGS`, and updates `~/.config/notient/state.json` `lastVault`.

- [ ] **Step 1: Write the implementation**

Create `src/cli/commands/init.ts`:

```typescript
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_SETTINGS } from "../../core/settings/types";
import type { Emitter } from "../output";

export interface InitOptions {
  vaultPathArg: string;
  cwd: string;
  emitter: Emitter;
  /** Absolute path to the bundled sql-wasm.wasm. Phase A: a known fixture under node_modules/sql.js/dist/. */
  sqlWasmSource: string;
  stateFilePath?: string;
}

export async function runInit(options: InitOptions): Promise<void> {
  const vaultPath = isAbsolute(options.vaultPathArg)
    ? options.vaultPathArg
    : resolve(options.cwd, options.vaultPathArg);
  const notientDir = join(vaultPath, ".notient");
  await mkdir(notientDir, { recursive: true });
  await copyFile(options.sqlWasmSource, join(notientDir, "sql-wasm.wasm"));
  await writeFile(
    join(notientDir, "config.json"),
    JSON.stringify(DEFAULT_SETTINGS, null, 2),
    "utf-8",
  );
  const stateFile = options.stateFilePath ?? join(homedir(), ".config", "notient", "state.json");
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ lastVault: vaultPath }, null, 2), "utf-8");
  options.emitter.emit({ type: "init:done", vault: vaultPath });
}
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/init.ts
git commit -m "$(cat <<'EOF'
feat(cli): init command bootstraps a vault

Creates <vault>/.notient/, copies the bundled sql-wasm.wasm, writes
config.json from DEFAULT_SETTINGS, and updates the state file with
the new lastVault. Daemon-less. Emits init:done on completion.
EOF
)"
```

---

### Task 21: `src/cli/commands/daemon.ts` — daemon lifecycle commands

**Files:**
- Create: `/home/akougkas/projects/notient/src/cli/commands/daemon.ts`

Verbs: `start`, `stop`, `status`, `list`. `start` spawns the daemon explicitly (the auto-spawn from `client.ts` is the implicit path; `start` is the explicit one). `stop` calls `daemon.shutdown` over the socket. `status` calls `daemon.status` and emits the response. `list` enumerates daemons by walking `~/.config/notient/state.json` plus any vaults known via env.

For Phase A, implement `start`, `stop`, and `status`. `list` is a stub that emits a single event `daemon:list` carrying the lastVault from the state file.

- [ ] **Step 1: Write the implementation**

Create `src/cli/commands/daemon.ts`:

```typescript
import { spawn } from "node:child_process";
import { connectClient } from "../client";
import type { Emitter } from "../output";
import { resolveSocketPath, currentPlatform } from "../../daemon/socket";

export interface DaemonCommandOptions {
  verb: "start" | "stop" | "status" | "list";
  vaultPath: string | null;
  emitter: Emitter;
}

export async function runDaemonCommand(options: DaemonCommandOptions): Promise<void> {
  switch (options.verb) {
    case "start":
      await runStart(options);
      return;
    case "stop":
      await runStop(options);
      return;
    case "status":
      await runStatus(options);
      return;
    case "list":
      options.emitter.emit({ type: "daemon:list", note: "stub", lastVault: options.vaultPath });
      return;
  }
}

async function runStart(options: DaemonCommandOptions): Promise<void> {
  if (!options.vaultPath) throw new Error("daemon start requires --vault");
  const child = spawn(
    process.execPath,
    [new URL("../../daemon/index.ts", import.meta.url).pathname, "--vault", options.vaultPath],
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );
  child.unref();
  options.emitter.emit({ type: "daemon:start_spawned", pid: child.pid ?? -1 });
}

async function runStop(options: DaemonCommandOptions): Promise<void> {
  if (!options.vaultPath) throw new Error("daemon stop requires --vault");
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({ socketPath, vaultPath: options.vaultPath });
  for await (const frame of client.call("daemon.shutdown", {})) {
    options.emitter.emit({ type: `rpc:${frame.type}`, ...frame });
    if (frame.type === "result" || frame.type === "error") break;
  }
  await client.close();
}

async function runStatus(options: DaemonCommandOptions): Promise<void> {
  if (!options.vaultPath) throw new Error("daemon status requires --vault");
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({ socketPath, vaultPath: options.vaultPath });
  for await (const frame of client.call("daemon.status", {})) {
    options.emitter.emit({ type: `rpc:${frame.type}`, ...frame });
    if (frame.type === "result" || frame.type === "error") break;
  }
  await client.close();
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/daemon.ts
git commit -m "$(cat <<'EOF'
feat(cli): daemon start | stop | status | list

start spawns the daemon detached; stop and status open a client
connection (auto-spawning the daemon if needed) and forward every
NDJSON frame to the emitter. list is a Phase A stub that emits the
lastVault entry; full multi-vault enumeration arrives in Phase B.
EOF
)"
```

---

### Task 22: `src/cli/index.ts` — binary entry

**Files:**
- Create: `/home/akougkas/projects/notient/src/cli/index.ts`

Phase A surface: `notient init <path>`, `notient daemon {start|stop|status|list} [--vault <path>]`, `notient --help` (one-liner; full help in Phase E). Anything else exits non-zero with `INVALID_PARAMS`.

- [ ] **Step 1: Write the entry**

Create `src/cli/index.ts`:

```typescript
import { runInit } from "./commands/init";
import { runDaemonCommand } from "./commands/daemon";
import { defaultStateLoader, resolveVault } from "./env";
import { defaultMode, makeEmitter, type EmitterMode } from "./output";

interface ParsedArgs {
  command: string | null;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { command: null, positional: [], flags: {} };
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (!out.command && !token.startsWith("-")) {
      out.command = token;
      index++;
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        out.flags[key] = next;
        index += 2;
      } else {
        out.flags[key] = true;
        index += 1;
      }
      continue;
    }
    out.positional.push(token);
    index += 1;
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const modeFlag = (parsed.flags.json && "json") || (parsed.flags.ndjson && "ndjson") || (parsed.flags.pretty && "pretty");
  const mode: EmitterMode = (modeFlag as EmitterMode) ?? defaultMode(process.stdout.isTTY === true);
  const emitter = makeEmitter({ mode });

  try {
    if (!parsed.command || parsed.command === "help" || parsed.flags.help) {
      emitter.emit({
        type: "help",
        commands: ["init", "daemon"],
        note: "Phase A surface; richer surface lands in Phases B–E.",
      });
      return 0;
    }

    if (parsed.command === "init") {
      const vaultPathArg = parsed.positional[0];
      if (!vaultPathArg) throw new Error("init requires a vault path argument");
      const sqlWasmSource = await resolveSqlWasmSource();
      await runInit({
        vaultPathArg,
        cwd: process.cwd(),
        emitter,
        sqlWasmSource,
      });
      return 0;
    }

    if (parsed.command === "daemon") {
      const verb = parsed.positional[0] as "start" | "stop" | "status" | "list" | undefined;
      if (!verb) throw new Error("daemon requires a verb: start | stop | status | list");
      const vaultPath = await resolveVaultForDaemon(parsed);
      await runDaemonCommand({
        verb,
        vaultPath,
        emitter,
      });
      return 0;
    }

    emitter.emit({
      type: "error",
      code: "INVALID_PARAMS",
      message: `Unknown command: ${parsed.command}`,
    });
    return 2;
  } catch (error) {
    emitter.emit({
      type: "error",
      code: "INTERNAL",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

async function resolveVaultForDaemon(parsed: ParsedArgs): Promise<string | null> {
  const flagVault = typeof parsed.flags.vault === "string" ? parsed.flags.vault : null;
  try {
    return await resolveVault({
      flagVault,
      env: process.env as Record<string, string | undefined>,
      cwd: process.cwd(),
      stateLoader: defaultStateLoader(),
    });
  } catch {
    return null;
  }
}

async function resolveSqlWasmSource(): Promise<string> {
  const candidate = new URL("../../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url);
  return candidate.pathname;
}

void main(process.argv.slice(2)).then((code) => {
  process.exit(code);
});
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 3: Smoke (without daemon yet) — `notient help`**

Run: `bun run src/cli/index.ts help --json`
Expected: A single JSON line with `"type":"help"`. Exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts
git commit -m "$(cat <<'EOF'
feat(cli): binary entry, arg parser, mode dispatcher

Phase A surface is init and daemon. The arg parser accepts --flag value
and --flag=value (the latter via a one-line normalization to be added
in Phase E). Output mode picks json by default for non-TTY, pretty for
TTY, with --json/--ndjson/--pretty overrides. Help prints a one-liner
listing the Phase A commands.
EOF
)"
```

---

## Group 9: Package + fixtures + smoke

### Task 23: Update `package.json`

**Files:**
- Modify: `/home/akougkas/projects/notient/package.json`

- [ ] **Step 1: Replace the dependency surface**

Open `package.json`. Change to:

```json
{
  "name": "notient",
  "version": "0.1.0-phaseA",
  "description": "Local-first agentic CLI for sentient vaults",
  "type": "module",
  "bin": {
    "notient": "./dist/notient.js"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "lint": "biome check src/",
    "lint:fix": "biome check --write src/",
    "format": "biome format --write src/",
    "build:cli": "bun build src/cli/index.ts --target=bun --outfile=dist/notient.js && bun scripts/copy-wasm.ts",
    "smoke:cli:phaseA": "bun scripts/smoke-cli-phaseA.ts"
  },
  "keywords": [
    "ai",
    "local-llm",
    "semantic-search",
    "knowledge-management",
    "cli",
    "agentic"
  ],
  "author": "Anthony Kougkas",
  "license": "MIT",
  "devDependencies": {
    "@biomejs/biome": "1.9.0",
    "@types/node": "^20.10.0",
    "@types/sql.js": "^1.4.9",
    "bun-types": "^1.0.18",
    "tslib": "^2.6.2",
    "typescript": "^5.6.0"
  },
  "dependencies": {
    "@lmstudio/sdk": "^1.5.0",
    "@opentui/core": "0.1.105",
    "@opentui/react": "0.1.105",
    "chokidar": "^4.0.0",
    "hnswlib-wasm": "^0.8.2",
    "kysely": "^0.28.9",
    "ollama": "^0.6.3",
    "sql.js": "^1.13.0",
    "unpdf": "^0.12.0"
  }
}
```

NOTE on dropped scripts: `dev`, `dev:fast`, `dev:watch`, `dev:clean`, `dev:reset`, `dev:hard-reset`, `dev:status`, `build`, `build:dev`, `analyze`, `import`, `verify`, `smoke:indexer`, `smoke:coordinator`, `smoke:phase4` all targeted the plugin or earlier phases. Phase A drops them all. If a substrate-only smoke harness like `smoke:indexer` is salvageable for Phase B, restore it then.

NOTE on dropped deps: `obsidian`, `preact`, `@preact/signals`, `marked`, `prismjs`, `@types/prismjs`, `preact-render-to-string`, `esbuild`. Phase A no longer needs esbuild because the build pipeline collapses to `bun build --compile`.

- [ ] **Step 2: Add the wasm-copy helper**

Create `scripts/copy-wasm.ts`:

```typescript
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = process.cwd();
const source = join(root, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
const target = join(root, "dist", "sql-wasm.wasm");

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
```

- [ ] **Step 3: Install the new dependency tree**

Run: `bun install`
Expected: clean install. If `unpdf@^0.12.0` does not resolve, fall back to the latest `unpdf@^0` minor that bun's registry has; record the resolved version in the commit message.

- [ ] **Step 4: Typecheck the whole repo**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 5: Run the build**

Run: `bun run build:cli`
Expected: `dist/notient.js` and `dist/sql-wasm.wasm` exist. **If `bun build --compile` produces a binary that crashes when invoking `init` (Task 22 step 3 form), document the failure and switch the script to `bun build --target=bun` (no `--compile`) for Phase A; deliverables only require the script name `build:cli`, not a single-binary output. Note this as an Open Risk Phase A mitigation.**

- [ ] **Step 6: Run the test suite**

Run: `bun test`
Expected: Green.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lockb scripts/copy-wasm.ts
git commit -m "$(cat <<'EOF'
chore(deps): drop Obsidian plugin deps; add CLI runtime deps

Drops: obsidian, preact, @preact/signals, marked, prismjs,
@types/prismjs, preact-render-to-string, esbuild.

Adds: chokidar, unpdf, @opentui/core@0.1.105, @opentui/react@0.1.105.

package.json now declares bin (./dist/notient.js), build:cli, and
smoke:cli:phaseA. The dev scripts that targeted the plugin are gone;
Phase B will reintroduce a substrate smoke if the equivalent is needed.
EOF
)"
```

---

### Task 24: `tests/fixtures/sentient-vault/` — markdown corpus

**Files:**
- Create: `/home/akougkas/projects/notient/tests/fixtures/sentient-vault/notes/Phase 4 stream.md`
- Create: `/home/akougkas/projects/notient/tests/fixtures/sentient-vault/notes/TDD discipline.md`
- Create: `/home/akougkas/projects/notient/tests/fixtures/sentient-vault/notes/Test-driven development.md` (deliberate semantic near-duplicate of TDD discipline)
- Create: `/home/akougkas/projects/notient/tests/fixtures/sentient-vault/notes/Daily 2026-04-27.md` (daily note with tasks)
- Create: `/home/akougkas/projects/notient/tests/fixtures/sentient-vault/notes/Vault as kernel.md` (links to Phase 4 stream)
- Create: `/home/akougkas/projects/notient/tests/fixtures/sentient-vault/notes/Sentient vault hypothesis.md` (frontmatter, links)
- Create: `/home/akougkas/projects/notient/tests/fixtures/sentient-vault/notes/Contradiction A on testing.md` (asserts X)
- Create: `/home/akougkas/projects/notient/tests/fixtures/sentient-vault/notes/Contradiction B on testing.md` (asserts NOT X — the contradiction pair)
- Create: `/home/akougkas/projects/notient/tests/fixtures/sentient-vault/notes/Recipe ideas.md` (off-topic, ensures search ranking is non-trivial)
- Create: `/home/akougkas/projects/notient/tests/fixtures/sentient-vault/notes/Reading list.md` (frontmatter with author + status fields)

The contradiction pair: `Contradiction A on testing.md` says "Tests should always be written before code." and `Contradiction B on testing.md` says "Tests should never come before code; design first, test later." Phase B's contradictionHunter will surface this pair.

- [ ] **Step 1: Write each markdown file**

Each file is a single Write call. Content snapshots below; copy verbatim. Use real wikilinks (`[[Other Note]]`), real frontmatter, real tasks.

`tests/fixtures/sentient-vault/notes/Phase 4 stream.md`:

```markdown
---
maturity: adolescent
tags: [phase-4, stream]
---

# Phase 4 stream

The Stream tab ranked agent proposals by recency and relevance. Phase A
of the CLI pivot drops the Stream UI; the substrate ranking moves to
notient stream.

See also [[Vault as kernel]].
```

`tests/fixtures/sentient-vault/notes/TDD discipline.md`:

```markdown
---
maturity: mature
tags: [practice, testing]
---

# TDD discipline

Test-driven development means writing the failing test first, then the
minimal code that makes it pass, then refactoring. The discipline comes
from never letting a green bar lie.
```

`tests/fixtures/sentient-vault/notes/Test-driven development.md`:

```markdown
---
maturity: adolescent
tags: [testing]
---

# Test-driven development

Red, green, refactor. The classic loop. See [[TDD discipline]] for the
deeper take.
```

`tests/fixtures/sentient-vault/notes/Daily 2026-04-27.md`:

```markdown
---
date: 2026-04-27
type: daily
---

# 2026-04-27

- [ ] Land Phase A archive housekeeping
- [x] Read the spec
- [ ] Open the daemon socket end-to-end
```

`tests/fixtures/sentient-vault/notes/Vault as kernel.md`:

```markdown
---
maturity: mature
tags: [architecture]
---

# Vault as kernel

The vault is the kernel; tools are interchangeable. The substrate keeps
thinking about it whether or not Obsidian is running. See
[[Phase 4 stream]] and [[Sentient vault hypothesis]].
```

`tests/fixtures/sentient-vault/notes/Sentient vault hypothesis.md`:

```markdown
---
maturity: synthesis-ready
tags: [thesis]
related: ["[[Vault as kernel]]"]
---

# Sentient vault hypothesis

A vault that the substrate continues to think about while the user is
away becomes a sentient vault. Notient's job is to surface what the
substrate noticed. The proposals are visible via notient stream.
```

`tests/fixtures/sentient-vault/notes/Contradiction A on testing.md`:

```markdown
---
tags: [testing, opinion]
---

# Contradiction A on testing

Tests should always be written before code. The discipline of test-first
is what keeps the design honest.
```

`tests/fixtures/sentient-vault/notes/Contradiction B on testing.md`:

```markdown
---
tags: [testing, opinion]
---

# Contradiction B on testing

Tests should never come before code; design first, test later. Writing
tests too early calcifies a wrong shape.
```

`tests/fixtures/sentient-vault/notes/Recipe ideas.md`:

```markdown
---
tags: [cooking, off-topic]
---

# Recipe ideas

Beans on toast. Tomato soup. Unrelated to the rest of the vault on
purpose so the search ranker has noise to push down.
```

`tests/fixtures/sentient-vault/notes/Reading list.md`:

```markdown
---
type: list
items:
  - title: Programming Pearls
    author: Bentley
    status: read
  - title: Domain-Driven Design
    author: Evans
    status: queued
---

# Reading list

A reading queue with structured frontmatter that exercises the
properties surface.
```

- [ ] **Step 2: Verify count**

Run: `find tests/fixtures/sentient-vault/notes -name '*.md' | wc -l`
Expected: 10.

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/sentient-vault/
git commit -m "$(cat <<'EOF'
test(fixtures): sentient-vault corpus for Phase A/B smoke

Ten markdown notes spanning topics, wikilinks, frontmatter, daily
tasks, structured properties, and a deliberate contradiction pair on
testing. Phase B awaken + search + contradiction hunter use this
fixture; Phase A smoke uses only the directory's existence and the
init flow.
EOF
)"
```

---

### Task 25: `scripts/smoke-cli-phaseA.ts` — gate harness

**Files:**
- Create: `/home/akougkas/projects/notient/scripts/smoke-cli-phaseA.ts`

The harness:
1. Creates a temporary directory.
2. Copies the fixture vault into it (so the smoke does not mutate the source-controlled fixture).
3. Runs `notient init <tmp>` via `bun run src/cli/index.ts init <tmp>`.
4. Spawns `notient daemon status --vault <tmp>` to trigger auto-spawn.
5. Asserts that the NDJSON stream from step 4 contains a `type=ack`, then a `type=result` with `vault: <tmp>`, `pid: number`.
6. Spawns `notient daemon shutdown` (the `stop` verb).
7. Asserts the socket file disappears.
8. Cleans up.

The harness emits its own NDJSON via the same `output.ts` emitter — no `console.log`.

- [ ] **Step 1: Write the harness**

Create `scripts/smoke-cli-phaseA.ts`:

```typescript
import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEmitter } from "../src/cli/output";

const emitter = makeEmitter({ mode: "ndjson" });

async function main(): Promise<void> {
  const fixtureRoot = join(process.cwd(), "tests", "fixtures", "sentient-vault");
  const tmpRoot = await mkdtemp(join(tmpdir(), "notient-smoke-A-"));
  try {
    await cp(fixtureRoot, tmpRoot, { recursive: true });
    emitter.emit({ type: "smoke:setup", tmpRoot });

    await runOneShot(["init", tmpRoot]);
    emitter.emit({ type: "smoke:init_done" });

    const statusFrames = await runOneShotCollect(["daemon", "status", "--vault", tmpRoot]);
    assertStatusFrames(statusFrames, tmpRoot);
    emitter.emit({ type: "smoke:status_validated" });

    await runOneShot(["daemon", "stop", "--vault", tmpRoot]);
    emitter.emit({ type: "smoke:stop_done" });

    const socketPath = join(tmpRoot, ".notient", "notient.sock");
    let socketExists = true;
    try {
      await stat(socketPath);
    } catch {
      socketExists = false;
    }
    if (socketExists) {
      throw new Error(`socket survived shutdown: ${socketPath}`);
    }
    emitter.emit({ type: "smoke:complete" });
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

interface CapturedFrames {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

async function runOneShot(argv: string[]): Promise<void> {
  const captured = await runOneShotCollect(argv);
  if (captured.exitCode !== 0) {
    emitter.emit({ type: "smoke:error", argv, exitCode: captured.exitCode, stderr: captured.stderr.join("\n") });
    throw new Error(`Command failed: notient ${argv.join(" ")}`);
  }
}

async function runOneShotCollect(argv: string[]): Promise<CapturedFrames> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["run", "src/cli/index.ts", ...argv, "--ndjson"],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
    );
    const stdoutBuffer: string[] = [];
    const stderrBuffer: string[] = [];
    child.stdout.on("data", (data: Buffer) => {
      stdoutBuffer.push(data.toString("utf-8"));
    });
    child.stderr.on("data", (data: Buffer) => {
      stderrBuffer.push(data.toString("utf-8"));
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? -1,
        stdout: stdoutBuffer.join("").split("\n").filter(Boolean),
        stderr: stderrBuffer.join("").split("\n").filter(Boolean),
      });
    });
  });
}

function assertStatusFrames(frames: CapturedFrames, tmpRoot: string): void {
  if (frames.exitCode !== 0) {
    throw new Error(`status exit ${frames.exitCode}: ${frames.stderr.join(" ")}`);
  }
  const parsed = frames.stdout.map((line) => JSON.parse(line) as Record<string, unknown>);
  const ack = parsed.find((event) => event.type === "rpc:ack");
  const result = parsed.find((event) => event.type === "rpc:result");
  if (!ack || !result) {
    throw new Error(`status missing ack/result: ${JSON.stringify(parsed)}`);
  }
  if (typeof result.id !== "string") throw new Error("result envelope missing id");
  if (typeof result.pid !== "number") throw new Error("result envelope missing pid");
  if (result.vault !== tmpRoot) throw new Error(`result.vault mismatch: ${String(result.vault)}`);
  if (result.sealed !== true) throw new Error("kernel not sealed");
}

void main().catch((error) => {
  emitter.emit({
    type: "smoke:fatal",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 3: Run the smoke harness manually**

Run: `bun run smoke:cli:phaseA`
Expected: A handful of NDJSON lines including `smoke:setup`, `smoke:init_done`, `smoke:status_validated`, `smoke:stop_done`, `smoke:complete`. Exit 0. **If this fails, do not commit; iterate inside Task 25 until green.**

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-cli-phaseA.ts
git commit -m "$(cat <<'EOF'
test(smoke): Phase A NDJSON gate harness

Spawns notient init <tmp>, then daemon status (auto-spawning the
daemon), then daemon stop, asserting NDJSON envelope shape (id, type,
vault, pid, sealed) and that the socket file disappears after
shutdown. The harness emits its own NDJSON via cli/output.ts so it
respects the no-console.log rule.
EOF
)"
```

---

## Group 10: Phase A gate

### Task 26: Run the gate end-to-end

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 2: Lint**

Run: `bun run lint`
Expected: Green.

- [ ] **Step 3: Test**

Run: `bun test`
Expected: Green. Substrate tests pass; the new adapter, settings, daemon, and CLI tests pass.

- [ ] **Step 4: Build the CLI**

Run: `bun run build:cli`
Expected: `dist/notient.js` exists and `dist/sql-wasm.wasm` exists.

- [ ] **Step 5: Phase A smoke**

Run: `bun run smoke:cli:phaseA`
Expected: Exit 0. NDJSON ends with `smoke:complete`.

- [ ] **Step 6: Live invocation against the fixture vault**

```bash
TMP=$(mktemp -d)
cp -r tests/fixtures/sentient-vault/. "$TMP"
bun run src/cli/index.ts init "$TMP" --ndjson
bun run src/cli/index.ts daemon status --vault "$TMP" --ndjson
bun run src/cli/index.ts daemon stop --vault "$TMP" --ndjson
rm -rf "$TMP"
```

Expected: Each command exits 0. Status prints an ack frame, then a result with `vault: $TMP`, `sealed: true`, and a numeric `pid`. Stop prints an ack and a result.

- [ ] **Step 7: Phase A done check**

Phase A is done **only when** the gate is fully green AND the live invocation in Step 6 succeeds. Anything less means another iteration is required. Do not tag, do not declare done, do not start Phase B.

- [ ] **Step 8: No commit needed**

Task 26 is verification only. The state of the repo is what was committed in Tasks 1–25.

---

## Self-review (run before declaring the plan ready)

**Spec coverage (Phase A deliverables 1–12):**
- (1) New dirs `src/cli/`, `src/daemon/`, `src/bridge/`, `src/agent/`, `src/adapters/` — covered by Tasks 3, 4, 12–22 (the tasks naturally create the directories via the file writes; `src/bridge/` and `src/agent/` are empty in Phase A and intentionally absent — they materialize in Phase B and Phase C respectively per the spec phasing).
- (2) `vaultAdapter.ts` — Task 3.
- (3) `fsVault.ts` — Task 4.
- (4) Rebind ~12 substrate consumers — most are wiring-only and land in Task 15 (`bootstrap.ts`); the only file edits are Task 6 (MaturityAdvancer) and Task 7 (kernel). The other consumers' interfaces (ConversationStore, ConversationIndex, SavedQueries, SearchHistory, CanvasFromResults, VitalsService, NativeGraphBridge, CoAuthor, VaultBootstrap, history inverters) already accept narrow facade-shaped interfaces; Phase A wiring of these into the daemon arrives in Phase B + Phase C as their RPC entry points come online. The plan flags this distinction.
- (5) SettingsService rebind — Task 5.
- (6) Daemon files — Tasks 12–16.
- (7) CLI files — Tasks 17–22.
- (8) Archive moves — Tasks 8–11.
- (9) Drop / add deps — Task 23.
- (10) `package.json` bin + scripts — Task 23.
- (11) Fixture vault — Task 24.
- (12) Housekeeping — Task 1.

**Placeholder scan:** No "TBD", "TODO", "implement later", or hand-wavey error handling left in any task. Every code block is concrete.

**Type consistency:** `VaultAdapter` is referenced by Tasks 3, 4, 6, 7, 15. Method names match across the interface and the FsVault implementation. `Kernel.seal({ phase })` is introduced in Task 15 step 1 and consumed in Task 15 step 2; the option is optional with a backwards-compatible default. `Emitter` and `StructuredEvent` are introduced in Task 17 and consumed in Tasks 20–22, 25. The smoke harness's `assertStatusFrames` checks `result.sealed === true` which `daemon.status` returns in Task 16.

---

## Phase A gate

```
bun run typecheck && bun run lint && bun test && bun run build:cli && bun run smoke:cli:phaseA
```

**No Phase A claim of done is valid without the gate green AND a live end-to-end CLI invocation against `tests/fixtures/sentient-vault/` (Task 26 step 6).**

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-27-cli-phase-a.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration. Tasks 12/13/14 run in parallel; Tasks 17/18 run in parallel; Tasks 24/25 can run in parallel.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
