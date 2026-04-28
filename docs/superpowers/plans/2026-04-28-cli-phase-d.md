# Notient v0.1 Phase D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the immediate Phase C caveats and complete the chat surface that ships in this release: a human or another agent can resolve write approvals over the wire (`/approve`, `/deny`), undo the last chat-driven write (`/undo`), inspect write history (`/history`), tab-complete `@<path>` mentions, read notes through the live `/read` verb, run conversations whose context budget tracks settings rather than a hardcoded constant, and let a flaky tool-mode probe recover before flagging a model `disabled`.

**Architecture:** Phase C promoted the kernel to its chat slice (ChatService, ApprovalGate, ToolRegistry, HistoryService). Phase D does NOT add new substrate services. Instead it (a) wires the existing `HistoryService` (already in the kernel since Phase B) through the chat write tools so `/undo` and `/history` work, (b) adds three thin RPC handlers (`vault.list`, `notes.history`, `notes.undo`, `notes.read`) over services already in the kernel, (c) emits a `loop:context_summarized` event from the existing summarization branch and reads `chat.modelContextTokens` from settings instead of hardcoding `32_000` in bootstrap, (d) hardens the tool-mode probe with a single-retry temperature variance, (e) rounds out the TUI with the missing slash verbs plus tab-driven `@`-completion. Phase D explicitly does NOT add subagents, Tier 2 identity, or `subagent.dispatch`. Both reviews surfaced a substrate blocker for that path: `ReasoningMutex.runPriority(label, task)` is preemptive, not reentrant — calling it from inside a chat task with a different label aborts the running chat task. Subagents wait for Phase E once the mutex grows a child-task contract.

**Tech Stack:** Bun runtime, TypeScript strict, NDJSON over Unix socket / Windows named pipe (Phase A transport unchanged), `@opentui/core@0.1.105` + `@opentui/react@0.1.105`, `@lmstudio/sdk` providers (locked substrate at `192.168.86.143:1234`). No new deps.

