# Notient v0.1 Phase D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the eight Phase C caveats and complete the chat surface so a human or another agent can resolve write approvals over the wire (`/approve`, `/deny`), undo the last write (`/undo`), inspect write history (`/history`), tab-complete `@<path>` mentions, read notes through the live `/read` verb, dispatch on-demand subagents through the orchestrator, and run conversations whose context budget tracks settings rather than a hardcoded constant.

**Architecture:** Phase C promoted the kernel to its chat slice (ChatService, ApprovalGate, ToolRegistry) and shipped a TUI bound to the substrate. Phase D layers two new substrate services onto that slice — `HistoryStore` for write/undo bookkeeping and `SubagentRegistry` for on-demand dispatch — extends three existing services (ContextManager emits a summarization event, toolModeProbe retries with temperature variance, ApprovalGate threads its policy through write-tool reversals), adds two RPC handlers (`vault.list`, `notes.history`), and rounds out the TUI with the missing slash verbs plus tab-driven `@`-completion. The tier-2 identity layer lands as constants in `src/agent/agentIdentity.ts` so the orchestrator can compose subagent prompts on dispatch.

**Tech Stack:** Bun runtime, TypeScript strict, NDJSON over Unix socket / Windows named pipe (Phase A transport unchanged), `@opentui/core@0.1.105` + `@opentui/react@0.1.105`, `@lmstudio/sdk` providers (locked substrate at `192.168.86.143:1234`). No new deps.

**Source of truth:**
- `docs/superpowers/handoffs/2026-04-28-phase-c-debug-and-phase-d-plan.md` — Phase D scope brief (Part 2).
- `docs/superpowers/specs/2026-04-27-notient-cli-design.md` — Section 6 Phase D deliverables (subset; this plan narrows that surface to the eight handoff items and defers `notient stream`, `notient export-canvas`, and `notient propose` to Phase E).
- `docs/superpowers/plans/2026-04-27-cli-phase-c.md` — locked decisions Phase D inherits.

**Locked decisions (Phase D, 2026-04-28):**

1. **Approval verbs are TUI-only and route to the existing `chat.approve` RPC.** `/approve <callId> [reason]` calls `chat.approve` with `approved: true`; `/deny <callId> [reason]` with `approved: false`. No new RPC. The TUI tracks pending approvals client-side from `loop:approval_pending` frames and clears them on `loop:approval_resolved`. `/help` lists both verbs.

2. **HistoryStore is a vault-native JSON sidecar at `<vault>/Notient/.history.json`.** Each entry is `{ id: string; callId: string; tool: string; args: Record<string, unknown>; reversal: ReversalSpec; decidedAt: number; status: "applied" | "reversed" }`. The store keeps the most recent 100 entries; older entries truncate from the head on every record. Atomic write through the existing `atomicWrite` helper.

3. **Per-tool reversal is captured at request time and applied through the same tool registry.** Reversal kinds: `notes.create` → `{ kind: "delete-note", path }`; `notes.append` → `{ kind: "truncate-note", path, priorLength }`; `notes.replace_section` → `{ kind: "restore-section", path, heading, priorBody }`; `notes.update_frontmatter` → `{ kind: "restore-frontmatter", path, priorYaml }`. The store reads the pre-write state synchronously inside the tool implementation before the write fires; failure to read pre-state aborts the tool.

4. **`/undo` is a TUI verb backed by a new `notes.undo` RPC.** The handler pops the latest `applied` entry from `HistoryStore`, dispatches the matching reversal through `notes.*` tools (bypassing the approval gate because the user has explicitly invoked undo), records the entry's status as `reversed`, and returns the reversed entry's id and tool name. `/undo` with an empty history surfaces `HISTORY_EMPTY`.

5. **`/history` is a TUI verb backed by `notes.history` RPC.** Returns up to the last 10 entries newest-first as `{ id, tool, path, decidedAt, status }`. The TUI renders one line per entry: `<status> <tool> <path> <ISO timestamp>`.

6. **`vault.list` RPC enumerates vault paths.** Parameters: `{ prefix?: string; limit?: number }` (defaults: `prefix: ""`, `limit: 200`). Returns `{ paths: string[] }` sorted lexicographically and capped at `min(limit, 200)`. Backed by the existing `vault.list(folder)` facade with a recursive walk; ignores `<vault>/.notient/`, `<vault>/Notient/conversations/`, and `<vault>/Notient/proposals/` so attachments never reach the chat agent's own state.

7. **`@`-completion in the TUI is tab-driven, not a popup.** When the input bar contains an `@`-prefixed token at the cursor and the user presses Tab, the TUI calls `vault.list` with the trailing characters as the prefix, replaces the partial with the first match, and emits a system line listing the next four matches. No autocomplete dropdown in Phase D.

8. **`/read <path>` reads the note through the existing `vault.read_note` substrate tool.** Replaces the current `/read` stub that aliased `/vitals`. The TUI renders the body in a fenced code block, truncated to 5KB with a `[...elided...]` marker when the file is larger.

9. **Tier 2 identity lives in `src/agent/agentIdentity.ts` and is composed at subagent dispatch time.** Exports `composeAgentIdentity(role: SubagentRole, base?: string): string`. Phase D ships one role: `"NoteEditor"`, with a verbatim prompt block focused on Obsidian-native I/O. `"ContextBuilder"` and `"Worker"` constants are defined as placeholders for Phase E; dispatching them returns `SUBAGENT_UNAVAILABLE` until Phase E ships their bodies.

10. **Subagent on-demand surface ships dispatch only.** `subagent.dispatch` starts a frozen subagent loop with `{ role, goal, toolWhitelist }`; the subagent runs to completion or aborts with `SUBAGENT_FAILED`. Mid-loop approval pauses are deferred to Phase E (`subagent.continue`); write-style tools the subagent reaches inside its loop auto-deny in Phase D so the loop terminates promptly. The orchestrator (chat agent) sees the subagent's final result as a tool result on its own `subagent.dispatch` tool call.

11. **Hardened tool-mode probe retries once with elevated temperature.** `probeToolMode` keeps its current first attempt at `temperature: 0.3`. When the model returns no tool calls in the first attempt, the probe retries once at `temperature: 0.7`. If the second attempt also returns no tool calls, the cache writes `"disabled"` and the probe emits a `loop:tool_mode_disabled` event with a settings hint pointing to `chat.toolModeByModel`. Probe failure is non-fatal; the chat turn proceeds in JSON-fallback mode if the cache says `disabled`.

12. **`chat.modelContextTokens` becomes a setting, defaulting to `200_000`.** Bootstrap stops hardcoding `32_000` in `daemon/bootstrap.ts`; ContextManager reads `settings.chat.modelContextTokens` at compose time. When `budgetedHistory` triggers summarization, ContextManager publishes a `loop:context_summarized` event on the EventBus with `{ originalTokens, summarizedTokens, model, conversationId }`. The chat handler forwards this on the wire as `loop:context_summarized` so the TUI can render an info line.

13. **Phase D kernel.** `PHASE_D_KEYS = PHASE_C_KEYS ∪ ["historyStore", "subagentRegistry"]`. `seal({ phase: "D" })` becomes the new daemon default. `historyStore` is required; `subagentRegistry` is required (with one role registered).

14. **Phase D smoke harness scope.** `smoke:cli:phaseD` runs five passes against the fixture vault and live LM Studio: (a) write tool with auto-approval policy fires, history records, `/undo` reverses it; (b) `vault.list` returns sorted paths under a known fixture prefix; (c) `chat.send` whose history triggers summarization emits `loop:context_summarized`; (d) tool-mode probe writes `native` for the locked model after retry; (e) `subagent.dispatch` of `NoteEditor` returns a final result tool message. The TUI is verified by an extended manual checklist (`docs/superpowers/plans/2026-04-28-cli-phase-d-checklist.md`).

---

## Hard rules (carry forward from Phase C; one Phase D addition)

- TypeScript strict. No `any` without justification.
- No `console.log` outside `src/cli/output.ts` and the existing `debug<Subsystem>` helpers.
- No abbreviations: `context` not `ctx`, `error` not `err`, `message` not `msg`, `event` not `evt`, `index` not `idx`, `options` not `opts`.
- No `[noun] - [parenthetical clause]` dash-clause prose anywhere.
- No emojis in source.
- One commit per logical step on `beta-spec`. No `git add -A`. Stage by name only.
- Substrate tests stay green throughout. New tests are additive.
- The chat handler remains the only place where internal kebab-case loop event names get rewritten to spec wire names.
- **(Phase D addition)** Reversal capture happens *before* the write fires. A write tool that cannot read its pre-state must abort with `REVERSAL_CAPTURE_FAILED` and never touch the vault.

---

## Risks (from spec section 9 and Phase C debug pass)

