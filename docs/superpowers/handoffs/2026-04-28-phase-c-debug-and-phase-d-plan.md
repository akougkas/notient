# Phase C Debug + Phase D Planning Handoff

**Date:** 2026-04-28
**From session:** Phase C execution + manual TUI testing against vaultex
**Branch:** `beta-spec` (also fast-forwarded to `main`, pushed to `origin/main`)
**Last commit:** `e90615f feat(llm): surface upstream body on chatWithTools failure`

---

## Where we are

Phase A (RPC daemon + socket), Phase B (substrate: indexer, search, vitals, coordinator), and Phase C (chat surface: 4-agent identity, ApprovalGate, ToolRegistry, ChatService, OpenTUI) all landed and gated green. 20 commits on `beta-spec` for Phase C; gate runs `bun run typecheck && bun run lint && bun test && bun run build:cli && bun run smoke:cli:phase{A,B,C}` clean against live LM Studio at `192.168.86.143:1234`.

The substrate works end-to-end: `bun dist/notient.js chat "<prompt>"` round-trips a single turn, the agent calls `vault.search_notes`, results stream back, conversation persists to `Notient/conversations/<date> <slug>.md`, embeddings index in `.notient/.index.json`. Verified against vaultex (903 notes, 9,139 chunks, 59,446 graph nodes after awaken).

Read the Phase C plan at `docs/superpowers/plans/2026-04-27-cli-phase-c.md` and the manual TUI checklist at `docs/superpowers/plans/2026-04-27-cli-phase-c-checklist.md` before touching code. The user's CLAUDE.md (`.claude/CLAUDE.md` and `~/.claude/CLAUDE.md`) sets the prose rules and architecture invariants — honor them.

---

## What broke during manual testing

The user opened the TUI against vaultex, sent one prompt successfully, and reported "multi-turn does not work." Forensics on `Notient/conversations/`:

| File | Size | Pattern |
|------|------|---------|
| `2026-04-28 tui-session 946b57.md` | 15KB | One real exchange: `agentic coding` query, agent ran `vault.search_notes`, returned 10 hits in a markdown table. `message_count: 4` (user + assistant-with-tool-call + tool-result + assistant-final). |
| `2026-04-28 tui-session 8fd4b3.md` | 266B | Stub — `chat.start` fired, no `chat.send` followed. |
| `2026-04-28 tui-session 63860f.md` | 266B | Same. |
| `2026-04-27 single-shot {1d05f4, ac745a, b86879}.md` | 266B each | Same. Single-shot CLI started conversations that errored before send. |
| `2026-04-27 single-shot {288d99, 2ef63e}.md` | 7.6KB / 8.5KB | Two real single-shot exchanges — TDD search confirmations from earlier. |

The agent's last message in `946b57` ends with "Let me know which note(s) you'd like to dive deeper into!" — implying a follow-up was attempted and failed silently.

### Three suspected root causes (rank by likelihood, debug top-down)

#### 1. Context bloat over turns *(most likely)*

`src/daemon/bootstrap.ts:contextSettings` hardcodes `modelContextTokens: 32_000`. The Nemotron-Cascade-2-30B model on dynamo actually has a 1M context window split across parallel slots (per `~/.claude/CLAUDE.md` + `.claude/CLAUDE.md`). Each turn appends:

- `userMessage` (small)
- `assistant` with tool calls (small)
- `tool` role message carrying the **full JSON** of `vault.search_notes` results (~3KB for 10 hits, including snippets with embedded base64 of nothing in particular but big regardless)
- `assistant` final response (~1.5KB markdown table)

By turn 2, history alone is ~5KB ≈ 1,250 tokens. Add the eight-layer system prompt (Tier 1 identity, vault snapshot, workspace state, pinned context, cross-session memory, tool catalog with 14 tools at ~150 tokens each = 2,100 tokens, history). With `contextBudgetFraction: 0.7` of 32K = 22,400 token budget, this likely fits — but `ContextManager` may be triggering its summarization path (oldest 50% replaced by a summary message) silently mid-turn, which itself runs an LLM call that can fail.

**Repro:** Run two consecutive `chat.send` calls against the same `conversationId` via the daemon (skip the TUI entirely). If turn 2 fails with `LLM 400` or `LLM 500`, this is the cause.

**Fix direction:**
- Pull `modelContextTokens` from settings (add `chat.modelContextTokens` to `NotientSettings`); default to 200_000 to start, document why.
- Audit `ContextManager.compose()` for silent summarization triggers; surface a `loop:context_summarized` event when it fires so the wire layer (and tests) can observe.
- Consider trimming tool-result `data` to a shorter form before embedding in conversation history (e.g., omit `chunkId`, snippet truncation). Today `agentLoop` stuffs the full `data` JSON as the `tool` message content.

