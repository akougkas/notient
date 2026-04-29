# Phase D1 — Agent-to-Agent Bridge

> Branch: `phase-d1` (off `beta-spec`). Predecessor: Phase D complete.
> Successor: Phase E (multi-vault, web surface; out of scope here).

## Context

The CLI substrate is solid. Phase D shipped the daemon RPC, the chat surface, the four-agent swarm (linker, synthesizer, contradictionHunter, maturityAdvancer), tool-mode probing, history+undo, vitals, search, and the structured TUI. The recent checkpoint (`db11eb1` + three follow-ups on `beta-spec`) removed every hardcoded model name from source: substrate identity now flows through `<vault>/.notient/.env` or process env, validated by `assertEndpointConfigured` at daemon seal.

The next iteration (Phase D1) builds the **agent-to-agent bridge** between Notient and external agentic clients (Claude Code first, Cursor/Codex/Aider next). The user's stance is locked: **no MCP**. The CLI is already the API. The bridge is intent-driven, not verb-driven. Notient stays an agent with its own reasoning; clients call high-level intents and Notient's orchestrator decides how to fulfill them.

## Goal

Ship seven features that turn the existing daemon into a peer-callable agent:

1. **Identity propagation** — `--as <agent-id>` global flag plumbed to every handler.
2. **`agent.ask`** — single-shot natural-language intent dispatch.
3. **`agent.brief`** — topic-driven structured brief without conversational round-trips.
4. **`agent.distill`** — ingest external transcripts, produce candidate notes.
5. **`agent.events`** — long-polling stream of swarm discoveries.
6. **`session.grant/revoke/list`** — scoped trust grants for unattended agent work.
7. **Claude Code skill** — `docs/skills/notient.md` operator copies to `~/.claude/skills/`.

## Out of scope

- MCP adapter. Deliberate non-goal. CLI is the surface.
- Multi-vault aggregation, federation, cross-vault search.
- Web UI, browser surfaces.
- Skill auto-installer (`notient skill install` would require permission machinery; skill is a manual copy for now).
- Push-to-Claude-Code IPC novelty. Long-poll over stdout is enough.
- New approval modes beyond session grants.

## Locked architectural decisions

These calls are made. Subagents do not relitigate them.

**LD-1. The CLI is the only API.** No MCP server, no HTTP, no second integration surface. Every external agent shells out to `notient ...`. The daemon RPC stays internal.

**LD-2. Notient is an agent, so the bridge is intent-driven.** External agents send natural-language intents (`agent.ask`) or fast-path verbs (`brief`, `distill`). They do NOT pick atomic verbs from a tool list. Notient's orchestrator owns dispatch.

**LD-3. Structured output via final-message JSON parse, not via `chatJson`.** `agent.ask` runs a normal tool-using chat turn with a system prompt that constrains the final assistant message to be valid JSON matching a fixed shape. Parse-failure falls back to wrapping the text. This avoids requiring providers that support tools+structured-output simultaneously.

**LD-4. Events flow through a curated, persisted, long-pollable channel.** A new `agent_events` SQLite table captures four event types from the swarm. `agent.events --since <cursor>` reads the table; on empty results, long-polls EventBus up to `longPollMs`. No websockets, no novel IPC.

**LD-5. Identity is per-invocation.** Every RPC envelope carries optional `clientIdentity`. The CLI sets it from `--as <agent-id>` (default `human`). The daemon plumbs it to chat context, approval gate, and event filtering. No persistent client registration.

**LD-6. Session grants are the unattended-write trust primitive.** A new `agent_sessions` SQLite table records grants keyed by `(client, folders, tools, maxWrites, ttl)`. ApprovalGate checks for an active grant before falling back to `chat.perTool` policy. Expired/revoked/exhausted grants degrade to the global policy.

**LD-7. The skill is markdown the user installs manually.** Lives at `docs/skills/notient.md` in the repo. Operator copies to `~/.claude/skills/notient.md`. No CLI installer in this phase.

**LD-8. `agent.ask` uses a read-only tool subset.** Writes never happen through `ask` — those go through `chat.send` (interactive) or `notes.*` (direct). The tool registry passed to `ask` filters out `notes.create/append/replace_section/update_frontmatter/proposals.upsert`.

**LD-9. `agent.brief` runs deterministic queries plus ONE LLM pass for the summary.** No tool loop. Vector search → relevant notes. Graph queries → decisions, questions, contradictions. Single `chat` call composes the summary paragraph.

**LD-10. Smokes prove the bridge end-to-end.** `scripts/smoke-cli-phaseD1.ts` drives all seven verbs against the live LM Studio substrate. Phases A/B/C/D continue to pass unchanged.