| Risk | Tasks affected | Mitigation in this plan |
|---|---|---|
| HistoryStore retention vs disk growth | Tasks 5, 6, 7 | Hard cap at 100 entries; head-truncation on every record. JSON sidecar bytes stay under ~50KB. Test verifies eviction order. |
| Reversal applied to a file the user manually edited since the original write | Tasks 6, 7, 12 | Each reversal verifies `priorBody` matches the head/section it intends to restore; mismatch surfaces `REVERSAL_STALE` on the wire and the entry stays `applied` in the store so the user can intervene. |
| `vault.list` walks unbounded directory trees on large vaults | Task 9 | Recursive walk caps at 200 paths and short-circuits when the cap is reached; folder filter excludes `<vault>/.notient`, `<vault>/Notient/conversations`, `<vault>/Notient/proposals`. Test runs against the fixture vault (~10 notes). |
| `@`-completion clashes with email-like literals (`user@example.com`) | Task 16 | Tab handler triggers only when the `@`-prefixed token is at the cursor end and contains no `.` characters before the first slash. Test covers email-style false positive. |
| Tool-mode probe second attempt costs an extra LLM round | Task 13 | Retry only fires when first attempt returns zero tool calls AND no error; second attempt's higher temperature surfaces tool calls when low-temp greedy decoding skipped them. |
| Subagent dispatch interferes with the orchestrator's mutex slot | Task 19 | Subagent runs under a separate `mutex.runPriority("subagent", ...)` slot below the orchestrator's chat slot; the orchestrator's chat turn returns the subagent's result without re-entering its own mutex. |
| Subagent goal injection through user prompts | Task 19 | The orchestrator's `subagent.dispatch` tool spec validates `role` against the registered names and rejects unknown roles before forwarding; user-supplied `goal` strings are sandboxed inside the subagent's prompt and cannot escape into the orchestrator's identity. |
| `loop:context_summarized` event leak across turns | Task 14 | Event carries `conversationId` so the chat handler scopes the wire emission to the active envelope. Test asserts no leak across two parallel chat conversations. |
| Tier 2 identity drift (Phase E adds Worker, ContextBuilder) | Task 17 | `composeAgentIdentity` returns `SUBAGENT_UNAVAILABLE` for unimplemented roles; no silent fallback to Tier 1 only. Phase E test gates that flip. |

---

## File structure (Phase D landing state)

```
src/
├── agent/
│   ├── agentIdentity.ts                    # NEW — Tier 2 prompts + composeAgentIdentity
│   ├── agentIdentity.test.ts               # NEW
│   ├── subagentRegistry.ts                 # NEW — dispatch/run table for on-demand subagents
│   └── subagentRegistry.test.ts            # NEW
├── core/
│   ├── kernel.ts                           # MODIFIED — adds PHASE_D_KEYS
│   ├── chat/
│   │   ├── contextManager.ts               # MODIFIED — read modelContextTokens from settings; emit loop:context_summarized
│   │   ├── contextManager.test.ts          # MODIFIED — assert event fires when budget exceeded
│   │   ├── toolModeProbe.ts                # MODIFIED — 2-attempt retry with temperature variance
│   │   ├── toolModeProbe.test.ts           # MODIFIED — assert second attempt fires on first-attempt zero-tool-call
│   │   └── tools/
│   │       └── notes.ts                    # MODIFIED — capture pre-state reversal before write
│   ├── history/                            # NEW directory
│   │   ├── historyStore.ts                 # NEW — record/list/markReversed; 100-entry cap
│   │   ├── historyStore.test.ts            # NEW
│   │   ├── reversals.ts                    # NEW — typed reversal specs + applyReversal()
│   │   └── reversals.test.ts               # NEW
│   └── settings/
│       └── types.ts                        # MODIFIED — chat.modelContextTokens; chat.history retention
├── daemon/
│   ├── bootstrap.ts                        # MODIFIED — register historyStore + subagentRegistry; seal "D"
│   ├── handlers/
│   │   ├── vault.ts                        # NEW — vault.list
│   │   ├── vault.test.ts                   # NEW
│   │   ├── notes.ts                        # NEW — notes.history, notes.undo
│   │   ├── notes.test.ts                   # NEW
│   │   ├── chat.ts                         # MODIFIED — forward loop:context_summarized
│   │   └── subagent.ts                     # NEW — subagent.dispatch
│   └── index.ts                            # MODIFIED — register vault, notes, subagent handlers
└── cli/
    ├── tui/
    │   ├── runtime.tsx                     # MODIFIED — pendingApprovals state; tab handler
    │   ├── slashCommands.ts                # MODIFIED — /approve, /deny, /undo, /history; real /read
    │   ├── slashCommands.test.ts           # MODIFIED — new verb tests
    │   └── attachments.ts                  # MODIFIED — vault.list-driven completion shim

scripts/
└── smoke-cli-phaseD.ts                     # NEW — Phase D gate harness

docs/superpowers/plans/
└── 2026-04-28-cli-phase-d-checklist.md     # NEW — manual TUI verification (Phase D additions)
```

---

## Task DAG

```
Group 1: Settings + kernel additions (sequential)
  Task 1: settings/types.ts adds chat.modelContextTokens + chat.history retention
  Task 2: core/kernel.ts adds PHASE_D_KEYS

Group 2: HistoryStore substrate (sequential, single file group)
  Task 3: core/history/reversals.ts + test
  Task 4: core/history/historyStore.ts + test
  Task 5: core/chat/tools/notes.ts captures reversal pre-state for each write tool

Group 3: ContextManager hardening (parallel-safe with Group 2)
  Task 6: contextManager.ts reads modelContextTokens; emits loop:context_summarized
  Task 7: toolModeProbe.ts 2-attempt retry

Group 4: Agent + subagent layer (sequential within group; agentIdentity first)
  Task 8: src/agent/agentIdentity.ts (Tier 2 prompts) + test
  Task 9: src/agent/subagentRegistry.ts + test

Group 5: Daemon handlers (sequential, single file edits)
  Task 10: daemon/handlers/vault.ts + test (vault.list)
  Task 11: daemon/handlers/notes.ts + test (notes.history, notes.undo)
  Task 12: daemon/handlers/subagent.ts + test (subagent.dispatch)
  Task 13: daemon/handlers/chat.ts forwards loop:context_summarized
  Task 14: daemon/index.ts registers new handlers

Group 6: Bootstrap promotion (sequential, single file)
  Task 15: daemon/bootstrap.ts wires historyStore + subagentRegistry + seal "D"

Group 7: TUI verbs + completion (parallel-safe)
  Task 16: cli/tui/slashCommands.ts /approve, /deny, /undo, /history; real /read
  Task 17: cli/tui/runtime.tsx pendingApprovals; tab handler
  Task 18: cli/tui/attachments.ts vault.list completion

Group 8: Smoke + gate (sequential, last)
  Task 19: scripts/smoke-cli-phaseD.ts + manual checklist file
  Task 20: Phase D gate run against the fixture vault + the live vaultex
```

**Parallelism rules.** Group 2 (HistoryStore) and Group 3 (ContextManager hardening) touch disjoint files and can dispatch in parallel after Group 1. Group 4 sequences Task 8 before Task 9 because the registry imports `composeAgentIdentity`. Group 5 serializes per-file: each handler is a single new file. Tasks 16, 17, 18 each edit a single TUI file and can dispatch in parallel after Group 6.

---

## Group 1: Settings + kernel additions

### Task 1: `settings/types.ts` adds `chat.modelContextTokens` + `chat.history`

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/settings/types.ts`

The chat block already carries `approvalMode`, `toolModeByModel`, `perTool`, optional `vision`. Phase D adds the model context budget setter and a small history retention block. Both default to safe values.

- [ ] **Step 1: Locate the chat sub-object**

Run: `grep -n "perTool\|toolModeByModel\|chat:" src/core/settings/types.ts`
Expected: hits at the chat sub-object.

- [ ] **Step 2: Edit the chat sub-object**

In `src/core/settings/types.ts`, after `perTool: Record<string, "auto" | "ask">;`, insert:

```typescript
    /**
     * Model context window in tokens. ContextManager budgets this fraction
     * (chat.contextBudgetFraction) before triggering history summarization.
     * Defaults to 200_000 for Nemotron-Cascade-2-30B; raise for 1M-context
     * models or lower for smaller ones.
     */
    modelContextTokens: number;
    history: {
      /** Maximum HistoryStore entries; head-truncates older ones on record. */
      maxEntries: number;
    };
```

In the same file's `DEFAULT_SETTINGS`, add inside the chat block:

```typescript
    modelContextTokens: 200_000,
    history: { maxEntries: 100 },
```

- [ ] **Step 3: Typecheck and run settings tests**

Run: `bun run typecheck && bun test src/core/settings`
Expected: Green. Existing consumers only read chat fields they already use; new fields are additive.

- [ ] **Step 4: Commit**

```bash
git add src/core/settings/types.ts
git commit -m "$(cat <<'EOF'
feat(settings): chat.modelContextTokens + chat.history retention

Phase D pulls the model context window out of bootstrap.ts (which
hardcoded 32_000) into NotientSettings so larger models like
Nemotron-Cascade-2-30B can use their real budget. chat.history.maxEntries
caps the HistoryStore's vault-side JSON sidecar at 100 records to
keep undo bookkeeping under ~50KB on disk.
EOF
)"
```

---

### Task 2: `core/kernel.ts` adds `PHASE_D_KEYS`

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/kernel.ts`

Phase C added `PHASE_C_KEYS`. Phase D adds the history slice plus the subagent registry. Both are required.

- [ ] **Step 1: Add `PHASE_D_KEYS` after `PHASE_C_KEYS`**

In `src/core/kernel.ts`, after the existing `PHASE_C_KEYS`, add:

```typescript
const PHASE_D_KEYS: ServiceKey[] = [
  ...PHASE_C_KEYS,
  "historyStore",
  "subagentRegistry",
];
```

Add to the `ServiceKey` union if not already present: `| "historyStore" | "subagentRegistry"`.

Update the `seal()` dispatch to recognize phase `"D"`:

```typescript
seal(options: { phase?: "A" | "B" | "C" | "D" } = {}): void {
  let required: ServiceKey[];
  if (options.phase === "A") required = PHASE_A_KEYS;
  else if (options.phase === "B") required = PHASE_B_KEYS;
  else if (options.phase === "C") required = PHASE_C_KEYS;
  else if (options.phase === "D") required = PHASE_D_KEYS;
  else required = REQUIRED_KEYS;
  const missing = required.filter((key) => this.services[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`Kernel.seal(): missing required services: ${missing.join(", ")}`);
  }
  this.sealed = true;
}
```

- [ ] **Step 2: Typecheck + kernel tests**

Run: `bun run typecheck && bun test src/core/kernel.test.ts`
Expected: Green.

