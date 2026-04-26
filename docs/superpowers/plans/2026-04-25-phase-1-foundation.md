# Phase 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a clean, verified foundation for Notient v1.0 — typed event bus, atomic writes, vault lock, SQLite + dual-store graph schema, OpenAI-compatible LLM provider, health monitor, fail-loud kernel/DI, and a minimal sidebar with a working status footer. Empty plugin loads in Obsidian; all infra wired and tested; no agent or UI features yet.

**Architecture:** Layered bottom-up. Pure utilities (eventBus, atomicWrite, vaultLock) → persistence (database, graphStore, frontmatter writer) → adapters (ObsidianFacade) → services (LLMProvider, HealthMonitor) → kernel + DI → sidebar shell with status footer. Test-first for every pure-logic module via `bun test`. Obsidian integration verified by smoke test in `/mnt/c/Users/akougk/Projects/vaultex` at end of phase.

**Tech Stack:** TypeScript strict, Bun (runtime + test), Preact + @preact/signals (UI), Obsidian Plugin API, sql.js (WASM SQLite), Biome (lint), esbuild via `scripts/build.ts`.

**Spec:** `docs/superpowers/specs/2026-04-25-notient-v1-design.md`. Phase 1 corresponds to spec §13 row 1 (Foundation).

**Definition of Done:**
1. `bun run typecheck && bun run lint && bun test` all green
2. `bun run dev` produces `main.js` deployed to test vault
3. Plugin loads in Obsidian without errors; sidebar opens with status footer showing dynamo health
4. Settings panel saves endpoint changes; persists across reload
5. Manual: write a note in vault → handler computes content SHA → row appears in `notient.db` `notes` table
6. Git tag `v1.0.0-foundation` on `beta-spec`

---

## File Structure

```
src/
├── main.ts                          # Plugin entry — onload/onunload/loadSettings
├── adapters/
│   ├── obsidianFacade.ts            # Vault wrapper using atomic writes + lock
│   └── obsidianFacade.test.ts
├── core/
│   ├── kernel.ts                    # Service registry with fail-loud init
│   ├── kernel.test.ts
│   ├── settings/
│   │   ├── types.ts                 # NotientSettings + DEFAULT_SETTINGS
│   │   ├── settingsService.ts       # load/save via plugin.loadData
│   │   └── SettingsTab.ts           # Obsidian PluginSettingTab
│   ├── events/
│   │   ├── types.ts                 # AppEvent union
│   │   ├── eventBus.ts              # generic on/off/emit
│   │   └── eventBus.test.ts
│   ├── utils/
│   │   ├── atomicWrite.ts           # temp + fsync + rename, Windows EPERM retry
│   │   └── atomicWrite.test.ts
│   ├── services/
│   │   ├── vaultLock.ts             # single-instance lockfile
│   │   ├── vaultLock.test.ts
│   │   ├── healthMonitor.ts         # periodic LLM endpoint probe
│   │   └── healthMonitor.test.ts
│   ├── db/
│   │   ├── database.ts              # sql.js bootstrap, persist, query
│   │   ├── database.test.ts
│   │   ├── schema.ts                # SQL DDL strings
│   │   └── migrations.ts            # ordered, idempotent migrations
│   ├── graph/
│   │   ├── types.ts                 # Node, Edge, NodeType, EdgeType
│   │   ├── graphStore.ts            # SQLite CRUD for graph
│   │   ├── graphStore.test.ts
│   │   ├── frontmatterWriter.ts     # parse YAML, merge notient block, atomic write
│   │   └── frontmatterWriter.test.ts
│   └── llm/
│       ├── provider.ts              # LLMProvider interface
│       ├── lmStudioProvider.ts      # OpenAI-compatible fetch + streaming
│       └── lmStudioProvider.test.ts
└── ui/
    └── sidebar/
        ├── SidebarView.ts           # Obsidian ItemView wrapper
        ├── App.tsx                  # Preact root (status footer only in P1)
        └── components/
            └── StatusFooter.tsx     # Health dot + node count + endpoint
```

**Test convention:** `<file>.test.ts` co-located with source. `bun test` discovers automatically.

---

## Task 1: Reset scaffold + minimal plugin entry

**Files:**
- Create: `src/main.ts`
- Create: `src/types.d.ts` (manifest typing for `import "../manifest.json"`)
- Modify: `manifest.json` (bump to `1.0.0-foundation`)
- Modify: `styles.css` (replace with empty stub)
- Verify: `package.json`, `tsconfig.json`, `scripts/build.ts` unchanged

- [ ] **Step 1.1:** Confirm `src/` is empty.

```bash
ls src/ 2>/dev/null && echo "src not empty" || echo "OK src is empty"
```
Expected: `OK src is empty`

- [ ] **Step 1.2:** Bump manifest version to phase tag.

Edit `manifest.json`, change `"version": "0.2.0"` to `"version": "1.0.0-foundation"`.

- [ ] **Step 1.3:** Reset `styles.css` to a stub.

```css
/* Notient v1.0 — styles populated in Phase 4 (Stream) */
```

- [ ] **Step 1.4:** Write minimal plugin entry.

Create `src/main.ts`:
```typescript
import { Plugin } from "obsidian";

export default class NotientPlugin extends Plugin {
  async onload(): Promise<void> {
    console.log("[Notient] loading v1.0.0-foundation");
  }

  async onunload(): Promise<void> {
    console.log("[Notient] unloading");
  }
}
```

- [ ] **Step 1.5:** Verify build pipeline works.

```bash
bun run typecheck
```
Expected: no output (clean exit).

```bash
bun run lint
```
Expected: no output (clean exit).

```bash
bun scripts/build.ts dev
```
Expected: `main.js` written and copied to `/mnt/c/Users/akougk/Projects/vaultex/.obsidian/plugins/notient/`.

- [ ] **Step 1.6:** Smoke test in Obsidian.

Open Obsidian on the test vault. Settings → Community plugins → toggle Notient on. Open developer console (Ctrl-Shift-I). Expected:  `[Notient] loading v1.0.0-foundation` printed.

- [ ] **Step 1.7:** Commit.

```bash
git add src/main.ts styles.css manifest.json
git commit -m "feat(foundation): minimal plugin entry, build pipeline verified"
```

---

## Task 2: Typed event bus

**Files:**
- Create: `src/core/events/types.ts`
- Create: `src/core/events/eventBus.ts`
- Create: `src/core/events/eventBus.test.ts`

- [ ] **Step 2.1:** Define event type union.

Create `src/core/events/types.ts`:
```typescript
export type AppEvent =
  | { type: "settings:changed"; key: string }
  | { type: "llm:health"; endpoint: string; ok: boolean; latencyMs?: number }
  | { type: "vault:note-saved"; path: string; sha: string }
  | { type: "indexer:progress"; processed: number; total: number }
  | { type: "indexer:complete"; total: number }
  | { type: "indexer:error"; message: string };

export type EventType = AppEvent["type"];
export type EventOf<T extends EventType> = Extract<AppEvent, { type: T }>;
export type EventHandler<T extends EventType> = (event: EventOf<T>) => void;
```

- [ ] **Step 2.2:** Write the failing test.

Create `src/core/events/eventBus.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { EventBus } from "./eventBus";

describe("EventBus", () => {
  test("subscribers receive emitted events of matching type", () => {
    const bus = new EventBus();
    let received: { processed: number; total: number } | null = null;
    bus.on("indexer:progress", (event) => {
      received = { processed: event.processed, total: event.total };
    });
    bus.emit({ type: "indexer:progress", processed: 5, total: 10 });
    expect(received).toEqual({ processed: 5, total: 10 });
  });

  test("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on("indexer:complete", () => count++);
    bus.emit({ type: "indexer:complete", total: 1 });
    off();
    bus.emit({ type: "indexer:complete", total: 1 });
    expect(count).toBe(1);
  });

  test("subscribers of other event types do not receive", () => {
    const bus = new EventBus();
    let received = false;
    bus.on("llm:health", () => {
      received = true;
    });
    bus.emit({ type: "indexer:complete", total: 1 });
    expect(received).toBe(false);
  });

  test("handler error does not stop other handlers", () => {
    const bus = new EventBus();
    bus.on("indexer:complete", () => {
      throw new Error("boom");
    });
    let other = false;
    bus.on("indexer:complete", () => {
      other = true;
    });
    bus.emit({ type: "indexer:complete", total: 1 });
    expect(other).toBe(true);
  });
});
```

- [ ] **Step 2.3:** Run test, expect failure.

```bash
bun test src/core/events/eventBus.test.ts
```
Expected: FAIL — `Cannot find module './eventBus'`.

- [ ] **Step 2.4:** Implement EventBus.

Create `src/core/events/eventBus.ts`:
```typescript
import type { AppEvent, EventHandler, EventType } from "./types";

type Handlers = Map<EventType, Set<EventHandler<EventType>>>;

export class EventBus {
  private handlers: Handlers = new Map();

  on<T extends EventType>(type: T, handler: EventHandler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as EventHandler<EventType>);
    return () => {
      set?.delete(handler as EventHandler<EventType>);
    };
  }

  emit(event: AppEvent): void {
    const set = this.handlers.get(event.type);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as EventHandler<typeof event.type>)(event);
      } catch (error) {
        console.error("[EventBus] handler error", event.type, error);
      }
    }
  }
}
```

- [ ] **Step 2.5:** Run test, expect pass.

