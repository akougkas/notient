import { FsVault } from "../adapters/fsVault";
import { buildAgentToolRegistry } from "../agent/toolBundle";
import { probeVisionRoute } from "../agent/visionProbe";
import { Linker } from "../core/agents/linker";
import { NoteAnalysis } from "../core/analysis/noteAnalysis";
import { ApprovalService } from "../core/approvals/approvalService";
import { reviewsForEdge } from "../core/approvals/reviewStorage";
import { AwakenBackgroundRegistry } from "../core/awaken/backgroundRegistry";
import { ApprovalGate } from "../core/chat/approvalGate";
import { type ChatRuntimeSettings, ChatService } from "../core/chat/chatService";
import { ContextManager } from "../core/chat/contextManager";
import { ConversationIndex } from "../core/chat/conversationIndex";
import { ConversationStore } from "../core/chat/conversationStore";
import type { ToolMode, ToolModeCache } from "../core/chat/toolModeProbe";
import type { ToolCall } from "../core/chat/types";
import { AgentRunExecutor } from "../core/coordinator/agentRunExecutor";
import type { Coordinator } from "../core/coordinator/coordinator";
import { ReasoningScheduler } from "../core/coordinator/reasoningScheduler";
import type { AgentRunCapability } from "../core/coordinator/types";
import { WRITEBACK_EDGE_TABLES } from "../core/db/edgeTables";
import { parseSurrealRelationRecordId } from "../core/db/recordId";
import { applySchema } from "../core/db/schemaApplier";
import { type SurrealConnection, connect as connectSurreal } from "../core/db/surreal";
import { createTranscriptDistiller } from "../core/distill/transcriptDistiller";
import { EventBus } from "../core/events/eventBus";
import { GraphService } from "../core/graph/graphService";
import { DurableNoteWriter } from "../core/history/durableNoteWriter";
import { HistoryOperationError, historyConflict } from "../core/history/errors";
import { HistoryService } from "../core/history/historyService";
import { makeNoteBodyInverter } from "../core/history/inverters/noteBody";
import type { HistoryRow, InverterRegistry } from "../core/history/types";
import { Embedder } from "../core/indexer/embedder";
import { runEmbeddingRepair } from "../core/indexer/embeddingRepair";
import { makeExclusionPredicate } from "../core/indexer/excludePaths";
import { Extractor } from "../core/indexer/extractor";
import { indexNote } from "../core/indexer/indexNote";
import { IndexReadiness } from "../core/indexer/indexReadiness";
import { IndexerQueue } from "../core/indexer/indexerQueue";
import { purgeExcludedNotes } from "../core/indexer/purgeNote";
import { Kernel } from "../core/kernel";
import {
  type ResolvedEmbeddingIdentity,
  createEmbeddingIdentity,
} from "../core/llm/embeddingIdentity";
import { probeEmbedding } from "../core/llm/embeddingProbe";
import { LMStudioProvider } from "../core/llm/lmStudioProvider";
import {
  type EndpointModelCatalog,
  applyResolvedModels,
  fetchEndpointModelCatalog,
  resolveEndpointModels,
} from "../core/llm/modelSelection";
import { Reranker } from "../core/search/reranker";
import { SearchPipeline } from "../core/search/searchPipeline";
import { AgentEventStore } from "../core/services/agentEventStore";
import { HealthMonitor } from "../core/services/healthMonitor";
import {
  DAEMON_RESTART_ORPHAN_REASON,
  reconcileRunOrphans,
} from "../core/services/reconcileRunOrphans";
import { SentienceActivity } from "../core/services/sentienceActivity";
import { SessionGrants } from "../core/services/sessionGrants";
import type { VaultLockHandle } from "../core/services/vaultLock";
import { type ConfigSource, loadNotientConfig } from "../core/settings/configSchema";
import { readEnvSource, readOptionalVaultFile } from "../core/settings/envFile";
import {
  type ProviderCredentials,
  resolveProviderCredentials,
  resolveSettings,
} from "../core/settings/envOverrides";
import { SettingsService } from "../core/settings/settingsService";
import type { NotientSettings } from "../core/settings/types";
import { sha256Hex } from "../core/utils/sha256";
import { DaemonMutationJournal } from "../core/vault/daemonMutationJournal";
import { vaultDataDir, vaultPidPath, vaultPortPath, vaultSecretPath } from "../core/vault/identity";
import { readOrGenerateSecret } from "../core/vault/secret";
import { VitalsService } from "../core/vitals/vitalsService";
import { makePipelineServices } from "./pipelines";
import { type SurrealServerHandle, startSurreal } from "./surrealServer";

import {
  type ToolAuthorityChecks,
  assertToolApproval,
  assertToolTarget,
} from "../core/chat/toolAuthority";
import { EffectAuthorityRevoked } from "../core/history/effectAuthority";

