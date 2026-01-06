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
import { Kernel, KernelContext } from "./core/kernel";
import { HealthMonitor } from "./services/healthMonitor";
import { OllamaService } from "./services/ollama";
import { SimpleVectorStore } from "./services/simpleVectorStore";
import { IndexManager } from "./services/indexManager";
import { SimpleIndexer } from "./core/indexer/simpleIndexer";
import { SearchPipeline } from "./core/search/pipeline";
import { SimpleVaultVitals } from "./core/vitals/simpleVitals";
import { NotientSidebarView } from "./views/sidebar";
import { NotientDashboardView } from "./views/dashboard";
import { SetupWizardModal } from "./views/setupWizard";
import { NotientSettingTab, loadSettings, saveSettings } from "./settings";
import { VIEW_TYPE_SIDEBAR, VIEW_TYPE_DASHBOARD } from "./core/constants";
import type { NotientSettings } from "./types/settings";

export default class NotientPlugin extends Plugin {
  private kernel!: Kernel;
  private settings!: NotientSettings;
  private settingTab!: NotientSettingTab;

  // Services - initialized lazily
  private healthMonitor: HealthMonitor | null = null;
  private ollamaService: OllamaService | null = null;
  private vectorStore: SimpleVectorStore | null = null;
  private indexManager: IndexManager | null = null;
  private indexer: SimpleIndexer | null = null;
  private searchPipeline: SearchPipeline | null = null;
  private vaultVitals: SimpleVaultVitals | null = null;

  private servicesInitialized = false;