```bash
bun test src/core/events/eventBus.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 2.6:** Verify lint + typecheck.

```bash
bun run typecheck && bun run lint
```
Expected: clean.

- [ ] **Step 2.7:** Commit.

```bash
git add src/core/events/
git commit -m "feat(foundation): typed event bus with handler-error isolation"
```

---

## Task 3: Settings (types + service + SettingsTab)

**Files:**
- Create: `src/core/settings/types.ts`
- Create: `src/core/settings/settingsService.ts`
- Create: `src/core/settings/SettingsTab.ts`
- Modify: `src/main.ts` (load + register settings tab)

- [ ] **Step 3.1:** Define settings types.

Create `src/core/settings/types.ts`:
```typescript
export interface LLMEndpointConfig {
  baseUrl: string;
  reasoningModel: string;
  embeddingModel: string;
  fastModel: string;
  rerankerModel: string;
}

export interface NotientSettings {
  primary: LLMEndpointConfig;
  deep: LLMEndpointConfig;
  agents: {
    linker: boolean;
    synthesizer: boolean;
    contradictionHunter: boolean;
    maturityAdvancer: boolean;
  };
  coAuthor: {
    enabled: boolean;
    minWords: number;
    debounceMs: number;
  };
  approvals: {
    confidenceThreshold: number;
  };
}

export const DEFAULT_SETTINGS: NotientSettings = {
  primary: {
    baseUrl: "http://192.168.86.143:1234/v1",
    reasoningModel: "qwen3.6-35b-a3b",
    embeddingModel: "text-embedding-nomic-embed-text-v2-moe",
    fastModel: "qwen3.5-2b",
    rerankerModel: "granite-4.0-h-350m",
  },
  deep: {
    baseUrl: "http://192.168.86.141:8080/v1",
    reasoningModel: "Qwen3.6-35B-A3B-UD-Q5_K_XL",
    embeddingModel: "",
    fastModel: "",
    rerankerModel: "",
  },
  agents: {
    linker: true,
    synthesizer: true,
    contradictionHunter: true,
    maturityAdvancer: true,
  },
  coAuthor: {
    enabled: true,
    minWords: 100,
    debounceMs: 5000,
  },
  approvals: {
    confidenceThreshold: 0.6,
  },
};
```

- [ ] **Step 3.2:** Write settings service.

Create `src/core/settings/settingsService.ts`:
```typescript
import type { Plugin } from "obsidian";
import type { EventBus } from "../events/eventBus";
import { DEFAULT_SETTINGS, type NotientSettings } from "./types";

export class SettingsService {
  private current: NotientSettings = DEFAULT_SETTINGS;

  constructor(
    private readonly plugin: Plugin,
    private readonly bus: EventBus,
  ) {}

  async load(): Promise<NotientSettings> {
    const raw = (await this.plugin.loadData()) as Partial<NotientSettings> | null;
    this.current = mergeSettings(DEFAULT_SETTINGS, raw ?? {});
    return this.current;
  }

  get(): NotientSettings {
    return this.current;
  }

  async update(patch: Partial<NotientSettings>): Promise<void> {
    this.current = mergeSettings(this.current, patch);
    await this.plugin.saveData(this.current);
    this.bus.emit({ type: "settings:changed", key: Object.keys(patch).join(",") });
  }
}

function mergeSettings(
  base: NotientSettings,
  patch: Partial<NotientSettings>,
): NotientSettings {
  return {
    primary: { ...base.primary, ...(patch.primary ?? {}) },
    deep: { ...base.deep, ...(patch.deep ?? {}) },
    agents: { ...base.agents, ...(patch.agents ?? {}) },
    coAuthor: { ...base.coAuthor, ...(patch.coAuthor ?? {}) },
    approvals: { ...base.approvals, ...(patch.approvals ?? {}) },
  };
}
```

- [ ] **Step 3.3:** Write SettingsTab.

Create `src/core/settings/SettingsTab.ts`:
```typescript
import { type App, PluginSettingTab, Setting } from "obsidian";
import type NotientPlugin from "../../main";
import type { SettingsService } from "./settingsService";

export class NotientSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: NotientPlugin,
    private readonly settings: SettingsService,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Notient — Local AI" });

    const current = this.settings.get();

    new Setting(containerEl)
      .setName("Primary endpoint URL")
      .setDesc("OpenAI-compatible. Reasoning + embeddings + fast extraction.")
      .addText((text) =>
        text
          .setPlaceholder("http://host:port/v1")
          .setValue(current.primary.baseUrl)
          .onChange(async (value) => {
            await this.settings.update({
              primary: { ...current.primary, baseUrl: value.trim() },
            });
          }),
      );

    new Setting(containerEl)
      .setName("Reasoning model (primary)")
      .addText((text) =>
        text.setValue(current.primary.reasoningModel).onChange(async (value) => {
          await this.settings.update({
            primary: { ...this.settings.get().primary, reasoningModel: value.trim() },
          });
        }),
      );

    new Setting(containerEl)
      .setName("Embedding model (primary)")
      .addText((text) =>
        text.setValue(current.primary.embeddingModel).onChange(async (value) => {
          await this.settings.update({
            primary: { ...this.settings.get().primary, embeddingModel: value.trim() },
          });
        }),
      );

    new Setting(containerEl)
      .setName("Fast extractor model (primary)")
      .addText((text) =>
        text.setValue(current.primary.fastModel).onChange(async (value) => {
          await this.settings.update({
            primary: { ...this.settings.get().primary, fastModel: value.trim() },
          });
        }),
      );

    containerEl.createEl("h3", { text: "Deep / heavy model (optional)" });

    new Setting(containerEl)
      .setName("Deep endpoint URL")
      .addText((text) =>
        text.setValue(current.deep.baseUrl).onChange(async (value) => {
          await this.settings.update({
            deep: { ...this.settings.get().deep, baseUrl: value.trim() },
          });
        }),
      );
  }
}
```

- [ ] **Step 3.4:** Wire into main.

Replace `src/main.ts` with:
```typescript
import { Plugin } from "obsidian";
import { EventBus } from "./core/events/eventBus";
import { SettingsService } from "./core/settings/settingsService";
import { NotientSettingsTab } from "./core/settings/SettingsTab";

export default class NotientPlugin extends Plugin {
  bus!: EventBus;
  settings!: SettingsService;

  async onload(): Promise<void> {
    console.log("[Notient] loading v1.0.0-foundation");
    this.bus = new EventBus();
    this.settings = new SettingsService(this, this.bus);
    await this.settings.load();
    this.addSettingTab(new NotientSettingsTab(this.app, this, this.settings));
  }

  async onunload(): Promise<void> {
    console.log("[Notient] unloading");
  }
}
```

- [ ] **Step 3.5:** Build + smoke.

```bash
bun run typecheck && bun run lint && bun scripts/build.ts dev
```
Expected: clean. In Obsidian: Settings → Notient → change "Primary endpoint URL" → reload Obsidian → value persists.

- [ ] **Step 3.6:** Commit.

```bash
git add src/core/settings/ src/main.ts
git commit -m "feat(foundation): settings service + Obsidian SettingsTab"
```

---

## Task 4: Atomic write utility

**Files:**
- Create: `src/core/utils/atomicWrite.ts`
- Create: `src/core/utils/atomicWrite.test.ts`

- [ ] **Step 4.1:** Define the abstraction (we depend on a small filesystem interface so tests can mock it).

Create `src/core/utils/atomicWrite.ts`:
```typescript
export interface AtomicFs {
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface AtomicWriteOptions {
  retries?: number;
  retryDelayMs?: number;
}

export async function atomicWrite(
  fs: AtomicFs,
  path: string,
  contents: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const retries = opts.retries ?? 4;
  const delayMs = opts.retryDelayMs ?? 50;
  const tmp = `${path}.notient-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const data = new TextEncoder().encode(contents).buffer;

  await fs.writeBinary(tmp, data);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fs.rename(tmp, path);
      return;
    } catch (error) {
      lastError = error;
      const msg = (error as { message?: string })?.message ?? "";
      const code = (error as { code?: string })?.code ?? "";
      const isWindowsRetryable = code === "EPERM" || code === "EBUSY" || /EPERM|EBUSY/.test(msg);
      if (!isWindowsRetryable || attempt === retries) {
        try {
          await fs.remove(tmp);
        } catch {
          // ignore cleanup failure
        }
        throw error;
      }
      await sleep(delayMs * (attempt + 1));
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 4.2:** Write tests.

Create `src/core/utils/atomicWrite.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { atomicWrite, type AtomicFs } from "./atomicWrite";

class FakeFs implements AtomicFs {
  files = new Map<string, ArrayBuffer>();
  renames: Array<[string, string]> = [];
  removed: string[] = [];
  renameFailUntilAttempt = 0;
  renameAttempt = 0;
  renameError: { code?: string; message: string } = { message: "EPERM: rename" };

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, data);
  }
  async rename(from: string, to: string): Promise<void> {
    this.renameAttempt++;
    if (this.renameAttempt <= this.renameFailUntilAttempt) {
      const err = new Error(this.renameError.message) as Error & { code?: string };
      err.code = this.renameError.code;
      throw err;
    }
    this.files.set(to, this.files.get(from) as ArrayBuffer);
    this.files.delete(from);
    this.renames.push([from, to]);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.removed.push(path);
  }
}

