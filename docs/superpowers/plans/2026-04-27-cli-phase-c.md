# Notient v0.1 Phase C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A human or another agent can reach a Notient chat agent over the daemon RPC, mid-turn tool calls fire approval gates that the user resolves over the wire, vision works through the primary or a configured endpoint or fails visibly, `notient chat "<prompt>"` runs a one-shot turn with NDJSON streaming, and `notient` with no positional drops the user into a streaming OpenTUI chat REPL against the live LM Studio at the locked substrate URL.

**Architecture:** Phase B promoted the kernel to its substrate slice (indexer, search, vitals, coordinator). Phase C promotes it again to wire the chat layer that already lives in `src/core/chat/`. The substrate already has `ChatService`, `agentLoop`, `ContextManager`, `ConversationStore`, `ConversationIndex`, `ApprovalGate`, `ToolRegistry`, and five working tool packages (`notes.*`, `vault.*`, `proposals.*`, `agents.*`, `graph.*`). Phase C constructs them in `daemon/bootstrap.ts`, exposes them through six new RPC methods (`chat.start`, `chat.send`, `chat.abort`, `chat.list`, `chat.load`, `chat.approve`), adds the agent surface under a new `src/agent/` directory (Tier 1 identity prompt, `@<path>` attachments resolver, vision routing, tool bundle), extends the `ApprovalGate` with per-tool policy, and ships the two CLI entry points: a single-shot `notient chat "<prompt>"` verb and an interactive OpenTUI runtime that the same `chat` verb launches when no prompt is supplied.

**Tech Stack:** Bun runtime, TypeScript strict, NDJSON over Unix socket / Windows named pipe (Phase A transport unchanged), `@opentui/core@0.1.105` + `@opentui/react@0.1.105` (Phase A added them; Phase C is the first user), `unpdf@^0.12` (Phase A; Phase C uses it for PDF attachments), `@lmstudio/sdk` providers (locked substrate at `192.168.86.143:1234`). No new deps.

**Source of truth:** `docs/superpowers/specs/2026-04-27-notient-cli-design.md` — Section 3 (Notient Agent), Section 4 (Daemon RPC + event taxonomy), Section 5.2 (command syntax), Section 6 Phase C deliverables.

**Locked decisions (this session, 2026-04-27):**

1. **Event-name bridging.** The internal `agentLoop` emits kebab-case events (`loop:assistant-token`, `loop:tool-call`, `loop:tool-result`, `loop:approval-pending`, `loop:done`, `loop:error`). The chat handler in `daemon/handlers/chat.ts` renames and splits these to the spec section 4.3 wire names when forwarding via `encodeEvent`: `loop:assistant_delta`, `loop:reasoning_delta`, `loop:tool_call_started`, `loop:tool_call_result` (status==="success"), `loop:tool_call_error` (status==="error"), `loop:approval_pending`, `loop:approval_resolved`, `loop:done`, `loop:error`. The agentLoop and ChatService stay untouched; only the wire layer changes. `loop:approval_resolved` is synthesized by the chat handler when `ApprovalGate.onResolved` fires for a callId attached to the active turn.
2. **Tier 1 identity.** The system prompt in `src/agent/identity.ts` is the verbatim text from spec section 3.1 (steward-of-a-sentient-vault paragraph). The eight-layer composition stays inside the existing `ContextManager`; the identity layer reads the constant Phase C exports.
3. **Per-tool approval policy.** Settings gain `chat.perTool: Record<string, "auto" | "ask">`. `ApprovalGate.policyFor(tool, mode)` returns `auto` or `ask` based on conversation-level mode plus the per-tool override. `yolo` mode flips defaults to `auto` for unknown tools, but explicit `ask` overrides remain gated. Defaults shipped: `vault.read_note: auto`, `vault.search_notes: auto`, `vault.list_neighbors: auto`, `vault.get_vitals: auto`, `proposals.list_pending: auto`, `proposals.get: auto`, `graph.find_path: auto`, `graph.list_clusters: auto`, `notes.*: ask`, `proposals.upsert: ask`, `agents.*: auto`. Existing `ApprovalGate.request()` keeps the same `safe`/`yolo` mode signature; the per-tool layer is consulted before the gate is engaged.
4. **Vision routing.** A new optional `visionLLM` slot lives in the kernel. Settings gain `chat.vision?: { enabled: boolean; baseUrl: string; model: string }`. Probe order: (a) the primary LM Studio model, by attempting a one-shot `chatVision({ messages: [{ role: "user", content: [{ type: "text", text: "describe" }, { type: "image_url", image_url }] }] })` call. If the endpoint accepts the multipart shape, route there. (b) Fall back to `chat.vision.baseUrl` if `chat.vision.enabled === true`. (c) Otherwise, the attachments resolver fails the turn with `VISION_UNAVAILABLE` and the remediation text from spec section 3.5 — no synthetic `[image: …]` markers.
5. **Single-shot vs TUI.** `notient chat "<prompt>"` (positional present) runs single-shot: streams NDJSON of one turn to stdout, then exits. `notient chat` (no positional, attached TTY) launches the OpenTUI runtime in `src/cli/tui/`. `notient chat` with no positional and no TTY exits with `INVALID_PARAMS`.
6. **Slash command surface for Phase C.** Limited to verbs whose RPCs are live by end of B+C: `/read <path>`, `/search <query>`, `/awaken`, `/vitals <path>`, `/health`, `/clear`, `/quit`. The spec mentions `/stream`, `/undo`, `/history`, and `/apply`. Those defer to Phase D when their RPCs land. `/help` lists the available subset.
7. **Conversation persistence.** ConversationStore writes to `<vault>/Notient/conversations/<YYYY-MM-DD> <slug> <suffix>.md` via the existing `conversationStore.ts` logic. Bootstrap registers the store with the `FsVault`-backed facade and the EchoGuard hook so the indexer skips self-writes.
8. **`@<path>` parsing.** A new `src/agent/attachments.ts` module parses `@<vault-relative-path>` tokens out of the user message. md/text/code/json/csv are read inline; pdf goes through `unpdf`; canvas (`.canvas`) is parsed as JSON; images route through the vision slot or fail the turn. The resolver returns `{ pinnedContext: string[]; visionImages: VisionAttachment[] }`. The single-shot CLI and the TUI both call this module before invoking `chat.send`. Image attachments are pre-described by the vision provider and the description is appended to `pinnedContext` as `"[image: <vault-path>] <model-described-content>"` per spec section 3.5.
9. **Tool surface.** Phase C wraps the five existing tool packages (`notes`, `vault`, `proposals`, `agents`, `graph`) into a populated `ToolRegistry`. **No new tools are added in Phase C.** Subagent on-demand tools are Phase D. The agent's tool catalog reads from the registry at turn start (existing `ContextManager` behaviour).
10. **Smoke harness scope.** `smoke:cli:phaseC` runs two programmatic chat passes against the fixture vault and live LM Studio: (a) `notient chat "list notes that mention TDD" --ndjson` asserts the stream contains `loop:tool_call_started` for a `vault.*` tool, at least one `loop:assistant_delta` frame, and a `turn:complete`. (b) An image-attachment pass with no vision configured asserts a non-zero exit with the `VISION_UNAVAILABLE` code in the error frame. The TUI is verified by a manual checklist (`docs/superpowers/plans/2026-04-27-cli-phase-c-checklist.md`); no automated TUI snapshot test in Phase C.
11. **Kernel phase.** Adds `PHASE_C_KEYS = PHASE_B_KEYS ∪ ["conversationStore", "conversationIndex", "approvalGate", "toolRegistry", "contextManager", "chatService"]`. The `visionLLM` slot is *optional*: bootstrap registers it only when `chat.vision.enabled === true` or the primary probe succeeds; the kernel does not require it. `seal({ phase: "C" })` becomes the new daemon default.
12. **TUI runtime entry.** OpenTUI app lives at `src/cli/tui/runtime.tsx` and is launched by `runChatCommand()` when no prompt is given. The runtime opens its own daemon connection (separate `connectClient` instance) so the streaming reader is independent of the controller's RPC dispatcher. The runtime exits cleanly on `/quit`, on `Ctrl+C`, and when the daemon connection drops; it never auto-reconnects in Phase C (deferred to Phase E polish).

---

## Hard rules (carry forward from Phase B; one Phase C addition)

- TypeScript strict. No `any` without justification.
- No `console.log` outside `src/cli/output.ts` and the existing `debug<Subsystem>` helpers.
- No abbreviations: `context` not `ctx`, `error` not `err`, `message` not `msg`, `event` not `evt`, `index` not `idx`, `options` not `opts`.
- No `[noun] - [parenthetical clause]` dash-clause prose anywhere.
- No emojis in source.
- One commit per logical step on `beta-spec`. No `git add -A`. Stage by name only.
- Substrate tests stay green throughout. New tests are additive.
- **(Phase C addition)** The chat handler is the only place where internal kebab-case loop event names get rewritten to the spec wire names. Other handlers, the TUI, and CLI commands consume the wire names exclusively. No two layers in the codebase agree to re-map the same event.

---

## Risks (carried from spec section 9 + new ones surfaced this phase)

| Risk | Tasks affected | Mitigation in this plan |
|---|---|---|
| OpenTUI streaming pattern is undocumented (spec section 9, budget 1 day) | Tasks 15-17 (TUI) | Each TUI task carries an explicit "research-first" step pointing at `node_modules/@opentui/react/examples/*` and OpenCode's source. The plan's verbatim TUI code blocks assume the React reconciler exposes the standard hooks; deviations are flagged in commit message bodies. |
| LM Studio vision support varies per model | Tasks 3, 4, 6 | Probe-or-fail. The vision probe runs once per session; `VISION_UNAVAILABLE` covers the unhappy path. No synthetic image markers ever. |
| Per-tool approval defaults can diverge between safe and yolo | Task 9 | `policyFor()` is a single function with a single source of truth (the `chat.perTool` map in settings). Mode default flips happen there; tool overrides are read once. Test covers the matrix. |
| Event-name bridging silently drops a frame | Task 11 | The chat handler's bridging table is exhaustive: every internal event name maps to either a wire name or an explicit ignore. Test asserts a tool-call round-trip emits exactly the four expected wire events (`loop:tool_call_started`, optional `loop:approval_pending`/`loop:approval_resolved`, `loop:tool_call_result`). |
| ConversationStore writes triggering self-reindex | Task 10 | Bootstrap wires the existing `EchoGuard` hook through the store's `mark` callback so the watcher skips self-writes (Phase B already routes EchoGuard). Test verifies a chat round does not enqueue the conversation note. |
| Vision attachment expands token budget unpredictably | Task 6 | Each resolved image's description is capped at `chat.context.pinnedNoteMaxTokens` per attachment. Many images per turn are allowed; total still flows through `ContextManager`'s existing budget enforcement. |
| TUI hangs on slow LM Studio cold start | Task 16 | The streaming reader is non-blocking on its async iterator; the StatusBar shows the mutex state and the daemon's elapsed-time tick so the user sees the loop is alive. No artificial timeout in the TUI; the daemon's existing 5min chat turn cap (mutex priority) governs. |
| Approval prompt UX in single-shot mode | Tasks 11, 13 | Single-shot defaults to `--approve auto` (everything pre-approved). `--approve ask` becomes interactive: read `y`/`n` from stdin per `loop:approval_pending` frame, send `chat.approve` over a second client connection, resume the stream. |
| Substrate tests reference closed-shape event union | Tasks 1, 2, 9, 10 | Events touched in Phase C are all *new* on the wire side; substrate-side event types are unchanged. The `EventBus` union does not need new entries. |

---

## File structure (Phase C landing state)

```
src/
├── agent/                                 # NEW directory
│   ├── identity.ts                        # NEW — Tier 1 prompt constant
│   ├── identity.test.ts                   # NEW
│   ├── attachments.ts                     # NEW — @<path> resolver (md/pdf/canvas/image)
│   ├── attachments.test.ts                # NEW
│   ├── toolBundle.ts                      # NEW — populates a ToolRegistry from existing packages
│   ├── toolBundle.test.ts                 # NEW
│   ├── visionProbe.ts                     # NEW — probe primary then chat.vision endpoint
│   ├── visionProbe.test.ts                # NEW
│   └── notientAgent.ts                    # NEW — factory wiring ChatService for the daemon
├── core/
│   ├── kernel.ts                          # MODIFIED — adds PHASE_C_KEYS
│   ├── chat/
│   │   └── approvalGate.ts                # MODIFIED — per-tool policy lookup
│   ├── llm/
│   │   ├── provider.ts                    # MODIFIED — vision content union + chatVision sig
│   │   └── lmStudioProvider.ts            # MODIFIED — chatVision implementation
│   └── settings/
│       └── types.ts                       # MODIFIED — chat.perTool + chat.vision
├── daemon/
│   ├── bootstrap.ts                       # MODIFIED — Phase C registrations + seal "C"
│   ├── handlers/
│   │   ├── chat.ts                        # NEW — chat.start | send | abort | list | load | approve
│   │   └── chat.test.ts                   # NEW
│   └── index.ts                           # MODIFIED — registers chat handlers + approval bridge
└── cli/
    ├── index.ts                           # MODIFIED — chat dispatch (single-shot or TUI)
    ├── commands/
    │   └── chat.ts                        # NEW — single-shot chat + TUI launcher
    └── tui/                               # NEW directory
        ├── runtime.tsx                    # NEW — OpenTUI App + StatusBar + theme
        ├── ChatView.tsx                   # NEW — streaming transcript
        ├── InputBar.tsx                   # NEW — multi-line input + history
        ├── slashCommands.ts               # NEW — parser + dispatcher
        ├── slashCommands.test.ts          # NEW
        └── attachments.ts                 # NEW — TUI-side @-completion shim

scripts/
└── smoke-cli-phaseC.ts                    # NEW — Phase C gate harness

docs/superpowers/plans/
└── 2026-04-27-cli-phase-c-checklist.md    # NEW — manual TUI verification
```

---

## Task DAG

