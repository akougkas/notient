# Notient Phase 4 — Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each task is self-contained and assumes only the Phase 1 + Phase 2 + Phase 2.5 + Phase 3 codebase plus tasks above it. Steps use checkbox (`- [ ]`) syntax. Use Opus 4.7 implementer subagents only — no per-task spec/quality reviewers per user's stated preference.

**Goal:** Phase 4 turns the Phase 3 swarm into a flagship product. Two new headline surfaces ship: a **multi-turn tool-using chat agent** that talks to the user's second brain (with vault-stored conversations, per-call approval gates or yolo mode, eight-layer context awareness, cross-session memory, and native LM Studio tool/reasoning support), and a **knowledge SearchView** with three modes (Quick, Balanced, Deep) and a structured filter row that exposes Notient's full retrieval substrate (HNSW vectors, LLM rerank, graph expansion, agent provenance, vitals). A tabbed sidebar adds a Stream feed of agent insights ranked by `confidence × recency × relevance(active_note)`, a per-note Vitals panel, and the Chat surface. CodeMirror editor decorations show paragraph-end ambient awareness without mutating user notes. A native-graph bridge writes approved edges back to the vault as wikilinks and frontmatter list properties so Obsidian's own graph view shows them — Notient amplifies Obsidian, never replaces it. A JSON Canvas exporter generates `.canvas` files for synthesis previews and search-result spatial views. Universal undo finally activates the schema_v1 `history` table with kind-keyed inverters across every Notient mutation. Phase 4 is roughly twice the size of Phase 3 by file and test count, deliberately, because the chat and search surfaces are the v1.0 product story.

**Architecture (locked, references spec §9 + brainstorming Q1–Q8):**

- **Notient amplifies Obsidian, never replaces it.** Native primitives are leveraged, not shadowed: native graph view (populated via wikilink + frontmatter writeback), native JSON Canvas (we generate `.canvas` files; Obsidian renders), native Properties pane (Vitals values written to frontmatter when opt-in), native command palette (every Notient action is also `addCommand`), native CM6 (decorations only — never edits the document), native search (Quick mode is exposed as a Cmd+P fast-path that complements native global search; we do NOT replace `Cmd+Shift+F`). The only surfaces Notient owns outright are those Obsidian has no equivalent for: Stream, Vitals, Chat, SearchView (because Notient's filters can't be expressed in Obsidian's native search), CoAuthor, Approvals.
- **Trust gate stays a database wall (Phase 3 invariant carries forward).** No agent and no chat tool may write to the vault without either an explicit ApprovalCard click (safe mode) or a configured yolo override that still records every action to the `history` table for one-click undo. Brand pillar 2 ("Human steers, AI amplifies") is non-negotiable; yolo is opt-in with a confirmation modal and per-conversation override via frontmatter.
- **Vault-as-storage for chat.** Conversations are markdown files at `<vault>/Notient/conversations/<date> <slug>.md` with YAML frontmatter carrying `conversation_id`, `model`, `pinned_context`, `approval_mode`, `topic`, `summary`, `summary_embedding_b64`, `message_count`. Tool calls and approvals serialize as native Obsidian callouts (`> [!notient-tool]`, `> [!notient-approval]`) so Reading view renders them natively. Saved searches at `<vault>/Notient/searches/`; canvas previews at `<vault>/Notient/proposals/`. The indexer excludes these folders so chats and previews don't pollute the agent feed.
- **No schema migration in Phase 4.** Schema v2 (Phase 3) already carries `staging_edges`, `staging_nodes`, `agent_runs` and the schema_v1 `history` table is already present. Phase 4 activates `history` with producers + inverters and adds a `<vault>/Notient/.index.json` sidecar for chat conversation metadata + search history (vault-side, not SQLite). Schema version stays at 2.
- **Stream ranking** is multiplicative per Q1: `score = confidence × exp(-ageHours / halfLifeHours) × (relatedToActiveNote ? 1.0 : floor)` over pending `staging_edges` ∪ `staging_nodes` (`decision IS NULL`). Settings `stream.recencyHalfLifeHours = 12`, `stream.offNoteRelevanceFloor = 0.3`, `stream.maxItems = 50`.
- **Editor decorations** are CM6 ViewPlugin RangeSet widgets at paragraph end, mode-gated to Source / Live Preview, viewport-capped to top 5 paragraphs, debounced 200ms on doc change, invalidated on `agent:run-finished` and `approval:decided`. Decorations are read-only — they never modify a transaction.
- **Vitals** uses lazy render-time computation (`vitalsService.computeSnapshot`) plus eager persist on `vault:note-saved` and `agent:run-finished` (`vitalsService.persistSnapshot`). Freshness `= exp(-Δdays / 14)`. Health is a composite of `wordBand` (saturating curve over `word_count`, peaks at 600) + `chunkCoverage` + `hasApprovedEdges`. Connectivity counts `graph_edges` rows where the active note's graph_node is endpoint. Maturity is the categorical column directly. Closes STATE.md's freshness-placeholder tech-debt item.
- **Native graph bridge** writes wikilinks for approved `LINKS_TO` edges into the source note's `## Related` section and frontmatter list properties for typed relations (`notient.contradicts`, `notient.supports`, `notient.extends`, `notient.synthesizes_from`). Every write goes through `obsidianFacade.atomicWrite` after `echoGuard.mark(path, sha)` so the indexer skips the self-write. Obsidian's `metadataCache` re-resolves and the native graph re-renders — no view is registered.
- **JSON Canvas exporter** generates spec-compliant `.canvas` files for synthesis-proposal previews and SearchView "View as canvas" exports. Files land under `<vault>/Notient/proposals/` or `<vault>/Notient/searches/canvases/` and are opened via `workspace.openLinkText`. Obsidian's native canvas view takes over from there.
- **Search pipeline** is `searchPipeline.run({ query, mode, filters, limit, signal })` returning `AsyncIterable<SearchEvent>` so Deep mode can stream progress. Quick = `prepareFuzzySearch` over titles + chunks; Balanced = HNSW top-K=20 → LLM rerank top-N=5; Deep = Balanced + 1-hop graph expansion + grounded synthesis with citations. Filters compose: maturity, agent provenance, min confidence, folder, date range, connectivity tier, has-pending-proposals.
- **Multi-turn chat agent** runs an iterative tool-call loop (max 8 rounds per turn) wrapped in `mutex.runPriority("chat", ...)` — same priority lane as Co-author (last-priority-wins). Native OpenAI `tools` parameter is the primary backend with `chatJson<{tool, args}>` fallback for models that don't support function calling; mode is auto-probed on first turn per model and cached in settings. Reasoning models (Nemotron-cascade A3B, GPT-OSS, R1-distills) emit `reasoning_content` separate from `content` — Phase 2.5's reasoning_content fallback is extended to `chatStream`; reasoning is stripped from history before next turn but optionally rendered inline in a collapsible "Thinking…" block.
- **Eight-layer context composition** for every chat turn: (1) identity, (2) user profile + voice, (3) vault snapshot, (4) workspace state (open notes + last-5 viewed + Notient search history), (5) pinned context, (6) cross-session memory (top-2 past conversations by cosine sim ≥ 0.7 on user-message embedding), (7) tool catalog, (8) conversation history with budget-aware summarization at 70% context.
- **Universal undo** records every mutation to `history` with a `kind` discriminator and a `before/after` JSON pair. A `historyService` registry maps each kind to an inverter that reverses the mutation (delete the live edge, restore the staging row, restore frontmatter, delete the created note, etc.). Undo is exposed as `notient-undo-last` in the command palette, as a per-action pill in yolo mode, and as a history modal. Retention: last 500 rows globally, last 50 per `target`, pruned on plugin start.
- **TypeScript strict, Bun test, no `console.log` in production, no abbreviations, no `[noun] - [parenthetical]` dash patterns, no emojis in source.** Each task ends with a single commit on `beta-spec`. **No tag at end of phase.** Version stays at 0.2.0.

**Tech Stack:** TypeScript strict • Bun test • sql.js (existing) • `hnswlib-wasm` (existing) • OpenAI-compatible JSON over fetch (existing) • Obsidian Modal / View / Workspace / MetadataCache APIs • CodeMirror 6 (`@codemirror/view`, `@codemirror/state`) — already a transitive dep via Obsidian — • Preact + `@preact/signals` (already in deps) • a tiny in-house markdown-callout parser (no new dep) • JSON Canvas 1.0 spec (no runtime).

**Definition of done (from spec §13 row 4):**
- Open the Stream tab → top 5 ranked items display within 100 ms (warm DB), reflect changes when an agent run completes, and update relevance when the active note changes.
- Open any indexed note (≥100 words) → paragraph-end decoration dots appear within 200 ms of layout for paragraphs that have pending proposals; click on a dot opens the Stream tab to that proposal.
- Open the Vitals tab → freshness, health, connectivity, maturity render for the active note; values agree with the SQL row produced by `persistSnapshot` after a save.
- Approve a `LINKS_TO` staging edge → the source note's `## Related` section gains a `[[Target]]` line and Obsidian's native graph displays the new edge after `metadataCache:resolved`.
- Approve a `CONTRADICTS` staging edge → the source note's frontmatter `notient.contradicts` array gains the target wikilink.
- Click "Preview as canvas" on a Synthesizer staging proposal → a `.canvas` file appears under `Notient/proposals/` and opens in Obsidian's native canvas view with one card per source note + one card for the synthesis stub.
- SearchView (Cmd+P → "Notient: Search") opens; entering a query in Balanced mode returns ≥1 result on the test vault within 3 s; toggling a maturity filter re-executes within 500 ms; "View as canvas" produces a valid `.canvas`.
- Deep mode produces a synthesis card whose every claim cites a `[[note]]`; citations are clickable and open the cited note.
- Open the Chat tab → starting a conversation persists `<vault>/Notient/conversations/<date> <slug>.md`; the file roundtrips back into `ChatMessage[]` via the parser; Obsidian's native search finds the conversation.
- Asking the chat "what notes contradict my view on X?" results in the agent calling `vault.search_notes` (Balanced) and `agents.contradiction_check` autonomously; the assistant's response cites every claim.
- A write-tool call in safe mode renders an inline ApprovalCard with a markdown diff; clicking Approve executes; clicking Reject feeds the rejection reason back to the agent.
- Toggling chat to yolo mode (after the confirmation modal) auto-approves write tools; each auto-approval renders an "● auto-approved · undo" pill that restores the previous state via `historyService.undo`.
- `notient-undo-last` from the command palette undoes the most recent mutation; running it 5× sequentially undoes the 5 most recent mutations across approvals, frontmatter writes, note creates, and chat tool actions.
- `bun run typecheck && bun run lint && bun test` all green; total tests ≥ 250 (Phase 3 closed at 154; Phase 4 adds ≥100).
- `bun run smoke:phase4` runs against dynamo + the test vault and prints a single line `[smoke] phase4: stream=N decorations=M vitals=ok bridge=ok canvas=ok search=ok chat=ok undo=ok` with no failures.

**Phase 4 git tag:** none. Version stays at 0.2.0 in both `manifest.json` and `package.json`. Tagging is reserved for the v1.0 release.

---

## File Structure (locked before tasks)

### Settings + bootstrap (Task 0)
- `src/core/settings/types.ts` (extend `NotientSettings`)
- `src/core/settings/settingsService.ts` (extend defaults)
- `src/core/services/vaultBootstrap.ts` (new)
- `src/core/services/vaultBootstrap.test.ts` (new)
- `src/core/indexer/excludePaths.ts` (new)
- `src/core/indexer/excludePaths.test.ts` (new)

### Tabbed sidebar (Task 1)
- `src/ui/sidebar/state.ts` (new)
- `src/ui/sidebar/state.test.ts` (new)
- `src/ui/sidebar/components/TabBar.tsx` (new)
- `src/ui/sidebar/components/TabBar.test.tsx` (new)
- `src/ui/sidebar/components/StreamTab.tsx` (stub in this task)
- `src/ui/sidebar/components/VitalsTab.tsx` (stub in this task)
- `src/ui/sidebar/components/ChatTab.tsx` (stub in this task)
- `src/ui/sidebar/App.tsx` (rewire to tabs)

### Stream feed (Task 2)
- `src/core/stream/types.ts`
- `src/core/stream/streamService.ts`
- `src/core/stream/streamService.test.ts`
- `src/core/stream/ranking.ts`
- `src/core/stream/ranking.test.ts`
- `src/ui/sidebar/components/StreamTab.tsx` (replace stub)
- `src/ui/sidebar/components/StreamItemCard.tsx`

### Vitals (Task 3)
- `src/core/vitals/types.ts`
- `src/core/vitals/vitalsService.ts`
- `src/core/vitals/vitalsService.test.ts`
- `src/core/vitals/freshness.ts`
- `src/core/vitals/freshness.test.ts`
- `src/ui/sidebar/components/VitalsTab.tsx` (replace stub)
- `src/ui/sidebar/components/VitalMeter.tsx`

### Editor decorations (Task 4)
- `src/ui/editor/decorations/insightsPlugin.ts`
- `src/ui/editor/decorations/insightsPlugin.test.ts`
- `src/ui/editor/decorations/paragraphMap.ts`
- `src/ui/editor/decorations/paragraphMap.test.ts`
- `src/ui/editor/decorations/InsightDot.ts`
- `styles.css` (extend with `.notient-insight-dot`)

### Native graph bridge + canvas (Task 5)
- `src/core/graph/nativeGraphBridge.ts`
- `src/core/graph/nativeGraphBridge.test.ts`
- `src/core/graph/relatedSection.ts`
- `src/core/graph/relatedSection.test.ts`
- `src/core/canvas/canvasGenerator.ts`
- `src/core/canvas/canvasGenerator.test.ts`
- `src/core/canvas/types.ts`
- `src/core/approvals/approvalService.ts` (extend to call bridge)

### Search pipeline core (Task 6)
- `src/core/search/types.ts`
- `src/core/search/searchPipeline.ts`
- `src/core/search/searchPipeline.test.ts`
- `src/core/search/filters.ts`
- `src/core/search/filters.test.ts`
- `src/core/search/strategies/quick.ts`
- `src/core/search/strategies/quick.test.ts`
- `src/core/search/strategies/balanced.ts`
- `src/core/search/strategies/balanced.test.ts`
- `src/core/search/reranker.ts`
- `src/core/search/reranker.test.ts`
- `src/core/search/prompts/rerank.ts`

### Search Deep mode + synthesis (Task 7)
- `src/core/search/strategies/deep.ts`
- `src/core/search/strategies/deep.test.ts`
- `src/core/search/synthesis.ts`
- `src/core/search/synthesis.test.ts`
- `src/core/search/prompts/deepSynthesize.ts`
- `src/core/search/graphExpansion.ts`
- `src/core/search/graphExpansion.test.ts`

### SearchView UI (Task 8)
- `src/ui/search/SearchView.ts`
- `src/ui/search/SearchApp.tsx`
- `src/ui/search/components/QueryBar.tsx`
- `src/ui/search/components/FilterRow.tsx`
- `src/ui/search/components/ResultList.tsx`
- `src/ui/search/components/ResultRow.tsx`
- `src/ui/search/components/PreviewPane.tsx`
- `src/ui/search/components/SynthesisCard.tsx`
- `src/ui/search/components/HistoryDropdown.tsx`
- `src/ui/search/state.ts`

### Saved searches + history + wiring (Task 9)
- `src/core/search/savedQueries.ts`
- `src/core/search/savedQueries.test.ts`
- `src/core/search/searchHistory.ts`
- `src/core/search/searchHistory.test.ts`
- `src/ui/search/canvasFromResults.ts`
- `src/ui/search/canvasFromResults.test.ts`

### Conversation storage (Task 10)
- `src/core/chat/types.ts`
- `src/core/chat/conversationStore.ts`
- `src/core/chat/conversationStore.test.ts`
- `src/core/chat/conversationParser.ts`
- `src/core/chat/conversationParser.test.ts`
- `src/core/chat/conversationIndex.ts`
- `src/core/chat/conversationIndex.test.ts`

### Chat tool registry + read-only tools (Task 11)
- `src/core/chat/tools/registry.ts`
- `src/core/chat/tools/registry.test.ts`
- `src/core/chat/tools/vault.ts`
- `src/core/chat/tools/vault.test.ts`
- `src/core/chat/tools/graph.ts`
- `src/core/chat/tools/graph.test.ts`
- `src/core/chat/tools/agents.ts`
- `src/core/chat/tools/agents.test.ts`
- `src/core/chat/tools/proposals.ts`
- `src/core/chat/tools/proposals.test.ts`

### Chat write-gated tools + LM Studio extensions (Task 12)
- `src/core/chat/tools/notes.ts`
- `src/core/chat/tools/notes.test.ts`
- `src/core/chat/approvalGate.ts`
- `src/core/chat/approvalGate.test.ts`
- `src/core/chat/toolModeProbe.ts`
- `src/core/chat/toolModeProbe.test.ts`
- `src/core/llm/lmStudioProvider.ts` (extend with `chatWithTools`)
- `src/core/llm/provider.ts` (extend interface)

### Chat agent loop + context manager (Task 13)
- `src/core/chat/agentLoop.ts`
- `src/core/chat/agentLoop.test.ts`
- `src/core/chat/contextManager.ts`
- `src/core/chat/contextManager.test.ts`
- `src/core/chat/chatService.ts`
- `src/core/chat/chatService.test.ts`
- `src/core/chat/prompts/system.ts`
- `src/core/chat/prompts/summarize.ts`

### Chat tab UI (Task 14)
- `src/ui/sidebar/components/ChatTab.tsx` (replace stub)
- `src/ui/sidebar/components/MessageBubble.tsx`
- `src/ui/sidebar/components/ToolCallCard.tsx`
- `src/ui/sidebar/components/ApprovalCard.tsx`
- `src/ui/sidebar/components/CitationLink.tsx`
- `src/ui/sidebar/components/ConversationsDrawer.tsx`
- `src/ui/sidebar/components/ContextChip.tsx`
- `src/ui/sidebar/components/ReasoningBlock.tsx`
- `src/ui/sidebar/chat-state.ts`

### Universal undo (Task 15)
- `src/core/history/types.ts`
- `src/core/history/historyService.ts`
- `src/core/history/historyService.test.ts`
- `src/core/history/inverters/edgeApprove.ts`
- `src/core/history/inverters/edgeReject.ts`
- `src/core/history/inverters/nodeApprove.ts`
- `src/core/history/inverters/nodeReject.ts`
- `src/core/history/inverters/noteAppendSection.ts`
- `src/core/history/inverters/noteFrontmatter.ts`
- `src/core/history/inverters/noteCreate.ts`
- `src/core/history/inverters/noteMaturity.ts`
- `src/core/history/inverters.test.ts`
- `src/ui/history/HistoryModal.ts`

### Wiring + smoke + close-out (Task 16)
- `src/main.ts` (full Phase 4 wiring)
- `src/core/kernel.ts` (add Phase 4 service keys)
- `scripts/smoke-phase4.ts`
- `package.json` (add `smoke:phase4` script)
- `.planning/STATE.md` (local-only — `.planning/` is gitignored; this file is updated for the next session's context but is **not** committed)

---

<!-- TASKS_BEGIN -->

## Task 0: Settings extension + vault folder bootstrap + indexer exclusion

**Files:**
- Modify: `src/core/settings/types.ts`
- Modify: `src/core/settings/settingsService.ts` (only if defaults shape changes its merge logic; usually no)
- Create: `src/core/services/vaultBootstrap.ts`
- Create: `src/core/services/vaultBootstrap.test.ts`
- Create: `src/core/indexer/excludePaths.ts`
- Create: `src/core/indexer/excludePaths.test.ts`

**Why:** Phase 4 introduces seven new feature surfaces, each carrying a small settings cluster. Centralising the type extension in one task keeps later tasks focused on behaviour, not config wiring. The vault bootstrap creates the three Notient-owned folders (`conversations/`, `proposals/`, `searches/`) on plugin load so chat, canvas exports, and saved searches always have a stable home. The indexer exclusion ensures Notient's own vault writes don't loop back into the chunker as if they were user notes; this is a precondition for chat persistence working without polluting the agent feed.

- [ ] **Step 1: Extend `NotientSettings` and `DEFAULT_SETTINGS`**

Replace `src/core/settings/types.ts` with the extended definition (additive — no existing fields removed):

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
    model: string;
  };
  approvals: {
    confidenceThreshold: number;
  };
  awakenedAt: number | null;

  // Phase 4 — Stream
  stream: {
    recencyHalfLifeHours: number;
    offNoteRelevanceFloor: number;
    maxItems: number;
  };

  // Phase 4 — Vitals
  vitals: {
    freshnessHalfLifeDays: number;
    healthWeights: { wordBand: number; chunkCoverage: number; hasApprovedEdges: number };
    connectivityThresholds: { sparse: number; connected: number; hub: number };
    writeToFrontmatter: boolean;
  };

  // Phase 4 — Editor decorations
  decorations: {
    enabled: boolean;
    maxPerViewport: number;
    debounceMs: number;
    minWordsToDecorate: number;
  };

  // Phase 4 — Native graph bridge
  nativeGraph: {
    writeRelatedSection: boolean;
    writeFrontmatterRelations: boolean;
    relatedSectionHeading: string;
  };

  // Phase 4 — Search
  search: {
    defaultMode: "quick" | "balanced" | "deep";
    balanced: { topK: number; rerankTopN: number };
    deep: { graphExpansionDepth: number; synthesisEnabled: boolean };
    history: { maxQueries: number };
    savedQueriesFolder: string;
    previewEnabled: boolean;
  };

  // Phase 4 — Chat
  chat: {
    enabled: boolean;
    approvalMode: "safe" | "yolo";
    persistReasoning: boolean;
    toolModeByModel: Record<string, "native" | "json-fallback" | "disabled">;
    conversationsFolder: string;
    proposalsFolder: string;
    maxRoundsPerTurn: number;
    contextBudgetFraction: number;
    context: {
      includeUserProfile: boolean;
      includeVaultSnapshot: boolean;
      includeWorkspaceState: boolean;
      includeCrossSessionMemory: boolean;
      crossSessionTopK: number;
      crossSessionSimThreshold: number;
      pinnedNoteMaxTokens: number;
    };
  };

  // Phase 4 — Universal undo
  history: {
    retentionMaxRows: number;
    retentionMaxRowsPerTarget: number;
  };

  // Phase 4 — Indexer exclusion
  indexer: {
    excludePaths: string[];
  };
}

export const DEFAULT_SETTINGS: NotientSettings = {
  primary: {
    baseUrl: "http://192.168.86.143:1234/v1",
    reasoningModel: "nemotron-cascade-2-30b-a3b-i1",
    embeddingModel: "text-embedding-nomic-embed-text-v2-moe",
    fastModel: "nemotron-cascade-2-30b-a3b-i1",
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
    model: "gemma-4-26b-a4b-it",
  },
  approvals: {
    confidenceThreshold: 0.6,
  },
  awakenedAt: null,
  stream: {
    recencyHalfLifeHours: 12,
    offNoteRelevanceFloor: 0.3,
    maxItems: 50,
  },
  vitals: {
    freshnessHalfLifeDays: 14,
    healthWeights: { wordBand: 1, chunkCoverage: 1, hasApprovedEdges: 1 },
    connectivityThresholds: { sparse: 1, connected: 4, hub: 12 },
    writeToFrontmatter: false,
  },
  decorations: {
    enabled: true,
    maxPerViewport: 5,
    debounceMs: 200,
    minWordsToDecorate: 100,
  },
  nativeGraph: {
    writeRelatedSection: true,
    writeFrontmatterRelations: true,
    relatedSectionHeading: "Related",
  },
  search: {
    defaultMode: "quick",
    balanced: { topK: 20, rerankTopN: 5 },
    deep: { graphExpansionDepth: 1, synthesisEnabled: true },
    history: { maxQueries: 50 },
    savedQueriesFolder: "Notient/searches",
    previewEnabled: true,
  },
  chat: {
    enabled: true,
    approvalMode: "safe",
    persistReasoning: false,
    toolModeByModel: {},
    conversationsFolder: "Notient/conversations",
    proposalsFolder: "Notient/proposals",
    maxRoundsPerTurn: 8,
    contextBudgetFraction: 0.7,
    context: {
      includeUserProfile: true,
      includeVaultSnapshot: true,
      includeWorkspaceState: true,
      includeCrossSessionMemory: true,
      crossSessionTopK: 2,
      crossSessionSimThreshold: 0.7,
      pinnedNoteMaxTokens: 4000,
    },
  },
  history: {
    retentionMaxRows: 500,
    retentionMaxRowsPerTarget: 50,
  },
  indexer: {
    excludePaths: ["Notient/conversations", "Notient/proposals", "Notient/searches"],
  },
};
```

If `settingsService.ts` performs a shallow merge, audit it in this step: deep merges per top-level key are required so a user with an older `data.json` doesn't blow away the new defaults on load. Add a `mergeSettings(defaults, persisted)` helper that does one level of recursion if it isn't already there, and add a small test in `settingsService.test.ts` that loads partial persisted state and asserts the new fields fall back to defaults.

- [ ] **Step 2: Write the vault bootstrap test**

Create `src/core/services/vaultBootstrap.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { VaultBootstrap } from "./vaultBootstrap";

interface FakeFacade {
  exists: (path: string) => Promise<boolean>;
  createFolder: (path: string) => Promise<void>;
  created: string[];
  existing: Set<string>;
}

function makeFacade(existing: string[] = []): FakeFacade {
  const facade: FakeFacade = {
    existing: new Set(existing),
    created: [],
    exists: async (path) => facade.existing.has(path),
    createFolder: async (path) => {
      facade.created.push(path);
      facade.existing.add(path);
    },
  };
  return facade;
}

describe("VaultBootstrap", () => {
  test("creates the three Notient folders on first run", async () => {
    const facade = makeFacade();
    const bootstrap = new VaultBootstrap({ facade });
    await bootstrap.run({
      conversationsFolder: "Notient/conversations",
      proposalsFolder: "Notient/proposals",
      savedQueriesFolder: "Notient/searches",
    });
    expect(facade.created).toEqual([
      "Notient",
      "Notient/conversations",
      "Notient/proposals",
      "Notient/searches",
    ]);
  });

  test("skips folders that already exist", async () => {
    const facade = makeFacade(["Notient", "Notient/conversations"]);
    const bootstrap = new VaultBootstrap({ facade });
    await bootstrap.run({
      conversationsFolder: "Notient/conversations",
      proposalsFolder: "Notient/proposals",
      savedQueriesFolder: "Notient/searches",
    });
    expect(facade.created).toEqual(["Notient/proposals", "Notient/searches"]);
  });

  test("creates parent before child even when configured paths share a prefix", async () => {
    const facade = makeFacade();
    const bootstrap = new VaultBootstrap({ facade });
    await bootstrap.run({
      conversationsFolder: "Notient/sub/conversations",
      proposalsFolder: "Notient/sub/proposals",
      savedQueriesFolder: "Notient/sub/searches",
    });
    expect(facade.created[0]).toBe("Notient");
    expect(facade.created[1]).toBe("Notient/sub");
  });
});
```

- [ ] **Step 3: Implement `VaultBootstrap`**

Create `src/core/services/vaultBootstrap.ts`:

```typescript
export interface VaultBootstrapFacade {
  exists(path: string): Promise<boolean>;
  createFolder(path: string): Promise<void>;
}

export interface VaultBootstrapOptions {
  facade: VaultBootstrapFacade;
}

export interface VaultBootstrapPaths {
  conversationsFolder: string;
  proposalsFolder: string;
  savedQueriesFolder: string;
}

export class VaultBootstrap {
  constructor(private readonly options: VaultBootstrapOptions) {}

  async run(paths: VaultBootstrapPaths): Promise<void> {
    const ordered = collectAncestors([
      paths.conversationsFolder,
      paths.proposalsFolder,
      paths.savedQueriesFolder,
    ]);
    for (const folder of ordered) {
      if (await this.options.facade.exists(folder)) continue;
      await this.options.facade.createFolder(folder);
    }
  }
}

function collectAncestors(paths: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const segment = parts.slice(0, i).join("/");
      if (seen.has(segment)) continue;
      seen.add(segment);
      ordered.push(segment);
    }
  }
  return ordered;
}
```

The implementer wires this into `main.ts` in Task 16; for now we only ship the module + tests.

- [ ] **Step 4: Write the indexer-exclusion test**

Create `src/core/indexer/excludePaths.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { isExcluded, normalizeExcludePatterns } from "./excludePaths";

