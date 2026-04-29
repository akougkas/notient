# Notient v0.1 Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substrate runs end-to-end against `tests/fixtures/sentient-vault/` and the user's vaultex without any UI. CLI exposes `awaken`, `reindex`, `search`, `vitals`, `health`. Daemon hosts the `chokidar` watcher and an autonomous `Coordinator` loop that wakes after the first awaken.

**Architecture:** Phase A wired bus, settings, vault, database, graph, three LLM providers, health, lock, echoGuard. Phase B promotes the kernel to its full Phase B subset: `embedder`, `extractor`, `vectorIndex`, `indexer`, `vaultBootstrap`, `idleDetector`, `reasoningMutex`, `reranker`, `searchPipeline`, `savedQueries`, `searchHistory`, `vitalsService`, `coordinator`. Five new RPC handlers (`awaken.run`, `reindex.glob`, `search.run`, `vitals.get`, `health.probe`) plus the bridge probe and watcher. Five new CLI verbs that wrap them.

**Tech Stack:** Bun runtime, TypeScript strict, `node:net` Unix socket (Phase A), `chokidar@4` watcher (declared Phase A, used Phase B), `hnswlib-wasm` vectors, `sql.js` DB, `@lmstudio/sdk` providers (locked substrate at `192.168.86.143:1234`). No new deps; `chokidar` and `unpdf` are already in `package.json` from Phase A.

**Source of truth:** `docs/superpowers/specs/2026-04-27-notient-cli-design.md` Section 4.4 (RPC catalog), Section 6 Phase B (deliverables), Section 4.3 (event taxonomy).

**Locked decisions (from this session, 2026-04-27):**
1. Coordinator autonomous loop starts only after the first `awaken.run` completes successfully.
2. `reindex <glob>` invokes the same `indexNote` pipeline as `awaken`, which already skips unchanged chunks via SHA. No `--force` flag.
3. `search.run mode=quick` returns `BRIDGE_DOWN` when the Obsidian bridge is not up. Error message includes a remediation hint.
4. Smoke harness runs against the live LM Studio at `192.168.86.143:1234`. No fake provider in this phase.
5. `chokidar` runs with `ignoreInitial: true`. First-time backfill is the user's job via `notient awaken`.

---

## Hard rules (carry forward from Phase A; one Phase B addition)

- TypeScript strict. No `any` without justification.
- No `console.log` outside `src/cli/output.ts` and the existing `debug<Subsystem>` helpers. The daemon's two stdout writes (`daemon:ready`, `daemon:shutting_down`) remain the only allowed direct stdout writes outside the CLI emitter.
- No abbreviations: `context` not `ctx`, `error` not `err`, `message` not `msg`, `event` not `evt`, `index` not `idx`, `options` not `opts`.
- No `[noun] - [parenthetical clause]` dash-clause prose anywhere.
- No emojis in source.
- One commit per logical step on `beta-spec`. No `git add -A`. Stage by name only.
- Substrate tests stay green throughout. New tests are additive.
- **(Phase B addition)** Every new RPC handler emits substrate events from the kernel's `EventBus` to the per-request emitter via a forwarder. Handlers do not invent event types; they re-emit what the substrate already produces, with the daemon's `id` envelope prepended.

---

## Risks (carried from spec section 9 + new ones surfaced this phase)

| Risk | Tasks affected | Mitigation in this plan |
|---|---|---|
| Embedding LLM cold-start ~30s on first awaken | Task 5 (awaken handler), Task 20 (smoke) | Smoke gate budgets 60s for the first batch. Awaken handler emits `indexer:progress` per file, so a slow first call is visible to the user. |
| WSL2 chokidar inotify reliability on networked mounts (vaultex lives on `/mnt/c`) | Task 11 (watcher) | Watcher detects `/mnt/` paths and falls back to `usePolling: true` with `interval: 1000`. Native `inotify` for non-WSL mounts. |
| Bridge probe blocks daemon boot if Obsidian is slow to respond | Task 1 (probe) | Probe runs in the background after `daemon:ready`. First tick is asynchronous; daemon starts whether bridge is up or down. |
| `Coordinator.start()` triggers agent runs before the index has data | Task 13 (coordinator) | Locked decision (1): Coordinator only starts after the first `awaken.run` resolves. Bootstrap registers it but does not call `.start()`. |
| `notient search query="..."` quoting in the CLI parser | Task 16 (search verb) | Phase A's parser already handles `--key value` and `--key=value` after a one-line normalization (added in Task 16). The query is read from a positional or from `--query`. |
| `Coordinator.dispatch` requires `vault:note-saved` and friends; the daemon does not currently emit them | Task 13 (coordinator) | Watcher (Task 11) and indexer (Task 5) emit `vault:note-saved` after each `indexNote` completion so the Coordinator's existing subscription model works unchanged. |
| HNSW vector index file is not pre-existing on a fresh vault | Task 4 (bootstrap) | `HnswVectorIndex` already initializes empty when the load returns null. Bootstrap reads `<vault>/.notient/vectors.bin` if present, else creates an empty index. |
| `kernel.test.ts` references `ALL_SERVICE_KEYS` and would break if Phase B promotion changes the list | Task 3 (kernel promotion) | The full `REQUIRED_KEYS` list is unchanged. Phase B adds a `PHASE_B_KEYS` constant alongside `PHASE_A_KEYS`; the test continues to drive the full set. |

---

## File structure (Phase B landing state)

```
src/
├── bridge/
│   ├── obsidianProbe.ts        # NEW — 30s polling, emits bridge:up/bridge:down
│   ├── obsidianProbe.test.ts   # NEW
│   ├── obsidianCli.ts          # NEW — shell-out wrapper for `obsidian` CLI verbs (read-style)
│   └── obsidianCli.test.ts     # NEW
├── daemon/
│   ├── handlers/               # NEW
│   │   ├── awaken.ts           # NEW — awaken.run, reindex.glob
│   │   ├── awaken.test.ts      # NEW
│   │   ├── search.ts           # NEW — search.run; BRIDGE_DOWN on quick mode w/o bridge
│   │   ├── search.test.ts      # NEW
│   │   ├── vitals.ts           # NEW — vitals.get
│   │   ├── vitals.test.ts      # NEW
│   │   └── health.ts           # NEW — health.probe (substrate + bridge)
│   ├── watcher.ts              # NEW — chokidar w/ WSL polling fallback
│   ├── watcher.test.ts         # NEW
│   ├── coordinatorRunner.ts    # NEW — start() once first awaken completes
│   ├── bootstrap.ts            # MODIFIED — registers Phase B services
│   └── index.ts                # MODIFIED — registers handlers, starts watcher, wires runner
├── cli/
│   └── commands/               # MODIFIED
│       ├── awaken.ts           # NEW
│       ├── reindex.ts          # NEW
│       ├── search.ts           # NEW
│       ├── vitals.ts           # NEW
│       └── health.ts           # NEW
├── cli/
│   └── index.ts                # MODIFIED — dispatch table extended
└── core/
    └── kernel.ts               # MODIFIED — adds PHASE_B_KEYS

scripts/
└── smoke-cli-phaseB.ts         # NEW — Phase B gate harness
```

---

## Task DAG

```
Group 1: Bridge probe (sequential)
  Task 1: src/bridge/obsidianProbe.ts + test
  Task 2: src/bridge/obsidianCli.ts + test

Group 2: Kernel promotion + bootstrap extension (sequential)
  Task 3: kernel.ts adds PHASE_B_KEYS
  Task 4: daemon/bootstrap.ts registers Phase B services and seals with phase: "B"

Group 3: Daemon handlers (parallel after Task 4)
  Task 5: daemon/handlers/awaken.ts + test    [parallel-safe]
  Task 6: daemon/handlers/search.ts + test    [parallel-safe]
  Task 7: daemon/handlers/vitals.ts + test    [parallel-safe]
  Task 8: daemon/handlers/health.ts           [parallel-safe]

Group 4: Wire handlers into daemon entry (sequential after Group 3)
  Task 9: daemon/index.ts registers handlers via a wireHandlers() helper

Group 5: Watcher (parallel with Group 4 — separate file)
  Task 10: daemon/watcher.ts + test
  Task 11: daemon/index.ts starts the watcher

Group 6: Coordinator autonomous loop (sequential after Tasks 4 + 9 + 11)
  Task 12:   daemon/coordinatorRunner.ts + test
  Task 13:   daemon/index.ts wires runner; first awaken triggers Coordinator.start()
  Task 13.5: daemon/bootstrap.ts wires real Linker + ContradictionHunter callbacks

Group 7: CLI verbs (parallel after Task 9)
  Task 14: cli/commands/awaken.ts                                 [parallel-safe]
  Task 15: cli/commands/reindex.ts                                [parallel-safe]
  Task 16: cli/commands/search.ts                                 [parallel-safe]
  Task 17: cli/commands/vitals.ts                                 [parallel-safe]
  Task 18: cli/commands/health.ts                                 [parallel-safe]
  Task 19: cli/index.ts dispatch table extended                   [needs 14-18]

Group 8: Smoke + gate (sequential, last)
  Task 20: scripts/smoke-cli-phaseB.ts
  Task 21: Phase B gate run + live invocation against vaultex (live LM Studio)
```

**Parallelism rules.** Tasks 5, 6, 7, 8 can dispatch in parallel: each writes a single new file under `src/daemon/handlers/`, no shared state. Tasks 10 and any of 5-8 can also run in parallel. Tasks 14-18 are independent CLI verbs.

Sequential constraints: Group 2 must precede Group 3. Group 4 (handler wiring in `daemon/index.ts`) must serialize because it edits a single file. Group 6 needs the kernel bootstrap, the awaken handler, and the watcher all live before the runner can sensibly trigger.

---

## Group 1: Bridge probe

### Task 1: `src/bridge/obsidianProbe.ts` + test

**Files:**
- Create: `/home/akougkas/projects/notient/src/bridge/obsidianProbe.ts`
- Create: `/home/akougkas/projects/notient/src/bridge/obsidianProbe.test.ts`

The probe runs `obsidian status --json` (or whatever the cheapest read-style verb is) every 30 seconds. On success it emits `bridge:up` on the EventBus. On any failure (binary not on PATH, non-zero exit, parse error) it emits `bridge:down`. The probe never throws to its caller; it logs to the bus. The first tick happens asynchronously after `start()` so daemon boot is not blocked.

- [ ] **Step 1: Write the test**