  async onload(): Promise<void> {
    console.log("[Notient] Loading plugin...");

    try {
      // Load settings first
      this.settings = await loadSettings(this);
      console.log(
        "[Notient] Settings loaded, setupComplete =",
        this.settings.setupComplete
      );

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
        async (newSettings) => {
          this.settings = newSettings;
          await saveSettings(this, newSettings);
          this.kernel.eventBus.emit("settings:changed", { changedFields: [] });
        }
      );
      this.addSettingTab(this.settingTab);

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
      this.vaultVitals?.dispose();
      this.searchPipeline?.dispose();
      this.indexer?.dispose();
      if (this.indexManager) {
        await this.indexManager.dispose();
      }
      if (this.vectorStore) {
        await this.vectorStore.dispose();
      }
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

      if (
        !hasEmbeddingModel ||
        !hasReasoningModel ||
        !ollamaEnabled ||
        !lmstudioEnabled
      ) {
        console.error("[Notient] Missing required configuration:", {
          hasEmbeddingModel,
          hasReasoningModel,
          ollamaEnabled,
          lmstudioEnabled,
        });
        this.kernel.obsidian.notice(
          "Notient requires BOTH Ollama and LM Studio. Run setup wizard."
        );
        return;
      }

      console.log("[Notient] Required services configured:", {
        embeddingModel: this.settings.ollama.embeddingModel,
        reasoningModel: this.settings.lmstudio.reasoningModel,
      });

      // Initialize AI services
      try {
        // Ollama service
        this.ollamaService = new OllamaService(this.kernel);
        await this.ollamaService.initialize();
        this.kernel.registerService("ollama", this.ollamaService);

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
          this.ollamaService
        );
        await this.indexer.initialize();
        this.kernel.registerService("indexer", this.indexer);

        // Search pipeline
        this.searchPipeline = new SearchPipeline(
          this.kernel,
          eventBus,
          this.ollamaService,
          this.vectorStore
        );
        await this.searchPipeline.initialize();
        this.kernel.registerService("search", this.searchPipeline);

        // Vault vitals (simplified)
        this.vaultVitals = new SimpleVaultVitals(
          this.kernel,
          eventBus,
          this.vectorStore,
          this.indexManager
        );
        this.kernel.registerService("vitals", this.vaultVitals);

        this.servicesInitialized = true;
        this.kernel.setServicesInitialized();
        console.log("[Notient] Services initialized successfully");

        // Start background indexing
        setTimeout(() => this.startBackgroundIndexing(), 2000);
      } catch (error) {
        console.error("[Notient] Failed to initialize AI services:", error);
        this.kernel.setServicesInitializing(false);
        this.kernel.obsidian.notice(
          "Failed to connect to AI services. Check that Ollama and LM Studio are running."
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
          const input = document.querySelector(
            ".notient-search-input"
          ) as HTMLInputElement;
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
          this.kernel.obsidian.notice(
            "Cannot index - check service connections"
          );
          return;
        }
        this.kernel.obsidian.notice("Starting vault sync...");
        const result = await this.indexer.syncVault();
        this.kernel.obsidian.notice(
          `Sync complete: ${result.added} added, ${result.updated} updated`
        );
      },
    });

    // Full reindex
    this.addCommand({
      id: "full-reindex",
      name: "Full reindex (rebuild everything)",
      callback: async () => {
        if (!this.indexer || !this.kernel.capabilities.indexing) {
          this.kernel.obsidian.notice(
            "Cannot index - check service connections"
          );
          return;
        }
        this.kernel.obsidian.notice("Starting full reindex...");
        const result = await this.indexer.fullReindex();
        this.kernel.obsidian.notice(
          `Reindex complete: ${result.added + result.updated} notes in ${Math.round(result.durationMs / 1000)}s`
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
          vectorStore: store ? {
            ready: store.isReady(),
            chunkCount: await store.countChunks(),
            noteCount: await store.countNotes(),
          } : null,
          searchPipeline: search ? "available" : "null",
        };
        
        console.log("[Notient] Diagnostics:", diagnostics);
        
        // Also show in notice
        const storeInfo = store 
          ? `${await store.countChunks()} chunks / ${await store.countNotes()} notes`
          : "not ready";
        this.kernel.obsidian.notice(
          `Notient: Ollama=${health.ollama.status}, Search=${search ? "ready" : "no"}, Store=${storeInfo}`
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
    if (!this.healthMonitor) {
      this.healthMonitor = new HealthMonitor(this.kernel);
    }

    const wizard = new SetupWizardModal(
      this.app,
      this.healthMonitor,
      this.settings
    );

    const result = await wizard.run();

    if (result.completed) {
      this.settings = {
        ...this.settings,
        ...result.settings,
        ollama: { ...this.settings.ollama, ...result.settings.ollama },
        lmstudio: { ...this.settings.lmstudio, ...result.settings.lmstudio },
        indexing: { ...this.settings.indexing, ...result.settings.indexing },
        setupComplete: true,
      };

      await saveSettings(this, this.settings);
      this.settingTab.updateSettings(this.settings);
      this.kernel.updateSettings(this.settings);

      this.kernel.obsidian.notice("Notient configured! Initializing...");
      await this.reinitializeServices();
    }
  }

  private async reinitializeServices(): Promise<void> {
    try {
      // Dispose old services
      this.searchPipeline?.dispose();
      this.indexer?.dispose();
      if (this.indexManager) {
        await this.indexManager.dispose();
      }
      if (this.vectorStore) {
        await this.vectorStore.dispose();
      }
      this.ollamaService?.dispose();

      this.searchPipeline = null;
      this.indexer = null;
      this.indexManager = null;
      this.vectorStore = null;
      this.ollamaService = null;
      this.servicesInitialized = false;

      // Reinitialize
      await this.initializeServicesAsync();

      if (this.servicesInitialized) {
        this.kernel.obsidian.notice(
          "Notient ready! Starting background indexing..."
        );
      }
    } catch (error) {
      console.error("[Notient] Reinitialization failed:", error);
      this.kernel.obsidian.notice("Setup failed. Check console for details.");
    }
  }

  private async startBackgroundIndexing(): Promise<void> {
    if (!this.indexer || !this.indexManager) {
      console.log("[Notient] Cannot start indexing - services not initialized");
      return;
    }

    if (!this.kernel.capabilities.indexing) {
      console.log("[Notient] Cannot start indexing - missing capabilities");
      return;
    }

    try {
      // Check for crash recovery
      const stats = await this.indexManager.getStats();
      if (stats.needsRecovery) {
        console.log("[Notient] Detected interrupted indexing session");
        this.kernel.obsidian.notice(
          "Previous indexing was interrupted. Starting fresh sync...",
          5000
        );
        // Clear the in-progress flag and restart
        this.indexManager.endIndexing();
      }

      await this.indexer.syncVault();
    } catch (error) {
      console.error("[Notient] Background indexing failed:", error);
    }
  }
}
