import { MarkdownView, Notice, Plugin, TFile, type WorkspaceLeaf } from "obsidian";
import { ObsidianFacade } from "./adapters/obsidianFacade";
import { ContradictionHunter } from "./core/agents/contradictionHunter";
import { Linker } from "./core/agents/linker";
import { MaturityAdvancer } from "./core/agents/maturityAdvancer";
import { Synthesizer } from "./core/agents/synthesizer";
import { ApprovalService } from "./core/approvals/approvalService";
import { generateSynthesisCanvas } from "./core/canvas/canvasGenerator";
import { ApprovalGate } from "./core/chat/approvalGate";
import { type ChatRuntimeSettings, ChatService } from "./core/chat/chatService";
import { ContextManager } from "./core/chat/contextManager";
import { ConversationIndex } from "./core/chat/conversationIndex";
import { ConversationStore } from "./core/chat/conversationStore";
import type { ToolMode, ToolModeCache } from "./core/chat/toolModeProbe";
import { makeContradictionCheckTool, makeSynthesizeTool } from "./core/chat/tools/agents";
import { makeFindPathTool } from "./core/chat/tools/graph";
import {
  makeAppendNoteTool,
  makeCreateNoteTool,
  makeHistoryRecorder,
  makeReplaceSectionTool,
  makeUpdateFrontmatterTool,
} from "./core/chat/tools/notes";
import { makeGetProposalTool, makeListProposalsTool } from "./core/chat/tools/proposals";
import { ToolRegistry } from "./core/chat/tools/registry";
import {
  makeGetVitalsTool,
  makeListNeighborsTool,
  makeReadNoteTool,
  makeVaultSearchTool,
} from "./core/chat/tools/vault";
import { CoAuthorService } from "./core/coAuthor/chatStream";
import { Coordinator } from "./core/coordinator/coordinator";
import { ReasoningMutex } from "./core/coordinator/reasoningMutex";
import { Database } from "./core/db/database";
import { EventBus } from "./core/events/eventBus";
import { GraphStore } from "./core/graph/graphStore";
import { NativeGraphBridge } from "./core/graph/nativeGraphBridge";
import { HistoryService } from "./core/history/historyService";
import { makeEdgeApproveInverter } from "./core/history/inverters/edgeApprove";
import { makeEdgeRejectInverter } from "./core/history/inverters/edgeReject";
import { makeNodeApproveInverter } from "./core/history/inverters/nodeApprove";
import { makeNodeRejectInverter } from "./core/history/inverters/nodeReject";
import { makeNoteAppendSectionInverter } from "./core/history/inverters/noteAppendSection";
import { makeNoteCreateInverter } from "./core/history/inverters/noteCreate";
import { makeNoteFrontmatterInverter } from "./core/history/inverters/noteFrontmatter";
import { makeNoteMaturityInverter } from "./core/history/inverters/noteMaturity";
import type { InverterRegistry } from "./core/history/types";
import { Embedder } from "./core/indexer/embedder";
import { isExcluded, normalizeExcludePatterns } from "./core/indexer/excludePaths";
import { Extractor } from "./core/indexer/extractor";
import { HnswVectorIndex } from "./core/indexer/hnswVectorIndex";
import { indexNote } from "./core/indexer/indexNote";
import { IndexerQueue } from "./core/indexer/indexerQueue";
import { createIndexerRuntimeConfig } from "./core/indexer/indexerRuntime";
import { Kernel } from "./core/kernel";
import { LMStudioProvider } from "./core/llm/lmStudioProvider";
import { Reranker } from "./core/search/reranker";
import { SavedQueries } from "./core/search/savedQueries";
import { SearchHistory } from "./core/search/searchHistory";
import { SearchPipeline } from "./core/search/searchPipeline";
import { EchoGuard } from "./core/services/echoGuard";
import { HealthMonitor } from "./core/services/healthMonitor";
import { IdleDetector } from "./core/services/idleDetector";
import { VaultBootstrap } from "./core/services/vaultBootstrap";
import { VaultLock, type VaultLockHandle } from "./core/services/vaultLock";
import { NotientSettingsTab } from "./core/settings/SettingsTab";
import { SettingsService } from "./core/settings/settingsService";
import { StreamService } from "./core/stream/streamService";
import type { StreamItem } from "./core/stream/types";
import { VitalsService } from "./core/vitals/vitalsService";
import { ApprovalsView, VIEW_TYPE_NOTIENT_APPROVALS } from "./ui/approvals/ApprovalsView";
import { CoAuthorView, VIEW_TYPE_NOTIENT_CO_AUTHOR } from "./ui/coAuthor/CoAuthorView";
import { makeInsightsPlugin } from "./ui/editor/decorations/insightsPlugin";
import { AwakenVaultModal } from "./ui/onboarding/AwakenVaultModal";
import { AwakenRunner } from "./ui/onboarding/awakenRunner";
import { GraphCanvasModel } from "./ui/onboarding/graphCanvas";
import { SearchView, VIEW_TYPE_NOTIENT_SEARCH } from "./ui/search/SearchView";
import { CanvasFromResults, makeSlug } from "./ui/search/canvasFromResults";
import {
  type SearchAppActions,
  cancelDispatch as cancelSearchDispatch,
  dispatchSearch,
  pushHistory as pushSearchUiHistory,
  searchHistory as searchHistoryState,
  searchMode as searchModeState,
  searchQuery as searchQueryState,
  searchResult as searchResultState,
} from "./ui/search/state";
import {
  type AgentRun,
  pendingApprovalsState,
  recentRunsState,
  sidebarActions,
  tickState,
} from "./ui/sidebar/App";
import { NotientSidebarView, VIEW_TYPE_NOTIENT } from "./ui/sidebar/SidebarView";
import {
  type ChatActions,
  chatActions as chatActionsSignal,
  activeConversation as chatActiveConversation,
  conversationsList as chatConversationsList,
  pendingApprovals as chatPendingApprovals,
  persistReasoning as chatPersistReasoning,
  pinnedContext as chatPinnedContext,
  setChatRunner,
} from "./ui/sidebar/chat-state";
import {
  focusedProposalIdState,
  streamActions,
  streamItemsState,
} from "./ui/sidebar/components/StreamTab";
import { vitalsActions, vitalsSnapshotState } from "./ui/sidebar/components/VitalsTab";
import { setActiveTab } from "./ui/sidebar/state";

const PLUGIN_DIR = ".obsidian/plugins/notient";
const DB_PATH = `${PLUGIN_DIR}/notient.db`;
const WASM_PATH = `${PLUGIN_DIR}/sql-wasm.wasm`;
const LOCK_PATH = `${PLUGIN_DIR}/notient.lock`;
const VECTOR_PATH = `${PLUGIN_DIR}/vectors.bin`;
const SIDECAR_PATH = "Notient/.index.json";