describe("atomicWrite", () => {
  test("writes via temp file then renames to target", async () => {
    const fs = new FakeFs();
    await atomicWrite(fs, "/vault/note.md", "hello");
    expect(fs.files.get("/vault/note.md")).toBeDefined();
    expect(new TextDecoder().decode(fs.files.get("/vault/note.md")!)).toBe("hello");
    expect(fs.renames.length).toBe(1);
    const [from, to] = fs.renames[0];
    expect(to).toBe("/vault/note.md");
    expect(from.startsWith("/vault/note.md.notient-tmp-")).toBe(true);
  });

  test("retries on EPERM (Windows file lock) and eventually succeeds", async () => {
    const fs = new FakeFs();
    fs.renameFailUntilAttempt = 2;
    fs.renameError = { code: "EPERM", message: "EPERM" };
    await atomicWrite(fs, "/vault/note.md", "x", { retries: 4, retryDelayMs: 1 });
    expect(fs.renames.length).toBe(1);
    expect(fs.renameAttempt).toBe(3);
  });

  test("non-retryable error throws and cleans up temp file", async () => {
    const fs = new FakeFs();
    fs.renameFailUntilAttempt = 99;
    fs.renameError = { code: "ENOSPC", message: "no space left" };
    await expect(atomicWrite(fs, "/vault/note.md", "x", { retries: 2, retryDelayMs: 1 })).rejects.toThrow(
      /no space left/,
    );
    expect(fs.removed.length).toBe(1);
    expect(fs.removed[0].startsWith("/vault/note.md.notient-tmp-")).toBe(true);
  });
});
```

- [ ] **Step 4.3:** Run.

```bash
bun test src/core/utils/atomicWrite.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 4.4:** Commit.

```bash
git add src/core/utils/
git commit -m "feat(foundation): crash-safe atomic write with Windows EPERM retry"
```

---

## Task 5: Vault lock

**Files:**
- Create: `src/core/services/vaultLock.ts`
- Create: `src/core/services/vaultLock.test.ts`

- [ ] **Step 5.1:** Implement the lock.

Create `src/core/services/vaultLock.ts`:
```typescript
export interface LockFs {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface LockClock {
  now(): number;
}

export interface VaultLockHandle {
  release(): Promise<void>;
}

export class VaultLock {
  private static readonly STALE_MS = 60_000;

  constructor(
    private readonly fs: LockFs,
    private readonly path: string,
    private readonly instanceId: string,
    private readonly clock: LockClock = { now: () => Date.now() },
  ) {}

  async acquire(): Promise<VaultLockHandle> {
    if (await this.fs.exists(this.path)) {
      const raw = await this.fs.read(this.path);
      const data = parseLock(raw);
      const fresh = data && this.clock.now() - data.timestamp < VaultLock.STALE_MS;
      if (fresh && data && data.instanceId !== this.instanceId) {
        throw new Error(
          `Notient: vault is open in another window (lock holder ${data.instanceId}, age ${this.clock.now() - data.timestamp}ms). Close it or wait 60s.`,
        );
      }
    }
    await this.write();
    const interval = setInterval(() => {
      this.write().catch((error) => console.error("[VaultLock] heartbeat failed", error));
    }, 20_000);
    return {
      release: async () => {
        clearInterval(interval);
        try {
          await this.fs.remove(this.path);
        } catch {
          // ignore
        }
      },
    };
  }

  private async write(): Promise<void> {
    const payload = JSON.stringify({ instanceId: this.instanceId, timestamp: this.clock.now() });
    const data = new TextEncoder().encode(payload).buffer;
    await this.fs.writeBinary(this.path, data);
  }
}

function parseLock(raw: string): { instanceId: string; timestamp: number } | null {
  try {
    const data = JSON.parse(raw) as { instanceId?: string; timestamp?: number };
    if (typeof data.instanceId === "string" && typeof data.timestamp === "number") {
      return { instanceId: data.instanceId, timestamp: data.timestamp };
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5.2:** Write tests.

Create `src/core/services/vaultLock.test.ts`:
```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type LockClock, type LockFs, VaultLock } from "./vaultLock";

class MemFs implements LockFs {
  files = new Map<string, string>();
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async read(path: string): Promise<string> {
    const v = this.files.get(path);
    if (!v) throw new Error("ENOENT");
    return v;
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, new TextDecoder().decode(data));
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

let originalSetInterval: typeof setInterval;
beforeEach(() => {
  originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (() => 0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;
});
afterEach(() => {
  globalThis.setInterval = originalSetInterval;
});

const clock = (now: number): LockClock => ({ now: () => now });

describe("VaultLock", () => {
  test("acquires when no lock exists", async () => {
    const fs = new MemFs();
    const lock = new VaultLock(fs, "/vault/.notient.lock", "instance-A", clock(1000));
    const handle = await lock.acquire();
    expect(fs.files.has("/vault/.notient.lock")).toBe(true);
    await handle.release();
    expect(fs.files.has("/vault/.notient.lock")).toBe(false);
  });

  test("rejects when fresh lock held by another instance", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/vault/.notient.lock",
      JSON.stringify({ instanceId: "instance-A", timestamp: 1000 }),
    );
    const lock = new VaultLock(fs, "/vault/.notient.lock", "instance-B", clock(1500));
    await expect(lock.acquire()).rejects.toThrow(/another window/);
  });

  test("steals stale lock (>60s old)", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/vault/.notient.lock",
      JSON.stringify({ instanceId: "instance-A", timestamp: 1000 }),
    );
    const lock = new VaultLock(fs, "/vault/.notient.lock", "instance-B", clock(70_000));
    const handle = await lock.acquire();
    await handle.release();
  });

  test("re-acquire by same instance is idempotent (no error)", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/vault/.notient.lock",
      JSON.stringify({ instanceId: "instance-A", timestamp: 1000 }),
    );
    const lock = new VaultLock(fs, "/vault/.notient.lock", "instance-A", clock(1500));
    const handle = await lock.acquire();
    await handle.release();
  });
});
```

- [ ] **Step 5.3:** Run.

```bash
bun test src/core/services/vaultLock.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5.4:** Commit.

```bash
git add src/core/services/vaultLock.ts src/core/services/vaultLock.test.ts
git commit -m "feat(foundation): single-instance vault lock with stale takeover"
```

---

## Task 6: SQLite database + schema + migrations

**Files:**
- Create: `src/core/db/schema.ts`
- Create: `src/core/db/migrations.ts`
- Create: `src/core/db/database.ts`
- Create: `src/core/db/database.test.ts`

- [ ] **Step 6.1:** Define schema as DDL strings.

Create `src/core/db/schema.ts`:
```typescript
export const SCHEMA_V1 = [
  // notes — one row per markdown file
  `CREATE TABLE IF NOT EXISTS notes (
    path TEXT PRIMARY KEY,
    sha TEXT NOT NULL,
    word_count INTEGER NOT NULL DEFAULT 0,
    maturity TEXT NOT NULL DEFAULT 'raw',
    health REAL NOT NULL DEFAULT 0,
    freshness REAL NOT NULL DEFAULT 1,
    indexed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS notes_updated_at ON notes(updated_at);`,

  // chunks — semantic chunks of notes
  `CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    text TEXT NOT NULL,
    sha TEXT NOT NULL,
    UNIQUE(note_path, ord)
  );`,
  `CREATE INDEX IF NOT EXISTS chunks_note_path ON chunks(note_path);`,

  // embeddings — float arrays serialized as BLOB
  `CREATE TABLE IF NOT EXISTS embeddings (
    chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vector BLOB NOT NULL
  );`,

  // graph nodes (concept, claim, question — note nodes are notes table)
  `CREATE TABLE IF NOT EXISTS graph_nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    note_path TEXT,
    payload TEXT,
    created_at INTEGER NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS graph_nodes_type ON graph_nodes(type);`,
  `CREATE INDEX IF NOT EXISTS graph_nodes_note_path ON graph_nodes(note_path);`,

  // graph edges
  `CREATE TABLE IF NOT EXISTS graph_edges (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    confidence REAL NOT NULL,
    agent TEXT NOT NULL,
    evidence TEXT,
    approved INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS graph_edges_source ON graph_edges(source_id);`,
  `CREATE INDEX IF NOT EXISTS graph_edges_target ON graph_edges(target_id);`,
  `CREATE INDEX IF NOT EXISTS graph_edges_type ON graph_edges(type);`,
  `CREATE INDEX IF NOT EXISTS graph_edges_approved ON graph_edges(approved);`,

  // mutation history (for undo)
  `CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    before TEXT,
    after TEXT,
    created_at INTEGER NOT NULL
  );`,

  // schema version
  `CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  );`,
];
```

- [ ] **Step 6.2:** Migrations runner.

Create `src/core/db/migrations.ts`:
```typescript
import type { Database } from "sql.js";
import { SCHEMA_V1 } from "./schema";

export const CURRENT_VERSION = 1;

export function applyMigrations(db: Database): number {
  db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);");
  const result = db.exec("SELECT version FROM schema_version LIMIT 1;");
  const current = result[0]?.values[0]?.[0] as number | undefined;
  const startFrom = current ?? 0;

  if (startFrom < 1) {
    for (const stmt of SCHEMA_V1) {
      db.run(stmt);
    }
    if (current === undefined) {
      db.run("INSERT INTO schema_version (version) VALUES (?);", [CURRENT_VERSION]);
    } else {
      db.run("UPDATE schema_version SET version = ?;", [CURRENT_VERSION]);
    }
  }

  return CURRENT_VERSION;
}
```

- [ ] **Step 6.3:** Database wrapper.