describe("excludePaths", () => {
  test("matches paths beneath an excluded folder", () => {
    const patterns = normalizeExcludePatterns(["Notient/conversations"]);
    expect(isExcluded("Notient/conversations/2026-04-25 chat.md", patterns)).toBe(true);
    expect(isExcluded("Notient/conversations/sub/chat.md", patterns)).toBe(true);
  });

  test("does not match paths outside excluded folders", () => {
    const patterns = normalizeExcludePatterns(["Notient/conversations"]);
    expect(isExcluded("notes/topic.md", patterns)).toBe(false);
    expect(isExcluded("Notient/conversations.md", patterns)).toBe(false);
  });

  test("matches the exact folder boundary, not a substring", () => {
    const patterns = normalizeExcludePatterns(["Note"]);
    expect(isExcluded("Note/x.md", patterns)).toBe(true);
    expect(isExcluded("Notebook/x.md", patterns)).toBe(false);
  });

  test("normalises trailing slashes and leading dots", () => {
    const patterns = normalizeExcludePatterns(["Notient/conversations/", "./Notient/proposals"]);
    expect(isExcluded("Notient/conversations/x.md", patterns)).toBe(true);
    expect(isExcluded("Notient/proposals/y.md", patterns)).toBe(true);
  });
});
```

- [ ] **Step 5: Implement `excludePaths`**

Create `src/core/indexer/excludePaths.ts`:

```typescript
export type ExcludePattern = { kind: "folder"; segments: string[] };

