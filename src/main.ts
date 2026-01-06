/**
 * Notient - AI-powered vault management for Obsidian
 *
 * Main plugin entry point.
 * SAFETY: Plugin must always load. Services initialize lazily after setup.
 */

import { Plugin } from "obsidian";
import { Kernel, KernelContext } from "./core/kernel";
import { JobQueue } from "./core/queue/jobQueue";
import { HealthMonitor } from "./services/healthMonitor";
import { OllamaService } from "./services/ollama";
import { OramaStore } from "./services/orama";
import { IndexPipeline } from "./core/indexer/pipeline";
import { SearchPipeline } from "./core/search/pipeline";
import { VaultVitals } from "./core/vitals/vitals";
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
  private vectorStore: OramaStore | null = null;
  private jobQueue: JobQueue | null = null;
  private indexPipeline: IndexPipeline | null = null;
  private searchPipeline: SearchPipeline | null = null;
  private vaultVitals: VaultVitals | null = null;

  private servicesInitialized = false;

  async onload(): Promise<void> {
    console.log("[Notient] Loading plugin - step 1: start");

    try {
      // Load settings first - this is always safe
      console.log("[Notient] Loading plugin - step 2: loading settings");
      this.settings = await loadSettings(this);
      console.log("[Notient] Loading plugin - step 3: settings loaded, setupComplete =", this.settings.setupComplete);

      // Create kernel (lightweight, just creates event bus and paths)
      console.log("[Notient] Loading plugin - step 4: creating kernel");
      const context: KernelContext = {
        app: this.app,
        plugin: this,
        settings: this.settings,
      };
      this.kernel = new Kernel(context);
      console.log("[Notient] Loading plugin - step 5: kernel created");

      // Initialize kernel (creates directories, tries lock)
      console.log("[Notient] Loading plugin - step 6: initializing kernel");
      await this.kernel.initialize();
      console.log("[Notient] Loading plugin - step 7: kernel initialized");

      // Register views - safe, just registers factories
      console.log("[Notient] Loading plugin - step 8: registering views");
      this.registerViews();
      console.log("[Notient] Loading plugin - step 9: views registered");

      // Register commands
      console.log("[Notient] Loading plugin - step 10: registering commands");
      this.registerCommands();
      console.log("[Notient] Loading plugin - step 11: commands registered");

      // Add settings tab
      console.log("[Notient] Loading plugin - step 12: adding settings tab");
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
      console.log("[Notient] Loading plugin - step 13: settings tab added");

      // Add ribbon icon
      console.log("[Notient] Loading plugin - step 14: adding ribbon icon");
      this.addRibbonIcon("sparkles", "Notient", () => {
        this.activateSidebar();
      });
      console.log("[Notient] Loading plugin - step 15: ribbon added");

      // Check if setup needed
      if (!this.settings.setupComplete) {
        console.log("[Notient] Loading plugin - step 16: scheduling setup wizard");
        // Show wizard after a short delay to let UI settle
        setTimeout(() => this.showSetupWizard(), 500);
      } else {
        console.log("[Notient] Loading plugin - step 16: scheduling service init");
        // Initialize services in background (non-blocking)
        setTimeout(() => this.initializeServicesAsync(), 1000);
      }

      console.log("[Notient] Plugin loaded successfully - all steps complete");
    } catch (error) {
      console.error("[Notient] Failed to load plugin:", error);
      // Don't throw - plugin should always load
    }
  }

  async onunload(): Promise<void> {
    console.log("[Notient] Unloading plugin...");

    try {
      // Dispose services in reverse order
      this.vaultVitals?.dispose();
      this.searchPipeline?.dispose();
      this.indexPipeline?.dispose();
      if (this.vectorStore) {
        await this.vectorStore.dispose();
      }
      this.ollamaService?.dispose();
      this.healthMonitor?.dispose();
      this.jobQueue?.dispose();

      // Dispose kernel last
      this.kernel?.dispose();
    } catch (error) {
      console.error("[Notient] Error during unload:", error);
    }

    console.log("[Notient] Plugin unloaded");
  }

  /**
   * Initialize services asynchronously with proper error handling
   * REQUIRES: Both Ollama AND LM Studio must be configured
   */
  private async initializeServicesAsync(): Promise<void> {
    if (this.servicesInitialized) return;

    console.log("[Notient] Initializing services...");

    try {
      const eventBus = this.kernel.eventBus;
      const storagePaths = this.kernel.storagePaths;

      // Job queue - safe, just file operations
      this.jobQueue = new JobQueue(storagePaths, eventBus);
      await this.jobQueue.initialize();
      this.kernel.registerService("jobQueue", this.jobQueue);

      // Health monitor - makes network requests but handles errors
      this.healthMonitor = new HealthMonitor(this.kernel);
      await this.healthMonitor.initialize();
      this.kernel.registerService("healthMonitor", this.healthMonitor);

      // BOTH Ollama AND LM Studio are MANDATORY
      const hasEmbeddingModel = Boolean(this.settings.ollama.embeddingModel);
      const hasReasoningModel = Boolean(this.settings.lmstudio.reasoningModel);
      const ollamaEnabled = this.settings.ollama.enabled;
      const lmstudioEnabled = this.settings.lmstudio.enabled;

      // Validate all required configuration
      if (!hasEmbeddingModel || !hasReasoningModel || !ollamaEnabled || !lmstudioEnabled) {
        console.error("[Notient] MISSING REQUIRED CONFIGURATION:", {
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
        ollamaUrl: this.settings.ollama.host,
        lmstudioUrl: this.settings.lmstudio.host,
      });

      // All required - proceed with initialization
      if (true) {
        // Ollama service
        this.ollamaService = new OllamaService(this.kernel);
        try {
          await this.ollamaService.initialize();
          this.kernel.registerService("ollama", this.ollamaService);

          // Vector store (depends on Ollama for model key)
          this.vectorStore = new OramaStore(this.kernel);
          await this.vectorStore.initialize();
          this.kernel.registerService("vectorStore", this.vectorStore);

          // Index pipeline
          this.indexPipeline = new IndexPipeline(
            this.kernel,
            eventBus,
            this.jobQueue,
            this.ollamaService,
            this.vectorStore
          );
          await this.indexPipeline.initialize();
          this.kernel.registerService("indexer", this.indexPipeline);

          // Search pipeline
          this.searchPipeline = new SearchPipeline(
            this.kernel,
            eventBus,
            this.ollamaService,
            this.vectorStore
          );
          await this.searchPipeline.initialize();
          this.kernel.registerService("search", this.searchPipeline);

          // Vault vitals
          this.vaultVitals = new VaultVitals(
            this.kernel,
            eventBus,
            this.vectorStore,
            this.indexPipeline.getStateStore(),
            this.jobQueue
          );

          this.servicesInitialized = true;
          console.log("[Notient] Services initialized successfully");

          // Start background indexing after another delay
          setTimeout(() => this.startBackgroundIndexing(), 2000);
        } catch (error) {
          console.error("[Notient] Failed to initialize AI services:", error);
          this.kernel.obsidian.notice(
            "Failed to connect to AI services. Check that Ollama and LM Studio are running."
          );
        }
      }
    } catch (error) {
      console.error("[Notient] Service initialization failed:", error);
    }
  }

  private registerViews(): void {
    // Sidebar view
    this.registerView(VIEW_TYPE_SIDEBAR, (leaf) => {
      return new NotientSidebarView(leaf, this.kernel, this.searchPipeline);
    });

    // Dashboard view
    this.registerView(VIEW_TYPE_DASHBOARD, (leaf) => {
      return new NotientDashboardView(leaf, this.kernel, this.vaultVitals);
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

    // Reindex vault
    this.addCommand({
      id: "reindex-vault",
      name: "Reindex entire vault",
      callback: async () => {
        if (!this.indexPipeline || !this.kernel.capabilities.indexing) {
          this.kernel.obsidian.notice(
            "Cannot index - check service connections"
          );
          return;
        }
        this.kernel.obsidian.notice("Starting vault reindex...");
        await this.indexPipeline.startFullIndex();
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
    // Need health monitor for wizard, initialize it first if needed
    if (!this.healthMonitor) {
      this.healthMonitor = new HealthMonitor(this.kernel);
      // Don't await initialize - let wizard handle connection testing
    }

    const wizard = new SetupWizardModal(
      this.app,
      this.healthMonitor,
      this.settings
    );

    const result = await wizard.run();

    if (result.completed) {
      // Apply settings
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

      // Initialize services now that we have config
      this.kernel.obsidian.notice("Notient configured! Initializing...");

      // Reinitialize everything with new settings
      await this.reinitializeServices();
    }
  }

  private async reinitializeServices(): Promise<void> {
    try {
      // Dispose old services
      this.searchPipeline?.dispose();
      this.indexPipeline?.dispose();
      if (this.vectorStore) {
        await this.vectorStore.dispose();
      }
      this.ollamaService?.dispose();

      this.searchPipeline = null;
      this.indexPipeline = null;
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
    if (!this.indexPipeline) {
      console.log("[Notient] Cannot start indexing - pipeline not initialized");
      return;
    }

    if (!this.kernel.capabilities.indexing) {
      console.log("[Notient] Cannot start indexing - missing capabilities");
      return;
    }

    try {
      await this.indexPipeline.startFullIndex();
    } catch (error) {
      console.error("[Notient] Background indexing failed:", error);
    }
  }
}