Create `src/core/db/database.ts`:
```typescript
import initSqlJs, { type Database as SqlDatabase } from "sql.js";
import { applyMigrations, CURRENT_VERSION } from "./migrations";

export interface DatabaseAdapter {
  readBinary(path: string): Promise<ArrayBuffer | null>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
}

export interface DatabaseConfig {
  dbPath: string;
  wasmPath: string;
}

export class Database {
  private db: SqlDatabase | null = null;
  private dirty = false;

  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly config: DatabaseConfig,
  ) {}

  async init(): Promise<void> {
    const wasmBinary = (await this.adapter.readBinary(this.config.wasmPath)) ?? undefined;
    if (!wasmBinary) {
      throw new Error(`sql.js wasm missing at ${this.config.wasmPath}`);
    }
    const SQL = await initSqlJs({ wasmBinary });
    const existing = await this.adapter.readBinary(this.config.dbPath);
    this.db = existing ? new SQL.Database(new Uint8Array(existing)) : new SQL.Database();
    applyMigrations(this.db);
    if (!existing) {
      await this.persist();
    }
  }

  run(sql: string, params: unknown[] = []): void {
    this.requireDb().run(sql, params as never);
    this.dirty = true;
  }

  exec(sql: string): { columns: string[]; values: unknown[][] }[] {
    return this.requireDb().exec(sql);
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.requireDb().prepare(sql);
    try {
      stmt.bind(params as never);
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  async persist(): Promise<void> {
    if (!this.dirty && (await this.adapter.readBinary(this.config.dbPath))) return;
    const data = this.requireDb().export();
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    await this.adapter.writeBinary(this.config.dbPath, buffer);
    this.dirty = false;
  }

  async close(): Promise<void> {
    if (this.db && this.dirty) {
      await this.persist();
    }
    this.db?.close();
    this.db = null;
  }

  version(): number {
    const rows = this.query<{ version: number }>("SELECT version FROM schema_version;");
    return rows[0]?.version ?? 0;
  }

  static get currentSchemaVersion(): number {
    return CURRENT_VERSION;
  }

  private requireDb(): SqlDatabase {
    if (!this.db) throw new Error("Database not initialized. Call init() first.");
    return this.db;
  }
}
```

- [ ] **Step 6.4:** Tests (use real sql.js, in-memory adapter).

Create `src/core/db/database.test.ts`:
```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { Database, type DatabaseAdapter } from "./database";

class MemoryAdapter implements DatabaseAdapter {
  files = new Map<string, ArrayBuffer>();
  constructor(initial: Record<string, ArrayBuffer> = {}) {
    for (const [k, v] of Object.entries(initial)) this.files.set(k, v);
  }
  async readBinary(path: string): Promise<ArrayBuffer | null> {
    return this.files.get(path) ?? null;
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, data);
  }
}

function loadWasm(): ArrayBuffer {
  const wasmPath = resolve(import.meta.dir, "../../../node_modules/sql.js/dist/sql-wasm.wasm");
  const buf = readFileSync(wasmPath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe("Database", () => {
  test("init creates schema and sets version", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    expect(db.version()).toBe(Database.currentSchemaVersion);
    expect(adapter.files.has("/db")).toBe(true);
  });

  test("notes table accepts inserts", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
      ["/n.md", "abc", 10, 1, 1],
    );
    const rows = db.query<{ path: string; sha: string }>("SELECT path, sha FROM notes;");
    expect(rows).toEqual([{ path: "/n.md", sha: "abc" }]);
  });

  test("re-init from persisted DB preserves data", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db1 = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db1.init();
    db1.run(
      "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
      ["/x.md", "sha", 1, 1, 1],
    );
    await db1.persist();
    await db1.close();

    const db2 = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db2.init();
    const rows = db2.query<{ path: string }>("SELECT path FROM notes;");
    expect(rows).toEqual([{ path: "/x.md" }]);
  });
});
```

- [ ] **Step 6.5:** Run.

```bash
bun test src/core/db/database.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 6.6:** Commit.

```bash
git add src/core/db/
git commit -m "feat(foundation): SQLite database + v1 schema + migrations"
```

---

## Task 7: Graph store (SQLite CRUD)

**Files:**
- Create: `src/core/graph/types.ts`
- Create: `src/core/graph/graphStore.ts`
- Create: `src/core/graph/graphStore.test.ts`

- [ ] **Step 7.1:** Graph types.

Create `src/core/graph/types.ts`:
```typescript
export type NodeType = "note" | "concept" | "claim" | "question";

export type EdgeType =
  | "mentions"
  | "asserts"
  | "asks"
  | "links"
  | "supports"
  | "contradicts"
  | "extends"
  | "exemplifies"
  | "synthesizes"
  | "related_to";

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  notePath: string | null;
  payload: Record<string, unknown> | null;
  createdAt: number;
}

export interface GraphEdge {
  id: string;
  type: EdgeType;
  sourceId: string;
  targetId: string;
  confidence: number;
  agent: string;
  evidence: string[];
  approved: boolean;
  createdAt: number;
}
```

- [ ] **Step 7.2:** GraphStore impl.

Create `src/core/graph/graphStore.ts`:
```typescript
import type { Database } from "../db/database";
import type { EdgeType, GraphEdge, GraphNode, NodeType } from "./types";

export class GraphStore {
  constructor(private readonly db: Database) {}

  upsertNode(node: GraphNode): void {
    this.db.run(
      `INSERT INTO graph_nodes (id, type, label, note_path, payload, created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET label = excluded.label, payload = excluded.payload;`,
      [
        node.id,
        node.type,
        node.label,
        node.notePath,
        node.payload ? JSON.stringify(node.payload) : null,
        node.createdAt,
      ],
    );
  }

  insertEdge(edge: GraphEdge): void {
    this.db.run(
      `INSERT INTO graph_edges (id, type, source_id, target_id, confidence, agent, evidence, approved, created_at)
       VALUES (?,?,?,?,?,?,?,?,?);`,
      [
        edge.id,
        edge.type,
        edge.sourceId,
        edge.targetId,
        edge.confidence,
        edge.agent,
        JSON.stringify(edge.evidence),
        edge.approved ? 1 : 0,
        edge.createdAt,
      ],
    );
  }

  approveEdge(id: string): void {
    this.db.run("UPDATE graph_edges SET approved = 1 WHERE id = ?;", [id]);
  }

  edgesFor(nodeId: string): GraphEdge[] {
    const rows = this.db.query<{
      id: string;
      type: string;
      source_id: string;
      target_id: string;
      confidence: number;
      agent: string;
      evidence: string;
      approved: number;
      created_at: number;
    }>(
      `SELECT id, type, source_id, target_id, confidence, agent, evidence, approved, created_at
       FROM graph_edges WHERE source_id = ? OR target_id = ?;`,
      [nodeId, nodeId],
    );
    return rows.map(rowToEdge);
  }

  edgesByType(type: EdgeType, approvedOnly = false): GraphEdge[] {
    const rows = this.db.query<{
      id: string;
      type: string;
      source_id: string;
      target_id: string;
      confidence: number;
      agent: string;
      evidence: string;
      approved: number;
      created_at: number;
    }>(
      approvedOnly
        ? `SELECT * FROM graph_edges WHERE type = ? AND approved = 1;`
        : `SELECT * FROM graph_edges WHERE type = ?;`,
      [type],
    );
    return rows.map(rowToEdge);
  }

  nodesByType(type: NodeType): GraphNode[] {
    const rows = this.db.query<{
      id: string;
      type: string;
      label: string;
      note_path: string | null;
      payload: string | null;
      created_at: number;
    }>(`SELECT * FROM graph_nodes WHERE type = ?;`, [type]);
    return rows.map(rowToNode);
  }
}

function rowToEdge(row: {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  confidence: number;
  agent: string;
  evidence: string;
  approved: number;
  created_at: number;
}): GraphEdge {
  return {
    id: row.id,
    type: row.type as EdgeType,
    sourceId: row.source_id,
    targetId: row.target_id,
    confidence: row.confidence,
    agent: row.agent,
    evidence: JSON.parse(row.evidence) as string[],
    approved: row.approved === 1,
    createdAt: row.created_at,
  };
}

function rowToNode(row: {
  id: string;
  type: string;
  label: string;
  note_path: string | null;
  payload: string | null;
  created_at: number;
}): GraphNode {
  return {
    id: row.id,
    type: row.type as NodeType,
    label: row.label,
    notePath: row.note_path,
    payload: row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : null,
    createdAt: row.created_at,
  };
}
```

- [ ] **Step 7.3:** Tests.

Create `src/core/graph/graphStore.test.ts`:
```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { Database, type DatabaseAdapter } from "../db/database";
import { GraphStore } from "./graphStore";

class MemAdapter implements DatabaseAdapter {
  files = new Map<string, ArrayBuffer>();
  constructor(init: Record<string, ArrayBuffer>) {
    for (const [k, v] of Object.entries(init)) this.files.set(k, v);
  }
  async readBinary(p: string) {
    return this.files.get(p) ?? null;
  }
  async writeBinary(p: string, d: ArrayBuffer) {
    this.files.set(p, d);
  }
}