#### 2. TUI input buffer race *(explains the 266-byte stubs)*

`src/cli/tui/runtime.tsx:104` defines `handleKey` via `useCallback` with deps `[busy, buffer, onExit, submit]`. Every keystroke updates `buffer`, which recreates `handleKey`, which `useKeyboard` re-subscribes. Fast typing or an enter-press during the React render commit can route to a stale closure with the old buffer.

**Repro:** Open the TUI, type a message rapidly, press enter. Watch `Notient/conversations/` for a stub or a chopped message.

**Fix direction:**
- Move buffer to a ref (`useRef`) instead of state for the keypress handler; render the visible buffer from a separate state that ticks on commit.
- Or: hold buffer in state, but read it inside `handleEditingKey` via the latest-state pattern (functional setState that captures + submits).
- Audit OpenTUI's `useKeyboard` impl in `node_modules/@opentui/react/src/hooks/use-keyboard.d.ts` to confirm the subscribe/unsubscribe lifecycle.

#### 3. Missing /approve in TUI *(explains write-tool stalls)*

`src/cli/tui/slashCommands.ts` ships `/help, /search, /awaken, /vitals, /health, /clear, /quit` only. Phase C plan locked decision 6 deferred `/approve, /undo, /history, /apply` to Phase D. If the user's follow-up triggered any `notes.*` tool, the agent's request stalls at `loop:approval_pending` with no UI to resolve it. The TUI shows the line but has no verb to call `chat.approve`.

**Fix direction:** Add `/approve <callId> [reason]` and `/deny <callId> [reason]` to `slashCommands.ts`. Wire them through the existing `chat.approve` RPC. Show pending approval lines with a colored prefix and a hint.

---

## Caveats from this session (already known, document not re-discover)

1. **Tool-mode auto-probe is flaky.** `src/core/chat/toolModeProbe.ts` sometimes returns `"disabled"` for tool-capable models that just didn't tool-call on the simple `echo` probe. Bootstrap now persists successful probes via `SettingsService.update(chat.toolModeByModel)`. The vaultex config has `nemotron-cascade-2-30b-a3b-i1: native` pinned manually. Phase D should harden the probe (try the call 3x, larger temperature variance, OR check model metadata first).
2. **Build is two-bundle.** `scripts/build-cli.ts` emits `dist/notient.js` (CLI) and `dist/daemon.js` (daemon). Splitting flag emits chunks for the OpenTUI runtime + tree-sitter assets. `src/cli/client.ts:resolveDaemonEntry` switches between dev (`src/daemon/index.ts`) and bundled (`dist/daemon.js`) based on `import.meta.url` extension.
3. **First chatWithTools call sometimes 400/500.** Transient, model warmup. `lmStudioProvider.chatWithTools` now surfaces the response body in the error message so the daemon's `loop:error` carries diagnostic detail. With `NOTIENT_DEBUG_LLM=1` the request body dumps to `/tmp/notient-llm-request-<ts>.json`.
4. **`/read` is a stub.** It currently routes to the same handler as `/vitals`. Phase D should wire a real vault-read RPC.
5. **Vision is opt-in.** Primary model probe runs at bootstrap; if it accepts the 1x1 PNG, vision goes through the primary. Otherwise refuses with `VISION_UNAVAILABLE`. Configure `chat.vision: { enabled, baseUrl, model }` to add a fallback.
6. **History recording is a noop.** `ApprovalGate.recordHistoryAutoApprove` returns immediately. Phase D should wire the existing `historyService` (already in the kernel) into chat write tools so undo works.
7. **Approvals stall in TUI.** As noted above. `/approve` is the missing verb.
8. **The OpenTUI manual checklist (`docs/superpowers/plans/2026-04-27-cli-phase-c-checklist.md`) was never visually verified.** The smoke harness covers the wire layer end-to-end, but the 8-item TUI interaction checklist is open.

---

## Your mandate

### Part 1: Debug the multi-turn failure (priority 1)

1. **Reproduce without the TUI.** Write a small node script (e.g., `scripts/repro-multi-turn.ts`) that:
   - Starts the daemon (or connects to a running one).
   - Calls `chat.start` to get a `conversationId`.
   - Calls `chat.send` with prompt 1 (e.g., `"what notes mention TDD?"`); drains until `turn:complete`.
   - Calls `chat.send` again with prompt 2 (e.g., `"tell me more about the first one"`); drains.
   - Asserts both turns produce a `turn:complete` and the second response references the first turn's content.