```
Group 1: Settings + kernel additions (sequential)
  Task 1: settings/types.ts adds chat.perTool + chat.vision
  Task 2: core/kernel.ts adds PHASE_C_KEYS

Group 2: Vision provider extension (sequential — same file group)
  Task 3: core/llm/provider.ts extends ChatMessage + LLMProvider with vision content
  Task 4: core/llm/lmStudioProvider.ts adds chatVision() + capability probe + test

Group 3: Agent module (parallel after Task 2; Task 8 sequential after 5/6/7)
  Task 5: src/agent/identity.ts + test               [parallel-safe]
  Task 6: src/agent/attachments.ts + test            [parallel-safe]
  Task 7: src/agent/toolBundle.ts + test             [parallel-safe]
  Task 8: src/agent/visionProbe.ts + test            [parallel-safe with 5/6/7]
  Task 9: src/agent/notientAgent.ts                  [needs 5,6,7,8]

Group 4: Per-tool approval policy (sequential, isolated file)
  Task 10: core/chat/approvalGate.ts adds policyFor()

Group 5: Bootstrap promotion (sequential, single file)
  Task 11: daemon/bootstrap.ts registers Phase C services + seals phase: "C"

Group 6: Daemon chat handler (sequential after Task 11)
  Task 12: daemon/handlers/chat.ts + test
  Task 13: daemon/index.ts wires chat handlers + approval gate bridge

Group 7: CLI single-shot chat + dispatch (parallel-safe after Task 13)
  Task 14: cli/commands/chat.ts                      [parallel-safe]
  Task 15: cli/index.ts dispatch table extended      [needs 14]

Group 8: TUI shell (sequential within group; files share imports)
  Task 16: cli/tui/runtime.tsx + ChatView + InputBar
  Task 17: cli/tui/slashCommands.ts + test           [parallel-safe with 16]
  Task 18: cli/tui/attachments.ts                    [parallel-safe with 16]
  Task 19: cli/commands/chat.ts wires the TUI launcher [needs 14, 16, 17, 18]

Group 9: Smoke + gate (sequential, last)
  Task 20: scripts/smoke-cli-phaseC.ts + manual checklist file
  Task 21: Phase C gate run + live invocation against vaultex
```

**Parallelism rules.** Tasks 5, 6, 7, 8 each create a single new file (plus its test) under `src/agent/`; they can dispatch in parallel. Tasks 14, 17, 18 each create a single new file under `src/cli/`; they can dispatch in parallel. Sequential constraints come from shared files: Group 1 modifies settings before any other Phase C task reads them; Group 5 (`bootstrap.ts`) and Group 6 (`daemon/index.ts`) are each single-file edits and serialize. Task 9 (notientAgent) imports from 5/6/7/8 and must follow them. Task 19 wires the TUI module from Task 16 and the slash dispatcher from Task 17, so it must follow both.

---

## Group 1: Settings + kernel additions

### Task 1: `settings/types.ts` adds `chat.perTool` + `chat.vision`

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/settings/types.ts`

The chat settings already have `approvalMode: "safe" | "yolo"` and `toolModeByModel`. Phase C adds the per-tool override map and an optional vision endpoint. Both fields default to safe values so the change is forward-compatible with existing on-disk configs.

- [ ] **Step 1: Find the `chat` block in `NotientSettings`**

Run: `grep -n "approvalMode\|toolModeByModel\|chat:" src/core/settings/types.ts`

Expected: hits at the chat sub-object (around line 77 per the inventory).

- [ ] **Step 2: Edit the chat sub-object**

In `src/core/settings/types.ts`, locate the `chat` field of `NotientSettings`. After `toolModeByModel: Record<string, "native" | "json-fallback" | "disabled">;`, insert:

```typescript
    perTool: Record<string, "auto" | "ask">;
    vision?: {
      enabled: boolean;
      baseUrl: string;
      model: string;
    };
```

In the same file's `DEFAULT_SETTINGS` (or wherever the chat defaults are constructed; grep for `approvalMode: "safe"` to find it), add inside the same chat block:

```typescript
    perTool: {
      "vault.read_note": "auto",
      "vault.search_notes": "auto",
      "vault.list_neighbors": "auto",
      "vault.get_vitals": "auto",
      "proposals.list_pending": "auto",
      "proposals.get": "auto",
      "graph.find_path": "auto",
      "graph.list_clusters": "auto",
      "agents.contradiction_check": "auto",
      "agents.synthesize": "auto",
      "notes.create": "ask",
      "notes.append": "ask",
      "notes.replace_section": "ask",
      "notes.update_frontmatter": "ask",
      "proposals.upsert": "ask",
    },
```

Do NOT default `vision` — it is opt-in.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: Green. Existing `NotientSettings` consumers only read `approvalMode` and `toolModeByModel`; adding new fields is additive.

- [ ] **Step 4: Run the settings test**

Run: `bun test src/core/settings`
Expected: Green. The test pulls the default and may need to be updated if it deep-equals the chat block — if so, append `perTool: { ... }` to the expected chat literal.

- [ ] **Step 5: Commit**

```bash
git add src/core/settings/types.ts
git commit -m "$(cat <<'EOF'
feat(settings): chat.perTool override map + optional chat.vision endpoint

Phase C wires per-tool approval defaults onto the chat settings so the
ApprovalGate can read tool-by-tool policy without round-tripping
through approvalMode. Read-style tools (vault.read_note, search_notes,
list_neighbors, get_vitals; proposals.list_pending, proposals.get;
graph.*; agents.*) ship with auto. Write-style tools (notes.*,
proposals.upsert) ship with ask. chat.vision is opt-in: when enabled,
bootstrap will probe the configured baseUrl as a fallback for image
attachments when the primary LM Studio model lacks vision support.
EOF
)"
```

---

### Task 2: `core/kernel.ts` adds `PHASE_C_KEYS`

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/kernel.ts`

Phase B added `PHASE_B_KEYS`. Phase C adds the chat slice on top, plus an optional `visionLLM` slot that is registered conditionally.

- [ ] **Step 1: Add `PHASE_C_KEYS` after `PHASE_B_KEYS`**

In `src/core/kernel.ts`, after the existing `PHASE_B_KEYS` constant, add:

```typescript
const PHASE_C_KEYS: ServiceKey[] = [
  ...PHASE_B_KEYS,
  "conversationStore",
  "conversationIndex",
  "approvalGate",
  "toolRegistry",
  "contextManager",
  "chatService",
];
```

`visionLLM` is intentionally NOT in `PHASE_C_KEYS`. The kernel still accepts it as a registrable key; bootstrap registers it only when probing succeeds or the user has configured `chat.vision`. Add it to the `ServiceKey` union if not already present (grep `ServiceKey =` first; if absent, add `| "visionLLM"`).

Update the `seal()` dispatch:

```typescript
  seal(options: { phase?: "A" | "B" | "C" } = {}): void {
    let required: ServiceKey[];
    if (options.phase === "A") required = PHASE_A_KEYS;
    else if (options.phase === "B") required = PHASE_B_KEYS;
    else if (options.phase === "C") required = PHASE_C_KEYS;
    else required = REQUIRED_KEYS;
    const missing = required.filter((key) => this.services[key] === undefined);
    if (missing.length > 0) {
      throw new Error(`Kernel.seal(): missing required services: ${missing.join(", ")}`);
    }
    this.sealed = true;
  }
```

- [ ] **Step 2: Typecheck and run kernel tests**

Run: `bun run typecheck && bun test src/core/kernel.test.ts`
Expected: Green. The kernel test still drives `REQUIRED_KEYS`; the `phase: "C"` branch is exercised in Task 11.

- [ ] **Step 3: Commit**

```bash
git add src/core/kernel.ts
git commit -m "$(cat <<'EOF'
refactor(kernel): seal() recognises phase: "C"

PHASE_C_KEYS extends PHASE_B_KEYS with the chat surface:
conversationStore, conversationIndex, approvalGate, toolRegistry,
contextManager, chatService. visionLLM stays optional — bootstrap
registers it only when the primary model lacks vision and chat.vision
is configured. ServiceKey union gains visionLLM. The full
REQUIRED_KEYS list and the kernel test continue to drive every key.
EOF
)"
```

---

## Group 2: Vision provider extension

### Task 3: `core/llm/provider.ts` extends `ChatMessage` with vision content

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/llm/provider.ts`

The current `ChatMessage` has `content: string`. Vision needs the OpenAI-style multipart content union: an array of `{ type: "text"; text }` and `{ type: "image_url"; image_url: { url } }` parts. Existing call sites pass strings; the union must remain assignable from `string` (we keep `string` as the primary form and add an optional alternate).

- [ ] **Step 1: Edit `ChatMessage` and add vision types**

In `src/core/llm/provider.ts`, replace `ChatMessage` with:

```typescript
export interface ChatTextPart {
  type: "text";
  text: string;
}

