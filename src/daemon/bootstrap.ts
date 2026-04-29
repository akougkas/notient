import { readFile as readFileFs, rename, unlink, writeFile } from "node:fs/promises";
import { FsVault } from "../adapters/fsVault";
import { TIER_1_IDENTITY } from "../agent/identity";
import { buildNotientAgent } from "../agent/notientAgent";
import { buildAgentToolRegistry } from "../agent/toolBundle";
import { probeVisionRoute } from "../agent/visionProbe";
import { Linker } from "../core/agents/linker";
import { MaturityAdvancer } from "../core/agents/maturityAdvancer";
import { ApprovalService } from "../core/approvals/approvalService";
import { ApprovalGate } from "../core/chat/approvalGate";
import { type ChatRuntimeSettings, ChatService } from "../core/chat/chatService";
import { ContextManager } from "../core/chat/contextManager";
import { ConversationIndex } from "../core/chat/conversationIndex";
import { ConversationStore } from "../core/chat/conversationStore";
import type { ToolMode, ToolModeCache } from "../core/chat/toolModeProbe";
import { InMemoryClusterCache } from "../core/chat/tools/graph";
import type { ToolCall } from "../core/chat/types";
import { loadVaultConfig } from "../core/config/configFile";
import { Coordinator } from "../core/coordinator/coordinator";
import { ReasoningMutex } from "../core/coordinator/reasoningMutex";
import type { Agent, AgentRunResult } from "../core/coordinator/types";
import { applySchema } from "../core/db/schemaApplier";
import { type SurrealConnection, connect as connectSurreal } from "../core/db/surreal";
import { createTranscriptDistiller } from "../core/distill/transcriptDistiller";
import { EventBus } from "../core/events/eventBus";
import { HistoryService } from "../core/history/historyService";
import { makeNoteAppendSectionInverter } from "../core/history/inverters/noteAppendSection";
import { makeNoteCreateInverter } from "../core/history/inverters/noteCreate";
import { makeNoteFrontmatterInverter } from "../core/history/inverters/noteFrontmatter";
import { makeNoteMaturityInverter } from "../core/history/inverters/noteMaturity";
import type { InverterRegistry } from "../core/history/types";
import { Embedder } from "../core/indexer/embedder";
import { Extractor } from "../core/indexer/extractor";
import { indexNote } from "../core/indexer/indexNote";
import { IndexerQueue } from "../core/indexer/indexerQueue";
import { Kernel } from "../core/kernel";
import { LMStudioProvider } from "../core/llm/lmStudioProvider";
import { Reranker } from "../core/search/reranker";
import { SavedQueries } from "../core/search/savedQueries";
import { SearchHistory } from "../core/search/searchHistory";
import { SearchPipeline } from "../core/search/searchPipeline";
import { AgentEventStore } from "../core/services/agentEventStore";
import { HealthMonitor } from "../core/services/healthMonitor";
import { IdleDetector } from "../core/services/idleDetector";
import { ProbeCache } from "../core/services/probeCache";
import { SessionGrants } from "../core/services/sessionGrants";
import { runStartupProbe } from "../core/services/startupProbe";
import { VaultBootstrap } from "../core/services/vaultBootstrap";
import { VaultLock, type VaultLockHandle } from "../core/services/vaultLock";
import { parseEnvFile } from "../core/settings/envFile";
import type { EnvSource } from "../core/settings/envOverrides";
import { type ConfigStore, SettingsService } from "../core/settings/settingsService";
import { vaultDataDir, vaultPidPath, vaultPortPath, vaultSecretPath } from "../core/vault/identity";
import { readOrGenerateSecret } from "../core/vault/secret";
import { VitalsService } from "../core/vitals/vitalsService";
import { type SurrealServerHandle, startSurreal } from "./surrealServer";

export interface BootstrapOptions {
  vaultPath: string;
  /** Override for LM Studio base URL when testing. Defaults to settings. */
  baseUrlOverride?: string;
  /** When true, seal kernel with phase: "A" (probe-only, no DB or indexer). */
  phaseA?: boolean;
  /**
   * When true, skip the SurrealDB child-process bootstrap (start, connect,
   * applySchema, register). Tests that exercise the full Phase C bootstrap
   * without a `surreal` binary on PATH set this. The Phase A early-exit path
   * already skips the SurrealDB block; this flag covers Phase C tests.
   */
  skipSurreal?: boolean;
}