---

## Tasks

Ten tasks (T1–T10), grouped into four waves for subagent parallelization. Per-task spec: files, contract, tests, acceptance.

### T1 — Identity propagation

**Goal.** Every RPC carries optional `clientIdentity`. `--as <agent-id>` on the CLI sets it. Default `human` when unset.

**Files to create.**
- `src/cli/identity.ts` — `validateAgentId(s)`, `normalizeAgentId(s)`, `DEFAULT_AGENT_ID = "human"`.
- `src/cli/identity.test.ts` — pure helper tests.

**Files to modify.**
- `src/daemon/rpc.ts` (or wherever `RpcRequestFrame` is declared) — add `clientIdentity?: string` to the request envelope schema.
- `src/cli/client.ts` — `connectClient` accepts optional `clientIdentity`; client embeds it in every outgoing frame.
- `src/cli/index.ts` — register a global `--as <agent-id>` option that flows into the client.
- `src/daemon/handlers/chat.ts` (and any other handler that records to DB) — read `frame.clientIdentity`, persist where appropriate.

**Schema additions.** ConversationStore + HistoryService rows gain a nullable `client_identity TEXT` column. Migration in `src/core/db/migrations.ts`.

**Validation rules.**
- Allowed pattern: `^[a-z][a-z0-9-]{0,31}$`. Reserved IDs: `human`, `claude-code`, `cursor`, `codex`, `aider`. Custom IDs allowed if they match the pattern.
- Empty/whitespace → defaults to `human`.

**Tests.**
- `validateAgentId` accepts reserved + custom valid IDs, rejects spaces, dots, uppercase, leading digits.
- `connectClient` includes `clientIdentity` in frames when provided.
- A chat.send through the daemon with `--as claude-code` produces a conversation row with `client_identity = "claude-code"`.

**Acceptance.**
- `notient chat "hi" --as claude-code` succeeds and the conversation row carries the identity.
- `notient chat "hi"` defaults to `human` (no breakage).
- Existing chat smoke (Phase C) passes unchanged.

---

### T2 — `agent_events` table + EventBus publication

**Goal.** Persist four swarm event types to a queryable table.

**Files to create.**
- `src/core/services/agentEventStore.ts` — `record(type, payload)`, `since(cursor, limit)`, `latestId()`, `countSince(cursor)`.
- `src/core/services/agentEventStore.test.ts`.

**Files to modify.**
- `src/core/db/schema.ts` — add `agent_events` table.
- `src/core/db/migrations.ts` — migration step.
- `src/daemon/bootstrap.ts` — instantiate `AgentEventStore`, subscribe to the four event types, register in kernel.

**Schema.**
```sql
CREATE TABLE agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL  -- JSON
);
CREATE INDEX idx_agent_events_id_desc ON agent_events(id DESC);
```

**Subscribed event types** (subagent confirms exact bus event names by reading swarm code):
- `swarm:contradiction_discovered` — emitted by ContradictionHunter when a new contradiction pair surfaces.
- `swarm:cluster_emerged` — emitted by Synthesizer when a cluster meets minClusterSize.
- `swarm:claim_advanced` — emitted by MaturityAdvancer when a claim moves a maturity tier.
- `swarm:link_proposed` — emitted by Linker when a new edge is proposed.

If the swarm currently emits these under different names, the subagent decides: (a) rename in the swarm to match this contract, or (b) subscribe to existing names and namespace them in the AgentEventStore. Pick (a) if there are <3 emit sites; pick (b) otherwise. Document the decision.

**Tests.**
- `record` persists, `since(0, ...)` returns rows in id order.
- `since(cursor, limit)` respects both bounds.
- Emitting `swarm:contradiction_discovered` on the bus produces a row.
- `latestId()` returns the max id, 0 when empty.

**Acceptance.**
- All four event types land in the table when fired.
- Existing swarm tests pass.

---

### T3 — `agent.ask` RPC + `notient ask` CLI

**Goal.** Single-shot natural-language intent dispatch. Returns structured JSON.

**Files to create.**
- `src/daemon/handlers/agentAsk.ts` — handler.
- `src/daemon/handlers/agentAsk.test.ts`.
- `src/cli/commands/ask.ts` — CLI subcommand. (If existing CLI commands are inline in `index.ts`, follow that convention instead.)
- `src/cli/commands/ask.test.ts` (or inline test).

**Files to modify.**
- `src/daemon/rpc.ts` — register `agent.ask` verb.
- `src/cli/index.ts` — register `notient ask <intent>` subcommand.

