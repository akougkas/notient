/**
 * Notient - AI-powered vault management for Obsidian
 *
 * Main plugin entry point.
 * SAFETY: Plugin must always load. Services initialize lazily after setup.
 *
 * Architecture (Simplified):
 * - SimpleVectorStore: Brute-force cosine similarity, JSON persistence
 * - IndexManager: Coordinates vector store and note state
 * - SimpleIndexer: Batch processing with UI yields, no JobQueue
 * - SearchPipeline: Cached semantic search
 */

import { Plugin } from "obsidian";
import { AgentTaskQueue, NotientAgent } from "./core/agent";
import { ActionApplier, ActionHistory, TrustLevelManager, WorkflowRunner } from "./core/agentic";
// Phase 2: Conversation persistence + Agentic services
import { ConversationStore } from "./core/chat";
import { VIEW_TYPE_DASHBOARD, VIEW_TYPE_SIDEBAR } from "./core/constants";
import { VaultContextBuilder } from "./core/context/vaultContextBuilder";
import { SimpleIndexer } from "./core/indexer/simpleIndexer";
import { ActionOrchestrator } from "./core/intelligence/actionOrchestrator";
import { NoteIntelligenceService } from "./core/intelligence/noteIntelligence";
import { Kernel, type KernelContext } from "./core/kernel";
// New architecture (Phase 1.8)
import { LMStudioProvider } from "./core/llm";
import { SearchPipeline } from "./core/search/pipeline";
import { SimpleVaultVitals } from "./core/vitals/simpleVitals";
import { HealthMonitor } from "./services/healthMonitor";
import { IndexManager } from "./services/indexManager";
import { LMStudioService } from "./services/lmstudio";
import { OllamaService } from "./services/ollama";
import { SimpleVectorStore } from "./services/simpleVectorStore";
import { NotientSettingTab, loadSettings, saveSettings } from "./settings";
import type { NotientSettings } from "./types/settings";
import { NotientDashboardView } from "./views/dashboard";
import { IndexOptionsModal } from "./views/indexOptionsModal";
import { SetupWizardModal } from "./views/setupWizard";
import { NotientSidebarView } from "./views/sidebar";

export default class NotientPlugin extends Plugin {
  private kernel!: Kernel;
  private settings!: NotientSettings;
  private settingTab!: NotientSettingTab;

  // Services - initialized lazily
  private healthMonitor: HealthMonitor | null = null;
  private ollamaService: OllamaService | null = null;
  private lmStudioService: LMStudioService | null = null;
  private vectorStore: SimpleVectorStore | null = null;
  private indexManager: IndexManager | null = null;
  private indexer: SimpleIndexer | null = null;
  private searchPipeline: SearchPipeline | null = null;
  private contextBuilder: VaultContextBuilder | null = null;
  private vaultVitals: SimpleVaultVitals | null = null;
  // Phase 3: Note intelligence (summaries + health)
  private noteIntelligence: NoteIntelligenceService | null = null;
  // New architecture (Phase 1.8)
  private llmProvider: LMStudioProvider | null = null;
  private notientAgent: NotientAgent | null = null;
  private agentTaskQueue: AgentTaskQueue | null = null;

  // Phase 2: Conversation persistence + Agentic services
  private conversationStore: ConversationStore | null = null;
  private actionHistory: ActionHistory | null = null;
  private trustLevelManager: TrustLevelManager | null = null;
  private actionApplier: ActionApplier | null = null;
  private workflowRunner: WorkflowRunner | null = null;
  // Intelligence 2.0
  private actionOrchestrator: ActionOrchestrator | null = null;

