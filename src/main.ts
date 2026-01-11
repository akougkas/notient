/**
 * Notient - AI-powered vault management for Obsidian
 *
 * Main plugin entry point.
 * SAFETY: Plugin must always load. Services initialize lazily after setup.
 *
 * Architecture (Simplified):
 * - HNSWVectorStore: HNSW algorithm (O(log N) search), WASM-based
 * - IndexManager: Coordinates vector store and note state
 * - SimpleIndexer: Batch processing with UI yields, no JobQueue
 * - SearchPipeline: Cached semantic search
 */

import { Notice, Plugin } from "obsidian";
import { AgentTaskQueue, NotientAgent } from "./core/agent";
import { ProfileManager } from "./core/agent/profileManager";
import { ActionApplier, ActionHistory, TrustLevelManager, WorkflowRunner } from "./core/agentic";
import { ConversationStore } from "./core/chat";
import { VIEW_TYPE_DASHBOARD, VIEW_TYPE_SIDEBAR } from "./core/constants";
import { VaultContextBuilder } from "./core/context/vaultContextBuilder";
import { UserEvolutionService } from "./core/evolution";
import { ImporterService, MigrationService } from "./core/importer";
import { SimpleIndexer } from "./core/indexer/simpleIndexer";
import { ActionOrchestrator } from "./core/intelligence/actionOrchestrator";
import { NoteIntelligenceService } from "./core/intelligence/noteIntelligence";
import { Kernel, type KernelContext } from "./core/kernel";
import { LMStudioProvider } from "./core/llm";
import { SearchPipeline } from "./core/search/pipeline";
import { ProgressiveSearchOrchestrator } from "./core/search/progressiveSearch";
import { InitializationStateMachine } from "./core/services";
import { SimpleVaultVitals } from "./core/vitals/simpleVitals";
import { HealthMonitor } from "./services/healthMonitor";
import { HNSWVectorStore } from "./services/hnswVectorStore";
import { IndexManager } from "./services/indexManager";
import { LMStudioService } from "./services/lmstudio";
import { OllamaService } from "./services/ollama";
import { OllamaRerankerService } from "./services/ollamaReranker";
import type { NotientSettings } from "./types/settings";
import { NotientDashboardView } from "./ui/dashboard/DashboardView";
import { ImportModal } from "./ui/modals/ImportModal";
import { IndexOptionsModal } from "./ui/modals/IndexOptionsModal";
import { ProfilePreviewModal } from "./ui/modals/ProfilePreviewModal";
import { SetupWizardModal } from "./ui/modals/SetupWizard";
import { NotientSettingTab, loadSettings, saveSettings } from "./ui/settings";
import { NotientSidebarView } from "./ui/sidebar";

export default class NotientPlugin extends Plugin {
  private kernel!: Kernel;
  private settings!: NotientSettings;
  private settingTab!: NotientSettingTab;

  // LLM providers
  private healthMonitor: HealthMonitor | null = null;
  private ollamaService: OllamaService | null = null;
  private ollamaReranker: OllamaRerankerService | null = null;
  private lmStudioService: LMStudioService | null = null;
  private llmProvider: LMStudioProvider | null = null;

  // Indexing and search
  private vectorStore: HNSWVectorStore | null = null;
  private indexManager: IndexManager | null = null;
  private indexer: SimpleIndexer | null = null;
  private searchPipeline: SearchPipeline | null = null;
  private progressiveSearch: ProgressiveSearchOrchestrator | null = null;
  private contextBuilder: VaultContextBuilder | null = null;

  // Intelligence and vitals
  private vaultVitals: SimpleVaultVitals | null = null;
  private noteIntelligence: NoteIntelligenceService | null = null;
  private actionOrchestrator: ActionOrchestrator | null = null;

  // Agent system
  private notientAgent: NotientAgent | null = null;
  private agentTaskQueue: AgentTaskQueue | null = null;
  private conversationStore: ConversationStore | null = null;

  // Agentic actions
  private actionHistory: ActionHistory | null = null;
  private trustLevelManager: TrustLevelManager | null = null;
  private actionApplier: ActionApplier | null = null;
  private workflowRunner: WorkflowRunner | null = null;

  // Identity and evolution
  private profileManager: ProfileManager | null = null;
  private userEvolution: UserEvolutionService | null = null;

  // Import and migration
  private importerService: ImporterService | null = null;
  private migrationService: MigrationService | null = null;

  // Initialization state
  private initStateMachine: InitializationStateMachine | null = null;
  private servicesInitialized = false;

  // Indexing control
  private indexingAbortController: AbortController | null = null;