**RPC contract.**
```typescript
interface AgentAskRequest {
  intent: string;
  clientIdentity?: string;
  format?: "structured" | "text"; // default "structured"
  maxRoundsPerTurn?: number;      // default 4, capped at 8
}

interface AgentAskResponse {
  answer: string;
  citations: Array<{ path: string; score: number; snippet: string }>;
  openQuestions: string[];
  confidence: number; // 0-1
  toolCalls: Array<{ name: string; args: unknown; durationMs: number }>;
  durationMs: number;
}
```

**Handler logic (per LD-3, LD-8).**
1. Build a system prompt that frames the assistant as Notient and constrains the final message to be valid JSON matching `AgentAskResponse` (sans `toolCalls` and `durationMs`, which the handler fills in).
2. Filter `toolRegistry` to read-only verbs (`vault.read_note`, `vault.search_notes`, `vault.list_neighbors`, `vault.get_vitals`, `proposals.list_pending`, `proposals.get`, `graph.find_path`, `graph.list_clusters`, `agents.contradiction_check`, `agents.synthesize`).
3. Run a single chat turn through ChatService against an ephemeral conversation (not persisted to ConversationStore). Use the existing `buildNotientAgent` machinery; pass an in-memory ConversationStore stub.
4. Drain events; collect tool calls into `toolCalls`.
5. Parse final assistant content as JSON. On success, merge with handler-filled fields. On failure, return `{answer: <raw text>, citations: [], openQuestions: [], confidence: 0, toolCalls, durationMs}`.

**System prompt template.**
```
You are Notient, a local-first knowledge agent. Answer the operator's intent using the read-only tools available.

Your final message MUST be a single JSON object with this exact shape:
{
  "answer": "<concise prose answer, 1-3 paragraphs>",
  "citations": [{"path": "<note path>", "score": <0-1>, "snippet": "<short quote>"}],
  "openQuestions": ["<question 1>", ...],
  "confidence": <0-1, your confidence in the answer>
}

Do not wrap the JSON in code fences. Do not include any prose before or after the JSON. Do not include tool-call narration in your final message.
```

**CLI contract.**
```
notient ask "what is the user's position on auth?"
notient ask "..." --format text          # extracts answer field, prints plain
notient ask "..." --as claude-code
notient ask "..." --max-rounds 6
```

Output: structured JSON pretty-printed by default; text mode prints `answer` as plain text.

**Tests.**
- Handler unit test with stub provider returning canned JSON in final content.
- Read-only enforcement: stub provider tries to call `notes.create`, handler rejects with clear error.
- Parse-failure fallback: stub returns plain text, handler wraps it.
- CLI integration: pipes through, prints expected output.

**Acceptance.**
- `notient ask "what notes are in the vault?"` returns valid JSON with non-empty `answer` against the live substrate.
- Read-only writes are blocked.

---

### T4 — `agent.brief` RPC + `notient brief` CLI

**Goal.** Topic-driven structured brief. No tool loop. One LLM call for summary.

**Files to create.**
- `src/daemon/handlers/agentBrief.ts`.
- `src/daemon/handlers/agentBrief.test.ts`.
- `src/cli/commands/brief.ts` (or inline in `index.ts` per existing convention).
- `src/cli/commands/brief.test.ts`.

**Files to modify.**
- `src/daemon/rpc.ts` — register `agent.brief`.
- `src/cli/index.ts` — register `notient brief <topic>`.

**RPC contract.**
```typescript
interface AgentBriefRequest {
  topic?: string;
  filePath?: string;       // mutually exclusive with topic; embeds file content as query
  clientIdentity?: string;
  maxNotes?: number;       // default 8
  maxQuestions?: number;   // default 5
  maxDecisions?: number;   // default 5
}

interface AgentBriefResponse {
  topic: string;           // echoed or derived from filePath
  summary: string;         // 2-3 sentence LLM-composed summary
  relevantNotes: Array<{ path: string; score: number; snippet: string; lastTouchedAt: number }>;
  recentDecisions: Array<{ id: string; text: string; notePath: string; ts: number }>;
  openQuestions: Array<{ id: string; text: string; notePath: string }>;
  openContradictions: Array<{ pair: [string, string]; severity: number }>;
  durationMs: number;
}
```

**Handler logic (per LD-9).**
1. Resolve query vector: if `topic`, embed the topic string; if `filePath`, read the file (via FsVault) and embed the content (truncated to ~4K tokens).
2. Vector search via `searchPipeline` (balanced mode) → `relevantNotes` (top `maxNotes`).
3. Query graph for claims with `maturity = "decision"` whose `notePath` is in `relevantNotes` paths → `recentDecisions` (top `maxDecisions` by ts).
4. Query graph for nodes with `type = "question"` AND `answered = false` linked to relevant notes → `openQuestions`.
5. Query contradiction pairs where either side touches a relevant note → `openContradictions`.
6. ONE LLM `chat` call with the structured data as context, asking for a 2-3 sentence summary.

