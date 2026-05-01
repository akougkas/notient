# Notient — AI Assistant Context

Local-first agentic CLI that turns a Markdown vault into a queryable, self-organising knowledge base. Notient owns a long-lived daemon, talks to a local LM Studio instance over OpenAI-compatible HTTP, and persists everything to an embedded SurrealDB. Notient = Note + Sentient. Local-only. Human-in-the-steering-wheel.

The user-facing surface is the `notient` CLI (built into `dist/notient.js`). The CLI either drives the daemon or spawns one on demand; the daemon owns SurrealDB, the indexer/awaken pipelines, the chat/agent loop, the watcher, and the swarm agents.

---

## Tech stack

| Layer | Technology |
|---|---|
| Language | TypeScript (strict, isolatedModules) |
| Runtime | Bun 1.3.10 |
| Build | bun (single-file build into `dist/notient.js`) via `tools/build-cli.ts` |
| Lint / format | Biome 1.9.0 |
| Database | SurrealDB 3.0.5 (spawned as a child process by the daemon) |
| LLM | LM Studio / llama.cpp-compatible OpenAI API for chat, structured JSON, vision, and embeddings |
| TUI | `@opentui/core` + `@opentui/react` |
| Markdown pipeline | unified / remark-parse / remark-stringify / remark-frontmatter |

---

## Commands

```bash
bun run typecheck         # tsc --noEmit (covers src/, testing/, tools/)
bun run test              # bun test testing/unit (fast, no external deps)
bun run test:integration  # NOTIENT_SMOKE=1 bun test testing/integration (spawns SurrealDB)
bun run test:smoke        # alias for test:integration
bun run test:all          # test then test:integration
bun run lint              # biome check src/ testing/
bun run lint:fix          # biome check --write src/ testing/
bun run format            # biome format --write src/ testing/
bun run build             # alias for build:cli
bun run build:cli         # bun tools/build-cli.ts → dist/notient.js
bun run smoke:cli:phaseA  # standalone phase-A end-to-end smoke (live LM Studio)
bun run smoke:cli:phaseB
bun run smoke:cli:phaseC
bun run smoke:cli:phaseD
bun run smoke:cli:phaseD1
```

`bun test testing/integration` requires the `surreal` binary on PATH and `NOTIENT_SMOKE=1`. CI installs SurrealDB v3.0.5 in the integration job; locally the dev machine pins the same version.

The `smoke:cli:phase*` scripts in `tools/` are not part of `bun test` — they drive the live LM Studio + daemon end-to-end and live as standalone harnesses.

Local AI tuning is controlled by vault `.notient/.env`, project `.env`, or process env:

```bash
NOTIENT_LLM_BASE_URL=http://host:1234/v1
NOTIENT_LLM_MODEL=nvidia-nemotron-3-nano-omni-30b-a3b-reasoning
NOTIENT_EMBED_MODEL=text-embedding-nomic-embed-text-v2-moe
NOTIENT_CONTEXT_TOKENS=200000       # per request/slot
NOTIENT_REASONING_SLOTS=4           # match LM Studio / llama.cpp parallel slots
```

With a server loaded at 800K total context and 4 slots, keep `NOTIENT_CONTEXT_TOKENS=200000` and `NOTIENT_REASONING_SLOTS=4`. Startup/status probes report both the per-slot budget and total requested context.

---

## Code map

Verify against the repo before trusting; this map gets stale when subsystems shift. Source of truth is the filesystem.