  async onload(): Promise<void> {
    console.log("[Notient] Loading plugin...");

    try {
      // Load settings first
      this.settings = await loadSettings(this);
      console.log("[Notient] Settings loaded, setupComplete =", this.settings.setupComplete);

      // Create kernel (lightweight)
      const context: KernelContext = {
        app: this.app,
        plugin: this,
        settings: this.settings,
      };
      this.kernel = new Kernel(context);

      // Initialize kernel
      await this.kernel.initialize();

      // Create initialization state machine
      this.initStateMachine = new InitializationStateMachine({
        eventBus: this.kernel.eventBus,
        onStateChange: (ctx) => {
          console.log("[Notient] Init state:", ctx.state, ctx.capabilities);
        },
      });

      // Register views
      this.registerViews();

      // Register commands
      this.registerCommands();

      // Add settings tab
      this.settingTab = new NotientSettingTab(
        this.app,
        this,
        this.kernel,
        this.settings,
        async (newSettings, changedFields = []) => {
          this.settings = newSettings;
          // Update kernel's settings reference to prevent stale state
          this.kernel.updateSettings(newSettings);
          await saveSettings(this, newSettings);
          this.kernel.eventBus.emit("settings:changed", { changedFields });
        },
      );
      this.addSettingTab(this.settingTab);

      // Listen for LLM settings changes to reinitialize services
      this.kernel.eventBus.on("settings:changed", async ({ changedFields }) => {
        // Embedding model changes require full reinit (index depends on embedding dimension)
        const embeddingFields = ["ollama.host", "ollama.embeddingModel"];
        // Chat model changes only need chat service reconnect (preserves index)
        const chatFields = ["lmstudio.host", "lmstudio.reasoningModel"];

        const needsFullReinit = changedFields.some((f) => embeddingFields.includes(f));
        const needsChatReinit = changedFields.some((f) => chatFields.includes(f));

        if (needsFullReinit && this.servicesInitialized) {
          console.log("[Notient] Embedding settings changed, reinitializing all services...");
          await this.reinitializeServices();
        } else if (needsChatReinit && this.servicesInitialized) {
          console.log("[Notient] Chat model changed, reconnecting chat services...");
          await this.reinitializeChatOnly();
        }
      });

      // Add ribbon icon
      this.addRibbonIcon("sparkles", "Notient", () => {
        this.activateSidebar();
      });

      // Check if setup needed
      if (!this.settings.setupComplete) {
        setTimeout(() => this.showSetupWizard(), 500);
      } else {
        setTimeout(() => this.initializeServicesAsync(), 1000);
      }

      console.log("[Notient] Plugin loaded successfully");
    } catch (error) {
      console.error("[Notient] Failed to load plugin:", error);
    }
  }

  async onunload(): Promise<void> {
    console.log("[Notient] Unloading plugin...");

    try {
      await this.disposeServices();

      // Dispose state machine
      this.initStateMachine?.dispose();
      this.initStateMachine = null;

      // Dispose kernel last
      this.kernel?.dispose();
    } catch (error) {
      console.error("[Notient] Error during unload:", error);
    }

    console.log("[Notient] Plugin unloaded");
  }

  /**
   * Dispose all services in reverse initialization order.
   * Used by both onunload() and reinitializeServices().
   */
  private async disposeServices(): Promise<void> {
    // Agentic services first (depend on other services)
    this.workflowRunner?.dispose();
    this.workflowRunner = null;
    this.actionApplier = null;
    this.actionOrchestrator = null;
    this.trustLevelManager = null;

    if (this.actionHistory) {
      await this.actionHistory.dispose();
      this.actionHistory = null;
    }
    if (this.conversationStore) {
      await this.conversationStore.dispose();
      this.conversationStore = null;
    }

    // Agent system
    this.agentTaskQueue = null;
    this.notientAgent = null;
    this.llmProvider?.dispose();
    this.llmProvider = null;

    // Intelligence and evolution
    this.noteIntelligence?.dispose();
    this.noteIntelligence = null;
    if (this.userEvolution) {
      await this.userEvolution.unload();
      this.userEvolution = null;
    }

    // Search and context
    this.vaultVitals?.dispose();
    this.progressiveSearch?.dispose();
    this.searchPipeline?.dispose();
    this.contextBuilder = null;
    this.searchPipeline = null;

    // Indexing
    this.indexer?.dispose();
    this.indexer = null;
    if (this.indexManager) {
      await this.indexManager.dispose();
      this.indexManager = null;
    }
    if (this.vectorStore) {
      await this.vectorStore.dispose();
      this.vectorStore = null;
    }

    // LLM providers
    this.lmStudioService?.dispose();
    this.lmStudioService = null;
    this.ollamaService?.dispose();
    this.ollamaService = null;

    // Health monitor
    this.healthMonitor?.dispose();
    this.healthMonitor = null;

    this.servicesInitialized = false;
  }