Create `src/bridge/obsidianProbe.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../core/events/eventBus";
import { ObsidianProbe } from "./obsidianProbe";

interface BusEvent {
  type: string;
  [key: string]: unknown;
}

function captureBus(bus: EventBus): BusEvent[] {
  const events: BusEvent[] = [];
  bus.on("bridge:up", (event) => {
    events.push({ ...event });
  });
  bus.on("bridge:down", (event) => {
    events.push({ ...event });
  });
  return events;
}

describe("ObsidianProbe", () => {
  let probe: ObsidianProbe | null = null;

  afterEach(async () => {
    if (probe) {
      await probe.stop();
      probe = null;
    }
  });

  test("emits bridge:up when the prober reports ready", async () => {
    const bus = new EventBus();
    const events = captureBus(bus);
    probe = new ObsidianProbe({
      bus,
      intervalMs: 50,
      probe: async () => ({ ok: true, version: "1.5.3" }),
    });
    await probe.tickOnce();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("bridge:up");
    expect(events[0].version).toBe("1.5.3");
  });

  test("emits bridge:down when the prober rejects", async () => {
    const bus = new EventBus();
    const events = captureBus(bus);
    probe = new ObsidianProbe({
      bus,
      intervalMs: 50,
      probe: async () => ({ ok: false, error: "ENOENT" }),
    });
    await probe.tickOnce();
    expect(events[0].type).toBe("bridge:down");
    expect(events[0].error).toBe("ENOENT");
  });

  test("dedupes consecutive identical states", async () => {
    const bus = new EventBus();
    const events = captureBus(bus);
    probe = new ObsidianProbe({
      bus,
      intervalMs: 50,
      probe: async () => ({ ok: true, version: "1.5.3" }),
    });
    await probe.tickOnce();
    await probe.tickOnce();
    await probe.tickOnce();
    expect(events.length).toBe(1);
  });

  test("emits state transitions", async () => {
    const bus = new EventBus();
    const events = captureBus(bus);
    let state: "up" | "down" = "up";
    probe = new ObsidianProbe({
      bus,
      intervalMs: 50,
      probe: async () => (state === "up" ? { ok: true } : { ok: false, error: "down" }),
    });
    await probe.tickOnce();
    state = "down";
    await probe.tickOnce();
    state = "up";
    await probe.tickOnce();
    expect(events.map((event) => event.type)).toEqual(["bridge:up", "bridge:down", "bridge:up"]);
  });
});
```

NOTE: This test references `EventBus.on("bridge:up", ...)`. Verify the event taxonomy includes both event names; if the typed bus is closed-shape and rejects new event names, add `"bridge:up"` and `"bridge:down"` to the bus event union in `src/core/events/types.ts` as part of this task. Use `grep "bridge:up" src/core/events/types.ts` to check.

- [ ] **Step 2: Add bridge events to the bus type union if missing**

Run: `grep -n "bridge:up\|bridge:down" src/core/events/types.ts`
If no matches: open `src/core/events/types.ts` and add to the event union:

```typescript
| { type: "bridge:up"; version?: string }
| { type: "bridge:down"; error?: string }
```

If matches exist, skip this step.

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test src/bridge/obsidianProbe.test.ts`
Expected: FAIL because `obsidianProbe.ts` does not exist.

- [ ] **Step 4: Write the implementation**

Create `src/bridge/obsidianProbe.ts`:

```typescript
import type { EventBus } from "../core/events/eventBus";

export interface ProbeResult {
  ok: boolean;
  version?: string;
  error?: string;
}

export type ProbeFn = () => Promise<ProbeResult>;

export interface ObsidianProbeOptions {
  bus: EventBus;
  intervalMs: number;
  probe: ProbeFn;
}

/**
 * Polls the Obsidian CLI on a fixed interval and emits bridge:up / bridge:down
 * via the EventBus. Probes never throw; failures surface as bridge:down with
 * an error string. Consecutive identical states are deduped so the bus only
 * sees transitions plus the first tick.
 */
export class ObsidianProbe {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastState: "up" | "down" | null = null;