**Source of truth:**
- `docs/superpowers/handoffs/2026-04-28-phase-c-debug-and-phase-d-plan.md` — Phase C debug + Phase D scope brief.
- `docs/superpowers/specs/2026-04-27-notient-cli-design.md` — Section 6 Phase D deliverables (the spec's "Phase D — Stream, approvals, apply, undo, propose, canvas, subagent on-demand" list narrows here to the items closable from the existing substrate; subagent on-demand, `notient stream`, `notient export-canvas`, and `notient propose` defer to Phase E).
- `docs/superpowers/plans/2026-04-27-cli-phase-c.md` — locked decisions Phase D inherits.
- `src/core/history/historyService.ts` — already-shipped record/undo path.
- `src/core/history/inverters/` — already-shipped per-kind inverters (`noteCreate`, `noteAppendSection`, `noteFrontmatter`, `noteMaturity`).
- `src/core/coordinator/reasoningMutex.ts` — confirms preemptive non-reentrant semantics.

**Locked decisions (Phase D, 2026-04-28):**

1. **Phase D adds no new substrate service.** `HistoryService` and its inverters already exist in the kernel (`kernel.ts:71`, `historyService.ts`). Phase D wires them through the chat tool factory and reads them through new RPCs. There is no `HistoryStore` JSON sidecar; the SQLite `history` table from `SCHEMA_V1` (defined in `db/schema.ts:53`) is the durable record. Concurrent writes from parallel chat conversations are safe because SQLite serializes inserts.

2. **`recordHistory` in the chat tool factory forwards directly to `HistoryService.record`.** Bootstrap currently passes `recordHistory: async () => 0` (a noop, per Phase C caveat #6). Phase D replaces that with a closure that calls `kernel.get<HistoryService>("historyService").record(input)` and returns the row id. The four chat write tools (`notes.create`, `notes.append`, `notes.replace_section`, `notes.update_frontmatter`) already pass the correctly-shaped `RecordHistoryInput` (kind, target, before, after); no tool-side change is needed.

3. **`/undo` calls `notes.undo` RPC which calls `HistoryService.undoLast()`.** The handler returns `{ ok, error?, reversed?: { id, kind, target, createdAt } }`. Empty history surfaces `error: "no history"` (HistoryService's existing string). Inverter failure surfaces the inverter's error verbatim. The `/undo` TUI verb renders `reversed: <kind> <target>` on success and `error: <msg>` on failure.

4. **`/history` calls `notes.history` RPC which calls `HistoryService.getRecent(10)`.** The handler returns `{ ok, entries: HistoryRow[] }`. The TUI verb renders one line per row: `<kind> <target> <ISO timestamp>`. Phase D does not introduce a status column because HistoryService hard-deletes on undo (no soft-reverse marker).

5. **`/read <path>` calls a new `notes.read` RPC that wraps `vault.read(path)`.** The RPC returns `{ ok, body: string }`. The TUI verb renders the body in a fenced markdown block; bodies longer than 5000 characters are head/tail truncated with a `[…N characters elided…]` marker mirroring `ContextManager.elide`. No LLM call.

6. **Approval verbs are TUI-only and route to the existing `chat.approve` RPC.** `/approve <callId> [reason]` calls `chat.approve` with `approved: true`; `/deny <callId> [reason]` with `approved: false`. The TUI tracks pending approvals client-side from `loop:approval_pending` frames and clears them on `loop:approval_resolved`. `/help` lists both verbs.

7. **`vault.list` RPC enumerates a single folder's children, not a recursive walk.** Parameters: `{ folder?: string; filter?: string; limit?: number }` (defaults: `folder: ""`, `filter: ""`, `limit: 200`). Returns `{ paths: string[] }` containing both files and folders directly under `folder` whose name starts with `filter`, sorted lexicographically and capped at `min(limit, 200)`. Folder names are returned with a trailing `/` so the TUI's tab loop knows to descend. Excludes `.notient/`, `Notient/conversations/`, and `Notient/proposals/` at any folder level so attachments never reach the chat agent's own state. Backed by the existing `vault.list(folder)` facade — single-level read, no recursive scan, safe for vaults with millions of files.

8. **`@`-completion in the TUI is tab-driven.** When the input bar contains an `@`-prefixed token at the cursor and the user presses Tab, the TUI parses the token into `{ folder, partial }` (the part before the last `/` and the part after; `@inbox/foo` -> `{ folder: "inbox", partial: "foo" }`; `@inbox` -> `{ folder: "", partial: "inbox" }`), calls `vault.list({ folder, filter: partial, limit: 5 })`, and replaces the partial with the first match. A system line shows the next four matches as hints. The trigger condition is "the cursor is at the end of the input AND the buffer's last unbroken non-space run begins with `@`"; the `.` rule from the original sketch is dropped because folder/file names commonly contain `.` (e.g. `foo.md`).

9. **`chat.modelContextTokens` becomes a setting; bootstrap stops hardcoding `32_000`.** Default: `200_000` for the locked Nemotron-Cascade-2-30B substrate. Operators running smaller models override via `<vault>/.notient/config.json`. Phase D adds a `loop:context_overflow_warning` event (separate from `loop:context_summarized`) that `ContextManager` emits the first time a single turn's pre-summary token estimate exceeds `modelContextTokens` (not just the budgeted fraction); this surfaces as an info line so an operator running an 8K-context model with a `200_000` default sees the mismatch immediately.

10. **`loop:context_summarized` event lands on the bus and forwards on the wire.** `ContextManager` publishes `{ conversationId, model, originalTokens, summarizedTokens }` whenever `budgetedHistory` replaces the oldest half with a summary. The chat handler subscribes for the duration of each chat.send turn and forwards the event with the wire name `loop:context_summarized` filtered by `conversationId`. The event payload type is declared in `core/events/types.ts` so the bus is type-checked end to end (per Phase C kernel rule).

11. **Tool-mode probe retries once at temperature 0.7.** `probeToolMode` keeps the first attempt at `temperature: 0.3`. When the first attempt returns zero tool calls AND no error, the probe retries once at `0.7`. A second attempt that returns zero tool calls writes `disabled` to the cache. A second attempt that returns one or more tool calls AND parses every tool's arguments as JSON writes `native`. A second attempt that returns tool calls but ANY argument fails to parse as JSON writes `disabled` (the model's tool-calling output is unreliable). The probe emits a `loop:tool_mode_probed` event with `{ model, mode, attempts }` for operator visibility; failures are non-fatal — the chat turn proceeds in `disabled` mode if the cache says so.

12. **Phase D kernel.** `PHASE_D_KEYS = PHASE_C_KEYS` exactly. No new kernel slots; `historyService` is already in `PHASE_B_KEYS`. `seal({ phase: "D" })` becomes the new daemon default and gates the `loop:context_summarized` event emission on the existence of a registered bus, but otherwise the kernel shape is unchanged. `Kernel.seal` recognises `"D"` as an alias for the same key set as `"C"`; this keeps the daemon's default phase consistent with the version-stamped release.

13. **Subagent surface deferred to Phase E.** Both pre-execution reviews (Opus 4.7 plan reviewer + Codex adversarial) flagged that `ReasoningMutex.runPriority` aborts the running task when called with a different label. Calling `runPriority("subagent", ...)` from inside a `chat` tool execution would actively abort the parent chat turn, not deadlock — but either way the surface is unsafe to ship. Phase E will add `ReasoningMutex.runChild(parentLabel, label, task)` (or equivalent) plus `SubagentRegistry`, `composeAgentIdentity`, and `subagent.dispatch` together so the contract is testable end-to-end. Phase D's TUI ships without `subagent.dispatch` slash verbs.

14. **Phase D smoke harness scope.** `smoke:cli:phaseD` runs four passes against the fixture vault and live LM Studio: (a) a write-tool turn whose auto-approval policy fires emits `loop:approval_resolved`; subsequent `notes.history` returns one entry; subsequent `notes.undo` reverses the entry; subsequent `notes.history` returns zero entries. (b) `vault.list({ folder: "" })` returns the seeded fixture root paths excluding `.notient` and `Notient/`. (c) A turn with a pinned long context emits `loop:context_summarized` with non-zero `originalTokens`. (d) Tool-mode probe writes `native` for the locked model after retry. The TUI is verified by an extended manual checklist (`docs/superpowers/plans/2026-04-28-cli-phase-d-checklist.md`).

---

## Hard rules (carry forward from Phase C)

- TypeScript strict. No `any` without justification.
- No `console.log` outside `src/cli/output.ts` and the existing `debug<Subsystem>` helpers.
- No abbreviations: `context` not `ctx`, `error` not `err`, `message` not `msg`, `event` not `evt`, `index` not `idx`, `options` not `opts`.
- No `[noun] - [parenthetical clause]` dash-clause prose anywhere.
- No emojis in source.
- One commit per logical step on `beta-spec`. No `git add -A`. Stage by name only.
- Substrate tests stay green throughout. New tests are additive.
- The chat handler remains the only place where internal kebab-case loop event names get rewritten to spec wire names.

---

## Risks (refined after pre-execution review)

| Risk | Tasks affected | Mitigation in this plan |
|---|---|---|
| Bootstrap silently keeps the noop `recordHistory` after wiring HistoryService | Task 11 | Task 11 deletes the `recordHistory: async () => 0` literal in the same diff that adds the closure; biome lint catches the unused import if the wiring is missed. Test asserts `getRecent(1)` returns the row a chat write produced. |
| `vault.list` semantics mismatch between FsVault (folder-listing) and the planner's expectation (filename prefix) | Task 6, 14 | Locked decision 7 explicitly aligns the RPC with `FsVault.list(folder)`'s shape and adds a separate filename `filter` parameter. The TUI's tab path (Task 14) parses the at-token into `{ folder, partial }` so the call shape matches the facade. Test covers `folder: ""` and a nested folder. |
| Tool-mode probe retry classifies a model as `native` after malformed tool args | Task 8 | Locked decision 11 specifies "all tool args must parse as JSON" before writing `native`. Test asserts that a model returning a tool call with `arguments: "<broken>"` writes `disabled` even when `toolCalls.length > 0`. |
| `modelContextTokens` default `200_000` silently overflows smaller models | Task 7 | Locked decision 9 adds `loop:context_overflow_warning` (distinct from `loop:context_summarized`) so operators running 8K models see the mismatch as an info line on the first turn that exceeds the configured budget. The default is documented in `settings/types.ts` JSDoc and the manual TUI checklist. |
| `loop:context_summarized` payload drift between bus emit and wire forward | Task 7, 9 | Payload type lives in `core/events/types.ts` (typed pub/sub kernel rule). Both producer and forwarder import the same interface; tsc fails the build on shape drift. |
| `/undo` runs an inverter whose write path differs from the chat tool's facade (e.g., EchoGuard not marked) | Task 12 | Bootstrap (Task 11) wires the inverter facade with the same `notesFacade` and `echoGuard` the tool factory uses. Test in `historyService.test.ts` already covers EchoGuard marking. |
| TUI tab handler swallows Tab on legitimate non-mention text (e.g., user pressing Tab to indent inside a code-block prompt) | Task 14 | Tab triggers completion only when the buffer's last whitespace-delimited run begins with `@`; otherwise Tab is dropped (no other binding). Test in `slashCommands.test.ts` covers an `@`-less buffer. |
| HistoryService rows accumulate without retention pruning | Task 11 | Bootstrap calls `historyService.prune()` on every successful chat-write tool result. `chat.history.maxEntries` (added in Task 1) drives the retention.max. Test asserts pruning fires on the next record after the cap. |
| Concurrent writes between Notient daemon and another process (Obsidian plugin still in `.nuked/`) corrupt the `history` table | Task 11 | Out of scope: the substrate's vault lock (`VaultLock`) already prevents two daemons from running on the same vault. Phase A documented this; Phase D inherits. |

---

## File structure (Phase D landing state)

```
src/
├── core/
│   ├── chat/
│   │   ├── contextManager.ts               # MODIFIED — read modelContextTokens from settings; emit loop:context_summarized + loop:context_overflow_warning
│   │   ├── contextManager.test.ts          # MODIFIED — assert events fire when budget exceeded
│   │   ├── toolModeProbe.ts                # MODIFIED — 2-attempt retry with temperature variance + JSON-parse gate
│   │   └── toolModeProbe.test.ts           # MODIFIED — assert second attempt; assert JSON-parse gate
│   ├── events/
│   │   └── types.ts                        # MODIFIED — declare ContextSummarizedEvent + ContextOverflowWarningEvent + ToolModeProbedEvent payloads
│   └── settings/
│       └── types.ts                        # MODIFIED — chat.modelContextTokens; chat.history retention
├── daemon/
│   ├── bootstrap.ts                        # MODIFIED — wire historyService through tool factory; pass bus to ContextManager
│   ├── handlers/
│   │   ├── chat.ts                         # MODIFIED — forward loop:context_summarized + loop:context_overflow_warning + loop:tool_mode_probed
│   │   ├── notes.ts                        # NEW — notes.history, notes.undo, notes.read
│   │   ├── notes.test.ts                   # NEW
│   │   ├── vault.ts                        # NEW — vault.list (folder + filter)
│   │   └── vault.test.ts                   # NEW
│   └── index.ts                            # MODIFIED — register notes.* + vault.list handlers
└── cli/
    └── tui/
        ├── runtime.tsx                     # MODIFIED — pendingApprovals state; tab handler; render new event lines
        ├── slashCommands.ts                # MODIFIED — /approve, /deny, /undo, /history; real /read
        ├── slashCommands.test.ts           # MODIFIED — new verb tests
        └── attachments.ts                  # MODIFIED — vault.list-driven completion shim

scripts/
└── smoke-cli-phaseD.ts                     # NEW — Phase D gate harness

docs/superpowers/plans/
└── 2026-04-28-cli-phase-d-checklist.md     # NEW — manual TUI verification (Phase D additions)

package.json                                # MODIFIED — adds smoke:cli:phaseD script
```

---

## Task DAG

```
Group 1: Settings + event types (sequential)
  Task 1: settings/types.ts adds chat.modelContextTokens + chat.history retention
  Task 2: events/types.ts declares the three new event payloads

Group 2: ContextManager + probe hardening (parallel-safe within group)
  Task 3: contextManager.ts reads settings; emits loop:context_summarized
  Task 4: contextManager.ts emits loop:context_overflow_warning
  Task 5: toolModeProbe.ts 2-attempt retry + JSON-parse gate

Group 3: Daemon handlers (parallel-safe; each is a single new or single edited file)
  Task 6: daemon/handlers/vault.ts + test (vault.list)
  Task 7: daemon/handlers/notes.ts + test (notes.history, notes.undo, notes.read)
  Task 8: daemon/handlers/chat.ts forwards three new wire events

Group 4: Bootstrap promotion (sequential, single file)
  Task 9: daemon/bootstrap.ts wires historyService through tool factory; passes bus to ContextManager
  Task 10: daemon/index.ts registers notes.* + vault.list handlers

Group 5: TUI verbs + completion (parallel-safe within group; share no files)
  Task 11: cli/tui/slashCommands.ts /approve, /deny, /undo, /history; real /read
  Task 12: cli/tui/runtime.tsx pendingApprovals + tab handler + new event line renderers
  Task 13: cli/tui/attachments.ts vault.list completion

Group 6: Smoke + gate (sequential, last)
  Task 14: scripts/smoke-cli-phaseD.ts + manual checklist file
  Task 15: Phase D gate run against the fixture vault + the live vaultex
```

**Parallelism rules.** Group 1 is sequential because Task 2 depends on having a stable settings shape. Group 2 splits one file (`contextManager.ts`) across two tasks; Task 4 sequences after Task 3. Group 3's three handler tasks edit disjoint files and can dispatch in parallel after Group 2. Group 4 serializes per-file. Group 5's three TUI tasks edit disjoint files (`slashCommands.ts`, `runtime.tsx`, `attachments.ts`) and dispatch in parallel after Group 4. Group 6 is the gate.

---

## Group 1: Settings + event types

### Task 1: `settings/types.ts` adds `chat.modelContextTokens` + `chat.history`

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/settings/types.ts`

The chat block already carries `approvalMode`, `toolModeByModel`, `perTool`, optional `vision`. Phase D adds the model context budget setter and a small history retention block. Both default to safe values.

- [ ] **Step 1: Locate the chat sub-object**

Run: `grep -n "perTool\|toolModeByModel\|chat:" src/core/settings/types.ts`
Expected: hits at the chat sub-object inside `NotientSettings` and inside `DEFAULT_SETTINGS`.

- [ ] **Step 2: Edit the chat sub-object**

In `src/core/settings/types.ts`, after `perTool: Record<string, "auto" | "ask">;`, insert:

```typescript
    /**
     * Model context window in tokens. ContextManager budgets this fraction
     * (chat.contextBudgetFraction) before triggering history summarization.
     * Defaults to 200_000 for the locked Nemotron-Cascade-2-30B substrate;
     * lower for 8K/32K models (Llama 3.1 8B, Qwen2.5 7B). When the
     * configured value is too small for a given turn the loop emits
     * loop:context_overflow_warning so the operator can adjust.
     */
    modelContextTokens: number;
    history: {
      /** Maximum HistoryService rows kept globally; older rows prune on record. */
      maxEntries: number;
      /** Maximum HistoryService rows per target path; older rows prune on record. */
      maxPerTarget: number;
    };
```

In `DEFAULT_SETTINGS`'s chat block, append:

```typescript
    modelContextTokens: 200_000,
    history: { maxEntries: 200, maxPerTarget: 20 },
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
hardcoded 32_000 in Phase C) into NotientSettings so larger models
like Nemotron-Cascade-2-30B can use their real budget. Smaller models
(Llama 3.1 8B, Qwen2.5 7B) override via config.json; the upcoming
loop:context_overflow_warning event surfaces a mismatch on the first
turn. chat.history retention drives HistoryService.prune() so the
sqlite history table stays bounded as chat-driven writes accumulate.
EOF
)"
```

---

### Task 2: `events/types.ts` declares the three new payloads

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/events/types.ts`

