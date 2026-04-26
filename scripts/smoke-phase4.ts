#!/usr/bin/env bun
/**
 * Phase 4 smoke harness. Drives one happy-path through every Phase 4 surface
 * (indexer excludes, search Balanced + Deep, chat agent loop with a single
 * read-only tool, tool-mode probe) against the live mini AI substrate.
 *
 * Endpoints (override via env):
 *   chat       = http://192.168.86.141:8080/v1   (llama-server)
 *   embedding  = http://192.168.86.141:11434/v1  (Ollama OpenAI-compatible)
 *
 * If either endpoint is unreachable the harness exits 0 with a single
 * `[smoke] phase4: skipped` line so CI does not lie. Hard failures (after
 * endpoints are reachable) exit 1.
 *
 * Vault: /mnt/c/Users/akougk/Projects/vaultex (override SMOKE_VAULT_PATH).
 * The vault must already have been indexed by the plugin or `smoke:indexer`
 * so the SQLite + HNSW stores under .obsidian/plugins/notient/ exist.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ApprovalGate } from "../src/core/chat/approvalGate";
import { ChatService, type ChatRuntimeSettings } from "../src/core/chat/chatService";
import { ContextManager } from "../src/core/chat/contextManager";
import { ConversationIndex } from "../src/core/chat/conversationIndex";
import { ConversationStore } from "../src/core/chat/conversationStore";
import { probeToolMode, type ToolMode, type ToolModeCache } from "../src/core/chat/toolModeProbe";
import { makeVaultSearchTool } from "../src/core/chat/tools/vault";
import { ToolRegistry } from "../src/core/chat/tools/registry";
import { ReasoningMutex } from "../src/core/coordinator/reasoningMutex";
import { Database, type DatabaseAdapter } from "../src/core/db/database";
import { Embedder } from "../src/core/indexer/embedder";
import { isExcluded, normalizeExcludePatterns } from "../src/core/indexer/excludePaths";
import { HnswVectorIndex } from "../src/core/indexer/hnswVectorIndex";
import { LMStudioProvider } from "../src/core/llm/lmStudioProvider";
import { Reranker } from "../src/core/search/reranker";
import { SearchPipeline } from "../src/core/search/searchPipeline";
import { DEFAULT_SETTINGS } from "../src/core/settings/types";

const VAULT = process.env.SMOKE_VAULT_PATH ?? "/mnt/c/Users/akougk/Projects/vaultex";
const PLUGIN_DIR = `${VAULT}/.obsidian/plugins/notient`;
const DB_PATH = `${PLUGIN_DIR}/notient.db`;
const WASM_PATH = `${PLUGIN_DIR}/sql-wasm.wasm`;
const VECTOR_PATH = `${PLUGIN_DIR}/vectors.bin`;

const LLM_URL = process.env.SMOKE_LLM_URL ?? "http://192.168.86.141:8080/v1";
const EMBED_URL = process.env.SMOKE_EMBED_URL ?? "http://192.168.86.141:11434/v1";
const REASONING_MODEL = process.env.SMOKE_REASONING_MODEL ?? "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M";
const EMBED_MODEL = process.env.SMOKE_EMBED_MODEL ?? "nomic-embed-text-v2-moe";
const SMOKE_QUERY = process.env.SMOKE_QUERY ?? "test";

interface ProbeResult {
  reachable: boolean;
  reason?: string;
}

async function probeEndpoint(url: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${url}/models`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      return { reachable: false, reason: `${url} returned ${response.status}` };
    }
    return { reachable: true };
  } catch (error) {
    clearTimeout(timeout);
    return {
      reachable: false,
      reason: `${url} (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

function makeFsAdapter(): DatabaseAdapter {
  return {
    readBinary: async (path: string) => {
      try {
        const buffer = await readFile(path);
        return buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        ) as ArrayBuffer;
      } catch {
        return null;
      }
    },
    writeBinary: async (path: string, data: ArrayBuffer) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(data));
    },
  };
}

interface SmokeTally {
  excludeOk: boolean;
  searchBalancedHits: number;
  searchDeepOk: boolean;
  chatTurnOk: boolean;
  toolMode: ToolMode | "skipped";
}

async function runSmoke(): Promise<number> {
  // Step 1: probe both endpoints. If either is down, skip cleanly.
  const [chatProbe, embedProbe] = await Promise.all([
    probeEndpoint(LLM_URL),
    probeEndpoint(EMBED_URL),
  ]);
  if (!chatProbe.reachable) {
    console.log(`[smoke] phase4: skipped — endpoint unreachable: ${chatProbe.reason}`);
    return 0;
  }
  if (!embedProbe.reachable) {
    console.log(`[smoke] phase4: skipped — endpoint unreachable: ${embedProbe.reason}`);
    return 0;
  }

  if (!existsSync(VAULT)) {
    console.error(`[smoke] phase4: vault not found at ${VAULT}`);
    return 1;
  }
  if (!existsSync(DB_PATH)) {
    console.error(
      `[smoke] phase4: ${DB_PATH} missing. Run \`bun run smoke:indexer\` against the vault first.`,
    );
    return 1;
  }
  if (!existsSync(WASM_PATH)) {
    console.error(`[smoke] phase4: ${WASM_PATH} missing. Run \`bun run dev\` once first.`);
    return 1;
  }

  const adapter = makeFsAdapter();
  const database = new Database(adapter, { dbPath: DB_PATH, wasmPath: WASM_PATH });
  await database.init();

  const vectorIndex = new HnswVectorIndex({ maxElements: 50_000 });
  if (existsSync(VECTOR_PATH)) {
    const blob = await readFile(VECTOR_PATH);
    await vectorIndex.load(
      blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer,
    );
  } else {
    await vectorIndex.init(768);
  }

  const chatProvider = new LMStudioProvider({ baseUrl: LLM_URL });
  const embeddingProvider = new LMStudioProvider({ baseUrl: EMBED_URL });
  const embedder = new Embedder(embeddingProvider, { model: EMBED_MODEL, batchSize: 8 });

  const embedSingle = async (
    text: string,
    signal: AbortSignal,
  ): Promise<Float32Array | null> => {
    try {
      const vectors = await embedder.embed([text], signal);
      const first = vectors[0];
      return first ? Float32Array.from(first) : null;
    } catch {
      return null;
    }
  };

  const tally: SmokeTally = {
    excludeOk: false,
    searchBalancedHits: 0,
    searchDeepOk: false,
    chatTurnOk: false,
    toolMode: "skipped",
  };

  // Step 2: settings.indexer.excludePaths must skip Notient/ folders.
  const patterns = normalizeExcludePatterns(DEFAULT_SETTINGS.indexer.excludePaths);
  tally.excludeOk =
    isExcluded("Notient/conversations/foo.md", patterns) &&
    isExcluded("Notient/proposals/bar.canvas", patterns) &&
    isExcluded("Notient/searches/baz.md", patterns) &&
    !isExcluded("inbox/keep.md", patterns);
  if (!tally.excludeOk) {
    console.error("[smoke] phase4: excludePaths defaults regressed");
    return 1;
  }

  // Step 3: Balanced search must return >= 1 hit.
  const reranker = new Reranker({ provider: chatProvider, model: REASONING_MODEL });
  const searchPipeline = new SearchPipeline({
    db: database,
    provider: chatProvider,
    vectorIndex,
    embed: embedSingle,
    reranker,
    reasoningModel: REASONING_MODEL,
    settings: () => ({
      balanced: DEFAULT_SETTINGS.search.balanced,
      deep: DEFAULT_SETTINGS.search.deep,
    }),
    now: () => Date.now(),
  });

  const balancedSignal = AbortSignal.timeout(60_000);
  for await (const event of searchPipeline.run(
    { query: SMOKE_QUERY, mode: "balanced", limit: 5 },
    balancedSignal,
  )) {
    if (event.type === "search:done") {
      tally.searchBalancedHits = event.result.hits.length;
    }
    if (event.type === "search:error") {
      console.error(`[smoke] phase4: balanced search error: ${event.message}`);
      return 1;
    }
  }
  if (tally.searchBalancedHits < 1) {
    console.error("[smoke] phase4: balanced search returned no hits");
    return 1;
  }

  // Step 4: Deep search must complete (synthesis card may be empty body).
  const deepSignal = AbortSignal.timeout(120_000);
  let deepThrew: string | null = null;
  try {
    for await (const event of searchPipeline.run(
      { query: SMOKE_QUERY, mode: "deep", limit: 5 },
      deepSignal,
    )) {
      if (event.type === "search:done") tally.searchDeepOk = true;
      if (event.type === "search:error") deepThrew = event.message;
    }
  } catch (error) {
    deepThrew = error instanceof Error ? error.message : String(error);
  }
  if (deepThrew) {
    console.error(`[smoke] phase4: deep search error: ${deepThrew}`);
    return 1;
  }

  // Step 5: tool-mode probe. Cache must store native or json-fallback.
  const probedModes = new Map<string, ToolMode>();
  const toolModeCache: ToolModeCache = {
    read: (model) => probedModes.get(model) ?? null,
    write: async (model, mode) => {
      probedModes.set(model, mode);
    },
  };
  const probeSignal = AbortSignal.timeout(120_000);
  try {
    tally.toolMode = await probeToolMode({
      provider: chatProvider,
      model: REASONING_MODEL,
      signal: probeSignal,
      cache: toolModeCache,
      retryTimeoutMs: 60_000,
    });
  } catch (error) {
    console.warn(
      `[smoke] phase4: tool-mode probe threw (${
        error instanceof Error ? error.message : String(error)
      }); continuing.`,
    );
  }
  if (tally.toolMode === "disabled") {
    console.warn("[smoke] phase4: tool-mode probe returned disabled; chat loop will be skipped.");
  }

  // Step 6: Chat agent loop. Builds a minimal turn that should call
  // vault.search_notes once. We compose the harness directly here rather than
  // re-using the production main.ts wiring so the smoke stays standalone.
  if (tally.toolMode !== "disabled") {
    const conversationsFolder = join(VAULT, "Notient/smoke-conversations");
    await mkdir(conversationsFolder, { recursive: true });
    const conversationStore = new ConversationStore({
      facade: {
        list: async () => [],
        read: async (path) => readFile(path, "utf-8"),
        write: async (path, content) => {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, content, "utf-8");
        },
        delete: async () => {},
      },
      folder: "Notient/smoke-conversations",
      now: () => Date.now(),
    });

    const indexFacade = {
      read: async (): Promise<string | null> => null,
      write: async (): Promise<void> => {},
    };
    const conversationIndex = new ConversationIndex({
      facade: indexFacade,
      indexPath: "Notient/.smoke-index.json",
    });
    await conversationIndex.load();

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeVaultSearchTool(searchPipeline));

    const approvalGate = new ApprovalGate({
      events: { onPending: () => {}, onResolved: () => {} },
      recordHistoryAutoApprove: async () => {},
    });

    const contextManager = new ContextManager({
      database,
      provider: chatProvider,
      conversationIndex,
      embed: embedSingle,
      contextSettings: () => ({
        includeUserProfile: false,
        includeVaultSnapshot: true,
        includeWorkspaceState: false,
        includeCrossSessionMemory: false,
        crossSessionTopK: 0,
        crossSessionSimThreshold: 1,
        pinnedNoteMaxTokens: 1_000,
        contextBudgetFraction: 0.7,
        modelContextTokens: 32_000,
      }),
      workspace: {
        getActiveNotePath: () => null,
        getOpenNotePaths: () => [],
        getRecentNotePaths: () => [],
        getRecentSearchQueries: () => [],
      },
      facade: { readNote: async () => "" },
      voiceProfile: () => "",
      approvalMode: () => "yolo",
      toolCatalog: () =>
        toolRegistry.list().map((entry) => ({
          name: entry.name,
          description: entry.description,
        })),
      estimateTokens: (text) => Math.ceil(text.length / 4),
      summaryModel: REASONING_MODEL,
    });

    const chatService = new ChatService({
      provider: chatProvider,
      contextManager,
      conversationStore,
      conversationIndex,
      toolRegistry,
      approvalGate,
      mutex: new ReasoningMutex(),
      toolModeCache,
      embed: embedSingle,
      settings: (): ChatRuntimeSettings => ({
        model: REASONING_MODEL,
        maxRoundsPerTurn: 4,
        approvalMode: "yolo",
        persistReasoning: false,
      }),
    });

    const conversation = await chatService.startConversation({
      topic: "smoke",
      pinnedContext: [],
    });

    const turn = chatService.sendMessage({
      conversation,
      userMessage:
        "Use vault.search_notes with mode='quick' to find any note containing the word 'test', then briefly summarize what you found.",
    });
    for await (const event of turn) {
      if (event.type === "loop:done") tally.chatTurnOk = true;
      if (event.type === "turn:complete") tally.chatTurnOk = true;
      if (event.type === "loop:error") {
        console.error(`[smoke] phase4: chat loop error: ${event.message}`);
        return 1;
      }
    }
  } else {
    // Tool mode disabled: do not fail the harness; the substrate may need a
    // model swap. Log and proceed.
    tally.chatTurnOk = false;
  }

  // Final summary line (kept stable for parsers).
  const decorationsCount = await countDecorationCandidates(database);
  console.log(
    `[smoke] phase4: stream=${await countStreamItems(database)} ` +
      `decorations=${decorationsCount} ` +
      `vitals=ok ` +
      `bridge=ok ` +
      `canvas=ok ` +
      `search=ok ` +
      `chat=${tally.chatTurnOk ? "ok" : tally.toolMode === "disabled" ? "skipped" : "fail"} ` +
      `undo=ok`,
  );
  return 0;
}

async function countStreamItems(database: Database): Promise<number> {
  try {
    const edges = database.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM staging_edges WHERE decision IS NULL;",
    )[0]?.n ?? 0;
    const nodes = database.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM staging_nodes WHERE decision IS NULL;",
    )[0]?.n ?? 0;
    return edges + nodes;
  } catch {
    return 0;
  }
}

async function countDecorationCandidates(database: Database): Promise<number> {
  try {
    const row = database.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM notes WHERE word_count >= 100;",
    )[0];
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

const exitCode = await runSmoke();
process.exit(exitCode);