- [ ] **Step 3: Commit**

```bash
git add src/core/kernel.ts
git commit -m "$(cat <<'EOF'
refactor(kernel): seal() recognises phase: "D"

PHASE_D_KEYS extends PHASE_C_KEYS with historyStore and
subagentRegistry. Both are required so daemon bootstrap fails fast if
either slot is missing.
EOF
)"
```

---

## Group 2: HistoryStore substrate

### Task 3: `core/history/reversals.ts` defines reversal specs + `applyReversal`

**Files:**
- Create: `/home/akougkas/projects/notient/src/core/history/reversals.ts`
- Create: `/home/akougkas/projects/notient/src/core/history/reversals.test.ts`

The module owns the reversal type union and the dispatcher that turns a reversal spec into a vault write. Each kind reads the file's current state to detect drift before applying the reversal.

- [ ] **Step 1: Write the test**

Create `src/core/history/reversals.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { applyReversal, type ReversalSpec } from "./reversals";

interface FakeFacade {
  files: Map<string, string>;
}

function makeFacade(initial: Record<string, string> = {}): FakeFacade & {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    async read(path) {
      const value = files.get(path);
      if (value === undefined) throw new Error(`not found: ${path}`);
      return value;
    },
    async write(path, content) {
      files.set(path, content);
    },
    async remove(path) {
      files.delete(path);
    },
    async exists(path) {
      return files.has(path);
    },
  };
}

describe("applyReversal", () => {
  test("delete-note removes the file", async () => {
    const facade = makeFacade({ "notes/x.md": "body" });
    const spec: ReversalSpec = { kind: "delete-note", path: "notes/x.md" };
    await applyReversal(spec, facade);
    expect(facade.files.has("notes/x.md")).toBe(false);
  });

  test("truncate-note restores the prior length", async () => {
    const facade = makeFacade({ "notes/x.md": "AAA\nBBB\nCCC" });
    const spec: ReversalSpec = {
      kind: "truncate-note",
      path: "notes/x.md",
      priorLength: 3,
    };
    await applyReversal(spec, facade);
    expect(facade.files.get("notes/x.md")).toBe("AAA");
  });

  test("restore-frontmatter rewrites the YAML block", async () => {
    const facade = makeFacade({
      "notes/x.md": "---\nfoo: 1\nbar: 2\n---\nbody",
    });
    const spec: ReversalSpec = {
      kind: "restore-frontmatter",
      path: "notes/x.md",
      priorYaml: "foo: 9",
    };
    await applyReversal(spec, facade);
    expect(facade.files.get("notes/x.md")).toBe("---\nfoo: 9\n---\nbody");
  });

  test("restore-section restores the body under a heading", async () => {
    const facade = makeFacade({
      "notes/x.md": "## Goals\n\nnew body\n\n## Notes\n\nkeep me",
    });
    const spec: ReversalSpec = {
      kind: "restore-section",
      path: "notes/x.md",
      heading: "Goals",
      priorBody: "old body",
    };
    await applyReversal(spec, facade);
    const body = facade.files.get("notes/x.md") ?? "";
    expect(body).toContain("## Goals\n\nold body");
    expect(body).toContain("## Notes\n\nkeep me");
  });

  test("delete-note throws REVERSAL_STALE when file is missing", async () => {
    const facade = makeFacade({});
    const spec: ReversalSpec = { kind: "delete-note", path: "notes/x.md" };
    await expect(applyReversal(spec, facade)).rejects.toThrow(/REVERSAL_STALE/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/history/reversals.test.ts`
Expected: FAIL — module not yet created.

- [ ] **Step 3: Implement `reversals.ts`**

Create `src/core/history/reversals.ts`:

```typescript
/**
 * Typed reversal specs for chat-write tools and the dispatcher that applies
 * them. Each kind captures the minimum state needed to undo the original
 * write: a path plus prior body bytes for content-mutating tools, just a
 * path for create. The dispatcher reads the current state and refuses to
 * apply when the file has drifted (missing or unexpectedly different) since
 * the original write so the user is not silently overwriting their own work.
 */

export interface ReversalFacade {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export type ReversalSpec =
  | { kind: "delete-note"; path: string }
  | { kind: "truncate-note"; path: string; priorLength: number }
  | { kind: "restore-section"; path: string; heading: string; priorBody: string }
  | { kind: "restore-frontmatter"; path: string; priorYaml: string };

export async function applyReversal(spec: ReversalSpec, facade: ReversalFacade): Promise<void> {
  if (spec.kind === "delete-note") {
    if (!(await facade.exists(spec.path))) {
      throw new Error(`REVERSAL_STALE: ${spec.path} no longer exists`);
    }
    await facade.remove(spec.path);
    return;
  }
  const current = await facade.read(spec.path).catch(() => null);
  if (current === null) {
    throw new Error(`REVERSAL_STALE: ${spec.path} no longer readable`);
  }
  if (spec.kind === "truncate-note") {
    if (current.length < spec.priorLength) {
      throw new Error(`REVERSAL_STALE: ${spec.path} shorter than priorLength`);
    }
    await facade.write(spec.path, current.slice(0, spec.priorLength));
    return;
  }
  if (spec.kind === "restore-frontmatter") {
    const next = replaceFrontmatter(current, spec.priorYaml);
    await facade.write(spec.path, next);
    return;
  }
  if (spec.kind === "restore-section") {
    const next = replaceSection(current, spec.heading, spec.priorBody);
    await facade.write(spec.path, next);
    return;
  }
}

function replaceFrontmatter(body: string, priorYaml: string): string {
  const match = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return `---\n${priorYaml}\n---\n${body}`;
  return `---\n${priorYaml}\n---\n${body.slice(match[0].length)}`;
}

function replaceSection(body: string, heading: string, priorBody: string): string {
  const lines = body.split("\n");
  const headingPattern = new RegExp(`^#{1,6}\\s+${escapeRegex(heading)}\\s*$`);
  const startIndex = lines.findIndex((line) => headingPattern.test(line));
  if (startIndex < 0) {
    throw new Error(`REVERSAL_STALE: heading "${heading}" not found`);
  }
  let endIndex = lines.length;
  for (let cursor = startIndex + 1; cursor < lines.length; cursor++) {
    if (/^#{1,6}\s+/.test(lines[cursor])) {
      endIndex = cursor;
      break;
    }
  }
  const before = lines.slice(0, startIndex + 1);
  const after = lines.slice(endIndex);
  const restored = priorBody.split("\n");
  return [...before, "", ...restored, "", ...after].join("\n").replace(/\n{3,}/g, "\n\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/history/reversals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/history/reversals.ts src/core/history/reversals.test.ts
git commit -m "$(cat <<'EOF'
feat(history): typed reversal specs + drift-aware applyReversal

Phase D undoes chat-driven writes by replaying a captured reversal
spec through the same vault facade the original write touched. Kinds:
delete-note, truncate-note, restore-section, restore-frontmatter. Each
read-checks the current file before applying so the user gets
REVERSAL_STALE instead of a silent overwrite when they manually edited
the file in the meantime.
EOF
)"
```

---

### Task 4: `core/history/historyStore.ts` records + lists + marks reversed

**Files:**
- Create: `/home/akougkas/projects/notient/src/core/history/historyStore.ts`
- Create: `/home/akougkas/projects/notient/src/core/history/historyStore.test.ts`

The store reads/writes a JSON sidecar at `<vault>/Notient/.history.json`. It keeps the most-recent `maxEntries` entries (default 100) and exposes `record`, `list`, `latestApplied`, `markReversed`.

- [ ] **Step 1: Write the test**

Create `src/core/history/historyStore.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { HistoryStore, type HistoryStoreFacade } from "./historyStore";
import type { ReversalSpec } from "./reversals";

class FakeFacade implements HistoryStoreFacade {
  public readonly files = new Map<string, string>();
  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}

function makeStore(maxEntries = 100): { store: HistoryStore; facade: FakeFacade } {
  const facade = new FakeFacade();
  let now = 1745625600000;
  const store = new HistoryStore({
    facade,
    sidecarPath: "Notient/.history.json",
    maxEntries,
    now: () => ++now,
  });
  return { store, facade };
}

const sampleReversal: ReversalSpec = { kind: "delete-note", path: "notes/x.md" };