  private servicesInitialized = false;

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
        const llmFields = [
          "ollama.host",
          "ollama.embeddingModel",
          "lmstudio.host",
          "lmstudio.reasoningModel",
        ];
        const needsReinit = changedFields.some((f) => llmFields.includes(f));
        if (needsReinit && this.servicesInitialized) {
          console.log("[Notient] LLM settings changed, reinitializing services...");
          await this.reinitializeServices();
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
      // Dispose services in reverse order
      // Phase 2: Flush agentic services first
      if (this.workflowRunner) {
        this.workflowRunner.dispose();
        this.workflowRunner = null;
      }
      if (this.actionApplier) {
        this.actionApplier = null;
      }
      if (this.actionOrchestrator) {
        this.actionOrchestrator = null;
      }
      if (this.trustLevelManager) {
        this.trustLevelManager = null;
      }
      if (this.actionHistory) {
        await this.actionHistory.dispose();
        this.actionHistory = null;
      }
      if (this.conversationStore) {
        await this.conversationStore.dispose();
        this.conversationStore = null;
      }

      this.agentTaskQueue = null;
      this.notientAgent = null;
      this.llmProvider?.dispose();
      this.noteIntelligence?.dispose();
      this.vaultVitals?.dispose();
      this.contextBuilder = null;
      this.searchPipeline?.dispose();
      this.indexer?.dispose();
      if (this.indexManager) {
        await this.indexManager.dispose();
      }
      if (this.vectorStore) {
        await this.vectorStore.dispose();
      }
      this.lmStudioService?.dispose();
      this.ollamaService?.dispose();
      this.healthMonitor?.dispose();

      // Dispose kernel last
      this.kernel?.dispose();
    } catch (error) {
      console.error("[Notient] Error during unload:", error);
    }