```
.
├── .github/workflows/ci.yml      # unit job (always) + integration job (push-to-main + dispatch)
├── .claude/CLAUDE.md             # this file
├── package.json
├── tsconfig.json
├── biome.json
├── bun.lock
├── docs/                         # specs, deep-dives
├── src/                          # production code only — no tests
│   ├── adapters/
│   │   └── fsVault.ts            # filesystem vault adapter (atomic writes, listing, read/append)
│   ├── agent/                    # tier-1 identity + helpers used by the chat agent
│   │   ├── attachments.ts        # @-mention/attachment resolution from chat input
│   │   ├── identity.ts           # TIER_1_IDENTITY system prompt
│   │   ├── toolBundle.ts         # builds the chat tool registry
│   │   └── visionProbe.ts        # detects whether the active model accepts vision
│   ├── bridge/                   # bridges to host environments (Obsidian)
│   │   ├── obsidianCli.ts        # spawns Obsidian via /bin/sh
│   │   └── obsidianProbe.ts      # detects whether Obsidian is reachable
│   ├── cli/                      # `notient` binary
│   │   ├── index.ts              # CLI entry (dispatches verbs)
│   │   ├── client.ts             # connects to daemon over UDS, spawns one if absent
│   │   ├── env.ts / identity.ts / output.ts / help.ts
│   │   ├── commands/             # one file per top-level verb (ask, brief, distill,
│   │   │                         #   awaken, backup, restore, nuke, reindex, events,
│   │   │                         #   session, daemon, graphDump, graphStats, linksAudit,
│   │   │                         #   linksSync, migrateVault, proposalsCli, …)
│   │   └── tui/                  # @opentui-based TUI (slash commands, history,
│   │                             #   model verbs, status bar, keybindings)
│   ├── core/
│   │   ├── kernel.ts             # DI container; wires services for the daemon
│   │   ├── agent/identity.ts     # (tier-1 prompt; lives at src/agent/identity.ts now)
│   │   ├── agents/               # swarm agents driven by the coordinator
│   │   │   ├── linker.ts         # rank-based confidence link proposals
│   │   │   ├── dbscan.ts         # cosine-DBSCAN clustering primitive
│   │   │   └── maturityAdvancer.ts
│   │   ├── approvals/            # ApprovalService — reconcile + apply pending writebacks
│   │   ├── awaken/               # awaken pipeline (vault-wide indexer drive)
│   │   │   ├── awakenWorker.ts
│   │   │   ├── awakenRun.ts      # awaken_run DAL
│   │   │   ├── backgroundRegistry.ts
│   │   │   └── reconcileAwakenOrphans.ts
│   │   ├── chat/                 # chat orchestration
│   │   │   ├── chatService.ts
│   │   │   ├── agentLoop.ts      # tool-using agent turn loop
│   │   │   ├── approvalGate.ts
│   │   │   ├── contextManager.ts
│   │   │   ├── conversationStore.ts / conversationIndex.ts / conversationParser.ts
│   │   │   ├── toolModeProbe.ts
│   │   │   └── tools/            # vault, notes, graph, proposals, registry
│   │   ├── config/configFile.ts  # vault TOML config loader
│   │   ├── coordinator/          # background-agent coordinator + reasoning mutex
│   │   ├── db/                   # SurrealDB DAL
│   │   │   ├── surreal.ts        # connect, upsertNoteByPath, relateEdge, …
│   │   │   ├── schemaApplier.ts  # applies the vault schema
│   │   │   └── edgeTables.ts
│   │   ├── distill/              # transcript distiller
│   │   ├── events/eventBus.ts    # in-process pub/sub
│   │   ├── history/              # HistoryService + Inverter contract
│   │   ├── indexer/              # tier 1/2/3 indexer + chunker + embedder + extractor
│   │   │   ├── tier1.ts / tier2.ts / tier3.ts
│   │   │   ├── chunker.ts
│   │   │   ├── embedder.ts
│   │   │   ├── extractor.ts      # mdast → entities/edges
│   │   │   ├── indexNote.ts
│   │   │   ├── indexerQueue.ts / priorityQueue.ts / indexerRuntime.ts
│   │   │   └── excludePaths.ts
│   │   ├── llm/                  # LLM provider abstraction
│   │   │   ├── provider.ts       # LLMProvider interface
│   │   │   └── lmStudioProvider.ts (and .vision)
│   │   ├── markdown/             # remark pipeline
│   │   │   ├── pipeline.ts / extractor.ts / writeback.ts / resolver.ts / slug.ts
│   │   │   └── plugins/          # remarkBlockId, remarkTag, remarkWikilink
│   │   ├── search/               # search orchestration
│   │   │   ├── searchPipeline.ts / synthesis.ts / reranker.ts
│   │   │   ├── filters.ts / graphExpansion.ts / savedQueries.ts / searchHistory.ts
│   │   │   ├── strategies/       # quick (BM25), balanced (vec+rerank), deep (agentic)
│   │   │   └── prompts/
│   │   ├── services/             # daemon services
│   │   │   ├── healthMonitor.ts / idleDetector.ts / probeCache.ts
│   │   │   ├── sessionGrants.ts / startupProbe.ts / vaultBootstrap.ts / vaultLock.ts
│   │   │   └── agentEventStore.ts
│   │   ├── settings/             # env + settings
│   │   ├── utils/atomicWrite.ts
│   │   ├── vault/                # vault identity (paths, secret, port files)
│   │   └── vitals/               # note vitals (freshness, vitalsService)
│   └── daemon/                   # long-running daemon
│       ├── index.ts              # daemon entry
│       ├── bootstrap.ts          # wires kernel + services + handlers
│       ├── lifecycle.ts          # PID + idle-exit timer
│       ├── socket.ts             # UDS path resolution
│       ├── rpc.ts                # envelope codec + MethodDispatcher
│       ├── surrealServer.ts      # spawns/stops the SurrealDB child
│       ├── watcher.ts            # chokidar-backed vault watcher (with WSL polling)
│       ├── coordinatorRunner.ts  # bridges EventBus events to the agent coordinator
│       ├── awaitBackgroundWorkers.ts
│       └── handlers/             # per-RPC method (chat, search, vault, notes, vitals,
│                                 #   awaken, agentAsk, agentBrief, agentDistill, agentEvents,
│                                 #   session)
│
├── testing/
│   ├── unit/                     # fast, no external deps. Mirror of src/ + tools/.
│   ├── integration/              # NOTIENT_SMOKE=1, spawns SurrealDB / subprocess /
│   │                             #   real chokidar. Mirror of src/ where applicable;
│   │                             #   __smoke__/ retained as a sub-tree.
│   └── fixtures/markdown/        # shared markdown samples for the markdown tests
│
└── tools/                        # standalone scripts (not bundled into dist/)
    ├── build-cli.ts              # production CLI build
    ├── lib/spawnEnv.ts           # hermetic env helpers used by the smoke harnesses
    ├── repro-multi-turn.ts       # standalone multi-turn chat repro
    ├── smoke-cli-phaseA.ts … phaseD1.ts   # live-LM-Studio end-to-end smokes
    └── import-bridge/            # standalone import-normalisation utility
```