Phase C kernel rule: every bus event has a typed payload in `events/types.ts`. Phase D adds three.

- [ ] **Step 1: Inspect current event union**

Run: `grep -nA 5 "EventBusPayloads\|export type.*Event\|export interface.*Event" src/core/events/types.ts`
Expected: a typed map of event names to payload shapes.

- [ ] **Step 2: Add the three event payloads**

Append to `src/core/events/types.ts`:

```typescript
export interface ContextSummarizedEvent {
  conversationId: string;
  model: string;
  originalTokens: number;
  summarizedTokens: number;
}

export interface ContextOverflowWarningEvent {
  conversationId: string;
  model: string;
  configuredTokens: number;
  estimatedTokens: number;
}

export interface ToolModeProbedEvent {
  model: string;
  mode: "native" | "json-fallback" | "disabled";
  attempts: number;
}
```

Add the three new keys to the EventBusPayloads union (or whatever the existing aggregate is named — match the file's convention):

```typescript
export interface EventBusPayloads {
  // ...existing keys...
  "loop:context_summarized": ContextSummarizedEvent;
  "loop:context_overflow_warning": ContextOverflowWarningEvent;
  "loop:tool_mode_probed": ToolModeProbedEvent;
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: Green. The bus may now require these keys in the dispatch table; if so, the chat handler's emit calls (Task 8) will be checked end-to-end.

- [ ] **Step 4: Commit**

```bash
git add src/core/events/types.ts
git commit -m "$(cat <<'EOF'
feat(events): typed payloads for context/probe loop events

Phase D's three new bus events get explicit payload interfaces so the
producer (ContextManager, toolModeProbe) and the wire forwarder
(daemon/handlers/chat.ts) share a tsc-checked shape:
loop:context_summarized, loop:context_overflow_warning,
loop:tool_mode_probed.
EOF
)"
```

---

## Group 2: ContextManager + probe hardening

### Task 3: `contextManager.ts` reads `modelContextTokens` from settings; emits `loop:context_summarized`

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/chat/contextManager.ts`
- Modify: `/home/akougkas/projects/notient/src/core/chat/contextManager.test.ts`

The `ContextSettingsView` already has `modelContextTokens` (test fixture sets it directly). Bootstrap currently overrides the value to a hardcoded `32_000`; the bootstrap fix lands in Task 9. The `ContextManager` itself gains a bus reference and emits the typed event when summarization fires.

- [ ] **Step 1: Add bus to ContextManagerOptions**

Edit `src/core/chat/contextManager.ts`:

Add the import:

```typescript
import type { EventBus } from "../events/eventBus";
import type { ContextSummarizedEvent, ContextOverflowWarningEvent } from "../events/types";
```

Extend `ContextManagerOptions`:

```typescript
export interface ContextManagerOptions {
  // ...existing fields...
  bus?: EventBus;
}
```

In `compose`, after `budgetedHistory` returns:

```typescript
const composed = await this.budgetedHistory(...);
if (composed.summarized && this.options.bus) {
  this.options.bus.emit("loop:context_summarized", {
    conversationId: conversation.id,
    model: this.options.summaryModel,
    originalTokens: composed.originalTokens,
    summarizedTokens: composed.summarizedTokens,
  });
}
```

Update `budgetedHistory` to return `{ history, summarized, originalTokens, summarizedTokens }` (the latter two are computed inline from the existing `used` accumulator and the post-summary length).

- [ ] **Step 2: Write the test (RED)**

In `src/core/chat/contextManager.test.ts`, add:

```typescript
test("emits loop:context_summarized when oldest half is replaced by a summary", async () => {
  const events: ContextSummarizedEvent[] = [];
  const bus = {
    emit: (name: string, payload: ContextSummarizedEvent) => {
      if (name === "loop:context_summarized") events.push(payload);
    },
    on: () => () => undefined,
  } as unknown as EventBus;
  const manager = makeManagerWith({ bus, modelContextTokens: 50 });
  const longConversation = {
    ...baseConversation,
    messages: Array.from({ length: 12 }, (_, index) => ({
      id: `m${index}`,
      role: "user" as const,
      content: "x".repeat(80),
      createdAt: index,
    })),
  };
  await manager.compose(
    longConversation,
    { id: "u", role: "user" as const, content: "now what?", createdAt: 100 },
    new AbortController().signal,
  );
  expect(events.length).toBe(1);
  expect(events[0].conversationId).toBe(longConversation.id);
  expect(events[0].originalTokens).toBeGreaterThan(events[0].summarizedTokens);
});
```

`makeManagerWith` and `baseConversation` are existing helpers in the test file; reuse them.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/core/chat/contextManager.test.ts`
Expected: FAIL — bus is not yet wired through compose.

- [ ] **Step 4: Run test to verify it passes (after Step 1)**

Run: `bun test src/core/chat/contextManager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/chat/contextManager.ts src/core/chat/contextManager.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): ContextManager emits loop:context_summarized

When budgetedHistory replaces the oldest half of conversation
history with a summary, ContextManager publishes a typed event on
the optional bus carrying conversationId, model, originalTokens,
and summarizedTokens. The chat handler subscribes per-turn and
forwards the event on the wire so the TUI can render an info line
when summarization fires.
EOF
)"
```

---

### Task 4: `contextManager.ts` emits `loop:context_overflow_warning` once per turn

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/chat/contextManager.ts`
- Modify: `/home/akougkas/projects/notient/src/core/chat/contextManager.test.ts`