    console.log("[Notient] Plugin unloaded");
  }

  /**
   * Initialize services asynchronously
   */
  private async initializeServicesAsync(): Promise<void> {
    if (this.servicesInitialized) return;

    console.log("[Notient] Initializing services...");
    this.kernel.setServicesInitializing(true);

    try {
      const eventBus = this.kernel.eventBus;

      // Health monitor
      this.healthMonitor = new HealthMonitor(this.kernel);
      await this.healthMonitor.initialize();
      this.kernel.registerService("healthMonitor", this.healthMonitor);

      // Validate required configuration
      const hasEmbeddingModel = Boolean(this.settings.ollama.embeddingModel);
      const hasReasoningModel = Boolean(this.settings.lmstudio.reasoningModel);
      const ollamaEnabled = this.settings.ollama.enabled;
      const lmstudioEnabled = this.settings.lmstudio.enabled;

      if (!hasEmbeddingModel || !hasReasoningModel || !ollamaEnabled || !lmstudioEnabled) {
        console.error("[Notient] Missing required configuration:", {
          hasEmbeddingModel,
          hasReasoningModel,
          ollamaEnabled,
          lmstudioEnabled,
        });
        this.kernel.obsidian.notice(
          "Notient requires BOTH Ollama and LM Studio. Run setup wizard.",
        );
        return;
      }

      console.log("[Notient] Required services configured:", {
        embeddingModel: this.settings.ollama.embeddingModel,
        reasoningModel: this.settings.lmstudio.reasoningModel,
      });

      // Initialize AI services
      try {
        // Ollama service (embeddings)
        this.ollamaService = new OllamaService(this.kernel);
        await this.ollamaService.initialize();
        this.kernel.registerService("ollama", this.ollamaService);

        // LM Studio service (reasoning/chat)
        this.lmStudioService = new LMStudioService(this.kernel);
        try {
          await this.lmStudioService.initialize();
          this.kernel.registerService("lmstudio", this.lmStudioService);
          console.log("[Notient] LM Studio service initialized");
        } catch (lmError) {
          console.warn(
            "[Notient] LM Studio initialization failed (chat/reranking disabled):",
            lmError,
          );
          // Continue without LM Studio - search still works with vector similarity
        }

        // Vector store (simple brute-force implementation)
        this.vectorStore = new SimpleVectorStore(this.kernel);
        await this.vectorStore.initialize();
        this.kernel.registerService("vectorStore", this.vectorStore);

        // Index manager (coordinates store and state)
        this.indexManager = new IndexManager(this.kernel, this.vectorStore);
        await this.indexManager.initialize();
        this.kernel.registerService("indexManager", this.indexManager);

        // Simple indexer (no JobQueue)
        this.indexer = new SimpleIndexer(
          this.kernel,
          eventBus,
          this.indexManager,
          this.ollamaService,
        );
        await this.indexer.initialize();
        this.kernel.registerService("indexer", this.indexer);

        // Search pipeline
        this.searchPipeline = new SearchPipeline(
          this.kernel,
          eventBus,
          this.ollamaService,
          this.vectorStore,
        );
        await this.searchPipeline.initialize();
        this.kernel.registerService("search", this.searchPipeline);

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

        // New architecture (Phase 1.8): LLM Provider + Notient Agent
        this.llmProvider = new LMStudioProvider(
          this.settings.lmstudio.host,
          this.settings.lmstudio.reasoningModel,
        );
        try {
          await this.llmProvider.initialize();
          this.kernel.registerService("llmProvider", this.llmProvider);
          console.log("[Notient] LLM Provider initialized (new architecture)");
        } catch (llmError) {
          console.warn("[Notient] LLM Provider initialization failed:", llmError);
          // Fall back to old service for backward compatibility
        }

        // Phase 3: Note intelligence (background summaries + health)
        this.noteIntelligence = new NoteIntelligenceService(this.kernel, eventBus);
        await this.noteIntelligence.initialize();
        this.kernel.registerService("intelligence", this.noteIntelligence);

        // Create NotientAgent (uses LLM provider, search, context)
        if (!this.llmProvider) {
          throw new Error("LLM Provider is required for NotientAgent");
        }
        this.notientAgent = new NotientAgent(
          this.llmProvider,
          this.searchPipeline,
          this.contextBuilder,
          this.kernel.obsidian,
        );
        this.kernel.registerService("agent", this.notientAgent);

        // Agent Task Queue (new architecture)
        this.agentTaskQueue = new AgentTaskQueue(this.notientAgent, eventBus);
        this.kernel.registerService("taskQueue", this.agentTaskQueue);

        // Phase 2: Initialize ConversationStore
        this.conversationStore = new ConversationStore(this.kernel.storagePaths, {
          maxMessagesPerNote: this.settings.chatRetention.maxMessagesPerNote,
          maxAgeDays: this.settings.chatRetention.maxAgeDays,
        });
        await this.conversationStore.load();
        this.conversationStore.prune(); // Enforce retention limits on startup
        this.kernel.registerService("conversationStore", this.conversationStore);

        // Wire conversation store to task queue
        this.agentTaskQueue.setConversationStore(this.conversationStore);

        // Subscribe to file renames to update conversation keys
        this.kernel.obsidian.onFileRename((file, oldPath) => {
          if (this.conversationStore) {
            this.conversationStore.handleRename(oldPath, file.path);
          }
        });

        // Phase 2: Initialize Agentic services
        // TrustLevelManager (evaluates action gating)
        this.trustLevelManager = new TrustLevelManager(this.settings.agent.trustPolicy);
        this.kernel.registerService("trustLevelManager", this.trustLevelManager);

        // ActionHistory (stores applied actions with undo data)
        this.actionHistory = new ActionHistory(
          this.kernel.storagePaths,
          this.kernel.obsidian,
          this.kernel.eventBus,
          {
            maxEntries: this.settings.agent.history.maxEntries,
            maxAgeDays: this.settings.agent.history.maxAgeDays,
            maxSizeBytes: 10 * 1024 * 1024, // 10 MB limit
          },
        );
        await this.actionHistory.load();
        this.actionHistory.prune(); // Enforce retention limits on startup
        this.kernel.registerService("actionHistory", this.actionHistory);

        // ActionApplier (applies actions to notes)
        this.actionApplier = new ActionApplier(
          this.kernel,
          this.kernel.obsidian,
          this.actionHistory,
          this.trustLevelManager,
        );
        this.kernel.registerService("actionApplier", this.actionApplier);

        // WorkflowRunner (Milestone 2.4: bulk operations)
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

        // Intelligence 2.0: ActionOrchestrator (requires lmstudio + search)
        if (this.lmStudioService && this.searchPipeline) {
          this.actionOrchestrator = new ActionOrchestrator(
            this.lmStudioService,
            this.searchPipeline,
          );
          this.kernel.registerService("actionOrchestrator", this.actionOrchestrator);
          console.log("[Notient] ActionOrchestrator initialized");
        }

        console.log("[Notient] Phase 2 agentic services initialized");

        this.servicesInitialized = true;
        this.kernel.setServicesInitialized();
        console.log("[Notient] Services initialized successfully");

        // Handle index action from wizard or default behavior
        const indexAction = this._pendingIndexAction;
        this._pendingIndexAction = "none";

        console.log("[Notient] Index action decision:", {
          action: indexAction,
          setupComplete: this.settings.setupComplete,
          hasIndex: (await this.indexManager.getIndexedCount()) > 0,
        });

        if (indexAction !== "none") {
          // Execute the action explicitly requested by wizard
          setTimeout(() => this.executeIndexAction(indexAction), 500);
        } else if (this.settings.setupComplete) {
          // For returning users with setup complete: check if index exists
          const indexCount = await this.indexManager.getIndexedCount();
          if (indexCount === 0) {
            // No index at all - need to build
            console.log("[Notient] No index found, starting initial indexing");
            setTimeout(() => this.startBackgroundIndexing("rebuild"), 2000);
          } else {
            // Has index - don't auto-sync, let user trigger it
            console.log("[Notient] Existing index found with", indexCount, "notes. Ready to use.");
            this.kernel.obsidian.notice(`Notient ready! ${indexCount} notes indexed.`);
          }
        }
        // If setup not complete and no wizard action, don't do anything
      } catch (error) {
        console.error("[Notient] Failed to initialize AI services:", error);
        this.kernel.setServicesInitializing(false);
        this.kernel.obsidian.notice(
          "Failed to connect to AI services. Check that Ollama and LM Studio are running.",
        );
      }
    } catch (error) {
      console.error("[Notient] Service initialization failed:", error);
      this.kernel.setServicesInitializing(false);
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
      // Dispose old services
      // Phase 2: Flush agentic services first
      if (this.workflowRunner) {
        this.workflowRunner.dispose();
        this.workflowRunner = null;
      }
      if (this.actionApplier) {
        this.actionApplier = null;
      }
      if (this.actionOrchestrator) {
        this.actionOrchestrator = null;
      }
      if (this.trustLevelManager) {
        this.trustLevelManager = null;
      }
      if (this.actionHistory) {
        await this.actionHistory.dispose();
        this.actionHistory = null;
      }
      if (this.conversationStore) {
        await this.conversationStore.dispose();
        this.conversationStore = null;
      }

      this.agentTaskQueue = null;
      this.notientAgent = null;
      this.llmProvider?.dispose();
      this.noteIntelligence?.dispose();
      this.searchPipeline?.dispose();
      this.contextBuilder = null;
      this.indexer?.dispose();
      if (this.indexManager) {
        await this.indexManager.dispose();
      }
      if (this.vectorStore) {
        await this.vectorStore.dispose();
      }
      this.lmStudioService?.dispose();
      this.ollamaService?.dispose();
      // Dispose HealthMonitor to stop its polling interval (prevents memory leak)
      this.healthMonitor?.dispose();

      this.llmProvider = null;
      this.noteIntelligence = null;
      this.searchPipeline = null;
      this.contextBuilder = null;
      this.indexer = null;
      this.indexManager = null;
      this.vectorStore = null;
      this.lmStudioService = null;
      this.ollamaService = null;
      this.healthMonitor = null;
      this.agentTaskQueue = null;
      this.servicesInitialized = false;

      // Reinitialize
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

    try {
      const stats = await this.indexManager.getStats();
      console.log("[Notient] Starting indexing:", { action, state: stats.state });

      if (action === "rebuild") {
        console.log("[Notient] Full reindex requested");
        const result = await this.indexer.fullReindex();
        this.kernel.obsidian.notice(
          `Indexing complete: ${result.added + result.updated} notes in ${Math.round(result.durationMs / 1000)}s`,
          5000,
        );
      } else {
        // Sync - incremental indexing
        const result = await this.indexer.syncVault();

        if (result.added > 0 || result.updated > 0) {
          this.kernel.obsidian.notice(
            `Sync complete: ${result.added} new, ${result.updated} updated`,
            3000,
          );
        } else {
          this.kernel.obsidian.notice("Index up to date", 2000);
        }
      }
    } catch (error) {
      console.error("[Notient] Indexing failed:", error);
      this.kernel.obsidian.notice("Indexing failed. Check console for details.");
    }
  }
}