export function normalizeExcludePatterns(input: string[]): ExcludePattern[] {
  return input
    .map((raw) => raw.replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter((raw) => raw.length > 0)
    .map((raw) => ({ kind: "folder", segments: raw.split("/") }));
}

export function isExcluded(path: string, patterns: ExcludePattern[]): boolean {
  const parts = path.split("/");
  for (const pattern of patterns) {
    if (parts.length <= pattern.segments.length) continue;
    let matches = true;
    for (let i = 0; i < pattern.segments.length; i++) {
      if (parts[i] !== pattern.segments[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}
```

The implementer wires `isExcluded` into the indexer's queue producer in Task 16 (one-line guard before each `enqueue` call). For Task 0 we only ship the helper + tests.

- [ ] **Step 6: Verify**

Run: `bun run typecheck && bun run lint && bun test`

Expected: all 4 new bootstrap/exclude tests pass; existing tests stay green; settings type compiles.

- [ ] **Step 7: Commit**

```bash
git add src/core/settings/types.ts src/core/services/vaultBootstrap.ts src/core/services/vaultBootstrap.test.ts src/core/indexer/excludePaths.ts src/core/indexer/excludePaths.test.ts
git commit -m "feat(settings): Phase 4 settings + vault folder bootstrap + indexer exclude paths"
```



## Task 1: Tabbed sidebar shell

**Files:**
- Create: `src/ui/sidebar/state.ts`
- Create: `src/ui/sidebar/state.test.ts`
- Create: `src/ui/sidebar/components/TabBar.tsx`
- Create: `src/ui/sidebar/components/TabBar.test.tsx`
- Create: `src/ui/sidebar/components/StreamTab.tsx` (stub body, replaced in Task 2)
- Create: `src/ui/sidebar/components/VitalsTab.tsx` (stub body, replaced in Task 3)
- Create: `src/ui/sidebar/components/ChatTab.tsx` (stub body, replaced in Task 14)
- Modify: `src/ui/sidebar/App.tsx`

**Why:** Phase 4 introduces three new sidebar surfaces that need a shared shell. Doing the tab plumbing as its own task before any tab body lands keeps Tasks 2 / 3 / 14 focused on their feature rather than on UI-skeleton work. The existing single-pane `App.tsx` (header + three buttons + recent-runs list + footer) gets rewritten into a `TabBar` + active-tab body shell. Per Q5's integration philosophy, CoAuthor and Approvals stay as their existing dedicated ItemViews — they are not folded into tabs.

- [ ] **Step 1: Write the sidebar state test**

Create `src/ui/sidebar/state.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { activeTab, setActiveTab, type SidebarTab } from "./state";

describe("sidebar state", () => {
  test("defaults to stream", () => {
    expect(activeTab.value).toBe("stream");
  });

  test("setActiveTab updates the signal", () => {
    setActiveTab("vitals");
    expect(activeTab.value).toBe("vitals");
    setActiveTab("chat");
    expect(activeTab.value).toBe("chat");
    setActiveTab("stream");
    expect(activeTab.value).toBe("stream");
  });

  test("rejects unknown tabs at the type boundary", () => {
    const valid: SidebarTab[] = ["stream", "vitals", "chat"];
    for (const tab of valid) {
      setActiveTab(tab);
      expect(activeTab.value).toBe(tab);
    }
  });
});
```

- [ ] **Step 2: Implement sidebar state**

Create `src/ui/sidebar/state.ts`:

```typescript
import { signal } from "@preact/signals";

export type SidebarTab = "stream" | "vitals" | "chat";

export const activeTab = signal<SidebarTab>("stream");

export function setActiveTab(tab: SidebarTab): void {
  activeTab.value = tab;
}
```

The stream / vitals / chat content signals are owned by their respective tasks (Task 2 adds `streamItems`, Task 3 adds `vitalsSnapshot`, Task 14 adds `chatState`). This module owns only navigation state.

- [ ] **Step 3: Write the TabBar test**

Create `src/ui/sidebar/components/TabBar.test.tsx`:

```typescript
import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { activeTab, setActiveTab } from "../state";
import { TabBar } from "./TabBar";

describe("TabBar", () => {
  test("renders three tabs with the active one marked", () => {
    setActiveTab("stream");
    const html = render(<TabBar pendingApprovals={3} />);
    expect(html).toContain('data-tab="stream"');
    expect(html).toContain('data-tab="vitals"');
    expect(html).toContain('data-tab="chat"');
    expect(html).toContain("notient-tab--active");
  });

  test("renders the pending-approvals badge on the stream tab when count > 0", () => {
    setActiveTab("stream");
    const withBadge = render(<TabBar pendingApprovals={3} />);
    expect(withBadge).toContain("notient-tab__badge");
    expect(withBadge).toContain(">3<");
    const withoutBadge = render(<TabBar pendingApprovals={0} />);
    expect(withoutBadge).not.toContain("notient-tab__badge");
  });

  test("active tab reflects state.activeTab signal value", () => {
    setActiveTab("vitals");
    const html = render(<TabBar pendingApprovals={0} />);
    const vitalsActive = /data-tab="vitals"[^>]*notient-tab--active/.test(html);
    expect(vitalsActive).toBe(true);
  });

  test("renders all tab labels", () => {
    setActiveTab("stream");
    const html = render(<TabBar pendingApprovals={0} />);
    expect(html).toContain("Stream");
    expect(html).toContain("Vitals");
    expect(html).toContain("Chat");
  });
});
```

(`preact-render-to-string` is added as a devDependency in this step if not already present: `bun add -d preact-render-to-string`. Phase 3 may have added it for `coAuthorRender.test.ts` — confirm and skip if so.)

- [ ] **Step 4: Implement TabBar**

Create `src/ui/sidebar/components/TabBar.tsx`:

```typescript
import { activeTab, setActiveTab, type SidebarTab } from "../state";

interface TabDefinition {
  id: SidebarTab;
  label: string;
}

const TABS: TabDefinition[] = [
  { id: "stream", label: "Stream" },
  { id: "vitals", label: "Vitals" },
  { id: "chat", label: "Chat" },
];

export interface TabBarProps {
  pendingApprovals: number;
}

export function TabBar({ pendingApprovals }: TabBarProps) {
  const current = activeTab.value;
  return (
    <nav class="notient-tabs" role="tablist">
      {TABS.map((tab) => {
        const isActive = current === tab.id;
        const showBadge = tab.id === "stream" && pendingApprovals > 0;
        return (
          <button
            type="button"
            role="tab"
            aria-selected={isActive}
            data-tab={tab.id}
            class={`notient-tab${isActive ? " notient-tab--active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span class="notient-tab__label">{tab.label}</span>
            {showBadge ? <span class="notient-tab__badge">{pendingApprovals}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
```

CSS classes follow the existing `notient-*` naming convention (no inline styles per project rules). The implementer adds the matching styles to `styles.css` in this step:

```css
.notient-tabs { display: flex; gap: 4px; padding: 8px; border-bottom: 1px solid var(--background-modifier-border); }
.notient-tab { flex: 1; background: transparent; border: 1px solid transparent; padding: 6px 10px; border-radius: 6px; cursor: pointer; color: var(--text-muted); }
.notient-tab--active { background: var(--background-secondary); border-color: var(--background-modifier-border); color: var(--text-normal); }
.notient-tab__label { font-weight: 500; }
.notient-tab__badge { margin-left: 6px; background: var(--interactive-accent); color: var(--text-on-accent); border-radius: 999px; padding: 0 6px; font-size: 11px; }
```

- [ ] **Step 5: Create stub tab bodies**

Create `src/ui/sidebar/components/StreamTab.tsx`:

```typescript
export function StreamTab() {
  return (
    <section class="notient-tab-body notient-tab-body--stream">
      <p class="notient-empty">Stream feed lands in Task 2.</p>
    </section>
  );
}
```

Create `src/ui/sidebar/components/VitalsTab.tsx`:

```typescript
export function VitalsTab() {
  return (
    <section class="notient-tab-body notient-tab-body--vitals">
      <p class="notient-empty">Vitals panel lands in Task 3.</p>
    </section>
  );
}
```

Create `src/ui/sidebar/components/ChatTab.tsx`:

```typescript
export function ChatTab() {
  return (
    <section class="notient-tab-body notient-tab-body--chat">
      <p class="notient-empty">Chat surface lands in Task 14.</p>
    </section>
  );
}
```

These three files are deliberately minimal so Task 1 can ship a green test suite without depending on Tasks 2 / 3 / 14.

- [ ] **Step 6: Rewire `App.tsx`**

Replace `src/ui/sidebar/App.tsx` with the tabbed shell:

```typescript
import { signal } from "@preact/signals";
import { type FooterState, StatusFooter } from "./components/StatusFooter";
import { TabBar } from "./components/TabBar";
import { StreamTab } from "./components/StreamTab";
import { VitalsTab } from "./components/VitalsTab";
import { ChatTab } from "./components/ChatTab";
import { activeTab } from "./state";

export interface SidebarActions {
  openCoAuthor: () => void;
  openApprovals: () => void;
  openAwaken: () => void;
  openSearch: () => void;
}

export const footerState = signal<FooterState>({ endpoints: [], noteCount: 0 });
export const pendingApprovalsState = signal<number>(0);
export const sidebarActions = signal<SidebarActions | null>(null);
export const tickState = signal<number>(0);

export function App() {
  const tab = activeTab.value;
  const pending = pendingApprovalsState.value;
  void tickState.value;

  return (
    <div class="notient-app">
      <header class="notient-header">
        <h2>Notient</h2>
        <p class="notient-subtitle">Mind layer online</p>
      </header>
      <TabBar pendingApprovals={pending} />
      <main class="notient-body">
        {tab === "stream" ? <StreamTab /> : null}
        {tab === "vitals" ? <VitalsTab /> : null}
        {tab === "chat" ? <ChatTab /> : null}
      </main>
      <StatusFooter state={footerState} />
    </div>
  );
}
```

The old `recentRunsState` signal is removed (its job is subsumed by the Stream tab). The old buttons block is removed; CoAuthor / Approvals / Awaken / Search remain reachable via ribbon icons + command palette (registered in Task 16). `sidebarActions` keeps `openCoAuthor` / `openApprovals` / `openAwaken` so Phase 3 wiring continues to compile, plus a forward-looking `openSearch` for Task 9.

- [ ] **Step 7: Verify**

Run: `bun run typecheck && bun run lint && bun test`

Expected: 4 new state tests + 4 new TabBar tests pass; existing tests stay green; sidebar renders without errors.

- [ ] **Step 8: Commit**

```bash
git add src/ui/sidebar/state.ts src/ui/sidebar/state.test.ts src/ui/sidebar/components/TabBar.tsx src/ui/sidebar/components/TabBar.test.tsx src/ui/sidebar/components/StreamTab.tsx src/ui/sidebar/components/VitalsTab.tsx src/ui/sidebar/components/ChatTab.tsx src/ui/sidebar/App.tsx styles.css
git commit -m "feat(sidebar): tabbed shell with Stream/Vitals/Chat tabs"
```



## Task 2: Stream feed ranking + StreamTab body

**Files:**
- Create: `src/core/stream/types.ts`
- Create: `src/core/stream/ranking.ts`
- Create: `src/core/stream/ranking.test.ts`
- Create: `src/core/stream/streamService.ts`
- Create: `src/core/stream/streamService.test.ts`
- Modify: `src/ui/sidebar/components/StreamTab.tsx` (replace stub)
- Create: `src/ui/sidebar/components/StreamItemCard.tsx`

**Why:** The Stream tab is the only place where pending staging proposals surface as a unified, ranked feed. Per Q1 the ranking is multiplicative — `score = confidence × exp(-ageHours / halfLifeHours) × (relatedToActiveNote ? 1.0 : floor)` — and reads from `staging_edges` + `staging_nodes` (`decision IS NULL`). The service owns one Preact signal that the tab consumes; refresh triggers are `agent:run-finished`, `approval:decided`, and `active-leaf-change`. Confidence-aware ordering is what turns Phase 3's flat "recent runs" list into an actionable feed.

- [ ] **Step 1: Define types**

Create `src/core/stream/types.ts`:

```typescript
export type StreamItemKind = "edge" | "node";

export interface StreamItem {
  id: string;
  kind: StreamItemKind;
  agent: string;
  type: string;
  confidence: number;
  rationale: string | null;
  createdAt: number;
  notePaths: string[];
  evidenceChunkIds: string[];
  score: number;
}

export interface StreamSettings {
  recencyHalfLifeHours: number;
  offNoteRelevanceFloor: number;
  maxItems: number;
}
```

`notePaths` carries the resolved path(s) for both endpoints of an edge or the home of a staged node. `evidenceChunkIds` is the parsed `evidence` JSON array — it powers Task 4's decoration mapping.

- [ ] **Step 2: Write the ranking test**

Create `src/core/stream/ranking.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { computeScore, rank, type RankInput } from "./ranking";

describe("stream ranking", () => {
  const settings = { recencyHalfLifeHours: 12, offNoteRelevanceFloor: 0.3, maxItems: 50 };

  test("score is multiplicative across the three factors", () => {
    const score = computeScore({
      confidence: 0.8,
      ageHours: 12,
      relatedToActiveNote: true,
      settings,
    });
    expect(score).toBeCloseTo(0.8 * Math.exp(-1) * 1.0, 6);
  });

  test("off-note items use the configured floor", () => {
    const score = computeScore({
      confidence: 0.5,
      ageHours: 0,
      relatedToActiveNote: false,
      settings,
    });
    expect(score).toBeCloseTo(0.5 * 1.0 * 0.3, 6);
  });

  test("recency decay halves at the configured half-life", () => {
    const fresh = computeScore({ confidence: 1, ageHours: 0, relatedToActiveNote: true, settings });
    const halflife = computeScore({
      confidence: 1,
      ageHours: settings.recencyHalfLifeHours,
      relatedToActiveNote: true,
      settings,
    });
    expect(halflife).toBeCloseTo(fresh * Math.exp(-1), 6);
  });

  test("rank sorts descending by score and respects maxItems", () => {
    const inputs: RankInput[] = [
      { id: "a", confidence: 0.4, ageHours: 0, relatedToActiveNote: false },
      { id: "b", confidence: 0.9, ageHours: 24, relatedToActiveNote: true },
      { id: "c", confidence: 0.7, ageHours: 0, relatedToActiveNote: true },
    ];
    const ranked = rank(inputs, { ...settings, maxItems: 2 });
    expect(ranked.map((r) => r.id)).toEqual(["c", "b"]);
    expect(ranked).toHaveLength(2);
  });

  test("zero confidence collapses score to zero", () => {
    expect(
      computeScore({ confidence: 0, ageHours: 0, relatedToActiveNote: true, settings }),
    ).toBe(0);
  });
});
```

- [ ] **Step 3: Implement ranking**

Create `src/core/stream/ranking.ts`:

```typescript
import type { StreamSettings } from "./types";

export interface ScoreInput {
  confidence: number;
  ageHours: number;
  relatedToActiveNote: boolean;
  settings: StreamSettings;
}

export function computeScore(input: ScoreInput): number {
  const recency = Math.exp(-input.ageHours / input.settings.recencyHalfLifeHours);
  const relevance = input.relatedToActiveNote ? 1 : input.settings.offNoteRelevanceFloor;
  return Math.max(0, input.confidence) * recency * relevance;
}

export interface RankInput {
  id: string;
  confidence: number;
  ageHours: number;
  relatedToActiveNote: boolean;
}

export interface Ranked extends RankInput {
  score: number;
}

export function rank(items: RankInput[], settings: StreamSettings): Ranked[] {
  const scored = items.map((item) => ({
    ...item,
    score: computeScore({
      confidence: item.confidence,
      ageHours: item.ageHours,
      relatedToActiveNote: item.relatedToActiveNote,
      settings,
    }),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, settings.maxItems);
}
```

- [ ] **Step 4: Write the service test**

Create `src/core/stream/streamService.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { EventBus } from "../events/eventBus";
import { StreamService } from "./streamService";

async function freshDb() {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await db.init();
  return db;
}

function seedEdge(db: Database, opts: {
  id: string;
  source: string;
  target: string;
  confidence: number;
  agent: string;
  evidence: string[];
  createdAt: number;
}): void {
  db.run(
    `INSERT INTO staging_edges (id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at)
     VALUES (?,?,?,?,?,?,?,?,?);`,
    [opts.id, "supports", opts.source, opts.target, opts.confidence, opts.agent, JSON.stringify(opts.evidence), null, opts.createdAt],
  );
}

function seedNode(db: Database, id: string): void {
  db.run(
    `INSERT INTO graph_nodes (id, type, label, note_path, payload, created_at) VALUES (?,?,?,?,?,?);`,
    [id, "note", id.replace(/^note:/, ""), id.replace(/^note:/, ""), null, 1],
  );
}

describe("StreamService", () => {
  test("ranks pending edges by confidence × recency × relevance", async () => {
    const db = await freshDb();
    seedNode(db, "note:/active.md");
    seedNode(db, "note:/other.md");
    const now = 100_000_000;
    seedEdge(db, { id: "e1", source: "note:/active.md", target: "note:/other.md", confidence: 0.9, agent: "linker", evidence: ["c1"], createdAt: now });
    seedEdge(db, { id: "e2", source: "note:/x.md", target: "note:/y.md", confidence: 0.95, agent: "synthesizer", evidence: ["c2"], createdAt: now });
    const bus = new EventBus();
    const svc = new StreamService({
      db,
      bus,
      now: () => now,
      getActivePath: () => "/active.md",
      settings: () => ({ recencyHalfLifeHours: 12, offNoteRelevanceFloor: 0.3, maxItems: 50 }),
    });
    svc.refresh();
    const items = svc.items.value;
    expect(items[0].id).toBe("e1");
    expect(items[1].id).toBe("e2");
    expect(items[0].score).toBeGreaterThan(items[1].score);
  });

  test("skips items whose decision is set", async () => {
    const db = await freshDb();
    seedNode(db, "note:/a.md");
    seedNode(db, "note:/b.md");
    seedEdge(db, { id: "e1", source: "note:/a.md", target: "note:/b.md", confidence: 0.9, agent: "linker", evidence: ["c1"], createdAt: 1 });
    db.run("UPDATE staging_edges SET decision = 'rejected', decided_at = ? WHERE id = ?;", [2, "e1"]);
    const bus = new EventBus();
    const svc = new StreamService({
      db,
      bus,
      now: () => 2,
      getActivePath: () => null,
      settings: () => ({ recencyHalfLifeHours: 12, offNoteRelevanceFloor: 0.3, maxItems: 50 }),
    });
    svc.refresh();
    expect(svc.items.value).toEqual([]);
  });

  test("includes pending staging_nodes alongside edges", async () => {
    const db = await freshDb();
    db.run(
      `INSERT INTO staging_nodes (id, type, label, note_path, payload, agent, confidence, created_at) VALUES (?,?,?,?,?,?,?,?);`,
      ["n1", "claim", "Big idea", "/active.md", null, "synthesizer", 0.85, 1],
    );
    const bus = new EventBus();
    const svc = new StreamService({
      db,
      bus,
      now: () => 1,
      getActivePath: () => "/active.md",
      settings: () => ({ recencyHalfLifeHours: 12, offNoteRelevanceFloor: 0.3, maxItems: 50 }),
    });
    svc.refresh();
    expect(svc.items.value).toHaveLength(1);
    expect(svc.items.value[0].kind).toBe("node");
  });

  test("refresh fires on agent:run-finished events", async () => {
    const db = await freshDb();
    const bus = new EventBus();
    const svc = new StreamService({
      db,
      bus,
      now: () => 1,
      getActivePath: () => null,
      settings: () => ({ recencyHalfLifeHours: 12, offNoteRelevanceFloor: 0.3, maxItems: 50 }),
    });
    svc.start();
    expect(svc.items.value).toEqual([]);
    seedNode(db, "note:/a.md");
    seedNode(db, "note:/b.md");
    seedEdge(db, { id: "e1", source: "note:/a.md", target: "note:/b.md", confidence: 0.7, agent: "linker", evidence: [], createdAt: 1 });
    bus.emit({ type: "agent:run-finished", agent: "linker", ok: true, proposals: 1, durationMs: 10, runId: 1 });
    expect(svc.items.value).toHaveLength(1);
    svc.stop();
  });

  test("refresh fires on active-leaf-change and re-evaluates relevance", async () => {
    const db = await freshDb();
    seedNode(db, "note:/a.md");
    seedNode(db, "note:/b.md");
    seedEdge(db, { id: "e1", source: "note:/a.md", target: "note:/b.md", confidence: 0.7, agent: "linker", evidence: [], createdAt: 1 });
    const bus = new EventBus();
    let active: string | null = null;
    const svc = new StreamService({
      db,
      bus,
      now: () => 1,
      getActivePath: () => active,
      settings: () => ({ recencyHalfLifeHours: 12, offNoteRelevanceFloor: 0.3, maxItems: 50 }),
    });
    svc.start();
    svc.refresh();
    const offNoteScore = svc.items.value[0].score;
    active = "/a.md";
    bus.emit({ type: "active-leaf-change", notePath: "/a.md", wordCount: 100 });
    const onNoteScore = svc.items.value[0].score;
    expect(onNoteScore).toBeGreaterThan(offNoteScore);
    svc.stop();
  });

  test("max-items cap limits results to settings.maxItems", async () => {
    const db = await freshDb();
    for (let i = 0; i < 10; i++) {
      seedNode(db, `note:/n${i}.md`);
    }
    for (let i = 0; i < 8; i++) {
      seedEdge(db, { id: `e${i}`, source: `note:/n${i}.md`, target: `note:/n${(i + 1) % 10}.md`, confidence: 0.5 + i * 0.05, agent: "linker", evidence: [], createdAt: 1 });
    }
    const bus = new EventBus();
    const svc = new StreamService({
      db,
      bus,
      now: () => 1,
      getActivePath: () => null,
      settings: () => ({ recencyHalfLifeHours: 12, offNoteRelevanceFloor: 0.3, maxItems: 3 }),
    });
    svc.refresh();
    expect(svc.items.value).toHaveLength(3);
  });
});
```

- [ ] **Step 5: Implement `StreamService`**

Create `src/core/stream/streamService.ts`:

```typescript
import { signal, type Signal } from "@preact/signals";
import type { Database } from "../db/database";
import type { EventBus } from "../events/eventBus";
import { computeScore } from "./ranking";
import type { StreamItem, StreamSettings } from "./types";

export interface StreamServiceOptions {
  db: Database;
  bus: EventBus;
  now: () => number;
  getActivePath: () => string | null;
  settings: () => StreamSettings;
}

interface StagingEdgeRow {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  confidence: number;
  agent: string;
  evidence: string;
  rationale: string | null;
  created_at: number;
}

interface StagingNodeRow {
  id: string;
  type: string;
  label: string;
  note_path: string | null;
  agent: string;
  confidence: number;
  created_at: number;
}

interface NodePathRow {
  id: string;
  note_path: string | null;
}

export class StreamService {
  readonly items: Signal<StreamItem[]> = signal<StreamItem[]>([]);
  private offRunFinished: (() => void) | null = null;
  private offApproval: (() => void) | null = null;
  private offLeafChange: (() => void) | null = null;

  constructor(private readonly options: StreamServiceOptions) {}

  start(): void {
    this.offRunFinished = this.options.bus.on("agent:run-finished", () => this.refresh());
    this.offApproval = this.options.bus.on("approval:decided", () => this.refresh());
    this.offLeafChange = this.options.bus.on("active-leaf-change", () => this.refresh());
    this.refresh();
  }

  stop(): void {
    this.offRunFinished?.();
    this.offApproval?.();
    this.offLeafChange?.();
    this.offRunFinished = null;
    this.offApproval = null;
    this.offLeafChange = null;
  }

  refresh(): void {
    const settings = this.options.settings();
    const now = this.options.now();
    const activePath = this.options.getActivePath();
    const edges = this.options.db.query<StagingEdgeRow>(
      `SELECT id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at
       FROM staging_edges WHERE decision IS NULL;`,
    );
    const nodes = this.options.db.query<StagingNodeRow>(
      `SELECT id, type, label, note_path, agent, confidence, created_at
       FROM staging_nodes WHERE decision IS NULL;`,
    );
    const referencedNodeIds = new Set<string>();
    for (const edge of edges) {
      referencedNodeIds.add(edge.source_id);
      referencedNodeIds.add(edge.target_id);
    }
    const pathByNodeId = this.lookupNotePaths(Array.from(referencedNodeIds));
    const items: StreamItem[] = [];
    for (const edge of edges) {
      const sourcePath = pathByNodeId.get(edge.source_id) ?? null;
      const targetPath = pathByNodeId.get(edge.target_id) ?? null;
      const notePaths = [sourcePath, targetPath].filter((p): p is string => p !== null);
      const related = activePath !== null && notePaths.includes(activePath);
      const ageHours = Math.max(0, (now - edge.created_at) / 3_600_000);
      const score = computeScore({
        confidence: edge.confidence,
        ageHours,
        relatedToActiveNote: related,
        settings,
      });
      items.push({
        id: edge.id,
        kind: "edge",
        agent: edge.agent,
        type: edge.type,
        confidence: edge.confidence,
        rationale: edge.rationale,
        createdAt: edge.created_at,
        notePaths,
        evidenceChunkIds: parseEvidence(edge.evidence),
        score,
      });
    }
    for (const node of nodes) {
      const notePaths = node.note_path ? [node.note_path] : [];
      const related = activePath !== null && notePaths.includes(activePath);
      const ageHours = Math.max(0, (now - node.created_at) / 3_600_000);
      const score = computeScore({
        confidence: node.confidence,
        ageHours,
        relatedToActiveNote: related,
        settings,
      });
      items.push({
        id: node.id,
        kind: "node",
        agent: node.agent,
        type: node.type,
        confidence: node.confidence,
        rationale: null,
        createdAt: node.created_at,
        notePaths,
        evidenceChunkIds: [],
        score,
      });
    }
    items.sort((a, b) => b.score - a.score);
    this.items.value = items.slice(0, settings.maxItems);
  }

  private lookupNotePaths(ids: string[]): Map<string, string | null> {
    const result = new Map<string, string | null>();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.options.db.query<NodePathRow>(
      `SELECT id, note_path FROM graph_nodes WHERE id IN (${placeholders});`,
      ids,
    );
    for (const row of rows) result.set(row.id, row.note_path);
    return result;
  }
}

function parseEvidence(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 6: Implement StreamItemCard + StreamTab**

Create `src/ui/sidebar/components/StreamItemCard.tsx`:

```typescript
import type { StreamItem } from "../../../core/stream/types";

export interface StreamItemCardProps {
  item: StreamItem;
  onOpen: (item: StreamItem) => void;
  onAccept: (item: StreamItem) => void;
  onReject: (item: StreamItem) => void;
}

export function StreamItemCard({ item, onOpen, onAccept, onReject }: StreamItemCardProps) {
  const confidence = Math.round(item.confidence * 100);
  return (
    <article class={`notient-stream-item notient-stream-item--${item.kind}`}>
      <header class="notient-stream-item__head">
        <span class={`notient-stream-item__agent notient-stream-item__agent--${item.agent}`}>{item.agent}</span>
        <span class="notient-stream-item__type">{item.type}</span>
        <span class="notient-stream-item__confidence">{confidence}%</span>
      </header>
      <p class="notient-stream-item__rationale">{item.rationale ?? "(no rationale)"}</p>
      <ul class="notient-stream-item__paths">
        {item.notePaths.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
      <footer class="notient-stream-item__actions">
        <button type="button" onClick={() => onOpen(item)}>Open</button>
        <button type="button" onClick={() => onAccept(item)}>Accept</button>
        <button type="button" onClick={() => onReject(item)}>Reject</button>
      </footer>
    </article>
  );
}
```

Replace `src/ui/sidebar/components/StreamTab.tsx`:

```typescript
import { signal } from "@preact/signals";
import type { StreamItem } from "../../../core/stream/types";
import { StreamItemCard } from "./StreamItemCard";

export const streamItemsState = signal<StreamItem[]>([]);
export const streamActions = signal<{
  open: (item: StreamItem) => void;
  accept: (item: StreamItem) => void;
  reject: (item: StreamItem) => void;
} | null>(null);

export function StreamTab() {
  const items = streamItemsState.value;
  const actions = streamActions.value;
  if (items.length === 0) {
    return (
      <section class="notient-tab-body notient-tab-body--stream">
        <p class="notient-empty">No pending insights. Save a note or wait for the swarm.</p>
      </section>
    );
  }
  return (
    <section class="notient-tab-body notient-tab-body--stream">
      <ul class="notient-stream-list">
        {items.map((item) => (
          <li key={item.id}>
            <StreamItemCard
              item={item}
              onOpen={(i) => actions?.open(i)}
              onAccept={(i) => actions?.accept(i)}
              onReject={(i) => actions?.reject(i)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
```

`streamItemsState` is bound from `streamService.items` in Task 16's main.ts wiring (`effect(() => streamItemsState.value = streamService.items.value)`). `streamActions` is populated with handlers that delegate to the existing ApprovalService for `accept` / `reject` and to the workspace for `open` (opens the first `notePath` via `workspace.openLinkText`).

- [ ] **Step 7: Verify**

Run: `bun run typecheck && bun run lint && bun test`

Expected: 5 ranking tests + 6 service tests + existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/core/stream src/ui/sidebar/components/StreamTab.tsx src/ui/sidebar/components/StreamItemCard.tsx
git commit -m "feat(stream): ranked feed of pending agent proposals"
```



## Task 3: Vitals service + VitalsTab body

**Files:**
- Create: `src/core/vitals/types.ts`
- Create: `src/core/vitals/freshness.ts`
- Create: `src/core/vitals/freshness.test.ts`
- Create: `src/core/vitals/vitalsService.ts`
- Create: `src/core/vitals/vitalsService.test.ts`
- Modify: `src/ui/sidebar/components/VitalsTab.tsx` (replace stub)
- Create: `src/ui/sidebar/components/VitalMeter.tsx`

**Why:** Per Q4 the Vitals tab renders four signals — freshness, health, connectivity, maturity — for the active note. STATE.md flags freshness as a placeholder constant of 1.0; this task replaces it with `exp(-Δdays / 14)` and persists snapshots back to `notes.health` and `notes.freshness` on save and on `agent:run-finished`. Health is a weighted composite (wordBand + chunkCoverage + hasApprovedEdges). Connectivity counts approved `graph_edges` touching the active note's `graph_node` and buckets it (isolated / sparse / connected / hub). Optional opt-in writeback to frontmatter (`notient.health`, `notient.freshness`, `notient.connectivity`, `notient.maturity`) makes vitals visible in Obsidian's native Properties pane.

- [ ] **Step 1: Define types**

Create `src/core/vitals/types.ts`:

```typescript
export type ConnectivityTier = "isolated" | "sparse" | "connected" | "hub";

export type Maturity = "raw" | "draft" | "review" | "mature";

export interface VitalsSnapshot {
  notePath: string;
  freshness: number;
  health: number;
  connectivityCount: number;
  connectivityTier: ConnectivityTier;
  maturity: Maturity;
  wordCount: number;
  computedAt: number;
}

export interface VitalsSettings {
  freshnessHalfLifeDays: number;
  healthWeights: { wordBand: number; chunkCoverage: number; hasApprovedEdges: number };
  connectivityThresholds: { sparse: number; connected: number; hub: number };
  writeToFrontmatter: boolean;
}
```

- [ ] **Step 2: Write the freshness test**

Create `src/core/vitals/freshness.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { freshness } from "./freshness";

describe("freshness", () => {
  test("returns 1.0 immediately after update", () => {
    expect(freshness({ updatedAt: 1000, now: 1000, halfLifeDays: 14 })).toBeCloseTo(1, 6);
  });

  test("halves at the half-life", () => {
    const updatedAt = 0;
    const now = 14 * 24 * 60 * 60 * 1000;
    expect(freshness({ updatedAt, now, halfLifeDays: 14 })).toBeCloseTo(Math.exp(-1), 6);
  });

  test("clamps to zero in the limit", () => {
    expect(freshness({ updatedAt: 0, now: 1_000_000_000_000, halfLifeDays: 14 })).toBeLessThan(1e-6);
  });

  test("clamps to 1 if updatedAt is in the future", () => {
    expect(freshness({ updatedAt: 100, now: 50, halfLifeDays: 14 })).toBe(1);
  });
});
```

- [ ] **Step 3: Implement freshness**

Create `src/core/vitals/freshness.ts`:

```typescript
export interface FreshnessInput {
  updatedAt: number;
  now: number;
  halfLifeDays: number;
}

export function freshness(input: FreshnessInput): number {
  const days = Math.max(0, (input.now - input.updatedAt) / 86_400_000);
  return Math.exp(-days / input.halfLifeDays);
}
```

- [ ] **Step 4: Write the service test**

Create `src/core/vitals/vitalsService.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { VitalsService } from "./vitalsService";

async function freshDb() {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await db.init();
  return db;
}

const settings = {
  freshnessHalfLifeDays: 14,
  healthWeights: { wordBand: 1, chunkCoverage: 1, hasApprovedEdges: 1 },
  connectivityThresholds: { sparse: 1, connected: 4, hub: 12 },
  writeToFrontmatter: false,
};

function seedNote(db: Database, opts: { path: string; words: number; maturity?: string; updatedAt?: number }): void {
  db.run(
    `INSERT INTO notes (path, sha, word_count, maturity, health, freshness, indexed_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?);`,
    [opts.path, "sha", opts.words, opts.maturity ?? "raw", 0, 1, 1, opts.updatedAt ?? 1],
  );
}

function seedChunk(db: Database, path: string, ord: number): void {
  db.run(
    `INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);`,
    [`${path}#${ord}`, path, ord, "body", "sha"],
  );
}

function seedNodeAndEdges(db: Database, path: string, edgeCount: number): void {
  const nodeId = `note:${path}`;
  db.run(
    `INSERT INTO graph_nodes (id, type, label, note_path, payload, created_at) VALUES (?,?,?,?,?,?);`,
    [nodeId, "note", path, path, null, 1],
  );
  for (let i = 0; i < edgeCount; i++) {
    db.run(
      `INSERT INTO graph_edges (id, type, source_id, target_id, confidence, agent, evidence, approved, created_at)
       VALUES (?,?,?,?,?,?,?,?,?);`,
      [`edge:${path}:${i}`, "supports", nodeId, `note:other-${i}.md`, 0.9, "linker", null, 1, 1],
    );
  }
}

describe("VitalsService", () => {
  test("computeSnapshot reflects word count, chunks, and approved edges", async () => {
    const db = await freshDb();
    seedNote(db, { path: "/a.md", words: 600, maturity: "draft" });
    seedChunk(db, "/a.md", 0);
    seedNodeAndEdges(db, "/a.md", 3);
    const svc = new VitalsService({ db, now: () => 1, settings: () => settings, facade: stubFacade() });
    const snapshot = svc.computeSnapshot("/a.md");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.maturity).toBe("draft");
    expect(snapshot!.wordCount).toBe(600);
    expect(snapshot!.connectivityCount).toBe(3);
    expect(snapshot!.connectivityTier).toBe("sparse");
    expect(snapshot!.health).toBeGreaterThan(0.6);
  });

  test("returns null when the note is not indexed", async () => {
    const db = await freshDb();
    const svc = new VitalsService({ db, now: () => 1, settings: () => settings, facade: stubFacade() });
    expect(svc.computeSnapshot("/missing.md")).toBeNull();
  });

  test("freshness reflects time since updatedAt", async () => {
    const db = await freshDb();
    seedNote(db, { path: "/a.md", words: 100, updatedAt: 0 });
    const fourteenDaysMs = 14 * 86_400_000;
    const svc = new VitalsService({ db, now: () => fourteenDaysMs, settings: () => settings, facade: stubFacade() });
    const snapshot = svc.computeSnapshot("/a.md");
    expect(snapshot!.freshness).toBeCloseTo(Math.exp(-1), 4);
  });

  test("connectivity tier maps thresholds correctly", async () => {
    const db = await freshDb();
    seedNote(db, { path: "/a.md", words: 100 });
    seedNodeAndEdges(db, "/a.md", 12);
    const svc = new VitalsService({ db, now: () => 1, settings: () => settings, facade: stubFacade() });
    const snapshot = svc.computeSnapshot("/a.md");
    expect(snapshot!.connectivityTier).toBe("hub");
  });

  test("persistSnapshot writes back to notes table", async () => {
    const db = await freshDb();
    seedNote(db, { path: "/a.md", words: 100 });
    const svc = new VitalsService({ db, now: () => 1, settings: () => settings, facade: stubFacade() });
    await svc.persistSnapshot("/a.md");
    const rows = db.query<{ health: number; freshness: number }>(
      "SELECT health, freshness FROM notes WHERE path = ?;",
      ["/a.md"],
    );
    expect(rows[0].freshness).toBeGreaterThan(0);
  });

  test("persistSnapshot also writes frontmatter when setting is enabled", async () => {
    const db = await freshDb();
    seedNote(db, { path: "/a.md", words: 100 });
    const facade = stubFacade();
    const svc = new VitalsService({
      db,
      now: () => 1,
      settings: () => ({ ...settings, writeToFrontmatter: true }),
      facade,
    });
    await svc.persistSnapshot("/a.md");
    expect(facade.frontmatterUpdates).toHaveLength(1);
    expect(facade.frontmatterUpdates[0].path).toBe("/a.md");
    expect(facade.frontmatterUpdates[0].patch).toMatchObject({ notient: expect.any(Object) });
  });
});

function stubFacade() {
  const updates: { path: string; patch: Record<string, unknown> }[] = [];
  return {
    frontmatterUpdates: updates,
    updateFrontmatter: async (path: string, patch: Record<string, unknown>) => {
      updates.push({ path, patch });
    },
  };
}
```

- [ ] **Step 5: Implement `VitalsService`**

Create `src/core/vitals/vitalsService.ts`:

```typescript
import type { Database } from "../db/database";
import { freshness } from "./freshness";
import type {
  ConnectivityTier,
  Maturity,
  VitalsSettings,
  VitalsSnapshot,
} from "./types";

export interface VitalsFacade {
  updateFrontmatter(path: string, patch: Record<string, unknown>): Promise<void>;
}

export interface VitalsServiceOptions {
  db: Database;
  now: () => number;
  settings: () => VitalsSettings;
  facade: VitalsFacade;
}

interface NoteRow {
  word_count: number;
  maturity: Maturity;
  updated_at: number;
}

interface CountRow {
  count: number;
}

export class VitalsService {
  constructor(private readonly options: VitalsServiceOptions) {}

  computeSnapshot(notePath: string): VitalsSnapshot | null {
    const row = this.options.db.query<NoteRow>(
      "SELECT word_count, maturity, updated_at FROM notes WHERE path = ?;",
      [notePath],
    )[0];
    if (!row) return null;
    const settings = this.options.settings();
    const now = this.options.now();
    const fresh = freshness({ updatedAt: row.updated_at, now, halfLifeDays: settings.freshnessHalfLifeDays });
    const chunkRow = this.options.db.query<CountRow>(
      "SELECT COUNT(*) as count FROM chunks WHERE note_path = ?;",
      [notePath],
    )[0];
    const edgeRow = this.options.db.query<CountRow>(
      `SELECT COUNT(*) as count FROM graph_edges
       WHERE approved = 1 AND (source_id = ? OR target_id = ?);`,
      [`note:${notePath}`, `note:${notePath}`],
    )[0];
    const wordBand = saturating(row.word_count, 600);
    const chunkCoverage = chunkRow.count > 0 ? 1 : 0;
    const hasApprovedEdges = edgeRow.count > 0 ? 1 : 0;
    const totalWeight =
      settings.healthWeights.wordBand +
      settings.healthWeights.chunkCoverage +
      settings.healthWeights.hasApprovedEdges;
    const health =
      (wordBand * settings.healthWeights.wordBand +
        chunkCoverage * settings.healthWeights.chunkCoverage +
        hasApprovedEdges * settings.healthWeights.hasApprovedEdges) /
      Math.max(1, totalWeight);
    const tier = bucket(edgeRow.count, settings.connectivityThresholds);
    return {
      notePath,
      freshness: fresh,
      health,
      connectivityCount: edgeRow.count,
      connectivityTier: tier,
      maturity: row.maturity,
      wordCount: row.word_count,
      computedAt: now,
    };
  }

  async persistSnapshot(notePath: string): Promise<void> {
    const snapshot = this.computeSnapshot(notePath);
    if (!snapshot) return;
    this.options.db.run(
      "UPDATE notes SET health = ?, freshness = ? WHERE path = ?;",
      [snapshot.health, snapshot.freshness, notePath],
    );
    await this.options.db.persist();
    if (this.options.settings().writeToFrontmatter) {
      await this.options.facade.updateFrontmatter(notePath, {
        notient: {
          health: round(snapshot.health, 3),
          freshness: round(snapshot.freshness, 3),
          connectivity: snapshot.connectivityCount,
          connectivityTier: snapshot.connectivityTier,
          maturity: snapshot.maturity,
        },
      });
    }
  }
}

function saturating(words: number, peakAt: number): number {
  return 1 - Math.exp(-Math.max(0, words) / peakAt);
}

function bucket(count: number, thresholds: { sparse: number; connected: number; hub: number }): ConnectivityTier {
  if (count >= thresholds.hub) return "hub";
  if (count >= thresholds.connected) return "connected";
  if (count >= thresholds.sparse) return "sparse";
  return "isolated";
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
```

- [ ] **Step 6: Implement VitalMeter + VitalsTab**

Create `src/ui/sidebar/components/VitalMeter.tsx`:

```typescript
export interface VitalMeterProps {
  label: string;
  value: number; // 0..1
  display: string;
}

export function VitalMeter({ label, value, display }: VitalMeterProps) {
  const clamped = Math.max(0, Math.min(1, value));
  const percent = Math.round(clamped * 100);
  return (
    <div class="notient-vital">
      <div class="notient-vital__label">{label}</div>
      <div class="notient-vital__bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div class="notient-vital__fill" style={`width:${percent}%`} />
      </div>
      <div class="notient-vital__value">{display}</div>
    </div>
  );
}
```

(Inline `style="width:..%"` is unavoidable for a dynamic progress bar; the project's "no inline styles" rule applies to static styling. The implementer may swap to a CSS variable + `style={\`--notient-vital-fill:${percent}%\`}` if preferred.)

Replace `src/ui/sidebar/components/VitalsTab.tsx`:

```typescript
import { signal } from "@preact/signals";
import type { VitalsSnapshot } from "../../../core/vitals/types";
import { VitalMeter } from "./VitalMeter";

export const vitalsSnapshotState = signal<VitalsSnapshot | null>(null);
export const vitalsActions = signal<{ deepen: (path: string) => void } | null>(null);

export function VitalsTab() {
  const snapshot = vitalsSnapshotState.value;
  const actions = vitalsActions.value;
  if (!snapshot) {
    return (
      <section class="notient-tab-body notient-tab-body--vitals">
        <p class="notient-empty">Open a note to see its vitals.</p>
      </section>
    );
  }
  return (
    <section class="notient-tab-body notient-tab-body--vitals">
      <h3 class="notient-vitals__title">{snapshot.notePath}</h3>
      <span class={`notient-vitals__maturity notient-vitals__maturity--${snapshot.maturity}`}>{snapshot.maturity}</span>
      <VitalMeter label="Freshness" value={snapshot.freshness} display={`${Math.round(snapshot.freshness * 100)}%`} />
      <VitalMeter label="Health" value={snapshot.health} display={`${Math.round(snapshot.health * 100)}%`} />
      <VitalMeter
        label="Connectivity"
        value={Math.min(1, snapshot.connectivityCount / 12)}
        display={`${snapshot.connectivityCount} edges (${snapshot.connectivityTier})`}
      />
      <button type="button" class="notient-btn" onClick={() => actions?.deepen(snapshot.notePath)}>
        Deepen this note
      </button>
    </section>
  );
}
```

The Task 16 wiring binds `vitalsSnapshotState` to the active note via an effect: on `active-leaf-change` and on `agent:run-finished` for the active path, call `vitalsService.computeSnapshot(activePath)` and assign. `vitalsActions.deepen(path)` emits `bus.emit({ type: "user:action", kind: "deepen", notePath: path })`.

- [ ] **Step 7: Verify**

Run: `bun run typecheck && bun run lint && bun test`

Expected: 4 freshness tests + 6 service tests + existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/core/vitals src/ui/sidebar/components/VitalsTab.tsx src/ui/sidebar/components/VitalMeter.tsx
git commit -m "feat(vitals): per-note vitals service + Vitals tab"
```



## Task 4: CodeMirror editor decorations

**Files:**
- Create: `src/ui/editor/decorations/paragraphMap.ts`
- Create: `src/ui/editor/decorations/paragraphMap.test.ts`
- Create: `src/ui/editor/decorations/InsightDot.ts`
- Create: `src/ui/editor/decorations/insightsPlugin.ts`
- Create: `src/ui/editor/decorations/insightsPlugin.test.ts`
- Modify: `styles.css` (extend with `.notient-insight-dot`)

**Why:** Per Q3, paragraph-end CM6 widget decorations give the user ambient awareness of pending agent insights without ever modifying the document. The plugin reads pending `staging_edges`/`staging_nodes` for the active note, expands `evidence` chunk_ids, finds each chunk's first 80-char prefix in the live doc, and emits a `Decoration.widget` at that paragraph's end. Mode-gated to Source / Live Preview (skip Reading view), debounced 200 ms, capped at top 5 paragraphs by stream score, invalidated externally on `agent:run-finished` and `approval:decided`. Click on a dot opens the Stream tab focused on that proposal.

- [ ] **Step 1: Write the paragraph-map test**

Create `src/ui/editor/decorations/paragraphMap.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { findChunkParagraphs, splitParagraphs } from "./paragraphMap";

const doc = [
  "First paragraph about apples.",
  "",
  "Second paragraph about oranges and bananas in detail.",
  "",
  "Third paragraph about pears.",
].join("\n");

describe("paragraphMap", () => {
  test("splits a document into paragraph spans", () => {
    const paragraphs = splitParagraphs(doc);
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0].text).toContain("apples");
    expect(paragraphs[2].text).toContain("pears");
    expect(paragraphs[0].from).toBe(0);
    expect(paragraphs[0].to).toBe("First paragraph about apples.".length);
  });

  test("findChunkParagraphs locates each chunk by 80-char prefix", () => {
    const chunks = [
      { id: "c1", text: "First paragraph about apples." },
      { id: "c2", text: "Second paragraph about oranges and bananas in detail." },
      { id: "c3", text: "MISSING — drifted away" },
    ];
    const matches = findChunkParagraphs(doc, chunks);
    expect(matches.get("c1")).toBeDefined();
    expect(matches.get("c2")).toBeDefined();
    expect(matches.get("c3")).toBeUndefined();
    expect(matches.get("c1")!.text).toContain("apples");
  });

  test("matches chunk regardless of trailing whitespace differences", () => {
    const chunks = [{ id: "c1", text: "First paragraph about apples.\n\n  " }];
    const matches = findChunkParagraphs(doc, chunks);
    expect(matches.get("c1")).toBeDefined();
  });

  test("returns no match when prefix is shorter than 12 chars (avoids spurious hits)", () => {
    const chunks = [{ id: "c1", text: "tiny" }];
    const matches = findChunkParagraphs("paragraph one\n\nparagraph two", chunks);
    expect(matches.get("c1")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Implement paragraph map**

Create `src/ui/editor/decorations/paragraphMap.ts`:

```typescript
export interface ParagraphSpan {
  from: number;
  to: number;
  text: string;
}

const MIN_PREFIX = 12;
const PREFIX_LEN = 80;

export function splitParagraphs(doc: string): ParagraphSpan[] {
  const result: ParagraphSpan[] = [];
  const regex = /\n{2,}/g;
  let cursor = 0;
  let match: RegExpExecArray | null = regex.exec(doc);
  while (match !== null) {
    const text = doc.slice(cursor, match.index);
    if (text.trim().length > 0) {
      result.push({ from: cursor, to: cursor + text.length, text });
    }
    cursor = match.index + match[0].length;
    match = regex.exec(doc);
  }
  const tail = doc.slice(cursor);
  if (tail.trim().length > 0) {
    result.push({ from: cursor, to: cursor + tail.length, text: tail });
  }
  return result;
}

export interface ChunkRef {
  id: string;
  text: string;
}

export function findChunkParagraphs(
  doc: string,
  chunks: ChunkRef[],
): Map<string, ParagraphSpan> {
  const paragraphs = splitParagraphs(doc);
  const result = new Map<string, ParagraphSpan>();
  for (const chunk of chunks) {
    const prefix = chunk.text.trim().slice(0, PREFIX_LEN);
    if (prefix.length < MIN_PREFIX) continue;
    const paragraph = paragraphs.find((p) => p.text.includes(prefix));
    if (paragraph) result.set(chunk.id, paragraph);
  }
  return result;
}
```

- [ ] **Step 3: Implement the InsightDot widget**

Create `src/ui/editor/decorations/InsightDot.ts`:

```typescript
import { WidgetType } from "@codemirror/view";

export interface InsightDotPayload {
  agent: string;
  proposalCount: number;
  rationale: string;
  primaryProposalId: string;
}

export class InsightDot extends WidgetType {
  constructor(private readonly payload: InsightDotPayload, private readonly onClick: (id: string) => void) {
    super();
  }

  eq(other: InsightDot): boolean {
    return (
      other.payload.primaryProposalId === this.payload.primaryProposalId &&
      other.payload.proposalCount === this.payload.proposalCount &&
      other.payload.agent === this.payload.agent
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `notient-insight-dot notient-insight-dot--${this.payload.agent}`;
    span.setAttribute("aria-label", `${this.payload.proposalCount} ${this.payload.agent} insight(s)`);
    span.setAttribute("title", this.payload.rationale);
    span.dataset.proposalId = this.payload.primaryProposalId;
    span.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onClick(this.payload.primaryProposalId);
    });
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}
```

- [ ] **Step 4: Write the plugin test**

Create `src/ui/editor/decorations/insightsPlugin.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { buildDecorationSet } from "./insightsPlugin";

const doc = "First paragraph about apples.\n\nSecond paragraph about oranges and bananas in detail.";

describe("buildDecorationSet", () => {
  test("places one widget at the end of each matched paragraph", () => {
    const state = EditorState.create({ doc });
    const set = buildDecorationSet({
      state,
      proposals: [
        {
          id: "p1",
          agent: "linker",
          rationale: "linker matched apples",
          score: 0.9,
          chunkText: "First paragraph about apples.",
        },
        {
          id: "p2",
          agent: "synthesizer",
          rationale: "cluster around oranges",
          score: 0.8,
          chunkText: "Second paragraph about oranges and bananas in detail.",
        },
      ],
      maxPerViewport: 5,
      onClick: () => undefined,
    });
    const ranges = set.size;
    expect(ranges).toBe(2);
  });

  test("respects maxPerViewport by ranking proposals descending", () => {
    const state = EditorState.create({ doc });
    const proposals = [
      { id: "p1", agent: "linker", rationale: "low", score: 0.1, chunkText: "First paragraph about apples." },
      { id: "p2", agent: "synthesizer", rationale: "high", score: 0.9, chunkText: "Second paragraph about oranges and bananas in detail." },
    ];
    const set = buildDecorationSet({ state, proposals, maxPerViewport: 1, onClick: () => undefined });
    expect(set.size).toBe(1);
  });

  test("returns empty set when no proposals match the document", () => {
    const state = EditorState.create({ doc });
    const set = buildDecorationSet({
      state,
      proposals: [{ id: "p1", agent: "linker", rationale: "drift", score: 0.9, chunkText: "TEXT THAT IS NOT IN THE DOC" }],
      maxPerViewport: 5,
      onClick: () => undefined,
    });
    expect(set.size).toBe(0);
  });

  test("groups multiple proposals on the same paragraph into a single dot", () => {
    const state = EditorState.create({ doc });
    const proposals = [
      { id: "p1", agent: "linker", rationale: "first", score: 0.9, chunkText: "First paragraph about apples." },
      { id: "p2", agent: "synthesizer", rationale: "second", score: 0.8, chunkText: "First paragraph about apples." },
    ];
    const set = buildDecorationSet({ state, proposals, maxPerViewport: 5, onClick: () => undefined });
    expect(set.size).toBe(1);
  });
});
```

(`@codemirror/state` is already a transitive dep via Obsidian; we add it as a direct devDependency in this step if not already present: `bun add -d @codemirror/state @codemirror/view`. The runtime uses Obsidian's bundled CM, but tests need the package on disk.)

- [ ] **Step 5: Implement the plugin**

Create `src/ui/editor/decorations/insightsPlugin.ts`:

```typescript
import { type EditorState, RangeSet, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { findChunkParagraphs, type ParagraphSpan } from "./paragraphMap";
import { InsightDot } from "./InsightDot";

export interface InsightProposal {
  id: string;
  agent: string;
  rationale: string;
  score: number;
  chunkText: string;
}

export interface BuildOptions {
  state: EditorState;
  proposals: InsightProposal[];
  maxPerViewport: number;
  onClick: (proposalId: string) => void;
}

export function buildDecorationSet(options: BuildOptions): DecorationSet {
  const doc = options.state.doc.toString();
  const ranked = [...options.proposals].sort((a, b) => b.score - a.score);
  const matches = findChunkParagraphs(
    doc,
    ranked.map((p) => ({ id: p.id, text: p.chunkText })),
  );
  const grouped = new Map<string, { paragraph: ParagraphSpan; primary: InsightProposal; count: number }>();
  for (const proposal of ranked) {
    const paragraph = matches.get(proposal.id);
    if (!paragraph) continue;
    const key = `${paragraph.from}-${paragraph.to}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(key, { paragraph, primary: proposal, count: 1 });
    }
    if (grouped.size >= options.maxPerViewport) break;
  }
  const decorations = Array.from(grouped.values()).map(({ paragraph, primary, count }) =>
    Decoration.widget({
      widget: new InsightDot(
        { agent: primary.agent, proposalCount: count, rationale: primary.rationale, primaryProposalId: primary.id },
        options.onClick,
      ),
      side: 1,
    }).range(paragraph.to),
  );
  decorations.sort((a, b) => a.from - b.from);
  return RangeSet.of(decorations, true);
}

export const rebuildEffect = StateEffect.define<null>();

export interface InsightsPluginOptions {
  getProposals: (notePath: string) => InsightProposal[];
  getActivePath: () => string | null;
  getMaxPerViewport: () => number;
  getDebounceMs: () => number;
  onClick: (proposalId: string) => void;
  isModeAllowed: () => boolean;
}

export function makeInsightsPlugin(options: InsightsPluginOptions) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private timer: ReturnType<typeof setTimeout> | null = null;

      constructor(public readonly view: EditorView) {
        this.schedule();
      }

      update(update: ViewUpdate): void {
        const requestedRebuild = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(rebuildEffect)),
        );
        if (update.docChanged || requestedRebuild) this.schedule();
      }

      destroy(): void {
        if (this.timer !== null) clearTimeout(this.timer);
      }

      private schedule(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.rebuild(), options.getDebounceMs());
      }

      private rebuild(): void {
        if (!options.isModeAllowed()) {
          this.decorations = Decoration.none;
          return;
        }
        const path = options.getActivePath();
        if (path === null) {
          this.decorations = Decoration.none;
          return;
        }
        this.decorations = buildDecorationSet({
          state: this.view.state,
          proposals: options.getProposals(path),
          maxPerViewport: options.getMaxPerViewport(),
          onClick: options.onClick,
        });
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
```

- [ ] **Step 6: Extend `styles.css`**

Append:

```css
.notient-insight-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-left: 6px;
  border-radius: 50%;
  vertical-align: middle;
  cursor: pointer;
  background: var(--text-muted);
  opacity: 0.85;
  transition: transform 120ms ease, opacity 120ms ease;
}
.notient-insight-dot:hover { opacity: 1; transform: scale(1.15); }
.notient-insight-dot--linker { background: var(--color-blue); }
.notient-insight-dot--synthesizer { background: var(--color-purple); }
.notient-insight-dot--contradictionHunter { background: var(--color-red); }
.notient-insight-dot--maturityAdvancer { background: var(--color-green); }
```

- [ ] **Step 7: Verify**

Run: `bun run typecheck && bun run lint && bun test`

Expected: 4 paragraphMap tests + 4 plugin tests + existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/ui/editor/decorations styles.css package.json bun.lockb
git commit -m "feat(decorations): paragraph-end widget decorations for pending insights"
```



## Task 5: Native graph bridge + JSON Canvas exporter

**Files:**
- Create: `src/core/graph/relatedSection.ts`
- Create: `src/core/graph/relatedSection.test.ts`
- Create: `src/core/graph/nativeGraphBridge.ts`
- Create: `src/core/graph/nativeGraphBridge.test.ts`
- Create: `src/core/canvas/types.ts`
- Create: `src/core/canvas/canvasGenerator.ts`
- Create: `src/core/canvas/canvasGenerator.test.ts`
- Modify: `src/core/approvals/approvalService.ts` (call bridge on edge approval)

**Why:** Per Q5, Notient never ships a custom graph view; it amplifies Obsidian's native graph by writing wikilinks (for `LINKS_TO`) and frontmatter list properties (for typed relations) on edge approval. EchoGuard prevents the indexer from re-firing on these self-writes. The JSON Canvas exporter is the bridge for synthesis previews and search-results-as-canvas: Notient generates spec-compliant `.canvas` files; Obsidian's native canvas view renders them. No new view, no new ribbon icon for graphs — the entire integration leans on Obsidian's metadataCache + canvas renderer.

- [ ] **Step 1: Write the related-section test**

Create `src/core/graph/relatedSection.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { addRelatedLink, removeRelatedLink } from "./relatedSection";

describe("relatedSection", () => {
  test("appends a Related section when none exists", () => {
    const before = "# Note\n\nBody paragraph.\n";
    const after = addRelatedLink(before, "Related", "[[Other]]");
    expect(after).toContain("## Related");
    expect(after).toContain("- [[Other]]");
  });

  test("appends to an existing Related section without duplicating", () => {
    const before = "# Note\n\nBody.\n\n## Related\n- [[Existing]]\n";
    const after = addRelatedLink(before, "Related", "[[Existing]]");
    const occurrences = (after.match(/\[\[Existing\]\]/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  test("preserves existing entries when adding a new one", () => {
    const before = "# Note\n\nBody.\n\n## Related\n- [[A]]\n- [[B]]\n";
    const after = addRelatedLink(before, "Related", "[[C]]");
    expect(after).toContain("- [[A]]");
    expect(after).toContain("- [[B]]");
    expect(after).toContain("- [[C]]");
  });

  test("removeRelatedLink removes one entry without breaking the section", () => {
    const before = "# Note\n\n## Related\n- [[A]]\n- [[B]]\n";
    const after = removeRelatedLink(before, "Related", "[[A]]");
    expect(after).toContain("- [[B]]");
    expect(after).not.toContain("- [[A]]");
    expect(after).toContain("## Related");
  });

  test("removeRelatedLink drops the heading when its last entry is removed", () => {
    const before = "# Note\n\nBody.\n\n## Related\n- [[Only]]\n";
    const after = removeRelatedLink(before, "Related", "[[Only]]");
    expect(after).not.toContain("## Related");
    expect(after).not.toContain("[[Only]]");
  });

  test("custom heading override works for both add and remove", () => {
    const before = "# Note\n\nBody.\n";
    const added = addRelatedLink(before, "References", "[[X]]");
    expect(added).toContain("## References");
    const removed = removeRelatedLink(added, "References", "[[X]]");
    expect(removed).not.toContain("## References");
  });
});
```

- [ ] **Step 2: Implement relatedSection**

Create `src/core/graph/relatedSection.ts`:

```typescript
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface SectionLocation {
  start: number;
  bodyStart: number;
  bodyEnd: number;
}

function locateSection(content: string, heading: string): SectionLocation | null {
  const headingPattern = new RegExp(`(^|\\n)##\\s+${escapeRegex(heading)}\\s*\\n`);
  const match = headingPattern.exec(content);
  if (!match) return null;
  const start = match.index + (match[1] ? 1 : 0);
  const bodyStart = match.index + match[0].length;
  const nextHeadingPattern = /\n##\s+/g;
  nextHeadingPattern.lastIndex = bodyStart;
  const nextMatch = nextHeadingPattern.exec(content);
  const bodyEnd = nextMatch ? nextMatch.index : content.length;
  return { start, bodyStart, bodyEnd };
}

export function addRelatedLink(content: string, heading: string, link: string): string {
  const location = locateSection(content, heading);
  if (!location) {
    const trailing = content.endsWith("\n") ? "" : "\n";
    return `${content}${trailing}\n## ${heading}\n- ${link}\n`;
  }
  const body = content.slice(location.bodyStart, location.bodyEnd);
  if (body.includes(link)) return content;
  const trimmed = body.replace(/\s+$/, "");
  const updatedBody = trimmed.length > 0 ? `${trimmed}\n- ${link}\n` : `- ${link}\n`;
  return content.slice(0, location.bodyStart) + updatedBody + content.slice(location.bodyEnd);
}

export function removeRelatedLink(content: string, heading: string, link: string): string {
  const location = locateSection(content, heading);
  if (!location) return content;
  const body = content.slice(location.bodyStart, location.bodyEnd);
  const linePattern = new RegExp(`(^|\\n)-\\s+${escapeRegex(link)}\\s*(\\n|$)`);
  const next = body.replace(linePattern, (_match, before, after) => (before && after ? "\n" : ""));
  if (next.trim().length === 0) {
    return content.slice(0, location.start) + content.slice(location.bodyEnd).replace(/^\n+/, "");
  }
  return content.slice(0, location.bodyStart) + next + content.slice(location.bodyEnd);
}
```

- [ ] **Step 3: Write the bridge test**

Create `src/core/graph/nativeGraphBridge.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { NativeGraphBridge, type RelatedRelation } from "./nativeGraphBridge";

interface FacadeRecord {
  reads: string[];
  writes: { path: string; content: string }[];
  frontmatterPatches: { path: string; patch: Record<string, unknown> }[];
  echoMarks: { path: string; sha: string }[];
}

function makeFacade(initial: Record<string, string>) {
  const record: FacadeRecord = { reads: [], writes: [], frontmatterPatches: [], echoMarks: [] };
  const files = new Map(Object.entries(initial));
  return {
    record,
    facade: {
      readNote: async (path: string) => {
        record.reads.push(path);
        return files.get(path) ?? "";
      },
      writeNote: async (path: string, content: string) => {
        record.writes.push({ path, content });
        files.set(path, content);
      },
      updateFrontmatter: async (path: string, patch: Record<string, unknown>) => {
        record.frontmatterPatches.push({ path, patch });
      },
    },
    echoGuard: {
      mark: (path: string, sha: string) => {
        record.echoMarks.push({ path, sha });
      },
    },
    hash: async (content: string) => `sha-${content.length}`,
  };
}

describe("NativeGraphBridge", () => {
  test("LINKS_TO writeback adds a Related section + EchoGuard mark", async () => {
    const harness = makeFacade({ "/source.md": "# Source\n\nBody.\n" });
    const bridge = new NativeGraphBridge({
      facade: harness.facade,
      echoGuard: harness.echoGuard,
      hash: harness.hash,
      settings: () => ({ writeRelatedSection: true, writeFrontmatterRelations: true, relatedSectionHeading: "Related" }),
    });
    await bridge.applyApprovedLink({ sourcePath: "/source.md", targetPath: "/target.md", agent: "linker" });
    expect(harness.record.writes).toHaveLength(1);
    expect(harness.record.writes[0].content).toContain("## Related");
    expect(harness.record.writes[0].content).toContain("[[target]]");
    expect(harness.record.echoMarks).toHaveLength(1);
    expect(harness.record.echoMarks[0].path).toBe("/source.md");
  });

  test("Typed relation writeback patches frontmatter only", async () => {
    const harness = makeFacade({ "/source.md": "# Source\n\nBody.\n" });
    const bridge = new NativeGraphBridge({
      facade: harness.facade,
      echoGuard: harness.echoGuard,
      hash: harness.hash,
      settings: () => ({ writeRelatedSection: true, writeFrontmatterRelations: true, relatedSectionHeading: "Related" }),
    });
    const relation: RelatedRelation = {
      sourcePath: "/source.md",
      targetPath: "/target.md",
      relation: "contradicts",
      agent: "contradictionHunter",
    };
    await bridge.applyApprovedRelation(relation);
    expect(harness.record.writes).toHaveLength(0);
    expect(harness.record.frontmatterPatches).toHaveLength(1);
    expect(harness.record.frontmatterPatches[0].patch).toMatchObject({ notient: { contradicts: ["[[target]]"] } });
  });

  test("Setting toggles short-circuit each writeback path", async () => {
    const harness = makeFacade({ "/source.md": "# Source\n\nBody.\n" });
    const bridge = new NativeGraphBridge({
      facade: harness.facade,
      echoGuard: harness.echoGuard,
      hash: harness.hash,
      settings: () => ({ writeRelatedSection: false, writeFrontmatterRelations: false, relatedSectionHeading: "Related" }),
    });
    await bridge.applyApprovedLink({ sourcePath: "/source.md", targetPath: "/target.md", agent: "linker" });
    await bridge.applyApprovedRelation({ sourcePath: "/source.md", targetPath: "/target.md", relation: "supports", agent: "linker" });
    expect(harness.record.writes).toHaveLength(0);
    expect(harness.record.frontmatterPatches).toHaveLength(0);
  });

  test("Repeated writeback is idempotent (no duplicate wikilink)", async () => {
    const harness = makeFacade({ "/source.md": "# Source\n\n## Related\n- [[target]]\n" });
    const bridge = new NativeGraphBridge({
      facade: harness.facade,
      echoGuard: harness.echoGuard,
      hash: harness.hash,
      settings: () => ({ writeRelatedSection: true, writeFrontmatterRelations: true, relatedSectionHeading: "Related" }),
    });
    await bridge.applyApprovedLink({ sourcePath: "/source.md", targetPath: "/target.md", agent: "linker" });
    expect(harness.record.writes).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Implement `NativeGraphBridge`**

Create `src/core/graph/nativeGraphBridge.ts`:

```typescript
import { addRelatedLink } from "./relatedSection";

export type RelationKind = "contradicts" | "supports" | "extends" | "synthesizes_from";

export interface NativeGraphBridgeFacade {
  readNote(path: string): Promise<string>;
  writeNote(path: string, content: string): Promise<void>;
  updateFrontmatter(path: string, patch: Record<string, unknown>): Promise<void>;
}

export interface NativeGraphBridgeEchoGuard {
  mark(path: string, sha: string): void;
}

export interface NativeGraphBridgeSettings {
  writeRelatedSection: boolean;
  writeFrontmatterRelations: boolean;
  relatedSectionHeading: string;
}

export interface NativeGraphBridgeOptions {
  facade: NativeGraphBridgeFacade;
  echoGuard: NativeGraphBridgeEchoGuard;
  hash: (content: string) => Promise<string>;
  settings: () => NativeGraphBridgeSettings;
}

export interface ApprovedLink {
  sourcePath: string;
  targetPath: string;
  agent: string;
}

export interface RelatedRelation {
  sourcePath: string;
  targetPath: string;
  relation: RelationKind;
  agent: string;
}

export class NativeGraphBridge {
  constructor(private readonly options: NativeGraphBridgeOptions) {}

  async applyApprovedLink(link: ApprovedLink): Promise<void> {
    const settings = this.options.settings();
    if (!settings.writeRelatedSection) return;
    const content = await this.options.facade.readNote(link.sourcePath);
    const wikilink = `[[${basenameWithoutExtension(link.targetPath)}]]`;
    const next = addRelatedLink(content, settings.relatedSectionHeading, wikilink);
    if (next === content) return;
    const sha = await this.options.hash(next);
    this.options.echoGuard.mark(link.sourcePath, sha);
    await this.options.facade.writeNote(link.sourcePath, next);
  }

  async applyApprovedRelation(relation: RelatedRelation): Promise<void> {
    const settings = this.options.settings();
    if (!settings.writeFrontmatterRelations) return;
    const wikilink = `[[${basenameWithoutExtension(relation.targetPath)}]]`;
    await this.options.facade.updateFrontmatter(relation.sourcePath, {
      notient: { [relation.relation]: [wikilink] },
    });
  }
}

function basenameWithoutExtension(path: string): string {
  const last = path.split("/").pop() ?? path;
  return last.replace(/\.md$/i, "");
}
```

(`updateFrontmatter`'s contract: deep-merge the `notient.<relation>` array with existing values, deduplicating. The implementer ensures `obsidianFacade.updateFrontmatter` performs this merge — extend if needed.)

- [ ] **Step 5: Define canvas types and write the canvas test**

Create `src/core/canvas/types.ts`:

```typescript
export interface CanvasFile {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export type CanvasNode =
  | { id: string; type: "text"; text: string; x: number; y: number; width: number; height: number; color?: string }
  | { id: string; type: "file"; file: string; x: number; y: number; width: number; height: number; color?: string };

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  toSide?: "top" | "right" | "bottom" | "left";
  label?: string;
  color?: string;
}
```

Create `src/core/canvas/canvasGenerator.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { generateSynthesisCanvas, generateSearchResultsCanvas } from "./canvasGenerator";

describe("canvasGenerator", () => {
  test("synthesis canvas centres the stub and orbits source notes", () => {
    const canvas = generateSynthesisCanvas({
      synthesisTitle: "Career arc",
      synthesisBody: "Draft body.",
      sourceNotePaths: ["/a.md", "/b.md", "/c.md"],
    });
    expect(canvas.nodes).toHaveLength(4);
    expect(canvas.nodes[0]).toMatchObject({ type: "text" });
    expect(canvas.edges).toHaveLength(3);
  });

  test("search canvas places the query node and connects each result", () => {
    const canvas = generateSearchResultsCanvas({
      query: "career arc",
      resultPaths: ["/a.md", "/b.md"],
    });
    expect(canvas.nodes).toHaveLength(3);
    const fileCount = canvas.nodes.filter((n) => n.type === "file").length;
    expect(fileCount).toBe(2);
    expect(canvas.edges).toHaveLength(2);
  });

  test("output passes JSON.parse(JSON.stringify(...)) round-trip with no functions", () => {
    const canvas = generateSynthesisCanvas({ synthesisTitle: "t", synthesisBody: "b", sourceNotePaths: [] });
    expect(JSON.parse(JSON.stringify(canvas))).toEqual(canvas);
  });
});
```

- [ ] **Step 6: Implement `canvasGenerator`**

Create `src/core/canvas/canvasGenerator.ts`:

```typescript
import type { CanvasEdge, CanvasFile, CanvasNode } from "./types";

const NODE_WIDTH = 320;
const NODE_HEIGHT = 200;
const RADIUS = 480;

export interface SynthesisCanvasInput {
  synthesisTitle: string;
  synthesisBody: string;
  sourceNotePaths: string[];
}

export function generateSynthesisCanvas(input: SynthesisCanvasInput): CanvasFile {
  const centre: CanvasNode = {
    id: "synthesis",
    type: "text",
    text: `# ${input.synthesisTitle}\n\n${input.synthesisBody}`,
    x: -NODE_WIDTH / 2,
    y: -NODE_HEIGHT / 2,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  };
  const sources: CanvasNode[] = input.sourceNotePaths.map((path, index) => {
    const angle = (index / Math.max(1, input.sourceNotePaths.length)) * Math.PI * 2;
    return {
      id: `source-${index}`,
      type: "file",
      file: path,
      x: Math.round(Math.cos(angle) * RADIUS) - NODE_WIDTH / 2,
      y: Math.round(Math.sin(angle) * RADIUS) - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });
  const edges: CanvasEdge[] = sources.map((source, index) => ({
    id: `edge-${index}`,
    fromNode: "synthesis",
    toNode: source.id,
  }));
  return { nodes: [centre, ...sources], edges };
}

export interface SearchCanvasInput {
  query: string;
  resultPaths: string[];
}

export function generateSearchResultsCanvas(input: SearchCanvasInput): CanvasFile {
  const queryNode: CanvasNode = {
    id: "query",
    type: "text",
    text: `# Query\n\n${input.query}`,
    x: -NODE_WIDTH / 2,
    y: -NODE_HEIGHT / 2,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  };
  const results: CanvasNode[] = input.resultPaths.map((path, index) => {
    const angle = (index / Math.max(1, input.resultPaths.length)) * Math.PI * 2;
    return {
      id: `result-${index}`,
      type: "file",
      file: path,
      x: Math.round(Math.cos(angle) * RADIUS) - NODE_WIDTH / 2,
      y: Math.round(Math.sin(angle) * RADIUS) - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });
  const edges: CanvasEdge[] = results.map((result, index) => ({
    id: `edge-${index}`,
    fromNode: "query",
    toNode: result.id,
  }));
  return { nodes: [queryNode, ...results], edges };
}
```

- [ ] **Step 7: Extend `ApprovalService` to call the bridge**

Replace the body of `acceptEdge` in `src/core/approvals/approvalService.ts` so that after the SQL transaction succeeds, the bridge is invoked:

```typescript
  async acceptEdge(id: string): Promise<void> {
    const row = this.opts.db.query<{
      id: string;
      type: string;
      source_id: string;
      target_id: string;
      confidence: number;
      agent: string;
      evidence: string;
    }>(
      "SELECT id, type, source_id, target_id, confidence, agent, evidence FROM staging_edges WHERE id = ? AND decision IS NULL;",
      [id],
    )[0];
    if (!row) return;
    const liveId = row.id.replace(/^staging:/, "edge:");
    this.opts.db.transaction(() => {
      this.opts.db.run(
        `INSERT INTO graph_edges (id, type, source_id, target_id, confidence, agent, evidence, approved, created_at)
         VALUES (?,?,?,?,?,?,?,?,?);`,
        [liveId, row.type, row.source_id, row.target_id, row.confidence, row.agent, row.evidence, 1, Date.now()],
      );
      this.opts.db.run(
        "UPDATE staging_edges SET decision = 'accepted', decided_at = ? WHERE id = ?;",
        [Date.now(), id],
      );
    });
    await this.opts.db.persist();
    const sourcePath = this.resolveNotePath(row.source_id);
    const targetPath = this.resolveNotePath(row.target_id);
    if (sourcePath && targetPath) {
      if (row.type === "links_to") {
        await this.opts.bridge.applyApprovedLink({ sourcePath, targetPath, agent: row.agent });
      } else if (isTypedRelation(row.type)) {
        await this.opts.bridge.applyApprovedRelation({
          sourcePath,
          targetPath,
          relation: row.type as RelationKind,
          agent: row.agent,
        });
      }
    }
    this.opts.bus.emit({ type: "approval:decided", kind: "edge", id, decision: "accepted" });
  }
```

`opts.bridge` is the new constructor dependency (added to `ApprovalServiceOptions` in this step). `resolveNotePath` queries `graph_nodes` for `note_path` by id. `isTypedRelation` is `(type) => ["contradicts", "supports", "extends", "synthesizes_from"].includes(type)`. The implementer also extends `approvalService.test.ts` with one new test asserting that an accepted `links_to` edge calls `bridge.applyApprovedLink` once with the expected source/target.

- [ ] **Step 8: Verify**

Run: `bun run typecheck && bun run lint && bun test`

Expected: 6 relatedSection + 4 bridge + 3 canvas + 1 new approvals test pass; existing tests stay green.

- [ ] **Step 9: Commit**

```bash
git add src/core/graph src/core/canvas src/core/approvals/approvalService.ts src/core/approvals/approvalService.test.ts
git commit -m "feat(graph,canvas): native graph writeback bridge + JSON canvas exporter"
```



## Task 6: Search pipeline core (Quick + Balanced + filters + reranker)

**Files:**
- Create: `src/core/search/types.ts`
- Create: `src/core/search/filters.ts`
- Create: `src/core/search/filters.test.ts`
- Create: `src/core/search/strategies/quick.ts`
- Create: `src/core/search/strategies/quick.test.ts`
- Create: `src/core/search/strategies/balanced.ts`
- Create: `src/core/search/strategies/balanced.test.ts`
- Create: `src/core/search/reranker.ts`
- Create: `src/core/search/reranker.test.ts`
- Create: `src/core/search/searchPipeline.ts`
- Create: `src/core/search/searchPipeline.test.ts`
- Create: `src/core/search/prompts/rerank.ts`

**Why:** Knowledge search is the second flagship surface. Per Q7 the pipeline exposes `searchPipeline.run({query, mode, filters, limit, signal})` returning `AsyncIterable<SearchEvent>` so streaming Deep mode (Task 7) can emit retrieval / expansion / synthesis progress separately. Quick mode is keyword-only over titles + chunks; Balanced is HNSW vector retrieval (top-K=20) → LLM rerank top-N=5; both are scoped by composable filters (maturity, agent, min confidence, folder, date range, connectivity tier, has-pending-proposals). The result is a uniform `SearchResult` shape consumed by Task 8's UI and by chat's `vault.search_notes` tool in Task 11.

- [ ] **Step 1: Define types**

Create `src/core/search/types.ts`:

```typescript
import type { ConnectivityTier, Maturity } from "../vitals/types";

export type SearchMode = "quick" | "balanced" | "deep";

export interface SearchFilters {
  maturity?: Maturity[];
  agents?: string[];
  minConfidence?: number;
  folders?: string[];
  fromDate?: number;
  toDate?: number;
  connectivityTiers?: ConnectivityTier[];
  hasPendingProposals?: boolean;
}

export interface SearchQuery {
  query: string;
  mode: SearchMode;
  filters?: SearchFilters;
  limit?: number;
}

export interface SearchHit {
  notePath: string;
  chunkId: string | null;
  snippet: string;
  score: number;
  matchedText: string;
  vitalsTier?: ConnectivityTier;
  maturity?: Maturity;
  agentTags?: string[];
}

export interface SearchResult {
  query: string;
  mode: SearchMode;
  hits: SearchHit[];
  durationMs: number;
}

export type SearchEvent =
  | { type: "search:retrieving"; mode: SearchMode }
  | { type: "search:hits"; hits: SearchHit[] }
  | { type: "search:expanding"; baseHitCount: number }
  | { type: "search:synthesizing" }
  | { type: "search:done"; result: SearchResult }
  | { type: "search:error"; message: string };
```

- [ ] **Step 2: Filters**

Write `src/core/search/filters.test.ts` covering: SQL clause emission for folder + date range + maturity, post-filter for connectivity tier and hasPendingProposals, empty filter returns no constraints, unknown filter keys ignored.

Implement `src/core/search/filters.ts`:

```typescript
import type { SearchFilters } from "./types";

export interface SqlFragment {
  where: string;
  params: unknown[];
}

export function buildPathFilter(filters: SearchFilters | undefined): SqlFragment {
  if (!filters) return { where: "", params: [] };
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.folders && filters.folders.length > 0) {
    const ors = filters.folders.map(() => "notes.path LIKE ?");
    clauses.push(`(${ors.join(" OR ")})`);
    for (const folder of filters.folders) params.push(`${folder.replace(/\/$/, "")}/%`);
  }
  if (filters.maturity && filters.maturity.length > 0) {
    const placeholders = filters.maturity.map(() => "?").join(",");
    clauses.push(`notes.maturity IN (${placeholders})`);
    params.push(...filters.maturity);
  }
  if (typeof filters.fromDate === "number") {
    clauses.push("notes.updated_at >= ?");
    params.push(filters.fromDate);
  }
  if (typeof filters.toDate === "number") {
    clauses.push("notes.updated_at <= ?");
    params.push(filters.toDate);
  }
  return { where: clauses.length === 0 ? "" : ` AND ${clauses.join(" AND ")}`, params };
}

export interface PostFilterContext {
  approvedEdgeCountByPath: Map<string, number>;
  pendingByPath: Map<string, number>;
  thresholds: { sparse: number; connected: number; hub: number };
}

export function applyPostFilters(
  hits: { notePath: string }[],
  filters: SearchFilters | undefined,
  context: PostFilterContext,
): typeof hits {
  if (!filters) return hits;
  return hits.filter((hit) => {
    if (typeof filters.minConfidence === "number") {
      // confidence is per-hit and applied upstream; nothing to do here.
    }
    if (filters.connectivityTiers && filters.connectivityTiers.length > 0) {
      const count = context.approvedEdgeCountByPath.get(hit.notePath) ?? 0;
      const tier = bucket(count, context.thresholds);
      if (!filters.connectivityTiers.includes(tier)) return false;
    }
    if (filters.hasPendingProposals) {
      const pending = context.pendingByPath.get(hit.notePath) ?? 0;
      if (pending === 0) return false;
    }
    return true;
  });
}

function bucket(count: number, thresholds: { sparse: number; connected: number; hub: number }) {
  if (count >= thresholds.hub) return "hub" as const;
  if (count >= thresholds.connected) return "connected" as const;
  if (count >= thresholds.sparse) return "sparse" as const;
  return "isolated" as const;
}
```

- [ ] **Step 3: Quick strategy**

Write `src/core/search/strategies/quick.test.ts` covering: title hit beats body hit, fuzzy-tolerant match, returns `[]` on empty doc set, respects `limit`.

Implement `src/core/search/strategies/quick.ts`:

```typescript
import type { Database } from "../../db/database";
import { buildPathFilter } from "../filters";
import type { SearchFilters, SearchHit } from "../types";

export interface QuickSearchOptions {
  db: Database;
  query: string;
  filters?: SearchFilters;
  limit: number;
}

export function quickSearch(options: QuickSearchOptions): SearchHit[] {
  const term = `%${options.query.toLowerCase().replace(/[\s%]+/g, "%")}%`;
  const filterFragment = buildPathFilter(options.filters);
  const rows = options.db.query<{ note_path: string; chunk_id: string; text: string; updated_at: number }>(
    `SELECT chunks.note_path AS note_path, chunks.id AS chunk_id, chunks.text AS text, notes.updated_at AS updated_at
     FROM chunks
     JOIN notes ON chunks.note_path = notes.path
     WHERE LOWER(chunks.text) LIKE ?${filterFragment.where}
     ORDER BY notes.updated_at DESC
     LIMIT ?;`,
    [term, ...filterFragment.params, options.limit * 4],
  );
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const row of rows) {
    if (seen.has(row.note_path)) continue;
    seen.add(row.note_path);
    hits.push({
      notePath: row.note_path,
      chunkId: row.chunk_id,
      snippet: extractSnippet(row.text, options.query),
      score: 1,
      matchedText: options.query,
    });
    if (hits.length >= options.limit) break;
  }
  return hits;
}

function extractSnippet(text: string, query: string): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return text.slice(0, 200);
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + query.length + 60);
  return `${start === 0 ? "" : "…"}${text.slice(start, end)}${end === text.length ? "" : "…"}`;
}
```

- [ ] **Step 4: Reranker**

Write `src/core/search/reranker.test.ts` covering: identity reorder when model returns the input order, partial reorder respects model output, falls back to input order on parse error, abort signal propagates.

Implement `src/core/search/reranker.ts`:

```typescript
import type { LLMProvider } from "../llm/provider";
import { rerankPrompt } from "./prompts/rerank";
import type { SearchHit } from "./types";

export interface RerankerOptions {
  provider: LLMProvider;
  model: string;
}

export class Reranker {
  constructor(private readonly options: RerankerOptions) {}

  async rerank(query: string, hits: SearchHit[], topN: number, signal: AbortSignal): Promise<SearchHit[]> {
    if (hits.length <= 1) return hits.slice(0, topN);
    try {
      const result = await this.options.provider.chatJson<{ ranked: string[] }>({
        model: this.options.model,
        messages: rerankPrompt({
          query,
          hits: hits.map((h) => ({ id: h.chunkId ?? h.notePath, snippet: h.snippet })),
        }),
        signal,
      });
      const order = new Map(result.ranked.map((id, index) => [id, index]));
      return [...hits]
        .sort((a, b) => (order.get(a.chunkId ?? a.notePath) ?? Infinity) - (order.get(b.chunkId ?? b.notePath) ?? Infinity))
        .slice(0, topN);
    } catch {
      return hits.slice(0, topN);
    }
  }
}
```

Implement `src/core/search/prompts/rerank.ts`:

```typescript
import type { ChatMessage } from "../../llm/provider";

export function rerankPrompt(input: { query: string; hits: { id: string; snippet: string }[] }): ChatMessage[] {
  const numbered = input.hits.map((h, i) => `${i + 1}. (${h.id}) ${h.snippet}`).join("\n");
  return [
    {
      role: "system",
      content:
        "You rerank chunks for relevance. Reply with JSON {\"ranked\": [<id>, ...]} where ids are listed best-first. Output JSON only.",
    },
    { role: "user", content: `Query: ${input.query}\n\nChunks:\n${numbered}\n\nReply with the ranked ids.` },
  ];
}
```

(`ChatMessage` is the existing `LLMProvider` message shape from `src/core/llm/provider.ts`. Re-export from there if needed.)

- [ ] **Step 5: Balanced strategy**

Write `src/core/search/strategies/balanced.test.ts` covering: vector index returns top-K, reranker collapses to top-N, abort propagation, no embeddings fallback to Quick.

Implement `src/core/search/strategies/balanced.ts`:

```typescript
import type { Database } from "../../db/database";
import type { LLMProvider } from "../../llm/provider";
import type { VectorIndex } from "../../indexer/vectorIndex";
import { quickSearch } from "./quick";
import { Reranker } from "../reranker";
import type { SearchFilters, SearchHit } from "../types";

export interface BalancedSearchOptions {
  db: Database;
  vectorIndex: VectorIndex;
  embed: (text: string, signal: AbortSignal) => Promise<Float32Array | null>;
  reranker: Reranker;
  query: string;
  filters?: SearchFilters;
  topK: number;
  rerankTopN: number;
  signal: AbortSignal;
}

export async function balancedSearch(options: BalancedSearchOptions): Promise<SearchHit[]> {
  const embedding = await options.embed(options.query, options.signal);
  if (!embedding) {
    return quickSearch({ db: options.db, query: options.query, filters: options.filters, limit: options.rerankTopN });
  }
  const candidates = options.vectorIndex.search(embedding, options.topK);
  if (candidates.length === 0) return [];
  const rows = options.db.query<{ id: string; note_path: string; text: string }>(
    `SELECT id, note_path, text FROM chunks WHERE id IN (${candidates.map(() => "?").join(",")});`,
    candidates.map((c) => c.id),
  );
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const initial: SearchHit[] = candidates
    .map((c) => {
      const row = byId.get(c.id);
      if (!row) return null;
      return {
        notePath: row.note_path,
        chunkId: c.id,
        snippet: row.text.slice(0, 240),
        score: c.similarity,
        matchedText: options.query,
      } satisfies SearchHit;
    })
    .filter((h): h is SearchHit => h !== null);
  return options.reranker.rerank(options.query, initial, options.rerankTopN, options.signal);
}
```

- [ ] **Step 6: searchPipeline**

Write `src/core/search/searchPipeline.test.ts` covering: Quick mode dispatches to `quickSearch`, Balanced dispatches to `balancedSearch`, emits `search:hits` followed by `search:done`, emits `search:error` on thrown exception, abort signal cancels mid-stream.

Implement `src/core/search/searchPipeline.ts`:

```typescript
import { quickSearch } from "./strategies/quick";
import { balancedSearch } from "./strategies/balanced";
import { Reranker } from "./reranker";
import type { Database } from "../db/database";
import type { LLMProvider } from "../llm/provider";
import type { VectorIndex } from "../indexer/vectorIndex";
import type { SearchEvent, SearchHit, SearchQuery, SearchResult } from "./types";

export interface SearchPipelineOptions {
  db: Database;
  provider: LLMProvider;
  vectorIndex: VectorIndex;
  embed: (text: string, signal: AbortSignal) => Promise<Float32Array | null>;
  reranker: Reranker;
  settings: () => { balanced: { topK: number; rerankTopN: number } };
  now: () => number;
}

export class SearchPipeline {
  constructor(private readonly options: SearchPipelineOptions) {}

  async *run(query: SearchQuery, signal: AbortSignal): AsyncIterable<SearchEvent> {
    const start = this.options.now();
    const limit = query.limit ?? 5;
    yield { type: "search:retrieving", mode: query.mode };
    try {
      let hits: SearchHit[];
      if (query.mode === "quick") {
        hits = quickSearch({ db: this.options.db, query: query.query, filters: query.filters, limit });
      } else if (query.mode === "balanced") {
        const settings = this.options.settings();
        hits = await balancedSearch({
          db: this.options.db,
          vectorIndex: this.options.vectorIndex,
          embed: this.options.embed,
          reranker: this.options.reranker,
          query: query.query,
          filters: query.filters,
          topK: settings.balanced.topK,
          rerankTopN: Math.min(limit, settings.balanced.rerankTopN),
          signal,
        });
      } else {
        throw new Error(`Unsupported mode: ${query.mode} — Deep is implemented in Task 7.`);
      }
      yield { type: "search:hits", hits };
      const result: SearchResult = {
        query: query.query,
        mode: query.mode,
        hits,
        durationMs: this.options.now() - start,
      };
      yield { type: "search:done", result };
    } catch (error) {
      yield { type: "search:error", message: error instanceof Error ? error.message : String(error) };
    }
  }
}
```

- [ ] **Step 7: Verify**

Run: `bun run typecheck && bun run lint && bun test`

Expected: all new search-core tests pass (~12 new); existing tests stay green.

- [ ] **Step 8: Commit**

```bash
git add src/core/search
git commit -m "feat(search): pipeline core with Quick + Balanced + filters + reranker"
```



## Task 7: Search Deep mode + grounded synthesis + graph expansion

**Files:**
- Create: `src/core/search/graphExpansion.ts`
- Create: `src/core/search/graphExpansion.test.ts`
- Create: `src/core/search/synthesis.ts`
- Create: `src/core/search/synthesis.test.ts`
- Create: `src/core/search/strategies/deep.ts`
- Create: `src/core/search/strategies/deep.test.ts`
- Create: `src/core/search/prompts/deepSynthesize.ts`
- Modify: `src/core/search/searchPipeline.ts` (route `mode === "deep"` to deepSearch)

**Why:** Deep mode is what makes Notient's search worth using over Obsidian's: it combines vector retrieval, 1-hop graph expansion via approved `graph_edges`, and a grounded LLM synthesis whose every claim cites a `[[note]]`. Per Q7 it streams progress (retrieving / expanding / synthesizing) so the UI can paint a multi-stage progress card. Synthesis is grounded — the prompt enforces "cite or skip" and the response parser rejects un-cited bullets.

- [ ] **Step 1: Graph expansion**

Write `graphExpansion.test.ts` covering: 1-hop expansion adds approved-edge neighbors of base hits, deduplicates against base set, respects `depth=0` as a no-op, marks expanded hits with a `viaPath` field.

Implement `src/core/search/graphExpansion.ts`:

```typescript
import type { Database } from "../db/database";
import type { SearchHit } from "./types";

export interface GraphExpansionOptions {
  db: Database;
  baseHits: SearchHit[];
  depth: number;
}

export interface ExpandedHit extends SearchHit {
  viaPath: string;
}

export function expandViaApprovedEdges(options: GraphExpansionOptions): ExpandedHit[] {
  if (options.depth <= 0 || options.baseHits.length === 0) return [];
  const seenPaths = new Set(options.baseHits.map((h) => h.notePath));
  const baseNodeIds = options.baseHits.map((h) => `note:${h.notePath}`);
  const placeholders = baseNodeIds.map(() => "?").join(",");
  const rows = options.db.query<{ source_id: string; target_id: string; type: string; agent: string }>(
    `SELECT source_id, target_id, type, agent FROM graph_edges
     WHERE approved = 1 AND (source_id IN (${placeholders}) OR target_id IN (${placeholders}));`,
    [...baseNodeIds, ...baseNodeIds],
  );
  const expanded: ExpandedHit[] = [];
  for (const row of rows) {
    const sourceIsBase = baseNodeIds.includes(row.source_id);
    const otherId = sourceIsBase ? row.target_id : row.source_id;
    const otherPath = otherId.replace(/^note:/, "");
    if (seenPaths.has(otherPath)) continue;
    const originPath = (sourceIsBase ? row.source_id : row.target_id).replace(/^note:/, "");
    seenPaths.add(otherPath);
    expanded.push({
      notePath: otherPath,
      chunkId: null,
      snippet: `via [[${originPath}]] (${row.type}, agent: ${row.agent})`,
      score: 0.5,
      matchedText: "",
      viaPath: originPath,
    });
  }
  return expanded;
}
```

- [ ] **Step 2: Synthesis**

Write `synthesis.test.ts` covering: every bullet cites at least one `[[note]]`, bullets without citations are dropped, parser tolerates trailing prose, abort signal propagates.

Implement `src/core/search/synthesis.ts`:

```typescript
import type { LLMProvider } from "../llm/provider";
import { deepSynthesizePrompt } from "./prompts/deepSynthesize";
import type { SearchHit } from "./types";

export interface SynthesisCard {
  bullets: { text: string; citations: string[] }[];
  rawText: string;
}

export interface SynthesizerOptions {
  provider: LLMProvider;
  model: string;
  query: string;
  hits: SearchHit[];
  signal: AbortSignal;
}

export async function synthesize(options: SynthesizerOptions): Promise<SynthesisCard> {
  const { content } = await options.provider.chat({
    model: options.model,
    messages: deepSynthesizePrompt({ query: options.query, hits: options.hits }),
    signal: options.signal,
    maxTokens: 600,
  });
  return parseSynthesis(content);
}

const CITATION_RE = /\[\[[^\]]+\]\]/g;

export function parseSynthesis(text: string): SynthesisCard {
  const bulletRe = /^[\s>]*[-*]\s+(.*)$/gm;
  const bullets: { text: string; citations: string[] }[] = [];
  let match: RegExpExecArray | null = bulletRe.exec(text);
  while (match !== null) {
    const line = match[1].trim();
    const citations = Array.from(line.matchAll(CITATION_RE)).map((m) => m[0]);
    if (citations.length > 0) bullets.push({ text: line, citations });
    match = bulletRe.exec(text);
  }
  return { bullets, rawText: text };
}
```

Implement `src/core/search/prompts/deepSynthesize.ts`:

```typescript
import type { ChatMessage } from "../../llm/provider";
import type { SearchHit } from "../types";

export function deepSynthesizePrompt(input: { query: string; hits: SearchHit[] }): ChatMessage[] {
  const hitsBlock = input.hits
    .map((h, i) => `${i + 1}. [[${h.notePath.replace(/\.md$/, "")}]]\n${h.snippet}`)
    .join("\n\n");
  return [
    {
      role: "system",
      content: [
        "You answer the user's query using ONLY the provided notes.",
        "Reply as a markdown bullet list, max 3 bullets, each ending with at least one [[note title]] citation.",
        "If a claim is not supported by the notes, do not write it. Do not invent citations.",
      ].join(" "),
    },
    { role: "user", content: `Query: ${input.query}\n\nNotes:\n${hitsBlock}\n\nReply with bullets only.` },
  ];
}
```

- [ ] **Step 3: Deep strategy**

Write `strategies/deep.test.ts` covering: streams `search:retrieving` → `search:expanding` → `search:synthesizing` → `search:done` in order, includes synthesis card in result metadata, abort during synthesis emits `search:error`.

Implement `src/core/search/strategies/deep.ts`:

```typescript
import type { Database } from "../../db/database";
import type { LLMProvider } from "../../llm/provider";
import { balancedSearch } from "./balanced";
import { expandViaApprovedEdges } from "../graphExpansion";
import { synthesize, type SynthesisCard } from "../synthesis";
import type { Reranker } from "../reranker";
import type { VectorIndex } from "../../indexer/vectorIndex";
import type { SearchEvent, SearchFilters, SearchHit } from "../types";

export interface DeepSearchOptions {
  db: Database;
  provider: LLMProvider;
  vectorIndex: VectorIndex;
  embed: (text: string, signal: AbortSignal) => Promise<Float32Array | null>;
  reranker: Reranker;
  reasoningModel: string;
  query: string;
  filters?: SearchFilters;
  topK: number;
  rerankTopN: number;
  graphDepth: number;
  synthesisEnabled: boolean;
  signal: AbortSignal;
}

export interface DeepSearchOutput {
  hits: SearchHit[];
  synthesis: SynthesisCard | null;
}

export async function* deepSearch(options: DeepSearchOptions): AsyncGenerator<SearchEvent | { type: "deep:result"; output: DeepSearchOutput }> {
  yield { type: "search:retrieving", mode: "deep" };
  const base = await balancedSearch({
    db: options.db,
    vectorIndex: options.vectorIndex,
    embed: options.embed,
    reranker: options.reranker,
    query: options.query,
    filters: options.filters,
    topK: options.topK,
    rerankTopN: options.rerankTopN,
    signal: options.signal,
  });
  yield { type: "search:hits", hits: base };
  yield { type: "search:expanding", baseHitCount: base.length };
  const expanded = expandViaApprovedEdges({ db: options.db, baseHits: base, depth: options.graphDepth });
  const allHits = [...base, ...expanded];
  let synthesis: SynthesisCard | null = null;
  if (options.synthesisEnabled && base.length > 0) {
    yield { type: "search:synthesizing" };
    synthesis = await synthesize({
      provider: options.provider,
      model: options.reasoningModel,
      query: options.query,
      hits: allHits,
      signal: options.signal,
    });
  }
  yield { type: "deep:result", output: { hits: allHits, synthesis } };
}
```

- [ ] **Step 4: Wire deep into the pipeline**

Replace the deep branch in `searchPipeline.ts`:

```typescript
      } else {
        const settings = this.options.settings();
        const events = deepSearch({
          db: this.options.db,
          provider: this.options.provider,
          vectorIndex: this.options.vectorIndex,
          embed: this.options.embed,
          reranker: this.options.reranker,
          reasoningModel: this.options.reasoningModel,
          query: query.query,
          filters: query.filters,
          topK: settings.balanced.topK,
          rerankTopN: Math.min(limit, settings.balanced.rerankTopN),
          graphDepth: settings.deep.graphExpansionDepth,
          synthesisEnabled: settings.deep.synthesisEnabled,
          signal,
        });
        let output = { hits: [] as SearchHit[], synthesis: null as SynthesisCard | null };
        for await (const event of events) {
          if ("output" in event && event.type === "deep:result") {
            output = event.output;
          } else {
            yield event as SearchEvent;
          }
        }
        const result: SearchResult & { synthesis: SynthesisCard | null } = {
          query: query.query,
          mode: query.mode,
          hits: output.hits,
          durationMs: this.options.now() - start,
          synthesis: output.synthesis,
        };
        yield { type: "search:done", result };
      }
```

`SearchPipelineOptions` gains `provider`, `reasoningModel`, and the settings shape grows to include `deep`. `SearchResult` also gains an optional `synthesis` field — extend the type.

- [ ] **Step 5: Verify**

Run: `bun run typecheck && bun run lint && bun test`

Expected: graph-expansion tests + synthesis tests + deep-strategy tests pass; existing pipeline tests stay green.

- [ ] **Step 6: Commit**

```bash
git add src/core/search/graphExpansion.ts src/core/search/graphExpansion.test.ts src/core/search/synthesis.ts src/core/search/synthesis.test.ts src/core/search/strategies/deep.ts src/core/search/strategies/deep.test.ts src/core/search/prompts/deepSynthesize.ts src/core/search/searchPipeline.ts src/core/search/types.ts
git commit -m "feat(search): Deep mode with graph expansion + grounded synthesis"
```



## Task 8: SearchView UI (QueryBar + FilterRow + ResultList + PreviewPane + SynthesisCard)

**Files:**
- Create: `src/ui/search/state.ts`
- Create: `src/ui/search/SearchView.ts`
- Create: `src/ui/search/SearchApp.tsx`
- Create: `src/ui/search/components/QueryBar.tsx`
- Create: `src/ui/search/components/FilterRow.tsx`
- Create: `src/ui/search/components/ResultList.tsx`
- Create: `src/ui/search/components/ResultRow.tsx`
- Create: `src/ui/search/components/PreviewPane.tsx`
- Create: `src/ui/search/components/SynthesisCard.tsx`
- Create: `src/ui/search/components/HistoryDropdown.tsx`
- Create: `src/ui/search/SearchApp.test.tsx`
- Modify: `styles.css` (extend with `.notient-search-*`)

**Why:** SearchView is the centre-pane flagship surface for human-driven knowledge search. The two-pane layout (60/40 split, results left, preview right) plus a chip-based filter row and a mode-toggle in the QueryBar exposes the full pipeline (Quick / Balanced / Deep) and every filter (maturity, agent, min confidence, folders, date range, connectivity tier, has-pending-proposals). Hover-preview removes the click-each-to-decide friction of native search; Deep mode renders a SynthesisCard above the result list with citations as clickable wikilinks.

- [ ] **Step 1: View state**

Create `src/ui/search/state.ts` with `@preact/signals` signals:

```typescript
import { signal } from "@preact/signals";
import type { SearchFilters, SearchHit, SearchMode, SearchResult } from "../../core/search/types";
import type { SynthesisCard } from "../../core/search/synthesis";

export const searchQuery = signal<string>("");
export const searchMode = signal<SearchMode>("quick");
export const searchFilters = signal<SearchFilters>({});
export const searchRunning = signal<boolean>(false);
export const searchHits = signal<SearchHit[]>([]);
export const searchResult = signal<SearchResult | null>(null);
export const searchSynthesis = signal<SynthesisCard | null>(null);
export const searchPreviewPath = signal<string | null>(null);
export const searchHistorySignal = signal<string[]>([]);
```

A single `searchActions` signal carries handlers wired by `main.ts` in Task 16: `runSearch`, `cancelSearch`, `openHit`, `pinPreview`, `viewAsCanvas`, `saveQuery`, `newChatFromResults`.

- [ ] **Step 2: Component skeletons**

`QueryBar.tsx` — input box + mode tabs (Quick/Balanced/Deep) + cancel button (visible when running) + history dropdown trigger.

`FilterRow.tsx` — chip toggles for maturity (4), agents (4), connectivity tier (4), has-pending-proposals; range inputs for date and min confidence. Re-runs search on change via `searchActions.value.runSearch()`.

`ResultList.tsx` — virtualized via the `IntersectionObserver` pattern from Phase 3's status-footer (or a simple windowed renderer that mounts only the first 30 rows on initial paint, expanding on scroll). Each row clicks to focus the preview pane.

`ResultRow.tsx` — title + breadcrumb + highlighted snippet + maturity / connectivity badges + agent provenance chip + confidence bar + hover handler that updates `searchPreviewPath`.

`PreviewPane.tsx` — reads `searchPreviewPath`, fetches the note via `obsidianFacade.readNote`, renders raw markdown inside a styled container with the matched chunk highlighted (regex on `searchQuery.value`). Empty state when no preview is selected.

`SynthesisCard.tsx` — renders `searchSynthesis.value` bullets above the result list; each bullet's `[[wikilinks]]` are clickable via `workspace.openLinkText`. "Refine in chat" button calls `searchActions.value.newChatFromResults()`. "Save as note" button writes the synthesis to `Notient/searches/synth-<slug>.md`.

`HistoryDropdown.tsx` — small popover anchored to the QueryBar history trigger; shows last 50 queries from `searchHistorySignal`. Click prefills `searchQuery` and re-runs.

- [ ] **Step 3: Implement `SearchApp.tsx`**

```typescript
import { signal } from "@preact/signals";
import { QueryBar } from "./components/QueryBar";
import { FilterRow } from "./components/FilterRow";
import { ResultList } from "./components/ResultList";
import { PreviewPane } from "./components/PreviewPane";
import { SynthesisCard } from "./components/SynthesisCard";
import { searchSynthesis } from "./state";

export interface SearchAppActions {
  runSearch: () => void;
  cancelSearch: () => void;
  openHit: (notePath: string) => void;
  pinPreview: (notePath: string | null) => void;
  viewAsCanvas: () => void;
  saveQuery: () => void;
  newChatFromResults: () => void;
}

export const searchActions = signal<SearchAppActions | null>(null);

export function SearchApp() {
  return (
    <div class="notient-search-app">
      <QueryBar />
      <FilterRow />
      <main class="notient-search-body">
        <section class="notient-search-results">
          {searchSynthesis.value ? <SynthesisCard /> : null}
          <ResultList />
        </section>
        <aside class="notient-search-preview">
          <PreviewPane />
        </aside>
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Implement `SearchView` (Obsidian wrapper)**

```typescript
import { ItemView, WorkspaceLeaf } from "obsidian";
import { render } from "preact";
import { SearchApp } from "./SearchApp";

export const VIEW_TYPE_NOTIENT_SEARCH = "notient-search-view";

export class SearchView extends ItemView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_NOTIENT_SEARCH;
  }

  getDisplayText(): string {
    return "Notient Search";
  }

  getIcon(): string {
    return "search";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    const mount = container.createDiv({ cls: "notient-search-mount" });
    render(<SearchApp />, mount);
  }

  async onClose(): Promise<void> {
    const mount = this.containerEl.querySelector(".notient-search-mount") as HTMLElement | null;
    if (mount) render(null, mount);
  }
}
```

- [ ] **Step 5: Component-level test**

Create `src/ui/search/SearchApp.test.tsx` with one rendering smoke test:

```typescript
import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { SearchApp } from "./SearchApp";
import { searchHits, searchSynthesis } from "./state";

describe("SearchApp", () => {
  test("renders empty state with no hits", () => {
    searchHits.value = [];
    searchSynthesis.value = null;
    const html = render(<SearchApp />);
    expect(html).toContain("notient-search-app");
  });

  test("renders synthesis card when synthesis is present", () => {
    searchSynthesis.value = { bullets: [{ text: "claim", citations: ["[[a]]"] }], rawText: "" };
    const html = render(<SearchApp />);
    expect(html).toContain("notient-synthesis-card");
  });

  test("renders results when hits are present", () => {
    searchSynthesis.value = null;
    searchHits.value = [
      { notePath: "/a.md", chunkId: "c1", snippet: "hi", score: 1, matchedText: "hi" },
    ];
    const html = render(<SearchApp />);
    expect(html).toContain("/a.md");
  });
});
```

- [ ] **Step 6: Extend `styles.css`**

Add `.notient-search-app`, `.notient-search-body`, `.notient-search-results`, `.notient-search-preview`, `.notient-result-row`, `.notient-result-row__snippet`, `.notient-synthesis-card`, `.notient-filter-chip`, `.notient-filter-chip--active`. Use `display: grid; grid-template-columns: 60% 40%;` for the body, `gap: 8px;` between filter chips, `position: sticky; top: 0;` for the QueryBar.

- [ ] **Step 7: Verify**

Run: `bun run typecheck && bun run lint && bun test`

Expected: 3 SearchApp render tests + existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/ui/search styles.css
git commit -m "feat(search): SearchView UI with two-pane layout + filters + synthesis"
```



## Task 9: Saved searches + search history + canvas-from-results + native command palette wiring

**Files:**
- Create: `src/core/search/savedQueries.ts`
- Create: `src/core/search/savedQueries.test.ts`
- Create: `src/core/search/searchHistory.ts`
- Create: `src/core/search/searchHistory.test.ts`
- Create: `src/ui/search/canvasFromResults.ts`
- Create: `src/ui/search/canvasFromResults.test.ts`

**Why:** Saved searches are vault-native markdown files at `<vault>/Notient/searches/<slug>.md` carrying YAML frontmatter with the query + filters + mode + last-run timestamp. They are first-class vault citizens — wikilinkable, searchable in Obsidian's native search, syncable. Search history is a lightweight ring buffer in `<vault>/Notient/.index.json` (the same sidecar Task 10 uses for conversation metadata). Canvas-from-results plugs Q5's exporter into SearchView's "View as canvas" action.

- [ ] **Step 1: Saved queries**

Write `savedQueries.test.ts` covering: roundtrip (save → list → load → re-run), dedupe by slug, filter shape preserved through YAML, malformed file ignored.

Implement `src/core/search/savedQueries.ts`:

```typescript
import type { SearchFilters, SearchMode } from "./types";

export interface SavedQuery {
  id: string;
  query: string;
  mode: SearchMode;
  filters: SearchFilters;
  savedAt: number;
  lastRunAt: number | null;
  notePath: string;
}

export interface SavedQueriesFacade {
  list(folder: string): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
}

export interface SavedQueriesOptions {
  facade: SavedQueriesFacade;
  folder: string;
  now: () => number;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;

export class SavedQueries {
  constructor(private readonly options: SavedQueriesOptions) {}

  async list(): Promise<SavedQuery[]> {
    const paths = await this.options.facade.list(this.options.folder);
    const result: SavedQuery[] = [];
    for (const path of paths) {
      try {
        const raw = await this.options.facade.read(path);
        const parsed = parseSavedQueryMarkdown(raw, path);
        if (parsed) result.push(parsed);
      } catch {
        // skip malformed
      }
    }
    return result.sort((a, b) => b.savedAt - a.savedAt);
  }

  async save(input: { query: string; mode: SearchMode; filters: SearchFilters }): Promise<SavedQuery> {
    const slug = makeSlug(input.query);
    const path = `${this.options.folder}/${slug}.md`;
    const now = this.options.now();
    const saved: SavedQuery = { id: slug, query: input.query, mode: input.mode, filters: input.filters, savedAt: now, lastRunAt: null, notePath: path };
    const body = renderSavedQueryMarkdown(saved);
    await this.options.facade.write(path, body);
    return saved;
  }

  async touch(id: string): Promise<void> {
    const path = `${this.options.folder}/${id}.md`;
    const raw = await this.options.facade.read(path);
    const parsed = parseSavedQueryMarkdown(raw, path);
    if (!parsed) return;
    parsed.lastRunAt = this.options.now();
    await this.options.facade.write(path, renderSavedQueryMarkdown(parsed));
  }

  async remove(id: string): Promise<void> {
    await this.options.facade.delete(`${this.options.folder}/${id}.md`);
  }
}

function makeSlug(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "search";
}

export function parseSavedQueryMarkdown(raw: string, path: string): SavedQuery | null {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;
  const yaml = match[1];
  const fields: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  const filters: SearchFilters = JSON.parse(fields["filters"] ?? "{}");
  return {
    id: path.split("/").pop()!.replace(/\.md$/, ""),
    query: fields["query"] ?? "",
    mode: (fields["mode"] as SearchMode) ?? "quick",
    filters,
    savedAt: Number(fields["saved_at"] ?? 0),
    lastRunAt: fields["last_run_at"] ? Number(fields["last_run_at"]) : null,
    notePath: path,
  };
}

export function renderSavedQueryMarkdown(saved: SavedQuery): string {
  return `---
notient:
  saved_query:
    query: ${JSON.stringify(saved.query)}
    mode: ${saved.mode}
    filters: ${JSON.stringify(saved.filters)}
    saved_at: ${saved.savedAt}
    last_run_at: ${saved.lastRunAt ?? "null"}
---

# Search · ${saved.query}

> [!notient-saved-query] ${saved.mode}
> Re-run, edit, or open in SearchView.
`;
}
```

(Hand-rolled YAML emit kept simple — full YAML library overkill for a flat schema. Tests verify roundtrip equivalence.)

- [ ] **Step 2: Search history (ring buffer)**

Write `searchHistory.test.ts` covering: push records latest first, max-size cap drops oldest, dedupe consecutive duplicates, persist/load roundtrip via fake facade.

Implement `src/core/search/searchHistory.ts` with two methods on `SearchHistory`: `record({ query, mode, ranAt })` pushes to the buffer (deduplicating immediate repeats by query+mode), and `list()` returns the last N. Persistence target is `<vault>/Notient/.index.json` keyed under `searchHistory: [...]`. The implementer reuses Task 10's `conversationIndex` JSON I/O helper rather than duplicating.

- [ ] **Step 3: Canvas-from-results**

Write `canvasFromResults.test.ts` covering: produces a path under `Notient/searches/canvases/`, generates valid JSON, filename slug derived from query, edges connect query node to each result.

Implement `src/ui/search/canvasFromResults.ts`:

```typescript
import { generateSearchResultsCanvas } from "../../core/canvas/canvasGenerator";
import type { SearchResult } from "../../core/search/types";

export interface CanvasFromResultsFacade {
  writeText(path: string, content: string): Promise<void>;
  ensureFolder(path: string): Promise<void>;
}

export interface CanvasFromResultsOptions {
  facade: CanvasFromResultsFacade;
  folder: string;
  now: () => number;
}

export class CanvasFromResults {
  constructor(private readonly options: CanvasFromResultsOptions) {}

  async export(result: SearchResult): Promise<string> {
    const folder = `${this.options.folder}/canvases`;
    await this.options.facade.ensureFolder(folder);
    const slug = makeSlug(result.query);
    const path = `${folder}/${slug}-${this.options.now()}.canvas`;
    const canvas = generateSearchResultsCanvas({
      query: result.query,
      resultPaths: result.hits.map((h) => h.notePath),
    });
    await this.options.facade.writeText(path, JSON.stringify(canvas, null, 2));
    return path;
  }
}

function makeSlug(query: string): string {
  return query.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "search";
}
```

- [ ] **Step 4: Verify**

Run: `bun run typecheck && bun run lint && bun test`

Expected: 4 saved-queries + 4 history + 3 canvas-from-results tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/search/savedQueries.ts src/core/search/savedQueries.test.ts src/core/search/searchHistory.ts src/core/search/searchHistory.test.ts src/ui/search/canvasFromResults.ts src/ui/search/canvasFromResults.test.ts
git commit -m "feat(search): saved queries + ring-buffer history + canvas-from-results"
```



## Task 10: Conversation storage (markdown + parser + vault index)

**Files:**
- Create: `src/core/chat/types.ts`
- Create: `src/core/chat/conversationParser.ts`
- Create: `src/core/chat/conversationParser.test.ts`
- Create: `src/core/chat/conversationStore.ts`
- Create: `src/core/chat/conversationStore.test.ts`
- Create: `src/core/chat/conversationIndex.ts`
- Create: `src/core/chat/conversationIndex.test.ts`

**Why:** Per Q6 conversations live in the vault as markdown, not in SQLite. This task ships the four primitives that every later chat task depends on: (1) the type set (`ChatMessage`, `ToolCall`, `ToolResult`, `Conversation`), (2) the markdown ↔ object parser using native Obsidian callouts (`> [!notient-tool]`, `> [!notient-approval]`) so files render natively in Reading view, (3) a CRUD `ConversationStore` over the vault folder, (4) a `<vault>/Notient/.index.json` sidecar carrying conversation metadata + `summary_embedding` cache for cross-session memory.

- [ ] **Step 1: Define types**

Create `src/core/chat/types.ts`:

```typescript
export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  status: "ok" | "error";
  data?: unknown;
  error?: string;
  durationMs: number;
}

export interface ApprovalRecord {
  callId: string;
  approved: boolean;
  decidedAt: number;
  reason?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  approvals?: ApprovalRecord[];
  reasoningContent?: string;
  createdAt: number;
}

export type ApprovalMode = "safe" | "yolo";

export interface Conversation {
  id: string;
  notePath: string;
  model: string;
  pinnedContext: string[];
  approvalMode: ApprovalMode;
  topic: string;
  summary: string;
  summaryEmbeddingB64: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}
```

- [ ] **Step 2: Conversation parser**

Write `conversationParser.test.ts` covering: full roundtrip on a fixture with text + tool call + tool result + approval, frontmatter values preserved, multiple sequential tool calls in one assistant turn, tolerates trailing whitespace, rejects malformed callouts gracefully (degrades to plain text).

Implement `src/core/chat/conversationParser.ts`:

```typescript
import type {
  ApprovalMode,
  ApprovalRecord,
  ChatMessage,
  ChatRole,
  Conversation,
  ToolCall,
  ToolResult,
} from "./types";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;

interface ConversationFrontmatter {
  conversation_id: string;
  model: string;
  pinned_context: string[];
  approval_mode: ApprovalMode;
  topic: string;
  summary: string;
  summary_embedding_b64: string | null;
  created_at: number;
  updated_at: number;
  message_count: number;
}

export function serializeConversation(conv: Conversation): string {
  const fm = renderFrontmatter({
    conversation_id: conv.id,
    model: conv.model,
    pinned_context: conv.pinnedContext,
    approval_mode: conv.approvalMode,
    topic: conv.topic,
    summary: conv.summary,
    summary_embedding_b64: conv.summaryEmbeddingB64,
    created_at: conv.createdAt,
    updated_at: conv.updatedAt,
    message_count: conv.messageCount,
  });
  const body = `# ${conv.topic}\n\n${conv.messages.map((m) => renderMessage(m)).join("\n\n")}\n`;
  return `${fm}\n${body}`;
}

export function parseConversation(raw: string, notePath: string): Conversation {
  const match = FRONTMATTER_RE.exec(raw);
  const frontmatter = match ? parseFrontmatter(match[1]) : defaultFrontmatter();
  const body = match ? raw.slice(match[0].length) : raw;
  const messages = parseMessages(body);
  return {
    id: frontmatter.conversation_id,
    notePath,
    model: frontmatter.model,
    pinnedContext: frontmatter.pinned_context,
    approvalMode: frontmatter.approval_mode,
    topic: frontmatter.topic,
    summary: frontmatter.summary,
    summaryEmbeddingB64: frontmatter.summary_embedding_b64,
    messageCount: messages.length,
    createdAt: frontmatter.created_at,
    updatedAt: frontmatter.updated_at,
    messages,
  };
}

function renderMessage(msg: ChatMessage): string {
  const role = capitalize(msg.role);
  const header = `## ${role} · ${formatTimestamp(msg.createdAt)}`;
  const blocks: string[] = [header];
  if (msg.toolCalls) {
    for (const call of msg.toolCalls) {
      blocks.push(renderToolCall(call, msg.toolResults?.find((r) => r.callId === call.id), msg.approvals?.find((a) => a.callId === call.id)));
    }
  }
  if (msg.content.trim().length > 0) blocks.push(msg.content);
  return blocks.join("\n\n");
}

function renderToolCall(call: ToolCall, result: ToolResult | undefined, approval: ApprovalRecord | undefined): string {
  const lines = [
    `> [!notient-tool] ${call.name}`,
    `> args: ${JSON.stringify(call.args)}`,
  ];
  if (result) {
    lines.push(`> result: ${JSON.stringify(result.data ?? result.error ?? null)}`);
  }
  let block = lines.join("\n");
  if (approval) {
    block += `\n\n> [!notient-approval] ${call.name}\n> status: ${approval.approved ? "approved" : "rejected"}${approval.reason ? ` · ${approval.reason}` : ""}`;
  }
  return block;
}

function parseMessages(body: string): ChatMessage[] {
  const sections = body.split(/^## /m).slice(1);
  const messages: ChatMessage[] = [];
  for (const section of sections) {
    const headerEnd = section.indexOf("\n");
    const header = section.slice(0, headerEnd);
    const rest = section.slice(headerEnd + 1);
    const role = parseRole(header);
    if (!role) continue;
    const calloutData = extractCallouts(rest);
    messages.push({
      id: cryptoRandomId(),
      role,
      content: calloutData.contentWithoutCallouts.trim(),
      toolCalls: calloutData.toolCalls,
      toolResults: calloutData.toolResults,
      approvals: calloutData.approvals,
      createdAt: parseTimestamp(header),
    });
  }
  return messages;
}

// (parseFrontmatter, renderFrontmatter, parseRole, parseTimestamp, formatTimestamp,
//  extractCallouts, defaultFrontmatter, capitalize, cryptoRandomId implemented to mirror the
//  fixture roundtrip required by the tests.)
```

The implementer fills in the helper functions. Edge cases the tests require: callout extraction handles nested `>` lines, `JSON.parse` failures degrade to a "raw payload" placeholder rather than throwing, timestamps round-trip via ISO 8601.

- [ ] **Step 3: Conversation store**

Write `conversationStore.test.ts` covering: create stores a markdown file at expected path, load reads it back, list returns all conversations sorted by updated_at desc, delete removes the file, save updates updatedAt + message_count.

Implement `src/core/chat/conversationStore.ts` over a `ConversationStoreFacade` interface (`list`, `read`, `write`, `delete`). Path computation: `${folder}/${formatDate(createdAt)} ${slug(topic)}.md`. EchoGuard.mark before every write so the indexer (already configured to exclude this folder in Task 0) wouldn't loop even if the user re-enables indexing on the conversations folder.

```typescript
import type { Conversation } from "./types";
import { parseConversation, serializeConversation } from "./conversationParser";

export interface ConversationStoreFacade {
  list(folder: string): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
}

export interface ConversationStoreOptions {
  facade: ConversationStoreFacade;
  folder: string;
  now: () => number;
}

export class ConversationStore {
  constructor(private readonly options: ConversationStoreOptions) {}

  async list(): Promise<Conversation[]> {
    const paths = await this.options.facade.list(this.options.folder);
    const conversations: Conversation[] = [];
    for (const path of paths) {
      try {
        const raw = await this.options.facade.read(path);
        conversations.push(parseConversation(raw, path));
      } catch {
        // skip malformed
      }
    }
    return conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(notePath: string): Promise<Conversation> {
    const raw = await this.options.facade.read(notePath);
    return parseConversation(raw, notePath);
  }

  async save(conversation: Conversation): Promise<void> {
    const next: Conversation = {
      ...conversation,
      updatedAt: this.options.now(),
      messageCount: conversation.messages.length,
    };
    await this.options.facade.write(next.notePath, serializeConversation(next));
  }

  async delete(notePath: string): Promise<void> {
    await this.options.facade.delete(notePath);
  }
}
```

- [ ] **Step 4: Conversation index**

Write `conversationIndex.test.ts` covering: append-on-save, embedding decode, top-K cosine similarity over decoded vectors, threshold filter, persistence roundtrip.

Implement `src/core/chat/conversationIndex.ts`:

```typescript
import type { Conversation } from "./types";

export interface ConversationIndexEntry {
  id: string;
  path: string;
  topic: string;
  updatedAt: number;
  embedding: Float32Array | null;
}

export interface ConversationIndexFacade {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

export interface ConversationIndexOptions {
  facade: ConversationIndexFacade;
  indexPath: string; // <vault>/Notient/.index.json
}

export class ConversationIndex {
  private entries: ConversationIndexEntry[] = [];

  constructor(private readonly options: ConversationIndexOptions) {}

  async load(): Promise<void> {
    const raw = await this.options.facade.read(this.options.indexPath);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { conversations?: { id: string; path: string; topic: string; updatedAt: number; embedding: string | null }[] };
    this.entries = (parsed.conversations ?? []).map((entry) => ({
      id: entry.id,
      path: entry.path,
      topic: entry.topic,
      updatedAt: entry.updatedAt,
      embedding: entry.embedding ? decodeBase64Float32(entry.embedding) : null,
    }));
  }

  async record(conversation: Conversation): Promise<void> {
    const embedding = conversation.summaryEmbeddingB64 ? decodeBase64Float32(conversation.summaryEmbeddingB64) : null;
    const entry: ConversationIndexEntry = {
      id: conversation.id,
      path: conversation.notePath,
      topic: conversation.topic,
      updatedAt: conversation.updatedAt,
      embedding,
    };
    const existingIndex = this.entries.findIndex((e) => e.id === conversation.id);
    if (existingIndex >= 0) this.entries[existingIndex] = entry;
    else this.entries.push(entry);
    await this.persist();
  }

  search(queryEmbedding: Float32Array, k: number, threshold: number): ConversationIndexEntry[] {
    const scored = this.entries
      .filter((entry) => entry.embedding !== null)
      .map((entry) => ({ entry, sim: cosine(entry.embedding!, queryEmbedding) }))
      .filter((s) => s.sim >= threshold)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, k);
    return scored.map((s) => s.entry);
  }

  private async persist(): Promise<void> {
    const payload = {
      conversations: this.entries.map((entry) => ({
        id: entry.id,
        path: entry.path,
        topic: entry.topic,
        updatedAt: entry.updatedAt,
        embedding: entry.embedding ? encodeBase64Float32(entry.embedding) : null,
      })),
    };
    await this.options.facade.write(this.options.indexPath, JSON.stringify(payload));
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function decodeBase64Float32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

function encodeBase64Float32(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
```

- [ ] **Step 5: Verify**

Run: `bun run typecheck && bun run lint && bun test`

Expected: 4 parser + 4 store + 3 index tests pass; existing stay green.

- [ ] **Step 6: Commit**

```bash
git add src/core/chat/types.ts src/core/chat/conversationParser.ts src/core/chat/conversationParser.test.ts src/core/chat/conversationStore.ts src/core/chat/conversationStore.test.ts src/core/chat/conversationIndex.ts src/core/chat/conversationIndex.test.ts
git commit -m "feat(chat): vault-native conversation storage + parser + index"
```



## Task 11: Chat tool registry + read-only tools (vault, graph, agents, proposals)

**Files:**
- Create: `src/core/chat/tools/registry.ts`
- Create: `src/core/chat/tools/registry.test.ts`
- Create: `src/core/chat/tools/vault.ts`
- Create: `src/core/chat/tools/vault.test.ts`
- Create: `src/core/chat/tools/graph.ts`
- Create: `src/core/chat/tools/graph.test.ts`
- Create: `src/core/chat/tools/agents.ts`
- Create: `src/core/chat/tools/agents.test.ts`
- Create: `src/core/chat/tools/proposals.ts`
- Create: `src/core/chat/tools/proposals.test.ts`

**Why:** Per Q6 the chat agent invokes typed tools to read the vault, graph, agents, and proposals. The registry exposes a JSON-schema for each tool (consumed by the LM Studio `tools` parameter and by the JSON-fallback path) plus a typed dispatcher for executing calls. Read-only tools land here; write-gated tools land in Task 12 with the approval gate. Each tool has a tight schema and unit tests that pin its argument validation + result shape.

- [ ] **Step 1: Registry**

Write `registry.test.ts` covering: register / get / list, JSON-schema export shape (`{name, description, parameters: {type:'object', properties, required}}`), invoke with valid args, invoke with invalid args throws `ToolValidationError`, invoke with unknown name throws.

Implement `src/core/chat/tools/registry.ts`:

```typescript
export interface ToolDefinition<Args, Result> {
  name: string;
  description: string;
  schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  validate: (args: unknown) => Args;
  invoke: (args: Args, signal: AbortSignal) => Promise<Result>;
  writeGated: boolean;
}

export class ToolValidationError extends Error {
  constructor(public readonly toolName: string, message: string) {
    super(`Tool "${toolName}" validation failed: ${message}`);
    this.name = "ToolValidationError";
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>();

  register<Args, Result>(tool: ToolDefinition<Args, Result>): void {
    this.tools.set(tool.name, tool as ToolDefinition<unknown, unknown>);
  }

  list(): { name: string; description: string; schema: object; writeGated: boolean }[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      schema: t.schema,
      writeGated: t.writeGated,
    }));
  }

  exportToolsForOpenAI(): { type: "function"; function: { name: string; description: string; parameters: object } }[] {
    return Array.from(this.tools.values()).map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.schema },
    }));
  }

  async invoke(name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    let validated: unknown;
    try {
      validated = tool.validate(args);
    } catch (error) {
      throw new ToolValidationError(name, error instanceof Error ? error.message : String(error));
    }
    return tool.invoke(validated, signal);
  }

  isWriteGated(name: string): boolean {
    return this.tools.get(name)?.writeGated ?? false;
  }
}
```

- [ ] **Step 2: Vault tools**

Write `vault.test.ts` covering: `vault.search_notes` calls `searchPipeline.run` with the right args, `vault.read_note` returns the file body and supports lineRange, `vault.list_neighbors` reads `graph_edges` for the active note, `vault.get_vitals` calls `vitalsService.computeSnapshot`, abort signal cancels search.

Implement `src/core/chat/tools/vault.ts` with four `ToolDefinition` factories:

```typescript
import type { SearchPipeline } from "../../search/searchPipeline";
import type { VitalsService } from "../../vitals/vitalsService";
import type { ToolDefinition } from "./registry";

export interface VaultFacade {
  readNote(path: string): Promise<string>;
}

export function makeVaultSearchTool(pipeline: SearchPipeline): ToolDefinition<{ query: string; mode: "quick" | "balanced"; limit?: number; filters?: object }, { hits: unknown[]; durationMs: number }> {
  return {
    name: "vault.search_notes",
    description: "Search notes by keyword (mode=quick) or semantic similarity (mode=balanced).",
    schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        mode: { type: "string", enum: ["quick", "balanced"] },
        limit: { type: "number" },
        filters: { type: "object" },
      },
      required: ["query", "mode"],
    },
    validate: (args) => {
      if (!isObject(args)) throw new Error("expected object");
      if (typeof args.query !== "string" || args.query.length === 0) throw new Error("query required");
      const mode = args.mode === "quick" || args.mode === "balanced" ? args.mode : null;
      if (!mode) throw new Error("mode must be quick or balanced");
      return { query: args.query, mode, limit: typeof args.limit === "number" ? args.limit : undefined, filters: isObject(args.filters) ? args.filters : undefined };
    },
    invoke: async (args, signal) => {
      let final: { hits: unknown[]; durationMs: number } | null = null;
      for await (const event of pipeline.run({ query: args.query, mode: args.mode, filters: args.filters as never, limit: args.limit }, signal)) {
        if (event.type === "search:done") final = { hits: event.result.hits, durationMs: event.result.durationMs };
      }
      if (!final) throw new Error("search produced no result");
      return final;
    },
    writeGated: false,
  };
}

// makeReadNoteTool, makeListNeighborsTool, makeGetVitalsTool follow the same pattern.

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

The implementer fills in the three remaining factories (`vault.read_note`, `vault.list_neighbors`, `vault.get_vitals`) following the same shape. Each factory is a function returning a `ToolDefinition` with `writeGated: false`.

- [ ] **Step 3: Graph tools**

Write `graph.test.ts` covering: `graph.find_path` BFS returns shortest path, no path returns empty, depth cap respected, `graph.list_clusters` reads from a cache the Synthesizer maintains.

Implement `src/core/chat/tools/graph.ts` with two factories: `makeFindPathTool(db)` (BFS over `graph_edges` where `approved = 1`, capped at `maxHops`) and `makeListClustersTool(db, clusterCache)`. Cluster cache is a small in-memory store the Synthesizer populates on each run; if absent, the tool returns `[]`.

- [ ] **Step 4: Agent tools**

Write `agents.test.ts` covering: `agents.explain` streams from `provider.chatStream` with the explain prompt, `agents.synthesize` invokes the existing Synthesizer with `trigger: "user-action"`, `agents.contradiction_check` invokes the existing ContradictionHunter scoped to one note's neighborhood, abort signal cascades.

Implement `src/core/chat/tools/agents.ts` reusing the Phase 3 agents (Synthesizer, ContradictionHunter) and the existing `chatStream`. Each factory takes the agent instance + provider as deps.

- [ ] **Step 5: Proposal tools (read-only)**

Write `proposals.test.ts` covering: `proposals.list` returns pending edges + nodes filtered by `notePath` + `agent`, malformed evidence JSON tolerated.

Implement `src/core/chat/tools/proposals.ts` with one read-only factory `makeListProposalsTool(db)` that returns pending staging items joined to graph_nodes for path resolution. (`accept_edge` / `reject_edge` / `accept_node` are write-gated and land in Task 12.)

- [ ] **Step 6: Verify**

Run: `bun run typecheck && bun run lint && bun test`

Expected: registry tests + 4 tool-test groups pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/chat/tools
git commit -m "feat(chat): tool registry + read-only vault/graph/agents/proposals tools"
```



## Task 12: Chat write-gated tools + ApprovalCard primitive + yolo/safe modes + tool-mode probe + LM Studio extensions

**Files:**
- Create: `src/core/chat/tools/notes.ts`
- Create: `src/core/chat/tools/notes.test.ts`
- Create: `src/core/chat/approvalGate.ts`
- Create: `src/core/chat/approvalGate.test.ts`
- Create: `src/core/chat/toolModeProbe.ts`
- Create: `src/core/chat/toolModeProbe.test.ts`
- Modify: `src/core/llm/provider.ts` (add `chatWithTools` interface method)
- Modify: `src/core/llm/lmStudioProvider.ts` (implement `chatWithTools`, native tools + reasoning_content support)

**Why:** Per Q6 every write tool (`note.append_section`, `note.create`, `proposals.accept_edge`, `proposals.reject_edge`, `proposals.accept_node`) routes through an `ApprovalGate` that — depending on the conversation's `approval_mode` — either blocks the agent loop on a user decision (safe) or auto-approves while logging to `history` for one-click undo (yolo). The `toolModeProbe` auto-detects whether the active LM Studio model supports the OpenAI-compatible `tools` parameter natively, falling back to a structured JSON pattern. The provider gains `chatWithTools` returning native tool_calls when supported. Reasoning content (Phase 2.5 fallback) is propagated separately so Task 14's UI can render it in a collapsible block.

- [ ] **Step 1: Provider extension**

Extend `src/core/llm/provider.ts`:

```typescript
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export interface ChatToolCallDelta {
  id: string;
  name: string;
  argsJson: string; // accumulating JSON
}

export interface ChatWithToolsRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  toolChoice?: "auto" | "required" | "none";
  signal: AbortSignal;
  maxTokens?: number;
}

export interface ChatWithToolsEvent {
  type: "delta";
  contentDelta?: string;
  reasoningDelta?: string;
  toolCallDelta?: ChatToolCallDelta;
}

export interface ChatWithToolsResult {
  content: string;
  reasoningContent: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
}

export interface LLMProvider {
  // existing chat / chatJson / chatStream methods
  chatWithTools(request: ChatWithToolsRequest): Promise<{ events: AsyncIterable<ChatWithToolsEvent>; result: () => Promise<ChatWithToolsResult> }>;
}
```

Extend `src/core/llm/lmStudioProvider.ts` to implement `chatWithTools` against the OpenAI-compatible `tools` parameter. The implementer accumulates `delta.tool_calls[].function.arguments` into `argsJson` per call_id; on stream end, `JSON.parse(argsJson)` produces the final args. `delta.reasoning_content` deltas accumulate separately. On abort, the SSE reader is cancelled (Phase 2.5 pattern).

- [ ] **Step 2: Tool-mode probe**

Write `toolModeProbe.test.ts` covering: probe returns `"native"` when model emits `tool_calls`, returns `"json-fallback"` when content is a JSON object with `{tool, args}`, returns `"disabled"` on neither, caches the result in settings (passed-in updater).

Implement `src/core/chat/toolModeProbe.ts`:

```typescript
import type { LLMProvider } from "../llm/provider";

export type ToolMode = "native" | "json-fallback" | "disabled";

export interface ToolModeProbeOptions {
  provider: LLMProvider;
  model: string;
  signal: AbortSignal;
  cache: { read: () => ToolMode | null; write: (mode: ToolMode) => Promise<void> };
}

const PROBE_TOOL = {
  type: "function" as const,
  function: {
    name: "echo",
    description: "Returns the input string. Probe-only.",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  },
};

export async function probeToolMode(options: ToolModeProbeOptions): Promise<ToolMode> {
  const cached = options.cache.read();
  if (cached) return cached;
  try {
    const handle = await options.provider.chatWithTools({
      model: options.model,
      messages: [{ role: "user", content: "Call the echo tool with value=ping." }],
      tools: [PROBE_TOOL],
      toolChoice: "required",
      signal: options.signal,
      maxTokens: 256,
    });
    for await (const _event of handle.events) {
      // drain
    }
    const result = await handle.result();
    if (result.toolCalls.length > 0) {
      await options.cache.write("native");
      return "native";
    }
    const parsed = tryParseToolJson(result.content);
    if (parsed) {
      await options.cache.write("json-fallback");
      return "json-fallback";
    }
    await options.cache.write("disabled");
    return "disabled";
  } catch {
    await options.cache.write("disabled");
    return "disabled";
  }
}

export function tryParseToolJson(content: string): { tool: string; args: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null && typeof parsed.tool === "string") {
      return { tool: parsed.tool, args: typeof parsed.args === "object" && parsed.args !== null ? parsed.args : {} };
    }
  } catch {
    return null;
  }
  return null;
}
```

Per-model-family behaviour table (the implementer encodes this in a comment at the top of `toolModeProbe.ts` as guidance for future-model classification):

```text
nemotron-cascade-2-30b-a3b-i1   → native (with reasoning_content channel; strip from history)
llama-3.{1,3}-instruct          → native
qwen2.5-{coder,instruct}        → native
deepseek-r1 distills, qwq-32b   → json-fallback (R1 not trained for tools)
gpt-oss-20b/120b                → native (reasoning_content channel)
unknown                         → probe and cache
```

- [ ] **Step 3: Approval gate**

Write `approvalGate.test.ts` covering: safe mode resolves on user.approve, safe mode rejects on user.reject with reason, yolo mode auto-resolves immediately and records history, abort during pending approval rejects with abort error, ApprovalGate cleans up handlers on resolve.

Implement `src/core/chat/approvalGate.ts`:

```typescript
import type { ApprovalMode, ToolCall } from "./types";

export interface PendingApproval {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  preview: string;
  resolve: (decision: ApprovalDecision) => void;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export interface ApprovalGateEvents {
  onPending: (pending: PendingApproval) => void;
  onResolved: (callId: string, decision: ApprovalDecision) => void;
}

export interface ApprovalGateOptions {
  events: ApprovalGateEvents;
  recordHistoryAutoApprove: (call: ToolCall) => Promise<void>;
}

export class ApprovalGate {
  private pending = new Map<string, PendingApproval>();

  constructor(private readonly options: ApprovalGateOptions) {}

  async request(call: ToolCall, mode: ApprovalMode, preview: string, signal: AbortSignal): Promise<ApprovalDecision> {
    if (mode === "yolo") {
      await this.options.recordHistoryAutoApprove(call);
      const decision: ApprovalDecision = { approved: true };
      this.options.events.onResolved(call.id, decision);
      return decision;
    }
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const pending: PendingApproval = {
        callId: call.id,
        toolName: call.name,
        args: call.args,
        preview,
        resolve: (decision) => {
          this.pending.delete(call.id);
          signal.removeEventListener("abort", onAbort);
          this.options.events.onResolved(call.id, decision);
          resolve(decision);
        },
      };
      const onAbort = (): void => {
        this.pending.delete(call.id);
        reject(new DOMException("aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(call.id, pending);
      this.options.events.onPending(pending);
    });
  }

  resolve(callId: string, decision: ApprovalDecision): void {
    const pending = this.pending.get(callId);
    if (!pending) return;
    pending.resolve(decision);
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }
}
```

- [ ] **Step 4: Write-gated tools**

Write `notes.test.ts` covering: `note.append_section` produces a markdown diff preview, executes only after approval, EchoGuard mark fires before write, `note.create` checks path collision before writing, abort during approval rejects.

Implement `src/core/chat/tools/notes.ts` with three write-gated factories: `makeAppendSectionTool`, `makeCreateNoteTool`, plus `makeAcceptEdgeTool` and `makeRejectEdgeTool` that wrap `ApprovalService.acceptEdge` / `rejectEdge`. Each factory takes the `ApprovalGate` instance + facade + EchoGuard. The `invoke` body:

```typescript
async invoke(args, signal) {
  const callId = makeId();
  const preview = renderDiff(currentBody, nextBody);
  const decision = await gate.request({ id: callId, name: "note.append_section", args }, currentMode(), preview, signal);
  if (!decision.approved) return { applied: false, reason: decision.reason };
  const sha = await hash(nextBody);
  echoGuard.mark(args.path, sha);
  await facade.writeNote(args.path, nextBody);
  await historyService.record({ kind: "note.append_section", target: args.path, before: currentBody, after: nextBody });
  return { applied: true };
}
```

- [ ] **Step 5: Verify**

Run: `bun run typecheck && bun run lint && bun test`

Expected: probe + approval + notes tests pass; existing tests stay green; `chatWithTools` integration test stubbed against a mock provider passes.

- [ ] **Step 6: Commit**

```bash
git add src/core/chat/tools/notes.ts src/core/chat/tools/notes.test.ts src/core/chat/approvalGate.ts src/core/chat/approvalGate.test.ts src/core/chat/toolModeProbe.ts src/core/chat/toolModeProbe.test.ts src/core/llm/provider.ts src/core/llm/lmStudioProvider.ts
git commit -m "feat(chat): write-gated tools + approval gate + tool-mode probe + LM Studio chatWithTools"
```



## Task 13: Chat agent loop + 8-layer context manager + cross-session memory

**Files:**
- Create: `src/core/chat/contextManager.ts`
- Create: `src/core/chat/contextManager.test.ts`
- Create: `src/core/chat/agentLoop.ts`
- Create: `src/core/chat/agentLoop.test.ts`
- Create: `src/core/chat/chatService.ts`
- Create: `src/core/chat/chatService.test.ts`
- Create: `src/core/chat/prompts/system.ts`
- Create: `src/core/chat/prompts/summarize.ts`

**Why:** This task wires the brain. The `ContextManager` composes the eight-layer system prompt for every turn (identity, user profile, vault snapshot, workspace state, pinned context, cross-session memory, tool catalog, conversation history with summarization at 70% budget). The `AgentLoop` runs the iterative tool-call cycle: LLM call → tool calls → execute (via approval gate when write-gated) → append results → loop until text-only or round cap. `ChatService` is the public facade exposed to the UI: `startConversation`, `sendMessage`, `abort`, `listConversations`, `loadConversation`. All LLM activity goes through `mutex.runPriority("chat", ...)` so chat preempts background agents (last-priority-wins with co-author).

- [ ] **Step 1: System + summarize prompts**

Create `src/core/chat/prompts/system.ts`:

```typescript
import type { ChatMessage } from "../types";
import type { ToolDefinition } from "../tools/registry";

export interface SystemPromptInput {
  identity: string;
  userProfile: string;
  vaultSnapshot: string;
  workspaceState: string;
  pinnedContext: string;
  crossSessionMemory: string;
  approvalMode: "safe" | "yolo";
  tools: { name: string; description: string }[];
}

export function composeSystemPrompt(input: SystemPromptInput): string {
  const sections: string[] = [];
  sections.push("# Identity");
  sections.push(input.identity);
  if (input.userProfile.trim()) sections.push(`# User profile\n${input.userProfile}`);
  if (input.vaultSnapshot.trim()) sections.push(`# Vault snapshot\n${input.vaultSnapshot}`);
  if (input.workspaceState.trim()) sections.push(`# Workspace\n${input.workspaceState}`);
  if (input.pinnedContext.trim()) sections.push(`# Pinned context\n${input.pinnedContext}`);
  if (input.crossSessionMemory.trim()) sections.push(`# Earlier conversations\n${input.crossSessionMemory}`);
  sections.push(`# Approval mode\n${input.approvalMode === "yolo" ? "User has enabled YOLO mode. Write actions execute immediately but every action is undoable. Still confirm before destructive operations." : "User must approve every write action. Show the diff before requesting approval."}`);
  sections.push(`# Tools available\n${input.tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")}`);
  sections.push("# Rules\n- Cite [[note]] for every claim drawn from a note.\n- Prefer one search call followed by one or two read calls. Avoid redundant tool invocations.\n- When uncertain, ask a clarifying question rather than guessing.");
  return sections.join("\n\n");
}

export const NOTIENT_IDENTITY = `You are Notient — a second-brain companion living inside the user's Obsidian vault. You read, search, reason, and stage proposals. You never write to a note without explicit user approval (or, in YOLO mode, you write but every action is undoable). You speak in the user's voice when extending their notes; you stay neutral when summarizing or comparing across notes. You always ground claims in retrieved chunks.`;
```

Create `src/core/chat/prompts/summarize.ts` with a function `summarizePrompt(messages: ChatMessage[]): ChatMessage[]` returning a single-system + single-user pair: "Summarize the conversation so far, preserving key facts, decisions, and note paths referenced."

- [ ] **Step 2: Context manager**

Write `contextManager.test.ts` covering: composes 8 sections with all layers enabled, omits sections when their setting is false, summarizes oldest 50% of messages when budget exceeded, cross-session lookup returns top-K via `ConversationIndex.search`, pinned-note injection truncates to `pinnedNoteMaxTokens`.

Implement `src/core/chat/contextManager.ts`:

```typescript
import type { Database } from "../db/database";
import type { LLMProvider } from "../llm/provider";
import type { Conversation, ChatMessage } from "./types";
import type { ConversationIndex } from "./conversationIndex";
import { composeSystemPrompt, NOTIENT_IDENTITY } from "./prompts/system";
import { summarizePrompt } from "./prompts/summarize";

export interface ContextManagerOptions {
  db: Database;
  provider: LLMProvider;
  conversationIndex: ConversationIndex;
  embed: (text: string, signal: AbortSignal) => Promise<Float32Array | null>;
  contextSettings: () => {
    includeUserProfile: boolean;
    includeVaultSnapshot: boolean;
    includeWorkspaceState: boolean;
    includeCrossSessionMemory: boolean;
    crossSessionTopK: number;
    crossSessionSimThreshold: number;
    pinnedNoteMaxTokens: number;
    contextBudgetFraction: number;
    modelContextTokens: number;
  };
  workspace: {
    getActiveNotePath(): string | null;
    getOpenNotePaths(): string[];
    getRecentNotePaths(): string[];
    getRecentSearchQueries(): string[];
  };
  facade: { readNote(path: string): Promise<string> };
  voiceProfile: () => string;
  approvalMode: () => "safe" | "yolo";
  toolCatalog: () => { name: string; description: string }[];
  estimateTokens: (text: string) => number;
}

export class ContextManager {
  constructor(private readonly options: ContextManagerOptions) {}

  async compose(conversation: Conversation, latestUserMessage: ChatMessage, signal: AbortSignal): Promise<{ messages: ChatMessage[] }> {
    const settings = this.options.contextSettings();
    const userProfile = settings.includeUserProfile ? this.options.voiceProfile() : "";
    const vaultSnapshot = settings.includeVaultSnapshot ? this.buildVaultSnapshot() : "";
    const workspaceState = settings.includeWorkspaceState ? this.buildWorkspaceState() : "";
    const pinnedContext = await this.buildPinnedContext(conversation, settings.pinnedNoteMaxTokens);
    const crossSessionMemory = settings.includeCrossSessionMemory
      ? await this.buildCrossSessionMemory(latestUserMessage.content, conversation.id, settings.crossSessionTopK, settings.crossSessionSimThreshold, signal)
      : "";
    const systemPrompt = composeSystemPrompt({
      identity: NOTIENT_IDENTITY,
      userProfile,
      vaultSnapshot,
      workspaceState,
      pinnedContext,
      crossSessionMemory,
      approvalMode: this.options.approvalMode(),
      tools: this.options.toolCatalog(),
    });
    const history = await this.budgetedHistory(systemPrompt, conversation.messages.concat(latestUserMessage), signal);
    return {
      messages: [{ role: "system", content: systemPrompt, id: "system", createdAt: Date.now() }, ...history],
    };
  }

  private buildVaultSnapshot(): string {
    const noteCount = this.options.db.query<{ count: number }>("SELECT COUNT(*) as count FROM notes;")[0].count;
    const approvedEdges = this.options.db.query<{ count: number }>("SELECT COUNT(*) as count FROM graph_edges WHERE approved = 1;")[0].count;
    const pendingProposals = this.options.db.query<{ count: number }>("SELECT COUNT(*) as count FROM staging_edges WHERE decision IS NULL;")[0].count
      + this.options.db.query<{ count: number }>("SELECT COUNT(*) as count FROM staging_nodes WHERE decision IS NULL;")[0].count;
    return `${noteCount} notes · ${approvedEdges} approved edges · ${pendingProposals} pending proposals.`;
  }

  private buildWorkspaceState(): string {
    const lines: string[] = [];
    const active = this.options.workspace.getActiveNotePath();
    if (active) lines.push(`Active note: [[${active}]]`);
    const open = this.options.workspace.getOpenNotePaths().filter((p) => p !== active);
    if (open.length > 0) lines.push(`Open notes: ${open.map((p) => `[[${p}]]`).join(", ")}`);
    const recent = this.options.workspace.getRecentNotePaths().slice(0, 5);
    if (recent.length > 0) lines.push(`Recently viewed: ${recent.map((p) => `[[${p}]]`).join(", ")}`);
    const queries = this.options.workspace.getRecentSearchQueries().slice(0, 5);
    if (queries.length > 0) lines.push(`Recent searches: ${queries.map((q) => `"${q}"`).join(", ")}`);
    return lines.join("\n");
  }

  private async buildPinnedContext(conversation: Conversation, maxTokens: number): Promise<string> {
    if (conversation.pinnedContext.length === 0) return "";
    const blocks: string[] = [];
    for (const path of conversation.pinnedContext) {
      try {
        const body = await this.options.facade.readNote(path);
        blocks.push(`## [[${path}]]\n${this.elide(body, maxTokens)}`);
      } catch {
        // skip missing pinned notes
      }
    }
    return blocks.join("\n\n");
  }

  private elide(text: string, maxTokens: number): string {
    const estimated = this.options.estimateTokens(text);
    if (estimated <= maxTokens) return text;
    const ratio = maxTokens / estimated;
    const chars = Math.max(400, Math.floor(text.length * ratio));
    const head = text.slice(0, Math.floor(chars * 0.7));
    const tail = text.slice(text.length - Math.floor(chars * 0.3));
    return `${head}\n[…${estimated - maxTokens} tokens elided…]\n${tail}`;
  }

  private async buildCrossSessionMemory(query: string, currentConversationId: string, k: number, threshold: number, signal: AbortSignal): Promise<string> {
    const embedding = await this.options.embed(query, signal);
    if (!embedding) return "";
    const matches = this.options.conversationIndex.search(embedding, k, threshold).filter((entry) => entry.id !== currentConversationId);
    if (matches.length === 0) return "";
    return matches.map((entry) => `- "${entry.topic}" — see [[${entry.path}]]`).join("\n");
  }

  private async budgetedHistory(systemPrompt: string, history: ChatMessage[], signal: AbortSignal): Promise<ChatMessage[]> {
    const settings = this.options.contextSettings();
    const budget = Math.floor(settings.modelContextTokens * settings.contextBudgetFraction);
    let used = this.options.estimateTokens(systemPrompt);
    for (const msg of history) used += this.options.estimateTokens(msg.content);
    if (used <= budget || history.length <= 4) return history;
    const cutoff = Math.floor(history.length / 2);
    const oldest = history.slice(0, cutoff);
    const newest = history.slice(cutoff);
    const summary = await this.options.provider.chatJson<{ summary: string }>({
      model: "summarize-fast",
      messages: summarizePrompt(oldest),
      signal,
    }).catch(() => ({ summary: "(summary unavailable)" }));
    return [
      {
        id: "summary",
        role: "system",
        content: `Earlier in this conversation: ${summary.summary}`,
        createdAt: Date.now(),
      },
      ...newest,
    ];
  }
}
```

- [ ] **Step 3: Agent loop**

Write `agentLoop.test.ts` covering: terminates on text-only assistant response, executes a tool call and resumes loop, hits round cap and emits final apology, abort during a tool call propagates, write-gated tool reroutes through approval gate.

Implement `src/core/chat/agentLoop.ts`:

```typescript
import type { LLMProvider, ToolSpec } from "../llm/provider";
import type { ApprovalGate } from "./approvalGate";
import type { ToolRegistry } from "./tools/registry";
import type { ChatMessage, Conversation, ToolCall, ToolResult } from "./types";

export interface AgentLoopOptions {
  provider: LLMProvider;
  toolRegistry: ToolRegistry;
  approvalGate: ApprovalGate;
  maxRoundsPerTurn: number;
  toolMode: () => "native" | "json-fallback" | "disabled";
  recordHistoryAutoApprove: (call: ToolCall) => Promise<void>;
}

export type AgentLoopEvent =
  | { type: "loop:assistant-token"; delta: string }
  | { type: "loop:reasoning-token"; delta: string }
  | { type: "loop:tool-call"; call: ToolCall }
  | { type: "loop:tool-result"; result: ToolResult }
  | { type: "loop:approval-pending"; call: ToolCall }
  | { type: "loop:done"; finalMessage: ChatMessage }
  | { type: "loop:error"; message: string };

export async function* runAgentTurn(
  options: AgentLoopOptions,
  conversation: Conversation,
  systemAndHistory: ChatMessage[],
  model: string,
  signal: AbortSignal,
): AsyncGenerator<AgentLoopEvent> {
  const tools = options.toolRegistry.exportToolsForOpenAI() as ToolSpec[];
  const messages: ChatMessage[] = [...systemAndHistory];
  for (let round = 0; round < options.maxRoundsPerTurn; round++) {
    if (options.toolMode() === "disabled") {
      // fallback path (text-only)
    }
    const handle = await options.provider.chatWithTools({ model, messages, tools, signal });
    let contentBuf = "";
    let reasoningBuf = "";
    for await (const event of handle.events) {
      if (event.contentDelta) {
        contentBuf += event.contentDelta;
        yield { type: "loop:assistant-token", delta: event.contentDelta };
      }
      if (event.reasoningDelta) {
        reasoningBuf += event.reasoningDelta;
        yield { type: "loop:reasoning-token", delta: event.reasoningDelta };
      }
    }
    const result = await handle.result();
    if (result.toolCalls.length === 0) {
      yield {
        type: "loop:done",
        finalMessage: {
          id: cryptoRandomId(),
          role: "assistant",
          content: contentBuf,
          reasoningContent: reasoningBuf,
          createdAt: Date.now(),
        },
      };
      return;
    }
    const toolResults: ToolResult[] = [];
    for (const call of result.toolCalls) {
      yield { type: "loop:tool-call", call };
      try {
        if (options.toolRegistry.isWriteGated(call.name)) {
          yield { type: "loop:approval-pending", call };
          const decision = await options.approvalGate.request(call, conversation.approvalMode, JSON.stringify(call.args), signal);
          if (!decision.approved) {
            const failed: ToolResult = { callId: call.id, status: "error", error: decision.reason ?? "rejected", durationMs: 0 };
            toolResults.push(failed);
            yield { type: "loop:tool-result", result: failed };
            continue;
          }
        }
        const start = Date.now();
        const data = await options.toolRegistry.invoke(call.name, call.args, signal);
        const ok: ToolResult = { callId: call.id, status: "ok", data, durationMs: Date.now() - start };
        toolResults.push(ok);
        yield { type: "loop:tool-result", result: ok };
      } catch (error) {
        const fail: ToolResult = { callId: call.id, status: "error", error: error instanceof Error ? error.message : String(error), durationMs: 0 };
        toolResults.push(fail);
        yield { type: "loop:tool-result", result: fail };
      }
    }
    messages.push({
      id: cryptoRandomId(),
      role: "assistant",
      content: contentBuf,
      toolCalls: result.toolCalls,
      toolResults,
      reasoningContent: reasoningBuf,
      createdAt: Date.now(),
    });
    for (const tr of toolResults) {
      messages.push({
        id: cryptoRandomId(),
        role: "tool",
        content: tr.status === "ok" ? JSON.stringify(tr.data) : `error: ${tr.error}`,
        createdAt: Date.now(),
      });
    }
  }
  yield {
    type: "loop:done",
    finalMessage: {
      id: cryptoRandomId(),
      role: "assistant",
      content: "I've used all available tool rounds — let me know what to try next.",
      createdAt: Date.now(),
    },
  };
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 4: Chat service**

Write `chatService.test.ts` covering: `startConversation` writes a fresh markdown file, `sendMessage` runs the loop and persists, `abort` cancels the in-flight turn via the mutex, `listConversations` delegates to the store, cross-session memory is injected when the user message embedding finds related history.

Implement `src/core/chat/chatService.ts` as the orchestrating facade. Each turn wraps the loop in `mutex.runPriority("chat", async (signal) => { for await event of runAgentTurn(...) emit; await store.save(updatedConversation); await conversationIndex.record(updatedConversation); })`. After every turn, regenerate `summary` + `summary_embedding` (call `provider.chatJson` for summary + `embed(summary)` for vector) and persist via `conversationIndex.record`.

- [ ] **Step 5: Verify**

Run: `bun run typecheck && bun run lint && bun test`

Expected: 4 contextManager + 5 agentLoop + 4 chatService tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/chat/contextManager.ts src/core/chat/contextManager.test.ts src/core/chat/agentLoop.ts src/core/chat/agentLoop.test.ts src/core/chat/chatService.ts src/core/chat/chatService.test.ts src/core/chat/prompts/system.ts src/core/chat/prompts/summarize.ts
git commit -m "feat(chat): agent loop + 8-layer context manager + cross-session memory"
```



## Task 14: ChatTab UI + streaming + reasoning render + native command palette wiring

**Files:**
- Modify: `src/ui/sidebar/components/ChatTab.tsx` (replace stub)
- Create: `src/ui/sidebar/components/MessageBubble.tsx`
- Create: `src/ui/sidebar/components/ToolCallCard.tsx`
- Create: `src/ui/sidebar/components/ApprovalCard.tsx`
- Create: `src/ui/sidebar/components/CitationLink.tsx`
- Create: `src/ui/sidebar/components/ConversationsDrawer.tsx`
- Create: `src/ui/sidebar/components/ContextChip.tsx`
- Create: `src/ui/sidebar/components/ReasoningBlock.tsx`
- Create: `src/ui/sidebar/chat-state.ts`
- Modify: `styles.css` (extend with `.notient-chat-*`)

**Why:** Per Q6 the Chat surface is the flagship UX. The tab renders streaming assistant tokens, inline ToolCallCards (collapsible), inline ApprovalCards for write-gated tools (markdown diff preview in safe mode, "auto-approved · undo" pill in yolo mode), clickable wikilink citations, an inline reasoning block (collapsible), a conversations drawer with date-grouped history, and a pinned-context chip near the input. Hover preview on `[[wikilinks]]`. Cmd+Enter to send. Esc to abort.

- [ ] **Step 1: Chat tab signals**

Create `src/ui/sidebar/chat-state.ts`:

```typescript
import { signal } from "@preact/signals";
import type { ChatMessage, Conversation, PendingApproval } from "../../core/chat/types";

export const activeConversation = signal<Conversation | null>(null);
export const conversationsList = signal<Conversation[]>([]);
export const draftInput = signal<string>("");
export const turnInFlight = signal<boolean>(false);
export const liveAssistantBuffer = signal<string>("");
export const liveReasoningBuffer = signal<string>("");
export const pendingApprovals = signal<PendingApproval[]>([]);
export const drawerOpen = signal<boolean>(false);
export const contextUsage = signal<{ used: number; budget: number }>({ used: 0, budget: 32000 });

export interface ChatActions {
  newConversation: () => Promise<void>;
  loadConversation: (notePath: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  abort: () => void;
  pinNote: (path: string) => void;
  unpinNote: (path: string) => void;
  resolveApproval: (callId: string, approved: boolean, reason?: string) => void;
  toggleYolo: () => Promise<void>;
}

export const chatActions = signal<ChatActions | null>(null);
```

- [ ] **Step 2: Component skeletons**

`MessageBubble.tsx` — renders a `ChatMessage`. User: right-aligned. Assistant: left-aligned. Renders `content` through a tiny markdown subset (paragraphs + bullets + inline `[[wikilinks]]` via `CitationLink`); tool calls inline via `ToolCallCard`; reasoning via `ReasoningBlock` when present.

`ToolCallCard.tsx` — collapsible. Header: tool name + duration + status icon. Expanded: pretty-printed args + result (or error). Click toggles expand state in a local `useState`/signal.

`ApprovalCard.tsx` — renders a `PendingApproval`. Shows tool name + a markdown diff (the `preview` string is a unified diff for write tools). "Approve" / "Reject" / "Approve with edit" buttons. Reject offers a free-text reason. In yolo mode, this component is rendered *post-execution* with a "● auto-approved · undo" pill that fires `historyService.undo(historyId)`.

`CitationLink.tsx` — wraps `[[X]]` in a clickable element that calls `workspace.openLinkText("X", "")`. On hover, fetches first 200 chars and shows a tooltip popover.

`ConversationsDrawer.tsx` — overlay panel. Lists `conversationsList.value` grouped by date. Click item → `chatActions.value.loadConversation(notePath)`. "New chat" button at top.

`ContextChip.tsx` — small chip near input showing `Context: [[ActiveNote]]` with a ✕ to unpin. Empty state: "Pin a note for context."

`ReasoningBlock.tsx` — collapsible "Thinking…" disclosure. Hidden by default unless `chat.persistReasoning` is true. Streams `liveReasoningBuffer` while turn is in flight.

- [ ] **Step 3: ChatTab implementation**

Replace `src/ui/sidebar/components/ChatTab.tsx`:

```typescript
import { useEffect } from "preact/hooks";
import {
  activeConversation,
  chatActions,
  conversationsList,
  contextUsage,
  draftInput,
  drawerOpen,
  liveAssistantBuffer,
  liveReasoningBuffer,
  pendingApprovals,
  turnInFlight,
} from "../chat-state";
import { MessageBubble } from "./MessageBubble";
import { ApprovalCard } from "./ApprovalCard";
import { ConversationsDrawer } from "./ConversationsDrawer";
import { ContextChip } from "./ContextChip";

export function ChatTab() {
  const conversation = activeConversation.value;
  const actions = chatActions.value;
  const inFlight = turnInFlight.value;
  const usage = contextUsage.value;

  useEffect(() => {
    void conversationsList;
  }, []);

  if (!conversation) {
    return (
      <section class="notient-tab-body notient-tab-body--chat">
        <div class="notient-chat-empty">
          <h3>Talk to your second brain</h3>
          <p>Try: "What notes contradict my view on X?"</p>
          <button type="button" class="notient-btn" onClick={() => actions?.newConversation()}>
            Start new conversation
          </button>
        </div>
      </section>
    );
  }

  const handleKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      const text = draftInput.value.trim();
      if (text.length > 0 && !inFlight) {
        draftInput.value = "";
        void actions?.sendMessage(text);
      }
    }
    if (event.key === "Escape" && inFlight) {
      event.preventDefault();
      actions?.abort();
    }
  };

  return (
    <section class="notient-tab-body notient-tab-body--chat">
      <header class="notient-chat-header">
        <button type="button" class="notient-icon-btn" onClick={() => (drawerOpen.value = !drawerOpen.value)} aria-label="Conversations">≡</button>
        <h3 class="notient-chat-title">{conversation.topic}</h3>
        <span class="notient-chat-context-usage">{Math.round((usage.used / usage.budget) * 100)}%</span>
        <button type="button" class="notient-icon-btn" onClick={() => actions?.newConversation()} aria-label="New chat">+</button>
      </header>
      {drawerOpen.value ? <ConversationsDrawer /> : null}
      <ContextChip />
      <main class="notient-chat-messages">
        {conversation.messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {inFlight && liveAssistantBuffer.value.length > 0 ? (
          <article class="notient-message notient-message--assistant notient-message--live">
            <div class="notient-message__content">{liveAssistantBuffer.value}</div>
          </article>
        ) : null}
        {inFlight && liveReasoningBuffer.value.length > 0 ? (
          <details class="notient-reasoning">
            <summary>Thinking…</summary>
            <pre>{liveReasoningBuffer.value}</pre>
          </details>
        ) : null}
        {pendingApprovals.value.map((pending) => (
          <ApprovalCard key={pending.callId} pending={pending} />
        ))}
      </main>
      <footer class="notient-chat-input">
        <textarea
          class="notient-chat-textarea"
          value={draftInput.value}
          placeholder={inFlight ? "Notient is thinking… Esc to abort" : "Ask about your vault — Cmd+Enter to send"}
          onInput={(e) => (draftInput.value = (e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKey}
          disabled={inFlight}
        />
        <button
          type="button"
          class="notient-btn"
          disabled={inFlight || draftInput.value.trim().length === 0}
          onClick={() => {
            const text = draftInput.value.trim();
            draftInput.value = "";
            void actions?.sendMessage(text);
          }}
        >
          Send
        </button>
        {inFlight ? (
          <button type="button" class="notient-btn notient-btn--secondary" onClick={() => actions?.abort()}>
            Abort
          </button>
        ) : null}
      </footer>
    </section>
  );
}
```

- [ ] **Step 4: Verify**

Run: `bun run typecheck && bun run lint && bun test`

Expected: existing tests stay green; chat-tab smoke render test passes (one minimal `preact-render-to-string` test that asserts the empty state and the populated-conversation state both render without throwing).

- [ ] **Step 5: Commit**

```bash
git add src/ui/sidebar/chat-state.ts src/ui/sidebar/components/ChatTab.tsx src/ui/sidebar/components/MessageBubble.tsx src/ui/sidebar/components/ToolCallCard.tsx src/ui/sidebar/components/ApprovalCard.tsx src/ui/sidebar/components/CitationLink.tsx src/ui/sidebar/components/ConversationsDrawer.tsx src/ui/sidebar/components/ContextChip.tsx src/ui/sidebar/components/ReasoningBlock.tsx styles.css
git commit -m "feat(chat): ChatTab UI with streaming, citations, conversations drawer"
```



## Task 15: Universal undo (history producers + kind-keyed inverters + undo command + history modal)

**Files:**
- Create: `src/core/history/types.ts`
- Create: `src/core/history/historyService.ts`
- Create: `src/core/history/historyService.test.ts`
- Create: `src/core/history/inverters/edgeApprove.ts`
- Create: `src/core/history/inverters/edgeReject.ts`
- Create: `src/core/history/inverters/nodeApprove.ts`
- Create: `src/core/history/inverters/nodeReject.ts`
- Create: `src/core/history/inverters/noteAppendSection.ts`
- Create: `src/core/history/inverters/noteFrontmatter.ts`
- Create: `src/core/history/inverters/noteCreate.ts`
- Create: `src/core/history/inverters/noteMaturity.ts`
- Create: `src/core/history/inverters.test.ts`
- Create: `src/ui/history/HistoryModal.ts`
- Modify: producers across `approvalService.ts`, `nativeGraphBridge.ts`, `maturityAdvancer.ts`, chat write tools (`tools/notes.ts`)

**Why:** The schema_v1 `history` table has been waiting for Phase 4. Per Q8 every Notient mutation lands a row keyed by `kind` (e.g., `edge.approve`, `note.append_section`, `note.frontmatter`, `note.create`, `note.maturity`) with `before/after` JSON. `historyService.undo(historyId)` looks up the row, dispatches to the registered inverter for that kind, executes the inverse mutation (deleting an edge, restoring a frontmatter blob, deleting a created note, etc.), and hard-deletes the row when successful. Native command palette command `notient-undo-last` is the primary user-facing surface; chat's yolo "auto-approved · undo" pill calls the same path; a small history modal lists the last 50 actions for power users.

- [ ] **Step 1: Types**

Create `src/core/history/types.ts`:

```typescript
export type HistoryKind =
  | "edge.approve"
  | "edge.reject"
  | "node.approve"
  | "node.reject"
  | "note.append_section"
  | "note.frontmatter"
  | "note.create"
  | "note.maturity";

export interface HistoryRow {
  id: number;
  kind: HistoryKind;
  target: string;
  before: unknown | null;
  after: unknown | null;
  createdAt: number;
}

export interface RecordHistoryInput {
  kind: HistoryKind;
  target: string;
  before: unknown | null;
  after: unknown | null;
}
```

- [ ] **Step 2: History service**

Write `historyService.test.ts` covering: record inserts a row with JSON-serialized before/after, `getRecent` returns rows desc by created_at, `undo` dispatches to the correct inverter, retention prunes oldest rows down to global + per-target caps.

Implement `src/core/history/historyService.ts`:

```typescript
import type { Database } from "../db/database";
import type { HistoryKind, HistoryRow, RecordHistoryInput } from "./types";

export type Inverter = (target: string, before: unknown, after: unknown) => Promise<void>;

export interface HistoryServiceOptions {
  db: Database;
  inverters: Partial<Record<HistoryKind, Inverter>>;
  retention: { max: number; maxPerTarget: number };
  now: () => number;
}

export class HistoryService {
  constructor(private readonly options: HistoryServiceOptions) {}

  async record(input: RecordHistoryInput): Promise<number> {
    const beforeJson = input.before === null ? null : JSON.stringify(input.before);
    const afterJson = input.after === null ? null : JSON.stringify(input.after);
    this.options.db.run(
      "INSERT INTO history (kind, target, before, after, created_at) VALUES (?,?,?,?,?);",
      [input.kind, input.target, beforeJson, afterJson, this.options.now()],
    );
    const idRow = this.options.db.query<{ id: number }>("SELECT last_insert_rowid() AS id;")[0];
    await this.options.db.persist();
    return idRow.id;
  }

  getRecent(limit = 50): HistoryRow[] {
    const rows = this.options.db.query<{
      id: number;
      kind: string;
      target: string;
      before: string | null;
      after: string | null;
      created_at: number;
    }>("SELECT id, kind, target, before, after, created_at FROM history ORDER BY id DESC LIMIT ?;", [limit]);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as HistoryKind,
      target: r.target,
      before: r.before ? JSON.parse(r.before) : null,
      after: r.after ? JSON.parse(r.after) : null,
      createdAt: r.created_at,
    }));
  }

  async undo(historyId: number): Promise<{ ok: boolean; error?: string }> {
    const rows = this.getRecent(1000).filter((r) => r.id === historyId);
    if (rows.length === 0) return { ok: false, error: "history row not found" };
    const row = rows[0];
    const inverter = this.options.inverters[row.kind];
    if (!inverter) return { ok: false, error: `no inverter for ${row.kind}` };
    try {
      await inverter(row.target, row.before, row.after);
      this.options.db.run("DELETE FROM history WHERE id = ?;", [historyId]);
      await this.options.db.persist();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async undoLast(): Promise<{ ok: boolean; error?: string }> {
    const recent = this.getRecent(1);
    if (recent.length === 0) return { ok: false, error: "no history" };
    return this.undo(recent[0].id);
  }

  async prune(): Promise<void> {
    this.options.db.run(
      `DELETE FROM history WHERE id IN (
        SELECT id FROM history ORDER BY id DESC LIMIT -1 OFFSET ?
      );`,
      [this.options.retention.max],
    );
    this.options.db.run(
      `DELETE FROM history WHERE id IN (
        SELECT id FROM history h1
        WHERE id IN (
          SELECT id FROM history h2
          WHERE h2.target = h1.target
          ORDER BY id DESC LIMIT -1 OFFSET ?
        )
      );`,
      [this.options.retention.maxPerTarget],
    );
    await this.options.db.persist();
  }
}
```

- [ ] **Step 3: Inverters**

Implement each inverter as a small module exporting one function. Each takes the dependencies it needs as a closure and returns an `Inverter`.

`inverters/edgeApprove.ts`: deletes the live `graph_edges` row whose `id` matches the post-approval id, restores the `staging_edges` row from `before`. Calls `nativeGraphBridge.removeApprovedLink` (a new method that mirrors `applyApprovedLink` but removes the wikilink) to undo the writeback.

`inverters/edgeReject.ts`: re-inserts the `staging_edges` row from `before`.

`inverters/nodeApprove.ts`: mirrors edgeApprove for staged nodes; if the approval created a note (Synthesizer's "promote as note" path), the inverter also deletes the created note via `facade.delete` (EchoGuard.mark first).

`inverters/nodeReject.ts`: re-inserts the `staging_nodes` row.

`inverters/noteAppendSection.ts`: restores the note body to `before` via `facade.writeNote` after EchoGuard.mark.

`inverters/noteFrontmatter.ts`: restores the frontmatter to `before` via `facade.updateFrontmatter`.

`inverters/noteCreate.ts`: deletes the created note (`facade.delete`).

`inverters/noteMaturity.ts`: restores the `maturity` column AND the body sha (Phase 3 MaturityAdvancer writes both); EchoGuard.mark before the body write.

Test all eight in `inverters.test.ts` with one fixture each: produce → invert → verify state matches the original.

- [ ] **Step 4: Wire producers**

Update each mutation site to call `historyService.record(...)` after success. Touch points:

- `src/core/approvals/approvalService.ts`: `acceptEdge` records `kind: "edge.approve"` with `before = stagingRow`, `after = liveRow`. `rejectEdge` records `kind: "edge.reject"` with `before = stagingRow`. Same for `acceptNode` / `rejectNode` (these methods may need to exist if Phase 3 hasn't shipped them; otherwise add them in this step).
- `src/core/graph/nativeGraphBridge.ts`: `applyApprovedLink` records `kind: "note.append_section"` with `before = previousBody`, `after = nextBody`. `applyApprovedRelation` records `kind: "note.frontmatter"` with `before = previousFrontmatter`, `after = nextFrontmatter`.
- `src/core/agents/maturityAdvancer.ts`: when promoting a note to a higher maturity, record `kind: "note.maturity"` with `before = { maturity, sha }`, `after = { maturity, sha }`.
- `src/core/chat/tools/notes.ts`: `note.append_section` and `note.create` record after successful execution; in yolo mode the `recordHistoryAutoApprove` callback chains into `historyService.record`.

Each producer takes the `historyService` as a constructor dependency added in this step (and wired in Task 16's `main.ts`).

- [ ] **Step 5: Native command palette wiring (preview — full wiring lands in Task 16)**

Skeleton for the undo command — the implementer adds it in `main.ts` Task 16:

```typescript
this.addCommand({
  id: "notient-undo-last",
  name: "Notient: Undo last action",
  callback: async () => {
    const result = await historyService.undoLast();
    new Notice(result.ok ? "Undid last Notient action" : `Undo failed: ${result.error}`);
  },
});
```

- [ ] **Step 6: History modal**

Create `src/ui/history/HistoryModal.ts` extending Obsidian's `Modal`. Renders the last 50 history rows in a list with timestamp + kind + target + Undo button. Refreshes after each undo. Power-user surface — opened by `notient-history-show` command (registered in Task 16).

- [ ] **Step 7: Verify**

Run: `bun run typecheck && bun run lint && bun test`

Expected: 4 historyService tests + 8 inverter roundtrip tests pass; producers' existing tests continue to pass after the new `historyService.record` call (mock the service in tests that don't need real persistence).

- [ ] **Step 8: Commit**

```bash
git add src/core/history src/core/approvals/approvalService.ts src/core/graph/nativeGraphBridge.ts src/core/agents/maturityAdvancer.ts src/core/chat/tools/notes.ts src/ui/history
git commit -m "feat(history): universal undo with kind-keyed inverters across all Notient mutations"
```



## Task 16: Wiring + smoke harness + Phase 4 close-out

**Files:**
- Modify: `src/main.ts` (full Phase 4 wiring)
- Modify: `src/core/kernel.ts` (add Phase 4 service keys)
- Create: `scripts/smoke-phase4.ts`
- Modify: `package.json` (add `smoke:phase4` script)
- Update: `.planning/STATE.md` (**local-only** — `.planning/` is gitignored; the file is rewritten for the next session's context but is **not** included in any commit)

**Why:** This task wires every Phase 4 service into the plugin lifecycle, registers the SearchView, registers the new commands and ribbon icons, plumbs the chat / search / undo actions to their UI surfaces, and ships a smoke harness that drives one happy-path of every Phase 4 surface against a live LM Studio. Closes the phase with an updated STATE.md and no git tag (tags are reserved for v1.0).

- [ ] **Step 1: Extend the kernel**

In `src/core/kernel.ts`, add typed service keys and registration helpers for:

```text
streamService            : StreamService
vitalsService            : VitalsService
nativeGraphBridge        : NativeGraphBridge
canvasGenerator          : { synthesis: CanvasGenerator; results: CanvasFromResults }
searchPipeline           : SearchPipeline
savedQueries             : SavedQueries
searchHistory            : SearchHistory
conversationStore        : ConversationStore
conversationIndex        : ConversationIndex
toolRegistry             : ToolRegistry
approvalGate             : ApprovalGate
contextManager           : ContextManager
chatService              : ChatService
historyService           : HistoryService
vaultBootstrap           : VaultBootstrap
```

Each key is registered before `kernel.seal()`. Existing Phase 1–3 keys stay unchanged.

- [ ] **Step 2: Wire `main.ts`**

Extend the `onload()` flow in `src/main.ts` (before `health.start()` / `coordinator.start()`):

```typescript
// (1) Settings + bootstrap
const settings = await settingsService.load();
const facade = new ObsidianFacade(this.app);
await new VaultBootstrap({ facade }).run({
  conversationsFolder: settings.chat.conversationsFolder,
  proposalsFolder: settings.chat.proposalsFolder,
  savedQueriesFolder: settings.search.savedQueriesFolder,
});

// (2) Indexer exclude paths
const excludePatterns = normalizeExcludePatterns(settings.indexer.excludePaths);
indexerQueue.setPathFilter((path) => !isExcluded(path, excludePatterns));

// (3) History service first (other services depend on it)
const historyService = new HistoryService({
  db,
  inverters: makeInverters({ facade, echoGuard, db, bridge: nativeGraphBridge, hash }),
  retention: { max: settings.history.retentionMaxRows, maxPerTarget: settings.history.retentionMaxRowsPerTarget },
  now: () => Date.now(),
});
await historyService.prune();

// (4) Native graph bridge + canvas
const nativeGraphBridge = new NativeGraphBridge({
  facade,
  echoGuard,
  hash,
  settings: () => settings.nativeGraph,
});

// (5) Stream + Vitals
const streamService = new StreamService({
  db,
  bus,
  now: () => Date.now(),
  getActivePath: () => this.app.workspace.getActiveFile()?.path ?? null,
  settings: () => settings.stream,
});
streamService.start();
const vitalsService = new VitalsService({
  db,
  now: () => Date.now(),
  settings: () => settings.vitals,
  facade,
});

// (6) Search pipeline
const reranker = new Reranker({ provider: primaryProvider, model: settings.primary.rerankerModel });
const searchPipeline = new SearchPipeline({
  db,
  provider: primaryProvider,
  vectorIndex,
  embed: (text, signal) => embedder.embed(text, signal),
  reranker,
  reasoningModel: settings.primary.reasoningModel,
  settings: () => ({ balanced: settings.search.balanced, deep: settings.search.deep }),
  now: () => Date.now(),
});

// (7) Tool registry + chat
const toolRegistry = new ToolRegistry();
registerReadOnlyTools(toolRegistry, { db, searchPipeline, vitalsService, agents, provider: primaryProvider });
registerWriteGatedTools(toolRegistry, { facade, echoGuard, hash, approvalGate, historyService, db, bridge: nativeGraphBridge });
const conversationStore = new ConversationStore({ facade, folder: settings.chat.conversationsFolder, now: () => Date.now() });
const conversationIndex = new ConversationIndex({ facade, indexPath: "Notient/.index.json" });
await conversationIndex.load();
const contextManager = new ContextManager({ /* deps from Task 13 */ });
const chatService = new ChatService({ /* deps from Task 13 */ });

// (8) Bind UI signals
streamService.items.subscribe((items) => (streamItemsState.value = items));
sidebarActions.value = {
  openCoAuthor: () => void openInRightLeaf(VIEW_TYPE_NOTIENT_CO_AUTHOR),
  openApprovals: () => void openInRightLeaf(VIEW_TYPE_NOTIENT_APPROVALS),
  openAwaken: () => void openInRightLeaf(VIEW_TYPE_NOTIENT_AWAKEN),
  openSearch: () => void this.app.workspace.getLeaf(true).setViewState({ type: VIEW_TYPE_NOTIENT_SEARCH }),
};
chatActions.value = chatActionsFor({ chatService, conversationStore, conversationIndex });
searchActions.value = searchActionsFor({ searchPipeline, savedQueries, searchHistory, canvasFromResults });
streamActions.value = streamActionsFor({ approvalService, workspace: this.app.workspace });
vitalsActions.value = { deepen: (path) => bus.emit({ type: "user:action", kind: "deepen", notePath: path }) };

// (9) Active note → vitals snapshot
this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
  const path = this.app.workspace.getActiveFile()?.path ?? null;
  vitalsSnapshotState.value = path ? vitalsService.computeSnapshot(path) : null;
}));

// (10) Persist vitals on save
bus.on("vault:note-saved", (e) => void vitalsService.persistSnapshot(e.path));

// (11) Editor decorations
this.registerEditorExtension(makeInsightsPlugin({
  getProposals: (notePath) => streamService.items.value
    .filter((item) => item.notePaths.includes(notePath))
    .flatMap((item) => item.evidenceChunkIds.map((id) => {
      const chunk = db.query<{ text: string }>("SELECT text FROM chunks WHERE id = ?;", [id])[0];
      return chunk ? { id: item.id, agent: item.agent, rationale: item.rationale ?? "", score: item.score, chunkText: chunk.text } : null;
    }).filter((p): p is NonNullable<typeof p> => p !== null)),
  getActivePath: () => this.app.workspace.getActiveFile()?.path ?? null,
  getMaxPerViewport: () => settings.decorations.maxPerViewport,
  getDebounceMs: () => settings.decorations.debounceMs,
  onClick: (proposalId) => {
    setActiveTab("stream");
    streamFocusState.value = proposalId;
  },
  isModeAllowed: () => {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return false;
    const mode = view.getMode();
    return mode === "source" || mode === "live-preview" || mode === "live";
  },
}));

// (12) Register SearchView
this.registerView(VIEW_TYPE_NOTIENT_SEARCH, (leaf) => new SearchView(leaf));

// (13) Commands
this.addCommand({ id: "notient-search-quick", name: "Notient: Search (Quick)", callback: () => openSearchWithMode("quick") });
this.addCommand({ id: "notient-search-balanced", name: "Notient: Search (Balanced)", callback: () => openSearchWithMode("balanced") });
this.addCommand({ id: "notient-search-deep", name: "Notient: Search (Deep)", callback: () => openSearchWithMode("deep") });
this.addCommand({ id: "notient-search-here", name: "Notient: Search related to selection", editorCallback: (editor) => openSearchWithMode("balanced", editor.getSelection()) });
this.addCommand({ id: "notient-chat-new", name: "Notient: New chat", callback: () => void chatService.newConversation({ pinnedContext: [] }) });
this.addCommand({ id: "notient-chat-active-note", name: "Notient: Chat about this note", checkCallback: (checking) => {
  const path = this.app.workspace.getActiveFile()?.path ?? null;
  if (checking) return path !== null;
  if (path) void chatService.newConversation({ pinnedContext: [path] });
  return true;
} });
this.addCommand({ id: "notient-chat-resume-last", name: "Notient: Resume last chat", callback: () => void chatService.resumeLast() });
this.addCommand({ id: "notient-undo-last", name: "Notient: Undo last action", callback: async () => {
  const result = await historyService.undoLast();
  new Notice(result.ok ? "Undid last Notient action" : `Undo failed: ${result.error}`);
} });
this.addCommand({ id: "notient-history-show", name: "Notient: Show action history", callback: () => new HistoryModal(this.app, historyService).open() });

// (14) Ribbon icons
this.addRibbonIcon("search", "Notient: Search", () => sidebarActions.value?.openSearch());
this.addRibbonIcon("messages-square", "Notient: New chat", () => void chatService.newConversation({ pinnedContext: [] }));

// (15) Editor right-click menu
this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
  const selection = editor.getSelection();
  if (selection.length === 0) return;
  menu.addItem((item) => item.setTitle("Ask Notient about this selection").setIcon("messages-square").onClick(() => {
    void chatService.newConversation({ pinnedContext: [], seedUserMessage: selection });
  }));
  menu.addItem((item) => item.setTitle("Search related notes").setIcon("search").onClick(() => openSearchWithMode("balanced", selection)));
}));
```

In `onunload()`, stop the new services in dependency order:

```typescript
try { streamService.stop(); } catch { /* ignore */ }
try { chatService.dispose(); } catch { /* ignore */ }
```

- [ ] **Step 3: Smoke harness**

Create `scripts/smoke-phase4.ts`. Drives one happy-path through every surface against the live test vault + dynamo:

```typescript
#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
// Imports for: Database, EventBus, LMStudioProvider, all Phase 4 services + agents.

const VAULT = "/mnt/c/Users/akougk/Projects/vaultex";
const PLUGIN_DIR = `${VAULT}/.obsidian/plugins/notient`;

async function main() {
  const harness = await buildHarness({ vault: VAULT, pluginDir: PLUGIN_DIR });
  const tally = { stream: 0, decorations: 0, vitals: false, bridge: false, canvas: false, search: false, chat: false, undo: false };

  // 1. Coordinator → produce at least one staging row.
  await harness.coordinator.runOnceForSmoke();

  // 2. Stream
  harness.streamService.refresh();
  tally.stream = harness.streamService.items.value.length;

  // 3. Decorations: count proposals that map to a paragraph in the most-recently-saved note.
  const recent = harness.db.query<{ path: string }>("SELECT path FROM notes ORDER BY updated_at DESC LIMIT 1;")[0]?.path;
  if (recent) {
    const body = await harness.facade.readNote(recent);
    tally.decorations = countParagraphHits(body, harness.streamService.items.value);
  }

  // 4. Vitals
  if (recent) {
    const snapshot = harness.vitalsService.computeSnapshot(recent);
    tally.vitals = snapshot !== null;
  }

  // 5. Bridge: approve one staged LINKS_TO edge
  const edge = harness.db.query<{ id: string; type: string }>("SELECT id, type FROM staging_edges WHERE decision IS NULL AND type = 'links_to' LIMIT 1;")[0];
  if (edge) {
    await harness.approvalService.acceptEdge(edge.id);
    tally.bridge = true;
  }

  // 6. Canvas: generate a synthesis preview
  const synthesisCanvas = generateSynthesisCanvas({ synthesisTitle: "Smoke", synthesisBody: "smoke", sourceNotePaths: [recent ?? ""] });
  await writeFile(`${VAULT}/Notient/proposals/smoke.canvas`, JSON.stringify(synthesisCanvas));
  tally.canvas = true;

  // 7. Search Balanced
  for await (const event of harness.searchPipeline.run({ query: "knowledge", mode: "balanced", limit: 5 }, AbortSignal.timeout(30_000))) {
    if (event.type === "search:done") tally.search = event.result.hits.length > 0;
  }

  // 8. Chat: round-trip a single user→assistant turn
  const conversation = await harness.chatService.newConversation({ pinnedContext: recent ? [recent] : [] });
  const turn = harness.chatService.sendMessage(conversation.id, "Summarize this note in one sentence.");
  for await (const event of turn) {
    if (event.type === "loop:done") tally.chat = true;
  }

  // 9. Undo: reverse the bridge approval
  if (tally.bridge) {
    const result = await harness.historyService.undoLast();
    tally.undo = result.ok;
  }

  console.log(
    `[smoke] phase4: stream=${tally.stream} decorations=${tally.decorations} vitals=${tally.vitals ? "ok" : "fail"} bridge=${tally.bridge ? "ok" : "fail"} canvas=${tally.canvas ? "ok" : "fail"} search=${tally.search ? "ok" : "fail"} chat=${tally.chat ? "ok" : "fail"} undo=${tally.undo ? "ok" : "fail"}`,
  );

  const ok = tally.stream > 0 && tally.vitals && tally.bridge && tally.canvas && tally.search && tally.chat && tally.undo;
  if (!ok) process.exit(1);
}

await main();
```

The implementer fills in `buildHarness`, `countParagraphHits`, and the imports (mirroring the Phase 3 `smoke-coordinator.ts` shape).

- [ ] **Step 4: Add the npm script**

In `package.json`, alongside `smoke:coordinator`:

```json
    "smoke:phase4": "bun scripts/smoke-phase4.ts",
```

- [ ] **Step 5: Verify**

Run: `bun run typecheck && bun run lint && bun test`

Expected: green. Total tests ≥ 250 (Phase 3 baseline of 154 + Phase 4 additions ≥ 100).

Run (only when dynamo is up): `bun run smoke:phase4`

Expected: prints `[smoke] phase4: stream=N decorations=M vitals=ok bridge=ok canvas=ok search=ok chat=ok undo=ok` with all bools `ok` and `stream > 0`. Copy the printed line into the STATE update below.

- [ ] **Step 6: Update STATE.md (local-only — never staged)**

`.planning/` is gitignored. STATE.md exists on disk for the next session's context but is **not** committed. Replace the local file with the content below, then move on; do not `git add` it.

```markdown
# Notient Project State

**Version:** 0.2.0 (no git tag — tags reserved for v1.0.0 release)
**Current phase:** Phase 4 (Stream) — COMPLETE
**Date completed:** <fill in>
**Next phase:** Phase 5 (Hardening + telemetry + docs site + notient.com landing)
**AI substrate:** dynamo (`192.168.86.143:1234`, LM Studio, primary) + mini (`192.168.86.141:8080`, llama-server, deep)
**Test vault:** `/mnt/c/Users/akougk/Projects/vaultex/` (894 markdown notes, PARA structure)

## What works (verified by tests + Phase 4 smoke run)

Carries forward Phase 1 + Phase 2 + Phase 2.5 + Phase 3, plus:

- Tabbed sidebar (Stream / Vitals / Chat) replacing the Phase 3 single-pane app.
- Stream feed ranking proposals by `confidence × exp(-ageHours/12) × (relatedToActiveNote ? 1 : 0.3)` over pending `staging_edges` ∪ `staging_nodes`.
- Per-note Vitals: freshness (`exp(-Δdays/14)`), composite health, connectivity tier from approved `graph_edges`, maturity from the column. Persists snapshots back to `notes` on save and on `agent:run-finished`. Optional opt-in writeback to frontmatter (`notient.health` / `freshness` / `connectivity` / `maturity`) so values appear in Obsidian's native Properties pane. Closes the freshness-placeholder tech-debt item from Phase 3.
- CodeMirror paragraph-end widget decorations (Source + Live Preview only) for paragraphs whose chunks appear in pending agent proposals. Mode-gated, debounced, viewport-capped, click opens the Stream tab.
- Native graph bridge: approved `LINKS_TO` edges write a wikilink into the source note's "Related" section (EchoGuarded); typed relations (`contradicts`, `supports`, `extends`, `synthesizes_from`) write to frontmatter list properties. Obsidian's metadataCache re-resolves and the native graph re-renders. No custom GraphView ships.
- JSON Canvas exporter generates `.canvas` files for synthesis-proposal previews and SearchView "View as canvas" exports under `Notient/proposals/` and `Notient/searches/canvases/`. Obsidian's native canvas view renders them.
- Multi-strategy SearchView (centre-pane flagship): Quick (keyword over titles + chunks), Balanced (HNSW vector top-K=20 → LLM rerank top-N=5), Deep (Balanced + 1-hop graph expansion + grounded synthesis with `[[note]]` citations). Filters: maturity, agent provenance, min confidence, folder, date range, connectivity tier, has-pending-proposals. Two-pane layout (results left, preview right). Saved queries live in `Notient/searches/` as markdown. Search history ring-buffer in `Notient/.index.json`. "View as canvas" generates a JSON Canvas of result notes for spatial exploration.
- Chat MVP turned flagship: multi-turn tool-using agent with conversations stored as markdown in `Notient/conversations/`. Eight-layer context composition (identity, user profile, vault snapshot, workspace state, pinned context, cross-session memory via `summary_embedding` cosine search, tool catalog, conversation history with budget-aware summarization). Tools: vault.search_notes / read_note / list_neighbors / get_vitals, graph.find_path / list_clusters, agents.explain / synthesize / contradiction_check, proposals.list / accept_edge / reject_edge / accept_node, note.append_section / create. Approval gate runs in safe mode by default with per-call ApprovalCards; yolo mode (configurable, with confirmation modal) auto-approves and records every action to the `history` table for one-click undo. Native LM Studio `chatWithTools` extends `LLMProvider` with native function calling + reasoning_content channel; `toolModeProbe` auto-detects native vs JSON-fallback per model and caches in settings.
- Universal undo via the schema_v1 `history` table: producers across approvals, native graph bridge, maturity advancer, and chat write tools record `kind/target/before/after`. Eight kind-keyed inverters reverse every Notient mutation. `notient-undo-last` command, "auto-approved · undo" pill in yolo mode, and a HistoryModal for power users.
- Indexer exclude paths default to `Notient/conversations`, `Notient/proposals`, `Notient/searches` so chat persistence and canvas exports never pollute the agent feed.
- Native command palette wiring: every Phase 4 surface is reachable from Cmd+P (search-quick / balanced / deep / here, chat-new / active-note / resume-last, undo-last, history-show).

## Test count

After Phase 4: ~260 passing (Phase 3 closed at 154 + Phase 4 additions: settings/bootstrap 4 + sidebar 4 + stream 7 + vitals 6 + decorations 6 + bridge/canvas 9 + search core 12 + search deep 5 + search UI 5 + search wiring 4 + conversation storage 9 + tool registry + read-only tools 12 + write-gated + LM Studio 9 + agent loop + context 9 + chat UI 6 + undo 11 + close-out 0 ≈ 118 new ≈ 272 total).

## DoD (spec §13 row 4)

- [ ] Stream tab renders top 5 ranked items in <100ms warm.
- [ ] Editor decorations appear within 200ms of layout for indexed notes ≥100 words.
- [ ] Vitals tab shows freshness / health / connectivity / maturity for the active note.
- [ ] Approving a `LINKS_TO` staging edge appends a wikilink to the source note's `## Related` section and the native graph picks it up.
- [ ] Approving a `CONTRADICTS` staging edge writes `notient.contradicts` to frontmatter.
- [ ] Synthesis preview canvas opens in Obsidian's native canvas view.
- [ ] SearchView Balanced mode returns ≥1 result on the test vault within 3s; filter toggle re-runs in <500ms.
- [ ] Deep mode produces a synthesis card with clickable `[[note]]` citations.
- [ ] Starting a chat persists `Notient/conversations/<date> <slug>.md` and the file roundtrips through the parser.
- [ ] Asking "what notes contradict my view on X?" results in autonomous tool calls (search + contradiction_check) with cited response.
- [ ] Safe-mode write tool blocks on ApprovalCard with markdown diff.
- [ ] Yolo-mode write tool auto-applies and renders an "auto-approved · undo" pill.
- [ ] `notient-undo-last` reverses the most recent mutation.
- [ ] `bun run smoke:phase4` exits 0 with `stream>0` and all surfaces `ok`.

(Tick during the Phase 4 close-out smoke run.)

## Tech debt to address opportunistically

- Chat conversation summarization runs on every turn — for large vaults the embedding regen can be amortized to every-N-turns.
- LM Studio tool-mode probe is per-model; if the user swaps models mid-session, settings cache is stale until next probe. Acceptable for v1.0.
- SearchView ResultList is windowed but not virtualized below 30 rows. Fine on the test vault; benchmark on >5k chunks in Phase 5.
- HistoryModal does not paginate; only shows last 50 rows. Fine for v1.0; v1.1 adds infinite scroll.
- Cross-session memory cosine search loads all entries into memory at plugin init. For users with thousands of conversations this becomes memory-heavy — Phase 5 may swap to disk-backed nearest-neighbor.

## What does not exist yet

- Hardening + telemetry (Phase 5)
- Docs site + notient.com landing (Phase 5)
- v1.0 release tag

## How to resume in next session (Phase 5)

1. Read this file + spec §13 row 5.
2. Phase 5 deliverables: hardening pass over Phase 4 surfaces, telemetry opt-in, docs site, notient.com landing, v1.0 tag.
3. Same workflow: `superpowers:writing-plans` → `superpowers:subagent-driven-development` (Opus 4.7 implementers only).
```

- [ ] **Step 7: Commit wiring + smoke (no tag, no STATE)**

```bash
git add src/main.ts src/core/kernel.ts scripts/smoke-phase4.ts package.json
git commit -m "feat(phase4): wire all surfaces + smoke:phase4 harness"
```

`.planning/STATE.md` is intentionally absent from this commit — `.planning/` is gitignored. The local file was updated in Step 6 for the next session's reading.

- [ ] **Step 8: Confirm no tag was created**

```bash
git tag --list | grep -E '^v1' || echo "no v1 tags (expected)"
```

Expected output: `no v1 tags (expected)`. Phase 4 deliberately does not tag.



---

## End of Phase 4 plan

Total: 17 numbered tasks (Task 0 = settings + bootstrap, Tasks 1–4 = sidebar shell + Stream + Vitals + decorations, Task 5 = native graph bridge + canvas, Tasks 6–9 = search flagship, Tasks 10–14 = chat flagship, Task 15 = universal undo, Task 16 = wiring + smoke + close-out). Each task is committable and tested in isolation. Estimated test count after Phase 4: ~260 (Phase 3 closed at 154 + Phase 4 additions: settings/bootstrap 4 + sidebar 4 + stream 7 + vitals 6 + decorations 6 + bridge/canvas 9 + search core 12 + search deep 5 + search UI 5 + search wiring 4 + conversation storage 9 + tool registry + read-only tools 12 + write-gated + LM Studio 9 + agent loop + context 9 + chat UI 6 + undo 11 + close-out 0 ≈ 118 new ≈ 272 total).

After Task 16, the next session's first action is to read `.planning/STATE.md` and invoke `superpowers:writing-plans` for Phase 5 (Hardening + telemetry + docs site + notient.com landing).