**CLI contract.**
```
notient brief authentication
notient brief --file src/auth/oauth.ts
notient brief authentication --max-notes 5 --as claude-code
```

Output: structured JSON pretty-printed.

**Tests.**
- Handler with seeded DB returns expected structure.
- File mode reads the file, embeds the content, queries.
- `maxNotes`/`maxQuestions`/`maxDecisions` honored.

**Acceptance.**
- `notient brief TDD` returns at least one relevant note from the seeded fixture vault.
- `notient brief --file <existing.md>` works against the test vault.

---

### T5 — `agent.distill` RPC + `notient distill` CLI

**Goal.** Ingest external transcripts; produce candidate notes/claims as proposals.

**Files to create.**
- `src/core/distill/transcriptParser.ts` — normalizes formats to `{role, content, sourceMessageId}[]`.
- `src/core/distill/transcriptParser.test.ts`.
- `src/daemon/handlers/agentDistill.ts`.
- `src/daemon/handlers/agentDistill.test.ts`.
- `src/cli/commands/distill.ts` (or inline).
- `src/cli/commands/distill.test.ts`.

**Files to modify.**
- `src/daemon/rpc.ts` — register `agent.distill`.
- `src/cli/index.ts` — register `notient distill --from <path>`.

**Supported transcript formats** (auto-detected by file extension + content sniff):
- **Markdown**: `User:` / `Assistant:` blocks, separated by blank lines.
- **JSONL** (Claude Code session): one JSON object per line, types `user`, `assistant`, `tool_use`, `tool_result`. Map to `{role, content}` by collapsing tool calls.
- **JSON**: `{messages: [{role, content}, ...]}` shape.

**RPC contract.**
```typescript
interface AgentDistillRequest {
  transcriptPath: string;
  format?: "auto" | "markdown" | "jsonl" | "json"; // default "auto"
  clientIdentity?: string;
  dryRun?: boolean; // default false; when true, no proposals written
}

interface AgentDistillResponse {
  candidates: Array<{
    kind: "claim" | "decision" | "question" | "note";
    text: string;
    sourceMessageIds: string[];
  }>;
  proposalsCreated: number;
  byKind: Record<string, number>;
  durationMs: number;
}
```