export interface BootstrapResult {
  kernel: Kernel;
  close: () => Promise<void>;
}

const NOTIENT_DIR = ".notient";
const LOCK_PATH = `${NOTIENT_DIR}/notient.lock`;
const CONFIG_PATH = `${NOTIENT_DIR}/config.json`;

const NOTIENT_FOLDER = "Notient";
const CONVERSATIONS_FOLDER = `${NOTIENT_FOLDER}/conversations`;
const PROPOSALS_FOLDER = `${NOTIENT_FOLDER}/proposals`;
const SAVED_QUERIES_FOLDER = `${NOTIENT_FOLDER}/searches`;
const SIDECAR_PATH = `${NOTIENT_FOLDER}/.index.json`;
const ENV_PATH = `${NOTIENT_DIR}/.env`;
const ENV_KEYS: ReadonlyArray<keyof EnvSource> = [
  "NOTIENT_LLM_BASE_URL",
  "NOTIENT_LLM_MODEL",
  "NOTIENT_EMBED_MODEL",
  "NOTIENT_CONTEXT_TOKENS",
];

/**
 * Build an EnvSource by overlaying process.env on top of the vault's
 * <vault>/.notient/.env file. Process env wins so an operator can run
 * NOTIENT_LLM_MODEL=... bun ... daemon start to override the vault default
 * for one boot. Only NOTIENT_-prefixed keys we explicitly recognize are
 * carried through.
 */
/**
 * Refuse to seal the daemon if the operator hasn't pointed it at a real
 * LM Studio endpoint and a real chat model. The DEFAULT_SETTINGS values
 * are empty strings so that no model name is ever pinned in source code;
 * the configuration must come from <vault>/.notient/config.json or the
 * NOTIENT_LLM_BASE_URL / NOTIENT_LLM_MODEL / NOTIENT_EMBED_MODEL env vars
 * (read from <vault>/.notient/.env or process.env).
 */
function assertEndpointConfigured(settings: {
  primary: { baseUrl: string; reasoningModel: string };
  embedding: { model: string };
}): void {
  const missing: string[] = [];
  if (settings.primary.baseUrl.trim().length === 0) missing.push("primary.baseUrl");
  if (settings.primary.reasoningModel.trim().length === 0) missing.push("primary.reasoningModel");
  if (settings.embedding.model.trim().length === 0) missing.push("embedding.model");
  if (missing.length === 0) return;
  throw new Error(
    `notient: required configuration missing: ${missing.join(", ")}. Set values in <vault>/.notient/config.json or define NOTIENT_LLM_BASE_URL, NOTIENT_LLM_MODEL, NOTIENT_EMBED_MODEL in <vault>/.notient/.env (or process env).`,
  );
}