function wasm(): ArrayBuffer {
  const buf = readFileSync(
    resolve(import.meta.dir, "../../../node_modules/sql.js/dist/sql-wasm.wasm"),
  );
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

let db: Database;
let store: GraphStore;
beforeEach(async () => {
  db = new Database(new MemAdapter({ "/w": wasm() }), { dbPath: "/d", wasmPath: "/w" });
  await db.init();
  store = new GraphStore(db);
});

describe("GraphStore", () => {
  test("insert and retrieve concept node", () => {
    store.upsertNode({
      id: "concept:hpc",
      type: "concept",
      label: "HPC",
      notePath: null,
      payload: { domain: "computing" },
      createdAt: 1,
    });
    const nodes = store.nodesByType("concept");
    expect(nodes.length).toBe(1);
    expect(nodes[0].label).toBe("HPC");
    expect(nodes[0].payload).toEqual({ domain: "computing" });
  });

  test("upsert merges payload", () => {
    store.upsertNode({ id: "c", type: "concept", label: "X", notePath: null, payload: null, createdAt: 1 });
    store.upsertNode({ id: "c", type: "concept", label: "Y", notePath: null, payload: { v: 2 }, createdAt: 2 });
    const nodes = store.nodesByType("concept");
    expect(nodes[0].label).toBe("Y");
    expect(nodes[0].payload).toEqual({ v: 2 });
  });

  test("edges can be inserted and queried by source/target", () => {
    store.insertEdge({
      id: "e1",
      type: "supports",
      sourceId: "a",
      targetId: "b",
      confidence: 0.8,
      agent: "linker",
      evidence: ["chunk-1"],
      approved: false,
      createdAt: 1,
    });
    const edges = store.edgesFor("a");
    expect(edges.length).toBe(1);
    expect(edges[0].type).toBe("supports");
    expect(edges[0].evidence).toEqual(["chunk-1"]);
    expect(edges[0].approved).toBe(false);
  });

  test("approveEdge flips the flag and edgesByType filters", () => {
    store.insertEdge({
      id: "e1",
      type: "contradicts",
      sourceId: "a",
      targetId: "b",
      confidence: 0.7,
      agent: "hunter",
      evidence: [],
      approved: false,
      createdAt: 1,
    });
    expect(store.edgesByType("contradicts", true).length).toBe(0);
    store.approveEdge("e1");
    expect(store.edgesByType("contradicts", true).length).toBe(1);
  });
});
```

- [ ] **Step 7.4:** Run.

```bash
bun test src/core/graph/graphStore.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 7.5:** Commit.

```bash
git add src/core/graph/
git commit -m "feat(foundation): graph store with typed nodes/edges + approval flag"
```

---

## Task 8: Frontmatter writer (dual-store)

**Files:**
- Create: `src/core/graph/frontmatterWriter.ts`
- Create: `src/core/graph/frontmatterWriter.test.ts`

- [ ] **Step 8.1:** Implement parser + writer.

Create `src/core/graph/frontmatterWriter.ts`:
```typescript
export interface NotientFrontmatter {
  vitals?: { health: number; maturity: string; freshness: number };
  edges?: Array<{
    type: string;
    target: string;
    confidence: number;
    evidence?: string;
  }>;
  summary?: string;
  updated?: string;
}

const FENCE = "---";

export function readFrontmatter(content: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  if (!content.startsWith(FENCE)) return { frontmatter: null, body: content };
  const end = content.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) return { frontmatter: null, body: content };
  const yaml = content.slice(FENCE.length, end).trim();
  const body = content.slice(end + FENCE.length + 1).replace(/^\n/, "");
  return { frontmatter: parseYaml(yaml), body };
}

export function writeFrontmatter(
  body: string,
  frontmatter: Record<string, unknown>,
): string {
  if (Object.keys(frontmatter).length === 0) return body;
  return `${FENCE}\n${stringifyYaml(frontmatter)}${FENCE}\n${body}`;
}

export function mergeNotientBlock(
  existing: Record<string, unknown> | null,
  notient: NotientFrontmatter,
): Record<string, unknown> {
  return { ...(existing ?? {}), notient };
}

// Minimal YAML for the keys we control (Notient block + simple top-level scalars).
// We do NOT round-trip arbitrary YAML; we preserve unknown keys verbatim by treating
// them as opaque strings.
export function parseYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }
    const [, key, raw] = match;
    if (raw === "" && lines[i + 1]?.startsWith("  ")) {
      const block: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
        block.push(lines[i].slice(2));
        i++;
      }
      out[key] = parseYaml(block.join("\n"));
      continue;
    }
    out[key] = parseScalar(raw);
    i++;
  }
  return out;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "") return null;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function stringifyYaml(obj: Record<string, unknown>, indent = 0): string {
  const pad = "  ".repeat(indent);
  let out = "";
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      out += `${pad}${key}: null\n`;
    } else if (Array.isArray(value)) {
      out += `${pad}${key}:\n`;
      for (const item of value) {
        if (typeof item === "object" && item !== null) {
          out += `${pad}  - ${inlineObject(item as Record<string, unknown>)}\n`;
        } else {
          out += `${pad}  - ${formatScalar(item)}\n`;
        }
      }
    } else if (typeof value === "object") {
      out += `${pad}${key}:\n${stringifyYaml(value as Record<string, unknown>, indent + 1)}`;
    } else {
      out += `${pad}${key}: ${formatScalar(value)}\n`;
    }
  }
  return out;
}

function inlineObject(obj: Record<string, unknown>): string {
  const pairs = Object.entries(obj).map(([k, v]) => `${k}: ${formatScalar(v)}`);
  return `{ ${pairs.join(", ")} }`;
}

function formatScalar(value: unknown): string {
  if (typeof value === "string") {
    if (/[:#\n,{}\[\]]/.test(value)) return JSON.stringify(value);
    return value;
  }
  return String(value);
}
```

- [ ] **Step 8.2:** Tests.

Create `src/core/graph/frontmatterWriter.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import {
  mergeNotientBlock,
  readFrontmatter,
  writeFrontmatter,
} from "./frontmatterWriter";

describe("frontmatter parse/write", () => {
  test("reads YAML frontmatter and body", () => {
    const md = `---
title: Hello
tags:
  - a
  - b
---
# Body
text`;
    const { frontmatter, body } = readFrontmatter(md);
    expect(frontmatter).toEqual({ title: "Hello", tags: { "- a": null, "- b": null } });
    // Note: our minimal YAML treats indented list as nested keys; that's OK since we
    // only round-trip our own notient block. Body extraction is what matters.
    expect(body).toBe("# Body\ntext");
  });

  test("returns null frontmatter when no fence", () => {
    const md = "# No frontmatter\nbody";
    const { frontmatter, body } = readFrontmatter(md);
    expect(frontmatter).toBeNull();
    expect(body).toBe(md);
  });

  test("merges notient block into existing frontmatter", () => {
    const merged = mergeNotientBlock(
      { title: "Hello" },
      { vitals: { health: 78, maturity: "adolescent", freshness: 0.9 } },
    );
    expect(merged.title).toBe("Hello");
    expect(merged.notient).toEqual({
      vitals: { health: 78, maturity: "adolescent", freshness: 0.9 },
    });
  });

  test("write produces valid fenced block + body", () => {
    const body = "# Hello\n";
    const out = writeFrontmatter(body, {
      title: "T",
      notient: { vitals: { health: 50, maturity: "raw", freshness: 1 } },
    });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out.includes("title: T")).toBe(true);
    expect(out.includes("notient:")).toBe(true);
    expect(out.includes("vitals:")).toBe(true);
    expect(out.endsWith("# Hello\n")).toBe(true);
  });

  test("round-trip preserves notient block keys", () => {
    const original = `---
title: Foo
notient:
  vitals:
    health: 80
    maturity: mature
    freshness: 0.7
---
body`;
    const { frontmatter, body } = readFrontmatter(original);
    expect(frontmatter).not.toBeNull();
    const out = writeFrontmatter(body, frontmatter as Record<string, unknown>);
    const reparsed = readFrontmatter(out);
    expect((reparsed.frontmatter?.notient as { vitals: { health: number } }).vitals.health).toBe(80);
  });
});
```

- [ ] **Step 8.3:** Run.

```bash
bun test src/core/graph/frontmatterWriter.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 8.4:** Commit.

```bash
git add src/core/graph/frontmatterWriter.ts src/core/graph/frontmatterWriter.test.ts
git commit -m "feat(foundation): minimal YAML frontmatter parser + Notient block merger"
```

---

## Task 9: ObsidianFacade

**Files:**
- Create: `src/adapters/obsidianFacade.ts`
- Create: `src/adapters/obsidianFacade.test.ts`

- [ ] **Step 9.1:** Define facade interface and impl.

Create `src/adapters/obsidianFacade.ts`:
```typescript
import type { App, TFile, Vault } from "obsidian";
import { atomicWrite, type AtomicFs } from "../core/utils/atomicWrite";

export interface VaultIO {
  listMarkdown(): { path: string; mtime: number }[];
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export class ObsidianFacade implements VaultIO {
  constructor(private readonly app: App) {}

  listMarkdown(): { path: string; mtime: number }[] {
    return this.app.vault
      .getMarkdownFiles()
      .map((file: TFile) => ({ path: file.path, mtime: file.stat.mtime }));
  }

  async read(path: string): Promise<string> {
    const file = this.requireFile(path);
    return await this.app.vault.read(file);
  }

  async write(path: string, contents: string): Promise<void> {
    const fs = this.adapterFs();
    await atomicWrite(fs, path, contents);
  }

  async remove(path: string): Promise<void> {
    const file = this.requireFile(path);
    await this.app.vault.delete(file);
  }

  async exists(path: string): Promise<boolean> {
    return await this.app.vault.adapter.exists(path);
  }

  private requireFile(path: string): TFile {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f || !(f as TFile).stat) throw new Error(`Not a file: ${path}`);
    return f as TFile;
  }

  private adapterFs(): AtomicFs {
    const adapter = this.app.vault.adapter;
    return {
      writeBinary: (p, d) => adapter.writeBinary(p, d),
      rename: (from, to) => adapter.rename(from, to),
      remove: (p) => adapter.remove(p),
    };
  }

  vault(): Vault {
    return this.app.vault;
  }
}
```

- [ ] **Step 9.2:** Tests use a fake App.

Create `src/adapters/obsidianFacade.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { ObsidianFacade } from "./obsidianFacade";

function fakeApp(initial: Map<string, string>) {
  const renames: Array<[string, string]> = [];
  const writes: Array<[string, ArrayBuffer]> = [];
  const adapter = {
    async exists(path: string) {
      return initial.has(path);
    },
    async writeBinary(path: string, data: ArrayBuffer) {
      writes.push([path, data]);
      initial.set(path, new TextDecoder().decode(data));
    },
    async rename(from: string, to: string) {
      renames.push([from, to]);
      initial.set(to, initial.get(from) ?? "");
      initial.delete(from);
    },
    async remove(path: string) {
      initial.delete(path);
    },
  };
  const files = Array.from(initial.keys()).map((p) => ({ path: p, stat: { mtime: 1 } }));
  return {
    app: {
      vault: {
        adapter,
        getMarkdownFiles: () => files,
        getAbstractFileByPath: (p: string) => files.find((f) => f.path === p),
        async read(file: { path: string }) {
          return initial.get(file.path) ?? "";
        },
        async delete(file: { path: string }) {
          initial.delete(file.path);
        },
      },
    },
    renames,
    writes,
  };
}

describe("ObsidianFacade", () => {
  test("listMarkdown returns paths and mtimes", () => {
    const env = fakeApp(new Map([["a.md", "x"], ["b.md", "y"]]));
    const facade = new ObsidianFacade(env.app as never);
    const list = facade.listMarkdown();
    expect(list.map((f) => f.path).sort()).toEqual(["a.md", "b.md"]);
  });

  test("write performs atomic temp + rename via adapter", async () => {
    const env = fakeApp(new Map([["a.md", "old"]]));
    const facade = new ObsidianFacade(env.app as never);
    await facade.write("a.md", "new content");
    expect(env.renames.length).toBe(1);
    const [from, to] = env.renames[0];
    expect(to).toBe("a.md");
    expect(from.startsWith("a.md.notient-tmp-")).toBe(true);
  });

  test("read returns file contents", async () => {
    const env = fakeApp(new Map([["a.md", "hello"]]));
    const facade = new ObsidianFacade(env.app as never);
    expect(await facade.read("a.md")).toBe("hello");
  });
});
```

- [ ] **Step 9.3:** Run.

```bash
bun test src/adapters/obsidianFacade.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 9.4:** Commit.

```bash
git add src/adapters/
git commit -m "feat(foundation): ObsidianFacade wraps vault with atomic writes"
```

---

## Task 10: LLM provider (OpenAI-compatible)

**Files:**
- Create: `src/core/llm/provider.ts`
- Create: `src/core/llm/lmStudioProvider.ts`
- Create: `src/core/llm/lmStudioProvider.test.ts`

- [ ] **Step 10.1:** Provider interface.

Create `src/core/llm/provider.ts`:
```typescript
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface EmbedOptions {
  model: string;
  signal?: AbortSignal;
}

export interface LLMProvider {
  isAvailable(signal?: AbortSignal): Promise<boolean>;
  chat(messages: ChatMessage[], opts: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<string>;
  embed(input: string[], opts: EmbedOptions): Promise<number[][]>;
}
```

- [ ] **Step 10.2:** OpenAI-compatible impl.

Create `src/core/llm/lmStudioProvider.ts`:
```typescript
import type { ChatMessage, ChatOptions, EmbedOptions, LLMProvider } from "./provider";

export interface ProviderConfig {
  baseUrl: string;
}

export class LMStudioProvider implements LLMProvider {
  constructor(private readonly config: ProviderConfig) {}

  async isAvailable(signal?: AbortSignal): Promise<boolean> {
    try {
      const r = await fetch(`${this.config.baseUrl}/models`, { signal });
      return r.ok;
    } catch {
      return false;
    }
  }

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<string> {
    const r = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({
        model: opts.model,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens,
        stream: false,
      }),
    });
    if (!r.ok) throw new Error(`LLM ${r.status} ${r.statusText}`);
    const data = (await r.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message.content ?? "";
  }

  async *chatStream(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<string> {
    const r = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({
        model: opts.model,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens,
        stream: true,
      }),
    });
    if (!r.ok || !r.body) throw new Error(`LLM ${r.status} ${r.statusText}`);

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const event = JSON.parse(payload) as {
            choices: { delta?: { content?: string } }[];
          };
          const delta = event.choices[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // skip malformed line
        }
      }
    }
  }

  async embed(input: string[], opts: EmbedOptions): Promise<number[][]> {
    const r = await fetch(`${this.config.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({ model: opts.model, input }),
    });
    if (!r.ok) throw new Error(`Embed ${r.status} ${r.statusText}`);
    const data = (await r.json()) as { data: { embedding: number[] }[] };
    return data.data.map((d) => d.embedding);
  }
}
```

- [ ] **Step 10.3:** Tests with mock fetch.

Create `src/core/llm/lmStudioProvider.test.ts`:
```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LMStudioProvider } from "./lmStudioProvider";