describe("HistoryStore", () => {
  test("record persists the entry and assigns a stable id", async () => {
    const { store, facade } = makeStore();
    const entry = await store.record({
      callId: "call-1",
      tool: "notes.create",
      args: { notePath: "notes/x.md", body: "hi" },
      reversal: sampleReversal,
    });
    expect(entry.id).toBeDefined();
    expect(entry.status).toBe("applied");
    const raw = facade.files.get("Notient/.history.json") ?? "";
    expect(raw).toContain(entry.id);
  });

  test("list returns newest first", async () => {
    const { store } = makeStore();
    await store.record({ callId: "c1", tool: "notes.create", args: {}, reversal: sampleReversal });
    await store.record({ callId: "c2", tool: "notes.append", args: {}, reversal: sampleReversal });
    const entries = await store.list();
    expect(entries.length).toBe(2);
    expect(entries[0].callId).toBe("c2");
    expect(entries[1].callId).toBe("c1");
  });

  test("record evicts oldest entries past maxEntries", async () => {
    const { store } = makeStore(2);
    await store.record({ callId: "c1", tool: "notes.create", args: {}, reversal: sampleReversal });
    await store.record({ callId: "c2", tool: "notes.create", args: {}, reversal: sampleReversal });
    await store.record({ callId: "c3", tool: "notes.create", args: {}, reversal: sampleReversal });
    const entries = await store.list();
    expect(entries.length).toBe(2);
    expect(entries.map((entry) => entry.callId)).toEqual(["c3", "c2"]);
  });

  test("latestApplied skips already-reversed entries", async () => {
    const { store } = makeStore();
    const first = await store.record({
      callId: "c1",
      tool: "notes.create",
      args: {},
      reversal: sampleReversal,
    });
    await store.record({ callId: "c2", tool: "notes.append", args: {}, reversal: sampleReversal });
    await store.markReversed(first.id);
    const latest = await store.latestApplied();
    expect(latest?.callId).toBe("c2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/history/historyStore.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `historyStore.ts`**

Create `src/core/history/historyStore.ts`:

```typescript
/**
 * JSON-sidecar history store for chat-driven write tools.
 *
 * Reads/writes <vault>/Notient/.history.json via the injected facade. The
 * file is a flat array of HistoryEntry rows, newest first. record() inserts
 * at index 0 and head-truncates past maxEntries. The store is the single
 * source of truth for /undo and /history; tools call record() inside the
 * tool implementation immediately after the write succeeds (or before, when
 * the reversal needs the pre-state — see core/chat/tools/notes.ts).
 */

import type { ReversalSpec } from "./reversals";

export interface HistoryStoreFacade {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

export interface HistoryEntry {
  id: string;
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  reversal: ReversalSpec;
  decidedAt: number;
  status: "applied" | "reversed";
}

export interface HistoryStoreOptions {
  facade: HistoryStoreFacade;
  sidecarPath: string;
  maxEntries: number;
  now?: () => number;
  generateId?: () => string;
}

export interface RecordInput {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  reversal: ReversalSpec;
}

export class HistoryStore {
  constructor(private readonly options: HistoryStoreOptions) {}

  async record(input: RecordInput): Promise<HistoryEntry> {
    const entries = await this.read();
    const generateId = this.options.generateId ?? defaultGenerateId;
    const now = this.options.now ?? Date.now;
    const entry: HistoryEntry = {
      id: generateId(),
      callId: input.callId,
      tool: input.tool,
      args: input.args,
      reversal: input.reversal,
      decidedAt: now(),
      status: "applied",
    };
    const next = [entry, ...entries].slice(0, this.options.maxEntries);
    await this.options.facade.write(this.options.sidecarPath, JSON.stringify(next, null, 2));
    return entry;
  }

  async list(): Promise<HistoryEntry[]> {
    return this.read();
  }

  async latestApplied(): Promise<HistoryEntry | null> {
    const entries = await this.read();
    for (const entry of entries) {
      if (entry.status === "applied") return entry;
    }
    return null;
  }

  async markReversed(id: string): Promise<void> {
    const entries = await this.read();
    const next = entries.map((entry) =>
      entry.id === id ? { ...entry, status: "reversed" as const } : entry,
    );
    await this.options.facade.write(this.options.sidecarPath, JSON.stringify(next, null, 2));
  }

  private async read(): Promise<HistoryEntry[]> {
    const raw = await this.options.facade.read(this.options.sidecarPath);
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as HistoryEntry[];
    } catch {
      // corrupt sidecar; treat as empty so /undo and /history still respond
    }
    return [];
  }
}

function defaultGenerateId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/history/historyStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/history/historyStore.ts src/core/history/historyStore.test.ts
git commit -m "$(cat <<'EOF'
feat(history): vault-native HistoryStore + 100-entry head-truncation

JSON sidecar at Notient/.history.json carries up to chat.history.maxEntries
records of chat-driven writes. Each record() inserts newest-first and
truncates past the cap. latestApplied() and markReversed() drive the
upcoming /undo verb. Corrupt sidecars degrade to an empty list rather
than blocking the chat surface.
EOF
)"
```

---

### Task 5: `core/chat/tools/notes.ts` captures reversal pre-state

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/chat/tools/notes.ts`

Each of the four `notes.*` write tools must read the pre-state and call `historyStore.record({...})` after the write succeeds. The store is injected through the existing tool factory options (extend the options shape).

- [ ] **Step 1: Inspect the current factory shape**

Run: `grep -n "createNotesTools\|HistoryStore\|recordHistory" src/core/chat/tools/notes.ts`
Expected: factory has a `recordHistory` hook that's currently a noop in bootstrap (caveat #6).

- [ ] **Step 2: Replace the noop hook with HistoryStore wiring**

Edit `src/core/chat/tools/notes.ts`:
- Add `import type { HistoryStore } from "../../history/historyStore";`
- Replace the `recordHistory: (...) => Promise<number>` option with `historyStore: HistoryStore`.
- For each tool implementation:
  - `notes.create`: pre-state is "doesn't exist". Reversal: `{ kind: "delete-note", path: notePath }`. Record after `vault.write`.
  - `notes.append`: pre-state read for `priorLength`. Reversal: `{ kind: "truncate-note", path: notePath, priorLength }`. Record after `vault.write`.
  - `notes.replace_section`: pre-state read body, extract section under heading. Reversal: `{ kind: "restore-section", path, heading, priorBody }`.
  - `notes.update_frontmatter`: pre-state read frontmatter block. Reversal: `{ kind: "restore-frontmatter", path, priorYaml }`.

For each tool, wrap the existing write block in:

```typescript
let priorBody: string | null = null;
try {
  priorBody = await vault.readNote(notePath);
} catch {
  // Pre-state read failure for create is expected and fine; for others abort.
}
if (toolName !== "notes.create" && priorBody === null) {
  throw new Error(`REVERSAL_CAPTURE_FAILED: ${notePath} could not be read`);
}
// ...existing write...
await historyStore.record({
  callId: call.id,
  tool: "notes.append",
  args: { notePath, text },
  reversal: { kind: "truncate-note", path: notePath, priorLength: priorBody!.length },
});
```

- [ ] **Step 3: Update the test fixture**

`src/core/chat/tools/notes.test.ts` already mocks the noop hook. Replace with a fake HistoryStore:

```typescript
const recordedEntries: RecordInput[] = [];
const historyStore = {
  async record(input: RecordInput) {
    recordedEntries.push(input);
    return { id: "h1", ...input, decidedAt: 0, status: "applied" as const };
  },
  list: async () => [],
  latestApplied: async () => null,
  markReversed: async () => undefined,
} satisfies Pick<HistoryStore, "record" | "list" | "latestApplied" | "markReversed">;
```

Add an assertion per tool: after the tool fires, `recordedEntries[0].reversal.kind` matches the expected kind.

- [ ] **Step 4: Update bootstrap**

In `src/daemon/bootstrap.ts`, replace the `recordHistory: async () => 0` hook with `historyStore` (instantiated in Task 15).

For Task 5, update the typing only and leave the bootstrap wiring as a follow-up (Task 15 closes the loop). Add a `// TODO(phase-d-task-15): wire historyStore` comment if the import fails.

- [ ] **Step 5: Typecheck + run notes tool tests**

Run: `bun run typecheck && bun test src/core/chat/tools/notes.test.ts`
Expected: Green once the test fake matches the new shape.

- [ ] **Step 6: Commit**

```bash
git add src/core/chat/tools/notes.ts src/core/chat/tools/notes.test.ts
git commit -m "$(cat <<'EOF'
feat(history): notes.* tools capture reversal specs through HistoryStore

Each of the four chat-write tools reads its pre-state inside the
implementation and calls historyStore.record() with a reversal spec
immediately after the write succeeds. notes.create captures
delete-note; notes.append captures truncate-note with priorLength;
notes.replace_section captures restore-section with the prior body;
notes.update_frontmatter captures restore-frontmatter with the prior
YAML. Failure to read pre-state aborts the tool with
REVERSAL_CAPTURE_FAILED rather than touching the vault.
EOF
)"
```

---

## Group 3: ContextManager hardening (parallel-safe with Group 2)

### Task 6: `contextManager.ts` reads `modelContextTokens` + emits summarization event

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/chat/contextManager.ts`
- Modify: `/home/akougkas/projects/notient/src/core/chat/contextManager.test.ts`

The `ContextSettingsView` already has `modelContextTokens` (test fixture sets it directly). Bootstrap currently overrides the value to a hardcoded `32_000`. Phase D removes the override and emits a `loop:context_summarized` event when `budgetedHistory` triggers the oldest-half summary.

- [ ] **Step 1: Update bootstrap context settings**

In `src/daemon/bootstrap.ts`, change the `contextManager` registration:

```typescript
contextSettings: () => ({
  ...current.chat.context,
  contextBudgetFraction: current.chat.contextBudgetFraction,
  modelContextTokens: current.chat.modelContextTokens,
}),
```

Drop the `32_000` literal.

- [ ] **Step 2: Add a bus reference to ContextManager**

Edit `src/core/chat/contextManager.ts`:
- Add `bus?: EventBus<{ "loop:context_summarized": ContextSummarizedEvent }>;` to `ContextManagerOptions`.
- Define `ContextSummarizedEvent`:

```typescript
export interface ContextSummarizedEvent {
  conversationId: string;
  model: string;
  originalTokens: number;
  summarizedTokens: number;
}
```

- In `compose`, pass `conversation.id` to `budgetedHistory`. When `summarized` is true, emit:

```typescript
if (budgeted.summarized && this.options.bus) {
  this.options.bus.emit("loop:context_summarized", {
    conversationId: conversation.id,
    model: this.options.summaryModel,
    originalTokens: budgeted.originalTokens,
    summarizedTokens: budgeted.summarizedTokens,
  });
}
```

- Update `budgetedHistory` to return `{ history, summarized, originalTokens, summarizedTokens }`.

- [ ] **Step 3: Add a test**

In `src/core/chat/contextManager.test.ts`, add:

```typescript
test("emits loop:context_summarized when oldest half is replaced by a summary", async () => {
  const events: ContextSummarizedEvent[] = [];
  const bus = {
    emit: (name: string, payload: ContextSummarizedEvent) => {
      if (name === "loop:context_summarized") events.push(payload);
    },
  } as unknown as EventBus<{ "loop:context_summarized": ContextSummarizedEvent }>;
  const manager = makeManagerWith(bus, { modelContextTokens: 50 }); // tiny budget triggers summarization
  await manager.compose(longHistoryConversation, latestUserMessage, new AbortController().signal);
  expect(events.length).toBe(1);
  expect(events[0].conversationId).toBe(longHistoryConversation.id);
});
```

`makeManagerWith` and the long-history fixture mirror the existing test helpers; reuse `makeDatabase()` and add a conversation with ten 200-character messages so the budget overflow is unambiguous.

- [ ] **Step 4: Typecheck + run**

Run: `bun run typecheck && bun test src/core/chat/contextManager.test.ts`
Expected: Green.

- [ ] **Step 5: Commit**

```bash
git add src/core/chat/contextManager.ts src/core/chat/contextManager.test.ts src/daemon/bootstrap.ts
git commit -m "$(cat <<'EOF'
feat(chat): modelContextTokens from settings + loop:context_summarized

Bootstrap stops hardcoding 32_000; ContextManager reads
chat.modelContextTokens from NotientSettings (default 200_000) so
larger models like Nemotron-Cascade-2-30B can use their real budget.
budgetedHistory emits loop:context_summarized on the EventBus when it
replaces the oldest half of the history with a summary so the wire
layer can render a TUI info line and so tests can assert summarization
fires under known conditions.
EOF
)"
```

---

### Task 7: `toolModeProbe.ts` retries once with elevated temperature

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/chat/toolModeProbe.ts`
- Modify: `/home/akougkas/projects/notient/src/core/chat/toolModeProbe.test.ts`

`probeToolMode` currently sends one request at the provider's default temperature. When a tool-capable model returns no tool calls under low-temp greedy decoding, the probe writes `"disabled"` and the model is permanently flagged unless an operator pins the cache via settings. Phase D adds a single retry at `temperature: 0.7` to recover the common cold-start case.

- [ ] **Step 1: Inspect current probe**

Run: `grep -nA 30 "export.*probeToolMode\|chatWithTools" src/core/chat/toolModeProbe.ts`
Expected: a single chatWithTools call followed by a check on `result.toolCalls.length`.

- [ ] **Step 2: Add retry + test**

Edit `toolModeProbe.ts`:

```typescript
const FIRST_TEMPERATURE = 0.3;
const RETRY_TEMPERATURE = 0.7;

async function attempt(provider: LLMProvider, model: string, signal: AbortSignal, temperature: number): Promise<boolean> {
  if (!provider.chatWithTools) return false;
  const handle = await provider.chatWithTools({ /* ...probeRequest with temperature */ });
  for await (const _event of handle.events) { /* drain */ }
  const result = await handle.result();
  return result.toolCalls.length > 0;
}

export async function probeToolMode(input: ProbeInput): Promise<ToolMode> {
  const cached = input.cache.read(input.model);
  if (cached) return cached;
  const first = await attempt(input.provider, input.model, input.signal, FIRST_TEMPERATURE).catch(() => false);
  if (first) {
    await input.cache.write(input.model, "native");
    return "native";
  }
  const retry = await attempt(input.provider, input.model, input.signal, RETRY_TEMPERATURE).catch(() => false);
  if (retry) {
    await input.cache.write(input.model, "native");
    return "native";
  }
  await input.cache.write(input.model, "disabled");
  return "disabled";
}
```

- [ ] **Step 3: Test**

In `src/core/chat/toolModeProbe.test.ts`, add:

```typescript
test("returns native when the second attempt yields tool calls", async () => {
  let attempts = 0;
  const provider = makeProbeProvider({
    onChatWithTools: () => {
      attempts++;
      if (attempts === 1) return { toolCalls: [] };
      return { toolCalls: [{ id: "1", name: "echo", args: {} }] };
    },
  });
  const cache = makeMemoryCache();
  const mode = await probeToolMode({ provider, model: "test", signal: new AbortController().signal, cache });
  expect(mode).toBe("native");
  expect(attempts).toBe(2);
});

test("returns disabled when both attempts yield no tool calls", async () => {
  const provider = makeProbeProvider({ onChatWithTools: () => ({ toolCalls: [] }) });
  const cache = makeMemoryCache();
  const mode = await probeToolMode({ provider, model: "test", signal: new AbortController().signal, cache });
  expect(mode).toBe("disabled");
});
```

- [ ] **Step 4: Typecheck + run probe tests**

Run: `bun run typecheck && bun test src/core/chat/toolModeProbe.test.ts`
Expected: Green.

- [ ] **Step 5: Commit**

```bash
git add src/core/chat/toolModeProbe.ts src/core/chat/toolModeProbe.test.ts
git commit -m "$(cat <<'EOF'
feat(probe): retry once at 0.7 temperature before flagging disabled

Tool-capable models that miss the first probe under low-temperature
greedy decoding (the cold-start failure documented in Phase C caveat
#1) now get a second chance at temperature 0.7. Only a model that
returns zero tool calls under both attempts gets cached as "disabled",
which the operator can still override via chat.toolModeByModel.
EOF
)"
```

---

## Group 4: Agent + subagent layer

### Task 8: `src/agent/agentIdentity.ts` Tier 2 prompts + `composeAgentIdentity`

**Files:**
- Create: `/home/akougkas/projects/notient/src/agent/agentIdentity.ts`
- Create: `/home/akougkas/projects/notient/src/agent/agentIdentity.test.ts`

Phase D ships the NoteEditor identity body verbatim; `ContextBuilder` and `Worker` are placeholders that throw `SUBAGENT_UNAVAILABLE` until Phase E. The composer concatenates `TIER_1_IDENTITY` (already exported by `src/agent/identity.ts`) with the role's specialization block.

- [ ] **Step 1: Write the test**

Create `src/agent/agentIdentity.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { composeAgentIdentity } from "./agentIdentity";

describe("composeAgentIdentity", () => {
  test("NoteEditor includes Tier 1 + NoteEditor specialization", () => {
    const prompt = composeAgentIdentity("NoteEditor");
    expect(prompt).toContain("steward of a sentient vault");
    expect(prompt).toContain("# Role: NoteEditor");
    expect(prompt).toContain("Obsidian-native");
  });

  test("Worker throws SUBAGENT_UNAVAILABLE in Phase D", () => {
    expect(() => composeAgentIdentity("Worker")).toThrow(/SUBAGENT_UNAVAILABLE/);
  });

  test("ContextBuilder throws SUBAGENT_UNAVAILABLE in Phase D", () => {
    expect(() => composeAgentIdentity("ContextBuilder")).toThrow(/SUBAGENT_UNAVAILABLE/);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `bun test src/agent/agentIdentity.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/agent/agentIdentity.ts`:

```typescript
import { TIER_1_IDENTITY } from "./identity";

export type SubagentRole = "NoteEditor" | "ContextBuilder" | "Worker";

const NOTE_EDITOR_BLOCK = `
# Role: NoteEditor

You are the orchestrator's Obsidian-native I/O specialist. You receive a
focused goal (rewrite a section, append a paragraph, restructure
frontmatter) and the affected note paths. You read the current state,
plan the smallest write that achieves the goal, and request approval
through the standard ApprovalGate before each write. You never invent
new note paths the orchestrator did not give you. You return a brief
result summary the orchestrator can render to the user.

Tools available: notes.create, notes.append, notes.replace_section,
notes.update_frontmatter, vault.read_note, vault.list_neighbors. You do
not have search tools; the orchestrator has done the searching already.
`.trim();

export function composeAgentIdentity(role: SubagentRole, base: string = TIER_1_IDENTITY): string {
  if (role === "NoteEditor") return `${base}\n\n${NOTE_EDITOR_BLOCK}`;
  if (role === "ContextBuilder" || role === "Worker") {
    throw new Error(`SUBAGENT_UNAVAILABLE: ${role} ships in Phase E`);
  }
  throw new Error(`SUBAGENT_UNKNOWN: ${role as string}`);
}
```

- [ ] **Step 4: Run test (PASS)**

Run: `bun test src/agent/agentIdentity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/agentIdentity.ts src/agent/agentIdentity.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): Tier 2 NoteEditor identity + composeAgentIdentity

The orchestrator can now ask src/agent/agentIdentity.ts for a fully
composed subagent prompt (Tier 1 + role specialization). Phase D
ships NoteEditor verbatim and gates ContextBuilder + Worker behind
SUBAGENT_UNAVAILABLE so Phase E flips them on without a contract change.
EOF
)"
```

---

### Task 9: `src/agent/subagentRegistry.ts` dispatches frozen subagent runs

**Files:**
- Create: `/home/akougkas/projects/notient/src/agent/subagentRegistry.ts`
- Create: `/home/akougkas/projects/notient/src/agent/subagentRegistry.test.ts`

The registry holds a small map of role → runner. The runner accepts `{ goal, toolWhitelist }` and returns a final string. It uses the existing `runAgentTurn` (single turn, multi-round) under a separate mutex priority slot.

- [ ] **Step 1: Write the test**

Create `src/agent/subagentRegistry.test.ts` — a test that registers a fake runner and dispatches it, asserting the registry forwards `goal` and returns the runner's output. The fake runner skips the real LLM loop. Mirror the structure of `src/agent/notientAgent.ts`'s test.

```typescript
import { describe, expect, test } from "bun:test";
import { SubagentRegistry } from "./subagentRegistry";

describe("SubagentRegistry", () => {
  test("dispatch routes to the registered runner and returns its result", async () => {
    const registry = new SubagentRegistry();
    registry.register("NoteEditor", async (input) => `done: ${input.goal}`);
    const result = await registry.dispatch({
      role: "NoteEditor",
      goal: "rename heading",
      toolWhitelist: ["notes.replace_section"],
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.content).toBe("done: rename heading");
  });

  test("dispatch returns SUBAGENT_UNAVAILABLE for unregistered roles", async () => {
    const registry = new SubagentRegistry();
    const result = await registry.dispatch({ role: "Worker", goal: "x", toolWhitelist: [] });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("SUBAGENT_UNAVAILABLE");
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `bun test src/agent/subagentRegistry.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/agent/subagentRegistry.ts`:

```typescript
import type { SubagentRole } from "./agentIdentity";

export interface DispatchInput {
  role: SubagentRole;
  goal: string;
  toolWhitelist: string[];
}

export type DispatchResult =
  | { status: "ok"; content: string; durationMs: number }
  | { status: "error"; error: string };

export type SubagentRunner = (input: DispatchInput) => Promise<string>;

export class SubagentRegistry {
  private readonly runners = new Map<SubagentRole, SubagentRunner>();

  register(role: SubagentRole, runner: SubagentRunner): void {
    this.runners.set(role, runner);
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const runner = this.runners.get(input.role);
    if (!runner) {
      return { status: "error", error: `SUBAGENT_UNAVAILABLE: ${input.role}` };
    }
    const start = Date.now();
    try {
      const content = await runner(input);
      return { status: "ok", content, durationMs: Date.now() - start };
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  has(role: SubagentRole): boolean {
    return this.runners.has(role);
  }
}
```

- [ ] **Step 4: Run test (PASS)**

Run: `bun test src/agent/subagentRegistry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/subagentRegistry.ts src/agent/subagentRegistry.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): SubagentRegistry dispatches frozen subagent runs

Phase D's on-demand subagent surface drops a small registry that maps
a SubagentRole to a runner closure. dispatch() returns
SUBAGENT_UNAVAILABLE for unregistered roles so the orchestrator's
subagent.dispatch tool can refuse with a clear error rather than
crashing the chat turn. Bootstrap (Task 15) registers the
NoteEditor runner on top of the existing chat substrate.
EOF
)"
```

---

## Group 5: Daemon handlers

### Task 10: `daemon/handlers/vault.ts` adds `vault.list`

**Files:**
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/vault.ts`
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/vault.test.ts`

The handler walks `<vault>` recursively via the existing `vault.list(folder)` facade, applying the prefix filter and the cap. Excludes `.notient`, `Notient/conversations`, `Notient/proposals`.

- [ ] **Step 1: Write the test**

Create the test using a fake VaultAdapter that returns a flat path list. Assertions: prefix filter narrows results; cap respected; excluded folders absent.

```typescript
import { describe, expect, test } from "bun:test";
import { makeVaultHandlers } from "./vault";

const fakeVault = {
  list: async (folder: string) => ({
    files: ["notes/a.md", "notes/b.md", "Notient/conversations/x.md", ".notient/db"]
      .filter((path) => path.startsWith(folder)),
    folders: [],
  }),
};

describe("vault.list", () => {
  test("returns sorted paths under prefix", async () => {
    const handlers = makeVaultHandlers({ vault: fakeVault });
    const result = await handlers.list({ prefix: "notes/" }, () => undefined, "envelope-1");
    expect(result.paths).toEqual(["notes/a.md", "notes/b.md"]);
  });

  test("excludes .notient and Notient/conversations", async () => {
    const handlers = makeVaultHandlers({ vault: fakeVault });
    const result = await handlers.list({ prefix: "" }, () => undefined, "envelope-2");
    expect(result.paths).not.toContain(".notient/db");
    expect(result.paths).not.toContain("Notient/conversations/x.md");
  });

  test("caps result at 200", async () => {
    const big = Array.from({ length: 500 }, (_, index) => `n${index}.md`);
    const handlers = makeVaultHandlers({
      vault: { list: async () => ({ files: big, folders: [] }) },
    });
    const result = await handlers.list({ prefix: "" }, () => undefined, "envelope-3");
    expect(result.paths.length).toBe(200);
  });
});
```

- [ ] **Step 2: Implement**

Create `src/daemon/handlers/vault.ts`:

```typescript
import type { VaultAdapter } from "../../adapters/vaultAdapter";

export interface VaultHandlerDeps {
  vault: Pick<VaultAdapter, "list">;
}

export interface VaultHandlers {
  list: (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ) => Promise<{ ok: boolean; paths: string[] }>;
}

const EXCLUDE_PREFIXES = [".notient/", "Notient/conversations/", "Notient/proposals/"];
const HARD_CAP = 200;

export function makeVaultHandlers(deps: VaultHandlerDeps): VaultHandlers {
  return {
    list: async (params) => {
      const prefix = typeof params.prefix === "string" ? params.prefix : "";
      const limit = typeof params.limit === "number" ? Math.min(params.limit, HARD_CAP) : HARD_CAP;
      const listing = await deps.vault.list(prefix);
      const filtered = listing.files
        .filter((path) => !EXCLUDE_PREFIXES.some((excluded) => path.startsWith(excluded)))
        .sort()
        .slice(0, limit);
      return { ok: true, paths: filtered };
    },
  };
}
```

- [ ] **Step 3: Run test (PASS)**

Run: `bun test src/daemon/handlers/vault.test.ts`
Expected: Green.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/handlers/vault.ts src/daemon/handlers/vault.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): vault.list RPC enumerates paths with prefix filter

Returns vault-relative paths sorted lexicographically and capped at 200.
Excludes the substrate-internal folders (.notient, Notient/conversations,
Notient/proposals) so chat-side @-completion never surfaces them. The
handler stays thin over the existing VaultAdapter.list facade.
EOF
)"
```

---

### Task 11: `daemon/handlers/notes.ts` adds `notes.history` + `notes.undo`

**Files:**
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/notes.ts`
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/notes.test.ts`

`notes.history` returns up to 10 newest entries from the store. `notes.undo` reads `latestApplied`, applies the reversal through `applyReversal` against the vault facade, then calls `historyStore.markReversed(entry.id)`.

- [ ] **Step 1: Write the test**

Create the test with a fake HistoryStore + reversal facade. Assertions: history returns the expected entry list; undo applies the reversal; undo on an empty store returns `HISTORY_EMPTY`.

```typescript
import { describe, expect, test } from "bun:test";
import { makeNotesHandlers } from "./notes";

describe("notes.history + notes.undo", () => {
  test("history returns up to 10 newest entries", async () => {
    const entries = Array.from({ length: 15 }, (_, index) => ({
      id: `e${index}`,
      callId: `c${index}`,
      tool: "notes.create",
      args: {},
      reversal: { kind: "delete-note" as const, path: "notes/x.md" },
      decidedAt: index,
      status: "applied" as const,
    }));
    const handlers = makeNotesHandlers({
      historyStore: { list: async () => entries, latestApplied: async () => entries[0], markReversed: async () => undefined, record: async () => entries[0] },
      reversalFacade: { read: async () => "", write: async () => undefined, remove: async () => undefined, exists: async () => true },
    });
    const result = await handlers.history({}, () => undefined, "env");
    expect(result.entries.length).toBe(10);
    expect(result.entries[0].id).toBe("e0");
  });

  test("undo applies the latestApplied reversal and marks reversed", async () => {
    let marked = "";
    const recordedReversal: string[] = [];
    const handlers = makeNotesHandlers({
      historyStore: {
        list: async () => [],
        latestApplied: async () => ({
          id: "e1",
          callId: "c1",
          tool: "notes.create",
          args: { notePath: "notes/x.md" },
          reversal: { kind: "delete-note", path: "notes/x.md" },
          decidedAt: 0,
          status: "applied",
        }),
        markReversed: async (id) => { marked = id; },
        record: async () => { throw new Error("unused"); },
      },
      reversalFacade: {
        read: async () => "",
        write: async () => undefined,
        remove: async (path) => { recordedReversal.push(path); },
        exists: async () => true,
      },
    });
    const result = await handlers.undo({}, () => undefined, "env");
    expect(result.ok).toBe(true);
    expect(recordedReversal).toEqual(["notes/x.md"]);
    expect(marked).toBe("e1");
  });

  test("undo with no applied entry returns HISTORY_EMPTY", async () => {
    const handlers = makeNotesHandlers({
      historyStore: { list: async () => [], latestApplied: async () => null, markReversed: async () => undefined, record: async () => { throw new Error("unused"); } },
      reversalFacade: { read: async () => "", write: async () => undefined, remove: async () => undefined, exists: async () => false },
    });
    await expect(handlers.undo({}, () => undefined, "env")).rejects.toThrow(/HISTORY_EMPTY/);
  });
});
```

- [ ] **Step 2: Implement**

Create `src/daemon/handlers/notes.ts`:

```typescript
import type { ReversalFacade } from "../../core/history/reversals";
import { applyReversal } from "../../core/history/reversals";
import type { HistoryEntry, HistoryStore } from "../../core/history/historyStore";

export interface NotesHandlerDeps {
  historyStore: Pick<HistoryStore, "list" | "latestApplied" | "markReversed" | "record">;
  reversalFacade: ReversalFacade;
}

export interface NotesHandlers {
  history: (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ) => Promise<{ ok: boolean; entries: HistoryEntry[] }>;
  undo: (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ) => Promise<{ ok: boolean; reversed: HistoryEntry }>;
}

export function makeNotesHandlers(deps: NotesHandlerDeps): NotesHandlers {
  return {
    history: async () => {
      const entries = (await deps.historyStore.list()).slice(0, 10);
      return { ok: true, entries };
    },
    undo: async () => {
      const entry = await deps.historyStore.latestApplied();
      if (!entry) {
        throw new Error("HISTORY_EMPTY: nothing to undo");
      }
      try {
        await applyReversal(entry.reversal, deps.reversalFacade);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`UNDO_FAILED: ${message}`);
      }
      await deps.historyStore.markReversed(entry.id);
      return { ok: true, reversed: { ...entry, status: "reversed" } };
    },
  };
}
```

- [ ] **Step 3: Run test (PASS)**

Run: `bun test src/daemon/handlers/notes.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/daemon/handlers/notes.ts src/daemon/handlers/notes.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): notes.history + notes.undo over HistoryStore

notes.history returns the last 10 chat-driven write entries newest
first. notes.undo pops the latest applied entry, applies its reversal
spec through applyReversal against the vault facade, and marks the
entry reversed in the store. Empty history surfaces HISTORY_EMPTY;
reversal mismatch (file drifted) surfaces UNDO_FAILED with the inner
REVERSAL_STALE message preserved.
EOF
)"
```

---

### Task 12: `daemon/handlers/subagent.ts` adds `subagent.dispatch`

**Files:**
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/subagent.ts`
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/subagent.test.ts`

The handler validates `role` against the registry, forwards `goal` and `toolWhitelist`, and returns `{ ok, status, content, error }`. Mid-loop approval pauses are not in scope for Phase D; the runner handles them internally.

- [ ] **Step 1: Write the test**

Test that:
- A registered role returns `{ ok: true, status: "ok", content }`.
- An unregistered role returns `{ ok: false, status: "error", error: "SUBAGENT_UNAVAILABLE..." }`.
- Missing `role` parameter throws `INVALID_PARAMS`.

- [ ] **Step 2: Implement**

```typescript
import type { SubagentRegistry } from "../../agent/subagentRegistry";
import type { SubagentRole } from "../../agent/agentIdentity";

export interface SubagentHandlerDeps {
  registry: SubagentRegistry;
}

export interface SubagentHandlers {
  dispatch: (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ) => Promise<{ ok: boolean; status: string; content?: string; error?: string }>;
}

export function makeSubagentHandlers(deps: SubagentHandlerDeps): SubagentHandlers {
  return {
    dispatch: async (params) => {
      const role = typeof params.role === "string" ? (params.role as SubagentRole) : "";
      const goal = typeof params.goal === "string" ? params.goal : "";
      const toolWhitelist = Array.isArray(params.toolWhitelist)
        ? (params.toolWhitelist as string[])
        : [];
      if (role.length === 0) throw new Error("INVALID_PARAMS: role is required");
      if (goal.length === 0) throw new Error("INVALID_PARAMS: goal is required");
      const result = await deps.registry.dispatch({ role, goal, toolWhitelist });
      if (result.status === "ok") {
        return { ok: true, status: "ok", content: result.content };
      }
      return { ok: false, status: "error", error: result.error };
    },
  };
}
```

- [ ] **Step 3: Test + commit (analogous to prior tasks)**

```bash
git add src/daemon/handlers/subagent.ts src/daemon/handlers/subagent.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): subagent.dispatch RPC over the registry

Validates role + goal, forwards toolWhitelist, and returns the runner's
final string. Unregistered roles surface SUBAGENT_UNAVAILABLE without
crashing the daemon. Mid-loop approval pauses (subagent.continue) are
deferred to Phase E.
EOF
)"
```

---

### Task 13: `daemon/handlers/chat.ts` forwards `loop:context_summarized`

**Files:**
- Modify: `/home/akougkas/projects/notient/src/daemon/handlers/chat.ts`

The chat handler must subscribe to the bus's `loop:context_summarized` event for the duration of the active turn and forward each event with the wire name `loop:context_summarized`.

- [ ] **Step 1: Subscribe + unsubscribe alongside the approval bridge**

Add inside `send`:

```typescript
const unsubscribeSummary = deps.bus.on("loop:context_summarized", (payload) => {
  if (payload.conversationId !== conversation.id) return;
  emit(encodeEvent(envelopeId, "loop:context_summarized", payload));
});
try {
  return await runSendStream(/* ... */);
} finally {
  unsubscribeSummary();
  unsubscribe();
}
```

`deps.bus` is added to `ChatHandlerDeps`; bootstrap passes `kernel.get("bus")`.

- [ ] **Step 2: Test + commit**

Add a chat handler test that:
- Stubs ContextManager to bus-emit `loop:context_summarized` during the turn.
- Asserts the wire stream contains a `loop:context_summarized` frame for the active envelope id.

```bash
git add src/daemon/handlers/chat.ts src/daemon/handlers/chat.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): chat handler forwards loop:context_summarized frames