export interface BootstrapOptions {
  vaultPath: string;
  /** Lock acquired by the daemon's boot ownership transaction. */
  lockHandle: VaultLockHandle;
  deferMutationRecovery?: boolean;
  beforeVaultMutation?: (paths: string[]) => Promise<undefined | (() => void)>;
  authorizeIdentity?: ToolAuthorityChecks["authorizeIdentity"];
  authorizeCaller?: Parameters<typeof makePipelineServices>[0]["authorizeCaller"];
}

export interface BootstrapResult {
  kernel: Kernel;
  mutationsReady: () => boolean;
  resumeMutationRecovery: () => Promise<boolean>;
  /** Authenticated catalog capability; endpoint credentials stay in closure scope. */
  fetchPrimaryModelCatalog: (timeoutMs?: number) => Promise<EndpointModelCatalog>;
  /** Fence process-owned startup writers before exclusive graph maintenance. */
  settleMaintenanceBackground: () => Promise<void>;
  close: () => Promise<void>;
}

const NOTIENT_DIR = ".notient";
const CONFIG_PATH = `${NOTIENT_DIR}/config.json`;

const NOTIENT_FOLDER = "Notient";
const CONVERSATIONS_FOLDER = `${NOTIENT_FOLDER}/conversations`;

/** Without a pairing store, no paired credential can be shown to be live. */
function identityAuthorizer(options: BootstrapOptions): ToolAuthorityChecks["authorizeIdentity"] {
  return (
    options.authorizeIdentity ??
    ((id) => {
      if (id.startsWith("paired-"))
        throw new EffectAuthorityRevoked("paired caller cannot be validated");
    })
  );
}

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const daemonMutationJournal = new DaemonMutationJournal();
  const vault = new FsVault(options.vaultPath, {
    reserveMutation: (mutation) => daemonMutationJournal.reserve(mutation),
    beforeMutation: options.beforeVaultMutation,
  });
  // The daemon owns `.notient/.env` and `.notient/config.json`. `vault`
  // refuses dot-prefixed segments so no RPC handler or chat tool can read
  // them; configuration goes through a hidden-capable adapter that is never
  // handed to a handler or tool facade.
  const internalVault = new FsVault(options.vaultPath, { allowHiddenPaths: true });
  // A killed atomic write can leave only Notient's strict UUID-tagged temp
  // files behind. Recover them before reading any operator configuration.
  await internalVault.cleanupInterruptedWrites();
  const bus = new EventBus();

  const configSource: ConfigSource = {
    path: `${options.vaultPath}/${CONFIG_PATH}`,
    load: () => readOptionalVaultFile(internalVault, CONFIG_PATH),
  };
  const config = await loadNotientConfig(configSource);
  const envSource = await readEnvSource(internalVault, process.env);
  const configured = resolveSettings(config, envSource);
  const providerCredentials = resolveProviderCredentials(envSource);
  const selection = await resolveStartupModels(configured, providerCredentials);
  const settings = new SettingsService(applyResolvedModels(configured, selection), {
    config,
    load: configSource.load,
    compareAndSwap: (before, after, authorize) =>
      before === null
        ? internalVault.createIfAbsent(CONFIG_PATH, after, async () => {
            await authorize?.();
          })
        : internalVault.writeIfUnchanged(CONFIG_PATH, before, after, async () => {
            await authorize?.();
          }),
  });
  const current = settings.get();

  // `settings.indexer.excludePaths` / `excludeGlobs` shipped as declared
  // but unconsumed config, so the daemon indexed Notient's own
  // conversation transcripts and proposals and served them back as top
  // search hits. One predicate is compiled here and
  // threaded through every entry point that can put a path into the
  // graph: the vault listing, the indexer queue, the watcher and the
  // awaken/reindex handlers.
  const indexExclusion = makeExclusionPredicate({
    excludePaths: current.indexer.excludePaths,
    excludeGlobs: current.indexer.excludeGlobs,
  });
  vault.setExclusion(indexExclusion);
  for (const warning of selection.warnings) {
    process.stderr.write(
      `${JSON.stringify({ type: "daemon:model_selection_warning", warning })}\n`,
    );
  }
  if (selection.warnings.length > 0 || selection.reason.length > 0) {
    process.stderr.write(
      `${JSON.stringify({ type: "daemon:model_selection", reason: selection.reason })}\n`,
    );
  }

  const lockHandle = options.lockHandle;

  const baseUrl = current.primary.baseUrl;
  const primaryLLM = new LMStudioProvider({
    baseUrl,
    ...(providerCredentials.chatApiKey === undefined
      ? {}
      : { apiKey: providerCredentials.chatApiKey }),
  });
  const deepLLM = new LMStudioProvider({
    baseUrl: current.deep.baseUrl,
    ...(providerCredentials.chatApiKey === undefined
      ? {}
      : { apiKey: providerCredentials.chatApiKey }),
  });
  const embeddingLLM = new LMStudioProvider({
    baseUrl: current.embedding.baseUrl,
    ...(providerCredentials.embeddingApiKey === undefined
      ? {}
      : { apiKey: providerCredentials.embeddingApiKey }),
  });

  const health = new HealthMonitor(
    [
      { label: "primary", baseUrl, provider: primaryLLM },
      { label: "deep", baseUrl: current.deep.baseUrl, provider: deepLLM },
      { label: "embedding", baseUrl: current.embedding.baseUrl, provider: embeddingLLM },
    ],
    bus,
    { intervalMs: 30_000 },
  );

  // SurrealDB bootstrap runs ahead of kernel registration so every service
  // receives one live, non-optional connection. Order: secret, server, SDK,
  // schema, then kernel registration.
  let embeddingProbe: ResolvedEmbeddingIdentity | null = null;
  const surrealSecret = await readOrGenerateSecret(vaultSecretPath(options.vaultPath));
  const surrealHandle = await startSurreal({
    dataDir: vaultDataDir(options.vaultPath),
    secret: surrealSecret,
    portFile: vaultPortPath(options.vaultPath),
    pidFile: vaultPidPath(options.vaultPath),
    logLevel: current.surrealdb.logLevel,
    hnswCacheMib: current.surrealdb.hnswCacheMib,
    onUnexpectedExit: (code) => {
      process.stderr.write(`${JSON.stringify({ type: "daemon:db_failed", code: code ?? -1 })}\n`);
    },
  });
  const surrealConnection = await connectSurreal({
    url: surrealHandle.url,
    user: "root",
    pass: surrealSecret,
    namespace: "notient",
    database: "vault",
  });
  try {
    embeddingProbe = await probeEmbedding({
      provider: embeddingLLM,
      model: current.embedding.model,
      signal: AbortSignal.timeout(2000),
    });
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        type: "daemon:embedding_probe_failed",
        model: current.embedding.model,
        baseUrl: current.embedding.baseUrl,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
  await applySchema(
    surrealConnection.db,
    surrealSecret,
    embeddingProbe === null
      ? { embedDim: null, embedModel: null }
      : { embedDim: embeddingProbe.dimension, embedModel: embeddingProbe.model },
  );
  const embeddingIdentity = createEmbeddingIdentity(
    current.embedding.model,
    embeddingProbe?.dimension ?? null,
  );
  const runOrphans = await reconcileRunOrphans(surrealConnection.db, {
    reason: DAEMON_RESTART_ORPHAN_REASON,
  });
  process.stderr.write(
    `${JSON.stringify({
      type: "daemon:run_orphans_reconciled",
      awakenRuns: runOrphans.awakenRuns,
      agentRuns: runOrphans.agentRuns,
    })}\n`,
  );

  // Register substrate services before higher-level indexing and chat wiring.
  const kernel = new Kernel();
  kernel.register("bus", bus);
  kernel.register("settings", settings);
  kernel.register("vault", vault);
  kernel.register("primaryLLM", primaryLLM);
  kernel.register("deepLLM", deepLLM);
  kernel.register("embeddingLLM", embeddingLLM);
  kernel.register("health", health);
  kernel.register("lock", lockHandle);
  const agentEventStore = new AgentEventStore({
    db: surrealConnection.db,
    bus,
    maxRows: current.agentEvents.maxRows,
  });
  kernel.register("agentEventStore", agentEventStore);
  const sessionGrants = new SessionGrants({ db: surrealConnection.db, now: Date.now });
  kernel.register("sessionGrants", sessionGrants);
  kernel.register("awakenBackgroundRegistry", new AwakenBackgroundRegistry());
  kernel.register("indexExclusion", indexExclusion);
  kernel.register("surrealDb", surrealConnection);

  // Indexing and retrieval services.
  const reasoningScheduler = new ReasoningScheduler({
    maxConcurrent: current.chat.reasoningSlots,
  });
  const embedder = new Embedder(embeddingLLM, {
    identity: embeddingIdentity,
    concurrency: current.indexer.concurrency.embed,
    resolveIdentity: async (signal) => {
      const identity = await probeEmbedding({
        provider: embeddingLLM,
        model: current.embedding.model,
        signal,
      });
      await applySchema(surrealConnection.db, surrealSecret, {
        embedDim: identity.dimension,
        embedModel: identity.model,
      });
      return identity;
    },
  });
  const extractor = new Extractor(deepLLM, {
    model: current.deep.reasoningModel,
    concurrency: current.indexer.concurrency.extract,
    scheduler: reasoningScheduler,
  });

  const sentienceActivity = new SentienceActivity(bus, {
    loadActiveNote: async () => {
      const [rows] = await surrealConnection.db
        .query<[Array<{ path: string }>]>(
          "SELECT path, last_user_edit_at FROM note WHERE last_user_edit_at != NONE AND tombstoned_at = NONE ORDER BY last_user_edit_at DESC LIMIT 1;",
        )
        .collect<[Array<{ path: string }>]>();
      return rows[0]?.path ?? null;
    },
  });
  const reranker = new Reranker({
    provider: deepLLM,
    model: current.deep.rerankerModel,
    bus,
  });

  const vitalsService = new VitalsService({
    db: surrealConnection.db,
    now: () => Date.now(),
    settings: () => current.vitals,
    facade: {
      updateFrontmatter: (path, patch) => vault.updateFrontmatter(path, patch),
    },
  });

  // SearchPipeline reads kNN, BM25, and approved graph expansion directly
  // through the required SurrealDB connection.
  const indexReadiness = new IndexReadiness(bus, indexExclusion);
  const graph = new GraphService({
    db: surrealConnection.db,
    vault,
    indexing: () => indexReadiness.snapshot(),
    isExcluded: indexExclusion,
  });
  kernel.register("graph", graph);
  const searchPipeline = new SearchPipeline({
    indexing: () => indexReadiness.snapshot(),
    vault,
    db: surrealConnection.db,
    reranker,
    embed: async (text, signal) => {
      const vectors = await embedder.embed([text], signal);
      return vectors.length > 0 ? new Float32Array(vectors[0]) : null;
    },
    provider: deepLLM,
    reasoningModel: current.deep.reasoningModel,
    scheduler: reasoningScheduler,
    settings: () => current.search,
  });

  kernel.register(
    "analysis",
    new NoteAnalysis({
      vault,
      search: searchPipeline,
      provider: primaryLLM,
      scheduler: reasoningScheduler,
      settings: () => ({
        model: settings.get().primary.reasoningModel,
        contextTokens: settings.get().chat.modelContextTokens,
      }),
      indexing: () => indexReadiness.snapshot(),
    }),
  );

  const linker = new Linker({
    db: surrealConnection.db,
    provider: deepLLM,
    reasoningModel: current.deep.reasoningModel,
  });
  const agentRunExecutor = new AgentRunExecutor({
    db: surrealConnection.db,
    bus,
    scheduler: reasoningScheduler,
    now: Date.now,
  });
  const runLinker = agentRunExecutor.bind(linker);

  const indexer = new IndexerQueue({
    readiness: indexReadiness,
    bus,
    debounceMs: current.indexer.debounceMs,
    isExcluded: indexExclusion,
    indexNote: async (path, context) => {
      const body = await vault.read(path);
      return await indexNote({
        notePath: path,
        noteBody: body,
        embedder,
        extractor,
        bus,
        chunkSizes: current.indexer.chunk,
        surrealDb: surrealConnection,
        runLinker,
        // Watching grants structural indexing only. Model work is scheduled
        // by explicit pipeline policy or a deliberate live tier request.
        tierFilter: context.tierFilter ?? [1],
      });
    },
  });

  kernel.register("indexer", indexer);
  kernel.register("embedder", embedder);
  kernel.register("extractor", extractor);
  kernel.register("sentienceActivity", sentienceActivity);
  kernel.register("daemonMutationJournal", daemonMutationJournal);
  kernel.register("reasoningScheduler", reasoningScheduler);
  kernel.register("agentRunExecutor", agentRunExecutor);
  kernel.register("searchPipeline", searchPipeline);
  kernel.register("vitalsService", vitalsService);

  // Conversation and write-approval services.

  const conversationStore = new ConversationStore({
    facade: {
      list: async (folder) => (await vault.list(folder)).files,
      read: (path) => vault.read(path),
      createIfAbsent: (path, content) => vault.createIfAbsent(path, content),
      writeIfUnchanged: (path, expected, content) =>
        vault.writeIfUnchanged(path, expected, content),
      removeIfUnchanged: (path, expected) => vault.removeIfUnchanged(path, expected),
    },
    folder: CONVERSATIONS_FOLDER,
    now: () => Date.now(),
  });

  const conversationIndex = new ConversationIndex({
    db: surrealConnection.db,
    identity: embeddingIdentity,
  });
  await conversationIndex.reconcile(await conversationStore.list());

  const notesFacade = {
    readNote: (path: string) => vault.read(path),
    exists: (path: string) => vault.exists(path),
  };

  // History is backed by the same required SurrealDB connection.
  const surrealDbConnection = surrealConnection;
  const updateNoteSha = async (notePath: string, sha: string): Promise<void> => {
    await surrealDbConnection.db
      .query(
        "UPDATE note SET sha = $sha, tier1_at = NONE, tier2_at = NONE, tier3_at = NONE WHERE path = $path AND sha != $sha;",
        { path: notePath, sha },
      )
      .collect();
  };
  const inverters = buildHistoryInverters({
    readNote: notesFacade.readNote,
    writeNoteIfUnchanged: (path, expected, content, authorize) =>
      vault.writeIfUnchanged(path, expected, content, authorize),
    removeNoteIfUnchanged: (path, expected, authorize) =>
      vault.removeIfUnchanged(path, expected, authorize),
    moveNoteIfUnchanged: (from, to, expected, authorize) =>
      vault.moveIfUnchanged(from, to, expected, authorize),
    noteExists: notesFacade.exists,
    hash: sha256Hex,
    updateNoteSha,
    validateTargetIdentity: (row) => validateProposalHistoryTarget(surrealDbConnection, row),
  });
  const historyService = new HistoryService({
    db: surrealDbConnection.db,
    vault,
    authorizeCaller: options.authorizeCaller,
    inverters,
    retention: {
      max: current.chat.history.maxEntries,
      maxPerTarget: current.chat.history.maxPerTarget,
    },
  });

  const authorizeIdentity = identityAuthorizer(options);
  const authorizeTool = (proof: Parameters<typeof assertToolApproval>[0]) =>
    assertToolApproval(proof, {
      authorizeIdentity,
      grant: (id) => sessionGrants.get(id),
      policy: () => settings.refreshToolPolicy(),
    });
  const durableNoteWriter = new DurableNoteWriter({
    db: surrealDbConnection.db,
    vault,
    hash: sha256Hex,
    authorizeRecovery: async (intent) => {
      if (intent.previewId)
        await changes.authorizeRecoveredEffect({ previewId: intent.previewId }, intent);
      else {
        if (!intent.toolApproval)
          throw new EffectAuthorityRevoked("interrupted tool write requires a fresh approval");
        assertToolTarget(intent.toolApproval, intent.clientIdentity, { path: intent.target });
        await authorizeTool(intent.toolApproval);
      }
    },
    pruneHistory: () => historyService.prune(),
    onMaintenanceError: (error) => {
      process.stderr.write(
        `${JSON.stringify({ type: "daemon:history_prune_failed", error: String(error) })}\n`,
      );
    },
  });
  // Close the crash window between any terminal receipt and its post-commit
  // retention maintenance before accepting another write.
  await historyService.prune();
  let mutationRecoveryComplete = !options.deferMutationRecovery;
  const reconcileNotes = async (): Promise<boolean> => {
    const result = await durableNoteWriter.reconcilePendingWrites();
    if (result.replayed || result.abandoned || result.failed || result.deferred)
      process.stderr.write(
        `${JSON.stringify({ type: "daemon:note_write_reconcile_summary", ...result })}\n`,
      );
    assertMutationReconciliationSucceeded("ordinary note write", result.failed);
    return result.deferred === 0;
  };

  const approvalService = new ApprovalService({
    db: surrealDbConnection.db,
    bus,
    vault,
    hash: sha256Hex,
    pruneHistory: () => historyService.prune(),
    authorizeRecovery: async (edgeId, transition) => {
      if ((await reviewsForEdge(surrealDbConnection.db, edgeId)).length)
        await changes.authorizeRecoveredEffect({ edgeId }, transition);
      else {
        if (!transition.toolApproval)
          throw new EffectAuthorityRevoked("interrupted relationship needs a fresh approval");
        assertToolTarget(transition.toolApproval, transition.clientIdentity, { edgeId });
        await authorizeTool(transition.toolApproval);
      }
    },
  });

  const { changes, jobs, coordinator } = makePipelineServices({
    db: surrealDbConnection.db,
    vault,
    settings,
    bus,
    writer: durableNoteWriter,
    approvals: approvalService,
    embedder,
    extractor,
    scheduler: reasoningScheduler,
    search: searchPipeline,
    provider: primaryLLM,
    activity: sentienceActivity,
    authorizeCaller: options.authorizeCaller,
  });
  jobs.suspend();
  await jobs.recover();
  kernel.register("changes", changes);
  kernel.register("jobs", jobs);
  kernel.register("coordinator", coordinator);

  // Exclusions are a startup privacy invariant. Once a path becomes private,
  // no stale non-tombstoned chunks or semantic rows may remain searchable
  // until the operator happens to run awaken/reindex.
  const bootPurgedPaths = await purgeExcludedNotes(
    surrealDbConnection,
    indexExclusion,
    approvalService,
  );
  if (bootPurgedPaths.length > 0) {
    process.stderr.write(
      `${JSON.stringify({ type: "daemon:excluded_notes_purged", paths: bootPurgedPaths })}\n`,
    );
  }

  const approvalGate = new ApprovalGate({
    recordHistoryAutoApprove: buildRecordHistoryAutoApprove(historyService),
    perToolPolicy: () => settings.get().chat.perTool,
    authorize: authorizeTool,
    sessionGrants,
  });

  const toolRegistry = buildAgentToolRegistry({
    analysis: kernel.get("analysis"),
    graph: kernel.get("graph"),
    db: surrealDbConnection.db,
    searchPipeline,
    vitalsService,
    vaultFacade: vault,
    notesFacade,
    approvalGate,
    approvalService,
    changes,
    authorizeIdentity,
    hash: sha256Hex,
    approvalMode: () => settings.get().chat.approvalMode,
    applyWrite: (record) => durableNoteWriter.apply(record),
    generateCallId: () =>
      `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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
    engagedNotePath: () => sentienceActivity.snapshot().activeNotePath,
    facade: { readNote: (path) => vault.read(path) },
    approvalMode: () => settings.get().chat.approvalMode,
    toolCatalog: () =>
      toolRegistry.list().map((entry) => ({
        name: entry.name,
        description: entry.description,
      })),
    estimateTokens: (text) => Math.ceil(text.length / 4),
    summaryModel: current.primary.reasoningModel,
  });

  // Tool-mode detection is learned process state, not product configuration.
  // A restart deliberately probes again against the currently deployed model.
  const toolModeStore = new Map<string, ToolMode>();
  const toolModeCache: ToolModeCache = {
    read: (model) => toolModeStore.get(model) ?? null,
    write: async (model, mode) => {
      toolModeStore.set(model, mode);
    },
  };

  const chatService = new ChatService({
    provider: primaryLLM,
    contextManager,
    conversationStore,
    conversationIndex,
    toolRegistry,
    scheduler: reasoningScheduler,
    toolModeCache,
    embed: embedSingle,
    bus,
    settings: (): ChatRuntimeSettings => ({
      model: settings.get().primary.reasoningModel,
      maxRoundsPerTurn: settings.get().chat.maxRoundsPerTurn,
      budget: settings.get().chat.budget,
      approvalMode: settings.get().chat.approvalMode,
      persistReasoning: settings.get().chat.persistReasoning,
    }),
  });

  const transcriptDistiller = createTranscriptDistiller({
    provider: primaryLLM,
    model: current.primary.reasoningModel,
    scheduler: reasoningScheduler,
  });

  kernel.register("conversationStore", conversationStore);
  kernel.register("conversationIndex", conversationIndex);
  kernel.register("approvalGate", approvalGate);
  kernel.register("toolRegistry", toolRegistry);
  kernel.register("toolModeCache", toolModeCache);
  kernel.register("contextManager", contextManager);
  kernel.register("chatService", chatService);
  kernel.register("historyService", historyService);
  kernel.register("durableNoteWriter", durableNoteWriter);
  kernel.register("approvalService", approvalService);
  kernel.register("transcriptDistiller", transcriptDistiller);

  // Vision is a capability of the deployed primary model, not a second
  // persisted model/endpoint authority. Bootstrap omits the slot when the
  // primary probe fails; chat.send then returns VISION_UNAVAILABLE.
  const visionConfig = { enabled: false, baseUrl: "", model: "" };
  const visionRouter = await optionalVisionProbe({
    enabled: canProbeVision(current, selection.warnings),
    primaryLLM,
    primaryModel: current.primary.reasoningModel,
    visionConfig,
    scheduler: reasoningScheduler,
    makeFallback: () => primaryLLM,
  });
  if (visionRouter !== null) {
    kernel.register("visionLLM", visionRouter);
  }

  kernel.seal({ phase: "C" });
  if (mutationRecoveryComplete) await reconcileNotes();
  health.start();
  // Replay approve-and-write rows that landed in state 2 of the pending-state
  // contract (approved=true, applied=false) before a daemon crashed. Mutation
  // admission stays closed until every row reconciles successfully; logging a
  // failure and continuing would admit a competing proposal application.
  const reconcileApprovals = async (): Promise<boolean> => {
    const result = await approvalService.reconcilePendingApplications();
    process.stderr.write(`${JSON.stringify({ type: "daemon:reconcile_summary", ...result })}\n`);
    assertMutationReconciliationSucceeded("approved proposal", result.failed);
    return result.deferred === 0;
  };
  const approvalReconciliation = mutationRecoveryComplete
    ? reconcileApprovals().then(() => {})
    : Promise.resolve();
  await approvalReconciliation;
  let recoveryFlight: Promise<boolean> | null = null;
  const resumeMutationRecovery = (): Promise<boolean> => {
    if (mutationRecoveryComplete) return Promise.resolve(true);
    if (recoveryFlight) return recoveryFlight;
    recoveryFlight = (async () => {
      const notesReady = await reconcileNotes();
      const approvalsReady = await reconcileApprovals();
      mutationRecoveryComplete = notesReady && approvalsReady;
      return mutationRecoveryComplete;
    })().finally(() => {
      recoveryFlight = null;
    });
    return recoveryFlight;
  };

  // Model repair now runs only through the explicitly enabled index/extract
  // policy; migration flags remain durable through disabled periods.

  return {
    kernel,
    mutationsReady: () => mutationRecoveryComplete,
    resumeMutationRecovery,
    fetchPrimaryModelCatalog: (timeoutMs) =>
      fetchEndpointModelCatalog({
        baseUrl: current.primary.baseUrl,
        ...(providerCredentials.chatApiKey === undefined
          ? {}
          : { apiKey: providerCredentials.chatApiKey }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
    settleMaintenanceBackground: async () => {
      await approvalReconciliation;
      await recoveryFlight;
    },
    close: async () => {
      await recoveryFlight?.catch(() => {});
      await shutdownBootstrap({
        agentEventStore,
        approvalReconciliation,
        chatService,
        coordinator,
        health,
        sentienceActivity,
        indexer,
        lockHandle,
        surrealConnection,
        surrealHandle,
      });
    },
  };
}

export function assertMutationReconciliationSucceeded(
  authority: "ordinary note write" | "approved proposal",
  failed: number,
): void {
  if (!Number.isSafeInteger(failed) || failed < 0) {
    throw new Error(`${authority} reconciliation returned an invalid failed count`);
  }
  if (failed === 0) return;
  throw new Error(
    `notient: ${authority} reconciliation failed for ${failed} durable operation(s); mutation admission remains closed`,
  );
}

async function optionalVisionProbe(
  input: Parameters<typeof probeVisionRoute>[0] & { enabled: boolean },
) {
  return input.enabled ? await probeVisionRoute(input).catch(() => null) : null;
}

function canProbeVision(settings: NotientSettings, warnings: string[]): boolean {
  return Boolean(
    settings.primary.baseUrl && settings.primary.reasoningModel && warnings.length === 0,
  );
}

export async function resolveStartupModels(
  current: NotientSettings,
  credentials: ProviderCredentials,
) {
  const unavailable = {
    chatModel: current.primary.reasoningModel,
    embeddingModel: current.embedding.model,
    reason: "Core local operation is available; model discovery is unavailable or unconfigured.",
    warnings: [
      "Inference capabilities are unavailable until a model endpoint is configured and reachable.",
    ],
  };
  if (!current.primary.baseUrl) return unavailable;
  try {
    const catalog = await fetchEndpointModelCatalog({
      baseUrl: current.primary.baseUrl,
      timeoutMs: 2000,
      ...(credentials.chatApiKey === undefined ? {} : { apiKey: credentials.chatApiKey }),
    });
    const embeddingCatalog =
      current.embedding.baseUrl === current.primary.baseUrl &&
      credentials.embeddingApiKey === credentials.chatApiKey
        ? catalog
        : await fetchEndpointModelCatalog({
            baseUrl: current.embedding.baseUrl,
            timeoutMs: 2000,
            ...(credentials.embeddingApiKey === undefined
              ? {}
              : { apiKey: credentials.embeddingApiKey }),
          });
    return resolveEndpointModels({ settings: current, catalog, embeddingCatalog });
  } catch {
    return unavailable;
  }
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
  moveNoteIfUnchanged?: (
    from: string,
    to: string,
    expected: string,
    beforeEffect?: () => Promise<void>,
  ) => Promise<boolean>;
  readNote: (path: string) => Promise<string>;
  writeNoteIfUnchanged: (
    path: string,
    expected: string,
    content: string,
    beforeEffect?: () => Promise<void>,
  ) => Promise<boolean>;
  removeNoteIfUnchanged: (
    path: string,
    expected: string,
    beforeEffect?: () => Promise<void>,
  ) => Promise<boolean>;
  noteExists: (path: string) => Promise<boolean>;
  hash: (content: string) => Promise<string>;
  /** Refreshes `note.sha` after restoring a prior body. */
  updateNoteSha: (path: string, sha: string) => Promise<void>;
  /** Verifies an approval receipt still names the note at this path. */
  validateTargetIdentity: (row: HistoryRow) => Promise<boolean>;
}

/** Build the canonical body inverter for every reversible note mutation. */
export function buildHistoryInverters(options: BuildHistoryInvertersOptions): InverterRegistry {
  const noteBody = makeNoteBodyInverter({
    facade: {
      exists: options.noteExists,
      read: options.readNote,
      writeIfUnchanged: options.writeNoteIfUnchanged,
      removeIfUnchanged: options.removeNoteIfUnchanged,
    },
    hash: options.hash,
    updateNoteSha: options.updateNoteSha,
    validateTargetIdentity: options.validateTargetIdentity,
  });
  return {
    "notes.move": async (row, context) => {
      const after = row.after as { path?: unknown; body?: unknown } | null;
      if (
        !options.moveNoteIfUnchanged ||
        !after ||
        typeof after.path !== "string" ||
        typeof after.body !== "string" ||
        typeof row.before !== "string"
      )
        throw new HistoryOperationError(
          "HISTORY_INVALID_PAYLOAD",
          "move receipt is missing its exact path/body snapshot",
        );
      if (
        !(await options.noteExists(after.path)) &&
        (await options.noteExists(row.target)) &&
        (await options.readNote(row.target)) === row.before
      )
        return;
      if (
        !(await options.moveNoteIfUnchanged(after.path, row.target, after.body, context?.authorize))
      )
        throw historyConflict(row.id);
    },
    "notes.create": noteBody,
    "notes.append": noteBody,
    "notes.replace_section": noteBody,
    "notes.update_frontmatter": noteBody,
    "note.append_section": noteBody,
    "note.frontmatter": noteBody,
  };
}

export async function validateProposalHistoryTarget(
  connection: SurrealConnection,
  row: HistoryRow,
): Promise<boolean> {
  if (row.proposalEdge === null) return row.proposalCreatedAt === null;
  if (row.proposalCreatedAt === null) return false;
  const edge = parseSurrealRelationRecordId(
    row.proposalEdge,
    WRITEBACK_EDGE_TABLES,
    "history proposal edge",
  ).recordId;
  const [rows] = await connection.db
    .query<[Array<{ id: typeof edge }>]>(
      "SELECT id FROM $edge WHERE created_at = <datetime>$createdAt AND in.path = $target AND in.tombstoned_at IS NONE;",
      {
        edge,
        createdAt: row.proposalCreatedAt,
        target: row.target,
      },
    )
    .collect<[Array<{ id: typeof edge }>]>();
  if (rows.length === 0) return false;
  if (rows.length !== 1 || rows[0]?.id.toString() !== edge.toString()) {
    throw new Error("history storage integrity: proposal target validation returned invalid rows");
  }
  return true;
}

export interface EmbeddingRepairHandle {
  abort(): void;
  completion: Promise<void>;
}

function startEmbeddingRepairTask(options: {
  db: SurrealConnection["db"];
  indexer: IndexerQueue;
  runLinker: AgentRunCapability<"linker">;
}): EmbeddingRepairHandle {
  const controller = new AbortController();

  const completion = runEmbeddingRepair({
    db: options.db,
    indexer: options.indexer,
    runLinker: options.runLinker,
    signal: controller.signal,
  })
    .then((result) => {
      process.stderr.write(
        `${JSON.stringify({ type: "daemon:embedding_repair_complete", ...result })}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({
          type: "daemon:embedding_repair_failed",
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    });

  return { abort: () => controller.abort(), completion };
}

export interface BootstrapShutdownDeps {
  lockHandle: Pick<VaultLockHandle, "release">;
  health: Pick<HealthMonitor, "stop">;
  sentienceActivity: Pick<SentienceActivity, "stop">;
  coordinator: Pick<Coordinator, "stop" | "idle">;
  indexer: Pick<IndexerQueue, "stopAccepting" | "drain" | "dispose">;
  agentEventStore: Pick<AgentEventStore, "dispose" | "drain">;
  chatService: Pick<ChatService, "drain">;
  /** Fire-and-forget boot reconciliation that uses the SurrealDB SDK. */
  approvalReconciliation?: Promise<void>;
  /**
   * Canonical SurrealDB SDK connection. Closed after service drains so the
   * server sees a clean client disconnect before its child process stops.
   */
  surrealConnection: { close(): Promise<void> };
  /**
   * Canonical SurrealDB child-process handle. Stopped after the SDK has been
   * closed. Order is fixed: SDK close, then child stop, never the reverse.
   */
  surrealHandle: { stop(): Promise<void> };
  /**
   * Boot-time embedding repair. Abort and await it before closing SurrealDB so
   * an in-flight linker cannot race a torn-down SDK connection. Any unfinished
   * note keeps its durable pending flag and resumes on the next boot.
   */
  embeddingRepair?: EmbeddingRepairHandle;
}

/**
 * Tear down bootstrap-owned services without allowing queued indexing or
 * tracked ledger writes to outlive the SDK connection. The daemon closes RPC
 * admission, drains active RPC handlers, stops the watcher, and applies its
 * awaken-worker fence before calling this function. This closes the remaining
 * internal producers and applies one strict drain order.
 */
export async function shutdownBootstrap(deps: BootstrapShutdownDeps): Promise<void> {
  // Stop every bootstrap-owned source that can enqueue indexing or emit a
  // persisted ledger event. Already-accepted work remains drainable.
  deps.health.stop();
  deps.sentienceActivity.stop();
  deps.coordinator.stop();
  deps.indexer.stopAccepting();

  if (deps.embeddingRepair) {
    deps.embeddingRepair.abort();
    await deps.embeddingRepair.completion.catch(() => {
      // The startup wrapper already reports repair failures. Shutdown must
      // continue so the durable pending flags can drive the next boot.
    });
  }

  if (deps.approvalReconciliation) {
    await deps.approvalReconciliation.catch(() => {
      // The startup wrapper already reports reconciliation failures.
    });
  }

  // Post-turn summary jobs can still persist Markdown and conversation-memory
  // rows. RPC admission is already closed by the caller, so drain every
  // accepted refresh before the SurrealDB connection can be torn down.
  await deps.chatService.drain();

  // A stopped coordinator can still have runs in flight. Let them finish
  // while the event ledger and SDK are live, then finish all accepted index
  // work before disposing the queue.
  await deps.coordinator.idle();
  await deps.indexer.drain();
  deps.indexer.dispose();

  // Unsubscribe only after the last producer is quiescent, then await every
  // ledger write whose bus callback already started.
  deps.agentEventStore.dispose();
  await deps.agentEventStore.drain();

  await deps.surrealConnection.close().catch(() => {
    // SDK close errors are swallowed so subsequent shutdown steps run.
  });
  await deps.surrealHandle.stop().catch(() => {
    // Child stop errors are swallowed so subsequent shutdown steps run.
  });
  await deps.lockHandle.release();
}