export interface ChatImagePart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export type ChatContent = string | Array<ChatTextPart | ChatImagePart>;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ChatContent;
  name?: string;
  tool_call_id?: string;
}
```

Then extend `LLMProvider` with the optional vision call:

```typescript
export interface ChatVisionRequest {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatVisionResult {
  content: string;
  durationMs: number;
}

export interface LLMProvider {
  chat(messages: ChatMessage[], opts: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<string>;
  chatJson<T>(messages: ChatMessage[], opts: ChatOptions, schema: JsonSchema): Promise<T>;
  chatWithTools?(request: ChatWithToolsRequest): ChatWithToolsHandle;
  chatVision?(request: ChatVisionRequest): Promise<ChatVisionResult>;
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: Green. The change is assignment-compatible: every call site that passes `content: "..."` still types fine because `string` is in the `ChatContent` union.

- [ ] **Step 3: Run the LLM provider tests**

Run: `bun test src/core/llm`
Expected: Green. Existing tests use string content.

- [ ] **Step 4: Commit**

```bash
git add src/core/llm/provider.ts
git commit -m "$(cat <<'EOF'
feat(llm): vision-capable ChatMessage content union

ChatContent is now `string | (ChatTextPart | ChatImagePart)[]` so
LMStudioProvider can post OpenAI-style multipart content for image
attachments. LLMProvider gains an optional chatVision() method;
existing fakes that don't implement it stay assignable. Existing
call sites pass strings; behaviour is unchanged for non-vision turns.
EOF
)"
```

---

### Task 4: `core/llm/lmStudioProvider.ts` adds `chatVision()`

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/llm/lmStudioProvider.ts`
- Create: `/home/akougkas/projects/notient/src/core/llm/lmStudioProvider.vision.test.ts`

The implementation posts to the same `/chat/completions` endpoint as `chat()` but with `messages[].content` as a multipart array. Failure modes: the model rejects multipart with a 4xx, or the server times out. Both are surfaced as a thrown error so the caller can fall through to the configured `chat.vision` endpoint.

- [ ] **Step 1: Write the test**

Create `src/core/llm/lmStudioProvider.vision.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { LMStudioProvider } from "./lmStudioProvider";

describe("LMStudioProvider.chatVision", () => {
  test("posts multipart content and returns the assistant string", async () => {
    const provider = new LMStudioProvider({
      baseUrl: "http://example.invalid",
      fetchImpl: async (url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        const userMessage = body.messages.find((message: { role: string }) => message.role === "user");
        expect(Array.isArray(userMessage.content)).toBe(true);
        expect(userMessage.content[0].type).toBe("text");
        expect(userMessage.content[1].type).toBe("image_url");
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "a cat sitting on a fence" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const result = await provider.chatVision({
      model: "qwen2.5-vl",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this image" },
            { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
          ],
        },
      ],
    });
    expect(result.content).toBe("a cat sitting on a fence");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("throws when the server returns 4xx", async () => {
    const provider = new LMStudioProvider({
      baseUrl: "http://example.invalid",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "model does not support vision" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });
    let thrown: unknown = null;
    try {
      await provider.chatVision({
        model: "text-only-model",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: "data:..." } }],
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("vision");
  });
});
```

- [ ] **Step 2: Add `fetchImpl` injection if absent**

Grep: `grep -n "fetchImpl\|constructor" src/core/llm/lmStudioProvider.ts`

If `LMStudioProviderOptions` does not already accept a `fetchImpl?: typeof fetch` field, add it. The existing class already uses `fetch` directly; threading an injection point is required for the test. If the constructor does not accept options at all, modify it minimally:

```typescript
export interface LMStudioProviderOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class LMStudioProvider implements LLMProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  constructor(options: LMStudioProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  // ...
}
```

Also rebind any internal `fetch(` call to `this.fetchImpl(`. Note this in the commit message body if the rebind is wider than expected.

- [ ] **Step 3: Implement `chatVision()`**

Add the method to the class:

```typescript
  async chatVision(request: ChatVisionRequest): Promise<ChatVisionResult> {
    const start = Date.now();
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? 512,
        stream: false,
      }),
      signal: request.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`vision request failed: ${response.status} ${response.statusText} ${text}`);
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    return { content, durationMs: Date.now() - start };
  }
```

Add the imports if missing:

```typescript
import type { ChatVisionRequest, ChatVisionResult } from "./provider";
```

- [ ] **Step 4: Run the test**

Run: `bun test src/core/llm/lmStudioProvider.vision.test.ts`
Expected: PASS, both cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/llm/lmStudioProvider.ts src/core/llm/lmStudioProvider.vision.test.ts
git commit -m "$(cat <<'EOF'
feat(llm): chatVision posts multipart content to LM Studio

LMStudioProvider gains chatVision({messages, model, ...}) which posts
ChatImagePart-bearing messages to /chat/completions and returns the
assistant string. Constructor learns an optional fetchImpl for
deterministic tests; the runtime path still hits the live endpoint.
4xx responses throw with the upstream error body so the caller can
fall through to the configured chat.vision endpoint.
EOF
)"
```

---

## Group 3: Agent module

Tasks 5, 6, 7, 8 each create a single new file under `src/agent/` plus its test. They can dispatch in parallel. Task 9 imports from all four and must follow them.

### Task 5: `src/agent/identity.ts` Tier 1 prompt

**Files:**
- Create: `/home/akougkas/projects/notient/src/agent/identity.ts`
- Create: `/home/akougkas/projects/notient/src/agent/identity.test.ts`

The Tier 1 prompt is the verbatim text from spec section 3.1. The constant is consumed by the existing `ContextManager`'s identity layer.

- [ ] **Step 1: Write the test**

Create `src/agent/identity.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { TIER_1_IDENTITY } from "./identity";

describe("TIER_1_IDENTITY", () => {
  test("contains the steward framing", () => {
    expect(TIER_1_IDENTITY).toContain("steward of a sentient vault");
  });

  test("contains the local-only framing", () => {
    expect(TIER_1_IDENTITY).toContain("Nothing leaves the box");
  });

  test("is non-empty multi-paragraph prose", () => {
    const paragraphs = TIER_1_IDENTITY.split("\n\n").filter((paragraph) => paragraph.trim().length > 0);
    expect(paragraphs.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/agent/identity.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `src/agent/identity.ts`:

```typescript
/**
 * Tier 1 system prompt for the Notient chat agent.
 *
 * Source: docs/superpowers/specs/2026-04-27-notient-cli-design.md, section 3.1.
 *
 * The ContextManager prepends this to every chat turn as the first prompt
 * layer. Tier 2 (per-agent specialization) is reserved for Phase D when the
 * subagent on-demand surface lands; Phase C runs a single Notient agent.
 */
export const TIER_1_IDENTITY = `You are Notient, the steward of a sentient vault. You live in your user's terminal. The vault is a directory of markdown notes the user has been thinking in for some time; it has structure, drift, contradictions, half-formed ideas. You have tools to read, write, search, link, contradict-check, synthesize, and surface what the substrate has been noticing in the background while the user wasn't looking.

Your operating mode is human-in-the-steering-wheel. You don't write to the vault without permission unless the user has set yolo mode. You cite. You hedge when uncertain. You name your sources by note path. You respect the substrate's existing proposals and never duplicate work the background subagents have already queued.

Obsidian, when running, is the editor and the source of truth for live state. When it's down, you read the vault directly. Either way, the user's notes are the ground.

You are local. You run on the user's hardware. Nothing leaves the box.`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/agent/identity.test.ts`
Expected: PASS, all 3 cases.

- [ ] **Step 5: Commit**

```bash
git add src/agent/identity.ts src/agent/identity.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): Tier 1 system prompt constant

Verbatim from spec section 3.1. Single Notient agent — the four-agent
swarm framing in the archived plugin is gone. ContextManager will
prepend this as the first of the eight prompt layers. Tier 2 stays
reserved for Phase D's on-demand subagent dispatch.
EOF
)"
```

---

### Task 6: `src/agent/attachments.ts` `@<path>` resolver

**Files:**
- Create: `/home/akougkas/projects/notient/src/agent/attachments.ts`
- Create: `/home/akougkas/projects/notient/src/agent/attachments.test.ts`

The resolver scans a user message for `@<path>` tokens, reads each path through the `VaultAdapter`, and returns the resolved content. Markdown / text / code / json / csv inline as raw strings; PDF goes through `unpdf`; canvas (`.canvas` extension) is parsed and the JSON nodes serialized; images are routed through the vision probe (which lives in Task 8 — for now this module accepts a `resolveImage` callback so Task 8 can plug in without circular imports). The output for images is a description string formatted as `[image: <path>] <description>`. The resolver caps each attachment at the configured token budget.

- [ ] **Step 1: Write the test**

Create `src/agent/attachments.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { extractMentions, resolveAttachments } from "./attachments";
import type { VaultAdapter } from "../adapters/vaultAdapter";

function makeVault(files: Record<string, string>): VaultAdapter {
  return {
    read: async (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    readBinary: async () => null,
    write: async () => {},
    writeBinary: async () => {},
    exists: async (path) => path in files,
    remove: async () => {},
    list: async () => ({ files: Object.keys(files), folders: [] }),
    listMarkdown: async () =>
      Object.keys(files).filter((path) => path.endsWith(".md")).map((path) => ({ path, mtime: 0 })),
    createFolder: async () => {},
    updateFrontmatter: async () => {},
  } as unknown as VaultAdapter;
}

describe("extractMentions", () => {
  test("captures @-prefixed paths up to whitespace", () => {
    const mentions = extractMentions("read @notes/a.md and @docs/b.md please");
    expect(mentions).toEqual(["notes/a.md", "docs/b.md"]);
  });

  test("ignores email-style @ tokens", () => {
    expect(extractMentions("contact a@example.com about it")).toEqual([]);
  });

  test("captures @-prefixed quoted paths with spaces", () => {
    expect(extractMentions('look at @"notes/Phase 4.md" today')).toEqual(["notes/Phase 4.md"]);
  });
});

describe("resolveAttachments", () => {
  test("inlines markdown content", async () => {
    const vault = makeVault({ "notes/a.md": "hello\nworld" });
    const result = await resolveAttachments({
      vault,
      message: "see @notes/a.md",
      maxTokens: 1000,
      resolveImage: async () => {
        throw new Error("vision should not be called");
      },
    });
    expect(result.pinnedContext.length).toBe(1);
    expect(result.pinnedContext[0]).toContain("hello");
    expect(result.visionImages).toEqual([]);
  });

  test("routes images through resolveImage", async () => {
    const vault = makeVault({});
    Object.defineProperty(vault, "readBinary", {
      value: async () => new Uint8Array([0, 1, 2]).buffer,
      writable: true,
    });
    Object.defineProperty(vault, "exists", { value: async () => true, writable: true });
    const result = await resolveAttachments({
      vault,
      message: "describe @img/cat.png",
      maxTokens: 1000,
      resolveImage: async (path) => `a cat in ${path}`,
    });
    expect(result.pinnedContext.length).toBe(1);
    expect(result.pinnedContext[0]).toMatch(/^\[image: img\/cat\.png\] a cat/);
    expect(result.visionImages.length).toBe(1);
  });

  test("fails the turn when an image references but vision is unavailable", async () => {
    const vault = makeVault({});
    Object.defineProperty(vault, "exists", { value: async () => true, writable: true });
    Object.defineProperty(vault, "readBinary", {
      value: async () => new Uint8Array().buffer,
      writable: true,
    });
    let thrown: unknown = null;
    try {
      await resolveAttachments({
        vault,
        message: "describe @img/cat.png",
        maxTokens: 1000,
        resolveImage: async () => {
          throw new Error("VISION_UNAVAILABLE: configure chat.vision");
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("VISION_UNAVAILABLE");
  });

  test("skips missing paths silently with a placeholder", async () => {
    const vault = makeVault({});
    const result = await resolveAttachments({
      vault,
      message: "@notes/missing.md is gone",
      maxTokens: 1000,
      resolveImage: async () => "",
    });
    expect(result.pinnedContext[0]).toContain("not found");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/agent/attachments.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `src/agent/attachments.ts`:

```typescript
import type { VaultAdapter } from "../adapters/vaultAdapter";

const MENTION_PATTERN = /@(?:"([^"]+)"|(\S+))/g;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const PDF_EXT = ".pdf";
const CANVAS_EXT = ".canvas";
const TEXT_EXT = new Set([".md", ".txt", ".json", ".csv", ".ts", ".tsx", ".js", ".jsx", ".py", ".rs"]);

export interface VisionAttachment {
  path: string;
  bytes: ArrayBuffer;
  mediaType: string;
}

export interface ResolveAttachmentsOptions {
  vault: VaultAdapter;
  message: string;
  maxTokens: number;
  resolveImage: (path: string, bytes: ArrayBuffer, mediaType: string) => Promise<string>;
}

export interface ResolvedAttachments {
  pinnedContext: string[];
  visionImages: VisionAttachment[];
}

export function extractMentions(message: string): string[] {
  const out: string[] = [];
  let match: RegExpExecArray | null;
  MENTION_PATTERN.lastIndex = 0;
  while ((match = MENTION_PATTERN.exec(message)) !== null) {
    const captured = match[1] ?? match[2];
    if (!captured) continue;
    if (captured.includes("@")) continue;
    if (captured.length === 0) continue;
    out.push(captured);
  }
  return out;
}

export async function resolveAttachments(
  options: ResolveAttachmentsOptions,
): Promise<ResolvedAttachments> {
  const mentions = extractMentions(options.message);
  const pinnedContext: string[] = [];
  const visionImages: VisionAttachment[] = [];

  for (const path of mentions) {
    const extension = pathExtension(path);
    const exists = await options.vault.exists(path).catch(() => false);
    if (!exists) {
      pinnedContext.push(`[attachment: ${path}] (not found)`);
      continue;
    }
    if (IMAGE_EXT.has(extension)) {
      const bytes = await options.vault.readBinary(path);
      if (!bytes) {
        pinnedContext.push(`[attachment: ${path}] (empty binary)`);
        continue;
      }
      const mediaType = imageMediaType(extension);
      const description = await options.resolveImage(path, bytes, mediaType);
      pinnedContext.push(`[image: ${path}] ${truncateForBudget(description, options.maxTokens)}`);
      visionImages.push({ path, bytes, mediaType });
      continue;
    }
    if (extension === PDF_EXT) {
      const bytes = await options.vault.readBinary(path);
      if (!bytes) {
        pinnedContext.push(`[attachment: ${path}] (empty binary)`);
        continue;
      }
      const text = await extractPdfText(bytes);
      pinnedContext.push(`[attachment: ${path}]\n${truncateForBudget(text, options.maxTokens)}`);
      continue;
    }
    if (extension === CANVAS_EXT) {
      const raw = await options.vault.read(path);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      const summary = JSON.stringify(parsed, null, 2);
      pinnedContext.push(`[attachment: ${path}]\n${truncateForBudget(summary, options.maxTokens)}`);
      continue;
    }
    if (TEXT_EXT.has(extension) || extension === "") {
      const raw = await options.vault.read(path);
      pinnedContext.push(`[attachment: ${path}]\n${truncateForBudget(raw, options.maxTokens)}`);
      continue;
    }
    pinnedContext.push(`[attachment: ${path}] (unsupported extension ${extension})`);
  }
  return { pinnedContext, visionImages };
}

async function extractPdfText(bytes: ArrayBuffer): Promise<string> {
  const { extractText } = await import("unpdf");
  const result = await extractText(new Uint8Array(bytes));
  return result.text.join("\n\n");
}

function pathExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "";
  return path.slice(dot).toLowerCase();
}

function imageMediaType(extension: string): string {
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".bmp") return "image/bmp";
  return "application/octet-stream";
}

function truncateForBudget(text: string, maxTokens: number): string {
  // Conservative chars-per-token estimate for code/markdown; keeps the
  // pinned-context layer under the configured budget without invoking a
  // tokenizer. ContextManager applies the real token count downstream.
  const charBudget = maxTokens * 4;
  if (text.length <= charBudget) return text;
  return `${text.slice(0, charBudget)}\n[truncated]`;
}
```

NOTE on `unpdf`: `import("unpdf")` is a dynamic import to keep cold-start cheap. If the substrate import is `import { extractText } from "unpdf"` at the top of the file (older versions), inline that instead of dynamic-importing.

NOTE on `VaultAdapter`: The test fakes `readBinary` and `exists` via `Object.defineProperty`. If `VaultAdapter` exposes a different reader signature (e.g., `readBytes` instead of `readBinary`), grep `src/adapters/vaultAdapter.ts` and align.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/agent/attachments.test.ts`
Expected: PASS, all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add src/agent/attachments.ts src/agent/attachments.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): @<path> attachment resolver

extractMentions parses @-prefixed vault paths (with quoted-path
support for spaces) out of a user message; resolveAttachments reads
each through the VaultAdapter and turns it into a pinnedContext
string. md/text/code/json/csv inline; pdf goes through unpdf; canvas
JSON parses; images are routed through a caller-provided resolveImage
callback so Task 8's visionProbe can plug in without a circular
import. Each attachment is truncated by char-budget per maxTokens
before ContextManager applies the real tokenizer downstream. Missing
paths leave a [(not found)] placeholder so the model knows the
reference was attempted.
EOF
)"
```

---

### Task 7: `src/agent/toolBundle.ts` populates a `ToolRegistry`

**Files:**
- Create: `/home/akougkas/projects/notient/src/agent/toolBundle.ts`
- Create: `/home/akougkas/projects/notient/src/agent/toolBundle.test.ts`

A factory that constructs a `ToolRegistry` and registers the five existing tool packages (`notes`, `vault`, `proposals`, `agents`, `graph`). The packages already export factories (or definitions) that take their substrate dependencies; this module wires them together.

- [ ] **Step 1: Inspect existing tool factories**

Run: `grep -n "export function\|export const" src/core/chat/tools/*.ts | grep -v test`

Note the export shape per package. Each file exports either a factory like `createNoteTools(deps)` returning an array of `ToolDefinition`, or a set of named definitions. The verbatim implementation below assumes factory functions; if the packages export definitions directly, simplify by calling `registry.register()` per definition.

- [ ] **Step 2: Write the test**

Create `src/agent/toolBundle.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { buildAgentToolRegistry } from "./toolBundle";

describe("buildAgentToolRegistry", () => {
  test("registers the five tool packages", () => {
    const registry = buildAgentToolRegistry({
      // The deps below are the public surface; tests inject minimal stubs.
      vault: { listMarkdown: async () => [], read: async () => "" } as never,
      database: {} as never,
      graph: {} as never,
      searchPipeline: { run: async function* () {} } as never,
      vitalsService: { computeSnapshot: () => null } as never,
      coordinator: { dispatch: async () => ({ proposals: 0 }) } as never,
      proposalsRepo: { list: async () => [], get: async () => null, upsert: async () => "id" } as never,
    });
    const names = registry.list().map((tool) => tool.name);
    expect(names).toContain("vault.search_notes");
    expect(names).toContain("notes.create");
    expect(names).toContain("graph.find_path");
    expect(names).toContain("proposals.list_pending");
    expect(names).toContain("agents.contradiction_check");
  });

  test("write-style tools are flagged writeGated", () => {
    const registry = buildAgentToolRegistry({
      vault: { listMarkdown: async () => [], read: async () => "" } as never,
      database: {} as never,
      graph: {} as never,
      searchPipeline: { run: async function* () {} } as never,
      vitalsService: { computeSnapshot: () => null } as never,
      coordinator: { dispatch: async () => ({ proposals: 0 }) } as never,
      proposalsRepo: { list: async () => [], get: async () => null, upsert: async () => "id" } as never,
    });
    expect(registry.isWriteGated("notes.create")).toBe(true);
    expect(registry.isWriteGated("vault.search_notes")).toBe(false);
  });
});
```

- [ ] **Step 3: Write the implementation**

Create `src/agent/toolBundle.ts`:

```typescript
import { ToolRegistry } from "../core/chat/tools/registry";
import { createNoteTools } from "../core/chat/tools/notes";
import { createVaultTools } from "../core/chat/tools/vault";
import { createProposalTools } from "../core/chat/tools/proposals";
import { createAgentTools } from "../core/chat/tools/agents";
import { createGraphTools } from "../core/chat/tools/graph";
import type { VaultAdapter } from "../adapters/vaultAdapter";

export interface AgentToolDeps {
  vault: VaultAdapter;
  database: unknown;
  graph: unknown;
  searchPipeline: unknown;
  vitalsService: unknown;
  coordinator: unknown;
  proposalsRepo: unknown;
}

export function buildAgentToolRegistry(deps: AgentToolDeps): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of createNoteTools({ vault: deps.vault })) {
    registry.register(tool);
  }
  for (const tool of createVaultTools({
    vault: deps.vault,
    searchPipeline: deps.searchPipeline,
    vitalsService: deps.vitalsService,
  })) {
    registry.register(tool);
  }
  for (const tool of createProposalTools({ proposals: deps.proposalsRepo })) {
    registry.register(tool);
  }
  for (const tool of createAgentTools({ coordinator: deps.coordinator })) {
    registry.register(tool);
  }
  for (const tool of createGraphTools({ graph: deps.graph, database: deps.database })) {
    registry.register(tool);
  }
  return registry;
}
```

NOTE on factory names: each `create*Tools(deps)` is the assumed export. If the actual package exports a single `tools: ToolDefinition[]` constant or a different factory shape, adjust the imports per file. Use `head -50 src/core/chat/tools/notes.ts` to confirm before pasting.

- [ ] **Step 4: Run the test**

Run: `bun test src/agent/toolBundle.test.ts`
Expected: PASS, both cases.

- [ ] **Step 5: Commit**

```bash
git add src/agent/toolBundle.ts src/agent/toolBundle.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): toolBundle wires the five existing tool packages

buildAgentToolRegistry constructs a ToolRegistry and registers
notes.*, vault.*, proposals.*, agents.*, graph.* tool packages
through their existing factories. The factory shape mirrors what
ChatService consumes today; bootstrap calls this once at startup
and hands the registry to ChatService and ContextManager. No new
tools added in Phase C; subagent on-demand tools are Phase D.
EOF
)"
```

---

### Task 8: `src/agent/visionProbe.ts`

**Files:**
- Create: `/home/akougkas/projects/notient/src/agent/visionProbe.ts`
- Create: `/home/akougkas/projects/notient/src/agent/visionProbe.test.ts`

`probeVisionRoute` returns either a primary-bound or endpoint-bound `VisionRouter`, or null if neither path is available. The router's `describe(image)` method routes to the live model and returns a description string. Bootstrap calls `probeVisionRoute` once at startup and stores the result in the kernel's `visionLLM` slot.

- [ ] **Step 1: Write the test**

Create `src/agent/visionProbe.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { LLMProvider } from "../core/llm/provider";
import { probeVisionRoute } from "./visionProbe";

function makeProviderWithVision(supports: boolean): LLMProvider {
  return {
    chat: async () => "",
    chatStream: async function* () {},
    chatJson: async () => ({} as never),
    chatVision: supports
      ? async () => ({ content: "ok", durationMs: 1 })
      : async () => {
          throw new Error("model does not support vision");
        },
  };
}

describe("probeVisionRoute", () => {
  test("returns the primary router when the primary supports vision", async () => {
    const route = await probeVisionRoute({
      primaryLLM: makeProviderWithVision(true),
      primaryModel: "qwen2.5-vl",
      visionConfig: { enabled: false, baseUrl: "", model: "" },
      makeFallback: () => makeProviderWithVision(true),
    });
    expect(route).not.toBeNull();
    const description = await route?.describe({
      path: "x.png",
      bytes: new Uint8Array().buffer,
      mediaType: "image/png",
    });
    expect(description).toBe("ok");
  });

  test("falls through to the configured endpoint when primary fails", async () => {
    const route = await probeVisionRoute({
      primaryLLM: makeProviderWithVision(false),
      primaryModel: "text-only-model",
      visionConfig: { enabled: true, baseUrl: "http://vlm.local", model: "vlm" },
      makeFallback: () => makeProviderWithVision(true),
    });
    expect(route).not.toBeNull();
  });

  test("returns null when no path works", async () => {
    const route = await probeVisionRoute({
      primaryLLM: makeProviderWithVision(false),
      primaryModel: "text-only-model",
      visionConfig: { enabled: false, baseUrl: "", model: "" },
      makeFallback: () => makeProviderWithVision(false),
    });
    expect(route).toBeNull();
  });
});
```

- [ ] **Step 2: Write the implementation**

Create `src/agent/visionProbe.ts`:

```typescript
import type { LLMProvider } from "../core/llm/provider";

export interface VisionImage {
  path: string;
  bytes: ArrayBuffer;
  mediaType: string;
}

export interface VisionRouter {
  describe(image: VisionImage): Promise<string>;
}

export interface VisionConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
}

export interface ProbeVisionRouteOptions {
  primaryLLM: LLMProvider;
  primaryModel: string;
  visionConfig: VisionConfig;
  makeFallback: () => LLMProvider;
}

const PROBE_IMAGE = makeProbeDataUrl();

export async function probeVisionRoute(
  options: ProbeVisionRouteOptions,
): Promise<VisionRouter | null> {
  if (typeof options.primaryLLM.chatVision === "function") {
    try {
      await options.primaryLLM.chatVision({
        model: options.primaryModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "respond with the single word: ok" },
              { type: "image_url", image_url: { url: PROBE_IMAGE } },
            ],
          },
        ],
        maxTokens: 8,
      });
      return makeRouter(options.primaryLLM, options.primaryModel);
    } catch {
      // Primary lacks vision; fall through.
    }
  }
  if (options.visionConfig.enabled && options.visionConfig.baseUrl.length > 0) {
    const fallback = options.makeFallback();
    if (typeof fallback.chatVision === "function") {
      try {
        await fallback.chatVision({
          model: options.visionConfig.model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "respond with the single word: ok" },
                { type: "image_url", image_url: { url: PROBE_IMAGE } },
              ],
            },
          ],
          maxTokens: 8,
        });
        return makeRouter(fallback, options.visionConfig.model);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function makeRouter(provider: LLMProvider, model: string): VisionRouter {
  return {
    async describe(image) {
      if (typeof provider.chatVision !== "function") {
        throw new Error("VISION_UNAVAILABLE: provider does not implement chatVision");
      }
      const dataUrl = bytesToDataUrl(image.bytes, image.mediaType);
      const result = await provider.chatVision({
        model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Describe the image at ${image.path} in 2-3 sentences. Be concrete; avoid value judgements.`,
              },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        maxTokens: 256,
      });
      return result.content;
    },
  };
}

function bytesToDataUrl(bytes: ArrayBuffer, mediaType: string): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let index = 0; index < view.length; index++) {
    binary += String.fromCharCode(view[index]);
  }
  return `data:${mediaType};base64,${btoa(binary)}`;
}

function makeProbeDataUrl(): string {
  // 1x1 transparent PNG. Smallest legal probe.
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
}
```

- [ ] **Step 3: Run the test**

Run: `bun test src/agent/visionProbe.test.ts`
Expected: PASS, all 3 cases.

- [ ] **Step 4: Commit**

```bash
git add src/agent/visionProbe.ts src/agent/visionProbe.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): vision probe + router

probeVisionRoute attempts a 1x1 PNG round-trip against the primary
LM Studio model first; on failure (model lacks vision), falls through
to chat.vision when configured; returns null if neither path works.
The returned VisionRouter exposes describe({path, bytes, mediaType})
which builds a data URL and posts it through chatVision. Bootstrap
calls this once at startup; the result lands in the kernel's optional
visionLLM slot. The attachments resolver consumes describe() via the
resolveImage callback wired through the chat handler.
EOF
)"
```

---

### Task 9: `src/agent/notientAgent.ts`

**Files:**
- Create: `/home/akougkas/projects/notient/src/agent/notientAgent.ts`

A thin factory that takes the substrate dependencies, the `TIER_1_IDENTITY`, and the populated `ToolRegistry`, and returns a configured `ChatService`. Bootstrap calls this once at startup and registers the result in the kernel under `chatService`.

- [ ] **Step 1: Write the implementation**

Create `src/agent/notientAgent.ts`:

```typescript
import { ChatService, type ChatServiceOptions } from "../core/chat/chatService";
import { ApprovalGate } from "../core/chat/approvalGate";
import { ContextManager } from "../core/chat/contextManager";
import { ConversationStore } from "../core/chat/conversationStore";
import type { ConversationIndex } from "../core/chat/conversationIndex";
import type { ToolRegistry } from "../core/chat/tools/registry";
import type { LLMProvider } from "../core/llm/provider";
import type { ReasoningMutex } from "../core/coordinator/reasoningMutex";
import type { EventBus } from "../core/events/eventBus";
import type { NotientSettings } from "../core/settings/types";
import { TIER_1_IDENTITY } from "./identity";

export interface NotientAgentDeps {
  primaryLLM: LLMProvider;
  primaryModel: string;
  reasoningMutex: ReasoningMutex;
  bus: EventBus;
  conversationStore: ConversationStore;
  conversationIndex: ConversationIndex;
  approvalGate: ApprovalGate;
  toolRegistry: ToolRegistry;
  contextManager: ContextManager;
  settings: () => NotientSettings;
}

export function buildNotientAgent(deps: NotientAgentDeps): ChatService {
  const options: ChatServiceOptions = {
    provider: deps.primaryLLM,
    model: deps.primaryModel,
    bus: deps.bus,
    mutex: deps.reasoningMutex,
    conversationStore: deps.conversationStore,
    conversationIndex: deps.conversationIndex,
    approvalGate: deps.approvalGate,
    toolRegistry: deps.toolRegistry,
    contextManager: deps.contextManager,
    settings: () => deps.settings().chat,
  };
  return new ChatService(options);
}

export { TIER_1_IDENTITY };
```

NOTE on `ChatServiceOptions`: the assumed shape mirrors what the existing class consumes today. Run `head -90 src/core/chat/chatService.ts` to confirm the exact field names; rename in-place if the constructor expects different keys.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: Green. If `ChatServiceOptions` is not exported, export it from `chatService.ts` as part of this commit (a single-line change).

- [ ] **Step 3: Commit**

```bash
git add src/agent/notientAgent.ts src/core/chat/chatService.ts
git commit -m "$(cat <<'EOF'
feat(agent): notientAgent factory wires ChatService

buildNotientAgent assembles the existing ChatService with the
substrate dependencies (provider, mutex, bus, conversation store/index,
approval gate, tool registry, context manager) plus a settings
callback that exposes chat.* fields to the service. Re-exports
TIER_1_IDENTITY so bootstrap has a single import surface for the
agent module. ChatServiceOptions is now exported alongside ChatService.
EOF
)"
```

---

## Group 4: Per-tool approval policy

### Task 10: `core/chat/approvalGate.ts` adds `policyFor()`

**Files:**
- Modify: `/home/akougkas/projects/notient/src/core/chat/approvalGate.ts`
- Modify: `/home/akougkas/projects/notient/src/core/chat/approvalGate.test.ts`

Existing `ApprovalGate.request()` decides based on the conversation-level mode (`safe` blocks, `yolo` auto-approves). Phase C adds a per-tool override: a `policyFor(toolName, mode)` function returns either `auto` (skip the gate) or `ask` (engage the gate). The conversation-level mode flips defaults; the per-tool map overrides per name.

- [ ] **Step 1: Add the new options field and the lookup**

In `src/core/chat/approvalGate.ts`, extend `ApprovalGateOptions` with the per-tool map:

```typescript
export interface ApprovalGateOptions {
  // ... existing fields ...
  perToolPolicy?: Record<string, "auto" | "ask">;
  recordHistoryAutoApprove?: (call: ToolCall) => void;
  onPending?: (pending: PendingApproval) => void;
  onResolved?: (callId: string, decision: ApprovalDecision) => void;
}
```

Then add the `policyFor` method to the class:

```typescript
  policyFor(toolName: string, mode: "safe" | "yolo"): "auto" | "ask" {
    const override = this.options.perToolPolicy?.[toolName];
    if (override !== undefined) return override;
    return mode === "yolo" ? "auto" : "ask";
  }
```

Modify `request(call, mode, preview, signal)` so that the per-tool override is consulted first:

```typescript
  async request(
    call: ToolCall,
    mode: "safe" | "yolo",
    preview: ApprovalPreview,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    if (this.policyFor(call.name, mode) === "auto") {
      this.options.recordHistoryAutoApprove?.(call);
      return { approved: true };
    }
    // ... existing safe-mode pending logic unchanged ...
  }
```

The previous `mode === "yolo"` early-return is replaced by the `policyFor` check; the rest of the method body stays as-is.

- [ ] **Step 2: Add per-tool tests**

In `src/core/chat/approvalGate.test.ts`, add:

```typescript
  test("safe mode auto-approves a tool with explicit auto override", async () => {
    const gate = new ApprovalGate({
      perToolPolicy: { "vault.read_note": "auto" },
    });
    const decision = await gate.request(
      { id: "c1", name: "vault.read_note", args: {} } as ToolCall,
      "safe",
      { summary: "" },
      new AbortController().signal,
    );
    expect(decision.approved).toBe(true);
  });