2. **If the script fails:** the bug is in the substrate (suspect 1), not the TUI. Capture the daemon's `loop:error` or `turn:aborted` reason, dump the request body via `NOTIENT_DEBUG_LLM=1`, and identify whether the failure is context-size, summarization, or LLM-side.
3. **If the script passes:** the bug is in the TUI (suspect 2 or 3). Reproduce in a real terminal session; instrument `runtime.tsx` to log keystroke + buffer state to a debug file (e.g., `~/.notient/<vault-hash>/logs/tui.log`) so we can see the input loop without breaking the rendering.

Use **superpowers:systematic-debugging** for the diagnosis. Use **superpowers:test-driven-development** for the fix — add a substrate-level test for the multi-turn path under `src/core/chat/chatService.test.ts` if one doesn't already cover the post-turn-complete conversation reuse.

### Part 2: Plan Phase D

The spec at `docs/superpowers/specs/2026-04-27-notient-cli-design.md` outlines the full surface. Phase D's job (per spec section 6) is to land the on-demand subagent dispatch + the missing slash verbs. Suggested scope:

1. `/approve <id>` + `/deny <id>` in the TUI (closes caveat 7).
2. `vault.list` RPC + `@`-completion in the input bar (closes the `cli/tui/attachments.ts` stub from Phase C).
3. `notes.history` + `/undo` (closes caveat 6).
4. Tier 2 identity prompts under `src/agent/agentIdentity.ts` for on-demand subagents (read the archived `.nuked/src/core/agents/agentIdentity.ts` for the existing structure; do not import from `.nuked`).
5. Subagent on-demand tool surface — the spec lists `subagent.dispatch` + `subagent.continue`.
6. Hardened tool-mode probe (closes caveat 1).
7. Real `/read` verb (closes caveat 4).
8. `modelContextTokens` from settings + a `loop:context_summarized` event (closes suspect 1 from Part 1).

Use **superpowers:brainstorming** to explore intent + tradeoffs before writing the plan. Then use **superpowers:writing-plans** to produce `docs/superpowers/plans/2026-04-28-cli-phase-d.md` with the same shape as the Phase C plan (locked decisions, hard rules, risks, file structure, task DAG, parallelism rules, smoke harness).

### Part 3: Verify, commit, push

After Phase C debug fixes land:
- Run the full Phase C gate (`bun run typecheck && bun run lint && bun test && bun run build:cli && bun run smoke:cli:phase{A,B,C}`).
- Add a multi-turn smoke pass to `scripts/smoke-cli-phaseC.ts` (or a new `smoke:cli:phaseC-multiturn.ts` if structurally cleaner).
- Manually run the TUI checklist against vaultex.
- Commit each fix as a separate logical commit (no `git add -A`, stage by name).
- Don't push to `origin/main` without explicit approval — main was last updated 2026-04-27 with the Phase C merge.

---

## Reference paths

- Plan: `docs/superpowers/plans/2026-04-27-cli-phase-c.md`
- Spec: `docs/superpowers/specs/2026-04-27-notient-cli-design.md`
- TUI checklist: `docs/superpowers/plans/2026-04-27-cli-phase-c-checklist.md`
- Conversations to replay: `/mnt/c/Users/akougk/Projects/vaultex/Notient/conversations/2026-04-28 tui-session 946b57.md`
- Project CLAUDE.md: `.claude/CLAUDE.md` (architecture, anti-patterns, prose rules)
- User CLAUDE.md: `~/.claude/CLAUDE.md` (prose rules, communication style)

## Hard rules

- TypeScript strict, no `any` without justification.
- No `console.log` outside `src/cli/output.ts` and `debug<Subsystem>` helpers.
- No abbreviations: `context` not `ctx`, `error` not `err`, `message` not `msg`.
- No `[noun] - [parenthetical clause]` dash-clause prose.
- One logical commit per step. Never `git add -A`.
- Never push role branches; never force-push to `main`.
- Substrate tests stay green throughout. New tests are additive.
- Do not import from `.nuked/`. Reference only.

## Start here

1. Read this whole document.
2. Read `docs/superpowers/plans/2026-04-27-cli-phase-c.md` (locked decisions section).
3. `git log --oneline c911b7c..HEAD` to see what landed in Phase C.
4. Reproduce the multi-turn failure (Part 1, step 1).
5. Drive from there.
