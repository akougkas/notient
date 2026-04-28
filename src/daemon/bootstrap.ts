import { FsVault } from "../adapters/fsVault";
import { TIER_1_IDENTITY } from "../agent/identity";
import { buildNotientAgent } from "../agent/notientAgent";
import { buildAgentToolRegistry } from "../agent/toolBundle";
import { probeVisionRoute } from "../agent/visionProbe";
import { ContradictionHunter } from "../core/agents/contradictionHunter";
import { Linker } from "../core/agents/linker";
import { MaturityAdvancer } from "../core/agents/maturityAdvancer";
import { Synthesizer } from "../core/agents/synthesizer";
import { ApprovalGate } from "../core/chat/approvalGate";
import { type ChatRuntimeSettings, ChatService } from "../core/chat/chatService";
import { ContextManager } from "../core/chat/contextManager";
import { ConversationIndex } from "../core/chat/conversationIndex";
import { ConversationStore } from "../core/chat/conversationStore";
import type { ToolMode, ToolModeCache } from "../core/chat/toolModeProbe";
import { InMemoryClusterCache } from "../core/chat/tools/graph";
import { Coordinator } from "../core/coordinator/coordinator";
import { ReasoningMutex } from "../core/coordinator/reasoningMutex";
import { Database } from "../core/db/database";
import { EventBus } from "../core/events/eventBus";
import { GraphStore } from "../core/graph/graphStore";
import { HistoryService } from "../core/history/historyService";
import { makeNoteAppendSectionInverter } from "../core/history/inverters/noteAppendSection";
import { makeNoteCreateInverter } from "../core/history/inverters/noteCreate";
import { makeNoteFrontmatterInverter } from "../core/history/inverters/noteFrontmatter";
import type { InverterRegistry } from "../core/history/types";
import { Embedder } from "../core/indexer/embedder";
import { Extractor } from "../core/indexer/extractor";
import { HnswVectorIndex } from "../core/indexer/hnswVectorIndex";
import { indexNote } from "../core/indexer/indexNote";
import { IndexerQueue } from "../core/indexer/indexerQueue";
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