Subscribed for the duration of each chat.send turn so a summarization
event triggered by ContextManager surfaces on the wire as a scoped
frame the TUI can render as an info line. Filtered by conversationId
so parallel conversations do not cross-emit.
EOF
)"
```

---

### Task 14: `daemon/index.ts` registers vault, notes, subagent handlers

**Files:**
- Modify: `/home/akougkas/projects/notient/src/daemon/index.ts`

Wire `vault.list`, `notes.history`, `notes.undo`, `subagent.dispatch` into the RPC dispatch table.

- [ ] **Step 1: Edit**

```typescript
const vaultHandlers = makeVaultHandlers({ vault });
const notesHandlers = makeNotesHandlers({ historyStore, reversalFacade });
const subagentHandlers = makeSubagentHandlers({ registry: subagentRegistry });

router.register("vault.list", vaultHandlers.list);
router.register("notes.history", notesHandlers.history);
router.register("notes.undo", notesHandlers.undo);
router.register("subagent.dispatch", subagentHandlers.dispatch);
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: Green.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/index.ts
git commit -m "$(cat <<'EOF'
feat(daemon): register vault.list, notes.history|undo, subagent.dispatch

Phase D's four new RPC verbs land on the existing socket router. No
behavior change for existing handlers; additive registrations only.
EOF
)"
```

---

## Group 6: Bootstrap promotion

### Task 15: `daemon/bootstrap.ts` wires `historyStore` + `subagentRegistry` + seal `"D"`

**Files:**
- Modify: `/home/akougkas/projects/notient/src/daemon/bootstrap.ts`

- [ ] **Step 1: Construct services**

After the existing Phase C registrations, add:

```typescript
const historyStore = new HistoryStore({
  facade: {
    read: async (path) => vault.read(path).catch(() => null),
    write: (path, content) => vault.write(path, content),
  },
  sidecarPath: `${NOTIENT_FOLDER}/.history.json`,
  maxEntries: current.chat.history.maxEntries,
});