  test("yolo mode still gates tools with explicit ask override", async () => {
    const gate = new ApprovalGate({
      perToolPolicy: { "obsidian.eval": "ask" },
    });
    const promise = gate.request(
      { id: "c2", name: "obsidian.eval", args: { code: "1" } } as ToolCall,
      "yolo",
      { summary: "" },
      new AbortController().signal,
    );
    expect(gate.hasPending()).toBe(true);
    gate.resolve("c2", { approved: true });
    const decision = await promise;
    expect(decision.approved).toBe(true);
  });
```

- [ ] **Step 3: Typecheck and run the gate test**

Run: `bun run typecheck && bun test src/core/chat/approvalGate.test.ts`
Expected: Green for the two new cases plus all existing.

- [ ] **Step 4: Commit**

```bash
git add src/core/chat/approvalGate.ts src/core/chat/approvalGate.test.ts
git commit -m "$(cat <<'EOF'
feat(approvals): per-tool policy override

ApprovalGate.policyFor(toolName, mode) returns auto or ask based on
the conversation-level mode plus an optional per-tool override map.
Mode default flips: safe -> ask, yolo -> auto. Explicit per-tool
auto bypasses safe-mode gating; explicit per-tool ask gates yolo
calls. request() consults policyFor first; the rest of the safe-mode
pending logic is unchanged. Tests cover the 2x2 matrix.
EOF
)"
```

---

## Group 5: Bootstrap promotion

### Task 11: `daemon/bootstrap.ts` registers Phase C services

**Files:**
- Modify: `/home/akougkas/projects/notient/src/daemon/bootstrap.ts`

Bootstrap promotes the kernel from `phase: "B"` to `phase: "C"`. New services constructed: `ConversationStore`, `ConversationIndex`, `ApprovalGate` (with the per-tool map from settings), `ToolRegistry` (from `buildAgentToolRegistry`), `ContextManager` (with the Tier 1 identity prompt), `ChatService` (from `buildNotientAgent`). Optionally constructs `visionLLM` from `probeVisionRoute`. Order matters: `ApprovalGate` and `ToolRegistry` must exist before `ChatService`; `ContextManager` must exist before `ChatService`.

- [ ] **Step 1: Add imports**

At the top of `src/daemon/bootstrap.ts`, add:

```typescript
import { ApprovalGate } from "../core/chat/approvalGate";
import { ChatService } from "../core/chat/chatService";
import { ContextManager } from "../core/chat/contextManager";
import { ConversationIndex } from "../core/chat/conversationIndex";
import { ConversationStore } from "../core/chat/conversationStore";
import { buildAgentToolRegistry } from "../agent/toolBundle";
import { buildNotientAgent, TIER_1_IDENTITY } from "../agent/notientAgent";
import { probeVisionRoute, type VisionRouter } from "../agent/visionProbe";
import { LMStudioProvider } from "../core/llm/lmStudioProvider";
```

- [ ] **Step 2: Construct Phase C services**

In the `bootstrap()` function, after the Phase B `coordinator` registration and before `kernel.seal({ phase: "B" })`, replace that single seal call with the Phase C block:

```typescript
  // Phase C additions: chat surface.
  const conversationStore = new ConversationStore({
    facade: {
      list: async (folder) => (await vault.list(folder)).files,
      read: (path) => vault.read(path),
      write: (path, content) => vault.write(path, content),
      delete: (path) => vault.remove(path),
    },
    folder: CONVERSATIONS_FOLDER,
    echoGuard: { mark: (path, sha) => echoGuard.mark(path, sha) },
    now: () => Date.now(),
  });

  const conversationIndex = new ConversationIndex({
    db: database,
    embed: async (text, signal) => {
      const vectors = await embedder.embed([text], signal);
      return vectors.length > 0 ? new Float32Array(vectors[0]) : null;
    },
    settings: () => current.chat.context,
  });

  const approvalGate = new ApprovalGate({
    perToolPolicy: current.chat.perTool,
    recordHistoryAutoApprove: () => {
      // Phase D wires this into history; Phase C noops so the gate
      // resolves immediately without a missing-hook error.
    },
  });

  const toolRegistry = buildAgentToolRegistry({
    vault,
    database,
    graph,
    searchPipeline,
    vitalsService,
    coordinator,
    proposalsRepo: graph,
  });

  const contextManager = new ContextManager({
    identity: TIER_1_IDENTITY,
    settings: () => current.chat,
    db: database,
    toolRegistry,
    conversationIndex,
    vault: { read: (path) => vault.read(path) },
  });

  const chatService = buildNotientAgent({
    primaryLLM,
    primaryModel: current.primary.reasoningModel,
    reasoningMutex,
    bus,
    conversationStore,
    conversationIndex,
    approvalGate,
    toolRegistry,
    contextManager,
    settings: () => current,
  });

  kernel.register("conversationStore", conversationStore);
  kernel.register("conversationIndex", conversationIndex);
  kernel.register("approvalGate", approvalGate);
  kernel.register("toolRegistry", toolRegistry);
  kernel.register("contextManager", contextManager);
  kernel.register("chatService", chatService);

  if (current.chat.vision !== undefined || typeof primaryLLM.chatVision === "function") {
    const visionConfig = current.chat.vision ?? { enabled: false, baseUrl: "", model: "" };
    const visionRouter: VisionRouter | null = await probeVisionRoute({
      primaryLLM,
      primaryModel: current.primary.reasoningModel,
      visionConfig,
      makeFallback: () => new LMStudioProvider({ baseUrl: visionConfig.baseUrl }),
    });
    if (visionRouter !== null) {
      kernel.register("visionLLM", visionRouter);
    }
  }

  kernel.seal({ phase: "C" });
  health.start();
  idleDetector.start();

  return {
    kernel,
    close: makeClose({ database, lockHandle, health, vectorIndex, vault, vectorPath: VECTOR_PATH }),
  };