When the unbudgeted token estimate (`used`) exceeds `modelContextTokens` outright (not the budget fraction), the ContextManager emits a warning event so an operator running an 8K-context model with a `200_000` default sees the mismatch.

- [ ] **Step 1: Emit the warning before summarization**

Edit `src/core/chat/contextManager.ts`'s `budgetedHistory`:

```typescript
const settings = this.options.contextSettings();
const budget = Math.floor(settings.modelContextTokens * settings.contextBudgetFraction);
let used = this.options.estimateTokens(systemPrompt);
for (const message of history) {
  used += this.options.estimateTokens(message.content);
}
if (used > settings.modelContextTokens && this.options.bus) {
  this.options.bus.emit("loop:context_overflow_warning", {
    conversationId,
    model: this.options.summaryModel,
    configuredTokens: settings.modelContextTokens,
    estimatedTokens: used,
  });
}
if (used <= budget || history.length <= 4) {
  return { history, summarized: false, originalTokens: used, summarizedTokens: used };
}
```

Add `conversationId: string` as a parameter to `budgetedHistory` and pass it from `compose`.

- [ ] **Step 2: Write the test (RED)**

```typescript
test("emits loop:context_overflow_warning when used > modelContextTokens", async () => {
  const warnings: ContextOverflowWarningEvent[] = [];
  const bus = {
    emit: (name: string, payload: ContextOverflowWarningEvent) => {
      if (name === "loop:context_overflow_warning") warnings.push(payload);
    },
    on: () => () => undefined,
  } as unknown as EventBus;
  const manager = makeManagerWith({ bus, modelContextTokens: 50 });
  const tinyBudgetConversation = {
    ...baseConversation,
    messages: Array.from({ length: 6 }, (_, index) => ({
      id: `m${index}`,
      role: "user" as const,
      content: "y".repeat(200),
      createdAt: index,
    })),
  };
  await manager.compose(
    tinyBudgetConversation,
    { id: "u", role: "user" as const, content: "trigger", createdAt: 99 },
    new AbortController().signal,
  );
  expect(warnings.length).toBe(1);
  expect(warnings[0].configuredTokens).toBe(50);
  expect(warnings[0].estimatedTokens).toBeGreaterThan(50);
});
```

- [ ] **Step 3: Verify FAIL then PASS**

Run: `bun test src/core/chat/contextManager.test.ts`
First (before Step 1 lands): FAIL with `warnings.length === 0`.
Then (after Step 1): PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/chat/contextManager.ts src/core/chat/contextManager.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): emit loop:context_overflow_warning once per overflowing turn

When a single turn's pre-summary token estimate exceeds the configured
modelContextTokens (not just the budget fraction), ContextManager
publishes a warning event with the configured and estimated counts.
Operators running smaller models (Llama 3.1 8B, Qwen2.5 7B) with a
default 200_000 setting see the mismatch on the first turn.
EOF
)"
```

---

### Task 5: `toolModeProbe.ts` 2-attempt retry + JSON-parse gate

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/chat/toolModeProbe.ts`
- Modify: `/home/akougkas/projects/notient/src/core/chat/toolModeProbe.test.ts`

`probeToolMode` currently sends one request at the provider's default temperature. When a tool-capable model misses under low-temp greedy decoding, the probe writes `disabled` permanently. Phase D adds a single retry at `0.7` AND requires every returned tool call's arguments to parse as JSON before classifying as `native`.

- [ ] **Step 1: Inspect current probe**

Run: `grep -nA 30 "export.*probeToolMode" src/core/chat/toolModeProbe.ts`
Expected: a single chatWithTools call followed by a check on `result.toolCalls.length`.

- [ ] **Step 2: Implement retry + JSON-parse gate**

Replace the body of `probeToolMode` with:

```typescript
const FIRST_TEMPERATURE = 0.3;
const RETRY_TEMPERATURE = 0.7;

interface AttemptResult {
  toolCalls: ChatWithToolsToolCall[];
  errored: boolean;
}

async function attempt(
  provider: LLMProvider,
  model: string,
  signal: AbortSignal,
  temperature: number,
): Promise<AttemptResult> {
  if (!provider.chatWithTools) return { toolCalls: [], errored: true };
  try {
    const handle = await provider.chatWithTools({
      model,
      messages: PROBE_MESSAGES,
      tools: PROBE_TOOLS,
      toolChoice: "auto",
      temperature,
      signal,
    });
    for await (const _event of handle.events) { /* drain */ }
    const result = await handle.result();
    return { toolCalls: result.toolCalls, errored: false };
  } catch {
    return { toolCalls: [], errored: true };
  }
}

function allArgsParseAsJson(toolCalls: ChatWithToolsToolCall[]): boolean {
  for (const call of toolCalls) {
    // ChatWithToolsToolCall.args is the parsed object form. The
    // LMStudioProvider returns {} when JSON.parse fails (see
    // parseToolArguments in lmStudioProvider.ts), so we cannot
    // distinguish "valid empty object" from "broken arguments" by
    // looking at args alone. The probe relies on the provider's raw
    // argsJson which we expose via the handle for this gate.
    if (call.argsJson !== undefined && call.argsJson.length > 0) {
      try {
        JSON.parse(call.argsJson);
      } catch {
        return false;
      }
    }
  }
  return true;
}

export async function probeToolMode(input: ProbeInput): Promise<ToolMode> {
  const cached = input.cache.read(input.model);
  if (cached) return cached;
  const first = await attempt(input.provider, input.model, input.signal, FIRST_TEMPERATURE);
  if (first.toolCalls.length > 0 && allArgsParseAsJson(first.toolCalls)) {
    await input.cache.write(input.model, "native");
    input.bus?.emit("loop:tool_mode_probed", { model: input.model, mode: "native", attempts: 1 });
    return "native";
  }
  if (first.errored) {
    await input.cache.write(input.model, "disabled");
    input.bus?.emit("loop:tool_mode_probed", { model: input.model, mode: "disabled", attempts: 1 });
    return "disabled";
  }
  const retry = await attempt(input.provider, input.model, input.signal, RETRY_TEMPERATURE);
  if (retry.toolCalls.length > 0 && allArgsParseAsJson(retry.toolCalls)) {
    await input.cache.write(input.model, "native");
    input.bus?.emit("loop:tool_mode_probed", { model: input.model, mode: "native", attempts: 2 });
    return "native";
  }
  await input.cache.write(input.model, "disabled");
  input.bus?.emit("loop:tool_mode_probed", { model: input.model, mode: "disabled", attempts: 2 });
  return "disabled";
}
```