const subagentRegistry = new SubagentRegistry();
subagentRegistry.register("NoteEditor", makeNoteEditorRunner({
  provider: primaryLLM,
  toolRegistry,
  approvalGate,
  mutex: reasoningMutex,
  // ...identity composed via composeAgentIdentity("NoteEditor")
}));

kernel.register("historyStore", historyStore);
kernel.register("subagentRegistry", subagentRegistry);

kernel.seal({ phase: "D" });
```

`makeNoteEditorRunner` is a thin closure inside `bootstrap.ts` that:
1. Builds the prompt: `composeAgentIdentity("NoteEditor")` + user goal.
2. Runs `runAgentTurn` once with `toolWhitelist`-filtered registry.
3. Returns the final assistant content.

- [ ] **Step 2: Replace the `recordHistory` noop in the tool factory**

Pass `historyStore` directly into `buildAgentToolRegistry({ historyStore, ... })` (already typed in Task 5).

- [ ] **Step 3: Typecheck + run all bootstrap-adjacent tests**

Run: `bun run typecheck && bun test src/daemon`
Expected: Green.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/bootstrap.ts
git commit -m "$(cat <<'EOF'
feat(daemon): bootstrap registers historyStore + subagentRegistry; seal "D"

historyStore is wired through the chat tool factory (closes Phase C
caveat #6: recordHistoryAutoApprove was a noop). subagentRegistry
ships with one runner registered for the NoteEditor role; other roles
surface SUBAGENT_UNAVAILABLE until Phase E. seal({ phase: "D" }) is
the new daemon default.
EOF
)"
```