  /**
   * Initialize services asynchronously using the state machine
   */
  private async initializeServicesAsync(): Promise<void> {
    if (this.servicesInitialized) return;
    if (!this.initStateMachine) {
      console.error("[Notient] State machine not initialized");
      return;
    }

    console.log("[Notient] Initializing services...");
    this.kernel.setServicesInitializing(true);

    const eventBus = this.kernel.eventBus;
    let lmStudioFailed = false;

    try {
      // =========================================================================
      // PHASE 1: CHECKING_PROVIDERS
      // =========================================================================
      this.initStateMachine.transition("CHECKING_PROVIDERS", {
        progress: { stage: "providers", percent: 0, message: "Checking configuration..." },
      });

      // Create health monitor first
      this.healthMonitor = new HealthMonitor(this.kernel);
      await this.healthMonitor.initialize();
      this.kernel.registerService("healthMonitor", this.healthMonitor);

      // Validate required configuration (Scenario C1-C9)
      const hasEmbeddingModel = Boolean(this.settings.ollama.embeddingModel);
      const hasReasoningModel = Boolean(this.settings.lmstudio.reasoningModel);
      const ollamaEnabled = this.settings.ollama.enabled;
      const lmstudioEnabled = this.settings.lmstudio.enabled;

      if (!hasEmbeddingModel || !ollamaEnabled) {
        // Scenario P3: Ollama required but not configured → FAILED
        this.initStateMachine.transition("FAILED", {
          errorMessage: "Ollama embedding model not configured. Run setup wizard.",
          failedReason: "missing_config",
        });
        this.kernel.setServicesInitializing(false);
        this.kernel.obsidian.notice("Notient requires Ollama for embeddings. Run setup wizard.");
        return;
      }

      this.initStateMachine.updateProgress({
        stage: "providers",
        percent: 20,
        message: "Connecting to Ollama...",
      });

      // Initialize Ollama (required for embeddings - Scenario P1-P11)
      try {
        this.ollamaService = new OllamaService(this.kernel);
        await this.ollamaService.initialize();
        this.kernel.registerService("ollama", this.ollamaService);
      } catch (ollamaError) {
        // Scenario P3/P6: Ollama down → FAILED
        const errorMsg = ollamaError instanceof Error ? ollamaError.message : "Connection failed";
        const isNetworkError = errorMsg.includes("fetch") || errorMsg.includes("ECONNREFUSED");

        this.initStateMachine.transition("FAILED", {
          errorMessage: isNetworkError
            ? "Cannot connect to Ollama. Is it running?"
            : `Ollama error: ${errorMsg}`,
          failedReason: isNetworkError ? "connection_failed" : "critical_error",
        });
        this.kernel.setServicesInitializing(false);
        this.kernel.obsidian.notice("Cannot connect to Ollama. Is it running on port 11434?");
        return;
      }

      // Initialize dedicated reranker (optional - continues without if unavailable)
      try {
        this.ollamaReranker = new OllamaRerankerService(this.kernel);
        await this.ollamaReranker.initialize();
        this.kernel.registerService("ollamaReranker", this.ollamaReranker);
        console.log("[Notient] Ollama reranker service initialized");
      } catch (rerankerError) {
        console.warn(
          "[Notient] Ollama reranker initialization failed (will use LLM fallback):",
          rerankerError,
        );
      }

      this.initStateMachine.updateProgress({
        stage: "providers",
        percent: 40,
        message: "Connecting to LM Studio...",
      });

      // Initialize LM Studio (optional - Scenario P2)
      if (hasReasoningModel && lmstudioEnabled) {
        try {
          this.lmStudioService = new LMStudioService(this.kernel);
          await this.lmStudioService.initialize();
          this.kernel.registerService("lmstudio", this.lmStudioService);
          console.log("[Notient] LM Studio service initialized");
        } catch (lmError) {
          // Scenario P2: LM Studio down → continue in degraded mode
          console.warn(
            "[Notient] LM Studio initialization failed (chat/reranking disabled):",
            lmError,
          );
          lmStudioFailed = true;
        }
      } else {
        lmStudioFailed = true;
      }

      // =========================================================================
      // PHASE 2: LOADING_INDEX
      // =========================================================================
      this.initStateMachine.transition("LOADING_INDEX", {
        progress: { stage: "index", percent: 50, message: "Loading vector store..." },
      });

      // Create and initialize vector store (loads HNSW WASM)
      this.vectorStore = new HNSWVectorStore(this.kernel);
      await this.vectorStore.initialize();
      this.kernel.registerService("vectorStore", this.vectorStore);

      this.initStateMachine.updateProgress({
        stage: "index",
        percent: 60,
        message: "Loading index...",
      });

      // Initialize index manager (discovers/loads index, populates vectorStore)
      // Note: vectorStore.initialize() must be called first so HNSW WASM is ready
      if (!this.vectorStore) throw new Error("VectorStore not initialized");
      this.indexManager = new IndexManager(this.kernel, this.vectorStore);
      await this.indexManager.initialize();
      this.kernel.registerService("indexManager", this.indexManager);

      this.initStateMachine.updateProgress({
        stage: "index",
        percent: 70,
        message: "Initializing indexer...",
      });

      // Initialize indexer
      if (!this.ollamaService) throw new Error("OllamaService not initialized");
      this.indexer = new SimpleIndexer(
        this.kernel,
        eventBus,
        this.indexManager,
        this.ollamaService,
      );
      await this.indexer.initialize();
      this.kernel.registerService("indexer", this.indexer);

      // =========================================================================
      // PHASE 3: WARMING_SERVICES
      // =========================================================================
      // Only transition if not in CRASHED state
      if (this.initStateMachine.state !== "CRASHED") {
        this.initStateMachine.transition("WARMING_SERVICES", {
          progress: { stage: "services", percent: 75, message: "Initializing search..." },
        });
      }

      // Initialize search pipeline (ollamaService and vectorStore already validated above)
      this.searchPipeline = new SearchPipeline(
        this.kernel,
        eventBus,
        this.ollamaService,
        this.vectorStore,
      );
      await this.searchPipeline.initialize();
      this.kernel.registerService("search", this.searchPipeline);

      // Progressive search orchestrator (INSTANT → EVOLVING → DEEP)
      this.progressiveSearch = new ProgressiveSearchOrchestrator(this.searchPipeline, eventBus);
      this.kernel.registerService("progressiveSearch", this.progressiveSearch);

      // Vault context builder (for RAG)
      this.contextBuilder = new VaultContextBuilder(this.kernel);
      this.kernel.registerService("context", this.contextBuilder);

      // Vault vitals (simplified)
      this.vaultVitals = new SimpleVaultVitals(
        this.kernel,
        eventBus,
        this.vectorStore,
        this.indexManager,
      );
      this.kernel.registerService("vitals", this.vaultVitals);

      if (this.initStateMachine.state !== "CRASHED") {
        this.initStateMachine.updateProgress({
          stage: "services",
          percent: 80,
          message: "Initializing LLM provider...",
        });
      }

      // LLM Provider for agent
      this.llmProvider = new LMStudioProvider(
        this.settings.lmstudio.host,
        this.settings.lmstudio.reasoningModel,
      );
      try {
        await this.llmProvider.initialize();
        this.kernel.registerService("llmProvider", this.llmProvider);
      } catch (llmError) {
        console.warn("[Notient] LLM Provider initialization failed:", llmError);
        lmStudioFailed = true;
      }

      // Identity system: ProfileManager
      this.profileManager = new ProfileManager(this.app.vault, this.kernel);
      await this.profileManager.load();
      this.kernel.registerService("profileManager", this.profileManager);
      console.log(
        "[Notient] ProfileManager initialized:",
        this.profileManager.get()?.domain?.primary || "(no profile)",
      );

      // Evolution system: UserEvolutionService (PART 1.3)
      this.userEvolution = new UserEvolutionService(eventBus);
      await this.userEvolution.load();
      this.kernel.registerService("userEvolution", this.userEvolution);
      console.log("[Notient] UserEvolutionService initialized");

      // Note intelligence service
      this.noteIntelligence = new NoteIntelligenceService(this.kernel, eventBus);
      await this.noteIntelligence.initialize();
      this.kernel.registerService("intelligence", this.noteIntelligence);

      if (this.initStateMachine.state !== "CRASHED") {
        this.initStateMachine.updateProgress({
          stage: "services",
          percent: 90,
          message: "Initializing agent system...",
        });
      }

      // Always create AgentTaskQueue (graceful degradation when LLM unavailable)
      this.agentTaskQueue = new AgentTaskQueue(null, eventBus);
      this.kernel.registerService("taskQueue", this.agentTaskQueue);

      // Create NotientAgent if LLM Provider initialized successfully
      if (this.llmProvider && !lmStudioFailed) {
        const currentProfile = this.profileManager?.get();
        this.notientAgent = new NotientAgent(
          this.llmProvider,
          this.searchPipeline,
          this.contextBuilder,
          this.kernel.obsidian,
          currentProfile,
        );
        this.kernel.registerService("agent", this.notientAgent);

        // Wire agent to taskQueue (late binding)
        this.agentTaskQueue.setAgent(this.notientAgent);

        // Subscribe to profile updates
        eventBus.on("profile:updated", (event) => {
          this.notientAgent?.setProfile(event.profile);
        });
      } else {
        console.warn(
          "[Notient] LLM provider not available - agent tasks will fail with clear error",
        );
      }

      // ConversationStore
      this.conversationStore = new ConversationStore(this.kernel.storagePaths, {
        maxMessagesPerNote: this.settings.chatRetention.maxMessagesPerNote,
        maxAgeDays: this.settings.chatRetention.maxAgeDays,
      });
      await this.conversationStore.load();
      this.conversationStore.prune();
      this.kernel.registerService("conversationStore", this.conversationStore);

      // Always wire conversation store (taskQueue always exists now)
      this.agentTaskQueue.setConversationStore(this.conversationStore);

      // File rename handler
      this.kernel.obsidian.onFileRename((file, oldPath) => {
        if (this.conversationStore) {
          this.conversationStore.handleRename(oldPath, file.path);
        }
      });

      // Agentic services
      this.trustLevelManager = new TrustLevelManager(this.settings.agent.trustPolicy);
      this.kernel.registerService("trustLevelManager", this.trustLevelManager);

      this.actionHistory = new ActionHistory(
        this.kernel.storagePaths,
        this.kernel.obsidian,
        this.kernel.eventBus,
        {
          maxEntries: this.settings.agent.history.maxEntries,
          maxAgeDays: this.settings.agent.history.maxAgeDays,
          maxSizeBytes: 10 * 1024 * 1024,
        },
      );
      await this.actionHistory.load();
      this.actionHistory.prune();
      this.kernel.registerService("actionHistory", this.actionHistory);

      this.actionApplier = new ActionApplier(
        this.kernel,
        this.kernel.obsidian,
        this.actionHistory,
        this.trustLevelManager,
      );
      this.kernel.registerService("actionApplier", this.actionApplier);

      // Always create WorkflowRunner (taskQueue always exists now)
      this.workflowRunner = new WorkflowRunner(
        this.kernel,
        eventBus,
        this.agentTaskQueue,
        this.kernel.obsidian,
        {
          maxNotesPerWorkflow: this.settings.agent.bulk.maxNotesPerWorkflow,
          delayBetweenTasksMs: this.settings.agent.bulk.delayBetweenTasksMs,
        },
      );
      this.kernel.registerService("workflowRunner", this.workflowRunner);

      // ActionOrchestrator (requires lmstudio + search)
      if (this.lmStudioService && this.searchPipeline) {
        const profileProvider = () => this.profileManager?.get();
        this.actionOrchestrator = new ActionOrchestrator(
          this.lmStudioService,
          this.searchPipeline,
          profileProvider,
        );
        this.kernel.registerService("actionOrchestrator", this.actionOrchestrator);
      }

      // MigrationService (for "Expand Your Knowledge" feature)
      this.migrationService = new MigrationService(this.kernel, eventBus);
      this.kernel.registerService("migrationService", this.migrationService);

      // Register action event handlers (PART 2.3)
      this.registerActionEventHandlers(eventBus);

      // =========================================================================
      // PHASE 4: READY or DEGRADED
      // =========================================================================
      this.servicesInitialized = true;

      if (this.initStateMachine.state === "CRASHED") {
        // Stay in CRASHED state - let user choose recovery
        this.kernel.setServicesInitializing(false);
        this.kernel.obsidian.notice(
          "Previous indexing interrupted. Check settings for recovery options.",
        );
        return;
      }

      if (lmStudioFailed) {
        // Scenario P2: LM Studio down → DEGRADED
        this.initStateMachine.transition("DEGRADED", {
          degradedReason: "lmstudio_down",
          errorMessage: "LM Studio unavailable. Chat and reranking disabled.",
        });
        this.kernel.obsidian.notice("Notient ready (limited mode - LM Studio not connected)");
      } else {
        // All good → READY
        this.initStateMachine.transition("READY");
      }

      this.kernel.setServicesInitialized();

      // Handle index action from wizard or default behavior
      const indexAction = this._pendingIndexAction;
      this._pendingIndexAction = "none";

      console.log("[Notient] Index action decision:", {
        action: indexAction,
        setupComplete: this.settings.setupComplete,
        hasIndex: (await this.indexManager.getIndexedCount()) > 0,
      });

      if (indexAction !== "none") {
        setTimeout(() => this.executeIndexAction(indexAction), 500);
      } else if (this.settings.setupComplete) {
        // Check index state and auto-resume if incomplete
        const stats = await this.indexManager.getStats();

        // Dev mode: skip auto-indexing for faster testing
        if (this.settings.advanced.devSkipAutoIndex) {
          console.log(
            `[Notient] Dev mode: skipping auto-index (${stats.noteCount}/${stats.vaultNoteCount} notes)`,
          );
          this.kernel.obsidian.notice("Dev mode: indexing skipped for faster testing");
        } else if (stats.state === "none") {
          console.log("[Notient] No index found, starting initial indexing");
          setTimeout(() => this.startBackgroundIndexing("rebuild"), 2000);
        } else if (stats.state === "incomplete") {
          // Auto-resume: silently continue indexing remaining notes
          console.log(
            `[Notient] Incomplete index (${stats.noteCount}/${stats.vaultNoteCount}), auto-resuming...`,
          );
          if (!lmStudioFailed) {
            this.kernel.obsidian.notice(
              `Resuming indexing: ${stats.noteCount}/${stats.vaultNoteCount} notes...`,
            );
          }
          setTimeout(() => this.startBackgroundIndexing("sync"), 2000);
        } else {
          console.log(`[Notient] Index ready: ${stats.noteCount} notes (${stats.state})`);
          if (!lmStudioFailed) {
            this.kernel.obsidian.notice(`Notient ready! ${stats.noteCount} notes indexed.`);
          }
        }
      }
    } catch (error) {
      console.error("[Notient] Service initialization failed:", error);
      const errorMsg = error instanceof Error ? error.message : "Unknown error";

      if (this.initStateMachine.state !== "CRASHED") {
        this.initStateMachine.transition("FAILED", {
          errorMessage: `Initialization failed: ${errorMsg}`,
          failedReason: "critical_error",
        });
      }

      this.kernel.setServicesInitializing(false);
      this.kernel.obsidian.notice("Notient initialization failed. Check console for details.");
    }
  }