This requires extending `ChatWithToolsToolCall` (or the probe's handle shape) to carry the raw `argsJson` alongside the parsed `args`. If that change is too invasive, the probe re-parses each tool call's arguments string from a side-channel — but the cleanest path is exposing `argsJson` on the result.

If the substrate's `ChatWithToolsToolCall` does not expose `argsJson` today, the alternative is to inject a custom-serializing probe that captures the raw stream itself: `LMStudioProvider.chatWithTools` already aggregates `argsJson` per call inside `ToolStreamAggregator`; the probe can use a thin wrapper that exposes it.

The minimal change for the probe today is to use `args` parsability as the proxy: a tool call where `args === {}` AND the model's tool spec required arguments is treated as a malformed call. The probe's tool spec carries `required: ["query"]`, so:

```typescript
function looksLikeMalformed(call: ChatWithToolsToolCall): boolean {
  if (Object.keys(call.args).length === 0) return true;
  if (typeof call.args.query !== "string" || call.args.query.length === 0) return true;
  return false;
}

function allArgsLookValid(toolCalls: ChatWithToolsToolCall[]): boolean {
  return toolCalls.every((call) => !looksLikeMalformed(call));
}
```

Use `allArgsLookValid` instead of `allArgsParseAsJson` in the calls above. Document the heuristic in a comment.

- [ ] **Step 3: Write the tests (RED)**

In `src/core/chat/toolModeProbe.test.ts`, add:

```typescript
test("returns native after the second attempt yields a parseable tool call", async () => {
  let attempts = 0;
  const provider = makeProbeProvider({
    onChatWithTools: () => {
      attempts++;
      if (attempts === 1) return { toolCalls: [] };
      return { toolCalls: [{ id: "1", name: "echo", args: { query: "hello" } }] };
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

test("returns disabled when the second attempt yields a tool call with empty args", async () => {
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
  expect(mode).toBe("disabled");
});
```

`makeProbeProvider` is the existing helper; it returns a fake `LLMProvider` with a stubbed `chatWithTools` that the test drives through `onChatWithTools`.

- [ ] **Step 4: Verify FAIL then PASS**

Run: `bun test src/core/chat/toolModeProbe.test.ts`
Expected: First fail (current probe is single-attempt). Then pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/chat/toolModeProbe.ts src/core/chat/toolModeProbe.test.ts
git commit -m "$(cat <<'EOF'
feat(probe): retry once at 0.7 + reject malformed tool args

Tool-capable models that miss the first probe under low-temperature
greedy decoding (the cold-start failure documented in Phase C
caveat #1) now get a second chance at temperature 0.7. A tool call
whose required arg ('query' for the echo probe) is empty or missing
reads as malformed and the probe writes "disabled" rather than
classifying the model as "native" on the strength of an
unparseable response. The probe emits loop:tool_mode_probed with
the attempt count so operators can see the retry on the wire.
EOF
)"
```

---

## Group 3: Daemon handlers

### Task 6: `daemon/handlers/vault.ts` adds `vault.list`

**Files:**
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/vault.ts`
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/vault.test.ts`

The handler reads a single folder via the existing `vault.list(folder)` facade, applies the filename filter, sorts, and caps. Folders return with a trailing `/`.

- [ ] **Step 1: Write the test (RED)**

Create `src/daemon/handlers/vault.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { makeVaultHandlers } from "./vault";

const fakeVault = {
  list: async (folder: string) => {
    if (folder === "") {
      return {
        files: ["root.md", "Notient/conversations/x.md", ".notient/db"],
        folders: ["inbox", "Notient", ".notient"],
      };
    }
    if (folder === "inbox") {
      return { files: ["alpha.md", "beta.md", "alphabet.md"], folders: ["nested"] };
    }
    return { files: [], folders: [] };
  },
};

describe("vault.list", () => {
  test("returns folder children with trailing slash for folders", async () => {
    const handlers = makeVaultHandlers({ vault: fakeVault });
    const result = await handlers.list({ folder: "inbox" }, () => undefined, "envelope-1");
    expect(result.paths).toEqual(["alpha.md", "alphabet.md", "beta.md", "nested/"]);
  });

  test("filter narrows by filename prefix", async () => {
    const handlers = makeVaultHandlers({ vault: fakeVault });
    const result = await handlers.list({ folder: "inbox", filter: "alpha" }, () => undefined, "envelope-2");
    expect(result.paths).toEqual(["alpha.md", "alphabet.md"]);
  });

  test("excludes .notient and Notient at the root", async () => {
    const handlers = makeVaultHandlers({ vault: fakeVault });
    const result = await handlers.list({ folder: "" }, () => undefined, "envelope-3");
    expect(result.paths).toEqual(["inbox/", "root.md"]);
  });

  test("caps at 200 even when limit is unset", async () => {
    const big = Array.from({ length: 500 }, (_, index) => `n${index}.md`);
    const handlers = makeVaultHandlers({
      vault: { list: async () => ({ files: big, folders: [] }) },
    });
    const result = await handlers.list({}, () => undefined, "envelope-4");
    expect(result.paths.length).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify FAIL**

Run: `bun test src/daemon/handlers/vault.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

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

const HARD_CAP = 200;
const ROOT_EXCLUDES = new Set([".notient", "Notient"]);

export function makeVaultHandlers(deps: VaultHandlerDeps): VaultHandlers {
  return {
    list: async (params) => {
      const folder = typeof params.folder === "string" ? params.folder : "";
      const filter = typeof params.filter === "string" ? params.filter : "";
      const limit =
        typeof params.limit === "number" ? Math.min(params.limit, HARD_CAP) : HARD_CAP;
      const listing = await deps.vault.list(folder);
      const folderEntries = listing.folders
        .filter((name) => !(folder === "" && ROOT_EXCLUDES.has(name)))
        .filter((name) => name.startsWith(filter))
        .map((name) => `${name}/`);
      const fileEntries = listing.files
        .filter((name) => !(folder === "" && name.startsWith("Notient/")))
        .filter((name) => !(folder === "" && name.startsWith(".notient/")))
        .filter((name) => name.startsWith(filter));
      const paths = [...folderEntries, ...fileEntries].sort().slice(0, limit);
      return { ok: true, paths };
    },
  };
}
```

- [ ] **Step 4: Run test to verify PASS**

Run: `bun test src/daemon/handlers/vault.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/handlers/vault.ts src/daemon/handlers/vault.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): vault.list RPC over single-folder facade

Returns vault-relative children of a folder with a filename filter,
sorted with folders (trailing slash) first by lexicographic order,
capped at 200. Backed by the existing FsVault.list(folder) so the
walk is single-level — safe on vaults with millions of files. Excludes
.notient and Notient subtrees at the root so chat-side @-completion
never surfaces substrate-internal state. Drives the upcoming TUI
tab handler (Task 13).
EOF
)"
```

---

### Task 7: `daemon/handlers/notes.ts` adds `notes.history`, `notes.undo`, `notes.read`

**Files:**
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/notes.ts`
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/notes.test.ts`

`notes.history` calls `HistoryService.getRecent(10)`. `notes.undo` calls `HistoryService.undoLast()`. `notes.read` calls `vault.read(path)`.

- [ ] **Step 1: Write the test (RED)**

Create `src/daemon/handlers/notes.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { makeNotesHandlers } from "./notes";
import type { HistoryRow } from "../../core/history/types";

const sampleRow: HistoryRow = {
  id: 42,
  kind: "notes.create",
  target: "notes/x.md",
  before: null,
  after: "hello",
  createdAt: 1700000000000,
};

describe("notes.history + notes.undo + notes.read", () => {
  test("history returns the rows from getRecent", async () => {
    const handlers = makeNotesHandlers({
      historyService: {
        getRecent: () => [sampleRow],
        undoLast: async () => ({ ok: true }),
      },
      vault: { read: async () => "body" },
    });
    const result = await handlers.history({ limit: 10 }, () => undefined, "envelope-1");
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].id).toBe(42);
  });

  test("undo calls undoLast and returns the reversed row metadata", async () => {
    let called = false;
    const handlers = makeNotesHandlers({
      historyService: {
        getRecent: () => [sampleRow],
        undoLast: async () => {
          called = true;
          return { ok: true };
        },
      },
      vault: { read: async () => "body" },
    });
    const result = await handlers.undo({}, () => undefined, "envelope-2");
    expect(called).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.reversed?.id).toBe(42);
  });

  test("undo surfaces the inverter error when undoLast returns ok:false", async () => {
    const handlers = makeNotesHandlers({
      historyService: {
        getRecent: () => [],
        undoLast: async () => ({ ok: false, error: "no history" }),
      },
      vault: { read: async () => "body" },
    });
    const result = await handlers.undo({}, () => undefined, "envelope-3");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no history");
  });

  test("read returns the file body from vault.read", async () => {
    const handlers = makeNotesHandlers({
      historyService: { getRecent: () => [], undoLast: async () => ({ ok: false, error: "x" }) },
      vault: { read: async (path: string) => `# ${path}\n\nbody` },
    });
    const result = await handlers.read({ path: "notes/x.md" }, () => undefined, "envelope-4");
    expect(result.ok).toBe(true);
    expect(result.body).toBe("# notes/x.md\n\nbody");
  });

  test("read rejects without a path", async () => {
    const handlers = makeNotesHandlers({
      historyService: { getRecent: () => [], undoLast: async () => ({ ok: false, error: "x" }) },
      vault: { read: async () => "" },
    });
    await expect(handlers.read({}, () => undefined, "env-5")).rejects.toThrow(/INVALID_PARAMS/);
  });
});
```

- [ ] **Step 2: Verify FAIL**

Run: `bun test src/daemon/handlers/notes.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/daemon/handlers/notes.ts`:

```typescript
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import type { HistoryService } from "../../core/history/historyService";
import type { HistoryRow } from "../../core/history/types";

export interface NotesHandlerDeps {
  historyService: Pick<HistoryService, "getRecent" | "undoLast">;
  vault: Pick<VaultAdapter, "read">;
}

export interface NotesHandlers {
  history: (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ) => Promise<{ ok: boolean; entries: HistoryRow[] }>;
  undo: (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ) => Promise<{ ok: boolean; reversed?: HistoryRow; error?: string }>;
  read: (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ) => Promise<{ ok: boolean; body: string }>;
}