---

## Group 7: TUI verbs + completion

### Task 16: `cli/tui/slashCommands.ts` adds `/approve`, `/deny`, `/undo`, `/history`; real `/read`

**Files:**
- Modify: `/home/akougkas/projects/notient/src/cli/tui/slashCommands.ts`
- Modify: `/home/akougkas/projects/notient/src/cli/tui/slashCommands.test.ts`

- [ ] **Step 1: Update `HELP_LINES`**

Add four new lines and replace the `/read` description:

```typescript
const HELP_LINES = [
  "/read <path>       — read a vault note",
  "/search <query>    — balanced search",
  "/awaken            — index the vault",
  "/vitals <path>     — note health snapshot",
  "/health            — substrate + bridge status",
  "/approve <id> [r]  — approve a pending tool call",
  "/deny <id> [r]     — deny a pending tool call",
  "/undo              — reverse the latest write",
  "/history           — list recent chat-driven writes",
  "/clear             — clear the transcript",
  "/quit              — exit the TUI",
];
```

- [ ] **Step 2: Add four verb branches to `dispatchSlashCommand`**

```typescript
if (verb === "approve" || verb === "deny") {
  const [callId, ...reasonParts] = rest.split(" ");
  if (!callId) return { message: `/${verb} needs <callId>` };
  const approved = verb === "approve";
  const reason = reasonParts.join(" ").trim();
  return rpcChatApprove(context, callId, approved, reason);
}
if (verb === "undo") return rpcUndo(context);
if (verb === "history") return rpcHistory(context);
if (verb === "read") {
  if (rest.length === 0) return { message: "/read needs a path" };
  return rpcReadNote(context, rest);
}
```

Each helper drains the result frame and formats:

```typescript
async function rpcChatApprove(context, callId, approved, reason) { /* call chat.approve */ }
async function rpcUndo(context) { /* call notes.undo, format reversed entry */ }
async function rpcHistory(context) { /* call notes.history, format 10 lines */ }
async function rpcReadNote(context, path) {
  const result = await drainResult(context.client.call("notes.read", { path }));
  // Or invoke vault.read_note tool if exposed; otherwise wire a thin notes.read RPC.
}
```

For `/read`, expose a new `notes.read` RPC in `daemon/handlers/notes.ts` that wraps `vault.read(path)` directly (no LLM round-trip; just a file read). Add the registration in Task 14.

- [ ] **Step 3: Update tests**

Add tests asserting the verb routes to the correct RPC and formats the response. The RPC is mocked via a fake client.

- [ ] **Step 4: Commit**

```bash
git add src/cli/tui/slashCommands.ts src/cli/tui/slashCommands.test.ts
git commit -m "$(cat <<'EOF'
feat(tui): /approve, /deny, /undo, /history, real /read

Closes Phase C caveats #4 (real /read backed by notes.read RPC) and
#7 (chat.approve plumbing exposed as /approve and /deny). /undo and
/history land alongside notes.undo and notes.history. /help updates to
show the new verb set.
EOF
)"
```

---

### Task 17: `cli/tui/runtime.tsx` tracks pending approvals + handles Tab

**Files:**
- Modify: `/home/akougkas/projects/notient/src/cli/tui/runtime.tsx`

- [ ] **Step 1: Add `pendingApprovals` state**

```typescript
const [pendingApprovals, setPendingApprovals] = useState<Map<string, string>>(new Map());
```

In `handleStreamEvent`:

```typescript
case "loop:approval_pending": {
  const callId = (detail.callId as string) ?? "";
  const tool = (detail.tool as string) ?? "tool";
  setPendingApprovals((prior) => {
    const next = new Map(prior);
    next.set(callId, tool);
    return next;
  });
  setLines((prior) => [...prior, {
    kind: "approval",
    text: `pending: ${tool} (callId=${callId}). use /approve ${callId} or /deny ${callId}.`,
    callId,
  }]);
  return;
}
case "loop:approval_resolved": {
  const callId = (detail.callId as string) ?? "";
  setPendingApprovals((prior) => {
    const next = new Map(prior);
    next.delete(callId);
    return next;
  });
  return;
}
case "loop:context_summarized": {
  setLines((prior) => [...prior, {
    kind: "system",
    text: `context summarized (${(detail.originalTokens as number)} → ${(detail.summarizedTokens as number)} tokens)`,
  }]);
  return;
}
```

- [ ] **Step 2: Add Tab handler to `handleEditingKey`**

```typescript
if (event.name === "tab") {
  const cursor = buffer.lastIndexOf("@");
  if (cursor >= 0 && /^@[^\s.]*$/.test(buffer.slice(cursor))) {
    const partial = buffer.slice(cursor + 1);
    void completeAtMention(partial, buffer, cursor, setBuffer, context);
  }
  return;
}
```

`completeAtMention` calls `vault.list({ prefix: partial, limit: 5 })` and replaces the partial with the first match.

- [ ] **Step 3: Test + commit**

```bash
git add src/cli/tui/runtime.tsx
git commit -m "$(cat <<'EOF'
feat(tui): pending-approval tracking + tab-driven @-completion

The TUI now keeps a callId→tool map for outstanding approvals and
renders a hint line whenever loop:approval_pending arrives. Tab on an
@-prefixed token at the cursor calls vault.list and replaces the
partial with the first match. loop:context_summarized renders a
brief info line.
EOF
)"
```

---

### Task 18: `cli/tui/attachments.ts` calls `vault.list` for completion

**Files:**
- Modify: `/home/akougkas/projects/notient/src/cli/tui/attachments.ts`

The current stub returns no completions. Phase D wires it to the new RPC.

- [ ] **Step 1: Implement `completeAtMention(partial, client)`**

```typescript
export async function completeAtMention(
  partial: string,
  client: ClientHandle,
): Promise<{ first: string | null; tail: string[] }> {
  const result = await drainResult(client.call("vault.list", { prefix: partial, limit: 5 }));
  if (!result || result.type !== "result") return { first: null, tail: [] };
  const detail = result as unknown as { paths?: string[] };
  const paths = detail.paths ?? [];
  return { first: paths[0] ?? null, tail: paths.slice(1, 5) };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/tui/attachments.ts
git commit -m "$(cat <<'EOF'
feat(tui): @-completion via vault.list

completeAtMention drains a vault.list call with the partial path and
returns the first match plus the next four for an inline hint. The
TUI's Tab handler (runtime.tsx) drives the call.
EOF
)"
```

---

## Group 8: Smoke + gate

### Task 19: `scripts/smoke-cli-phaseD.ts` + manual checklist

**Files:**
- Create: `/home/akougkas/projects/notient/scripts/smoke-cli-phaseD.ts`
- Create: `/home/akougkas/projects/notient/docs/superpowers/plans/2026-04-28-cli-phase-d-checklist.md`

The harness drives the daemon RPC through five passes:

1. **Approval round-trip + undo.** Send a message that the LLM resolves into a `notes.append` call. Drain `loop:approval_pending`. Send `chat.approve` with `approved: true`. Drain to `turn:complete`. Assert `notes.history` shows the entry. Send `notes.undo`. Drain. Assert the file is back to its prior state.
2. **vault.list.** Call `vault.list({ prefix: "notes/", limit: 100 })`. Assert at least the seeded fixture paths are returned.
3. **Context summarization event.** Configure `chat.modelContextTokens = 100`. Send a message with a long `pinnedContext`. Drain. Assert `loop:context_summarized` fires.
4. **Tool-mode probe retry.** Pin a model that mock-returns zero tool calls on the first probe and one tool call on the second. Assert the cache writes `native`.
5. **Subagent dispatch.** Call `subagent.dispatch({ role: "NoteEditor", goal: "describe vault structure", toolWhitelist: ["vault.read_note"] })`. Assert `{ ok: true, status: "ok", content: <non-empty> }`.

Each pass mirrors the structure of `scripts/smoke-cli-phaseC.ts`. Add a `pass` counter so a single failure doesn't mask later regressions.

- [ ] **Step 1: Write the harness skeleton**

Mirror Phase C: emit `smoke:setup`, run init/awaken, then the five passes, then daemon stop. Each pass emits its own `smoke:<name>_validated` line.

- [ ] **Step 2: Add `bun run smoke:cli:phaseD` to package.json**

Edit `package.json` scripts:

```json
"smoke:cli:phaseD": "bun scripts/smoke-cli-phaseD.ts"
```

- [ ] **Step 3: Write the manual checklist**

Create `docs/superpowers/plans/2026-04-28-cli-phase-d-checklist.md`:

```markdown
# Phase D TUI Manual Checklist

Run after `bun run smoke:cli:phaseD` is green. Each item is yes/no.

1. [ ] `/help` lists the new verbs (approve, deny, undo, history) alongside the Phase C set.
2. [ ] After the assistant requests a `notes.*` write, a `pending: <tool> (callId=…)` line renders.
3. [ ] `/approve <callId>` resolves the gate and the assistant resumes.
4. [ ] `/deny <callId>` resolves with approved=false and the assistant emits a refusal note.
5. [ ] `/undo` reverses the most recent write and prints the entry that was reversed.
6. [ ] `/history` lists the last 10 chat-driven writes, newest first.
7. [ ] Typing `@inbox/` and pressing Tab replaces the partial with the first match and shows the next four hints.
8. [ ] `/read inbox/foo.md` renders the body in a fenced block, truncated at 5KB.
9. [ ] A long-history conversation prints a `context summarized (… → … tokens)` info line when budget overflows.
10. [ ] The orchestrator dispatching a subagent renders the subagent's final result inside the assistant message.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-cli-phaseD.ts docs/superpowers/plans/2026-04-28-cli-phase-d-checklist.md package.json
git commit -m "$(cat <<'EOF'
test(smoke): Phase D end-to-end harness + manual TUI checklist

Five passes over the live LM Studio: approval round-trip + undo,
vault.list, context-summarization event, tool-mode probe retry, and
subagent.dispatch. Each pass emits a smoke:* line so a single failure
surfaces without masking later regressions. The manual TUI checklist
covers the new verbs and the @-completion + summarization info line.
EOF
)"
```

---

### Task 20: Phase D gate run + live invocation

**Files:**
- None directly; this is the gate run.

- [ ] **Step 1: Local gate**

Run: `bun run typecheck && bun run lint && bun test && bun run build:cli && bun run smoke:cli:phaseA && bun run smoke:cli:phaseB && bun run smoke:cli:phaseC && bun run smoke:cli:phaseD`
Expected: All green.

- [ ] **Step 2: Live invocation against vaultex**

Manually walk the Phase D checklist against `/mnt/c/Users/akougk/Projects/vaultex`. Capture stderr to `~/.notient/<vault-hash>/logs/` and stash any failing item with the matching log line.

- [ ] **Step 3: Tag the phase done**

If gate green and checklist green:

```bash
git tag -a phase-d-done -m "Phase D: TUI verbs, history/undo, subagent dispatch, context summarization event"
```

Do NOT push without explicit approval. `main` must stay clean unless the user asks for a fast-forward.

---

## Phase D follow-ups (Phase E candidates)

Out of scope for Phase D, deferred:

1. `subagent.continue` for mid-loop approval pauses inside a subagent run.
2. ContextBuilder + Worker subagent runners (Tier 2 identity already gated).
3. `notient stream` (NDJSON event stream of background activity).
4. `notient export-canvas <proposalId>` (canvas-style export of a proposal cluster).
5. `notient propose <kind> <payload-json>` for direct proposal creation.
6. Auto-reconnect in the TUI after daemon drop (currently exits cleanly).
7. `@`-completion popup with arrow-key navigation (Tab-only is the Phase D shape).