  private registerViews(): void {
    // Sidebar view - services resolved lazily via kernel.getService()
    this.registerView(VIEW_TYPE_SIDEBAR, (leaf) => {
      return new NotientSidebarView(leaf, this.kernel);
    });

    // Dashboard view - services resolved lazily via kernel.getService()
    this.registerView(VIEW_TYPE_DASHBOARD, (leaf) => {
      return new NotientDashboardView(leaf, this.kernel);
    });
  }

  private registerCommands(): void {
    // Open sidebar
    this.addCommand({
      id: "open-sidebar",
      name: "Open Notient sidebar",
      callback: () => this.activateSidebar(),
    });

    // Open dashboard
    this.addCommand({
      id: "open-dashboard",
      name: "Open Vault Vitals dashboard",
      callback: () => this.activateDashboard(),
    });

    // Semantic search
    this.addCommand({
      id: "semantic-search",
      name: "Semantic search",
      callback: () => {
        this.activateSidebar();
        setTimeout(() => {
          const input = document.querySelector(".notient-search-input") as HTMLInputElement;
          input?.focus();
        }, 100);
      },
    });

    // Reindex vault (incremental)
    this.addCommand({
      id: "reindex-vault",
      name: "Sync vault index (incremental)",
      callback: async () => {
        if (!this.indexer || !this.kernel.capabilities.indexing) {
          this.kernel.obsidian.notice("Cannot index - check service connections");
          return;
        }
        // Block on external read-only indices
        if (this.indexManager?.isReadOnly()) {
          this.kernel.obsidian.notice(
            "Cannot sync: External index is read-only. Switch to a plugin-managed index.",
          );
          return;
        }
        this.kernel.obsidian.notice("Starting vault sync...");
        const result = await this.indexer.syncVault();
        this.kernel.obsidian.notice(
          `Sync complete: ${result.added} added, ${result.updated} updated`,
        );
      },
    });

    // Full reindex
    this.addCommand({
      id: "full-reindex",
      name: "Full reindex (rebuild everything)",
      callback: async () => {
        if (!this.indexer || !this.kernel.capabilities.indexing) {
          this.kernel.obsidian.notice("Cannot index - check service connections");
          return;
        }
        this.kernel.obsidian.notice("Starting full reindex...");
        const result = await this.indexer.fullReindex();
        this.kernel.obsidian.notice(
          `Reindex complete: ${result.added + result.updated} notes in ${Math.round(result.durationMs / 1000)}s`,
        );
      },
    });

    // Compute vitals
    this.addCommand({
      id: "compute-vitals",
      name: "Refresh Vault Vitals",
      callback: async () => {
        if (!this.vaultVitals) {
          this.kernel.obsidian.notice("Vitals not available - setup required");
          return;
        }
        const vitals = await this.vaultVitals.compute();
        const score = this.vaultVitals.calculateHealthScore(vitals);
        this.kernel.obsidian.notice(`Vault Health: ${score.overall}/100`);
      },
    });

    // Run setup wizard
    this.addCommand({
      id: "run-setup",
      name: "Run setup wizard",
      callback: () => this.showSetupWizard(),
    });

    // Debug diagnostics
    this.addCommand({
      id: "debug-diagnostics",
      name: "Debug: Show diagnostics",
      callback: async () => {
        const search = this.kernel.getService<SearchPipeline>("search");
        const store = this.vectorStore;

        const caps = this.kernel.capabilities;
        const health = this.kernel.serviceHealth;

        const diagnostics = {
          servicesInitialized: this.servicesInitialized,
          capabilities: caps,
          health: {
            ollama: health.ollama.status,
            lmstudio: health.lmstudio.status,
          },
          vectorStore: store
            ? {
                ready: store.isReady(),
                chunkCount: await store.countChunks(),
                noteCount: await store.countNotes(),
              }
            : null,
          searchPipeline: search ? "available" : "null",
        };

        console.log("[Notient] Diagnostics:", diagnostics);

        // Also show in notice
        const storeInfo = store
          ? `${await store.countChunks()} chunks / ${await store.countNotes()} notes`
          : "not ready";
        this.kernel.obsidian.notice(
          `Notient: Ollama=${health.ollama.status}, Search=${search ? "ready" : "no"}, Store=${storeInfo}`,
        );
      },
    });

    // Generate profile from vault
    this.addCommand({
      id: "generate-profile",
      name: "Generate Profile from Vault",
      callback: async () => {
        if (!this.profileManager) {
          new Notice("Profile manager not available. Complete setup first.");
          return;
        }

        // Check if index exists
        if (!this.indexManager || (await this.indexManager.getIndexedCount()) === 0) {
          new Notice("Please build the vault index first (Settings > Index > Rebuild)");
          return;
        }

        // Show progress notice
        const notice = new Notice("Analyzing vault...", 0); // 0 = don't auto-dismiss

        try {
          const profile = await this.profileManager.infer((status, message) => {
            notice.setMessage(message);
          });

          notice.hide();

          // Show preview modal
          const modal = new ProfilePreviewModal(this.app, profile);
          const editedProfile = await modal.run();

          if (editedProfile) {
            await this.profileManager.save(editedProfile);
            // Propagate profile to agent for prompt personalization
            this.notientAgent?.setProfile(editedProfile);
            new Notice("Profile saved successfully");
          }
        } catch (error) {
          notice.hide();
          new Notice(`Profile generation failed: ${(error as Error).message}`);
        }
      },
    });

    // Edit profile (opens settings)
    this.addCommand({
      id: "edit-profile",
      name: "Edit Profile",
      callback: () => {
        // Open settings tab - using the Obsidian API pattern
        // biome-ignore lint/suspicious/noExplicitAny: Obsidian internal API
        (this.app as any).setting?.open?.();
        // Note: Cannot scroll to specific section easily, user will see Identity section
      },
    });

    // Import markdown files
    this.addCommand({
      id: "import-markdown",
      name: "Import markdown files",
      callback: async () => {
        // Ensure importer service exists
        if (!this.importerService) {
          this.importerService = new ImporterService(this.kernel);
        }
        const modal = new ImportModal(this.app, this.importerService);
        const result = await modal.run();
        if (result.completed && result.summary) {
          const { created, updated, totalLinksConverted } = result.summary;
          new Notice(
            `Import complete: ${created} created, ${updated} updated, ${totalLinksConverted} links fixed`,
          );
        }
      },
    });
  }