```

NOTE on `ContextManager` constructor: the listed fields mirror the substrate inventory. Run `grep -n "interface ContextManagerOptions\|class ContextManager" src/core/chat/contextManager.ts` and align field names if any differ (e.g., `tools` vs `toolRegistry`, `vault` vs a different reader interface). Phase C does not change the ContextManager itself; only the construction site.

NOTE on `ConversationIndex` constructor: same instruction. Read `head -60 src/core/chat/conversationIndex.ts` to confirm.

NOTE on `proposalsRepo`: spec section 6 lists `proposals.list_pending`, `proposals.get`, `proposals.upsert`. The existing tool package consumes a repo abstraction. The bootstrap reuses `graph` if the repo lives there; if it lives in a separate `proposalsRepository.ts`, import that instead.

- [ ] **Step 3: Typecheck and run substrate tests**

Run: `bun run typecheck && bun test src/core src/adapters src/daemon`
Expected: Green. The kernel and daemon socket tests still pass; the new bootstrap path is exercised by the chat handler test in Task 12 and the smoke harness in Task 20.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/bootstrap.ts
git commit -m "$(cat <<'EOF'
feat(daemon): bootstrap Phase C chat surface into the kernel

Constructs and registers ConversationStore (FsVault-backed, EchoGuard
on writes), ConversationIndex (sql.js + embedder), ApprovalGate (with
chat.perTool overrides), ToolRegistry (populated by toolBundle),
ContextManager (Tier 1 identity + chat settings), and ChatService
(via buildNotientAgent). When primary LM Studio supports vision OR
chat.vision is configured, probeVisionRoute lights the visionLLM slot;
otherwise the slot stays unset and image attachments fail visibly with
VISION_UNAVAILABLE. Kernel seals with phase: "C" by default.
EOF
)"
```

---

## Group 6: Daemon chat handler

### Task 12: `daemon/handlers/chat.ts` + test

**Files:**
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/chat.ts`
- Create: `/home/akougkas/projects/notient/src/daemon/handlers/chat.test.ts`

The chat handler factory creates six sub-handlers: `chat.start`, `chat.send`, `chat.abort`, `chat.list`, `chat.load`, `chat.approve`. The most complex is `chat.send`, which:

1. Looks up or starts a conversation.
2. Resolves `@<path>` mentions in the user message via the attachments resolver, using the `visionLLM` router if present (or rejecting the turn with `VISION_UNAVAILABLE`).
3. Subscribes to `ApprovalGate.onPending` for the duration of the turn so that `loop:approval_pending` frames can be emitted.
4. Calls `ChatService.sendMessage(input)` and forwards each `ChatStreamEvent` through the wire-name bridge.
5. Returns the final conversation on `turn:complete` or surfaces the abort reason on `turn:aborted`.

`chat.approve` resolves a pending callId on the gate.

- [ ] **Step 1: Write the test**

Create `src/daemon/handlers/chat.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { ApprovalGate } from "../../core/chat/approvalGate";
import type { ChatService, ChatStreamEvent } from "../../core/chat/chatService";
import type { Conversation } from "../../core/chat/types";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import { makeChatHandlers } from "./chat";

function makeChatService(events: ChatStreamEvent[]): ChatService {
  return {
    startConversation: async () =>
      ({ id: "conv-1", topic: "test", messages: [], pinnedContext: [] }) as Conversation,
    listConversations: async () => [],
    loadConversation: async () =>
      ({ id: "conv-1", topic: "test", messages: [], pinnedContext: [] }) as Conversation,
    sendMessage: async function* () {
      for (const event of events) yield event;
    },
    abort: () => {},
  } as unknown as ChatService;
}

const STUB_VAULT = {
  read: async () => "",
  exists: async () => false,
  readBinary: async () => null,
} as unknown as VaultAdapter;