export interface BootstrapOptions {
  vaultPath: string;
  /** Override for LM Studio base URL when testing. Defaults to settings. */
  baseUrlOverride?: string;
  /** When true, seal kernel with phase: "A" (probe-only, no DB or indexer). */
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
      close: makeClose({
        database,
        lockHandle,
        health,
        vectorIndex: null,
        vault,
        vectorPath: VECTOR_PATH,
      }),
    };
  }

  // Phase B additions.
  const vectorIndex = new HnswVectorIndex({});
  const existingVectorBytes = await vault.readBinary(VECTOR_PATH);
  if (existingVectorBytes) {
    await vectorIndex.load(existingVectorBytes);
  } else {
    // 768 matches the locked embedding model (text-embedding-nomic-embed-text-v2-moe).
    await vectorIndex.init(768);
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
    neighborhood: async (notePath, queryOptions) => {
      const head = database.query<{ id: string; vector: Uint8Array; dim: number }>(
        `SELECT e.chunk_id AS id, e.vector AS vector, e.dim AS dim
         FROM embeddings e JOIN chunks c ON c.id = e.chunk_id
         WHERE c.note_path = ? ORDER BY c.ord LIMIT 1;`,
        [notePath],
      );
      if (head.length === 0) return [];
      const view = new Float32Array(head[0].vector.buffer, head[0].vector.byteOffset, head[0].dim);
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
    hash: syncHash,
    now: () => Date.now(),
  });

  const conversationIndex = new ConversationIndex({
    facade: {
      read: async (path) => vault.read(path).catch(() => null),
      write: (path, content) => vault.write(path, content),
    },
    indexPath: SIDECAR_PATH,
  });
  await conversationIndex.load();

  const approvalGate = new ApprovalGate({
    events: {
      onPending: () => {
        // Bootstrap registers a noop hook; the daemon's chat handler
        // (Task 13) re-binds onPending/onResolved per turn so wire frames
        // get emitted with a turn-scoped envelopeId.
      },
      onResolved: () => {
        // See above.
      },
    },
    recordHistoryAutoApprove: async () => {
      // Phase D wires this into history; Phase C noops so the gate
      // resolves immediately without a missing-hook error.
    },
    perToolPolicy: current.chat.perTool,
  });

  const clusterCache = new InMemoryClusterCache();

  const notesFacade = {
    readNote: (path: string) => vault.read(path),
    writeNote: (path: string, content: string) => vault.write(path, content),
    exists: (path: string) => vault.exists(path),
  };

  // Inverters for the four chat-write history kinds. Graph-side and
  // note.maturity inverters are wired alongside their producers in Task 16.
  const noteAppendInverter = makeNoteAppendSectionInverter({
    facade: { writeNote: notesFacade.writeNote },
    echoGuard: { mark: (path, sha) => echoGuard.mark(path, sha) },
    hash: simpleHash,
  });
  const inverters: InverterRegistry = {
    "notes.create": makeNoteCreateInverter({
      facade: {
        exists: notesFacade.exists,
        remove: (path) => vault.remove(path),
      },
      echoGuard: { mark: (path, sha) => echoGuard.mark(path, sha) },
      hash: simpleHash,
    }),
    "notes.append": noteAppendInverter,
    "notes.replace_section": noteAppendInverter,
    "notes.update_frontmatter": makeNoteFrontmatterInverter({
      facade: { writeNote: notesFacade.writeNote },
      echoGuard: { mark: (path, sha) => echoGuard.mark(path, sha) },
      hash: simpleHash,
    }),
  };
  const historyService = new HistoryService({
    db: database,
    inverters,
    retention: {
      max: current.chat.history.maxEntries,
      maxPerTarget: current.chat.history.maxPerTarget,
    },
  });

  const toolRegistry = buildAgentToolRegistry({
    database,
    searchPipeline,
    vitalsService,
    vaultFacade: { readNote: (path) => vault.read(path) },
    notesFacade,
    approvalGate,
    echoGuard: { mark: (path, sha) => echoGuard.mark(path, sha) },
    hash: simpleHash,
    approvalMode: () => current.chat.approvalMode,
    recordHistory: async (record) => historyService.record(record),
    generateCallId: () =>
      `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    contradictionHunter,
    synthesizer,
    clusterCache,
  });

  const embedSingle = async (text: string, signal: AbortSignal): Promise<Float32Array | null> => {
    const vectors = await embedder.embed([text], signal);
    return vectors.length > 0 ? new Float32Array(vectors[0]) : null;
  };

  const contextManager = new ContextManager({
    database,
    provider: primaryLLM,
    conversationIndex,
    embed: embedSingle,
    bus,
    contextSettings: () => ({
      ...current.chat.context,
      contextBudgetFraction: current.chat.contextBudgetFraction,
      modelContextTokens: current.chat.modelContextTokens,
    }),
    workspace: {
      getActiveNotePath: () => null,
      getOpenNotePaths: () => [],
      getRecentNotePaths: () => [],
      getRecentSearchQueries: () => [],
    },
    facade: { readNote: (path) => vault.read(path) },
    voiceProfile: () => "",
    approvalMode: () => current.chat.approvalMode,
    toolCatalog: () =>
      toolRegistry.list().map((entry) => ({
        name: entry.name,
        description: entry.description,
      })),
    estimateTokens: (text) => Math.ceil(text.length / 4),
    summaryModel: current.primary.reasoningModel,
    identity: TIER_1_IDENTITY,
  });

  // Tool-mode cache reads first from chat.toolModeByModel in settings (so an
  // operator can pin a known-good mode for a model that fails the auto-probe),
  // then from the in-memory store populated by previous probes this session.
  // Writes go through SettingsService.update so the setting persists across
  // daemon restarts.
  const toolModeStore = new Map<string, ToolMode>();
  const toolModeCache: ToolModeCache = {
    read: (model) => {
      const fromSettings = settings.get().chat.toolModeByModel[model];
      if (fromSettings) return fromSettings;
      return toolModeStore.get(model) ?? null;
    },
    write: async (model, mode) => {
      toolModeStore.set(model, mode);
      const next = { ...settings.get().chat.toolModeByModel, [model]: mode };
      await settings.update({ chat: { ...settings.get().chat, toolModeByModel: next } });
    },
  };

  const chatService = buildNotientAgent({
    provider: primaryLLM,
    contextManager,
    conversationStore,
    conversationIndex,
    toolRegistry,
    approvalGate,
    mutex: reasoningMutex,
    toolModeCache,
    embed: embedSingle,
    bus,
    settings: (): ChatRuntimeSettings => ({
      model: current.primary.reasoningModel,
      maxRoundsPerTurn: current.chat.maxRoundsPerTurn,
      approvalMode: current.chat.approvalMode,
      persistReasoning: current.chat.persistReasoning,
    }),
  });

  kernel.register("conversationStore", conversationStore);
  kernel.register("conversationIndex", conversationIndex);
  kernel.register("approvalGate", approvalGate);
  kernel.register("toolRegistry", toolRegistry);
  kernel.register("contextManager", contextManager);
  kernel.register("chatService", chatService);
  kernel.register("historyService", historyService);

  // Optional vision routing: probe primary first; fall back to
  // chat.vision when configured. Bootstrap omits the slot when neither
  // path is viable; chat.send refuses image attachments with
  // VISION_UNAVAILABLE in that case.
  const visionConfig = current.chat.vision ?? {
    enabled: false,
    baseUrl: "",
    model: "",
  };
  const visionRouter = await probeVisionRoute({
    primaryLLM,
    primaryModel: current.primary.reasoningModel,
    visionConfig,
    makeFallback: () => new LMStudioProvider({ baseUrl: visionConfig.baseUrl }),
  }).catch(() => null);
  if (visionRouter !== null) {
    kernel.register("visionLLM", visionRouter);
  }

  kernel.seal({ phase: "C" });
  health.start();
  idleDetector.start();

  return {
    kernel,
    close: makeClose({ database, lockHandle, health, vectorIndex, vault, vectorPath: VECTOR_PATH }),
  };
}

async function simpleHash(content: string): Promise<string> {
  const buffer = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Synchronous fallback hash for the ConversationStore's EchoGuard mark. The
 * indexer uses cryptographic SHA-256 elsewhere, but the conversation store's
 * hash hook needs to run inline with the write call. djb2 is good enough for
 * echo-guard de-duplication: any collision just means the indexer
 * re-processes a self-write (worst case wasted work, never wrong content).
 */
function syncHash(content: string): string {
  let hash = 5381;
  for (let index = 0; index < content.length; index++) {
    hash = ((hash << 5) + hash + content.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16);
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
        const bytes = await deps.vectorIndex.persist();
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