  private async activateSidebar(): Promise<void> {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({ type: VIEW_TYPE_SIDEBAR, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  private async activateDashboard(): Promise<void> {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD)[0];

    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_DASHBOARD, active: true });
    }

    workspace.revealLeaf(leaf);
  }

  private async showSetupWizard(): Promise<void> {
    // Reuse existing health monitor or create one (avoids duplicate monitors)
    if (!this.healthMonitor) {
      this.healthMonitor = new HealthMonitor(this.kernel);
      await this.healthMonitor.initialize();
    }

    // Track if this is a fresh setup or reconfiguration
    const wasSetupComplete = this.settings.setupComplete;
    const previousModel = this.settings.ollama.embeddingModel;

    const wizard = new SetupWizardModal(this.app, this.healthMonitor, this.settings, {
      discoverIndices: async () => IndexManager.discoverIndices(this.kernel.storagePaths),
    });

    const result = await wizard.run();

    if (result.completed) {
      const newModel = result.settings.ollama?.embeddingModel || previousModel;
      const modelChanged = previousModel !== newModel;

      this.settings = {
        ...this.settings,
        ...result.settings,
        ollama: { ...this.settings.ollama, ...result.settings.ollama },
        lmstudio: { ...this.settings.lmstudio, ...result.settings.lmstudio },
        indexing: { ...this.settings.indexing, ...result.settings.indexing },
        setupComplete: true,
      };

      // If user selected an existing index, save its path as active
      if (result.indexAction === "use_existing" && result.selectedIndexKey) {
        this.settings.indexing.activeIndexPath = result.selectedIndexKey;
      }

      await saveSettings(this, this.settings);
      this.settingTab.updateSettings(this.settings);
      this.kernel.updateSettings(this.settings);

      // Store the index action from wizard
      this._pendingIndexAction = result.indexAction;

      console.log(
        `[Notient] Wizard complete: wasSetup=${wasSetupComplete}, modelChanged=${modelChanged}, newModel=${newModel}, indexAction=${result.indexAction}, selectedPath=${result.selectedIndexKey}`,
      );

      if (!wasSetupComplete) {
        this.kernel.obsidian.notice("Notient configured! Initializing...");
      } else if (modelChanged) {
        this.kernel.obsidian.notice(`Model changed to ${newModel}. Creating new index...`);
      } else {
        this.kernel.obsidian.notice("Settings updated! Reconnecting...");
      }

      await this.reinitializeServices();
    }
  }

  // Track the index action requested by the wizard
  private _pendingIndexAction: "none" | "use_existing" | "sync" | "rebuild" = "none";

  private async reinitializeServices(): Promise<void> {
    try {
      // Abort any ongoing indexing before disposing
      this.indexingAbortController?.abort();
      this.indexingAbortController = null;

      await this.disposeServices();

      // Reset state machine for fresh start
      this.initStateMachine?.dispose();
      this.initStateMachine = new InitializationStateMachine({
        eventBus: this.kernel.eventBus,
        onStateChange: (context) => {
          console.log("[Notient] Init state:", context.state, context.capabilities);
        },
      });

      await this.initializeServicesAsync();

      if (this.servicesInitialized) {
        this.kernel.obsidian.notice("Notient ready! Starting background indexing...");
      }
    } catch (error) {
      console.error("[Notient] Reinitialization failed:", error);
      this.kernel.obsidian.notice("Setup failed. Check console for details.");
    }
  }

  /**
   * Reinitialize only chat-related services.
   * Preserves: vectorStore, indexManager, indexer, searchPipeline, conversationStore
   * Recreates: lmStudioService, llmProvider, notientAgent, agentTaskQueue
   */
  private async reinitializeChatOnly(): Promise<void> {
    console.log("[Notient] Chat model changed, reconnecting...");

    try {
      // Dispose chat services only (in reverse initialization order)
      this.agentTaskQueue = null;
      this.notientAgent = null;

      this.llmProvider?.dispose();
      this.llmProvider = null;

      this.lmStudioService?.dispose();
      this.lmStudioService = null;

      // Recreate LM Studio service
      if (this.settings.lmstudio.enabled && this.settings.lmstudio.reasoningModel) {
        try {
          this.lmStudioService = new LMStudioService(this.kernel);
          await this.lmStudioService.initialize();
          this.kernel.registerService("lmstudio", this.lmStudioService);
          console.log("[Notient] LM Studio service reconnected");
        } catch (lmError) {
          console.warn("[Notient] LM Studio reconnection failed:", lmError);
        }
      }

      // Recreate LLM Provider
      this.llmProvider = new LMStudioProvider(
        this.settings.lmstudio.host,
        this.settings.lmstudio.reasoningModel,
      );
      try {
        await this.llmProvider.initialize();
        this.kernel.registerService("llmProvider", this.llmProvider);
      } catch (llmError) {
        console.warn("[Notient] LLM Provider reconnection failed:", llmError);
      }

      // Recreate AgentTaskQueue (always create for graceful degradation)
      this.agentTaskQueue = new AgentTaskQueue(null, this.kernel.eventBus);
      this.kernel.registerService("taskQueue", this.agentTaskQueue);

      // Recreate NotientAgent if LLM Provider available
      if (this.llmProvider && this.searchPipeline && this.contextBuilder) {
        const currentProfile = this.profileManager?.get();
        this.notientAgent = new NotientAgent(
          this.llmProvider,
          this.searchPipeline,
          this.contextBuilder,
          this.kernel.obsidian,
          currentProfile,
        );
        this.kernel.registerService("agent", this.notientAgent);

        // Wire agent to taskQueue
        this.agentTaskQueue.setAgent(this.notientAgent);
      }

      // Wire conversation store to taskQueue (preserves existing chat history)
      if (this.conversationStore) {
        this.agentTaskQueue.setConversationStore(this.conversationStore);
      }

      this.kernel.obsidian.notice("Chat model reconnected");
      console.log("[Notient] Chat services reinitialized");
    } catch (error) {
      console.error("[Notient] Chat reinit failed:", error);
      this.kernel.obsidian.notice("Chat reconnection failed. Check console for details.");
    }
  }

  /**
   * Execute index action from wizard
   */
  private async executeIndexAction(action: "use_existing" | "sync" | "rebuild"): Promise<void> {
    if (!this.indexManager) return;

    console.log("[Notient] Executing index action:", action);

    switch (action) {
      case "use_existing":
        this.kernel.obsidian.notice("Using existing index. Ready to search!");
        break;
      case "sync":
        this.kernel.obsidian.notice("Syncing index with vault changes...");
        await this.startBackgroundIndexing("sync");
        break;
      case "rebuild":
        this.kernel.obsidian.notice("Building index from scratch...");
        await this.startBackgroundIndexing("rebuild");
        break;
    }
  }

  /**
   * Show index options modal (for manual trigger from settings/commands)
   * @internal Reserved for future use in settings UI
   */
  private async _showIndexOptionsAndStart(): Promise<void> {
    if (!this.indexManager) return;

    const stats = await this.indexManager.getStats();
    console.log("[Notient] Showing index options. State:", stats.state, stats);

    // If no index exists, just start indexing
    if (stats.state === "none") {
      this.kernel.obsidian.notice("Starting initial vault indexing...");
      await this.startBackgroundIndexing("rebuild");
      return;
    }

    // Show options modal
    const modal = new IndexOptionsModal(this.app, stats, false);
    const result = await modal.run();

    console.log("[Notient] User chose:", result.option);

    switch (result.option) {
      case "use_existing":
        this.kernel.obsidian.notice("Using existing index. Ready to search!");
        break;
      case "resume":
        this.kernel.obsidian.notice("Resuming indexing...");
        await this.startBackgroundIndexing("sync");
        break;
      case "rebuild":
        this.kernel.obsidian.notice("Rebuilding index from scratch...");
        await this.startBackgroundIndexing("rebuild");
        break;
      case "cancel":
        this.kernel.obsidian.notice("Indexing skipped. You can start it later from settings.");
        break;
    }
  }

  /**
   * Start background indexing with specified action
   */
  private async startBackgroundIndexing(action: "sync" | "rebuild"): Promise<void> {
    if (!this.indexer || !this.indexManager) {
      console.log("[Notient] Cannot start indexing - services not initialized");
      return;
    }

    if (!this.kernel.capabilities.indexing) {
      console.log(
        "[Notient] Cannot start indexing - missing capabilities:",
        this.kernel.capabilities,
      );
      const health = this.kernel.serviceHealth;
      if (health.ollama.status !== "healthy") {
        this.kernel.obsidian.notice("Cannot index: Ollama not connected");
      }
      return;
    }

    // Create AbortController for this indexing session
    this.indexingAbortController = new AbortController();
    const signal = this.indexingAbortController.signal;

    try {
      const stats = await this.indexManager.getStats();
      console.log("[Notient] Starting indexing:", { action, state: stats.state });

      if (action === "rebuild") {
        console.log("[Notient] Full reindex requested");
        const result = await this.indexer.fullReindex(signal);
        if (!signal.aborted) {
          this.kernel.obsidian.notice(
            `Indexing complete: ${result.added + result.updated} notes in ${Math.round(result.durationMs / 1000)}s`,
            5000,
          );
        }
      } else {
        // Sync - incremental indexing
        const result = await this.indexer.syncVault(signal);

        if (!signal.aborted) {
          if (result.added > 0 || result.updated > 0) {
            this.kernel.obsidian.notice(
              `Sync complete: ${result.added} new, ${result.updated} updated`,
              3000,
            );
          } else {
            this.kernel.obsidian.notice("Index up to date", 2000);
          }
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        console.error("[Notient] Indexing failed:", error);
        this.kernel.obsidian.notice("Indexing failed. Check console for details.");
      }
    } finally {
      this.indexingAbortController = null;
    }
  }

  /**
   * Register handlers for action events from UI
   * PART 2.3: Connect action:apply-requested and action:undo-requested
   */
  private registerActionEventHandlers(eventBus: typeof this.kernel.eventBus): void {
    // Handle action apply requests from UI
    eventBus.on("action:apply-requested", async ({ actionId, action }) => {
      console.log("[Notient] Action apply requested:", actionId);

      if (!this.actionApplier) {
        console.error("[Notient] ActionApplier not available");
        this.kernel.obsidian.notice("Cannot apply action - services not ready");
        return;
      }

      // If action not provided in event, try workflow runner's review queue
      let actionToApply = action;
      if (!actionToApply && this.workflowRunner) {
        // Check current and queued workflows for the action
        const currentWorkflow = this.workflowRunner.getCurrentWorkflow();
        const queuedWorkflows = this.workflowRunner.getQueuedWorkflows();
        const workflows = currentWorkflow ? [currentWorkflow, ...queuedWorkflows] : queuedWorkflows;

        for (const wf of workflows) {
          const found = wf.reviewQueue.find((a: { id: string }) => a.id === actionId);
          if (found) {
            actionToApply = found;
            break;
          }
        }
      }

      if (!actionToApply) {
        console.warn("[Notient] Could not find action:", actionId);
        this.kernel.obsidian.notice("Action not found. It may have expired.");
        return;
      }

      try {
        const result = await this.actionApplier.apply(actionToApply);
        if (result.success) {
          this.kernel.obsidian.notice(`Applied: ${actionToApply.title}`);
          // Remove from workflow review queue if applicable
          this.workflowRunner?.dismissReviewItem(actionId);
        } else {
          this.kernel.obsidian.notice(`Failed: ${result.error}`);
        }
      } catch (error) {
        console.error("[Notient] Action apply failed:", error);
        this.kernel.obsidian.notice("Action failed. Check console for details.");
      }
    });

    // Handle action undo requests from UI
    eventBus.on("action:undo-requested", async ({ actionId }) => {
      console.log("[Notient] Action undo requested:", actionId);

      if (!this.actionHistory) {
        console.error("[Notient] ActionHistory not available");
        this.kernel.obsidian.notice("Cannot undo - services not ready");
        return;
      }

      try {
        const success = await this.actionHistory.undo(actionId);
        if (success) {
          this.kernel.obsidian.notice("Action undone successfully");
        } else {
          this.kernel.obsidian.notice("Could not undo action. It may have already been undone.");
        }
      } catch (error) {
        console.error("[Notient] Action undo failed:", error);
        this.kernel.obsidian.notice("Undo failed. Check console for details.");
      }
    });

    console.log("[Notient] Action event handlers registered");
  }
}