---

## Architecture quick reference

Three boundaries matter:

1. **CLI ↔ daemon over Unix Domain Socket** (`src/daemon/socket.ts`, `src/daemon/rpc.ts`). Every CLI verb either reads from or RPC's into the daemon. The CLI may spawn the daemon if no UDS exists.

2. **Daemon ↔ SurrealDB** (`src/core/db/surreal.ts`, `src/daemon/surrealServer.ts`). The daemon owns the surreal child process. All persistence routes through `SurrealConnection`. Schema applied at startup via `applySchema`.

3. **Daemon ↔ local OpenAI-compatible AI server** through `src/core/llm/`. Chat, structured JSON extraction/reranking, vision, and embeddings all go through `LLMProvider`; the current production provider is `LMStudioProvider`. Vision probe at `src/agent/visionProbe.ts`.

The **awaken pipeline** is the indexer's batch driver. `awakenWorker` walks the vault, runs tier-1 (note + structure), tier-2 (chunks + embeddings), and tier-3 (extraction + linker proposals). `awaken_run` rows track progress for resume-on-restart.

The **coordinator** dispatches background swarm agents (linker, maturity advancer) when EventBus signals fire (e.g., `note:indexed`). Reasoning-model work is bounded by `chat.reasoningSlots` so it can use multi-slot local servers without silently oversubscribing them.

The **chat agent loop** (`src/core/chat/agentLoop.ts`) drives a tool-using turn over `ToolRegistry`. Tools live under `src/core/chat/tools/` (vault, notes, graph, proposals, registry).

---

## Conventions

- **No tests in `src/`.** Unit tests in `testing/unit/<mirror>`, integration in `testing/integration/<mirror>`. Fixtures in `testing/fixtures/`. Imports from tests traverse back to `../../../../src/...` (depth depends on file location).
- **Smoke gating.** Integration tests use `describe.skipIf(!SMOKE_ENABLED)` keyed off `process.env.NOTIENT_SMOKE === "1"`. Anything that spawns SurrealDB, a subprocess, or real chokidar is integration-only.
- **No `any` without justification.** Strict TypeScript. The repo allows unused locals / imports (so generated code stays cheap) but `useConst` is enforced.
- **Atomic writes.** Use `src/core/utils/atomicWrite.ts` rather than `fs.writeFile` directly when touching vault state.
- **Streaming.** LLM and search return `AsyncIterable<...Event>`. Respect `AbortSignal` in every long-running operation.
- **Identity.** `agent.ask` style handlers carry `clientIdentity` end-to-end (claude-code, human, etc.). Never drop or fabricate identity in handler plumbing.
- **Path aliases.** Only two are wired: `@/*` → `src/*` and `@core/*` → `src/core/*`. Prefer relative imports inside a subsystem.

---

## Anti-patterns

- Don't add tests under `src/`.
- Don't put product logic inside CLI command files. Commands marshal arguments and call into daemon RPC or core services.
- Don't bypass `LLMProvider`. Every model call goes through the provider so the chat-mode probe and vision routing work.
- Don't bypass `SurrealConnection`. No raw drivers, no per-call connect.
- Don't introduce parallel type systems. Reuse `src/core/db/surreal.ts` row types and `src/core/llm/provider.ts` message types.
- Don't catch + swallow `AbortError`. Propagate it so the agent loop can unwind cleanly.

---

## Versions

- Notient package: `0.1.0-phaseA`
- Bun: 1.3.10 (CI pinned)
- SurrealDB: 3.0.5 (CI pinned)
- TypeScript: ^5.6.0
- Biome: 1.9.0

## Archive

`.nuked/` previously held pre-pivot Obsidian-plugin code; the directory is gitignored and not present in the working tree. Never restore without explicit approval.