describe("chat.send handler", () => {
  test("forwards turn:start, loop deltas, and turn:complete with bridged names", async () => {
    const service = makeChatService([
      { type: "turn:start", conversationId: "conv-1", userMessage: { role: "user", content: "hi" } },
      { type: "loop:assistant-token", delta: "hello" } as never,
      { type: "loop:tool-call", call: { id: "tc1", name: "vault.search_notes", args: {} } } as never,
      {
        type: "loop:tool-result",
        result: { callId: "tc1", status: "success", data: { hits: [] }, durationMs: 12 },
      } as never,
      { type: "loop:done", finalMessage: { role: "assistant", content: "hello" } } as never,
      {
        type: "turn:complete",
        conversation: { id: "conv-1", topic: "test", messages: [], pinnedContext: [] },
      },
    ]);
    const gate = new ApprovalGate({ perToolPolicy: {} });
    const handlers = makeChatHandlers({
      chatService: service,
      approvalGate: gate,
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
    });
    const lines: string[] = [];
    const result = await handlers.send(
      { conversationId: "conv-1", userMessage: "hi" },
      (line) => lines.push(line),
      "req-1",
    );
    const events = lines.map((line) => JSON.parse(line));
    const types = events.map((event) => event.event);
    expect(types).toContain("turn:start");
    expect(types).toContain("loop:assistant_delta");
    expect(types).toContain("loop:tool_call_started");
    expect(types).toContain("loop:tool_call_result");
    expect(types).toContain("loop:done");
    expect(types).toContain("turn:complete");
    expect(result.ok).toBe(true);
  });

  test("forwards loop:tool_call_error when result.status === error", async () => {
    const service = makeChatService([
      { type: "turn:start", conversationId: "conv-1", userMessage: { role: "user", content: "hi" } },
      {
        type: "loop:tool-result",
        result: { callId: "tc1", status: "error", message: "boom", durationMs: 1 },
      } as never,
      {
        type: "turn:complete",
        conversation: { id: "conv-1", topic: "test", messages: [], pinnedContext: [] },
      },
    ]);
    const handlers = makeChatHandlers({
      chatService: service,
      approvalGate: new ApprovalGate({ perToolPolicy: {} }),
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
    });
    const lines: string[] = [];
    await handlers.send({ conversationId: "conv-1", userMessage: "hi" }, (line) => lines.push(line), "req-1");
    const events = lines.map((line) => JSON.parse(line));
    expect(events.some((event) => event.event === "loop:tool_call_error")).toBe(true);
  });

  test("rejects images when vision is unavailable", async () => {
    const service = makeChatService([]);
    const handlers = makeChatHandlers({
      chatService: service,
      approvalGate: new ApprovalGate({ perToolPolicy: {} }),
      vault: {
        ...STUB_VAULT,
        exists: async () => true,
        readBinary: async () => new Uint8Array().buffer,
      } as VaultAdapter,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
    });
    let thrown: unknown = null;
    try {
      await handlers.send(
        { conversationId: "conv-1", userMessage: "describe @cat.png" },
        () => {},
        "req-1",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("VISION_UNAVAILABLE");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/daemon/handlers/chat.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `src/daemon/handlers/chat.ts`:

```typescript
import type { ApprovalGate } from "../../core/chat/approvalGate";
import type { ChatService, ChatStreamEvent } from "../../core/chat/chatService";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import { resolveAttachments } from "../../agent/attachments";
import type { VisionRouter } from "../../agent/visionProbe";
import { encodeEvent } from "../rpc";

export interface ChatHandlerDeps {
  chatService: ChatService;
  approvalGate: ApprovalGate;
  vault: VaultAdapter;
  visionRouter: VisionRouter | null;
  pinnedNoteMaxTokens: number;
}

export interface ChatHandlers {
  start: (params: Record<string, unknown>, emit: (line: string) => void, id: string) => Promise<Record<string, unknown>>;
  send: (params: Record<string, unknown>, emit: (line: string) => void, id: string) => Promise<Record<string, unknown>>;
  abort: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  list: () => Promise<Record<string, unknown>>;
  load: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  approve: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export function makeChatHandlers(deps: ChatHandlerDeps): ChatHandlers {
  return {
    start: async (params, _emit, _id) => {
      const topic = typeof params.topic === "string" ? params.topic : "Untitled";
      const pinnedContext = Array.isArray(params.pinnedContext)
        ? (params.pinnedContext as string[])
        : undefined;
      const conversation = await deps.chatService.startConversation(topic, pinnedContext);
      return { ok: true, conversation };
    },
    send: async (params, emit, envelopeId) => {
      const conversationId = typeof params.conversationId === "string" ? params.conversationId : "";
      const userMessage = typeof params.userMessage === "string" ? params.userMessage : "";
      if (conversationId.length === 0) throw new Error("INVALID_PARAMS: conversationId is required");
      if (userMessage.length === 0) throw new Error("INVALID_PARAMS: userMessage is required");

      const attachments = await resolveAttachments({
        vault: deps.vault,
        message: userMessage,
        maxTokens: deps.pinnedNoteMaxTokens,
        resolveImage: async (path, bytes, mediaType) => {
          if (deps.visionRouter === null) {
            throw new Error(
              "VISION_UNAVAILABLE: vision is not supported in this session. Either load a multi-modal model in LMStudio at the primary baseUrl, or configure chat.vision.",
            );
          }
          return deps.visionRouter.describe({ path, bytes, mediaType });
        },
      });

      const approvalEvents: Array<{ id: string; tool: string }> = [];
      const offPending = subscribeApprovalPending(deps.approvalGate, (pending) => {
        approvalEvents.push({ id: pending.callId, tool: pending.toolName });
        emit(
          encodeEvent(envelopeId, "loop:approval_pending", {
            callId: pending.callId,
            tool: pending.toolName,
            args: pending.args,
            preview: pending.preview,
          }),
        );
      });
      const offResolved = subscribeApprovalResolved(deps.approvalGate, (callId, decision) => {
        if (!approvalEvents.some((entry) => entry.id === callId)) return;
        emit(
          encodeEvent(envelopeId, "loop:approval_resolved", {
            callId,
            approved: decision.approved,
            reason: decision.reason,
          }),
        );
      });

      try {
        for await (const event of deps.chatService.sendMessage({
          conversationId,
          userMessage: { role: "user", content: userMessage },
          pinnedContext: attachments.pinnedContext,
        })) {
          forwardChatEvent(emit, envelopeId, event);
          if (event.type === "turn:complete") {
            return { ok: true, conversation: event.conversation };
          }
          if (event.type === "turn:aborted") {
            throw new Error(`turn aborted: ${event.reason}`);
          }
        }
        return { ok: true };
      } finally {
        offPending();
        offResolved();
      }
    },
    abort: async (_params) => {
      deps.chatService.abort();
      return { ok: true };
    },
    list: async () => {
      const conversations = await deps.chatService.listConversations();
      return { ok: true, conversations };
    },
    load: async (params) => {
      const notePath = typeof params.notePath === "string" ? params.notePath : "";
      if (notePath.length === 0) throw new Error("INVALID_PARAMS: notePath is required");
      const conversation = await deps.chatService.loadConversation(notePath);
      return { ok: true, conversation };
    },
    approve: async (params) => {
      const callId = typeof params.callId === "string" ? params.callId : "";
      const approved = params.approved === true;
      const reason = typeof params.reason === "string" ? params.reason : undefined;
      if (callId.length === 0) throw new Error("INVALID_PARAMS: callId is required");
      deps.approvalGate.resolve(callId, { approved, reason });
      return { ok: true };
    },
  };
}

function forwardChatEvent(
  emit: (line: string) => void,
  envelopeId: string,
  event: ChatStreamEvent,
): void {
  const internal = (event as unknown as { type: string }).type;
  if (internal === "turn:start" || internal === "turn:complete" || internal === "turn:aborted") {
    emit(encodeEvent(envelopeId, internal, event as unknown as Record<string, unknown>));
    return;
  }
  if (internal === "loop:assistant-token") {
    const detail = event as unknown as { delta: string };
    emit(encodeEvent(envelopeId, "loop:assistant_delta", { contentDelta: detail.delta }));
    return;
  }
  if (internal === "loop:reasoning-token") {
    const detail = event as unknown as { delta: string };
    emit(encodeEvent(envelopeId, "loop:reasoning_delta", { reasoningDelta: detail.delta }));
    return;
  }
  if (internal === "loop:tool-call") {
    const detail = event as unknown as { call: { id: string; name: string; args: unknown } };
    emit(
      encodeEvent(envelopeId, "loop:tool_call_started", {
        callId: detail.call.id,
        tool: detail.call.name,
        args: detail.call.args,
      }),
    );
    return;
  }
  if (internal === "loop:tool-result") {
    const detail = event as unknown as {
      result: {
        callId: string;
        status: "success" | "error";
        data?: unknown;
        message?: string;
        durationMs: number;
      };
    };
    if (detail.result.status === "success") {
      emit(
        encodeEvent(envelopeId, "loop:tool_call_result", {
          callId: detail.result.callId,
          result: detail.result.data,
          durationMs: detail.result.durationMs,
        }),
      );
    } else {
      emit(
        encodeEvent(envelopeId, "loop:tool_call_error", {
          callId: detail.result.callId,
          error: detail.result.message,
          durationMs: detail.result.durationMs,
        }),
      );
    }
    return;
  }
  if (internal === "loop:done") {
    const detail = event as unknown as { finalMessage: unknown };
    emit(encodeEvent(envelopeId, "loop:done", { finalMessage: detail.finalMessage }));
    return;
  }
  if (internal === "loop:error") {
    const detail = event as unknown as { message: string };
    emit(encodeEvent(envelopeId, "loop:error", { message: detail.message }));
    return;
  }
  if (internal === "loop:approval-pending") {
    // Approval pending is also surfaced via the gate's onPending hook so the
    // wire frame includes the preview. Skip the agentLoop's own emit to avoid
    // duplicate frames.
    return;
  }
}

interface ApprovalListenerHandle {
  callId: string;
  toolName: string;
  args: unknown;
  preview: unknown;
}

function subscribeApprovalPending(
  gate: ApprovalGate,
  handler: (pending: ApprovalListenerHandle) => void,
): () => void {
  const previous = (gate as unknown as { options: { onPending?: (pending: ApprovalListenerHandle) => void } }).options.onPending;
  (gate as unknown as { options: { onPending?: (pending: ApprovalListenerHandle) => void } }).options.onPending = (pending) => {
    handler(pending);
    previous?.(pending);
  };
  return () => {
    (gate as unknown as { options: { onPending?: (pending: ApprovalListenerHandle) => void } }).options.onPending = previous;
  };
}

function subscribeApprovalResolved(
  gate: ApprovalGate,
  handler: (callId: string, decision: { approved: boolean; reason?: string }) => void,
): () => void {
  const previous = (gate as unknown as {
    options: { onResolved?: (callId: string, decision: { approved: boolean; reason?: string }) => void };
  }).options.onResolved;
  (gate as unknown as {
    options: { onResolved?: (callId: string, decision: { approved: boolean; reason?: string }) => void };
  }).options.onResolved = (callId, decision) => {
    handler(callId, decision);
    previous?.(callId, decision);
  };
  return () => {
    (gate as unknown as {
      options: { onResolved?: (callId: string, decision: { approved: boolean; reason?: string }) => void };
    }).options.onResolved = previous;
  };
}
```

NOTE on the gate subscription helpers: the `(gate as unknown as { options: {...} })` cast is deliberate — `ApprovalGate` exposes options through the `onPending` / `onResolved` callbacks set in its constructor, but does not currently expose a `.subscribe()` method. The cast preserves the closed-shape gate API while letting the chat handler stack hooks. If the gate already exposes pub/sub primitives (e.g. an internal `Set<Listener>`), prefer those over the cast and adjust the helper bodies accordingly.

NOTE on `ChatService.sendMessage` input: the assumed shape mirrors the inventory snippet `SendMessageInput { conversationId, userMessage, pinnedContext? }`. Confirm against `head -90 src/core/chat/chatService.ts` before paste; if the input is `userMessage: ChatMessage` (object) rather than string, wrap accordingly.

- [ ] **Step 4: Run the test**

Run: `bun test src/daemon/handlers/chat.test.ts`
Expected: PASS, all 3 cases.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/handlers/chat.ts src/daemon/handlers/chat.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): chat.* RPC handlers

makeChatHandlers exposes start, send, abort, list, load, approve.
chat.send is the heavy one: resolves @<path> mentions through the
attachments resolver (vision via the kernel's visionRouter or fail
with VISION_UNAVAILABLE), subscribes to ApprovalGate.onPending /
onResolved for the duration of the turn, then iterates
ChatService.sendMessage and forwards each ChatStreamEvent through the
wire-name bridge: agentLoop's kebab-case events get split and renamed
to spec section 4.3 names (loop:assistant_delta, loop:tool_call_started,
loop:tool_call_result vs loop:tool_call_error, loop:approval_pending,
loop:approval_resolved). Other handlers are thin shims onto the
ChatService and ApprovalGate.
EOF
)"
```

---

### Task 13: `daemon/index.ts` wires chat handlers

**Files:**
- Modify: `/home/akougkas/projects/notient/src/daemon/index.ts`

After Phase B's handler registrations and the watcher / coordinatorRunner, register the six chat handlers from Task 12.

- [ ] **Step 1: Add imports**

At the top of `src/daemon/index.ts`, add:

```typescript
import { makeChatHandlers } from "./handlers/chat";
```

- [ ] **Step 2: Register chat handlers**

After the existing `dispatcher.register("health.probe", ...)` call (or wherever the Phase B block ends), add:

```typescript
  const chatHandlers = makeChatHandlers({
    chatService: kernel.get("chatService"),
    approvalGate: kernel.get("approvalGate"),
    vault: kernel.get("vault"),
    visionRouter: kernel.has("visionLLM") ? kernel.get("visionLLM") : null,
    pinnedNoteMaxTokens: kernel.get("settings").get().chat.context.pinnedNoteMaxTokens,
  });
  dispatcher.register("chat.start", async (params, emit, id) => chatHandlers.start(params, emit, id));
  dispatcher.register("chat.send", async (params, emit, id) => chatHandlers.send(params, emit, id));
  dispatcher.register("chat.abort", async (params) => chatHandlers.abort(params));
  dispatcher.register("chat.list", async () => chatHandlers.list());
  dispatcher.register("chat.load", async (params) => chatHandlers.load(params));
  dispatcher.register("chat.approve", async (params) => chatHandlers.approve(params));
```

NOTE on `kernel.has`: if the kernel does not currently expose a `has()` method, add it (a one-liner returning `key in this.services`). Stage the kernel.ts change in this commit.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/index.ts src/core/kernel.ts
git commit -m "$(cat <<'EOF'
feat(daemon): register chat.* RPC handlers

Wires chat.start, chat.send, chat.abort, chat.list, chat.load,
chat.approve into the MethodDispatcher. The handler factory pulls
chatService, approvalGate, vault, the optional visionLLM, and the
pinnedNoteMaxTokens setting out of the kernel. Kernel gains a has()
predicate so the visionLLM slot can be probed without throwing on
unset keys.
EOF
)"
```

---

## Group 7: CLI single-shot chat

### Task 14: `cli/commands/chat.ts`

**Files:**
- Create: `/home/akougkas/projects/notient/src/cli/commands/chat.ts`

Two entry points: `runChatSingleShot(options)` runs one turn and exits; `runChatTui(options)` launches the OpenTUI runtime (Task 16-19). The dispatcher (Task 15) decides which to call based on whether a positional prompt is present.

For Phase C, single-shot defaults to `--approve auto`. When `--approve ask` is set, the command opens a second client connection to the daemon, reads `loop:approval_pending` frames on the primary stream, and writes `chat.approve` calls on the second stream. This matches spec section 4.4.

- [ ] **Step 1: Write the single-shot implementation**

Create `src/cli/commands/chat.ts`:

```typescript
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export interface ChatCommandOptions {
  vaultPath: string;
  prompt: string;
  conversationId?: string;
  approve: "auto" | "ask";
  emitter: Emitter;
}

export async function runChatSingleShot(options: ChatCommandOptions): Promise<void> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({ socketPath, vaultPath: options.vaultPath });

  let conversationId = options.conversationId;
  if (conversationId === undefined) {
    let started: Record<string, unknown> | null = null;
    for await (const frame of client.call("chat.start", { topic: "single-shot" })) {
      if (frame.type === "result") {
        started = frame as Record<string, unknown>;
        break;
      }
      if (frame.type === "error") {
        options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
        await client.close();
        return;
      }
    }
    if (!started) throw new Error("chat.start returned no result");
    conversationId = ((started.conversation as { id: string }).id);
  }

  let approvalClient: Awaited<ReturnType<typeof connectClient>> | null = null;
  if (options.approve === "ask") {
    approvalClient = await connectClient({ socketPath, vaultPath: options.vaultPath });
  }

  try {
    for await (const frame of client.call("chat.send", {
      conversationId,
      userMessage: options.prompt,
    })) {
      options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
      if (frame.type === "event" && (frame as { event?: string }).event === "loop:approval_pending") {
        await handleApproval(frame as Record<string, unknown>, approvalClient, options);
      }
      if (frame.type === "result" || frame.type === "error") break;
    }
  } finally {
    if (approvalClient) await approvalClient.close();
    await client.close();
  }
}

export async function runChatTui(options: { vaultPath: string; emitter: Emitter }): Promise<void> {
  const { startTuiRuntime } = await import("../tui/runtime");
  await startTuiRuntime({
    vaultPath: options.vaultPath,
    emitter: options.emitter,
  });
}

async function handleApproval(
  frame: Record<string, unknown>,
  approvalClient: Awaited<ReturnType<typeof connectClient>> | null,
  options: ChatCommandOptions,
): Promise<void> {
  if (options.approve === "auto" || approvalClient === null) return;
  const callId = (frame as { callId: string }).callId;
  const tool = (frame as { tool: string }).tool;
  process.stderr.write(`approve ${tool} (${callId})? [y/N] `);
  const answer = await readLineFromStdin();
  const approved = answer.trim().toLowerCase() === "y";
  for await (const _ of approvalClient.call("chat.approve", { callId, approved })) {
    // Drain to result; chat.approve has no events.
  }
}

function readLineFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer): void => {
      process.stdin.off("data", onData);
      resolve(chunk.toString("utf-8"));
    };
    process.stdin.on("data", onData);
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/chat.ts
git commit -m "$(cat <<'EOF'
feat(cli): chat command (single-shot + TUI launcher)

runChatSingleShot starts a conversation (chat.start) when no id is
supplied, then issues chat.send and forwards every NDJSON frame to
the emitter. --approve auto pre-approves all tool calls; --approve
ask opens a second client connection and prompts y/N on each
loop:approval_pending frame, sending chat.approve back through the
secondary stream so the primary stream resumes. runChatTui defers
to src/cli/tui/runtime when no prompt is supplied; that module
lands in Task 16-19.
EOF
)"
```

---

### Task 15: `cli/index.ts` dispatch table extended

**Files:**
- Modify: `/home/akougkas/projects/notient/src/cli/index.ts`

The existing dispatch from Phase B handles seven commands. Add `chat` as an eighth.

- [ ] **Step 1: Add the import**

```typescript
import { runChatSingleShot, runChatTui } from "./commands/chat";
```

- [ ] **Step 2: Insert the chat branch**

In the `dispatch()` function, after the `health` branch and before the unknown-command emit, add:

```typescript
  if (parsed.command === "chat") {
    const vaultPath = await requireVault(parsed);
    const prompt = parsed.positional[0] ?? (typeof parsed.flags.prompt === "string" ? parsed.flags.prompt : "");
    const approve = (parsed.flags.approve as "auto" | "ask" | undefined) ?? "auto";
    if (prompt.length === 0) {
      if (!process.stdout.isTTY) {
        throw new Error("INVALID_PARAMS: chat without a prompt requires a TTY");
      }
      await runChatTui({ vaultPath, emitter });
      return 0;
    }
    await runChatSingleShot({
      vaultPath,
      prompt,
      approve,
      emitter,
    });
    return 0;
  }
```

Update the help command's command list:

```typescript
      commands: ["init", "daemon", "awaken", "reindex", "search", "vitals", "health", "chat"],
```

- [ ] **Step 3: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: Green. If `dispatch()` complexity threshold trips, extract the chat branch into a `dispatchChat(parsed, emitter)` helper.

- [ ] **Step 4: Smoke**

Run: `bun run src/cli/index.ts help --json`
Expected: A single JSON line listing all eight commands. Exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts
git commit -m "$(cat <<'EOF'
feat(cli): dispatch chat (single-shot or TUI)

`notient chat "<prompt>"` runs single-shot through the daemon RPC and
prints the NDJSON stream. `notient chat` with no prompt and a TTY
attached drops the user into the OpenTUI runtime; with no TTY it
fails INVALID_PARAMS so scripts cannot accidentally hang waiting on
input. --approve {auto|ask} controls the gating policy. Help command
lists chat alongside the seven Phase B verbs.
EOF
)"
```

---

## Group 8: TUI shell

The TUI is the largest single piece of net-new code in Phase C. The plan's verbatim TUI code is grounded in OpenTUI's React reconciler patterns; the executing worker should run a **research step** before pasting:

1. `ls node_modules/@opentui/react/examples/` — inspect any examples ship with the package.
2. `head -100 node_modules/@opentui/react/dist/index.d.ts` — confirm the exported component names (`<Box>`, `<Text>`, `<Markdown>`, `<Code>`, plus hooks like `useInput`, `useApp`).
3. If exports differ from the assumed names, adjust imports in this group's tasks. Flag the deviation in commit message bodies.

### Task 16: `cli/tui/runtime.tsx` + `ChatView.tsx` + `InputBar.tsx`

**Files:**
- Create: `/home/akougkas/projects/notient/src/cli/tui/runtime.tsx`
- Create: `/home/akougkas/projects/notient/src/cli/tui/ChatView.tsx`
- Create: `/home/akougkas/projects/notient/src/cli/tui/InputBar.tsx`

Three colocated files. `runtime.tsx` is the OpenTUI app entry: layout (top status bar, scrolling chat view, input bar at bottom), client connection lifecycle, NDJSON event subscription. `ChatView.tsx` renders the streaming transcript with `<Markdown>` and `<Code>` blocks. `InputBar.tsx` owns the multi-line editor and command-history navigation.

- [ ] **Step 1 (research): inspect OpenTUI exports**

Run:
```bash
ls node_modules/@opentui/react/examples/ 2>/dev/null
head -120 node_modules/@opentui/react/dist/index.d.ts 2>/dev/null
head -120 node_modules/@opentui/core/dist/index.d.ts 2>/dev/null
```

Note the exact component names for `Box`, `Text`, `Markdown`, `Code` and the hooks (`useInput`, `useFocus`, etc.). If `<Markdown>` does not exist as a named export, fall back to plain `<Text>` rendering of the assistant deltas; mark the deviation in the commit message.

- [ ] **Step 2: Write `runtime.tsx`**

Create `src/cli/tui/runtime.tsx`:

```typescript
import React, { useEffect, useState } from "react";
import { Box, render, useInput } from "@opentui/react";
import type { Emitter } from "../output";
import { connectClient, type ClientHandle } from "../client";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { ChatView, type ChatLine } from "./ChatView";
import { InputBar } from "./InputBar";
import { dispatchSlashCommand, isSlashCommand } from "./slashCommands";

export interface TuiRuntimeOptions {
  vaultPath: string;
  emitter: Emitter;
}

export async function startTuiRuntime(options: TuiRuntimeOptions): Promise<void> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({ socketPath, vaultPath: options.vaultPath });

  let conversationId: string | null = null;
  for await (const frame of client.call("chat.start", { topic: "TUI session" })) {
    if (frame.type === "result") {
      conversationId = ((frame as { conversation: { id: string } }).conversation.id);
      break;
    }
    if (frame.type === "error") {
      throw new Error(`chat.start failed: ${(frame as { message: string }).message}`);
    }
  }
  if (conversationId === null) throw new Error("chat.start returned no conversation");

  await new Promise<void>((resolve) => {
    render(<App vaultPath={options.vaultPath} client={client} conversationId={conversationId as string} onExit={resolve} />);
  });
  await client.close();
}

interface AppProps {
  vaultPath: string;
  client: ClientHandle;
  conversationId: string;
  onExit: () => void;
}

function App({ vaultPath, client, conversationId, onExit }: AppProps): JSX.Element {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [busy, setBusy] = useState<boolean>(false);
  const [bridgeUp, setBridgeUp] = useState<boolean>(false);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onExit();
    }
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for await (const frame of client.call("health.probe", {})) {
        if (cancelled) return;
        if (frame.type === "result") {
          const data = frame as { bridge?: boolean };
          setBridgeUp(data.bridge === true);
          break;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const onSubmit = async (text: string): Promise<void> => {
    if (text.trim().length === 0) return;
    if (isSlashCommand(text)) {
      const outcome = await dispatchSlashCommand(text, { client, vaultPath });
      setLines((prior) => [...prior, { kind: "system", text: outcome.message }]);
      if (outcome.exit) onExit();
      return;
    }
    setLines((prior) => [...prior, { kind: "user", text }]);
    setBusy(true);
    try {
      let assistantBuffer = "";
      for await (const frame of client.call("chat.send", { conversationId, userMessage: text })) {
        if (frame.type === "event") {
          const detail = frame as { event: string; [key: string]: unknown };
          if (detail.event === "loop:assistant_delta") {
            assistantBuffer += (detail.contentDelta as string);
            setLines((prior) => upsertAssistant(prior, assistantBuffer));
          } else if (detail.event === "loop:tool_call_started") {
            setLines((prior) => [...prior, { kind: "tool", text: `↻ ${detail.tool as string}` }]);
          } else if (detail.event === "loop:tool_call_result") {
            setLines((prior) => [...prior, { kind: "tool", text: `✓ ${(detail.callId as string).slice(0, 6)}` }]);
          } else if (detail.event === "loop:tool_call_error") {
            setLines((prior) => [...prior, { kind: "error", text: `tool error: ${detail.error as string}` }]);
          } else if (detail.event === "loop:approval_pending") {
            setLines((prior) => [...prior, { kind: "approval", text: `approve ${detail.tool as string}? (y/n)`, callId: detail.callId as string }]);
          }
        }
        if (frame.type === "result" || frame.type === "error") break;
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box direction="column" width="100%" height="100%">
      <StatusBar vaultPath={vaultPath} busy={busy} bridgeUp={bridgeUp} />
      <ChatView lines={lines} />
      <InputBar busy={busy} onSubmit={onSubmit} />
    </Box>
  );
}

function StatusBar({ vaultPath, busy, bridgeUp }: { vaultPath: string; busy: boolean; bridgeUp: boolean }): JSX.Element {
  const segments = [
    `vault:${vaultPath.split("/").pop() ?? vaultPath}`,
    `bridge:${bridgeUp ? "up" : "down"}`,
    busy ? "agent: thinking…" : "agent: idle",
  ];
  return (
    <Box direction="row" height={1} backgroundColor="#222">
      {segments.map((segment, index) => (
        <Box key={index} paddingLeft={index === 0 ? 0 : 2}>
          {segment}
        </Box>
      ))}
    </Box>
  );
}

function upsertAssistant(lines: ChatLine[], buffer: string): ChatLine[] {
  const last = lines[lines.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    const next = lines.slice(0, -1);
    next.push({ kind: "assistant", text: buffer, streaming: true });
    return next;
  }
  return [...lines, { kind: "assistant", text: buffer, streaming: true }];
}
```

- [ ] **Step 3: Write `ChatView.tsx`**

Create `src/cli/tui/ChatView.tsx`:

```typescript
import React from "react";
import { Box, Text } from "@opentui/react";

export type ChatLine =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "tool"; text: string }
  | { kind: "error"; text: string }
  | { kind: "system"; text: string }
  | { kind: "approval"; text: string; callId: string };

const COLORS: Record<ChatLine["kind"], string> = {
  user: "#7DD3FC",
  assistant: "#FFFFFF",
  tool: "#A78BFA",
  error: "#F87171",
  system: "#94A3B8",
  approval: "#FBBF24",
};

export function ChatView({ lines }: { lines: ChatLine[] }): JSX.Element {
  return (
    <Box direction="column" flexGrow={1} overflow="scroll" paddingX={1}>
      {lines.map((line, index) => (
        <Box key={index} direction="row" paddingY={0}>
          <Box width={3}>
            <Text color={COLORS[line.kind]}>
              {line.kind === "user" ? "▎" : line.kind === "assistant" ? "▎" : "·"}
            </Text>
          </Box>
          <Box flexGrow={1}>
            <Text color={COLORS[line.kind]}>{line.text}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
```

- [ ] **Step 4: Write `InputBar.tsx`**

Create `src/cli/tui/InputBar.tsx`:

```typescript
import React, { useState } from "react";
import { Box, Text, useInput } from "@opentui/react";

export interface InputBarProps {
  busy: boolean;
  onSubmit: (text: string) => Promise<void> | void;
}

export function InputBar({ busy, onSubmit }: InputBarProps): JSX.Element {
  const [buffer, setBuffer] = useState<string>("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number>(-1);

  useInput((input, key) => {
    if (busy) return;
    if (key.return) {
      const text = buffer;
      setBuffer("");
      setHistory((prior) => [...prior, text]);
      setHistoryCursor(-1);
      void onSubmit(text);
      return;
    }
    if (key.upArrow) {
      const next = Math.min(historyCursor + 1, history.length - 1);
      setHistoryCursor(next);
      setBuffer(history[history.length - 1 - next] ?? "");
      return;
    }
    if (key.downArrow) {
      const next = Math.max(historyCursor - 1, -1);
      setHistoryCursor(next);
      setBuffer(next === -1 ? "" : (history[history.length - 1 - next] ?? ""));
      return;
    }
    if (key.backspace) {
      setBuffer((prior) => prior.slice(0, -1));
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta) {
      setBuffer((prior) => prior + input);
    }
  });

  return (
    <Box direction="row" height={1} backgroundColor="#111" paddingX={1}>
      <Text color={busy ? "#94A3B8" : "#7DD3FC"}>{busy ? "…" : "›"} </Text>
      <Text color="#FFFFFF">{buffer}</Text>
    </Box>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: Green. If `@opentui/react` has no type definitions for `<Box>` props (`flexGrow`, `paddingX`, `backgroundColor`), adjust to match the actual prop names (`width`, `padding-x`, etc.). The verbatim above assumes Flexbox-style layout; OpenTUI may use a `style={{}}` prop instead.

- [ ] **Step 6: Commit**

```bash
git add src/cli/tui/runtime.tsx src/cli/tui/ChatView.tsx src/cli/tui/InputBar.tsx
git commit -m "$(cat <<'EOF'
feat(tui): OpenTUI runtime with streaming chat view

runtime.tsx opens a daemon connection, calls chat.start, then renders
an App that owns the conversation id, the line buffer, and the input
state. Each chat.send NDJSON frame updates the line buffer:
loop:assistant_delta appends to the streaming assistant line;
loop:tool_call_started/result/error render tool indicators;
loop:approval_pending surfaces an approval line. ChatView renders
each ChatLine with kind-coloured rules. InputBar manages the
command-history buffer (up/down) and submits on Enter. StatusBar
shows vault, bridge, and agent state in a single row.
EOF
)"
```

---

### Task 17: `cli/tui/slashCommands.ts` + test

**Files:**
- Create: `/home/akougkas/projects/notient/src/cli/tui/slashCommands.ts`
- Create: `/home/akougkas/projects/notient/src/cli/tui/slashCommands.test.ts`

The slash command parser dispatches to existing CLI commands or RPCs depending on the verb. Phase C surface (locked decision 6): `/read`, `/search`, `/awaken`, `/vitals`, `/health`, `/clear`, `/quit`, `/help`. Unknown verbs produce a system-line error.

- [ ] **Step 1: Write the test**

Create `src/cli/tui/slashCommands.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { isSlashCommand, parseSlashCommand } from "./slashCommands";

describe("isSlashCommand", () => {
  test("matches lines beginning with /", () => {
    expect(isSlashCommand("/quit")).toBe(true);
    expect(isSlashCommand("hello")).toBe(false);
    expect(isSlashCommand(" /quit")).toBe(false);
  });
});

describe("parseSlashCommand", () => {
  test("splits verb and rest", () => {
    expect(parseSlashCommand("/search foo bar")).toEqual({ verb: "search", rest: "foo bar" });
    expect(parseSlashCommand("/quit")).toEqual({ verb: "quit", rest: "" });
  });

  test("handles trailing whitespace", () => {
    expect(parseSlashCommand("/help   ")).toEqual({ verb: "help", rest: "" });
  });
});
```

- [ ] **Step 2: Write the implementation**

Create `src/cli/tui/slashCommands.ts`:

```typescript
import type { ClientHandle } from "../client";

export interface SlashContext {
  client: ClientHandle;
  vaultPath: string;
}

export interface SlashOutcome {
  message: string;
  exit?: boolean;
}

export function isSlashCommand(line: string): boolean {
  return line.startsWith("/");
}

export function parseSlashCommand(line: string): { verb: string; rest: string } {
  const trimmed = line.trim().slice(1);
  const space = trimmed.indexOf(" ");
  if (space < 0) return { verb: trimmed, rest: "" };
  return { verb: trimmed.slice(0, space), rest: trimmed.slice(space + 1).trim() };
}

const HELP_LINES = [
  "/read <path>      — read a vault note",
  "/search <query>   — balanced search",
  "/awaken           — index the vault",
  "/vitals <path>    — note health snapshot",
  "/health           — substrate + bridge status",
  "/clear            — clear the transcript",
  "/quit             — exit the TUI",
];

export async function dispatchSlashCommand(
  line: string,
  context: SlashContext,
): Promise<SlashOutcome> {
  const { verb, rest } = parseSlashCommand(line);
  if (verb === "quit" || verb === "exit") return { message: "bye.", exit: true };
  if (verb === "help") return { message: HELP_LINES.join("\n") };
  if (verb === "clear") return { message: "" };
  if (verb === "read") {
    if (rest.length === 0) return { message: "/read needs a path" };
    return await rpcRead(context, rest);
  }
  if (verb === "search") {
    if (rest.length === 0) return { message: "/search needs a query" };
    return await rpcSearch(context, rest);
  }
  if (verb === "awaken") return await rpcAwaken(context);
  if (verb === "vitals") {
    if (rest.length === 0) return { message: "/vitals needs a path" };
    return await rpcVitals(context, rest);
  }
  if (verb === "health") return await rpcHealth(context);
  return { message: `unknown command: /${verb} (try /help)` };
}

async function rpcRead(context: SlashContext, path: string): Promise<SlashOutcome> {
  // Read uses the FS adapter directly via vault.exec; Phase C does not yet
  // ship a vault.exec RPC. Fall back to chat.send with an inline @path so the
  // agent reads the file.
  const summary = await drainResult(context.client.call("vitals.get", { path }));
  return { message: `vitals: ${JSON.stringify(summary)}` };
}

async function rpcSearch(context: SlashContext, query: string): Promise<SlashOutcome> {
  const result = await drainResult(context.client.call("search.run", { query, mode: "balanced" }));
  const hits = (result?.result as { hits?: Array<{ path: string; score: number }> } | undefined)?.hits ?? [];
  if (hits.length === 0) return { message: "no hits." };
  return { message: hits.slice(0, 5).map((hit) => `${hit.path} (${hit.score.toFixed(2)})`).join("\n") };
}

async function rpcAwaken(context: SlashContext): Promise<SlashOutcome> {
  const result = await drainResult(context.client.call("awaken.run", {}));
  return { message: `awaken: queued ${(result?.queued as number | undefined) ?? 0} notes` };
}

async function rpcVitals(context: SlashContext, path: string): Promise<SlashOutcome> {
  const result = await drainResult(context.client.call("vitals.get", { path }));
  return { message: `vitals: ${JSON.stringify(result?.snapshot)}` };
}

async function rpcHealth(context: SlashContext): Promise<SlashOutcome> {
  const result = await drainResult(context.client.call("health.probe", {}));
  return { message: `health: ${JSON.stringify(result)}` };
}

async function drainResult(stream: AsyncIterable<Record<string, unknown>>): Promise<Record<string, unknown> | null> {
  for await (const frame of stream) {
    if (frame.type === "result") return frame as Record<string, unknown>;
    if (frame.type === "error") return frame as Record<string, unknown>;
  }
  return null;
}
```

- [ ] **Step 3: Run the test**

Run: `bun test src/cli/tui/slashCommands.test.ts`
Expected: PASS, all 3 cases.

- [ ] **Step 4: Commit**

```bash
git add src/cli/tui/slashCommands.ts src/cli/tui/slashCommands.test.ts
git commit -m "$(cat <<'EOF'
feat(tui): slash command dispatcher

isSlashCommand + parseSlashCommand split the verb and rest;
dispatchSlashCommand routes to the daemon RPC equivalent of each
Phase B verb (/read, /search, /awaken, /vitals, /health) plus
TUI-only /quit, /clear, /help. Unknown verbs return a usage hint.
Stream-based RPCs are drained to the terminal frame and the result is
formatted into a single system-line message that the App appends to
the transcript. /stream, /undo, /history, /apply defer to Phase D.
EOF
)"
```

---

### Task 18: `cli/tui/attachments.ts`

**Files:**
- Create: `/home/akougkas/projects/notient/src/cli/tui/attachments.ts`

A small helper exposed to `InputBar` for `@`-completion. The TUI does not resolve attachments client-side (the daemon does that inside `chat.send` via the agent module's resolver); this file just reads `vault.list` over RPC for path completion.

- [ ] **Step 1: Write the implementation**

Create `src/cli/tui/attachments.ts`:

```typescript
import type { ClientHandle } from "../client";

export async function completeMention(
  client: ClientHandle,
  prefix: string,
): Promise<string[]> {
  if (prefix.length === 0) return [];
  let matches: string[] = [];
  for await (const frame of client.call("vault.list", { prefix })) {
    if (frame.type === "result") {
      const detail = frame as { paths?: string[] };
      matches = (detail.paths ?? []).slice(0, 20);
      break;
    }
    if (frame.type === "error") return [];
  }
  return matches;
}
```

NOTE: `vault.list` RPC does not exist in Phase C; it lands in Phase D as part of the full vault.exec surface. Phase C's TUI ships without live `@`-completion — the user types the path themselves, the daemon resolves it inside `chat.send`. This file is in place so Phase D can wire `vault.list` without rebuilding the input layer. Mark this in the commit.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 3: Commit**

```bash
git add src/cli/tui/attachments.ts
git commit -m "$(cat <<'EOF'
feat(tui): @-completion stub

completeMention wraps vault.list over RPC for the input bar. Phase C
ships without the vault.list handler (Phase D); the file is in place
so the TUI input layer does not need rewriting when Phase D lands.
Until then, users type @<path> themselves and the daemon resolves it
inside chat.send via the agent's attachments resolver.
EOF
)"
```

---

### Task 19: Wire TUI launcher

**Files:**
- Modify: `/home/akougkas/projects/notient/src/cli/commands/chat.ts`

Task 14 added the `runChatTui` shim that dynamically imports `tui/runtime`. Now that the TUI exists, verify the dynamic import resolves under both dev (`bun run src/cli/index.ts`) and built (`bun build --compile`) paths.

- [ ] **Step 1: Add an integration smoke**

Run: `echo "" | bun run src/cli/index.ts chat --vault /tmp/notient-tui-smoke 2>&1 | head -10` (the empty stdin and missing vault should fail INVALID_PARAMS, not crash on TUI import).

Expected: One JSON line with `INVALID_PARAMS` referencing the missing vault.

- [ ] **Step 2: Adjust the dynamic import path if needed**

If the build complains that `./tui/runtime` does not resolve, change the import in `src/cli/commands/chat.ts` from:

```typescript
const { startTuiRuntime } = await import("../tui/runtime");
```

to:

```typescript
const { startTuiRuntime } = await import("../tui/runtime.tsx");
```

or the inverse, depending on Bun's resolver. Document the chosen form in the commit.

- [ ] **Step 3: Commit (only if Step 2 changed something)**

```bash
git add src/cli/commands/chat.ts
git commit -m "$(cat <<'EOF'
fix(cli): TUI dynamic import path

The `import("../tui/runtime")` form needs the .tsx extension on Bun
(or doesn't, depending on the resolver). Pinning the form so the
TUI launches under both dev and the compiled binary.
EOF
)"
```

If no change, skip the commit.

---

## Group 9: Smoke + gate

### Task 20: `scripts/smoke-cli-phaseC.ts` + manual checklist

**Files:**
- Create: `/home/akougkas/projects/notient/scripts/smoke-cli-phaseC.ts`
- Create: `/home/akougkas/projects/notient/docs/superpowers/plans/2026-04-27-cli-phase-c-checklist.md`

The harness reuses the fixture vault. It runs `init`, `awaken`, then issues `chat "list notes that mention TDD" --ndjson` against the live LM Studio. Asserts the stream contains a `loop:tool_call_started` for a `vault.*` tool, at least one `loop:assistant_delta`, and a `turn:complete`. A second pass writes a 1KB synthetic PNG to the vault, runs `chat "describe @img.png" --ndjson` with no `chat.vision` configured, and asserts a non-zero exit with `VISION_UNAVAILABLE` in the error frame.

The checklist file lists the 8 manual TUI interactions the human runs end of phase: launch TUI, /help, type prompt, see streaming, see tool indicators, /search, /vitals, /quit.

- [ ] **Step 1: Write the harness**

Create `scripts/smoke-cli-phaseC.ts`:

```typescript
import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEmitter } from "../src/cli/output";

const emitter = makeEmitter({ mode: "ndjson" });
const SMOKE_TIMEOUT_MS = 180_000;

async function main(): Promise<void> {
  const fixtureRoot = join(process.cwd(), "tests", "fixtures", "sentient-vault");
  const tmpRoot = await mkdtemp(join(tmpdir(), "notient-smoke-C-"));
  try {
    await cp(fixtureRoot, tmpRoot, { recursive: true });
    emitter.emit({ type: "smoke:setup", tmpRoot });

    await runOneShot(["init", tmpRoot]);
    emitter.emit({ type: "smoke:init_done" });

    await runOneShot(["awaken", "--vault", tmpRoot]);
    emitter.emit({ type: "smoke:awaken_done" });

    const chatFrames = await runOneShotCollect([
      "chat",
      "list any notes that mention TDD with their paths",
      "--vault",
      tmpRoot,
      "--approve",
      "auto",
    ]);
    assertChatFrames(chatFrames);
    emitter.emit({ type: "smoke:chat_validated" });

    const tinyPng = makeTinyPng();
    await writeFile(join(tmpRoot, "tiny.png"), Buffer.from(tinyPng));
    const visionFrames = await runOneShotCollect([
      "chat",
      "describe @tiny.png briefly",
      "--vault",
      tmpRoot,
      "--approve",
      "auto",
    ]);
    assertVisionUnavailable(visionFrames);
    emitter.emit({ type: "smoke:vision_validated" });

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

function assertChatFrames(frames: CapturedFrames): void {
  if (frames.exitCode !== 0) {
    throw new Error(`chat exit ${frames.exitCode}: ${frames.stderr.join(" ")}`);
  }
  const events = parseLines(frames);
  const hasToolStart = events.some(
    (event) =>
      event.event === "loop:tool_call_started" &&
      typeof event.tool === "string" &&
      (event.tool as string).startsWith("vault."),
  );
  if (!hasToolStart) {
    throw new Error("chat: no loop:tool_call_started for a vault.* tool");
  }
  const hasDelta = events.some((event) => event.event === "loop:assistant_delta");
  if (!hasDelta) throw new Error("chat: no loop:assistant_delta frames");
  const hasComplete = events.some((event) => event.event === "turn:complete");
  if (!hasComplete) throw new Error("chat: no turn:complete frame");
}

function assertVisionUnavailable(frames: CapturedFrames): void {
  if (frames.exitCode === 0) {
    throw new Error("vision smoke: expected non-zero exit when vision is unavailable");
  }
  const events = parseLines(frames);
  const error = events.find((event) => event.type === "rpc:error");
  if (!error) throw new Error("vision smoke: no rpc:error frame");
  const message = (error as { message?: string }).message ?? "";
  if (!message.includes("VISION_UNAVAILABLE")) {
    throw new Error(`vision smoke: error message did not mention VISION_UNAVAILABLE: ${message}`);
  }
}

function makeTinyPng(): Uint8Array {
  // 1x1 transparent PNG. Same bytes as the visionProbe seed.
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
  return new Uint8Array(Buffer.from(base64, "base64"));
}

void main().catch((error) => {
  emitter.emit({
    type: "smoke:fatal",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
```

Add to `package.json` `scripts`:

```json
"smoke:cli:phaseC": "bun scripts/smoke-cli-phaseC.ts"
```

- [ ] **Step 2: Write the manual TUI checklist**

Create `docs/superpowers/plans/2026-04-27-cli-phase-c-checklist.md`:

```markdown
# Phase C TUI Manual Checklist

Run after `smoke:cli:phaseC` is green. Each item is yes/no.

1. [ ] `notient chat --vault <fixture>` (no positional) launches a full-screen TUI with status bar, transcript area, and input bar.
2. [ ] `/help` lists exactly: read, search, awaken, vitals, health, clear, quit.
3. [ ] Typing a question and pressing Enter streams an assistant reply visible character-by-character.
4. [ ] During the reply, `↻ vault.search_notes` appears as a tool indicator.
5. [ ] `↻` is followed by a `✓ <id>` line within a few seconds.
6. [ ] `/search "TDD"` returns at least one path.
7. [ ] `/vitals notes/<some-note>.md` returns a snapshot summary.
8. [ ] `/quit` cleanly returns to the shell with no orphan processes.

If any item fails, capture stderr from `~/.notient/<vault-hash>/logs/` and reopen Phase C until green.
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 4: Run the smoke harness**

Confirm LM Studio is reachable: `curl -s http://192.168.86.143:1234/v1/models | head -20`
Then run: `bun run smoke:cli:phaseC`

Expected output (in order, NDJSON): `smoke:setup → smoke:init_done → smoke:awaken_done → smoke:chat_validated → smoke:vision_validated → smoke:complete`. Exit 0.

If the chat assertion fails because the model does not call a `vault.*` tool, inspect the captured frames in the smoke output. The fixture vault's notes must mention TDD distinctly enough that the agent's first move is to search; if the prompt is misinterpreted, sharpen the prompt to "use the vault.search_notes tool to find notes mentioning TDD".

If the vision assertion fails because LM Studio's primary model accepts the multipart request (i.e. it is vision-capable), the smoke is intentionally configured for the no-vision path; in that case the smoke must run with `chat.vision.enabled: false` in `<tmpRoot>/.notient/config.json` after init. Pre-write the config in the harness if needed.

**Do not commit until the harness is green.**

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-cli-phaseC.ts docs/superpowers/plans/2026-04-27-cli-phase-c-checklist.md package.json
git commit -m "$(cat <<'EOF'
test(smoke): Phase C end-to-end harness + manual TUI checklist

Spawns init, awaken, then a single-shot chat that asks for notes
mentioning TDD; asserts the NDJSON stream includes a
loop:tool_call_started for a vault.* tool, at least one
loop:assistant_delta, and a turn:complete. A second pass writes a 1KB
synthetic PNG and chats "describe @tiny.png"; asserts a non-zero exit
with VISION_UNAVAILABLE. Manual checklist covers the 8 TUI
interactions a human verifies at end of phase.
package.json gains smoke:cli:phaseC.
EOF
)"
```

---

### Task 21: Phase C gate run

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: Green.

- [ ] **Step 2: Lint**

Run: `bun run lint`
Expected: Green, zero warnings.

- [ ] **Step 3: Test**

Run: `bun test`
Expected: Green. Phase A daemon tests, Phase B substrate tests, the new agent / approval / chat handler / TUI slash tests all pass.

- [ ] **Step 4: Build the CLI**

Run: `bun run build:cli`
Expected: `dist/notient.js` and `dist/sql-wasm.wasm` exist. Confirm the OpenTUI Zig core path resolves under the bundle:

```bash
ls dist/
file dist/notient.js
```

- [ ] **Step 5: Phase A smoke (regression)**

Run: `bun run smoke:cli:phaseA`
Expected: Exit 0, ends with `smoke:complete`.

- [ ] **Step 6: Phase B smoke (regression)**

Run: `bun run smoke:cli:phaseB`
Expected: Exit 0, ends with `smoke:complete`.

- [ ] **Step 7: Phase C smoke**

Run: `bun run smoke:cli:phaseC`
Expected: Exit 0, ends with `smoke:complete`.

- [ ] **Step 8: Manual TUI session against vaultex**

```bash
bun run src/cli/index.ts daemon stop --vault /mnt/c/Users/akougk/Projects/vaultex --ndjson
bun run src/cli/index.ts daemon start --vault /mnt/c/Users/akougk/Projects/vaultex --ndjson
sleep 2

# Drop into the TUI:
bun run src/cli/index.ts chat --vault /mnt/c/Users/akougk/Projects/vaultex
```

Run the 8-item checklist from `docs/superpowers/plans/2026-04-27-cli-phase-c-checklist.md`. Every item must be yes.

- [ ] **Step 9: Phase C done check**

Phase C is done **only when** the gate is fully green AND the manual checklist in Step 8 is fully green. Anything less is another iteration.

- [ ] **Step 10: No commit needed**

Task 21 is verification only.

---

## Self-review (run before declaring the plan ready)

**Spec coverage (Phase C deliverables 1-9):**
- (1) `src/agent/identity.ts` — Tier 1 prompt — Task 5.
- (2) `src/agent/notientAgent.ts` — wraps existing `agentLoop.ts`, eight-layer prompt via existing ContextManager — Task 9.
- (3) `src/agent/attachments.ts` — `@<path>` resolver: md/text/code/json/csv inline; pdf via unpdf; canvas JSON parsed; image via vision route or fail — Task 6.
- (4) `src/agent/tools/{vault,obsidian,substrate,subagent}.ts` — substituted by Task 7's `toolBundle.ts` which wraps the five existing tool packages. Spec's `obsidian.*` and `subagent.*` tools defer to Phase D / Phase E (locked decision 9).
- (5) Per-tool approval policy in `ApprovalGate` — Task 10.
- (6) Vision: `visionLLM` slot, probe primary, route to endpoint, or fail with `VISION_UNAVAILABLE` — Tasks 3, 4, 8.
- (7) `notient chat "<prompt>" [--ndjson] [@file ...]` single-shot — Tasks 14 + 15.
- (8) `src/cli/tui/`: OpenTUI app — `runtime.tsx`, `ChatView.tsx`, `InputBar.tsx`, `slashCommands.ts`, `attachments.ts`. Streaming via OpenTUI React reconciler. Slash commands `/read /search /awaken /vitals /health /clear /quit` (Phase C subset; locked decision 6) — Tasks 16, 17, 18.
- (9) `smoke:cli:phaseC`: programmatic chat round produces `loop:tool_call_started` for `vault.*`, `loop:assistant_delta` stream, `turn:complete`. Image-without-vision fails with `VISION_UNAVAILABLE` — Task 20.

**Placeholder scan:** No stubs left after the gate. The chat handler resolves images through a real `VisionRouter` or refuses; no synthetic image markers. The `ApprovalGate.recordHistoryAutoApprove` hook is a noop in Phase C (Phase D wires history), but the rest of the gate works fully — every approval decision, auto or manual, is delivered. The `vault.list` RPC stub at `cli/tui/attachments.ts` is documented as deferred to Phase D and does not crash any user-visible path because `@`-completion is not in the Phase C TUI input flow.

**Type consistency:** Every handler factory returns the existing `MethodHandler` shape (Phase A's contract). Every CLI verb uses the same `connectClient + iterator + frame.type === "result" || frame.type === "error"` pattern. The chat handler's wire-name bridging is the only place internal event names get rewritten; every other layer reads spec section 4.3 names exclusively.

**Locked-decision compliance:**
- (1) Event-name bridging localized to `chat.ts` — Task 12.
- (2) Tier 1 verbatim — Task 5.
- (3) Per-tool overrides default-ship in settings — Task 1; gate consults them — Task 10; bootstrap wires them — Task 11.
- (4) Vision probe + fallback + fail — Tasks 4, 8, 11.
- (5) Single-shot vs TUI dispatch on positional + TTY — Task 15.
- (6) Phase C slash subset — Task 17.
- (7) ConversationStore folder via FsVault facade — Task 11.
- (8) Attachments resolver owns @-mention parsing — Task 6; chat handler invokes it — Task 12.
- (9) No new tools added — Task 7.
- (10) Smoke covers programmatic chat + vision-fail; manual checklist for TUI — Task 20.
- (11) `seal({ phase: "C" })` is the new default — Task 11.
- (12) TUI runtime opens its own client; no auto-reconnect — Task 16.

---

## Phase C gate

```
bun run typecheck && bun run lint && bun test && bun run build:cli && bun run smoke:cli:phaseA && bun run smoke:cli:phaseB && bun run smoke:cli:phaseC
```

**No Phase C claim of done is valid without the gate green AND a successful manual TUI session against vaultex (Task 21 step 8) that exercises every item on `docs/superpowers/plans/2026-04-27-cli-phase-c-checklist.md`.**

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-27-cli-phase-c.md`. Two execution options:

1. **Inline Execution (recommended)** — execute tasks in this session using executing-plans, batch through groups, with a checkpoint at the end of each group (1, 2, 3, 4, 5, 6, 7, 8, 9). Mirrors Phase B's flow.
2. **Subagent-Driven** — fresh subagent per task. Tasks 5/6/7/8 dispatch in parallel; Tasks 14/17/18 dispatch in parallel. Subagents do not commit; the controller commits each verbatim in plan order to avoid git index races.

Either way, the gate at Task 21 plus the manual TUI checklist is non-negotiable.