export function makeNotesHandlers(deps: NotesHandlerDeps): NotesHandlers {
  return {
    history: async (params) => {
      const limit = typeof params.limit === "number" ? params.limit : 10;
      const entries = deps.historyService.getRecent(limit);
      return { ok: true, entries };
    },
    undo: async () => {
      const recent = deps.historyService.getRecent(1);
      const target = recent[0];
      const result = await deps.historyService.undoLast();
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return { ok: true, reversed: target };
    },
    read: async (params) => {
      const path = typeof params.path === "string" ? params.path : "";
      if (path.length === 0) throw new Error("INVALID_PARAMS: path is required");
      const body = await deps.vault.read(path);
      return { ok: true, body };
    },
  };
}
```

- [ ] **Step 4: Verify PASS**

Run: `bun test src/daemon/handlers/notes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/handlers/notes.ts src/daemon/handlers/notes.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): notes.history + notes.undo + notes.read RPCs

Three thin wrappers over the existing HistoryService and VaultAdapter:
notes.history reads HistoryService.getRecent(limit=10); notes.undo
calls HistoryService.undoLast and returns the reversed row metadata
or the inverter's error string; notes.read returns vault.read(path)
for the upcoming /read TUI verb. No new substrate; closes Phase C
caveats #4 (real /read) and #6 (history wiring).
EOF
)"
```

---

### Task 8: `daemon/handlers/chat.ts` forwards three new wire events

**Files:**
- Modify: `/home/akougkas/projects/notient/src/daemon/handlers/chat.ts`
- Modify: `/home/akougkas/projects/notient/src/daemon/handlers/chat.test.ts`

The chat handler subscribes to `loop:context_summarized`, `loop:context_overflow_warning`, and `loop:tool_mode_probed` for the duration of each `chat.send` and forwards each frame on the wire.

- [ ] **Step 1: Add bus to ChatHandlerDeps**

```typescript
import type { EventBus } from "../../core/events/eventBus";

export interface ChatHandlerDeps {
  // ...existing fields...
  bus: EventBus;
}
```

- [ ] **Step 2: Subscribe + unsubscribe inside `send`**

After `subscribeApprovalEvents`, before `runSendStream`:

```typescript
const unsubscribeSummary = deps.bus.on("loop:context_summarized", (payload) => {
  if (payload.conversationId !== conversation.id) return;
  emit(encodeEvent(envelopeId, "loop:context_summarized", payload));
});
const unsubscribeOverflow = deps.bus.on("loop:context_overflow_warning", (payload) => {
  if (payload.conversationId !== conversation.id) return;
  emit(encodeEvent(envelopeId, "loop:context_overflow_warning", payload));
});
const unsubscribeProbed = deps.bus.on("loop:tool_mode_probed", (payload) => {
  emit(encodeEvent(envelopeId, "loop:tool_mode_probed", payload));
});
try {
  return await runSendStream(/* ... */);
} finally {
  unsubscribeProbed();
  unsubscribeOverflow();
  unsubscribeSummary();
  unsubscribe();
}
```

`loop:tool_mode_probed` is broadcast (no `conversationId`) because the probe runs once per model and is not scoped to a turn.

- [ ] **Step 3: Add tests**

In `src/daemon/handlers/chat.test.ts`, add a test that emits each of the three events on the bus during a fake chat turn and asserts a matching wire frame is captured. Mirror the existing approval-bridge test pattern.

- [ ] **Step 4: Verify**

Run: `bun test src/daemon/handlers/chat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/handlers/chat.ts src/daemon/handlers/chat.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): chat handler forwards summarization + overflow + probe events

Subscribed for the duration of each chat.send turn so substrate bus
events surface on the wire as scoped frames the TUI can render as
info lines: loop:context_summarized (filtered by conversationId),
loop:context_overflow_warning (filtered by conversationId), and
loop:tool_mode_probed (broadcast — probe runs once per model, not
per turn).
EOF
)"
```

---

## Group 4: Bootstrap promotion

### Task 9: `daemon/bootstrap.ts` wires `historyService` through tool factory; passes bus to ContextManager

**Files:**
- Modify: `/home/akougkas/projects/notient/src/daemon/bootstrap.ts`

- [ ] **Step 1: Pass bus to ContextManager**

Find the `new ContextManager({ ... })` block. Add `bus,` to its options.

- [ ] **Step 2: Read `modelContextTokens` from settings**

In the same block, replace:

```typescript
contextSettings: () => ({
  ...current.chat.context,
  contextBudgetFraction: current.chat.contextBudgetFraction,
  modelContextTokens: 32_000,
}),
```

with:

```typescript
contextSettings: () => ({
  ...current.chat.context,
  contextBudgetFraction: current.chat.contextBudgetFraction,
  modelContextTokens: current.chat.modelContextTokens,
}),
```

- [ ] **Step 3: Forward `recordHistory` to HistoryService**

In the `buildAgentToolRegistry({...})` call, replace:

```typescript
recordHistory: async () => 0, // Phase D wires history table writes.
```

with:

```typescript
recordHistory: async (record) => historyService.record(record),
```

The variable `historyService` is already in scope (`kernel.get("historyService")` or constructed earlier in bootstrap; verify by running `grep -n "historyService" src/daemon/bootstrap.ts`). If it isn't already constructed, instantiate it inline before this block, mirroring the Phase B path that registers it in the kernel.

- [ ] **Step 4: Wire bus through toolModeProbe**

In the same file, find the `toolModeCache` block and the call site that consumes it (likely inside `chatService` construction). Add the bus to whatever wraps `probeToolMode` — pass the kernel's bus to whichever module invokes the probe. If `probeToolMode` is invoked directly in bootstrap, add `bus` to the call site.

- [ ] **Step 5: Add a smoke step asserting the wiring**

Add a substrate-level test in `src/daemon/bootstrap.test.ts` (or extend the existing one) that constructs the kernel, runs a chat turn that triggers a `notes.create`, and asserts `historyService.getRecent(1)` returns one row.

- [ ] **Step 6: Typecheck + run substrate**

Run: `bun run typecheck && bun test src/daemon`
Expected: Green.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/bootstrap.ts src/daemon/bootstrap.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): bootstrap forwards recordHistory through HistoryService

Closes Phase C caveat #6: recordHistory was a noop and the chat
write tools' history rows never landed in the sqlite table. Phase D
wires the closure to historyService.record so /undo and /history have
data to read. ContextManager also gains the bus reference so
loop:context_summarized + loop:context_overflow_warning surface on
the wire, and modelContextTokens reads from settings instead of the
Phase C hardcoded 32_000.
EOF
)"
```

---

### Task 10: `daemon/index.ts` registers `notes.*` + `vault.list` handlers

**Files:**
- Modify: `/home/akougkas/projects/notient/src/daemon/index.ts`

- [ ] **Step 1: Construct and register**

After the existing handler registrations:

```typescript
const vaultHandlers = makeVaultHandlers({ vault });
const notesHandlers = makeNotesHandlers({
  historyService: kernel.get("historyService"),
  vault,
});

router.register("vault.list", vaultHandlers.list);
router.register("notes.history", notesHandlers.history);
router.register("notes.undo", notesHandlers.undo);
router.register("notes.read", notesHandlers.read);
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: Green.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/index.ts
git commit -m "$(cat <<'EOF'
feat(daemon): register vault.list, notes.history|undo|read

Phase D's four new RPC verbs land on the existing socket router. No
behavior change for existing handlers; additive registrations only.
EOF
)"
```

---

## Group 5: TUI verbs + completion

### Task 11: `cli/tui/slashCommands.ts` adds `/approve`, `/deny`, `/undo`, `/history`; real `/read`

**Files:**
- Modify: `/home/akougkas/projects/notient/src/cli/tui/slashCommands.ts`
- Modify: `/home/akougkas/projects/notient/src/cli/tui/slashCommands.test.ts`

- [ ] **Step 1: Update `HELP_LINES`**

Replace `HELP_LINES` with:

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

- [ ] **Step 2: Add the verb branches**

Inside `dispatchSlashCommand`, before the `unknown command` line:

```typescript
if (verb === "approve" || verb === "deny") {
  const space = rest.indexOf(" ");
  const callId = space < 0 ? rest : rest.slice(0, space);
  const reason = space < 0 ? "" : rest.slice(space + 1).trim();
  if (callId.length === 0) return { message: `/${verb} needs <callId>` };
  return rpcChatApprove(context, callId, verb === "approve", reason);
}
if (verb === "undo") return rpcUndo(context);
if (verb === "history") return rpcHistory(context);
if (verb === "read") {
  if (rest.length === 0) return { message: "/read needs a path" };
  return rpcReadNote(context, rest);
}
```

Replace the existing `if (verb === "read")` branch (which currently routes to `rpcVitals`) with the dispatch above.