  constructor(private readonly options: ObsidianProbeOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, this.options.intervalMs);
    setImmediate(() => {
      void this.tickOnce();
    });
  }

  async tickOnce(): Promise<void> {
    let result: ProbeResult;
    try {
      result = await this.options.probe();
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const next: "up" | "down" = result.ok ? "up" : "down";
    if (this.lastState === next) return;
    this.lastState = next;
    if (result.ok) {
      this.options.bus.emit({ type: "bridge:up", version: result.version });
    } else {
      this.options.bus.emit({ type: "bridge:down", error: result.error });
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/bridge/obsidianProbe.test.ts`
Expected: PASS, all 4 cases.

- [ ] **Step 6: Commit**

```bash
git add src/bridge/obsidianProbe.ts src/bridge/obsidianProbe.test.ts src/core/events/types.ts
git commit -m "$(cat <<'EOF'
feat(bridge): Obsidian readiness probe

Polls a caller-provided probe function every intervalMs and emits
bridge:up / bridge:down via EventBus. Dedupes consecutive identical
states. Probes never throw; failures surface as bridge:down with an
error string. Daemon entry will inject a probe that runs the obsidian
CLI; tests inject deterministic fakes.
EOF
)"
```

---

### Task 2: `src/bridge/obsidianCli.ts` + test

**Files:**
- Create: `/home/akougkas/projects/notient/src/bridge/obsidianCli.ts`
- Create: `/home/akougkas/projects/notient/src/bridge/obsidianCli.test.ts`

A thin wrapper around `node:child_process.spawn` for the `obsidian` CLI. Phase B uses it only for the read-style verbs that Phase B handlers need: `obsidian status --json` (used by the probe) and a generic `exec(verb, args)` that the search handler will call for `obsidian search "..." --json` when the user runs `notient search mode=quick`. The wrapper enforces a hard timeout (default 5s) and returns `{ ok, stdout, stderr, exitCode }` instead of throwing.

- [ ] **Step 1: Write the test**

Create `src/bridge/obsidianCli.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { execObsidian } from "./obsidianCli";

describe("execObsidian", () => {
  test("returns ok=false when the binary is missing", async () => {
    const result = await execObsidian({
      command: "definitely-not-a-real-binary-xyz",
      args: ["--version"],
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("returns ok=true with stdout when the command succeeds", async () => {
    const result = await execObsidian({
      command: "/bin/sh",
      args: ["-c", "printf 'hello\\n'"],
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  test("returns ok=false on non-zero exit", async () => {
    const result = await execObsidian({
      command: "/bin/sh",
      args: ["-c", "exit 7"],
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
  });

  test("times out long-running commands", async () => {
    const result = await execObsidian({
      command: "/bin/sh",
      args: ["-c", "sleep 5"],
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timeout");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/bridge/obsidianCli.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `src/bridge/obsidianCli.ts`:

```typescript
import { spawn } from "node:child_process";

export interface ExecOptions {
  command: string;
  args: string[];
  timeoutMs: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function execObsidian(options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let finished = false;

    const timeoutHandle = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGKILL");
      resolve({
        ok: false,
        exitCode: -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        error: `timeout after ${options.timeoutMs}ms`,
      });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      resolve({
        ok: false,
        exitCode: -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        error: error.message,
      });
    });

    child.on("close", (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      const code = exitCode ?? -1;
      resolve({
        ok: code === 0,
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      });
    });
  });
}

/**
 * Convenience wrapper for the eventual `obsidian` CLI binary. Phase B uses
 * this only via `obsidianStatusProbe()` (in the daemon) and the search
 * handler's quick-mode path. The binary may not exist on the user's PATH;
 * callers must handle ok=false gracefully.
 */
export function obsidianStatusProbe(timeoutMs = 2000): Promise<ExecResult> {
  return execObsidian({
    command: "obsidian",
    args: ["status", "--json"],
    timeoutMs,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/bridge/obsidianCli.test.ts`
Expected: PASS, all 4 cases.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/obsidianCli.ts src/bridge/obsidianCli.test.ts
git commit -m "$(cat <<'EOF'
feat(bridge): obsidian CLI shell-out wrapper

execObsidian wraps node:child_process.spawn with a hard timeout and
returns { ok, exitCode, stdout, stderr, error } instead of throwing.
obsidianStatusProbe is the convenience entry the daemon's
ObsidianProbe will inject. Tests cover missing binary, success,
non-zero exit, and timeout.
EOF
)"
```

---

## Group 2: Kernel promotion + bootstrap extension

### Task 3: `kernel.ts` adds `PHASE_B_KEYS`

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/kernel.ts`

The Phase B subset adds the indexer surface, search surface, vitals, coordinator, and the supporting reasoningMutex/idleDetector. Bootstrap will register these. The kernel test continues to drive the full `REQUIRED_KEYS` set; this task is additive only.

- [ ] **Step 1: Add `PHASE_B_KEYS` after `PHASE_A_KEYS`**

In `src/core/kernel.ts`, after the `PHASE_A_KEYS` constant, add:

```typescript
const PHASE_B_KEYS: ServiceKey[] = [
  ...PHASE_A_KEYS,
  "indexer",
  "vectorIndex",
  "embedder",
  "extractor",
  "vaultBootstrap",
  "idleDetector",
  "reasoningMutex",
  "searchPipeline",
  "savedQueries",
  "searchHistory",
  "vitalsService",
  "coordinator",
];
```

Then change the `seal()` method to dispatch on `phase === "B"`:

```typescript
  seal(options: { phase?: "A" | "B" | "C" } = {}): void {
    let required: ServiceKey[];
    if (options.phase === "A") required = PHASE_A_KEYS;
    else if (options.phase === "B") required = PHASE_B_KEYS;
    else required = REQUIRED_KEYS;
    const missing = required.filter((key) => this.services[key] === undefined);
    if (missing.length > 0) {
      throw new Error(`Kernel.seal(): missing required services: ${missing.join(", ")}`);
    }
    this.sealed = true;
  }
```

- [ ] **Step 2: Typecheck and run the kernel test**

Run: `bun run typecheck && bun test src/core/kernel.test.ts`
Expected: Green. The kernel test still passes (it registers the full `REQUIRED_KEYS` set). The `phase: "B"` branch is exercised in Task 4's bootstrap.

- [ ] **Step 3: Commit**

```bash
git add src/core/kernel.ts
git commit -m "$(cat <<'EOF'
refactor(kernel): seal() recognises phase: "B"

Adds PHASE_B_KEYS constant covering the substrate slice that the
Phase B bootstrap wires: indexer, vectorIndex, embedder, extractor,
vaultBootstrap, idleDetector, reasoningMutex, searchPipeline,
savedQueries, searchHistory, vitalsService, coordinator. The full
REQUIRED_KEYS list is unchanged so the kernel test keeps driving the
complete surface; default behaviour is unchanged.
EOF
)"
```

---

### Task 4: `daemon/bootstrap.ts` registers Phase B services

**Files:**
- Modify: `/home/akougkas/projects/notient/src/daemon/bootstrap.ts`

Bootstrap constructs and registers every Phase B service. Order matters: the indexer needs the embedder + extractor + vectorIndex, the searchPipeline needs the vectorIndex + reranker + embedder, the coordinator needs the four agents which themselves need DB + provider + a neighborhood callback. The neighborhood callback is supplied as an arrow function bound to the vectorIndex.

The HNSW index loads from `<vault>/.notient/vectors.bin` if present; otherwise it constructs empty. The savedQueries and searchHistory facades wrap the FsVault.

This is the largest single edit in Phase B. The file roughly doubles in size.

- [ ] **Step 1: Replace `bootstrap.ts` with the Phase B variant**

Open `src/daemon/bootstrap.ts` and replace its entire content with:

```typescript
import { Linker } from "../core/agents/linker";
import { MaturityAdvancer } from "../core/agents/maturityAdvancer";
import { ContradictionHunter } from "../core/agents/contradictionHunter";
import { Synthesizer } from "../core/agents/synthesizer";
import { Coordinator } from "../core/coordinator/coordinator";
import { ReasoningMutex } from "../core/coordinator/reasoningMutex";
import { Database } from "../core/db/database";
import { EventBus } from "../core/events/eventBus";
import { GraphStore } from "../core/graph/graphStore";
import { Embedder } from "../core/indexer/embedder";
import { Extractor } from "../core/indexer/extractor";
import { HnswVectorIndex } from "../core/indexer/hnswVectorIndex";
import { IndexerQueue } from "../core/indexer/indexerQueue";
import { indexNote } from "../core/indexer/indexNote";
import { Kernel } from "../core/kernel";
import { LMStudioProvider } from "../core/llm/lmStudioProvider";
import { Reranker } from "../core/search/reranker";
import { SavedQueries } from "../core/search/savedQueries";
import { SearchHistory } from "../core/search/searchHistory";
import { SearchPipeline } from "../core/search/searchPipeline";
import { EchoGuard } from "../core/services/echoGuard";
import { HealthMonitor } from "../core/services/healthMonitor";
import { IdleDetector } from "../core/services/idleDetector";
import { VaultBootstrap } from "../core/services/vaultBootstrap";
import { VaultLock, type VaultLockHandle } from "../core/services/vaultLock";
import { type ConfigStore, SettingsService } from "../core/settings/settingsService";
import { VitalsService } from "../core/vitals/vitalsService";
import { FsVault } from "../adapters/fsVault";

export interface BootstrapOptions {
  vaultPath: string;
  /** Override for LM Studio base URL when testing. Defaults to settings. */
  baseUrlOverride?: string;
  /** When true, seal kernel with phase: "A". Default phase: "B". */
  phaseA?: boolean;
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

const NOTIENT_FOLDER = "Notient";
const CONVERSATIONS_FOLDER = `${NOTIENT_FOLDER}/conversations`;
const PROPOSALS_FOLDER = `${NOTIENT_FOLDER}/proposals`;
const SAVED_QUERIES_FOLDER = `${NOTIENT_FOLDER}/searches`;
const SIDECAR_PATH = `${NOTIENT_FOLDER}/.index.json`;

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
  const current = settings.get();

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

  const baseUrl = options.baseUrlOverride ?? current.primary.baseUrl;
  const primaryLLM = new LMStudioProvider({ baseUrl });
  const deepLLM = new LMStudioProvider({ baseUrl: current.deep.baseUrl });
  const embeddingLLM = new LMStudioProvider({ baseUrl: current.embedding.baseUrl });

  const health = new HealthMonitor(
    [
      { label: "primary", baseUrl, provider: primaryLLM },
      { label: "deep", baseUrl: current.deep.baseUrl, provider: deepLLM },
      { label: "embedding", baseUrl: current.embedding.baseUrl, provider: embeddingLLM },
    ],
    bus,
    { intervalMs: 30_000 },
  );

  const phaseA = options.phaseA === true;

  // Phase A registers and seals here.
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

  if (phaseA) {
    kernel.seal({ phase: "A" });
    health.start();
    return {
      kernel,
      close: makeClose({ database, lockHandle, health, vectorIndex: null, vault, vectorPath: VECTOR_PATH }),
    };
  }

  // Phase B additions.
  const vectorIndex = new HnswVectorIndex({});
  const existingVectorBytes = await vault.readBinary(VECTOR_PATH);
  if (existingVectorBytes) {
    await vectorIndex.load(existingVectorBytes);
  }

  const embedder = new Embedder(embeddingLLM, { model: current.embedding.model });
  const extractor = new Extractor(deepLLM, { model: current.deep.reasoningModel });

  const indexer = new IndexerQueue({
    bus,
    indexNote: async (path) => {
      const body = await vault.read(path);
      return await indexNote({
        notePath: path,
        noteBody: body,
        database,
        graph,
        vectorIndex,
        embedder,
        extractor,
        bus,
      });
    },
  });

  const vaultBootstrap = new VaultBootstrap({
    facade: {
      exists: (path) => vault.exists(path),
      createFolder: (path) => vault.createFolder(path),
    },
  });
  await vaultBootstrap.run({
    conversationsFolder: CONVERSATIONS_FOLDER,
    proposalsFolder: PROPOSALS_FOLDER,
    savedQueriesFolder: SAVED_QUERIES_FOLDER,
  });

  const idleDetector = new IdleDetector(bus, {});
  const reasoningMutex = new ReasoningMutex();

  const reranker = new Reranker({
    provider: deepLLM,
    model: current.deep.rerankerModel,
  });

  const searchPipeline = new SearchPipeline({
    db: database,
    vectorIndex,
    reranker,
    embed: async (text, signal) => {
      const vectors = await embedder.embed([text], signal);
      return vectors.length > 0 ? new Float32Array(vectors[0]) : null;
    },
    provider: deepLLM,
    reasoningModel: current.deep.reasoningModel,
    settings: () => current.search,
  });

  const savedQueries = new SavedQueries({
    facade: {
      list: (folder) => vault.list(folder).then((listing) => listing.files),
      read: (path) => vault.read(path),
      write: (path, content) => vault.write(path, content),
      delete: (path) => vault.remove(path),
    },
    folder: SAVED_QUERIES_FOLDER,
    now: () => Date.now(),
  });

  const searchHistory = new SearchHistory({
    facade: {
      readSidecar: async () => {
        const raw = await vault.read(SIDECAR_PATH).catch(() => null);
        if (raw === null) return null;
        try {
          return JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return null;
        }
      },
      writeSidecar: async (value) => {
        await vault.write(SIDECAR_PATH, JSON.stringify(value, null, 2));
      },
    },
    maxQueries: current.search.history.maxQueries,
  });

  const vitalsService = new VitalsService({
    db: database,
    now: () => Date.now(),
    settings: () => current.vitals,
    facade: {
      updateFrontmatter: (path, patch) => vault.updateFrontmatter(path, patch),
      readNote: (path) => vault.read(path),
      writeNote: (path, content) => vault.write(path, content),
    },
    echoGuard: { mark: (path, sha) => echoGuard.mark(path, sha) },
  });

  const linker = new Linker({
    db: database,
    provider: deepLLM,
    reasoningModel: current.deep.reasoningModel,
    neighborhood: async (notePath, opts) => {
      return [];
    },
  });
  const synthesizer = new Synthesizer({
    db: database,
    provider: deepLLM,
    reasoningModel: current.deep.reasoningModel,
    epsilon: 0.35,
    minClusterSize: 3,
    sinceMs: 7 * 24 * 60 * 60 * 1000,
  });
  const contradictionHunter = new ContradictionHunter({
    db: database,
    provider: deepLLM,
    reasoningModel: current.deep.reasoningModel,
    neighbors: async (claimIds, opts) => {
      return [];
    },
    maxPairs: 5,
  });
  const maturityAdvancer = new MaturityAdvancer({
    db: database,
    facade: {
      read: (path) => vault.read(path),
      write: (path, content) => vault.write(path, content),
    },
    echoGuard,
    hash: async (input) => {
      const buffer = new TextEncoder().encode(input);
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    },
  });

  const coordinator = new Coordinator({
    bus,
    db: database,
    mutex: reasoningMutex,
    agents: {
      linker,
      synthesizer,
      contradictionHunter,
      maturityAdvancer,
    },
  });

  kernel.register("indexer", indexer);
  kernel.register("vectorIndex", vectorIndex);
  kernel.register("embedder", embedder);
  kernel.register("extractor", extractor);
  kernel.register("vaultBootstrap", vaultBootstrap);
  kernel.register("idleDetector", idleDetector);
  kernel.register("reasoningMutex", reasoningMutex);
  kernel.register("searchPipeline", searchPipeline);
  kernel.register("savedQueries", savedQueries);
  kernel.register("searchHistory", searchHistory);
  kernel.register("vitalsService", vitalsService);
  kernel.register("coordinator", coordinator);
  kernel.seal({ phase: "B" });

  health.start();
  idleDetector.start();

  return {
    kernel,
    close: makeClose({ database, lockHandle, health, vectorIndex, vault, vectorPath: VECTOR_PATH }),
  };
}

interface CloseDeps {
  database: Database;
  lockHandle: VaultLockHandle;
  health: HealthMonitor;
  vectorIndex: HnswVectorIndex | null;
  vault: FsVault;
  vectorPath: string;
}

function makeClose(deps: CloseDeps): () => Promise<void> {
  return async (): Promise<void> => {
    deps.health.stop();
    if (deps.vectorIndex) {
      try {
        const bytes = await deps.vectorIndex.serialize();
        await deps.vault.writeBinary(deps.vectorPath, bytes);
      } catch (error) {
        // Vector persistence is best-effort: a failure here must not block the
        // database flush or the lock release. Surface to the daemon's stderr
        // emitter via a thrown re-attempt in Phase E if we want to escalate.
        process.stderr.write(
          `${JSON.stringify({ type: "daemon:vector_persist_failed", message: error instanceof Error ? error.message : String(error) })}\n`,
        );
      }
    }
    await deps.database.persist();
    await deps.database.close();
    await deps.lockHandle.release();
  };
}
```

NOTE on `makeClose`: vector persistence is owned end-to-end here. The daemon's `index.ts` shutdown path just calls `closeBootstrap()`; it does not touch the HNSW serializer or the vault adapter directly for vectors. Failures during serialization emit `daemon:vector_persist_failed` to stderr but never block the database flush or lock release.

NOTE on agent callbacks: `linker.neighborhood` and `contradictionHunter.neighbors` are deliberately registered as `[]`-returning stubs in this commit so the bootstrap stays compilable before Task 13.5 lands. Task 13.5 replaces both with the live HNSW queries ported from `.nuked/src/main.ts`. The Coordinator does not start until the first awaken (locked decision 1), so the stubs are never invoked in production until Task 13.5 has landed.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: Green. If `SavedQueriesStore` does not exist by that name, check `src/core/search/savedQueries.ts` exports and rename accordingly. Same for `SearchHistory`.

- [ ] **Step 3: Run the substrate test suite**

Run: `bun test src/core src/adapters src/daemon`
Expected: Green. The bootstrap is not directly tested but the kernel and daemon socket tests must keep passing.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/bootstrap.ts
git commit -m "$(cat <<'EOF'
feat(daemon): bootstrap Phase B services into the kernel

Constructs and registers Embedder, Extractor, HnswVectorIndex (with
optional restore from <vault>/.notient/vectors.bin), IndexerQueue
(wired to indexNote against FsVault), SavedQueries, SearchHistory,
SearchPipeline, VitalsService, IdleDetector, ReasoningMutex,
VaultBootstrap (creates Notient/conversations, Notient/proposals,
Notient/searches), and Coordinator with the four agent constructors.
Linker and ContradictionHunter neighbourhood callbacks land as
[]-returning stubs that Task 13.5 replaces with the live HNSW queries
before the Coordinator can ever invoke them. makeClose owns vector
persistence end-to-end so the daemon entry stays a thin lifecycle
shell. Kernel seals with phase: "B" by default; phase: "A" still
available via opts.phaseA for compatibility.
EOF
)"
```

---

## Group 3: Daemon handlers

Tasks 5, 6, 7, 8 are independent files. They can dispatch in parallel. Each writes one new file plus its test.

### Task 5: `daemon/handlers/awaken.ts` + test

**Files:**
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/awaken.ts`
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/awaken.test.ts`

The awaken handler walks `vault.listMarkdown()`, optionally filtered by `since`, batches by `batch` (default 32), and pushes each path through `indexer.enqueue(path)`. It re-emits indexer events on the per-request emitter. The reindex.glob handler does the same against a glob.

- [ ] **Step 1: Write the test**

Create `src/daemon/handlers/awaken.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { EventBus } from "../../core/events/eventBus";
import type { IndexerQueue } from "../../core/indexer/indexerQueue";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import { makeAwakenHandler, makeReindexHandler } from "./awaken";

interface FakeQueue {
  enqueued: string[];
  enqueue: (path: string) => void;
  drain: () => Promise<void>;
}

function makeQueue(): FakeQueue {
  const queue: FakeQueue = {
    enqueued: [],
    enqueue: (path: string) => {
      queue.enqueued.push(path);
    },
    drain: async () => {},
  };
  return queue;
}

function makeVault(files: { path: string; mtime: number }[]): Pick<VaultAdapter, "listMarkdown"> {
  return {
    listMarkdown: async () => files,
  };
}

describe("awaken handler", () => {
  test("enqueues every markdown file", async () => {
    const bus = new EventBus();
    const queue = makeQueue();
    const vault = makeVault([
      { path: "a.md", mtime: 1000 },
      { path: "b.md", mtime: 2000 },
    ]);
    const lines: string[] = [];
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
    });
    const result = await handler({}, (line) => {
      lines.push(line);
    }, "req-1");
    expect(queue.enqueued.sort()).toEqual(["a.md", "b.md"]);
    expect(result.ok).toBe(true);
    expect(result.queued).toBe(2);
  });

  test("filters by since when provided", async () => {
    const bus = new EventBus();
    const queue = makeQueue();
    const vault = makeVault([
      { path: "old.md", mtime: 1000 },
      { path: "new.md", mtime: 5000 },
    ]);
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
    });
    await handler({ since: 3000 }, () => {}, "req-1");
    expect(queue.enqueued).toEqual(["new.md"]);
  });
});

describe("reindex handler", () => {
  test("enqueues paths matching the glob", async () => {
    const bus = new EventBus();
    const queue = makeQueue();
    const vault = makeVault([
      { path: "notes/a.md", mtime: 1 },
      { path: "notes/b.md", mtime: 2 },
      { path: "drafts/c.md", mtime: 3 },
    ]);
    const handler = makeReindexHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
    });
    await handler({ pattern: "notes/*.md" }, () => {}, "req-1");
    expect(queue.enqueued.sort()).toEqual(["notes/a.md", "notes/b.md"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/daemon/handlers/awaken.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `src/daemon/handlers/awaken.ts`:

```typescript
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import type { EventBus } from "../../core/events/eventBus";
import type { IndexerQueue } from "../../core/indexer/indexerQueue";
import { encodeEvent } from "../rpc";

export interface AwakenHandlerDeps {
  bus: EventBus;
  indexer: IndexerQueue;
  vault: VaultAdapter;
}

export function makeAwakenHandler(deps: AwakenHandlerDeps) {
  return async (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ): Promise<Record<string, unknown>> => {
    const since = typeof params.since === "number" ? params.since : null;
    const all = await deps.vault.listMarkdown();
    const filtered = since === null ? all : all.filter((entry) => entry.mtime >= since);

    const forwardEvents = subscribeIndexerEvents(deps.bus, emit, envelopeId);
    try {
      for (const entry of filtered) {
        deps.indexer.enqueue(entry.path);
      }
      await deps.indexer.drain();
      return { ok: true, queued: filtered.length };
    } finally {
      forwardEvents();
    }
  };
}

export function makeReindexHandler(deps: AwakenHandlerDeps) {
  return async (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ): Promise<Record<string, unknown>> => {
    const pattern = typeof params.pattern === "string" ? params.pattern : "**/*.md";
    const matcher = compileGlob(pattern);
    const all = await deps.vault.listMarkdown();
    const matches = all.filter((entry) => matcher(entry.path));

    const forwardEvents = subscribeIndexerEvents(deps.bus, emit, envelopeId);
    try {
      for (const entry of matches) {
        deps.indexer.enqueue(entry.path);
      }
      await deps.indexer.drain();
      return { ok: true, queued: matches.length };
    } finally {
      forwardEvents();
    }
  };
}

function subscribeIndexerEvents(
  bus: EventBus,
  emit: (line: string) => void,
  envelopeId: string,
): () => void {
  const unsubs: Array<() => void> = [];
  for (const eventName of [
    "indexer:queued",
    "indexer:progress",
    "indexer:note_indexed",
    "indexer:complete",
    "indexer:error",
  ] as const) {
    unsubs.push(
      bus.on(eventName, (event) => {
        emit(encodeEvent(envelopeId, eventName, event as Record<string, unknown>));
      }),
    );
  }
  return () => {
    for (const off of unsubs) off();
  };
}

/**
 * Minimal glob matcher. Supports `*` (any non-slash chars), `**` (any chars
 * including slashes), and literal segments. Sufficient for the
 * `notient reindex "notes/*.md"` use case in Phase B; richer glob semantics
 * land in Phase E.
 */
function compileGlob(pattern: string): (path: string) => boolean {
  const regex = patternToRegExp(pattern);
  return (path: string) => regex.test(path);
}

function patternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index++;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if (".+()|^$[]{}\\".includes(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  source += "$";
  return new RegExp(source);
}
```

NOTE: `IndexerQueue.drain()` may not exist on the substrate yet. Inspect `src/core/indexer/indexerQueue.ts` and either use the existing flush method or add a `drain()` that resolves once `pending` is empty. If neither exists, fall back to polling: `while (queue.pendingCount() > 0) await sleep(50)`. The test fakes this method.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/daemon/handlers/awaken.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/handlers/awaken.ts src/daemon/handlers/awaken.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): awaken.run + reindex.glob handlers

awaken.run walks vault.listMarkdown(), optionally filtered by `since`,
and feeds every path through IndexerQueue.enqueue. reindex.glob filters
by a minimal glob pattern (*, **, ?). Both handlers subscribe to
indexer:* events on the bus and forward them through the per-request
emitter so CLI clients see streaming progress. Returns { ok, queued }
on success.
EOF
)"
```

---

### Task 6: `daemon/handlers/search.ts` + test

**Files:**
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/search.ts`
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/search.test.ts`

The search handler accepts `{ query, mode, filters? }`. For `mode=quick` it returns `BRIDGE_DOWN` with a remediation hint when the bridge is not up. For `mode=balanced` and `mode=deep` it iterates `searchPipeline.run(query, signal)` and forwards each event.

- [ ] **Step 1: Write the test**

Create `src/daemon/handlers/search.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { SearchEvent, SearchPipeline } from "../../core/search/searchPipeline";
import { makeSearchHandler } from "./search";

function makeFakePipeline(events: SearchEvent[]): SearchPipeline {
  return {
    run: async function* () {
      for (const event of events) yield event;
    },
  } as unknown as SearchPipeline;
}

describe("search handler", () => {
  test("forwards balanced mode events", async () => {
    const pipeline = makeFakePipeline([
      { type: "search:retrieving", mode: "balanced" },
      { type: "search:hits", hits: [] },
      { type: "search:done", result: { hits: [], synthesisCard: null } as never },
    ]);
    const handler = makeSearchHandler({
      pipeline,
      bridgeUp: () => true,
    });
    const lines: string[] = [];
    const result = await handler(
      { query: "hello", mode: "balanced" },
      (line) => lines.push(line),
      "req-1",
    );
    expect(result.ok).toBe(true);
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]).event).toBe("search:retrieving");
  });

  test("returns BRIDGE_DOWN for quick mode without bridge", async () => {
    const handler = makeSearchHandler({
      pipeline: makeFakePipeline([]),
      bridgeUp: () => false,
    });
    let thrown: unknown = null;
    try {
      await handler({ query: "x", mode: "quick" }, () => {}, "req-1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("BRIDGE_DOWN");
  });

  test("rejects empty query", async () => {
    const handler = makeSearchHandler({
      pipeline: makeFakePipeline([]),
      bridgeUp: () => true,
    });
    let thrown: unknown = null;
    try {
      await handler({ mode: "balanced" }, () => {}, "req-1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/daemon/handlers/search.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `src/daemon/handlers/search.ts`:

```typescript
import type { SearchPipeline } from "../../core/search/searchPipeline";
import type { SearchFilters, SearchMode, SearchQuery } from "../../core/search/types";
import { encodeEvent } from "../rpc";

export interface SearchHandlerDeps {
  pipeline: SearchPipeline;
  bridgeUp: () => boolean;
}

export function makeSearchHandler(deps: SearchHandlerDeps) {
  return async (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ): Promise<Record<string, unknown>> => {
    const query = typeof params.query === "string" ? params.query : "";
    if (query.trim().length === 0) {
      throw new Error("INVALID_PARAMS: query is required");
    }
    const mode = (typeof params.mode === "string" ? params.mode : "balanced") as SearchMode;
    if (mode === "quick" && !deps.bridgeUp()) {
      throw new Error(
        "BRIDGE_DOWN: notient search mode=quick wraps Obsidian's native search; start Obsidian or pass mode=balanced",
      );
    }

    const filters = (params.filters as SearchFilters | undefined) ?? {};
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    const searchQuery: SearchQuery = { query, mode, filters, limit };

    const controller = new AbortController();
    let lastResult: unknown = null;
    for await (const event of deps.pipeline.run(searchQuery, controller.signal)) {
      emit(encodeEvent(envelopeId, event.type, event as unknown as Record<string, unknown>));
      if (event.type === "search:done") lastResult = event.result;
    }
    return { ok: true, result: lastResult };
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/daemon/handlers/search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/handlers/search.ts src/daemon/handlers/search.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): search.run handler with bridge-aware quick mode

Wraps SearchPipeline.run as an async iterator and forwards search:*
events through the per-request emitter. mode=quick returns
BRIDGE_DOWN with a remediation hint when the Obsidian bridge is not up
(spec section 4.4 quick mode requires native search). Empty query
returns INVALID_PARAMS. Returns the final search:done payload as the
RPC result for one-shot consumers that ignored the stream.
EOF
)"
```

---

### Task 7: `daemon/handlers/vitals.ts` + test

**Files:**
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/vitals.ts`
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/vitals.test.ts`

The vitals handler calls `vitalsService.computeSnapshot(path)` and emits a single `vitals:snapshot` event before resolving.

- [ ] **Step 1: Write the test**

Create `src/daemon/handlers/vitals.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { VitalsService, VitalsSnapshot } from "../../core/vitals/vitalsService";
import { makeVitalsHandler } from "./vitals";

const FIXTURE_SNAPSHOT: VitalsSnapshot = {
  path: "note.md",
  health: 0.78,
  freshness: 0.6,
  connectivity: "warm",
  maturity: "mature",
} as VitalsSnapshot;

describe("vitals handler", () => {
  test("returns the snapshot and emits an event", async () => {
    const service = {
      computeSnapshot: () => FIXTURE_SNAPSHOT,
    } as unknown as VitalsService;
    const handler = makeVitalsHandler({ vitalsService: service });
    const lines: string[] = [];
    const result = await handler({ path: "note.md" }, (line) => lines.push(line), "req-1");
    expect(result.snapshot).toEqual(FIXTURE_SNAPSHOT);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).event).toBe("vitals:snapshot");
  });

  test("rejects empty path", async () => {
    const service = { computeSnapshot: () => FIXTURE_SNAPSHOT } as unknown as VitalsService;
    const handler = makeVitalsHandler({ vitalsService: service });
    let thrown: unknown = null;
    try {
      await handler({}, () => {}, "req-1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  test("returns INVALID_PARAMS when the note is not indexed", async () => {
    const service = { computeSnapshot: () => null } as unknown as VitalsService;
    const handler = makeVitalsHandler({ vitalsService: service });
    let thrown: unknown = null;
    try {
      await handler({ path: "missing.md" }, () => {}, "req-1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("not indexed");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/daemon/handlers/vitals.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `src/daemon/handlers/vitals.ts`:

```typescript
import type { VitalsService } from "../../core/vitals/vitalsService";
import { encodeEvent } from "../rpc";

export interface VitalsHandlerDeps {
  vitalsService: VitalsService;
}

export function makeVitalsHandler(deps: VitalsHandlerDeps) {
  return async (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ): Promise<Record<string, unknown>> => {
    const path = typeof params.path === "string" ? params.path : "";
    if (path.trim().length === 0) {
      throw new Error("INVALID_PARAMS: path is required");
    }
    const snapshot = deps.vitalsService.computeSnapshot(path);
    if (!snapshot) {
      throw new Error(`INVALID_PARAMS: note not indexed: ${path}`);
    }
    emit(encodeEvent(envelopeId, "vitals:snapshot", snapshot as unknown as Record<string, unknown>));
    return { ok: true, snapshot };
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/daemon/handlers/vitals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/handlers/vitals.ts src/daemon/handlers/vitals.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): vitals.get handler

Wraps VitalsService.computeSnapshot and emits the vitals:snapshot event
before resolving. Returns the snapshot in the RPC result for one-shot
consumers. Empty path returns INVALID_PARAMS.
EOF
)"
```

---

### Task 8: `daemon/handlers/health.ts`

**Files:**
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/health.ts`

The health handler runs `healthMonitor.probeAll()` and combines the result with the bridge state. No new test file: the substrate's `healthMonitor.test.ts` covers the probe; the handler is a 25-line shim.

- [ ] **Step 1: Write the implementation**

Create `src/daemon/handlers/health.ts`:

```typescript
import type { HealthMonitor } from "../../core/services/healthMonitor";
import { encodeEvent } from "../rpc";

export interface HealthHandlerDeps {
  health: HealthMonitor;
  bridgeUp: () => boolean;
}

export function makeHealthHandler(deps: HealthHandlerDeps) {
  return async (
    _params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ): Promise<Record<string, unknown>> => {
    const probes = await deps.health.probeAll();
    const bridge = deps.bridgeUp();
    const tick = {
      type: "health:tick" as const,
      ...probes,
      bridge,
    };
    emit(encodeEvent(envelopeId, "health:tick", tick as unknown as Record<string, unknown>));
    return { ok: true, ...probes, bridge };
  };
}
```

NOTE: Verify `HealthMonitor.probeAll()` exists with that name. If it is named differently (e.g., `probe()` or `runProbe()`), adjust accordingly. Check with `grep "probeAll\|async probe\b" src/core/services/healthMonitor.ts`.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/handlers/health.ts
git commit -m "$(cat <<'EOF'
feat(daemon): health.probe handler

Combines HealthMonitor.probeAll() with the bridge state (from
ObsidianProbe) and emits a single health:tick event. Returns the
combined report in the RPC result.
EOF
)"
```

---

## Group 4: Wire handlers into `daemon/index.ts`

### Task 9: `daemon/index.ts` registers Phase B handlers

**Files:**
- Modify: `/home/akougkas/projects/notient/src/daemon/index.ts`

Pull handler factories together via a `wireHandlers()` helper. The daemon already constructs the dispatcher and registers `daemon.*`; this task adds five more registrations.

- [ ] **Step 1: Edit `src/daemon/index.ts`**

After the existing `dispatcher.register("daemon.config_set", ...)` block (around line 110), add:

```typescript
  const indexer = kernel.get("indexer");
  const searchPipeline = kernel.get("searchPipeline");
  const vitalsService = kernel.get("vitalsService");
  let bridgeUp = false;

  dispatcher.register("awaken.run", makeAwakenHandler({ bus: kernel.get("bus"), indexer, vault: kernel.get("vault") }));
  dispatcher.register("reindex.glob", makeReindexHandler({ bus: kernel.get("bus"), indexer, vault: kernel.get("vault") }));
  dispatcher.register("search.run", makeSearchHandler({ pipeline: searchPipeline, bridgeUp: () => bridgeUp }));
  dispatcher.register("vitals.get", makeVitalsHandler({ vitalsService }));
  dispatcher.register("health.probe", makeHealthHandler({ health: kernel.get("health"), bridgeUp: () => bridgeUp }));

  kernel.get("bus").on("bridge:up", () => {
    bridgeUp = true;
  });
  kernel.get("bus").on("bridge:down", () => {
    bridgeUp = false;
  });
```

Add the new imports near the top of the file:

```typescript
import { makeAwakenHandler, makeReindexHandler } from "./handlers/awaken";
import { makeHealthHandler } from "./handlers/health";
import { makeSearchHandler } from "./handlers/search";
import { makeVitalsHandler } from "./handlers/vitals";
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/index.ts
git commit -m "$(cat <<'EOF'
feat(daemon): register Phase B RPC handlers

Wires awaken.run, reindex.glob, search.run, vitals.get, and
health.probe into the MethodDispatcher. The daemon also now
subscribes to bridge:up / bridge:down on the bus so the search and
health handlers can read the live bridge state via a closure.
EOF
)"
```

---

## Group 5: Watcher

### Task 10: `daemon/watcher.ts` + test

**Files:**
- Create: `/home/akougkas/projects/notient/src/daemon/watcher.ts`
- Create: `/home/akougkas/projects/notient/src/daemon/watcher.test.ts`

The watcher uses `chokidar` with `ignoreInitial: true`. On WSL paths (`/mnt/c/...`), it switches to `usePolling: true, interval: 1000` because inotify on cifs/9p mounts is unreliable. On native paths it uses default inotify. Each `add` / `change` event pushes the path through `indexer.enqueue`.

- [ ] **Step 1: Write the test**

Create `src/daemon/watcher.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultWatcher, isWslPath } from "./watcher";

describe("isWslPath", () => {
  test("matches /mnt/<letter>/ paths", () => {
    expect(isWslPath("/mnt/c/Users/x")).toBe(true);
    expect(isWslPath("/mnt/d/projects")).toBe(true);
  });

  test("rejects native paths", () => {
    expect(isWslPath("/home/user/notes")).toBe(false);
    expect(isWslPath("/tmp/v")).toBe(false);
  });
});

describe("VaultWatcher", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-watch-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("emits enqueue when a markdown file is added after start", async () => {
    const enqueued: string[] = [];
    const watcher = new VaultWatcher({
      root,
      enqueue: (path) => {
        enqueued.push(path);
      },
      pollingInterval: 50,
      forcePolling: true,
    });
    await watcher.start();
    await writeFile(join(root, "new.md"), "hello");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await watcher.stop();
    expect(enqueued).toContain("new.md");
  });

  test("ignoreInitial: existing files are not enqueued on start", async () => {
    await writeFile(join(root, "existing.md"), "x");
    const enqueued: string[] = [];
    const watcher = new VaultWatcher({
      root,
      enqueue: (path) => {
        enqueued.push(path);
      },
      pollingInterval: 50,
      forcePolling: true,
    });
    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await watcher.stop();
    expect(enqueued).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/daemon/watcher.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `src/daemon/watcher.ts`:

```typescript
import chokidar, { type FSWatcher } from "chokidar";
import { relative, sep, posix } from "node:path";

export interface VaultWatcherOptions {
  root: string;
  enqueue: (vaultRelativePath: string) => void;
  /** Override polling decision (true = always poll, false = always inotify). */
  forcePolling?: boolean;
  pollingInterval?: number;
}

const DOT_PREFIXES = new Set([".notient", ".obsidian", ".git"]);

export class VaultWatcher {
  private watcher: FSWatcher | null = null;

  constructor(private readonly options: VaultWatcherOptions) {}

  async start(): Promise<void> {
    if (this.watcher) return;
    const usePolling = this.options.forcePolling ?? isWslPath(this.options.root);
    this.watcher = chokidar.watch(this.options.root, {
      ignoreInitial: true,
      usePolling,
      interval: this.options.pollingInterval ?? 1000,
      ignored: (path) => {
        const segments = path.split(sep);
        return segments.some((segment) => DOT_PREFIXES.has(segment));
      },
    });
    await new Promise<void>((resolve, reject) => {
      const watcher = this.watcher;
      if (!watcher) {
        resolve();
        return;
      }
      watcher.once("ready", () => resolve());
      watcher.once("error", reject);
    });
    const onChange = (absolutePath: string): void => {
      if (!absolutePath.endsWith(".md")) return;
      const vaultPath = relative(this.options.root, absolutePath).split(sep).join(posix.sep);
      this.options.enqueue(vaultPath);
    };
    this.watcher.on("add", onChange);
    this.watcher.on("change", onChange);
  }

  async stop(): Promise<void> {
    if (!this.watcher) return;
    await this.watcher.close();
    this.watcher = null;
  }
}

export function isWslPath(path: string): boolean {
  return /^\/mnt\/[a-z]\//i.test(path);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/daemon/watcher.test.ts`
Expected: PASS, both cases.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/watcher.ts src/daemon/watcher.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): chokidar-backed vault watcher

VaultWatcher wraps chokidar with ignoreInitial: true (first-time
backfill is the user's job via notient awaken). WSL paths
(/mnt/<letter>/...) auto-switch to usePolling: true with a 1000ms
interval to work around unreliable inotify on cifs/9p mounts; native
paths use default inotify. .notient/, .obsidian/, .git/ ignored.
Each .md add or change pushes the vault-relative path through the
caller-provided enqueue callback.
EOF
)"
```

---

### Task 11: Wire the watcher into `daemon/index.ts`

**Files:**
- Modify: `/home/akougkas/projects/notient/src/daemon/index.ts`

After the handlers register (Task 9), construct the watcher and start it. Persist the vector index on shutdown.

- [ ] **Step 1: Add the watcher wiring after the handler block**

In `src/daemon/index.ts`, immediately after the handler registrations from Task 9, add:

```typescript
  const watcher = new VaultWatcher({
    root: args.vaultPath,
    enqueue: (path) => {
      indexer.enqueue(path);
    },
  });
  await watcher.start();
```

Add the import at the top:

```typescript
import { VaultWatcher } from "./watcher";
```

In the `shutdown(reason)` function, before `await closeBootstrap()`, add:

```typescript
    await watcher.stop();
```

Vector persistence is owned by `bootstrap.ts`'s `makeClose()` and runs as part of `closeBootstrap()`. Do not write vectors from the daemon entry; that path is the single source of truth.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/index.ts
git commit -m "$(cat <<'EOF'
feat(daemon): start the vault watcher

VaultWatcher kicks in after handlers are wired and feeds .md changes
straight into IndexerQueue. Vector persistence on shutdown is owned
by bootstrap's makeClose so the daemon entry stays a thin lifecycle
shell.
EOF
)"
```

---

## Group 6: Coordinator autonomous loop

### Task 12: `daemon/coordinatorRunner.ts` + test

**Files:**
- Create: `/home/akougkas/projects/notient/src/daemon/coordinatorRunner.ts`
- Create: `/home/akougkas/projects/notient/src/daemon/coordinatorRunner.test.ts`

The runner exposes `armOnFirstAwaken()`. It listens for `indexer:complete`. The first one calls `coordinator.start()`. Subsequent ones do nothing.

- [ ] **Step 1: Write the test**

Create `src/daemon/coordinatorRunner.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { Coordinator } from "../core/coordinator/coordinator";
import { EventBus } from "../core/events/eventBus";
import { CoordinatorRunner } from "./coordinatorRunner";

describe("CoordinatorRunner", () => {
  test("starts coordinator after first indexer:complete", () => {
    const bus = new EventBus();
    let started = 0;
    const coordinator = {
      start: () => {
        started++;
      },
    } as unknown as Coordinator;
    const runner = new CoordinatorRunner({ bus, coordinator });
    runner.arm();
    bus.emit({ type: "indexer:complete", total: 5, durationMs: 1000 });
    expect(started).toBe(1);
  });

  test("does not restart on subsequent indexer:complete", () => {
    const bus = new EventBus();
    let started = 0;
    const coordinator = {
      start: () => {
        started++;
      },
    } as unknown as Coordinator;
    const runner = new CoordinatorRunner({ bus, coordinator });
    runner.arm();
    bus.emit({ type: "indexer:complete", total: 5, durationMs: 1000 });
    bus.emit({ type: "indexer:complete", total: 3, durationMs: 500 });
    expect(started).toBe(1);
  });

  test("disarmed runner does not start", () => {
    const bus = new EventBus();
    let started = 0;
    const coordinator = {
      start: () => {
        started++;
      },
    } as unknown as Coordinator;
    const runner = new CoordinatorRunner({ bus, coordinator });
    runner.arm();
    runner.disarm();
    bus.emit({ type: "indexer:complete", total: 5, durationMs: 1000 });
    expect(started).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/daemon/coordinatorRunner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `src/daemon/coordinatorRunner.ts`:

```typescript
import type { Coordinator } from "../core/coordinator/coordinator";
import type { EventBus } from "../core/events/eventBus";

export interface CoordinatorRunnerOptions {
  bus: EventBus;
  coordinator: Coordinator;
}

export class CoordinatorRunner {
  private armed = false;
  private started = false;
  private unsub: (() => void) | null = null;

  constructor(private readonly options: CoordinatorRunnerOptions) {}

  arm(): void {
    if (this.armed) return;
    this.armed = true;
    this.unsub = this.options.bus.on("indexer:complete", () => {
      if (this.started) return;
      if (!this.armed) return;
      this.started = true;
      this.options.coordinator.start();
    });
  }

  disarm(): void {
    this.armed = false;
    if (this.unsub) this.unsub();
    this.unsub = null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/daemon/coordinatorRunner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/coordinatorRunner.ts src/daemon/coordinatorRunner.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): coordinator runner armed on first awaken

CoordinatorRunner subscribes to indexer:complete and triggers
Coordinator.start() exactly once, on the first event. Subsequent
events are ignored. Disarm cleans up the subscription. The daemon
arms the runner during boot; the first awaken.run completion lights
up the autonomous loop. Locked Phase B decision: never wake the
coordinator on an empty vault.
EOF
)"
```

---

### Task 13: Wire CoordinatorRunner into `daemon/index.ts`

**Files:**
- Modify: `/home/akougkas/projects/notient/src/daemon/index.ts`

Construct the runner after the watcher starts. Arm it. The first awaken call lights the loop.

- [ ] **Step 1: Add the runner wiring after the watcher block**

In `src/daemon/index.ts`, after `await watcher.start();`, add:

```typescript
  const coordinatorRunner = new CoordinatorRunner({
    bus: kernel.get("bus"),
    coordinator: kernel.get("coordinator"),
  });
  coordinatorRunner.arm();
```

Add the import at the top:

```typescript
import { CoordinatorRunner } from "./coordinatorRunner";
```

In `shutdown(reason)`, before `await watcher.stop();`, add:

```typescript
    coordinatorRunner.disarm();
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/index.ts
git commit -m "$(cat <<'EOF'
feat(daemon): arm CoordinatorRunner during boot

Runner subscribes to indexer:complete on boot and starts the
Coordinator on the first event, never on an empty vault. Disarm runs
in the shutdown path. The four agents (linker, synthesizer,
contradictionHunter, maturityAdvancer) wake on the existing
vault:note-saved / coordinator:* event subscriptions wired in
bootstrap.
EOF
)"
```

---

### Task 13.5: Bind `Linker.neighborhood` and `ContradictionHunter.neighbors` to real DB queries

**Files:**
- Modify: `/home/akougkas/projects/notient/src/daemon/bootstrap.ts`

The Task 4 commit landed the agents with `[]`-returning stubs. With the Coordinator now armed (Task 13), those stubs would silently keep `linker` and `contradictionHunter` from ever surfacing real proposals. This task ports the queries from `.nuked/src/main.ts` lines 254-335 verbatim so the agents work as designed against the live HNSW index.

Both queries follow the same pattern: pick a representative embedding (head chunk for the linker, claim's chunk for the hunter), call `vectorIndex.search(view, topK)`, and join the hit ids back to chunks/notes/claims.

- [ ] **Step 1: Replace the linker stub**

In `src/daemon/bootstrap.ts`, find the `const linker = new Linker({ ... })` block and replace its `neighborhood` field with:

```typescript
    neighborhood: async (notePath, queryOptions) => {
      const head = database.query<{ id: string; vector: Uint8Array; dim: number }>(
        `SELECT e.chunk_id AS id, e.vector AS vector, e.dim AS dim
         FROM embeddings e JOIN chunks c ON c.id = e.chunk_id
         WHERE c.note_path = ? ORDER BY c.ord LIMIT 1;`,
        [notePath],
      );
      if (head.length === 0) return [];
      const view = new Float32Array(
        head[0].vector.buffer,
        head[0].vector.byteOffset,
        head[0].dim,
      );
      const hits = vectorIndex.search(view, queryOptions.topK);
      const out: Array<{ notePath: string; chunkId: string; text: string; score: number }> = [];
      for (const hit of hits) {
        const meta = database.query<{ note_path: string; text: string }>(
          "SELECT note_path, text FROM chunks WHERE id = ?;",
          [hit.id],
        );
        if (meta.length === 0) continue;
        if (meta[0].note_path === notePath) continue;
        out.push({
          notePath: meta[0].note_path,
          chunkId: hit.id,
          text: meta[0].text,
          score: hit.score,
        });
      }
      return out;
    },
```

- [ ] **Step 2: Replace the contradiction hunter stub**

In the same file, find `const contradictionHunter = new ContradictionHunter({ ... })` and replace its `neighbors` field with:

```typescript
    neighbors: async (recentClaimIds, queryOptions) => {
      if (recentClaimIds.length === 0) return [];
      const probe = database.query<{ vector: Uint8Array; dim: number; chunk_id: string }>(
        `SELECT e.vector AS vector, e.dim AS dim, e.chunk_id AS chunk_id
         FROM graph_nodes n JOIN chunks c ON c.note_path = n.note_path
         JOIN embeddings e ON e.chunk_id = c.id
         WHERE n.id = ? LIMIT 1;`,
        [recentClaimIds[0]],
      );
      if (probe.length === 0) return [];
      const view = new Float32Array(
        probe[0].vector.buffer,
        probe[0].vector.byteOffset,
        probe[0].dim,
      );
      const hits = vectorIndex.search(view, queryOptions.topK);
      const out: Array<{ id: string; score: number; chunkIds: string[] }> = [];
      for (const hit of hits) {
        const claim = database.query<{ id: string }>(
          `SELECT id FROM graph_nodes WHERE type = 'claim' AND note_path = (
              SELECT note_path FROM chunks WHERE id = ?
           ) LIMIT 1;`,
          [hit.id],
        );
        if (claim.length === 0) continue;
        if (recentClaimIds.includes(claim[0].id)) continue;
        out.push({ id: claim[0].id, score: hit.score, chunkIds: [hit.id] });
      }
      return out;
    },
```

- [ ] **Step 3: Typecheck and run substrate tests**

Run: `bun run typecheck && bun test src/core/agents`
Expected: Green. Existing agent tests use injected fakes for `neighborhood` / `neighbors`, so the real-callback wiring does not change their behaviour.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/bootstrap.ts
git commit -m "$(cat <<'EOF'
feat(daemon): wire Linker + ContradictionHunter to live HNSW queries

The Phase B bootstrap previously registered both agents with no-op
neighbourhood callbacks because the autonomous loop only lights up
after first awaken. This commit replaces the stubs with the real DB
queries ported verbatim from .nuked/src/main.ts: pick a representative
embedding, search the HNSW index, join hit ids back to chunks /
notes / claims, filter the source row out. Both queries already
covered by the agent tests via injected fakes; no test changes needed.
The autonomous Coordinator can now surface coordinator:proposal events
once awaken populates the index.
EOF
)"
```

---

## Group 7: CLI verbs

Tasks 14-18 are independent. Each writes a single command file. Task 19 stitches them into `cli/index.ts`.

### Task 14: `cli/commands/awaken.ts`

**Files:**
- Create: `/home/akougkas/projects/notient/src/cli/commands/awaken.ts`

- [ ] **Step 1: Write the implementation**

Create `src/cli/commands/awaken.ts`:

```typescript
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export interface AwakenCommandOptions {
  vaultPath: string;
  batch?: number;
  since?: number;
  emitter: Emitter;
}

export async function runAwakenCommand(options: AwakenCommandOptions): Promise<void> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({ socketPath, vaultPath: options.vaultPath });
  const params: Record<string, unknown> = {};
  if (options.batch !== undefined) params.batch = options.batch;
  if (options.since !== undefined) params.since = options.since;
  for await (const frame of client.call("awaken.run", params)) {
    options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
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
git add src/cli/commands/awaken.ts
git commit -m "$(cat <<'EOF'
feat(cli): awaken command

Calls awaken.run over the daemon RPC and forwards every NDJSON frame
to the emitter (ack, indexer:* events, result). Optional --batch and
--since flags surface as RPC params.
EOF
)"
```

---

### Task 15: `cli/commands/reindex.ts`

**Files:**
- Create: `/home/akougkas/projects/notient/src/cli/commands/reindex.ts`

- [ ] **Step 1: Write the implementation**

Create `src/cli/commands/reindex.ts`:

```typescript
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export interface ReindexCommandOptions {
  vaultPath: string;
  pattern: string;
  emitter: Emitter;
}

export async function runReindexCommand(options: ReindexCommandOptions): Promise<void> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({ socketPath, vaultPath: options.vaultPath });
  for await (const frame of client.call("reindex.glob", { pattern: options.pattern })) {
    options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
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
git add src/cli/commands/reindex.ts
git commit -m "$(cat <<'EOF'
feat(cli): reindex command

Calls reindex.glob over the daemon RPC for paths matching the
caller-provided glob. Same skip-unchanged semantics as awaken because
indexNote already short-circuits when the SHA matches.
EOF
)"
```

---

### Task 16: `cli/commands/search.ts`

**Files:**
- Create: `/home/akougkas/projects/notient/src/cli/commands/search.ts`

- [ ] **Step 1: Write the implementation**

Create `src/cli/commands/search.ts`:

```typescript
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export interface SearchCommandOptions {
  vaultPath: string;
  query: string;
  mode: "quick" | "balanced" | "deep";
  limit?: number;
  emitter: Emitter;
}

export async function runSearchCommand(options: SearchCommandOptions): Promise<void> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({ socketPath, vaultPath: options.vaultPath });
  const params: Record<string, unknown> = {
    query: options.query,
    mode: options.mode,
  };
  if (options.limit !== undefined) params.limit = options.limit;
  for await (const frame of client.call("search.run", params)) {
    options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
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
git add src/cli/commands/search.ts
git commit -m "$(cat <<'EOF'
feat(cli): search command

Calls search.run over the daemon RPC and forwards every search:* event
to the emitter. Default mode is balanced; quick fails with BRIDGE_DOWN
when Obsidian is not running (handler enforces this; the CLI just
forwards the error).
EOF
)"
```

---

### Task 17: `cli/commands/vitals.ts`

**Files:**
- Create: `/home/akougkas/projects/notient/src/cli/commands/vitals.ts`

- [ ] **Step 1: Write the implementation**

Create `src/cli/commands/vitals.ts`:

```typescript
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export interface VitalsCommandOptions {
  vaultPath: string;
  notePath: string;
  emitter: Emitter;
}

export async function runVitalsCommand(options: VitalsCommandOptions): Promise<void> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({ socketPath, vaultPath: options.vaultPath });
  for await (const frame of client.call("vitals.get", { path: options.notePath })) {
    options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
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
git add src/cli/commands/vitals.ts
git commit -m "$(cat <<'EOF'
feat(cli): vitals command

Calls vitals.get over the daemon RPC for a single note path.
The handler emits a vitals:snapshot event before the result; both
flow to the emitter.
EOF
)"
```

---

### Task 18: `cli/commands/health.ts`

**Files:**
- Create: `/home/akougkas/projects/notient/src/cli/commands/health.ts`

- [ ] **Step 1: Write the implementation**

Create `src/cli/commands/health.ts`:

```typescript
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export interface HealthCommandOptions {
  vaultPath: string;
  emitter: Emitter;
}

export async function runHealthCommand(options: HealthCommandOptions): Promise<void> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({ socketPath, vaultPath: options.vaultPath });
  for await (const frame of client.call("health.probe", {})) {
    options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
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
git add src/cli/commands/health.ts
git commit -m "$(cat <<'EOF'
feat(cli): health command

Calls health.probe over the daemon RPC. The result combines
HealthMonitor probes (primary, deep, embedding) with the live bridge
state from ObsidianProbe.
EOF
)"
```

---

### Task 19: `cli/index.ts` extends the dispatch table

**Files:**
- Modify: `/home/akougkas/projects/notient/src/cli/index.ts`

The existing `dispatch()` already handles `init`, `daemon`, and `help`. Add five new branches.

- [ ] **Step 1: Edit the dispatch function**

In `src/cli/index.ts`, replace the `dispatch()` function with:

```typescript
async function dispatch(parsed: ParsedArgs, emitter: Emitter): Promise<number> {
  if (!parsed.command || parsed.command === "help" || parsed.flags.help) {
    emitter.emit({
      type: "help",
      commands: ["init", "daemon", "awaken", "reindex", "search", "vitals", "health"],
      note: "Phase B surface; richer surface lands in Phases C-E.",
    });
    return 0;
  }

  if (parsed.command === "init") {
    const vaultPathArg = parsed.positional[0];
    if (!vaultPathArg) throw new Error("init requires a vault path argument");
    const sqlWasmSource = await resolveSqlWasmSource();
    await runInit({ vaultPathArg, cwd: process.cwd(), emitter, sqlWasmSource });
    return 0;
  }

  if (parsed.command === "daemon") {
    const verb = parsed.positional[0] as "start" | "stop" | "status" | "list" | undefined;
    if (!verb) throw new Error("daemon requires a verb: start | stop | status | list");
    const vaultPath = await resolveVaultForDaemon(parsed);
    await runDaemonCommand({ verb, vaultPath, emitter });
    return 0;
  }

  if (parsed.command === "awaken") {
    const vaultPath = await requireVault(parsed);
    const batch = typeof parsed.flags.batch === "string" ? Number(parsed.flags.batch) : undefined;
    const since = typeof parsed.flags.since === "string" ? Date.parse(parsed.flags.since) : undefined;
    await runAwakenCommand({ vaultPath, batch, since, emitter });
    return 0;
  }

  if (parsed.command === "reindex") {
    const vaultPath = await requireVault(parsed);
    const pattern = parsed.positional[0] ?? "**/*.md";
    await runReindexCommand({ vaultPath, pattern, emitter });
    return 0;
  }

  if (parsed.command === "search") {
    const vaultPath = await requireVault(parsed);
    const query = parsed.positional[0] ?? (typeof parsed.flags.query === "string" ? parsed.flags.query : "");
    if (!query) throw new Error("search requires a query positional or --query flag");
    const mode = (parsed.flags.mode as "quick" | "balanced" | "deep") ?? "balanced";
    const limit = typeof parsed.flags.limit === "string" ? Number(parsed.flags.limit) : undefined;
    await runSearchCommand({ vaultPath, query, mode, limit, emitter });
    return 0;
  }

  if (parsed.command === "vitals") {
    const vaultPath = await requireVault(parsed);
    const notePath = parsed.positional[0];
    if (!notePath) throw new Error("vitals requires a note path positional");
    await runVitalsCommand({ vaultPath, notePath, emitter });
    return 0;
  }

  if (parsed.command === "health") {
    const vaultPath = await requireVault(parsed);
    await runHealthCommand({ vaultPath, emitter });
    return 0;
  }

  emitter.emit({
    type: "error",
    code: "INVALID_PARAMS",
    message: `Unknown command: ${parsed.command}`,
  });
  return 2;
}

async function requireVault(parsed: ParsedArgs): Promise<string> {
  const vaultPath = await resolveVaultForDaemon(parsed);
  if (!vaultPath) {
    throw new Error("No vault. Pass --vault, set NOTIENT_VAULT, or run 'notient init <path>' first.");
  }
  return vaultPath;
}
```

Add the new imports at the top:

```typescript
import { runAwakenCommand } from "./commands/awaken";
import { runHealthCommand } from "./commands/health";
import { runReindexCommand } from "./commands/reindex";
import { runSearchCommand } from "./commands/search";
import { runVitalsCommand } from "./commands/vitals";
```

- [ ] **Step 2: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: Green. If `dispatch()` complexity exceeds 15 again, extract per-command branches into helpers (mirror what Phase A did with `selectMode`/`dispatch`).

- [ ] **Step 3: Live smoke**

Run: `bun run src/cli/index.ts help --json`
Expected: A single JSON line listing all seven commands. Exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts
git commit -m "$(cat <<'EOF'
feat(cli): dispatch awaken | reindex | search | vitals | health

Phase B surface lands. requireVault() centralizes the
flag>env>cwd>state>fail resolution path so every Phase B verb fails
with a single clear message when no vault is reachable. Help command
now lists all seven verbs.
EOF
)"
```

---

## Group 8: Smoke + gate

### Task 20: `scripts/smoke-cli-phaseB.ts`

**Files:**
- Create: `/home/akougkas/projects/notient/scripts/smoke-cli-phaseB.ts`

The harness reuses the fixture vault. It runs `init`, then `awaken`, then `search "TDD" --mode balanced`, then `vitals notes/Vault as kernel.md`, then `health`. Asserts indexer events fired, search returned ≥1 hit, vitals returned a snapshot, health is green for every endpoint.

This is the first smoke that hits LM Studio. Budget 90s for cold start.

- [ ] **Step 1: Write the harness**

Create `scripts/smoke-cli-phaseB.ts`:

```typescript
import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEmitter } from "../src/cli/output";

const emitter = makeEmitter({ mode: "ndjson" });
const SMOKE_TIMEOUT_MS = 120_000;

async function main(): Promise<void> {
  const fixtureRoot = join(process.cwd(), "tests", "fixtures", "sentient-vault");
  const tmpRoot = await mkdtemp(join(tmpdir(), "notient-smoke-B-"));
  try {
    await cp(fixtureRoot, tmpRoot, { recursive: true });
    emitter.emit({ type: "smoke:setup", tmpRoot });

    await runOneShot(["init", tmpRoot]);
    emitter.emit({ type: "smoke:init_done" });

    const awakenFrames = await runOneShotCollect(["awaken", "--vault", tmpRoot]);
    assertAwakenFrames(awakenFrames);
    emitter.emit({ type: "smoke:awaken_validated" });

    const searchFrames = await runOneShotCollect([
      "search",
      "TDD",
      "--vault",
      tmpRoot,
      "--mode",
      "balanced",
    ]);
    assertSearchFrames(searchFrames);
    emitter.emit({ type: "smoke:search_validated" });

    const vitalsFrames = await runOneShotCollect([
      "vitals",
      "notes/Vault as kernel.md",
      "--vault",
      tmpRoot,
    ]);
    assertVitalsFrames(vitalsFrames);
    emitter.emit({ type: "smoke:vitals_validated" });

    const healthFrames = await runOneShotCollect(["health", "--vault", tmpRoot]);
    assertHealthFrames(healthFrames);
    emitter.emit({ type: "smoke:health_validated" });

    await runOneShot(["daemon", "stop", "--vault", tmpRoot]);
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
    emitter.emit({
      type: "smoke:error",
      argv,
      exitCode: captured.exitCode,
      stderr: captured.stderr.join("\n"),
    });
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
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`smoke timeout after ${SMOKE_TIMEOUT_MS}ms running ${argv.join(" ")}`));
    }, SMOKE_TIMEOUT_MS);
    child.stdout.on("data", (data: Buffer) => {
      stdoutBuffer.push(data.toString("utf-8"));
    });
    child.stderr.on("data", (data: Buffer) => {
      stderrBuffer.push(data.toString("utf-8"));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode: exitCode ?? -1,
        stdout: stdoutBuffer.join("").split("\n").filter(Boolean),
        stderr: stderrBuffer.join("").split("\n").filter(Boolean),
      });
    });
  });
}

function parseLines(frames: CapturedFrames): Record<string, unknown>[] {
  return frames.stdout.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assertAwakenFrames(frames: CapturedFrames): void {
  if (frames.exitCode !== 0) throw new Error(`awaken exit ${frames.exitCode}: ${frames.stderr.join(" ")}`);
  const events = parseLines(frames);
  const ack = events.find((event) => event.type === "rpc:ack");
  const result = events.find((event) => event.type === "rpc:result");
  if (!ack || !result) throw new Error("awaken missing ack/result");
  if (typeof result.queued !== "number" || result.queued < 5) {
    throw new Error(`awaken queued ${result.queued}; expected at least 5`);
  }
  const indexedEvents = events.filter((event) => event.event === "indexer:note_indexed");
  if (indexedEvents.length === 0) throw new Error("no indexer:note_indexed events");
}

function assertSearchFrames(frames: CapturedFrames): void {
  if (frames.exitCode !== 0) throw new Error(`search exit ${frames.exitCode}: ${frames.stderr.join(" ")}`);
  const events = parseLines(frames);
  const result = events.find((event) => event.type === "rpc:result");
  if (!result) throw new Error("search missing result");
  const searchResult = result.result as { hits?: { path: string }[] } | null;
  if (!searchResult || !searchResult.hits || searchResult.hits.length === 0) {
    throw new Error(`search returned no hits: ${JSON.stringify(searchResult)}`);
  }
}

function assertVitalsFrames(frames: CapturedFrames): void {
  if (frames.exitCode !== 0) throw new Error(`vitals exit ${frames.exitCode}: ${frames.stderr.join(" ")}`);
  const events = parseLines(frames);
  const snapshot = events.find((event) => event.event === "vitals:snapshot");
  if (!snapshot) throw new Error("missing vitals:snapshot event");
}

function assertHealthFrames(frames: CapturedFrames): void {
  if (frames.exitCode !== 0) throw new Error(`health exit ${frames.exitCode}: ${frames.stderr.join(" ")}`);
  const events = parseLines(frames);
  const tick = events.find((event) => event.event === "health:tick");
  if (!tick) throw new Error("missing health:tick event");
}

void main().catch((error) => {
  emitter.emit({
    type: "smoke:fatal",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
```

Update `package.json` `scripts`:

```json
"smoke:cli:phaseB": "bun scripts/smoke-cli-phaseB.ts"
```

- [ ] **Step 2: Typecheck the script**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 3: Run the smoke harness**

Confirm LM Studio is reachable: `curl -s http://192.168.86.143:1234/v1/models | head -20`
Then run: `bun run smoke:cli:phaseB`

Expected output (in order, NDJSON): `smoke:setup → smoke:init_done → smoke:awaken_validated → smoke:search_validated → smoke:vitals_validated → smoke:health_validated → smoke:complete`. Exit 0.

If awaken times out, check the embedding model is loaded in LM Studio. If search returns 0 hits, awaken probably failed silently — inspect the captured awaken frames in the smoke output. **Do not commit until the harness is green.**

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-cli-phaseB.ts package.json
git commit -m "$(cat <<'EOF'
test(smoke): Phase B end-to-end harness

Spawns init, awaken, search "TDD" --mode balanced, vitals on a
fixture note, then health. Asserts indexer:note_indexed events
fire, search returns at least one hit, vitals emits a snapshot, and
health emits a tick. Hits the live LM Studio at the locked substrate
URL; budget 120s per command for the first cold-start awaken.
package.json gains smoke:cli:phaseB.
EOF
)"
```

---

### Task 21: Phase B gate run

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 2: Lint**

Run: `bun run lint`
Expected: Green.

- [ ] **Step 3: Test**

Run: `bun test`
Expected: Green. Substrate tests pass; the Phase A daemon tests pass; the new bridge, handler, watcher, and runner tests pass.

- [ ] **Step 4: Build the CLI**

Run: `bun run build:cli`
Expected: `dist/notient.js` and `dist/sql-wasm.wasm` exist.

- [ ] **Step 5: Phase A smoke (regression)**

Run: `bun run smoke:cli:phaseA`
Expected: Exit 0, ends with `smoke:complete`.

- [ ] **Step 6: Phase B smoke**

Run: `bun run smoke:cli:phaseB`
Expected: Exit 0, ends with `smoke:complete`.

- [ ] **Step 7: Live invocation against vaultex (Phase B parity check)**

```bash
# Daemon should already be running against vaultex from the end of Phase A; restart it so the Phase B kernel registrations take effect:
bun run src/cli/index.ts daemon stop --vault /mnt/c/Users/akougk/Projects/vaultex --ndjson
bun run src/cli/index.ts daemon start --vault /mnt/c/Users/akougk/Projects/vaultex --ndjson
sleep 2

# First-time awaken on the real vault. Cold start may take several minutes; tail progress:
bun run src/cli/index.ts awaken --vault /mnt/c/Users/akougk/Projects/vaultex --ndjson | tail -20

# Search a real note from the user's vault:
bun run src/cli/index.ts search "your topic here" --vault /mnt/c/Users/akougk/Projects/vaultex --mode balanced --ndjson | tail -10

# Vitals on a real note:
bun run src/cli/index.ts vitals "Notes/Some Real Note.md" --vault /mnt/c/Users/akougk/Projects/vaultex --ndjson

# Health probe:
bun run src/cli/index.ts health --vault /mnt/c/Users/akougk/Projects/vaultex --pretty
```

Expected: each command exits 0. Awaken streams `indexer:note_indexed` events. Search returns hits. Vitals returns a snapshot. Health shows primary/deep/embedding all true and bridge true if Obsidian is open against vaultex, false otherwise.

- [ ] **Step 8: Phase B done check**

Phase B is done **only when** the gate is fully green AND the live invocation in Step 7 succeeds against vaultex. Anything less means another iteration.

- [ ] **Step 9: No commit needed**

Task 21 is verification only.

---

## Self-review (run before declaring the plan ready)

**Spec coverage (Phase B deliverables 1-10):**
- (1) `notient awaken [--batch] [--since]` — Tasks 5 + 14.
- (2) `notient reindex <glob>` — Tasks 5 + 15.
- (3) `notient search query="..." [mode] [filters]` — Tasks 6 + 16.
- (4) `notient vitals <path>` — Tasks 7 + 17.
- (5) `notient health` (substrate + bridge) — Tasks 8 + 18.
- (6) `src/bridge/obsidianProbe.ts` — Task 1.
- (7) `src/bridge/obsidianCli.ts` — Task 2.
- (8) Daemon chokidar watcher with WSL polling fallback — Task 10.
- (9) Coordinator runs autonomously inside the daemon — Tasks 12 + 13. Locked decision (1): triggered after first awaken.
- (10) `smoke:cli:phaseB` integration test — Task 20.

**Placeholder scan:** No stubs left after Task 13.5. Linker and ContradictionHunter receive real DB-backed neighborhood callbacks ported from the archived `main.ts`; Synthesizer and MaturityAdvancer take their dependencies inline; vector persistence is owned end-to-end by `bootstrap.ts`'s `makeClose`. Every concrete service the kernel registers does real work.

**Type consistency:** Every handler factory returns the `MethodHandler` type from `src/daemon/rpc.ts` (params, emit, envelopeId → Promise<Record<string, unknown>>). Every CLI verb uses the same `connectClient` + iterator pattern as the Phase A daemon verbs. The `frame.type === "result" || frame.type === "error"` break condition matches Phase A.

**Locked-decision compliance:**
- (1) Coordinator gated on first awaken: Tasks 12 + 13.
- (2) reindex skips unchanged via existing indexNote SHA short-circuit: Task 15 explicitly mentions this; no force flag.
- (3) BRIDGE_DOWN on quick mode w/o bridge: Task 6.
- (4) Live LM Studio in smoke: Task 20.
- (5) `ignoreInitial: true` in chokidar: Task 10.

---

## Phase B gate

```
bun run typecheck && bun run lint && bun test && bun run build:cli && bun run smoke:cli:phaseA && bun run smoke:cli:phaseB
```

**No Phase B claim of done is valid without the gate green AND a live end-to-end CLI invocation against `vaultex` (Task 21 step 7) that exercises awaken, search, vitals, and health.**

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-27-cli-phase-b.md`. Two execution options:

1. **Inline Execution (recommended)** — execute tasks in this session using executing-plans, batch execution with checkpoints. Mirrors Phase A's flow.
2. **Subagent-Driven** — fresh subagent per task. Tasks 5/6/7/8 dispatch in parallel; Tasks 14/15/16/17/18 dispatch in parallel.

Either way, the gate at Task 21 plus the live vaultex invocation is non-negotiable.