async function readEnvSource(vault: FsVault, processEnv: NodeJS.ProcessEnv): Promise<EnvSource> {
  const fileEnv = await vault
    .read(ENV_PATH)
    .then((text) => (text === null ? {} : parseEnvFile(text)))
    .catch(() => ({}) as Record<string, string>);
  const result: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const fileValue = fileEnv[key];
    const processValue = processEnv[key];
    const chosen = processValue ?? fileValue;
    if (typeof chosen === "string" && chosen.length > 0) result[key] = chosen;
  }
  return result as EnvSource;
}

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const vault = new FsVault(options.vaultPath);
  const bus = new EventBus();

  // Read the per-vault TOML config once. Missing file falls back to the
  // built-in defaults silently; malformed TOML logs a warning and falls back.
  // No live reload; daemon restart picks up changes (Phase 4 Task 10).
  const vaultConfig = await loadVaultConfig(options.vaultPath);

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
  const envSource = await readEnvSource(vault, process.env);
  await settings.load(envSource);
  const current = settings.get();
  assertEndpointConfigured(current);

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

  // SurrealDB bootstrap runs ahead of kernel registration so the Phase A
  // services (AgentEventStore, SessionGrants) that Phase 4 Task 12 migrated
  // off SQLite can read the live connection at construction. Order:
  // secret -> start server -> SDK connect -> applySchema -> kernel registers.
  // The `skipSurreal` opt-out wires nothing here; downstream sites that
  // require SurrealDB (SearchPipeline, HistoryService, AgentEventStore,
  // SessionGrants) refuse to construct without it, so the only remaining
  // skipSurreal path is the daemon shutdown contract test that never reaches
  // those services.
  let surrealHandle: SurrealServerHandle | null = null;
  let surrealConnection: SurrealConnection | null = null;
  if (!options.skipSurreal) {
    const surrealSecret = await readOrGenerateSecret(vaultSecretPath(options.vaultPath));
    surrealHandle = await startSurreal({
      dataDir: vaultDataDir(options.vaultPath),
      secret: surrealSecret,
      portFile: vaultPortPath(options.vaultPath),
      pidFile: vaultPidPath(options.vaultPath),
      logLevel: vaultConfig.surrealdb.logLevel,
      hnswCacheMib: vaultConfig.surrealdb.hnswCacheMib,
      onUnexpectedExit: (code) => {
        // The AppEvent union does not include a SurrealDB failure variant in
        // Phase 1. Mirror the `daemon:vector_persist_failed` pattern from
        // makeClose and surface the failure as a structured stderr line so
        // the daemon supervisor can detect it without widening the union.
        process.stderr.write(`${JSON.stringify({ type: "daemon:db_failed", code: code ?? -1 })}\n`);
      },
    });
    surrealConnection = await connectSurreal({
      url: surrealHandle.url,
      user: "root",
      pass: surrealSecret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(surrealConnection.db, surrealSecret);
  }
  if (surrealConnection === null) {
    throw new Error(
      "bootstrap: AgentEventStore and SessionGrants require a SurrealDB connection (Phase 4 Task 12); skipSurreal is incompatible with Phase A wiring",
    );
  }

  // Phase A registers and seals here.
  const kernel = new Kernel();
  kernel.register("bus", bus);
  kernel.register("settings", settings);
  kernel.register("vault", vault);
  kernel.register("primaryLLM", primaryLLM);
  kernel.register("deepLLM", deepLLM);
  kernel.register("embeddingLLM", embeddingLLM);
  kernel.register("health", health);
  kernel.register("lock", lockHandle);
  kernel.register("probeCache", new ProbeCache(bus));
  kernel.register("agentEventStore", new AgentEventStore({ db: surrealConnection.db, bus }));
  const sessionGrants = new SessionGrants({ db: surrealConnection.db });
  kernel.register("sessionGrants", sessionGrants);
  kernel.register("surrealDb", surrealConnection);
  kernel.register("vaultConfig", vaultConfig);

  if (phaseA) {
    kernel.seal({ phase: "A" });
    health.start();
    return {
      kernel,
      close: makeClose({
        lockHandle,
        health,
      }),
    };
  }

  // Phase B additions.
  const embedder = new Embedder(embeddingLLM, {
    model: current.embedding.model,
    concurrency: vaultConfig.indexer.concurrency.embed,
  });
  const extractor = new Extractor(deepLLM, {
    model: current.deep.reasoningModel,
    concurrency: vaultConfig.indexer.concurrency.extract,
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
    db: surrealConnection.db,
    now: () => Date.now(),
    settings: () => current.vitals,
    facade: {
      updateFrontmatter: (path, patch) => vault.updateFrontmatter(path, patch),
    },
  });

  // SearchPipeline (Phase 4 Task 11) reads kNN, BM25, and graph expansion
  // directly through SurrealDB. The connection was opened ahead of Phase A
  // registration above; the null guard here is defense-in-depth for any
  // future change that re-introduces a path through bootstrap which leaves
  // the connection unset.
  if (surrealConnection === null) {
    throw new Error(
      "bootstrap: SearchPipeline requires a SurrealDB connection (Phase 4 Task 11); skipSurreal is incompatible with Phase B wiring",
    );
  }
  const searchPipeline = new SearchPipeline({
    db: surrealConnection.db,
    reranker,
    embed: async (text, signal) => {
      const vectors = await embedder.embed([text], signal);
      return vectors.length > 0 ? new Float32Array(vectors[0]) : null;
    },
    provider: deepLLM,
    reasoningModel: current.deep.reasoningModel,
    settings: () => current.search,
  });

  // The Linker (Phase 3) requires a live SurrealDB connection. When the
  // operator skipped SurrealDB or a Phase 3 deploy has not yet provisioned
  // it, fall back to a no-op linker so the Coordinator's agents map stays
  // populated and the swarm dispatch loop runs unchanged for the other
  // three agents.
  const concreteLinker: Linker | null =
    surrealConnection !== null
      ? new Linker({
          db: surrealConnection.db,
          provider: deepLLM,
          reasoningModel: current.deep.reasoningModel,
        })
      : null;
  const linker: Agent = concreteLinker ?? {
    name: "linker" as const,
    usesReasoningModel: false,
    run: async (): Promise<AgentRunResult> => ({ proposals: 0 }),
  };

  const indexer = new IndexerQueue({
    bus,
    debounceMs: vaultConfig.indexer.debounceMs,
    indexNote: async (path, context) => {
      const body = await vault.read(path);
      return await indexNote({
        notePath: path,
        noteBody: body,
        embedder,
        extractor,
        bus,
        chunkSizes: vaultConfig.indexer.chunk,
        ...(surrealConnection !== null ? { surrealDb: surrealConnection } : {}),
        ...(concreteLinker !== null ? { linker: concreteLinker } : {}),
        ...(context.tierFilter !== undefined ? { tierFilter: context.tierFilter } : {}),
      });
    },
  });

  // Phase 5 Locked Decision 11: Synthesizer and ContradictionHunter are
  // stripped from production wiring rather than migrated. Both have read
  // frozen/empty SQLite state since Phase 3 (Synthesizer clusters embeddings
  // via SQL against tables Phase 3 stopped writing to; ContradictionHunter
  // already runs with an empty `neighbors` closure since Phase 3 Task 10).
  // Migrating them onto SurrealDB is feature work, not a Phase 5 cutover
  // obligation. The agent .ts files stay on disk so a future feature task
  // can re-introduce SurrealDB-backed implementations. The Coordinator's
  // agents map keeps both keys with the same no-op fallback shape Linker
  // uses when SurrealDB is absent, so the swarm dispatch loop still records
  // four agent_run rows per cycle (each with proposals_count=0).
  const synthesizer: Agent = {
    name: "synthesizer" as const,
    usesReasoningModel: false,
    run: async (): Promise<AgentRunResult> => ({ proposals: 0 }),
  };
  const contradictionHunter: Agent = {
    name: "contradictionHunter" as const,
    usesReasoningModel: false,
    run: async (): Promise<AgentRunResult> => ({ proposals: 0 }),
  };
  const maturityAdvancer = new MaturityAdvancer({
    db: surrealConnection.db,
    facade: {
      read: (path) => vault.read(path),
      write: (path, content) => vault.write(path, content),
    },
  });

  const coordinator = new Coordinator({
    bus,
    db: surrealConnection.db,
    mutex: reasoningMutex,
    agents: {
      linker,
      synthesizer,
      contradictionHunter,
      maturityAdvancer,
    },
  });

  kernel.register("indexer", indexer);
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

  const notesFacade = {
    readNote: (path: string) => vault.read(path),
    writeNote: (path: string, content: string) => vault.write(path, content),
    exists: (path: string) => vault.exists(path),
  };

  // Phase 4 Task 4: HistoryService is SurrealDB-backed. The bootstrap
  // requires a live SurrealDB connection; the only path that produces a
  // null connection is the test-only `skipSurreal` opt-out, which exits
  // earlier in the production fast path because it has no consumers.
  if (surrealConnection === null) {
    throw new Error(
      "bootstrap: HistoryService requires a SurrealDB connection (Phase 4 Task 4); skipSurreal is incompatible with Phase C wiring",
    );
  }
  const surrealDbConnection = surrealConnection;
  const updateNoteSha = async (notePath: string, sha: string): Promise<void> => {
    await surrealDbConnection.db
      .query("UPDATE note SET sha = $sha WHERE path = $path;", { path: notePath, sha })
      .collect();
  };
  const inverters = buildHistoryInverters({
    writeNote: notesFacade.writeNote,
    removeNote: (path) => vault.remove(path),
    noteExists: notesFacade.exists,
    hash: simpleHash,
    updateNoteSha,
  });
  const historyService = new HistoryService({
    db: surrealDbConnection.db,
    inverters,
    retention: {
      max: current.chat.history.maxEntries,
      maxPerTarget: current.chat.history.maxPerTarget,
    },
  });

  // ApprovalService writes to absolute filesystem paths (vaultRoot joined
  // with the SurrealDB `note.path` value). FsVault's internal AtomicFs
  // treats paths as relative-to-root, so the production wiring constructs
  // a separate adapter that operates on absolute paths via node:fs/promises.
  // The smoke harness in approvalService.test.ts uses the same shape.
  const approvalService = new ApprovalService({
    db: surrealDbConnection.db,
    bus,
    vaultRoot: options.vaultPath,
    fs: {
      writeBinary: async (filePath, data) => {
        await writeFile(filePath, new Uint8Array(data));
      },
      rename: async (from, to) => {
        await rename(from, to);
      },
      remove: async (filePath) => {
        await unlink(filePath).catch(() => {
          // missing-file is not an error for cleanup
        });
      },
    },
    readFile: (filePath) => readFileFs(filePath, "utf8"),
  });

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
    recordHistoryAutoApprove: buildRecordHistoryAutoApprove(historyService),
    perToolPolicy: current.chat.perTool,
    sessionGrants,
  });

  const clusterCache = new InMemoryClusterCache();

  const toolRegistry = buildAgentToolRegistry({
    db: surrealDbConnection.db,
    searchPipeline,
    vitalsService,
    vaultFacade: { readNote: (path) => vault.read(path) },
    notesFacade,
    approvalGate,
    hash: simpleHash,
    approvalMode: () => current.chat.approvalMode,
    recordHistory: async (record) => historyService.record(record),
    generateCallId: () =>
      `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    // Phase 5 Locked Decision 11: the production agents are no-op `Agent`
    // shells. Task 7 migrated the chat-tool factories onto SurrealDB and
    // converted `agents.contradiction_check` / `agents.synthesize` into
    // explicit no-ops, so the toolbundle accepts the `Agent`-typed
    // placeholders directly without the transitional cast.
    contradictionHunter,
    synthesizer,
    clusterCache,
    bus,
  });

  const embedSingle = async (text: string, signal: AbortSignal): Promise<Float32Array | null> => {
    const vectors = await embedder.embed([text], signal);
    return vectors.length > 0 ? new Float32Array(vectors[0]) : null;
  };

  const contextManager = new ContextManager({
    db: surrealDbConnection.db,
    provider: primaryLLM,
    conversationIndex,
    embed: embedSingle,
    bus,
    contextSettings: () => {
      const live = settings.get().chat;
      return {
        ...live.context,
        contextBudgetFraction: live.contextBudgetFraction,
        modelContextTokens: live.modelContextTokens,
      };
    },
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

  const transcriptDistiller = createTranscriptDistiller({
    provider: primaryLLM,
    model: current.primary.reasoningModel,
  });

  kernel.register("conversationStore", conversationStore);
  kernel.register("conversationIndex", conversationIndex);
  kernel.register("approvalGate", approvalGate);
  kernel.register("toolRegistry", toolRegistry);
  kernel.register("toolModeCache", toolModeCache);
  kernel.register("contextManager", contextManager);
  kernel.register("chatService", chatService);
  kernel.register("historyService", historyService);
  kernel.register("approvalService", approvalService);
  kernel.register("transcriptDistiller", transcriptDistiller);

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

  // Phase 5 Task 2: replay any approve-and-write rows that landed in
  // state 2 of the pending-state contract (approved=true, applied=false)
  // before a previous daemon crashed. The call is fire-and-forget so
  // boot stays fast; the supervisor reads the structured stderr summary.
  // A reconciliation crash MUST NOT take down the daemon.
  void approvalService
    .reconcilePendingApplications()
    .then((result) => {
      process.stderr.write(
        `${JSON.stringify({
          type: "daemon:reconcile_summary",
          replayed: result.replayed,
          failed: result.failed,
        })}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ type: "daemon:reconcile_failed", error: String(error) })}\n`,
      );
    });

  // Fire-and-forget startup probe so boot stays fast (network roundtrip
  // bounded by AbortController in runStartupProbe).
  void runStartupProbe({
    endpoint: current.primary.baseUrl,
    modelId: current.primary.reasoningModel,
    configuredContextTokens: current.chat.modelContextTokens,
  }).then((event) => {
    bus.emit({ type: "daemon:startup_probe", ...event });
  });

  return {
    kernel,
    close: makeClose({
      lockHandle,
      health,
      surrealConnection,
      surrealHandle,
    }),
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
 * Closure the daemon installs at `ApprovalGate.recordHistoryAutoApprove`.
 * Yolo-mode tool calls invoke this hook before the tool's own write so the
 * audit trail records the auto-approval even when the subsequent write
 * fails. The row uses a distinct `chat.auto_approve` kind so /history shows
 * it alongside the regular `notes.*` rows but no inverter is registered for
 * it, which keeps /undo from silently erasing the audit record.
 */
export function buildRecordHistoryAutoApprove(
  historyService: HistoryService,
): (call: ToolCall) => Promise<void> {
  return async (call) => {
    const path = typeof call.args.path === "string" ? call.args.path : "";
    await historyService.record({
      kind: "chat.auto_approve",
      target: path,
      before: null,
      after: { tool: call.name, args: call.args },
    });
  };
}

export interface BuildHistoryInvertersOptions {
  writeNote: (path: string, content: string) => Promise<void>;
  removeNote: (path: string) => Promise<void>;
  noteExists: (path: string) => Promise<boolean>;
  hash: (content: string) => Promise<string>;
  /**
   * Refreshes the SurrealDB `note.sha` field after a body-restoring
   * inverter writes the prior body back to disk. Phase 4 Task 4
   * replaced the SQLite `notes` table write with this closure; the
   * production wiring issues `UPDATE note SET sha = $sha WHERE path = $path;`.
   */
  updateNoteSha: (path: string, sha: string) => Promise<void>;
}

/**
 * Build the InverterRegistry the daemon installs into HistoryService. Covers
 * the body-edit kinds and the maturity advancer's body+column write. Phase 4
 * Task 3 retired the `edge.*` and `node.*` inverters because the staging
 * tables they reverted no longer exist; rejections in the new SurrealDB
 * approval flow are total deletes with no `history` row. Task 4 swapped the
 * SQLite-backed sha update on `noteMaturity`/`noteAppendSection`/
 * `noteFrontmatter` for the injected `updateNoteSha` closure that hits
 * SurrealDB. Task 6 dropped the self-write mark; the indexer now
 * cross-references the SurrealDB `daemon_write` table to skip daemon writes.
 *
 * The body-edit kinds (`note.append_section`, `note.frontmatter`) reuse the
 * chat-side append/frontmatter inverters because they share the same payload
 * shape: prior body in `before`, written back through the vault facade.
 */
export function buildHistoryInverters(options: BuildHistoryInvertersOptions): InverterRegistry {
  const writeFacade = { writeNote: options.writeNote };
  const removeFacade = { exists: options.noteExists, remove: options.removeNote };
  const noteAppendInverter = makeNoteAppendSectionInverter({
    facade: writeFacade,
    hash: options.hash,
    updateNoteSha: options.updateNoteSha,
  });
  const noteFrontmatterInverter = makeNoteFrontmatterInverter({
    facade: writeFacade,
    hash: options.hash,
    updateNoteSha: options.updateNoteSha,
  });
  return {
    "notes.create": makeNoteCreateInverter({
      facade: removeFacade,
    }),
    "notes.append": noteAppendInverter,
    "notes.replace_section": noteAppendInverter,
    "notes.update_frontmatter": noteFrontmatterInverter,
    "note.append_section": noteAppendInverter,
    "note.frontmatter": noteFrontmatterInverter,
    "note.maturity": makeNoteMaturityInverter({
      facade: writeFacade,
      hash: options.hash,
      updateNoteSha: options.updateNoteSha,
    }),
  };
}

interface CloseDeps {
  lockHandle: VaultLockHandle;
  health: HealthMonitor;
  /**
   * Optional SurrealDB SDK connection. Closed first during shutdown so the
   * server sees a clean client disconnect before its child process is asked
   * to stop.
   */
  surrealConnection?: { close(): Promise<void> } | null;
  /**
   * Optional SurrealDB child-process handle. Stopped after the SDK has been
   * closed. Order is fixed: SDK close, then child stop, never the reverse.
   */
  surrealHandle?: { stop(): Promise<void> } | null;
}

function makeClose(deps: CloseDeps): () => Promise<void> {
  return async (): Promise<void> => {
    deps.health.stop();
    if (deps.surrealConnection) {
      await deps.surrealConnection.close().catch(() => {
        // SDK close errors are swallowed so subsequent shutdown steps run.
      });
    }
    if (deps.surrealHandle) {
      await deps.surrealHandle.stop().catch(() => {
        // Child stop errors are swallowed so subsequent shutdown steps run.
      });
    }
    await deps.lockHandle.release();
  };
}