Add the helper bodies:

```typescript
async function rpcChatApprove(
  context: SlashContext,
  callId: string,
  approved: boolean,
  reason: string,
): Promise<SlashOutcome> {
  const params: Record<string, unknown> = { callId, approved };
  if (reason.length > 0) params.reason = reason;
  const result = await drainResult(context.client.call("chat.approve", params));
  if (!result || result.type === "error") {
    return { message: `${approved ? "approve" : "deny"} error: ${formatError(result)}` };
  }
  return { message: `${approved ? "approved" : "denied"} ${callId}` };
}

async function rpcUndo(context: SlashContext): Promise<SlashOutcome> {
  const result = await drainResult(context.client.call("notes.undo", {}));
  if (!result || result.type === "error") return { message: `undo error: ${formatError(result)}` };
  const detail = result as unknown as {
    result?: { ok?: boolean; error?: string; reversed?: { kind?: string; target?: string } };
  };
  if (detail.result?.ok !== true) {
    return { message: `undo: ${detail.result?.error ?? "unknown"}` };
  }
  const reversed = detail.result.reversed;
  return { message: `undone: ${reversed?.kind ?? "?"} ${reversed?.target ?? ""}` };
}

async function rpcHistory(context: SlashContext): Promise<SlashOutcome> {
  const result = await drainResult(context.client.call("notes.history", { limit: 10 }));
  if (!result || result.type === "error") return { message: `history error: ${formatError(result)}` };
  const detail = result as unknown as {
    result?: { entries?: { kind: string; target: string; createdAt: number }[] };
  };
  const entries = detail.result?.entries ?? [];
  if (entries.length === 0) return { message: "history: (empty)" };
  return {
    message: entries
      .map((entry) => `${entry.kind} ${entry.target} ${new Date(entry.createdAt).toISOString()}`)
      .join("\n"),
  };
}

async function rpcReadNote(context: SlashContext, path: string): Promise<SlashOutcome> {
  const result = await drainResult(context.client.call("notes.read", { path }));
  if (!result || result.type === "error") return { message: `read error: ${formatError(result)}` };
  const detail = result as unknown as { result?: { body?: string } };
  const body = detail.result?.body ?? "";
  return { message: renderNoteBody(path, body) };
}

function renderNoteBody(path: string, body: string): string {
  const limit = 5000;
  if (body.length <= limit) return `\`\`\`md\n${body}\n\`\`\``;
  const head = body.slice(0, Math.floor(limit * 0.7));
  const tail = body.slice(body.length - Math.floor(limit * 0.3));
  return `\`\`\`md\n${head}\n[…${body.length - limit} characters elided…]\n${tail}\n\`\`\``;
}
```

- [ ] **Step 3: Update tests**

In `src/cli/tui/slashCommands.test.ts`, add a fake-client test per new verb. The existing tests already mock `client.call`; mirror them. Cover: `/approve` calls `chat.approve` with `approved: true`; `/deny` with `approved: false`; `/undo` formats the reversed row; `/history` formats entries; `/read` truncates over 5000 chars.

- [ ] **Step 4: Run + commit**

Run: `bun test src/cli/tui/slashCommands.test.ts`
Expected: Green.

```bash
git add src/cli/tui/slashCommands.ts src/cli/tui/slashCommands.test.ts
git commit -m "$(cat <<'EOF'
feat(tui): /approve, /deny, /undo, /history; real /read

Closes Phase C caveats #4 (real /read backed by notes.read RPC) and
#7 (chat.approve plumbing exposed as /approve and /deny). /undo and
/history land alongside notes.undo and notes.history. /help updates
to list the new verbs. /read renders the note body in a fenced
markdown block, head/tail truncated at 5000 chars.
EOF
)"
```

---

### Task 12: `cli/tui/runtime.tsx` tracks pending approvals + handles Tab + renders new event lines

**Files:**
- Modify: `/home/akougkas/projects/notient/src/cli/tui/runtime.tsx`

- [ ] **Step 1: Add `pendingApprovals` state**

Inside `App`, after the existing `useState` calls:

```typescript
const [pendingApprovals, setPendingApprovals] = useState<Map<string, string>>(new Map());
```

- [ ] **Step 2: Extend `handleStreamEvent`**

Add cases:

```typescript
case "loop:approval_pending": {
  const callId = (detail.callId as string) ?? "";
  const tool = (detail.tool as string) ?? "tool";
  setPendingApprovals((prior) => {
    const next = new Map(prior);
    next.set(callId, tool);
    return next;
  });
  setLines((prior) => [
    ...prior,
    {
      kind: "approval",
      text: `pending: ${tool} (callId=${callId}). use /approve ${callId} or /deny ${callId}.`,
      callId,
    },
  ]);
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
  setLines((prior) => [
    ...prior,
    {
      kind: "system",
      text: `context summarized (${detail.originalTokens} → ${detail.summarizedTokens} tokens)`,
    },
  ]);
  return;
}
case "loop:context_overflow_warning": {
  setLines((prior) => [
    ...prior,
    {
      kind: "system",
      text: `warning: configured modelContextTokens=${detail.configuredTokens} but turn estimates ${detail.estimatedTokens} tokens. Increase chat.modelContextTokens.`,
    },
  ]);
  return;
}
case "loop:tool_mode_probed": {
  setLines((prior) => [
    ...prior,
    {
      kind: "system",
      text: `tool-mode for ${detail.model}: ${detail.mode} (attempts=${detail.attempts})`,
    },
  ]);
  return;
}
```

- [ ] **Step 3: Add Tab handler**

In `handleEditingKey`, before the printable-character branch:

```typescript
if (event.name === "tab") {
  if (event.shift || event.ctrl) return;
  const lastSpace = buffer.lastIndexOf(" ");
  const trailing = lastSpace < 0 ? buffer : buffer.slice(lastSpace + 1);
  if (!trailing.startsWith("@")) return;
  void completeAtMention(trailing.slice(1), buffer, lastSpace, setBuffer, submit, context);
  return;
}
```

`completeAtMention` lives in `src/cli/tui/attachments.ts` (Task 13).

- [ ] **Step 4: Commit**

```bash
git add src/cli/tui/runtime.tsx
git commit -m "$(cat <<'EOF'
feat(tui): pending-approval tracking + tab @-completion + event lines

App keeps a callId→tool map for outstanding approvals; the transcript
shows a pending hint on each loop:approval_pending and clears on
loop:approval_resolved. loop:context_summarized,
loop:context_overflow_warning, and loop:tool_mode_probed render as
system info lines. Tab on a buffer whose last whitespace-separated
run begins with @ calls completeAtMention against vault.list.
EOF
)"
```

---

### Task 13: `cli/tui/attachments.ts` calls `vault.list` for completion

**Files:**
- Modify: `/home/akougkas/projects/notient/src/cli/tui/attachments.ts`

The current shim returns no completions. Phase D wires it to `vault.list`.

- [ ] **Step 1: Implement `completeAtMention`**

```typescript
import type { ClientHandle, RpcResponseFrame } from "../client";

export interface AtMentionContext {
  client: ClientHandle;
}

export async function completeAtMention(
  partialAfterAt: string,
  fullBuffer: string,
  spaceIndex: number,
  setBuffer: (next: string) => void,
  appendSystemLine: (text: string) => void,
  context: AtMentionContext,
): Promise<void> {
  const lastSlash = partialAfterAt.lastIndexOf("/");
  const folder = lastSlash < 0 ? "" : partialAfterAt.slice(0, lastSlash);
  const filter = lastSlash < 0 ? partialAfterAt : partialAfterAt.slice(lastSlash + 1);
  const result = await drainResult(
    context.client.call("vault.list", { folder, filter, limit: 5 }),
  );
  if (!result || result.type !== "result") return;
  const detail = result as unknown as { paths?: string[] };
  const paths = detail.paths ?? [];
  if (paths.length === 0) {
    appendSystemLine(`no completions for @${partialAfterAt}`);
    return;
  }
  const first = paths[0];
  const completedToken = `@${folder.length > 0 ? `${folder}/` : ""}${first}`;
  const prefix = spaceIndex < 0 ? "" : `${fullBuffer.slice(0, spaceIndex + 1)}`;
  setBuffer(`${prefix}${completedToken}`);
  if (paths.length > 1) {
    appendSystemLine(`hints: ${paths.slice(1, 5).join("  ")}`);
  }
}