**Handler logic.**
1. Read file at `transcriptPath` (validate path is absolute or vault-relative; reject `..` traversal).
2. Detect format if `auto` (extension first; fallback content sniff).
3. Parse via `transcriptParser` to canonical message list.
4. Convert messages to chunks (one chunk per assistant or user turn, sized within the existing chunker's limits).
5. Run the existing `Synthesizer` over the chunks to produce claim/question candidates.
6. If `!dryRun`, write each candidate as a proposal file to `Notient/proposals/distilled-<ts>-<kind>-<seq>.md` with frontmatter linking back to `transcriptPath` and `clientIdentity`.
7. Return summary.

**Tests.**
- Parser: each format → canonical output.
- Handler: stub Synthesizer, assert proposals written to the right path.
- `dryRun: true` writes nothing.
- Path traversal rejection.

**Acceptance.**
- `notient distill --from /tmp/test-transcript.md --as claude-code` produces proposal files.
- `--dry-run` returns candidates without writing.
- All three formats parse cleanly.

---

### T6 — `agent.events` RPC + `notient events` CLI

**Goal.** Long-polling stream of swarm discoveries since a cursor.

**Files to create.**
- `src/daemon/handlers/agentEvents.ts`.
- `src/daemon/handlers/agentEvents.test.ts`.
- `src/cli/commands/events.ts` (or inline).
- `src/cli/commands/events.test.ts`.

**Files to modify.**
- `src/daemon/rpc.ts` — register `agent.events`.
- `src/cli/index.ts` — register `notient events`.

**RPC contract.**
```typescript
interface AgentEventsRequest {
  since: number;            // last id seen by this client; 0 for initial drain
  clientIdentity?: string;
  limit?: number;           // default 100, capped at 1000
  longPollMs?: number;      // default 30000, 0 disables long-poll
}

interface AgentEventsResponse {
  events: Array<{ id: number; ts: number; type: string; payload: unknown }>;
  cursor: number;           // highest id returned, or `since` if no rows
  longPollExpired: boolean;
}
```

**Handler logic.**
1. Query `AgentEventStore.since(since, limit)`.
2. If non-empty, return immediately.
3. If empty AND `longPollMs > 0`, subscribe to the four bus event types via `EventBus.on`. Wait up to `longPollMs` for a fire. On fire, re-query (the AgentEventStore subscriber from T2 should have just persisted the row); return.
4. On timeout, return `{events: [], cursor: since, longPollExpired: true}`.
5. Always remove bus listeners on completion (no leaks).

**CLI contract.**
```
notient events --since 0                    # initial drain, long-polls if empty
notient events --since 42 --as claude-code
notient events --since 42 --no-poll         # immediate return
notient events --since 42 --long-poll-ms 5000
```

Output: NDJSON to stdout — one event per line, then a final `{"type": "events:cursor", "cursor": <n>}` line.

**Tests.**
- Handler with seeded events returns rows after `since`.
- Long-poll: handler waits, an event fires, handler returns it within ~latency.
- `longPollMs: 0` disables polling.
- Timeout returns empty + `longPollExpired: true`.
- Listener cleanup verified (no leaks across multiple calls).

**Acceptance.**
- After a fresh awaken, `notient events --since 0 --no-poll` returns 0 events (or whatever the swarm produced during indexing).
- After triggering a synthesizer cluster (e.g., via the smoke), `notient events --since <prev>` returns it.

---

### T7 — Session grants

**Goal.** User-authorized scoped trust grants for unattended agent writes.

**Files to create.**
- `src/core/services/sessionGrants.ts` — `grant(opts)`, `revoke(id)`, `list(filter)`, `find({client, tool, folder, now})`.
- `src/core/services/sessionGrants.test.ts`.
- `src/daemon/handlers/sessionGrant.ts`, `sessionRevoke.ts`, `sessionList.ts`.
- `src/daemon/handlers/session.test.ts`.
- `src/cli/commands/session.ts` — handles `grant`, `revoke`, `list` subcommands.
- `src/cli/commands/session.test.ts`.

**Files to modify.**
- `src/core/db/schema.ts` — add `agent_sessions` table.
- `src/core/db/migrations.ts` — migration.
- `src/daemon/rpc.ts` — register three verbs.
- `src/cli/index.ts` — register `notient session` parent + three subcommands.
- `src/daemon/bootstrap.ts` — instantiate SessionGrants service, register in kernel.

**Schema.**
```sql
CREATE TABLE agent_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  allowed_folders TEXT NOT NULL,  -- JSON string array
  allowed_tools TEXT NOT NULL,    -- JSON string array; empty array means "all writes"
  max_writes INTEGER,             -- nullable = unlimited
  used_writes INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER              -- nullable
);
CREATE INDEX idx_agent_sessions_client_active ON agent_sessions(client, expires_at, revoked_at);
```

**`find` lookup logic.** Returns the most recent active grant matching `(client, tool, folder, now)` where:
- `revoked_at IS NULL`
- `expires_at > now`
- `tool` is in `allowed_tools` OR `allowed_tools` is empty
- `folder` starts with one of `allowed_folders`
- `used_writes < max_writes` (or `max_writes IS NULL`)

**RPC contracts.**
```typescript
interface SessionGrantRequest {
  client: string;                  // validated via T1's normalizeAgentId
  allowedFolders: string[];
  allowedTools?: string[];         // default [] = "all writes"
  maxWrites?: number;
  ttlMinutes: number;              // capped at 24*60 (1 day)
}

interface SessionGrantResponse {
  sessionId: number;
  client: string;
  expiresAt: number;
  allowedFolders: string[];
  allowedTools: string[];
  maxWrites: number | null;
}

interface SessionRevokeRequest {
  sessionId: number;
}

interface SessionListRequest {
  client?: string;
  activeOnly?: boolean;            // default true
}

interface SessionListResponse {
  sessions: Array<SessionGrantResponse & { usedWrites: number; revokedAt: number | null }>;
}
```

**CLI contract.**
```
notient session grant --client claude-code --folders "Inbox/" "Notient/agent-asks/" --max-writes 20 --ttl 60
notient session list
notient session list --client claude-code
notient session revoke 5
```

**Tests.**
- `grant` creates a row with correct ttl and folders.
- `find` returns active grants, ignores expired/revoked/exhausted.
- `incrementWriteCount` is atomic.
- Revoke flips `revoked_at`.
- TTL cap (1 day) enforced.
- CLI argument parsing.

**Acceptance.**
- A grant with `--ttl 1` is unfindable after 60s.
- `revoke` immediately disables the grant.
- `list` shows only active grants by default.

---

### T8 — ApprovalGate session-grant integration

**Goal.** ApprovalGate consults active grants before falling back to `chat.perTool` policy.

**Files to modify.**
- `src/core/chat/approvalGate.ts` — accept `SessionGrants` service in constructor; check grants first.
- `src/core/chat/approvalGate.test.ts` — extend with grant-related tests.
- `src/daemon/bootstrap.ts` — wire SessionGrants into ApprovalGate construction.

**New logic.**
```typescript
async checkApproval(call: ToolCall, ctx: ApprovalContext): Promise<Decision> {
  const grant = await this.sessionGrants.find({
    client: ctx.clientIdentity ?? "human",
    tool: call.name,
    folder: extractFolder(call.args.path),
    now: Date.now(),
  });
  if (grant !== null) {
    await this.sessionGrants.incrementWriteCount(grant.id);
    return {
      decision: "auto",
      reason: `session-grant#${grant.id}`,
      sessionId: grant.id,
    };
  }
  return this.applyPerToolPolicy(call); // existing path
}
```

**`extractFolder` helper.** From a tool call's `args.path`, return the leading folder segment (e.g., `"Inbox/"` from `"Inbox/today.md"`). Falls back to `""` if no path.

**ApprovalContext additions.** `clientIdentity?: string` plumbed through from chat handler (T1 dependency).

**Tests.**
- Active grant covering `(folder, tool)` → auto with `sessionId` set.
- Active grant covering folder but tool not in `allowedTools` → fall through to perTool.
- Grant exhausted (`usedWrites === maxWrites`) → fall through.
- Expired grant → fall through.
- Revoked grant → fall through.
- No grant → existing perTool behavior unchanged.

**Acceptance.**
- All existing approval-gate tests pass.
- New grant tests pass.
- Smoke C still passes (no grant set; existing flow holds).

---

### T9 — Phase D1 smoke

**Goal.** End-to-end exercise of all seven verbs against the live substrate.

**Files to create.**
- `scripts/smoke-cli-phaseD1.ts` — modeled on `scripts/smoke-cli-phaseD.ts`. Uses `captureNotientEnv` + `writeVaultEnvFile` per the pattern just established.
- Add `"smoke:cli:phaseD1": "bun scripts/smoke-cli-phaseD1.ts"` to `package.json`.

**Smoke flow.**
1. Capture env, mkdtemp, copy fixture, init, write vault `.env`, awaken.
2. Pre-seed config: tool mode pin, auto-approve `notes.create` for fixture seeding.
3. **Identity test** — `notient chat "hello" --as claude-code --vault <tmp>`; assert the resulting conversation row has `client_identity = "claude-code"`.
4. **Ask** — `notient ask "what is in this vault?" --as claude-code --vault <tmp>`; assert valid JSON with non-empty `answer` and at least one citation.
5. **Brief (topic)** — `notient brief "TDD" --as claude-code --vault <tmp>`; assert `relevantNotes.length >= 1` (fixture seeds TDD-related notes).
6. **Brief (file)** — `notient brief --file notes/<existing-md> --as claude-code --vault <tmp>`; assert `summary.length > 0`.
7. **Session grant** — `notient session grant --client claude-code --folders "Inbox/" --max-writes 5 --ttl 60 --vault <tmp>`; capture `sessionId`. Assert `notient session list --vault <tmp>` shows it.
8. **Distill (dry-run)** — write a fake markdown transcript to `<tmp>/transcript.md`; `notient distill --from <path> --as claude-code --dry-run --vault <tmp>`; assert `candidates.length >= 1`.
9. **Distill (live)** — same call without `--dry-run`; assert proposal files exist under `<tmp>/Notient/proposals/distilled-*`.
10. **Events** — read initial cursor via `notient events --since 0 --no-poll --vault <tmp>`; record cursor. Run a chat turn that triggers swarm work. Re-poll `notient events --since <prev> --no-poll`; assert at least one event observed (or skip-flag if substrate doesn't drive it within 60s, mirroring smoke D's context-summarized skip pattern).
11. **Session revoke** — `notient session revoke <sessionId> --vault <tmp>`; assert success.
12. Stop daemon, `smoke:complete`.

**Acceptance.**
- `bun run smoke:cli:phaseD1` ends with `smoke:complete`.
- Smokes A, B, C, D continue to pass (no regression).

---

### T10 — Claude Code skill

**Goal.** Markdown contract operator copies to `~/.claude/skills/notient.md`.

**Files to create.**
- `docs/skills/notient.md` — single self-contained skill file.

**Required sections.**
- YAML frontmatter: `name: notient`, `description: ...` (concise; describes when to invoke).
- **What is Notient** — one paragraph: a local-first knowledge agent backing an Obsidian vault, exposes seven CLI verbs.
- **When to invoke** — bullet list of detection signals: user asks about their notes/decisions/memory; user is editing a file with vault-architectural context; session start (drain events); session end (distill).
- **How to invoke** — one subsection per verb (`ask`, `brief`, `distill`, `events`, `session grant`), each with at least one example.
- **Identity** — ALWAYS pass `--as claude-code` on every invocation.
- **Boundaries** — do not write without an active session grant; surface contradictions inline; honor `notient session list` before assuming write authority.
- **Errors** — daemon-not-running fallback (skip silently; do not retry); permission-denied → respect; transcript path validation.
- **Detection examples** — concrete user phrasings paired with the verb to call.

**Length target.** 150–250 lines. Self-contained: no external links required for Claude Code to act on it.

**Acceptance.**
- File at `docs/skills/notient.md` exists.
- All seven verbs documented with examples.
- Detection rules unambiguous.
- Operator can manually copy to `~/.claude/skills/notient.md` and Claude Code activates it.

---

## Wave plan (subagent parallelization)

Subagents run inside git worktrees per the project topology. Each task gets its own worktree off `phase-d1`. After each wave, the orchestrator merges the work into `phase-d1` and runs the verification gate before launching the next wave.

**Wave 1** (parallel, no inter-dependencies):
- T1 — identity propagation
- T2 — agent_events table + publication
- T10 — skill markdown (no code touches)

**Wave 2** (parallel, after Wave 1 merged):
- T3 — `agent.ask`
- T4 — `agent.brief`
- T5 — `agent.distill`
- T6 — `agent.events` (depends on T2 schema)
- T7 — `session.grant/revoke/list`

**Wave 3** (after T7 merged):
- T8 — ApprovalGate integration

**Wave 4** (after Wave 3 merged):
- T9 — Phase D1 smoke

## Per-wave verification gate

Before merging a wave's worktree branches into `phase-d1`:

1. `bun run typecheck` — green.
2. `bun run lint` — green.
3. `bun test` — all tests green; new tests added by the task present.
4. Smokes A/B/C/D — green (no regression).

After T9 merges, the gate adds: `bun run smoke:cli:phaseD1` — green.

## Constraints (carry forward from prior session)

- **TS strict, no `any`.** No abbreviations (`context` not `ctx`). No `console.log` outside `src/cli/output.ts`.
- **No new dependencies.** Reuse existing Bun, sqlite, HNSW, EventBus, ChatService, Synthesizer.
- **No new RPC verbs beyond those listed.** Phase D1 introduces exactly: `agent.ask`, `agent.brief`, `agent.distill`, `agent.events`, `session.grant`, `session.revoke`, `session.list`. Plus the envelope-level `clientIdentity` field.
- **One logical commit per task** within a worktree. HEREDOC commit messages. No co-authored-by, no AI-generated, no emojis.
- **No banned dash pattern.** `[noun] - [parenthetical clause]` is forbidden in commit messages and comments. Use full sentences.
- **TDD on pure helpers.** `validateAgentId`, `extractFolder`, `transcriptParser`, `AgentEventStore`, `SessionGrants` get tests-first. Handler tests can be after-the-fact, but every handler ships with tests.
- **Don't push.** Don't force-push. Don't touch `main`. Phase D1 lives entirely on local `phase-d1` branch + per-task worktrees.
- **Smokes live in `scripts/`.** Reuse `captureNotientEnv` + `writeVaultEnvFile` + `stripNotientEnvFromProcess` from `scripts/lib/spawnEnv.ts`. Do not re-implement env handling.

## When subagents stop and report back

- A wave's verification gate fails after 2 fix attempts.
- A locked decision needs revisiting (file an issue note in the worktree, do not silently change direction).
- A task surfaces a hardcoded model string anywhere (the prior session swept these out; regression must be reported).
- A task discovers an existing system that conflicts with the spec (e.g., the swarm emits events under different names — the LD-2 case in T2 documentation).

## Done definition

Phase D1 is complete when:

1. All ten tasks merged into `phase-d1`.
2. All four verification gates pass on `phase-d1`.
3. `bun run smoke:cli:phaseD1` ends with `smoke:complete`.
4. Phase A/B/C/D smokes continue to pass.
5. The skill at `docs/skills/notient.md` is reviewed and lands.
6. A summary commit on `phase-d1` documents the bridge surface for the operator.

The branch stays local. No PR, no push. The user merges to `beta-spec` (or whatever the next integration branch is) when satisfied.

---

## Implementation status (shipped on `beta-spec`)

Phase D1 shipped on `beta-spec` rather than a `phase-d1` branch. The user authorized the simpler topology mid-flight: stay on the current branch, no migrations, schema rewritten from first principles. The seven verbs and the skill are live.

### Commit log (chronological)

| # | SHA | Subject |
|---|-----|---------|
| 0 | `36605f7` | refactor(db): collapse schema into single SCHEMA constant |
| 1 | `60068e4` | feat(identity): per-invocation clientIdentity plumbed through RPC |
| 2 | `200b295` | feat(events): agent_events store + bus subscription for swarm discoveries |
| 3 | `27671d8` | docs(skill): claude code notient skill at docs/skills/notient.md |
| 4 | `cbb4478` | fix(client): raise daemon spawn timeout to 30s |
| 5 | `36d3b48` | feat(agent): agent.ask RPC + notient ask CLI |
| 6 | `aaae5b3` | feat(agent): agent.brief RPC + notient brief CLI |
| 7 | `d54801d` | feat(agent): agent.distill RPC + notient distill CLI |
| 8 | `893e124` | feat(agent): agent.events long-poll RPC + notient events CLI |
| 9 | `a50514c` | feat(session): grants service + RPC verbs + notient session CLI |
| 10 | `7b77083` | feat(approval): consult session grants before per-tool policy |
| 11 | `1f43fcc` | test(smoke): phase D1 end-to-end harness for the seven new verbs |

### Wire surface for the operator

External agentic clients (Claude Code first) shell out to the `notient` binary. Every invocation passes `--as <agent-id>` so writes get attributed and session grants apply. The seven verbs:

| Verb | Wire | Use case |
|------|------|----------|
| `notient ask "<intent>"` | `agent.ask` | Single-shot natural-language intent, structured JSON answer with citations + open questions + confidence. Read-only. |
| `notient brief <topic>` / `--file <path>` | `agent.brief` | Topic or file-driven structured brief: relevant notes, recent decisions, open questions, open contradictions, plus a 2-3 sentence LLM summary. |
| `notient distill --from <transcript>` | `agent.distill` | Ingests an external transcript (markdown / JSONL / JSON) and produces proposal files under `<vault>/Notient/proposals/`. `--dry-run` previews without writing. |
| `notient events --since <cursor>` | `agent.events` | Long-polling NDJSON stream of swarm discoveries (contradictions, clusters, claim advances, link proposals). |
| `notient session grant --client <id> --folders <list>` | `session.grant` | User-authorized scoped trust grant for unattended writes. |
| `notient session list` | `session.list` | Lists active grants. |
| `notient session revoke <id>` | `session.revoke` | Revokes a grant immediately. |

Plus the global `--as <agent-id>` flag the T1 plumbing added to every existing verb.

### Schema additions

`SCHEMA` in `src/core/db/schema.ts` gained:

- `client_identity TEXT` column on the `history` table (T1).
- `agent_events` table + `idx_agent_events_id_desc` index (T2).
- `agent_sessions` table + `idx_agent_sessions_client_active` index (T7).

ConversationStore is markdown-based; identity is persisted in the per-conversation YAML frontmatter rather than a SQL column.

### EventBus additions

Four new `swarm:*` event types in `src/core/events/types.ts`:

- `swarm:contradiction_discovered`
- `swarm:cluster_emerged`
- `swarm:claim_advanced`
- `swarm:link_proposed`

Each is fired by the corresponding swarm agent at its discovery-commit moment. `AgentEventStore` self-subscribes and persists rows for `agent.events` consumers.

### ApprovalGate behavior

`ApprovalGate.request` now consults `SessionGrants.find` before falling back to per-tool policy. Active grants covering `(client, tool, folder)` produce an `auto` decision with `reason: "session-grant#<id>"` and `sessionId` attribution. `usedWrites` increments atomically once per approved call. Expired, revoked, and exhausted grants degrade silently to the existing per-tool policy.

### Verification at the close

- `bun run typecheck` — clean.
- `bun run lint` — clean (276 files).
- `bun test` — 872 pass / 0 fail.
- `bun run smoke:cli:phaseA|B|C|D|D1` — all end with `smoke:complete`. The D1 smoke validates identity, ask, brief topic, brief file, session grant + list + revoke, distill dry + live, and skip-tolerates the substrate-flaky `events` step (per the spec's flaky-test guidance).

### Operator copy step

Operator copies `docs/skills/notient.md` to `~/.claude/skills/notient.md` to activate the skill in Claude Code. There is no installer in this phase by design (LD-7).