export default class NotientPlugin extends Plugin {
  kernel = new Kernel();
  bus = new EventBus();
  settings!: SettingsService;
  private lockHandle: VaultLockHandle | null = null;
  echoGuard = new EchoGuard();
  indexOne!: (path: string) => Promise<unknown>;

  async onload(): Promise<void> {
    console.log("[Notient] onload");

    this.settings = new SettingsService(this, this.bus);
    await this.settings.load();
    this.addSettingTab(new NotientSettingsTab(this.app, this, this.settings));

    const adapter = this.app.vault.adapter;
    const lock = new VaultLock(
      {
        exists: (path) => adapter.exists(path),
        read: (path) => adapter.read(path),
        writeBinary: (path, data) => adapter.writeBinary(path, data),
        remove: (path) => adapter.remove(path),
      },
      LOCK_PATH,
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );

    try {
      this.lockHandle = await lock.acquire();
    } catch (error) {
      new Notice(`Notient: ${(error as Error).message}`);
      throw error;
    }

    const database = new Database(
      {
        readBinary: async (path) =>
          (await adapter.exists(path)) ? await adapter.readBinary(path) : null,
        writeBinary: (path, data) => adapter.writeBinary(path, data),
      },
      { dbPath: DB_PATH, wasmPath: WASM_PATH },
    );
    await database.init();

    const facade = new ObsidianFacade(this.app);
    const graph = new GraphStore(database);

    const current = this.settings.get();

    // (1) Vault bootstrap. Creates Notient/conversations, Notient/proposals,
    // and the saved-queries folder up-front so chat/search persistence never
    // races a missing parent.
    const vaultBootstrap = new VaultBootstrap({ facade });
    await vaultBootstrap.run({
      conversationsFolder: current.chat.conversationsFolder,
      proposalsFolder: current.chat.proposalsFolder,
      savedQueriesFolder: current.search.savedQueriesFolder,
    });

    const primaryLLM = new LMStudioProvider({ baseUrl: current.primary.baseUrl });
    const deepLLM = new LMStudioProvider({ baseUrl: current.deep.baseUrl });
    const embeddingLLM = new LMStudioProvider({ baseUrl: current.embedding.baseUrl });

    const vectorIndex = new HnswVectorIndex({ maxElements: 50_000 });
    if (await adapter.exists(VECTOR_PATH)) {
      const blob = await adapter.readBinary(VECTOR_PATH);
      await vectorIndex.load(blob);
    } else {
      await vectorIndex.init(768); // nomic-embed-text-v2-moe
    }

    const embedder = new Embedder(embeddingLLM, {
      model: current.embedding.model,
      batchSize: 16,
    });
    const extractor = new Extractor(primaryLLM, {
      model: current.primary.fastModel,
      concurrency: 4,
    });

    // Single-text embed shim used by SearchPipeline / ContextManager / ChatService.
    // Returns null on failure so callers can fall back to keyword search.
    const embedSingle = async (text: string, signal: AbortSignal): Promise<Float32Array | null> => {
      try {
        const vectors = await embedder.embed([text], signal);
        const first = vectors[0];
        if (!first) return null;
        return Float32Array.from(first);
      } catch {
        return null;
      }
    };

    const indexerRuntime = createIndexerRuntimeConfig();
    console.log("[Notient] indexer pipeline", indexerRuntime.mode);

    const indexOne = async (path: string): Promise<unknown> => {
      const body = await facade.read(path);
      const result = await indexNote({
        notePath: path,
        noteBody: body,
        database,
        graph,
        vectorIndex,
        embedder,
        extractor,
        bus: this.bus,
      });
      await database.persist();
      await adapter.writeBinary(VECTOR_PATH, await vectorIndex.persist());
      return result;
    };
    this.indexOne = indexOne;

    // (2) Indexer exclude paths. Closes the H1 audit gap: helpers existed but
    // no production code wired them. Both the queue and the modify handler
    // now skip Notient-owned folders so chat persistence does not loop back.
    const excludePatterns = normalizeExcludePatterns(current.indexer.excludePaths);
    const indexerQueue = new IndexerQueue({
      indexNote: indexOne,
      debounceMs: 500,
      bus: this.bus,
      isExcluded: (path) => isExcluded(path, excludePatterns),
    });

    const reasoningMutex = new ReasoningMutex();
    const idleDetector = new IdleDetector(this.bus);

    const linker = new Linker({
      db: database,
      provider: primaryLLM,
      reasoningModel: current.primary.reasoningModel,
      neighborhood: async (notePath, options) => {
        const head = database.query<{ id: string; vector: Uint8Array; dim: number }>(
          `SELECT e.chunk_id AS id, e.vector AS vector, e.dim AS dim
           FROM embeddings e JOIN chunks c ON c.id = e.chunk_id
           WHERE c.note_path = ? ORDER BY c.ord LIMIT 1;`,
          [notePath],
        );
        if (head.length === 0) return [];
        const view = new Float32Array(
          head[0].vector.buffer,
          head[0].vector.byteOffset,
          head[0].dim,
        );
        const hits = vectorIndex.search(view, options.topK);
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
      provider: primaryLLM,
      reasoningModel: current.primary.reasoningModel,
      epsilon: 0.18,
      minClusterSize: 3,
      sinceMs: 24 * 60 * 60 * 1000,
    });

    const contradictionHunter = new ContradictionHunter({
      db: database,
      provider: primaryLLM,
      reasoningModel: current.primary.reasoningModel,
      neighbors: async (recentClaimIds, options) => {
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
        const hits = vectorIndex.search(view, options.topK);
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
      facade,
      echoGuard: this.echoGuard,
      hash: sha256,
    });

    const coordinator = new Coordinator({
      bus: this.bus,
      db: database,
      mutex: reasoningMutex,
      agents: { linker, synthesizer, contradictionHunter, maturityAdvancer },
    });

    // (3) Native graph bridge. Wires approved LINKS_TO + typed-relation edges
    // back into note bodies / frontmatter so Obsidian's native graph view
    // re-renders without a custom GraphView.
    const historyServiceRef: { current: HistoryService | null } = { current: null };
    const recordHistory = (input: Parameters<HistoryService["record"]>[0]): Promise<number> => {
      if (!historyServiceRef.current) {
        throw new Error("HistoryService not initialized");
      }
      return historyServiceRef.current.record(input);
    };
    const nativeGraphBridge = new NativeGraphBridge({
      facade,
      echoGuard: this.echoGuard,
      hash: sha256,
      settings: () => this.settings.get().nativeGraph,
      recordHistory,
    });

    const approvalService = new ApprovalService({
      db: database,
      bus: this.bus,
      bridge: nativeGraphBridge,
      recordHistory,
    });

    const coAuthor = new CoAuthorService({
      db: database,
      bus: this.bus,
      provider: primaryLLM,
      reasoningModel: current.coAuthor.model,
      readNote: async (path) => facade.read(path),
      neighbors: (path) => {
        const rows = database.query<{ target_id: string }>(
          "SELECT target_id FROM graph_edges WHERE source_id = ? AND approved = 1 LIMIT 10;",
          [`note:${path}`],
        );
        return rows.map((r) => ({
          path: r.target_id.replace(/^note:/, ""),
          title: r.target_id,
          summary: "",
        }));
      },
      minWords: current.coAuthor.minWords,
    });

    const health = new HealthMonitor(
      [
        { label: "primary", baseUrl: current.primary.baseUrl, provider: primaryLLM },
        { label: "deep", baseUrl: current.deep.baseUrl, provider: deepLLM },
        { label: "embedding", baseUrl: current.embedding.baseUrl, provider: embeddingLLM },
      ],
      this.bus,
      { intervalMs: 30_000 },
    );

    // (4) Stream + Vitals services. Both are dep-injected from settings so
    // settings:changed events naturally reflect into ranking + vitals math.
    const streamService = new StreamService({
      db: database,
      bus: this.bus,
      now: () => Date.now(),
      getActivePath: () => this.app.workspace.getActiveFile()?.path ?? null,
      settings: () => this.settings.get().stream,
    });

    const vitalsService = new VitalsService({
      db: database,
      now: () => Date.now(),
      settings: () => this.settings.get().vitals,
      facade,
      echoGuard: this.echoGuard,
      hash: sha256,
    });

    // (5) Search pipeline. Reranker shares the chat model on mini.
    const reranker = new Reranker({
      provider: primaryLLM,
      model: current.primary.rerankerModel,
    });
    const searchPipeline = new SearchPipeline({
      db: database,
      provider: primaryLLM,
      vectorIndex,
      embed: embedSingle,
      reranker,
      reasoningModel: current.primary.reasoningModel,
      settings: () => ({
        balanced: this.settings.get().search.balanced,
        deep: this.settings.get().search.deep,
      }),
      now: () => Date.now(),
    });

    const sidecarFacade = {
      readSidecar: async (): Promise<Record<string, unknown> | null> => {
        if (!(await adapter.exists(SIDECAR_PATH))) return null;
        try {
          const raw = await adapter.read(SIDECAR_PATH);
          const parsed = JSON.parse(raw) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
          return parsed as Record<string, unknown>;
        } catch {
          return null;
        }
      },
      writeSidecar: async (value: Record<string, unknown>): Promise<void> => {
        await adapter.write(SIDECAR_PATH, JSON.stringify(value));
      },
    };

    const searchHistory = new SearchHistory({
      facade: sidecarFacade,
      maxQueries: current.search.history.maxQueries,
    });

    const savedQueries = new SavedQueries({
      facade: {
        list: async (folder) => {
          if (!(await adapter.exists(folder))) return [];
          const listing = await adapter.list(folder);
          return listing.files.filter((path) => path.endsWith(".md"));
        },
        read: (path) => adapter.read(path),
        write: (path, content) => facade.write(path, content),
        delete: (path) => adapter.remove(path),
      },
      folder: current.search.savedQueriesFolder,
      now: () => Date.now(),
    });

    const canvasFromResults = new CanvasFromResults({
      facade: {
        ensureFolder: async (path) => {
          if (await adapter.exists(path)) return;
          await this.app.vault.createFolder(path);
        },
        writeText: (path, content) => facade.write(path, content),
      },
      folder: current.search.savedQueriesFolder,
      now: () => Date.now(),
    });

    // (6) Conversation persistence + cross-session memory index.
    const conversationStore = new ConversationStore({
      facade: {
        list: async (folder) => {
          if (!(await adapter.exists(folder))) return [];
          const listing = await adapter.list(folder);
          return listing.files.filter((path) => path.endsWith(".md"));
        },
        read: (path) => adapter.read(path),
        write: (path, content) => facade.write(path, content),
        delete: (path) => adapter.remove(path),
      },
      folder: current.chat.conversationsFolder,
      now: () => Date.now(),
      echoGuard: this.echoGuard,
      hash: sha256Sync,
    });

    const conversationIndex = new ConversationIndex({
      facade: {
        read: async (path) => ((await adapter.exists(path)) ? await adapter.read(path) : null),
        write: (path, content) => adapter.write(path, content),
      },
      indexPath: SIDECAR_PATH,
    });
    await conversationIndex.load();

    // (7) Universal undo. The HistoryService is constructed before the chat
    // tools and approval gate so write tools can record into it via the
    // makeHistoryRecorder bridge. Inverters span every kind that ever lands
    // a row.
    const inverters: InverterRegistry = {
      "edge.approve": makeEdgeApproveInverter({ db: database }),
      "edge.reject": makeEdgeRejectInverter({ db: database }),
      "node.approve": makeNodeApproveInverter({
        db: database,
        facade,
        echoGuard: this.echoGuard,
        hash: sha256,
      }),
      "node.reject": makeNodeRejectInverter({ db: database }),
      "note.append_section": makeNoteAppendSectionInverter({
        facade,
        echoGuard: this.echoGuard,
        hash: sha256,
      }),
      "note.frontmatter": makeNoteFrontmatterInverter({
        facade,
        echoGuard: this.echoGuard,
        hash: sha256,
      }),
      "note.maturity": makeNoteMaturityInverter({
        db: database,
        facade,
        echoGuard: this.echoGuard,
        hash: sha256,
      }),
      "notes.create": makeNoteCreateInverter({
        facade,
        echoGuard: this.echoGuard,
        hash: sha256,
      }),
      "notes.append": makeNoteAppendSectionInverter({
        facade,
        echoGuard: this.echoGuard,
        hash: sha256,
      }),
      "notes.replace_section": makeNoteAppendSectionInverter({
        facade,
        echoGuard: this.echoGuard,
        hash: sha256,
      }),
      "notes.update_frontmatter": makeNoteFrontmatterInverter({
        facade,
        echoGuard: this.echoGuard,
        hash: sha256,
      }),
    };
    const historyService = new HistoryService({
      db: database,
      inverters,
      retention: {
        max: current.history.retentionMaxRows,
        maxPerTarget: current.history.retentionMaxRowsPerTarget,
      },
      now: () => Date.now(),
    });
    historyServiceRef.current = historyService;
    await historyService.prune();

    // (8) Approval gate for chat write tools. Pending approvals surface in
    // the ChatTab via the `pendingApprovals` signal; resolved cards are
    // removed from the same list.
    const approvalGate = new ApprovalGate({
      events: {
        onPending: (pending) => {
          chatPendingApprovals.value = [...chatPendingApprovals.value, pending];
        },
        onResolved: (callId) => {
          chatPendingApprovals.value = chatPendingApprovals.value.filter(
            (entry) => entry.callId !== callId,
          );
        },
      },
      recordHistoryAutoApprove: async () => {
        // The chat write tools record their own history rows on success. The
        // gate hook is reserved for an "auto-approval" trail; v1.0 leaves it
        // as a no-op so undo points only at real mutations.
      },
    });

    // (9) Chat tool registry. Read-only tools first, then write-gated.
    const toolRegistry = new ToolRegistry();
    const recordNoteHistory = makeHistoryRecorder(database, () => Date.now());
    toolRegistry.register(makeVaultSearchTool(searchPipeline));
    toolRegistry.register(makeReadNoteTool({ readNote: (path) => facade.read(path) }));
    toolRegistry.register(makeListNeighborsTool(database));
    toolRegistry.register(makeGetVitalsTool(vitalsService));
    toolRegistry.register(makeFindPathTool(database));
    toolRegistry.register(makeListProposalsTool(database));
    toolRegistry.register(makeGetProposalTool(database));
    toolRegistry.register(
      makeContradictionCheckTool({ db: database, hunter: contradictionHunter }),
    );
    toolRegistry.register(makeSynthesizeTool({ db: database, synthesizer }));

    const notesContext = {
      facade: {
        readNote: (path: string) => facade.read(path),
        writeNote: (path: string, content: string) => facade.write(path, content),
        exists: (path: string) => facade.exists(path),
      },
      approvalGate,
      echoGuard: this.echoGuard,
      hash: sha256,
      approvalMode: () => this.settings.get().chat.approvalMode,
      recordHistory: recordNoteHistory,
      generateCallId: () => generateRandomId(),
    };
    toolRegistry.register(makeCreateNoteTool(notesContext));
    toolRegistry.register(makeAppendNoteTool(notesContext));
    toolRegistry.register(makeReplaceSectionTool(notesContext));
    toolRegistry.register(makeUpdateFrontmatterTool(notesContext));

    // (10) ContextManager: builds the eight-layer system prompt. Workspace
    // facets read from Obsidian directly; the rest comes from settings or DB.
    const recentNoteRing: string[] = [];
    const recentSearchRing: string[] = [];
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!file || file.extension !== "md") return;
        const next = [file.path, ...recentNoteRing.filter((p) => p !== file.path)];
        recentNoteRing.length = 0;
        recentNoteRing.push(...next.slice(0, 10));
      }),
    );

    const toolModeCache: ToolModeCache = {
      read: (model) => {
        const cached = this.settings.get().chat.toolModeByModel[model];
        return cached ?? null;
      },
      write: async (model, mode: ToolMode) => {
        const next = { ...this.settings.get().chat.toolModeByModel, [model]: mode };
        await this.settings.update({
          chat: { ...this.settings.get().chat, toolModeByModel: next },
        });
      },
    };

    const contextManager = new ContextManager({
      database,
      provider: primaryLLM,
      conversationIndex,
      embed: embedSingle,
      contextSettings: () => {
        const chatSettings = this.settings.get().chat;
        return {
          includeUserProfile: chatSettings.context.includeUserProfile,
          includeVaultSnapshot: chatSettings.context.includeVaultSnapshot,
          includeWorkspaceState: chatSettings.context.includeWorkspaceState,
          includeCrossSessionMemory: chatSettings.context.includeCrossSessionMemory,
          crossSessionTopK: chatSettings.context.crossSessionTopK,
          crossSessionSimThreshold: chatSettings.context.crossSessionSimThreshold,
          pinnedNoteMaxTokens: chatSettings.context.pinnedNoteMaxTokens,
          contextBudgetFraction: chatSettings.contextBudgetFraction,
          modelContextTokens: 32_000,
        };
      },
      workspace: {
        getActiveNotePath: () => this.app.workspace.getActiveFile()?.path ?? null,
        getOpenNotePaths: () => {
          const paths: string[] = [];
          this.app.workspace.iterateAllLeaves((leaf) => {
            const view = leaf.view as { file?: TFile };
            const file = view.file;
            if (file && file.extension === "md") paths.push(file.path);
          });
          return paths;
        },
        getRecentNotePaths: () => [...recentNoteRing],
        getRecentSearchQueries: () => [...recentSearchRing],
      },
      facade: { readNote: (path) => facade.read(path) },
      voiceProfile: () => "",
      approvalMode: () => this.settings.get().chat.approvalMode,
      toolCatalog: () =>
        toolRegistry.list().map((entry) => ({
          name: entry.name,
          description: entry.description,
        })),
      estimateTokens: (text) => Math.ceil(text.length / 4),
      summaryModel: current.primary.reasoningModel,
    });

    const chatRuntimeSettings = (): ChatRuntimeSettings => {
      const chatSettings = this.settings.get().chat;
      return {
        model: this.settings.get().primary.reasoningModel,
        maxRoundsPerTurn: chatSettings.maxRoundsPerTurn,
        approvalMode: chatSettings.approvalMode,
        persistReasoning: chatSettings.persistReasoning,
      };
    };

    const chatService = new ChatService({
      provider: primaryLLM,
      contextManager,
      conversationStore,
      conversationIndex,
      toolRegistry,
      approvalGate,
      mutex: reasoningMutex,
      toolModeCache,
      embed: embedSingle,
      settings: chatRuntimeSettings,
    });

    this.kernel.register("bus", this.bus);
    this.kernel.register("settings", this.settings);
    this.kernel.register("facade", facade);
    this.kernel.register("database", database);
    this.kernel.register("graph", graph);
    this.kernel.register("primaryLLM", primaryLLM);
    this.kernel.register("deepLLM", deepLLM);
    this.kernel.register("embeddingLLM", embeddingLLM);
    this.kernel.register("health", health);
    this.kernel.register("lock", this.lockHandle);
    this.kernel.register("echoGuard", this.echoGuard);
    this.kernel.register("vectorIndex", vectorIndex);
    this.kernel.register("embedder", embedder);
    this.kernel.register("extractor", extractor);
    this.kernel.register("indexer", indexerQueue);
    this.kernel.register("reasoningMutex", reasoningMutex);
    this.kernel.register("idleDetector", idleDetector);
    this.kernel.register("coordinator", coordinator);
    this.kernel.register("approvalService", approvalService);
    this.kernel.register("coAuthor", coAuthor);
    this.kernel.register("streamService", streamService);
    this.kernel.register("vitalsService", vitalsService);
    this.kernel.register("nativeGraphBridge", nativeGraphBridge);
    this.kernel.register("canvasFromResults", canvasFromResults);
    this.kernel.register("searchPipeline", searchPipeline);
    this.kernel.register("savedQueries", savedQueries);
    this.kernel.register("searchHistory", searchHistory);
    this.kernel.register("conversationStore", conversationStore);
    this.kernel.register("conversationIndex", conversationIndex);
    this.kernel.register("toolRegistry", toolRegistry);
    this.kernel.register("approvalGate", approvalGate);
    this.kernel.register("contextManager", contextManager);
    this.kernel.register("chatService", chatService);
    this.kernel.register("historyService", historyService);
    this.kernel.register("vaultBootstrap", vaultBootstrap);
    this.kernel.seal();

    this.bus.on("llm:health", () => {
      NotientSidebarView.updateFooter(health.current(), facade.listMarkdown().length);
    });

    health.start();
    coordinator.start();
    idleDetector.start();
    streamService.start();

    // (11) UI signal binding. The Stream tab subscribes to the live items
    // signal; the Vitals tab updates on active-leaf-change; the chat tab
    // gets a runner adapter and an actions object.
    streamService.items.subscribe((items: StreamItem[]) => {
      streamItemsState.value = items;
    });

    chatPersistReasoning.value = current.chat.persistReasoning;

    // Open right-leaf view helpers.
    const openInRightLeaf = async (viewType: string): Promise<void> => {
      const { workspace } = this.app;
      const existing = workspace.getLeavesOfType(viewType);
      if (existing.length > 0) {
        workspace.revealLeaf(existing[0]);
        return;
      }
      const leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: viewType, active: true });
        workspace.revealLeaf(leaf);
      }
    };
    const openSidebar = (): Promise<void> => openInRightLeaf(VIEW_TYPE_NOTIENT);
    const openApprovals = (): Promise<void> => openInRightLeaf(VIEW_TYPE_NOTIENT_APPROVALS);

    let coAuthorAbort: AbortController | null = null;
    const openCoAuthor = async (): Promise<void> => {
      debugCoAuthorMain("open-command");
      await openInRightLeaf(VIEW_TYPE_NOTIENT_CO_AUTHOR);
      const file = this.app.workspace.getActiveFile();
      const path = file?.extension === "md" ? file.path : null;
      debugCoAuthorMain("open-command:active-file", { path });
      if (!path) return;
      const wordRow = database.query<{ word_count: number }>(
        "SELECT word_count FROM notes WHERE path = ?;",
        [path],
      )[0];
      this.bus.emit({
        type: "active-leaf-change",
        notePath: path,
        wordCount: wordRow?.word_count ?? 0,
      });
      if (coAuthorAbort) {
        debugCoAuthorMain("abort-previous", { reason: "open-command" });
        coAuthorAbort.abort();
      }
      const ctrl = new AbortController();
      coAuthorAbort = ctrl;
      debugCoAuthorMain("run-priority:start", { path });
      void reasoningMutex.runPriority("co-author", async (signal) => {
        const merged = mergeSignals(signal, ctrl.signal);
        await coAuthor.runFor(path, merged);
        debugCoAuthorMain("run-priority:finished", { path, aborted: merged.aborted });
      });
    };

    const openSearch = async (
      mode: "quick" | "balanced" | "deep" = "quick",
      seed?: string,
    ): Promise<void> => {
      SearchView.prime(mode, seed);
      const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTIENT_SEARCH);
      let leaf: WorkspaceLeaf | null;
      if (existing.length > 0) {
        leaf = existing[0];
        this.app.workspace.revealLeaf(leaf);
      } else {
        leaf = this.app.workspace.getLeaf(true);
        await leaf.setViewState({ type: VIEW_TYPE_NOTIENT_SEARCH, active: true });
        this.app.workspace.revealLeaf(leaf);
      }
    };

    sidebarActions.value = {
      openCoAuthor: () => void openCoAuthor(),
      openApprovals: () => void openApprovals(),
      openAwaken: () => openAwakenModal(),
      openSearch: () => void openSearch("quick"),
    };

    // Search wiring: configure the SearchView with a runner that drives the
    // pipeline and an actions object that wires saved queries, canvas export,
    // chat refinement, and history persistence.
    const searchAppActions: SearchAppActions = {
      runSearch: () => {
        const trimmed = searchQueryState.value.trim();
        if (trimmed.length === 0) return;
        recentSearchRing.unshift(trimmed);
        recentSearchRing.splice(10);
        pushSearchUiHistory(trimmed);
        const cap = this.settings.get().search.history.maxQueries;
        if (searchHistoryState.value.length > cap) {
          searchHistoryState.value = searchHistoryState.value.slice(0, cap);
        }
        void searchHistory.record({
          query: trimmed,
          mode: searchModeState.value,
          ranAt: Date.now(),
        });
        void dispatchSearch();
      },
      cancelSearch: () => {
        cancelSearchDispatch();
      },
      openHit: (notePath) => {
        const target = this.app.metadataCache.getFirstLinkpathDest(notePath, "");
        if (!target) return;
        void this.app.workspace.openLinkText(target.path, "", false);
      },
      pinPreview: () => {
        // Preview pin state is local to the view; nothing to push to runtime.
      },
      viewAsCanvas: () => {
        const result = searchResultState.value;
        if (!result) return;
        void canvasFromResults.export(result).then((exported) => {
          new Notice(`Notient: canvas saved to ${exported.path}`);
          void this.app.workspace.openLinkText(exported.path, "", false);
        });
      },
      saveQuery: () => {
        const trimmed = searchQueryState.value.trim();
        if (trimmed.length === 0) return;
        void savedQueries.save({
          query: trimmed,
          mode: searchModeState.value,
          filters: {},
        });
      },
      newChatFromResults: () => {
        const trimmed = searchQueryState.value.trim();
        if (trimmed.length === 0) return;
        setActiveTab("chat");
        void chatService
          .startConversation({ topic: trimmed, pinnedContext: [] })
          .then((conversation) => {
            chatActiveConversation.value = conversation;
          });
      },
      openLink: (linkText) => {
        const target = normalizeWikilinkTarget(linkText);
        if (target.length === 0) return;
        void this.app.workspace.openLinkText(target, "", false);
      },
    };

    SearchView.configure({
      runner: (query, signal) => searchPipeline.run(query, signal),
      actions: searchAppActions,
    });

    // Chat wiring: runner drives ChatService.sendMessage, actions cover
    // start/load/abort + pin/unpin + approval resolution + reasoning toggle.
    setChatRunner((conversation, userMessage, signal) => {
      const generator = chatService.sendMessage({ conversation, userMessage });
      return {
        async *[Symbol.asyncIterator]() {
          for await (const event of generator) {
            if (signal.aborted) return;
            yield event;
          }
        },
      };
    });

    const refreshConversationsList = async (): Promise<void> => {
      try {
        const conversations = await chatService.listConversations();
        chatConversationsList.value = conversations.map((conversation) => ({
          id: conversation.id,
          notePath: conversation.notePath,
          topic: conversation.topic,
          updatedAt: conversation.updatedAt,
        }));
      } catch {
        // Listing failures are non-fatal: the drawer simply stays empty until
        // the next refresh. Surfacing them via console.warn would re-introduce
        // a new log site where Phase 1-3 had eight pre-existing ones.
      }
    };

    const chatLiveActions: ChatActions = {
      newConversation: async () => {
        const conversation = await chatService.startConversation({
          topic: "Untitled",
          pinnedContext: [...chatPinnedContext.value],
        });
        chatActiveConversation.value = conversation;
        await refreshConversationsList();
      },
      loadConversation: async (notePath) => {
        const conversation = await chatService.loadConversation(notePath);
        chatActiveConversation.value = conversation;
      },
      sendMessage: async () => {
        // The dispatcher in chat-state.ts owns the actual streaming pump; this
        // action exists for parity with the interface and is invoked nowhere.
      },
      abort: () => chatService.abort(),
      pinNote: (notePath) => {
        if (chatPinnedContext.value.includes(notePath)) return;
        chatPinnedContext.value = [...chatPinnedContext.value, notePath];
      },
      unpinNote: (notePath) => {
        chatPinnedContext.value = chatPinnedContext.value.filter((entry) => entry !== notePath);
      },
      resolveApproval: (callId, approved, reason) => {
        approvalGate.resolve(callId, { approved, reason });
      },
      toggleYolo: async () => {
        const next = this.settings.get().chat.approvalMode === "safe" ? "yolo" : "safe";
        if (
          next === "yolo" &&
          !window.confirm(
            "Enable Notient yolo mode for chat writes? Write tools will auto-approve and rely on undo history.",
          )
        ) {
          return;
        }
        await this.settings.update({
          chat: { ...this.settings.get().chat, approvalMode: next },
        });
        if (chatActiveConversation.value) {
          chatActiveConversation.value = {
            ...chatActiveConversation.value,
            approvalMode: next,
          };
        }
      },
      openLink: (linkText) => {
        void this.app.workspace.openLinkText(linkText, "", false);
      },
      undoLastWrite: async (historyId) => {
        const numericId = Number(historyId);
        if (!Number.isFinite(numericId)) return;
        const result = await historyService.undo(numericId);
        if (!result.ok) {
          new Notice(`Notient: undo failed (${result.error})`);
        }
      },
    };
    chatActionsSignal.value = chatLiveActions;

    streamActions.value = {
      open: (item) => {
        const path = item.notePaths[0];
        if (!path) return;
        const target = this.app.metadataCache.getFirstLinkpathDest(path, "");
        if (target) void this.app.workspace.openLinkText(target.path, "", false);
      },
      accept: (item) => {
        if (item.kind === "edge") void approvalService.acceptEdge(item.id);
      },
      reject: (item) => {
        if (item.kind === "edge") void approvalService.rejectEdge(item.id);
      },
      previewCanvas: (item) => {
        if (item.kind !== "node" || item.type !== "synthesis") return;
        void exportSynthesisProposalCanvas(item.id);
      },
    };

    vitalsActions.value = {
      deepen: (path) => {
        this.bus.emit({ type: "user:action", kind: "deepen", notePath: path });
      },
    };

    // (12) Active-note → vitals snapshot. Recomputes on every leaf change so
    // the VitalsTab always shows the right note.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const file = this.app.workspace.getActiveFile();
        const path = file?.extension === "md" ? file.path : null;
        const wordRow = path
          ? database.query<{ word_count: number }>("SELECT word_count FROM notes WHERE path = ?;", [
              path,
            ])[0]
          : undefined;
        this.bus.emit({
          type: "active-leaf-change",
          notePath: path,
          wordCount: wordRow?.word_count ?? 0,
        });
        debugCoAuthorMain("active-leaf-change", { path, wordCount: wordRow?.word_count ?? 0 });
        if (coAuthorAbort) {
          debugCoAuthorMain("abort-previous", { reason: "active-leaf-change" });
          coAuthorAbort.abort();
        }
        vitalsSnapshotState.value = path ? vitalsService.computeSnapshot(path) : null;
        if (!path) return;
        const ctrl = new AbortController();
        coAuthorAbort = ctrl;
        debugCoAuthorMain("run-priority:start", { path });
        void reasoningMutex.runPriority("co-author", async (signal) => {
          const merged = mergeSignals(signal, ctrl.signal);
          await coAuthor.runFor(path, merged);
          debugCoAuthorMain("run-priority:finished", { path, aborted: merged.aborted });
        });
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        idleDetector.recordActivity();
      }),
    );

    // (13) Vitals snapshot persistence after indexing. The save event fires
    // before the note row/chunks are refreshed, so snapshots must persist from
    // the post-index event instead.
    this.bus.on("indexer:note-indexed", (event) => {
      void vitalsService.persistSnapshot(event.path).then(() => {
        const activePath = this.app.workspace.getActiveFile()?.path ?? null;
        if (activePath === event.path) {
          vitalsSnapshotState.value = vitalsService.computeSnapshot(event.path);
        }
      });
    });

    // (14) Editor decorations. Live Preview + Source only; Reading mode skips.
    this.registerEditorExtension(
      makeInsightsPlugin({
        getProposals: (notePath) => {
          const items = streamService.items.value.filter((item) =>
            item.notePaths.includes(notePath),
          );
          const proposals: Array<{
            id: string;
            agent: string;
            rationale: string;
            score: number;
            chunkText: string;
          }> = [];
          for (const item of items) {
            for (const chunkId of item.evidenceChunkIds) {
              const chunk = database.query<{ text: string }>(
                "SELECT text FROM chunks WHERE id = ?;",
                [chunkId],
              )[0];
              if (!chunk) continue;
              proposals.push({
                id: item.id,
                agent: item.agent,
                rationale: item.rationale ?? "",
                score: item.score,
                chunkText: chunk.text,
              });
            }
          }
          return proposals;
        },
        getActivePath: () => this.app.workspace.getActiveFile()?.path ?? null,
        getMaxPerViewport: () => this.settings.get().decorations.maxPerViewport,
        getDebounceMs: () => this.settings.get().decorations.debounceMs,
        onClick: (proposalId) => {
          focusedProposalIdState.value = proposalId;
          setActiveTab("stream");
        },
        isModeAllowed: () => {
          if (!this.settings.get().decorations.enabled) return false;
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (!view) return false;
          const path = this.app.workspace.getActiveFile()?.path ?? null;
          if (!path) return false;
          const minWords = this.settings.get().decorations.minWordsToDecorate;
          if (minWords > 0) {
            const row = database.query<{ word_count: number }>(
              "SELECT word_count FROM notes WHERE path = ?;",
              [path],
            )[0];
            if ((row?.word_count ?? 0) < minWords) return false;
          }
          const mode = view.getMode();
          return mode === "source" || mode === "preview";
        },
      }),
    );

    // (15) Vault modify handler. Excludes Notient-owned folders before
    // anything reaches the chunker — closes the H1 echo-loop hazard.
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!(file instanceof TFile)) return;
        if (!file.path.endsWith(".md")) return;
        if (isExcluded(file.path, excludePatterns)) return;
        try {
          const contents = await facade.read(file.path);
          const sha = await sha256(contents);
          if (this.echoGuard.take(file.path, sha)) return;
          this.bus.emit({ type: "vault:note-saved", path: file.path, sha });
          indexerQueue.enqueue(file.path);
        } catch (error) {
          console.error("[Notient] save handler error", error);
        }
      }),
    );

    const refreshPendingApprovals = (): void => {
      const row = database.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM staging_edges WHERE decision IS NULL;",
      )[0];
      pendingApprovalsState.value = row?.n ?? 0;
    };
    refreshPendingApprovals();

    const triggerByRunId = new Map<number, string>();
    this.bus.on("agent:run-started", (event) => {
      triggerByRunId.set(event.runId, event.trigger);
    });
    this.bus.on("agent:run-finished", (event) => {
      const next: AgentRun = {
        id: event.runId,
        agent: event.agent,
        trigger: triggerByRunId.get(event.runId) ?? "",
        ok: event.ok,
        proposals: event.proposals,
        durationMs: event.durationMs,
        error: event.error,
        finishedAt: Date.now(),
      };
      triggerByRunId.delete(event.runId);
      const previous = recentRunsState.value;
      recentRunsState.value = [next, ...previous].slice(0, 10);
      refreshPendingApprovals();
      const path = this.app.workspace.getActiveFile()?.path ?? null;
      if (path) void vitalsService.persistSnapshot(path);
    });

    this.bus.on("approval:decided", () => {
      refreshPendingApprovals();
    });

    const tickInterval = window.setInterval(() => {
      tickState.value = tickState.value + 1;
    }, 30_000);
    this.register(() => window.clearInterval(tickInterval));

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const selection = editor.getSelection();
        if (selection.length === 0) return;
        menu.addItem((item) =>
          item
            .setTitle("Ask Notient about this selection")
            .setIcon("messages-square")
            .onClick(() => {
              setActiveTab("chat");
              void chatService
                .startConversation({ topic: selection.slice(0, 60), pinnedContext: [] })
                .then((conversation) => {
                  chatActiveConversation.value = conversation;
                });
            }),
        );
        menu.addItem((item) =>
          item
            .setTitle("Search related notes")
            .setIcon("search")
            .onClick(() => {
              void openSearch("balanced", selection);
            }),
        );
      }),
    );

    const openAwakenModal = (): void => {
      const canvasModel = new GraphCanvasModel({ width: 720, height: 420 });
      let countersEl: HTMLElement | null = null;
      let canvasEl: HTMLCanvasElement | null = null;
      let rafHandle = 0;

      const renderCounters = (): void => {
        if (!countersEl) return;
        const c = canvasModel.counts();
        countersEl.empty();
        const pairs: Array<[string, number]> = [
          ["Notes", c.notes],
          ["Concepts", c.concepts],
          ["Claims", c.claims],
          ["Questions", c.questions],
          ["Edges", c.edges],
        ];
        for (const [label, value] of pairs) {
          const stat = countersEl.createDiv({ cls: "stat" });
          stat.createSpan({ cls: "label", text: label });
          stat.createSpan({ cls: "value", text: String(value) });
        }
      };

      const tick = (): void => {
        if (canvasEl) {
          const context = canvasEl.getContext("2d");
          if (context) canvasModel.draw(context, Date.now());
        }
        rafHandle = requestAnimationFrame(tick);
      };

      const nodeOff = this.bus.on("indexer:node-added", (event) => {
        canvasModel.addNode({
          id: event.nodeId,
          type: event.nodeType,
          label: event.label,
        });
        renderCounters();
      });
      const edgeOff = this.bus.on("indexer:edge-added", (event) => {
        canvasModel.addEdge({
          id: event.edgeId,
          sourceId: event.sourceId,
          targetId: event.targetId,
          type: event.edgeType,
        });
        renderCounters();
      });

      const runner = new AwakenRunner({
        listMarkdown: () => facade.listMarkdown(),
        indexNote: this.indexOne,
        batchSize: 10,
      });

      const modal = new AwakenVaultModal(this.app, {
        start: () =>
          runner.start({
            onProgress: () => renderCounters(),
            onComplete: async (c) => {
              const next = { ...this.settings.get(), awakenedAt: Date.now() };
              await this.settings.update(next);
              new Notice(
                `Notient awakened: ${c.totalIndexed} notes in ${(c.durationMs / 1000).toFixed(1)}s`,
              );
            },
            onError: (e) => console.warn("[Notient] awaken error", e),
          }),
        stop: () => runner.stop(),
        isRunning: () => runner.isRunning(),
        totalNotes: () => facade.listMarkdown().length,
        onAttachCanvas: (canvas) => {
          canvasEl = canvas;
          tick();
        },
        onAttachCounters: (el) => {
          countersEl = el;
          renderCounters();
        },
      });

      modal.onClose = ((original) =>
        function (this: AwakenVaultModal): void {
          cancelAnimationFrame(rafHandle);
          nodeOff();
          edgeOff();
          original.call(this);
        })(modal.onClose.bind(modal));

      modal.open();
    };

    const exportSynthesisProposalCanvas = async (id: string): Promise<void> => {
      const row = database.query<{ label: string; payload: string | null }>(
        "SELECT label, payload FROM staging_nodes WHERE id = ?;",
        [id],
      )[0];
      if (!row) return;
      const payload = parseObject(row.payload);
      const memberPaths = Array.isArray(payload.memberPaths)
        ? payload.memberPaths.filter((path): path is string => typeof path === "string")
        : [];
      const body = typeof payload.body === "string" ? payload.body : "";
      const folder = this.settings.get().chat.proposalsFolder;
      if (!(await adapter.exists(folder))) await this.app.vault.createFolder(folder);
      const path = `${folder}/${makeSlug(row.label)}-${Date.now()}.canvas`;
      const canvas = generateSynthesisCanvas({
        synthesisTitle: row.label,
        synthesisBody: body,
        sourceNotePaths: memberPaths,
      });
      await facade.write(path, JSON.stringify(canvas, null, 2));
      new Notice(`Notient: canvas saved to ${path}`);
      await this.app.workspace.openLinkText(path, "", false);
    };

    this.addCommand({
      id: "awaken-vault",
      name: "Notient: Awaken Vault",
      callback: openAwakenModal,
    });

    if (current.awakenedAt === null) {
      setTimeout(openAwakenModal, 800);
    }

    this.registerView(VIEW_TYPE_NOTIENT, (leaf) => new NotientSidebarView(leaf));
    this.registerView(
      VIEW_TYPE_NOTIENT_CO_AUTHOR,
      (leaf) =>
        new CoAuthorView(leaf, {
          bus: this.bus,
          onCancel: () => {
            debugCoAuthorMain("cancel-click");
            coAuthorAbort?.abort();
          },
        }),
    );
    this.registerView(
      VIEW_TYPE_NOTIENT_APPROVALS,
      (leaf) =>
        new ApprovalsView(leaf, {
          service: approvalService,
          bus: this.bus,
        }),
    );
    this.registerView(VIEW_TYPE_NOTIENT_SEARCH, (leaf) => new SearchView(leaf));

    this.addRibbonIcon("brain-circuit", "Open Notient", () => void openSidebar());
    this.addRibbonIcon("pen-tool", "Notient: Co-author", () => void openCoAuthor());
    this.addRibbonIcon("check-circle", "Notient: Approvals", () => void openApprovals());
    this.addRibbonIcon("search", "Notient: Search", () => void openSearch("quick"));
    this.addRibbonIcon("messages-square", "Notient: New chat", () => {
      setActiveTab("chat");
      void chatLiveActions.newConversation();
    });

    this.addCommand({
      id: "open-sidebar",
      name: "Notient: Open sidebar",
      callback: () => void openSidebar(),
    });
    this.addCommand({
      id: "open-co-author",
      name: "Notient: Open Co-author panel",
      callback: () => void openCoAuthor(),
    });
    this.addCommand({
      id: "open-approvals",
      name: "Notient: Open Approvals panel",
      callback: () => void openApprovals(),
    });
    this.addCommand({
      id: "deepen-active-note",
      name: "Notient: Deepen active note (run all agents)",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") {
          new Notice("Open a markdown note first.");
          return;
        }
        this.bus.emit({ type: "user:action", kind: "deepen", notePath: file.path });
        new Notice(`Notient: deepening ${file.path}`);
      },
    });

    // Phase 4 commands.
    this.addCommand({
      id: "notient-search-quick",
      name: "Notient: Search (Quick)",
      callback: () => void openSearch("quick"),
    });
    this.addCommand({
      id: "notient-search-balanced",
      name: "Notient: Search (Balanced)",
      callback: () => void openSearch("balanced"),
    });
    this.addCommand({
      id: "notient-search-deep",
      name: "Notient: Search (Deep)",
      callback: () => void openSearch("deep"),
    });
    this.addCommand({
      id: "notient-search-here",
      name: "Notient: Search related to selection",
      editorCallback: (editor) => {
        const selection = editor.getSelection();
        void openSearch("balanced", selection);
      },
    });
    this.addCommand({
      id: "notient-chat-new",
      name: "Notient: New chat",
      callback: () => {
        setActiveTab("chat");
        void chatLiveActions.newConversation();
      },
    });
    this.addCommand({
      id: "notient-chat-active-note",
      name: "Notient: Chat about this note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const path = file?.extension === "md" ? file.path : null;
        if (checking) return path !== null;
        if (path) {
          chatPinnedContext.value = [path];
          setActiveTab("chat");
          void chatLiveActions.newConversation();
        }
        return true;
      },
    });
    this.addCommand({
      id: "notient-chat-resume-last",
      name: "Notient: Resume last chat",
      callback: async () => {
        const conversations = await chatService.listConversations();
        const latest = conversations[0];
        if (!latest) {
          new Notice("Notient: no prior conversations");
          return;
        }
        await chatLiveActions.loadConversation(latest.notePath);
        setActiveTab("chat");
      },
    });
    this.addCommand({
      id: "notient-undo-last",
      name: "Notient: Undo last action",
      callback: async () => {
        const result = await historyService.undoLast();
        new Notice(result.ok ? "Undid last Notient action" : `Undo failed: ${result.error}`);
      },
    });

    NotientSidebarView.updateFooter(health.current(), facade.listMarkdown().length);
    void refreshConversationsList();
    console.log("[Notient] ready");
  }

  async onunload(): Promise<void> {
    console.log("[Notient] onunload");
    if (this.kernel.isSealed()) {
      try {
        this.kernel.get("streamService").stop();
      } catch {
        // ignore
      }
      try {
        this.kernel.get("coordinator").stop();
      } catch {
        // ignore
      }
      try {
        this.kernel.get("idleDetector").stop();
      } catch {
        // ignore
      }
      try {
        this.kernel.get("health").stop();
      } catch {
        // ignore
      }
      try {
        this.kernel.get("indexer").dispose();
      } catch {
        // ignore
      }
      try {
        await this.kernel.get("database").close();
      } catch {
        // ignore
      }
    }
    if (this.lockHandle) {
      try {
        await this.lockHandle.release();
      } catch {
        // ignore
      }
    }
  }
}

async function sha256(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// FNV-1a 32-bit. The conversation store wants a synchronous hash; using a
// non-cryptographic hash here is acceptable because EchoGuard needs only a
// stable fingerprint per content blob.
function sha256Sync(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function generateRandomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  else {
    a.addEventListener("abort", cancel, { once: true });
    b.addEventListener("abort", cancel, { once: true });
  }
  return controller.signal;
}

function normalizeWikilinkTarget(linkText: string): string {
  const trimmed = linkText.trim();
  const inner =
    trimmed.startsWith("[[") && trimmed.endsWith("]]") ? trimmed.slice(2, -2).trim() : trimmed;
  return inner.split("|")[0]?.trim() ?? "";
}

function parseObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function debugCoAuthorMain(message: string, data?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  console.log(`[Notient][CoAuthorMain] ${message}`, data ?? {});
}