async function drainResult(
  stream: AsyncIterable<RpcResponseFrame>,
): Promise<RpcResponseFrame | null> {
  for await (const frame of stream) {
    if (frame.type === "result" || frame.type === "error") return frame;
  }
  return null;
}
```

The `appendSystemLine` callback is wired from `runtime.tsx`'s `setLines` setter via a small adapter so the attachments module does not import React.

- [ ] **Step 2: Commit**

```bash
git add src/cli/tui/attachments.ts
git commit -m "$(cat <<'EOF'
feat(tui): @-completion via vault.list

completeAtMention parses the @-token into {folder, partial}, calls
vault.list with both, and replaces the partial with the first match.
The next four matches surface as a system hint line. Folder-shaped
completions get a trailing slash so a second Tab descends.
EOF
)"
```

---

## Group 6: Smoke + gate

### Task 14: `scripts/smoke-cli-phaseD.ts` + manual checklist

**Files:**
- Create: `/home/akougkas/projects/notient/scripts/smoke-cli-phaseD.ts`
- Create: `/home/akougkas/projects/notient/docs/superpowers/plans/2026-04-28-cli-phase-d-checklist.md`
- Modify: `/home/akougkas/projects/notient/package.json`

The harness drives the daemon RPC through four passes against the fixture vault and live LM Studio.

- [ ] **Step 1: Mirror Phase C harness shape**

Copy the structure of `scripts/smoke-cli-phaseC.ts` (init, awaken, then per-pass functions). Phase D passes:

```typescript
async function runHistoryUndoPass(vaultPath: string): Promise<void> {
  const socketPath = resolveSocketPath(vaultPath, currentPlatform());
  const client = await connectClient({ socketPath, vaultPath, spawnTimeoutMs: 60_000 });
  try {
    const conversationId = await startConversation(client);
    await drainChatSend(
      client,
      conversationId,
      "use notes.create to make a note at history-test.md with body 'hi'",
    );
    const after = await drainResultCall(client, "notes.history", { limit: 5 });
    if (after.entries.length === 0) throw new Error("history-undo: notes.create did not record");
    const undoOutcome = await drainResultCall(client, "notes.undo", {});
    if (undoOutcome.result?.ok !== true) {
      throw new Error(`history-undo: undo failed (${undoOutcome.result?.error})`);
    }
    const cleared = await drainResultCall(client, "notes.history", { limit: 5 });
    if (cleared.entries.length !== 0) {
      throw new Error("history-undo: history not pruned after undo");
    }
  } finally {
    await client.close();
  }
}

async function runVaultListPass(vaultPath: string): Promise<void> { /* ... */ }
async function runContextSummarizedPass(vaultPath: string): Promise<void> { /* ... */ }
async function runProbeRetryPass(vaultPath: string): Promise<void> { /* ... */ }
```

`drainResultCall` is a helper that drains the client.call iterator until `result` and returns its payload. The pass implementations follow the same shape; the smoke uses the live LM Studio and the same fixture vault Phase C uses.

- [ ] **Step 2: Add `bun run smoke:cli:phaseD` to package.json**

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
5. [ ] `/undo` reverses the most recent write and prints the entry that was reversed (kind + target).
6. [ ] `/history` lists the last 10 chat-driven writes, newest first.
7. [ ] Typing `@inbox/` and pressing Tab replaces the partial with the first match and shows the next four hints.
8. [ ] Typing `@inbox/foo` and pressing Tab also completes (filename prefix inside a folder).
9. [ ] `/read inbox/foo.md` renders the body in a fenced block, truncated at ~5000 chars.
10. [ ] A long-history conversation prints a `context summarized (… → … tokens)` info line when budget overflows.
11. [ ] An 8K-context model running with default 200_000 setting prints `warning: configured modelContextTokens=200000 but turn estimates …`.
12. [ ] First chat turn of the session prints `tool-mode for <model>: native (attempts=<1|2>)`.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-cli-phaseD.ts docs/superpowers/plans/2026-04-28-cli-phase-d-checklist.md package.json
git commit -m "$(cat <<'EOF'
test(smoke): Phase D end-to-end harness + manual TUI checklist

Four passes over the live LM Studio: history+undo round-trip,
vault.list folder enumeration, context summarization event,
tool-mode probe retry. Each pass emits a smoke:* line so a single
failure surfaces without masking later regressions. The manual TUI
checklist covers the new verbs, @-completion, and the three new
info lines.
EOF
)"
```

---

### Task 15: Phase D gate run + live invocation

**Files:**
- None directly; this is the gate run.

- [ ] **Step 1: Local gate**

Run: `bun run typecheck && bun run lint && bun test && bun run build:cli && bun run smoke:cli:phaseA && bun run smoke:cli:phaseB && bun run smoke:cli:phaseC && bun run smoke:cli:phaseD`
Expected: All green.

- [ ] **Step 2: Live invocation against vaultex**

Manually walk the Phase D checklist against `/mnt/c/Users/akougk/Projects/vaultex`. Capture any failure with the matching log line from `~/.notient/<vault-hash>/logs/`.

- [ ] **Step 3: Tag the phase done**

If gate green and checklist green:

```bash
git tag -a phase-d-done -m "Phase D: TUI verbs, history/undo, context-event surface, probe hardening"
```

Do NOT push without explicit approval. `main` must stay clean unless the user asks for a fast-forward.

---

## Phase D follow-ups (Phase E candidates)

Out of scope for Phase D, deferred:

1. **Subagent on-demand surface** — `subagent.dispatch`, `subagent.continue`, Tier 2 identity (`composeAgentIdentity`), `SubagentRegistry`, and the NoteEditor / ContextBuilder / Worker runners. Phase E must first add a child-task contract to `ReasoningMutex` so a subagent can run inside the orchestrator's chat slot without preempting the parent. The handoff's Phase E brief lists this as a prerequisite.
2. **`subagent.continue`** — once subagents land, mid-loop approvals piggyback on the existing `chat.approve` RPC by routing approvals back to the parent envelope.
3. **`notient stream`** — long-lived NDJSON stream of background events (spec section 6 Phase D deliverable, deferred to Phase E because the resync semantics on client reconnect need their own design).
4. **`notient export-canvas <proposalId>`** — JSON Canvas export for proposal clusters.
5. **`notient propose <kind> <payload-json>`** — direct proposal creation outside the chat surface.
6. **Auto-reconnect in the TUI** — currently exits cleanly on daemon drop; Phase E adds reconnection.
7. **`@`-completion popup** with arrow-key navigation — Phase D ships Tab-only.
8. **Full Obsidian bridge surface** (write-style + strict-Obsidian verbs) — Phase E.
9. **`recordHistoryAutoApprove`** — currently a noop in bootstrap. Phase E wires it into a separate audit log so the auto-approval decision is recoverable independent of the resulting write.

---

## What this revision changed (compared to the 2026-04-28 first draft)

Two pre-execution reviews (Opus 4.7 plan reviewer + Codex adversarial) flagged a substrate blocker (`ReasoningMutex.runPriority` is preemptive) and a duplicate-substrate hazard (a planned `HistoryStore` JSON sidecar reinvents the already-shipped `HistoryService` + sqlite + inverters). The first draft also assumed `vault.list(folder)` did filename-prefix filtering, which `FsVault.list` does not. Codex confirmed both by reading the actual files.

Material changes in this revision:

- **Subagents removed entirely from Phase D.** The dispatch surface, Tier 2 identity, registry, and the smoke pass that exercised them are gone. Phase E now owns subagents, gated on a `ReasoningMutex` child-task contract.
- **`HistoryStore` and `reversals.ts` removed entirely.** Phase D wires the existing `HistoryService` through the chat tool factory closure (replacing the noop `recordHistory: async () => 0` in bootstrap) and reads it via three thin RPC handlers.
- **`vault.list` shape changed** to match `FsVault.list(folder)` — single-level folder listing with a separate filename `filter` parameter. The TUI's `@`-completion parses `@<folder>/<partial>` accordingly.
- **`notes.read` RPC added explicitly** as the backing for `/read` (the first draft referenced `notes.read` but never declared the handler).
- **`loop:context_overflow_warning` event added** so operators running 8K-context models with the new 200_000 default see the mismatch on the first overflowing turn.
- **`loop:tool_mode_probed` event added** so operators see whether the probe needed a retry.
- **`@`-completion regex relaxed** to allow `.` after a folder boundary so `@inbox/foo.md` completes.
- **Tool-mode probe second attempt** now requires every returned tool call to have non-empty required arguments before classifying as `native` (proxy for the malformed-args case Codex flagged).
- **Task count drops from 20 to 15.** Plan size drops by roughly half. Risk register and parallelism rules updated accordingly.