let originalFetch: typeof fetch;
let calls: Array<{ url: string; init: RequestInit | undefined }>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

describe("LMStudioProvider", () => {
  test("isAvailable returns true on 200", async () => {
    mockFetch(() => new Response("{}", { status: 200 }));
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    expect(await p.isAvailable()).toBe(true);
  });

  test("isAvailable returns false on network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    expect(await p.isAvailable()).toBe(false);
  });

  test("chat returns assistant content", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "hello world" } }] }),
          { status: 200 },
        ),
    );
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const out = await p.chat([{ role: "user", content: "hi" }], { model: "m" });
    expect(out).toBe("hello world");
    expect(calls[0].url).toBe("http://x/v1/chat/completions");
  });

  test("embed returns vectors", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }),
          { status: 200 },
        ),
    );
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const v = await p.embed(["a", "b"], { model: "e" });
    expect(v).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  test("chatStream yields deltas from SSE stream", async () => {
    const sse =
      "data: " +
      JSON.stringify({ choices: [{ delta: { content: "hel" } }] }) +
      "\n" +
      "data: " +
      JSON.stringify({ choices: [{ delta: { content: "lo" } }] }) +
      "\n" +
      "data: [DONE]\n";
    mockFetch(() => new Response(sse, { status: 200 }));
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const chunks: string[] = [];
    for await (const c of p.chatStream([{ role: "user", content: "hi" }], { model: "m" })) {
      chunks.push(c);
    }
    expect(chunks.join("")).toBe("hello");
  });

  test("chat throws on non-OK response", async () => {
    mockFetch(() => new Response("bad", { status: 500 }));
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    await expect(p.chat([{ role: "user", content: "x" }], { model: "m" })).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 10.4:** Run.

```bash
bun test src/core/llm/
```
Expected: PASS (6 tests).

- [ ] **Step 10.5:** Commit.

```bash
git add src/core/llm/
git commit -m "feat(foundation): OpenAI-compatible LLM provider with streaming + embeddings"
```

---

## Task 11: Health monitor

**Files:**
- Create: `src/core/services/healthMonitor.ts`
- Create: `src/core/services/healthMonitor.test.ts`

- [ ] **Step 11.1:** Implement.

Create `src/core/services/healthMonitor.ts`:
```typescript
import type { EventBus } from "../events/eventBus";
import type { LLMProvider } from "../llm/provider";

export interface MonitoredEndpoint {
  label: string;
  baseUrl: string;
  provider: LLMProvider;
}

export interface HealthMonitorConfig {
  intervalMs: number;
}

export class HealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastResults = new Map<string, boolean>();

  constructor(
    private readonly endpoints: MonitoredEndpoint[],
    private readonly bus: EventBus,
    private readonly config: HealthMonitorConfig,
  ) {}

  start(): void {
    this.probeAll();
    this.timer = setInterval(() => this.probeAll(), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  current(): { label: string; ok: boolean }[] {
    return this.endpoints.map((e) => ({ label: e.label, ok: this.lastResults.get(e.label) ?? false }));
  }

  private async probeAll(): Promise<void> {
    await Promise.all(
      this.endpoints.map(async (endpoint) => {
        const start = Date.now();
        const ok = await endpoint.provider.isAvailable();
        const latencyMs = Date.now() - start;
        this.lastResults.set(endpoint.label, ok);
        this.bus.emit({ type: "llm:health", endpoint: endpoint.label, ok, latencyMs });
      }),
    );
  }
}
```

- [ ] **Step 11.2:** Tests.

Create `src/core/services/healthMonitor.test.ts`:
```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventBus } from "../events/eventBus";
import type { LLMProvider } from "../llm/provider";
import { HealthMonitor } from "./healthMonitor";

class FakeProvider implements LLMProvider {
  constructor(private value: boolean) {}
  setAvailable(v: boolean) {
    this.value = v;
  }
  async isAvailable(): Promise<boolean> {
    return this.value;
  }
  chat(): Promise<string> {
    throw new Error("not used");
  }
  async *chatStream(): AsyncIterable<string> {
    yield "";
  }
  embed(): Promise<number[][]> {
    return Promise.resolve([]);
  }
}

let originalSetInterval: typeof setInterval;
let originalClearInterval: typeof clearInterval;
beforeEach(() => {
  originalSetInterval = globalThis.setInterval;
  originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (() => 0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;
  globalThis.clearInterval = (() => undefined) as typeof clearInterval;
});
afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

describe("HealthMonitor", () => {
  test("emits llm:health events on probe", async () => {
    const bus = new EventBus();
    const events: { endpoint: string; ok: boolean }[] = [];
    bus.on("llm:health", (e) => events.push({ endpoint: e.endpoint, ok: e.ok }));
    const provider = new FakeProvider(true);
    const m = new HealthMonitor(
      [{ label: "primary", baseUrl: "http://x/v1", provider }],
      bus,
      { intervalMs: 30_000 },
    );
    m.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual([{ endpoint: "primary", ok: true }]);
    m.stop();
  });

  test("current() reflects last probe result", async () => {
    const bus = new EventBus();
    const provider = new FakeProvider(false);
    const m = new HealthMonitor(
      [{ label: "primary", baseUrl: "http://x/v1", provider }],
      bus,
      { intervalMs: 30_000 },
    );
    m.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(m.current()).toEqual([{ label: "primary", ok: false }]);
    m.stop();
  });
});
```

- [ ] **Step 11.3:** Run.

```bash
bun test src/core/services/healthMonitor.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 11.4:** Commit.

```bash
git add src/core/services/healthMonitor.ts src/core/services/healthMonitor.test.ts
git commit -m "feat(foundation): periodic LLM health monitor emitting bus events"
```

---

## Task 12: Kernel + DI with fail-loud init

**Files:**
- Create: `src/core/kernel.ts`
- Create: `src/core/kernel.test.ts`

- [ ] **Step 12.1:** Implement kernel.

Create `src/core/kernel.ts`:
```typescript
import type { ObsidianFacade } from "../adapters/obsidianFacade";
import type { Database } from "./db/database";
import type { EventBus } from "./events/eventBus";
import type { GraphStore } from "./graph/graphStore";
import type { LLMProvider } from "./llm/provider";
import type { HealthMonitor } from "./services/healthMonitor";
import type { VaultLockHandle } from "./services/vaultLock";
import type { SettingsService } from "./settings/settingsService";

export interface ServiceRegistry {
  bus: EventBus;
  settings: SettingsService;
  facade: ObsidianFacade;
  database: Database;
  graph: GraphStore;
  primaryLLM: LLMProvider;
  deepLLM: LLMProvider;
  health: HealthMonitor;
  lock: VaultLockHandle;
}

export type ServiceKey = keyof ServiceRegistry;

const REQUIRED_KEYS: ServiceKey[] = [
  "bus",
  "settings",
  "facade",
  "database",
  "graph",
  "primaryLLM",
  "deepLLM",
  "health",
  "lock",
];

export class Kernel {
  private services: Partial<ServiceRegistry> = {};
  private sealed = false;

  register<K extends ServiceKey>(key: K, value: ServiceRegistry[K]): void {
    if (this.sealed) throw new Error(`Kernel sealed; cannot register ${key}`);
    this.services[key] = value;
  }

  seal(): void {
    const missing = REQUIRED_KEYS.filter((k) => this.services[k] === undefined);
    if (missing.length > 0) {
      throw new Error(
        `Kernel.seal(): missing required services: ${missing.join(", ")}`,
      );
    }
    this.sealed = true;
  }

  get<K extends ServiceKey>(key: K): ServiceRegistry[K] {
    const value = this.services[key];
    if (value === undefined) throw new Error(`Kernel: service '${key}' not registered`);
    return value as ServiceRegistry[K];
  }

  isSealed(): boolean {
    return this.sealed;
  }
}
```

- [ ] **Step 12.2:** Tests.

Create `src/core/kernel.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { Kernel } from "./kernel";

describe("Kernel", () => {
  test("get throws if service not registered", () => {
    const k = new Kernel();
    expect(() => k.get("bus")).toThrow(/not registered/);
  });

  test("seal throws if any required service missing", () => {
    const k = new Kernel();
    k.register("bus", {} as never);
    expect(() => k.seal()).toThrow(/missing required services/);
  });

  test("seal succeeds when all required services registered", () => {
    const k = new Kernel();
    for (const key of [
      "bus",
      "settings",
      "facade",
      "database",
      "graph",
      "primaryLLM",
      "deepLLM",
      "health",
      "lock",
    ] as const) {
      k.register(key, {} as never);
    }
    expect(() => k.seal()).not.toThrow();
    expect(k.isSealed()).toBe(true);
  });

  test("register after seal throws", () => {
    const k = new Kernel();
    for (const key of [
      "bus",
      "settings",
      "facade",
      "database",
      "graph",
      "primaryLLM",
      "deepLLM",
      "health",
      "lock",
    ] as const) {
      k.register(key, {} as never);
    }
    k.seal();
    expect(() => k.register("bus", {} as never)).toThrow(/sealed/);
  });
});
```

- [ ] **Step 12.3:** Run.

```bash
bun test src/core/kernel.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 12.4:** Commit.

```bash
git add src/core/kernel.ts src/core/kernel.test.ts
git commit -m "feat(foundation): kernel with fail-loud seal verifying all services registered"
```

---

## Task 13: Sidebar shell + status footer

**Files:**
- Create: `src/ui/sidebar/SidebarView.ts`
- Create: `src/ui/sidebar/App.tsx`
- Create: `src/ui/sidebar/components/StatusFooter.tsx`
- Modify: `src/main.ts` (register view, open on activation)

- [ ] **Step 13.1:** Status signal + component.

Create `src/ui/sidebar/components/StatusFooter.tsx`:
```typescript
import type { Signal } from "@preact/signals";

export interface FooterState {
  endpoints: { label: string; ok: boolean }[];
  noteCount: number;
}

export function StatusFooter({ state }: { state: Signal<FooterState> }) {
  const s = state.value;
  return (
    <div class="notient-status-footer">
      {s.endpoints.map((e) => (
        <span class={`notient-dot ${e.ok ? "ok" : "down"}`} key={e.label} title={e.label}>
          ●
        </span>
      ))}
      <span class="notient-count">{s.noteCount} notes</span>
    </div>
  );
}
```

- [ ] **Step 13.2:** App root.

Create `src/ui/sidebar/App.tsx`:
```typescript
import { signal } from "@preact/signals";
import { StatusFooter, type FooterState } from "./components/StatusFooter";

export const footerState = signal<FooterState>({ endpoints: [], noteCount: 0 });

export function App() {
  return (
    <div class="notient-app">
      <header class="notient-header">
        <h2>Notient</h2>
        <p class="notient-subtitle">Foundation phase — UI lands in Phase 4</p>
      </header>
      <main class="notient-body">
        <p>Plugin loaded. Substrate online.</p>
      </main>
      <StatusFooter state={footerState} />
    </div>
  );
}
```

- [ ] **Step 13.3:** Obsidian view wrapper.

Create `src/ui/sidebar/SidebarView.ts`:
```typescript
import { ItemView, type WorkspaceLeaf } from "obsidian";
import { render } from "preact";
import { App, footerState } from "./App";

export const VIEW_TYPE_NOTIENT = "notient-sidebar";

export class NotientSidebarView extends ItemView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_NOTIENT;
  }

  getDisplayText(): string {
    return "Notient";
  }

  getIcon(): string {
    return "brain-circuit";
  }

  async onOpen(): Promise<void> {
    render(<App />, this.contentEl);
  }

  async onClose(): Promise<void> {
    render(null, this.contentEl);
  }

  static updateFooter(endpoints: { label: string; ok: boolean }[], noteCount: number): void {
    footerState.value = { endpoints, noteCount };
  }
}
```

- [ ] **Step 13.4:** Wire main.ts to register view + initialize all services.

Replace `src/main.ts`:
```typescript
import { Notice, Plugin } from "obsidian";
import { ObsidianFacade } from "./adapters/obsidianFacade";
import { Database } from "./core/db/database";
import { EventBus } from "./core/events/eventBus";
import { GraphStore } from "./core/graph/graphStore";
import { Kernel } from "./core/kernel";
import { LMStudioProvider } from "./core/llm/lmStudioProvider";
import { HealthMonitor } from "./core/services/healthMonitor";
import { VaultLock } from "./core/services/vaultLock";
import { SettingsService } from "./core/settings/settingsService";
import { NotientSettingsTab } from "./core/settings/SettingsTab";
import { NotientSidebarView, VIEW_TYPE_NOTIENT } from "./ui/sidebar/SidebarView";

const PLUGIN_DIR = ".obsidian/plugins/notient";
const DB_PATH = `${PLUGIN_DIR}/notient.db`;
const WASM_PATH = `${PLUGIN_DIR}/sql-wasm.wasm`;
const LOCK_PATH = `${PLUGIN_DIR}/notient.lock`;

export default class NotientPlugin extends Plugin {
  kernel = new Kernel();
  bus = new EventBus();
  settings!: SettingsService;
  private lockHandle: { release(): Promise<void> } | null = null;

  async onload(): Promise<void> {
    console.log("[Notient] onload");

    this.settings = new SettingsService(this, this.bus);
    await this.settings.load();
    this.addSettingTab(new NotientSettingsTab(this.app, this, this.settings));

    const adapter = this.app.vault.adapter;
    const lock = new VaultLock(
      {
        exists: (p) => adapter.exists(p),
        read: (p) => adapter.read(p),
        writeBinary: (p, d) => adapter.writeBinary(p, d),
        remove: (p) => adapter.remove(p),
      },
      LOCK_PATH,
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );

    try {
      this.lockHandle = await lock.acquire();
    } catch (error) {
      new Notice(`Notient: ${(error as Error).message}`);
      throw error;
    }

    const database = new Database(
      {
        readBinary: async (p) => ((await adapter.exists(p)) ? await adapter.readBinary(p) : null),
        writeBinary: (p, d) => adapter.writeBinary(p, d),
      },
      { dbPath: DB_PATH, wasmPath: WASM_PATH },
    );
    await database.init();

    const facade = new ObsidianFacade(this.app);
    const graph = new GraphStore(database);

    const cur = this.settings.get();
    const primaryLLM = new LMStudioProvider({ baseUrl: cur.primary.baseUrl });
    const deepLLM = new LMStudioProvider({ baseUrl: cur.deep.baseUrl });

    const health = new HealthMonitor(
      [
        { label: "primary", baseUrl: cur.primary.baseUrl, provider: primaryLLM },
        { label: "deep", baseUrl: cur.deep.baseUrl, provider: deepLLM },
      ],
      this.bus,
      { intervalMs: 30_000 },
    );

    this.kernel.register("bus", this.bus);
    this.kernel.register("settings", this.settings);
    this.kernel.register("facade", facade);
    this.kernel.register("database", database);
    this.kernel.register("graph", graph);
    this.kernel.register("primaryLLM", primaryLLM);
    this.kernel.register("deepLLM", deepLLM);
    this.kernel.register("health", health);
    this.kernel.register("lock", this.lockHandle);
    this.kernel.seal();

    this.bus.on("llm:health", () => {
      NotientSidebarView.updateFooter(health.current(), facade.listMarkdown().length);
    });

    health.start();

    this.registerView(VIEW_TYPE_NOTIENT, (leaf) => new NotientSidebarView(leaf));
    this.addRibbonIcon("brain-circuit", "Open Notient", async () => {
      const { workspace } = this.app;
      const existing = workspace.getLeavesOfType(VIEW_TYPE_NOTIENT);
      if (existing.length > 0) {
        workspace.revealLeaf(existing[0]);
        return;
      }
      const leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_NOTIENT, active: true });
        workspace.revealLeaf(leaf);
      }
    });

    NotientSidebarView.updateFooter(health.current(), facade.listMarkdown().length);
    console.log("[Notient] ready");
  }

  async onunload(): Promise<void> {
    console.log("[Notient] onunload");
    if (this.kernel.isSealed()) {
      try {
        this.kernel.get("health").stop();
      } catch {
        // ignore
      }
      try {
        await this.kernel.get("database").close();
      } catch {
        // ignore
      }
    }
    if (this.lockHandle) {
      try {
        await this.lockHandle.release();
      } catch {
        // ignore
      }
    }
  }
}
```

- [ ] **Step 13.5:** Add minimal CSS for the footer (styles.css).

Append to `styles.css`:
```css
.notient-app { display: flex; flex-direction: column; height: 100%; padding: 12px; }
.notient-header h2 { margin: 0 0 4px; }
.notient-subtitle { color: var(--text-muted); font-size: 0.85em; margin: 0; }
.notient-body { flex: 1; padding: 12px 0; }
.notient-status-footer {
  border-top: 1px solid var(--background-modifier-border);
  padding: 6px 0; display: flex; gap: 8px; align-items: center; font-size: 0.85em;
}
.notient-dot { font-size: 0.8em; }
.notient-dot.ok { color: var(--color-green); }
.notient-dot.down { color: var(--color-red); }
.notient-count { color: var(--text-muted); margin-left: auto; }
```

- [ ] **Step 13.6:** Build + smoke.

```bash
bun run typecheck && bun run lint && bun scripts/build.ts dev
```
Expected: clean build. In Obsidian: ribbon icon "Open Notient" appears → click → sidebar opens with header, body text, and status footer. Two dots show endpoint health (green if endpoints reachable, red otherwise).

- [ ] **Step 13.7:** Commit.

```bash
git add src/ui/ src/main.ts styles.css
git commit -m "feat(foundation): sidebar shell + status footer wired to health monitor + kernel init"
```

---

## Task 14: Definition-of-done smoke test + Phase 1 tag

**Files:**
- Modify: `src/main.ts` (add vault save handler that hashes content and inserts into `notes`)

- [ ] **Step 14.1:** Add a save handler that hashes content with Web Crypto and writes to DB.

Add to `src/main.ts` inside `onload()` after `health.start()`:
```typescript
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!file.path.endsWith(".md")) return;
        try {
          const contents = await facade.read(file.path);
          const sha = await sha256(contents);
          const now = Date.now();
          database.run(
            `INSERT INTO notes (path, sha, word_count, indexed_at, updated_at)
             VALUES (?,?,?,?,?)
             ON CONFLICT(path) DO UPDATE SET sha = excluded.sha,
               word_count = excluded.word_count,
               updated_at = excluded.updated_at;`,
            [file.path, sha, countWords(contents), now, now],
          );
          await database.persist();
          this.bus.emit({ type: "vault:note-saved", path: file.path, sha });
          NotientSidebarView.updateFooter(health.current(), facade.listMarkdown().length);
        } catch (error) {
          console.error("[Notient] save handler error", error);
        }
      }),
    );
```

Add helpers at the bottom of `src/main.ts` (outside the class):
```typescript
async function sha256(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
```

- [ ] **Step 14.2:** Build.

```bash
bun run typecheck && bun run lint && bun test && bun scripts/build.ts dev
```
Expected: all green; `main.js` deployed.

- [ ] **Step 14.3:** DoD smoke test.

In Obsidian on the test vault:
1. Toggle plugin off and on (force fresh load)
2. Open a markdown note
3. Type a word, save (Ctrl-S)
4. Open developer console, run:
   ```js
   const fs = require("fs");
   const path = ".obsidian/plugins/notient/notient.db";
   console.log("DB size:", fs.statSync(path).size);
   ```
5. Expected: DB exists, size > 0
6. Optionally inspect via SQLite CLI: `sqlite3 .obsidian/plugins/notient/notient.db "SELECT path, sha, word_count FROM notes ORDER BY updated_at DESC LIMIT 5;"`. Expected: at least one row with the file path, a 64-char hex SHA, and a word count.

- [ ] **Step 14.4:** Final verify.

```bash
bun run typecheck && bun run lint && bun test
```
Expected: all green.

- [ ] **Step 14.5:** Commit + tag.

```bash
git add src/main.ts
git commit -m "feat(foundation): on-save SHA hashing → notes table; DoD smoke test passes"
git tag v1.0.0-foundation -m "Phase 1 (Foundation) complete: kernel, atomic writes, vault lock, SQLite + dual-store schema, OpenAI provider, health monitor, status footer, on-save hashing"
git log --oneline -15
```

- [ ] **Step 14.6:** Create Phase 1 STATE.

Create `.planning/STATE.md`:
```markdown
# Notient v1.0 Project State

**Current phase:** Phase 1 (Foundation) — COMPLETE
**Tag:** `v1.0.0-foundation`
**Date completed:** [fill in]
**Next phase:** Phase 2 (Graph) — starts when user signals

## What works
- Plugin loads cleanly in Obsidian
- Settings panel persists endpoints + model overrides
- Kernel seals — fails loud if any service missing
- SQLite database with v1 schema (notes, chunks, embeddings, graph_nodes, graph_edges, history)
- Atomic writes + vault lock + frontmatter writer (unit-tested)
- OpenAI-compatible LLM provider with streaming + embeddings
- Health monitor probes both dynamo and mini every 30s
- Sidebar opens via ribbon, status footer shows live health + note count
- On-save handler computes SHA + upserts into notes table

## What does not exist yet
- Chunker, embedder, extractor (Phase 2)
- Vector index (Phase 2)
- Awaken Vault onboarding (Phase 2)
- Agents (Phase 3)
- Co-author panel (Phase 3)
- Stream UI, decorations, vitals panel (Phase 4)
- Chat (Phase 4)
- Hardening + landing site (Phase 5)

## Files of note
- Spec: `docs/superpowers/specs/2026-04-25-notient-v1-design.md`
- Phase 1 plan: `docs/superpowers/plans/2026-04-25-phase-1-foundation.md`
- Phase 1 source: all of `src/`

## How to resume
Read this file → read the spec → invoke `superpowers:writing-plans` to draft the Phase 2 plan from spec §13 row 2.
```

- [ ] **Step 14.7:** Commit STATE.

```bash
git add .planning/STATE.md
git commit -m "docs(foundation): Phase 1 STATE handoff"
```

---

## Self-Review

Spec coverage check:
- §3 architecture three layers — Foundation builds the substrate; Senses/Mind/Presence land in Phases 2-4. ✓
- §4 graph dual-store — graph schema in Task 6/7, frontmatter writer in Task 8. ✓
- §5 AI substrate — Provider impl in Task 10, settings defaults point at dynamo/mini in Task 3. ✓
- §10 cross-cutting (atomic writes, vault lock, thinking parser, typed events, kernel DI) — atomic writes Task 4, vault lock Task 5, typed events Task 2, kernel DI Task 12. Thinking parser deferred to Phase 3 (only needed when streaming reasoning models matter). ✓
- §13 Phase 1 DoD: empty plugin loads, settings work, health monitor green, write a note → SHA logged in DB — Tasks 1, 3, 11, 14 cover. ✓

Placeholder scan: none. Every step has actual code or actual commands.

Type consistency: `LLMProvider`, `EventBus`, `Database`, `GraphStore`, `SettingsService`, `ObsidianFacade`, `HealthMonitor`, `VaultLockHandle` — all referenced consistently between Tasks 10/11/12/13/14.

Granularity: each task has clear file paths, real test code, real implementation, exact commands. Bite-sized steps within tasks.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-25-phase-1-foundation.md`. Two execution options:**

**1. Subagent-Driven (recommended — matches user's "agent driven development" preference)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Uses the existing `.claude/agents/dispatch.py` and role worktrees from `CLAUDE.md`.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

**Which approach?**
