/**
 * Kernel / Service Manager
 *
 * Central orchestrator for Notient services. Manages:
 * - Service initialization order
 * - Shared cancellation/abort
 * - Capability registry
 * - Lifecycle management
 */

import type { App, Plugin } from "obsidian";
import { ObsidianFacade } from "../adapters/obsidianFacade";
import type { HealthMonitor } from "../services/healthMonitor";
import type { IndexManager } from "../services/indexManager";
import type { LMStudioService } from "../services/lmstudio";
import type { OllamaService } from "../services/ollama";
import type { OllamaRerankerService } from "../services/ollamaReranker";
import { StoragePaths } from "../services/storagePaths";
import { VaultLock } from "../services/vaultLock";
import type { VectorStore } from "../services/vectorStore";
import type { CapabilityStatus, ServiceHealth } from "../types/services";
import type { NotientSettings } from "../types/settings";
import type { ProfileManager } from "./agent/profileManager";
import type { AgentTaskQueue } from "./agent/taskQueue";
import type { ActionApplier } from "./agentic/actionApplier";
import type { ActionHistory } from "./agentic/actionHistory";
import type { TrustLevelManager } from "./agentic/trustLevelManager";
import type { WorkflowRunner } from "./agentic/workflowRunner";
import type { ConversationStore } from "./chat/conversationStore";
import type { VaultContextBuilder } from "./context/vaultContextBuilder";
import { EventBus, setGlobalEventBus } from "./events/eventBus";
import type { SimpleIndexer } from "./indexer/simpleIndexer";
import type { ActionOrchestrator } from "./intelligence/actionOrchestrator";
import type { NoteIntelligenceService } from "./intelligence/noteIntelligence";
import type { LLMProvider } from "./llm/provider";
import type { SearchPipeline } from "./search/pipeline";
import type { SimpleVaultVitals } from "./vitals/simpleVitals";

// NotientAgent is now ChiefOfStaff (re-exported from agent/index.ts)
import type { NotientAgent } from "./agent";
import type { UserEvolutionService } from "./evolution/userEvolutionService";
import type { MigrationService } from "./importer/migrationService";

export interface KernelContext {
  app: App;
  plugin: Plugin;
  settings: NotientSettings;
}

/** External services we monitor */
interface ServiceState {
  ollama: ServiceHealth;
  lmstudio: ServiceHealth;
}

/**
 * Service registry type map - maps service names to their types.
 * Used by getService() for type-safe service retrieval.
 */
export interface ServiceRegistry {
  healthMonitor: HealthMonitor;
  ollama: OllamaService;
  ollamaReranker: OllamaRerankerService;
  lmstudio: LMStudioService;
  vectorStore: VectorStore;
  indexManager: IndexManager;
  indexer: SimpleIndexer;
  search: SearchPipeline;
  context: VaultContextBuilder;
  vitals: SimpleVaultVitals;
  intelligence: NoteIntelligenceService;
  taskQueue: AgentTaskQueue;
  llmProvider: LLMProvider;
  agent: NotientAgent;
  conversationStore: ConversationStore;
  actionHistory: ActionHistory;
  workflowRunner: WorkflowRunner;
  trustLevelManager: TrustLevelManager;
  actionApplier: ActionApplier;
  actionOrchestrator: ActionOrchestrator;
  profileManager: ProfileManager;
  userEvolution: UserEvolutionService;
  migrationService: MigrationService;
}

/** Valid service names */
export type ServiceName = keyof ServiceRegistry;

/**
 * Main kernel class managing all services
 */
export class Kernel {
  private _eventBus: EventBus;
  private _storagePaths: StoragePaths;
  private _vaultLock: VaultLock;
  private _obsidian: ObsidianFacade;
  private _abortController: AbortController;
  private _initialized = false;
  private _disposed = false;
  private _servicesInitializing = false;
  private _servicesInitialized = false;

  private _serviceHealth: ServiceState = {
    ollama: { status: "unknown", lastChecked: null, error: null },
    lmstudio: { status: "unknown", lastChecked: null, error: null },
  };

  private _capabilities: CapabilityStatus = {
    embedding: false,
    reasoning: false,
    vectorStore: true, // SimpleVectorStore is pure JS, always available
    indexing: false,
    search: false,
  };

  // Service references (set during initialization)
  private healthMonitor: HealthMonitor | null = null;
  private ollamaService: OllamaService | null = null;
  private ollamaReranker: OllamaRerankerService | null = null;
  private lmStudioService: LMStudioService | null = null;
  private vectorStore: VectorStore | null = null;
  private indexManager: IndexManager | null = null;
  private indexer: SimpleIndexer | null = null;
  private searchPipeline: SearchPipeline | null = null;
  private contextBuilder: VaultContextBuilder | null = null;
  private vaultVitals: SimpleVaultVitals | null = null;
  private agentTaskQueue: AgentTaskQueue | null = null;
  // Phase 3 services (Intelligence)
  private intelligence: NoteIntelligenceService | null = null;
  // New architecture services (Phase 1.8)
  private llmProvider: LLMProvider | null = null;
  private notientAgent: NotientAgent | null = null;

  // Phase 2 services (Agentic)
  private conversationStore: ConversationStore | null = null;
  private actionHistory: ActionHistory | null = null;
  private workflowRunner: WorkflowRunner | null = null;
  private trustLevelManager: TrustLevelManager | null = null;
  private actionApplier: ActionApplier | null = null;
  // Intelligence 2.0
  private actionOrchestrator: ActionOrchestrator | null = null;
  // Identity system
  private profileManager: ProfileManager | null = null;
  // Evolution system
  private userEvolution: UserEvolutionService | null = null;

  constructor(private context: KernelContext) {
    this._eventBus = new EventBus();
    setGlobalEventBus(this._eventBus);

    this._obsidian = new ObsidianFacade(context.app);
    this._storagePaths = new StoragePaths(context.app);
    this._vaultLock = new VaultLock(this._storagePaths, (reason, error) => {
      this._eventBus.emit("lock:lost", { reason, error });
    });
    this._abortController = new AbortController();
  }

  // ============ Getters ============

  get eventBus(): EventBus {
    return this._eventBus;
  }

  get storagePaths(): StoragePaths {
    return this._storagePaths;
  }

  get vaultLock(): VaultLock {
    return this._vaultLock;
  }

  get obsidian(): ObsidianFacade {
    return this._obsidian;
  }

  get abortSignal(): AbortSignal {
    return this._abortController.signal;
  }

  get settings(): NotientSettings {
    return this.context.settings;
  }

  /** Update settings reference (used after settings change) */
  updateSettings(settings: NotientSettings): void {
    this.context.settings = settings;
  }

  /** Save current settings to disk */
  async saveSettings(): Promise<void> {
    const { saveSettings } = await import("../ui/settings");
    await saveSettings(this.context.plugin, this.context.settings);
  }

  get capabilities(): Readonly<CapabilityStatus> {
    return { ...this._capabilities };
  }

  get serviceHealth(): Readonly<ServiceState> {
    return { ...this._serviceHealth };
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  get hasWriteLock(): boolean {
    return this._vaultLock.isHeld();
  }

  get isServicesInitializing(): boolean {
    return this._servicesInitializing;
  }

  get isServicesInitialized(): boolean {
    return this._servicesInitialized;
  }

  /** Mark services as initializing (called by main.ts) */
  setServicesInitializing(value: boolean): void {
    this._servicesInitializing = value;
  }

  /** Mark services as initialized and emit event (called by main.ts) */
  setServicesInitialized(): void {
    this._servicesInitializing = false;
    this._servicesInitialized = true;
    this._eventBus.emit("services:initialized", {});
  }

  // ============ Lifecycle ============

  /**
   * Initialize kernel
   */
  async initialize(): Promise<void> {
    if (this._initialized || this._disposed) {
      return;
    }

    console.log("[Kernel] Starting initialization...");

    try {
      // 1. Ensure storage directories (with timeout protection)
      console.log("[Kernel] Step 1: Ensuring directories...");
      try {
        await Promise.race([
          this._storagePaths.ensureDirectories(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Directory creation timeout")), 5000),
          ),
        ]);
        console.log("[Kernel] Step 1: Directories ready");
      } catch (dirError) {
        console.warn("[Kernel] Directory creation failed, continuing anyway:", dirError);
      }

      // 2. Try to acquire write lock (with timeout - allows for 3 retries with backoff)
      console.log("[Kernel] Step 2: Acquiring lock...");
      try {
        const hasLock = await Promise.race([
          this._vaultLock.tryAcquire(),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
        ]);
        if (!hasLock) {
          console.warn("[Kernel] Could not acquire write lock - running in read-only mode");
        }
        console.log("[Kernel] Step 2: Lock status =", hasLock);
      } catch (lockError) {
        console.warn("[Kernel] Lock acquisition failed:", lockError);
      }

      this._initialized = true;
      console.log("[Kernel] Initialization complete");
    } catch (error) {
      console.error("[Kernel] Initialization failed:", error);
      // Don't throw - let plugin continue
      this._initialized = true; // Mark as initialized anyway
    }
  }

  /**
   * Update external service health status
   */
  updateServiceHealth(service: keyof ServiceState, health: ServiceHealth): void {
    this._serviceHealth[service] = health;
    this.updateCapabilities();

    this._eventBus.emit("health:changed", { service, health });
  }

  /**
   * Recalculate capabilities based on service health
   */
  private updateCapabilities(): void {
    const hasOllama = this._serviceHealth.ollama.status === "healthy";
    const hasLMStudio = this._serviceHealth.lmstudio.status === "healthy";
    const hasLock = this._vaultLock.isHeld();

    this._capabilities = {
      embedding: hasOllama,
      reasoning: hasLMStudio,
      vectorStore: true, // SimpleVectorStore is always available (pure JS)
      indexing: hasOllama && hasLock,
      search: hasOllama,
    };
  }

  /**
   * Register a service with the kernel
   * @param name - The service name (must be a valid ServiceName)
   * @param service - The service instance
   */
  registerService<K extends ServiceName>(name: K, service: ServiceRegistry[K]): void {
    switch (name) {
      case "healthMonitor":
        this.healthMonitor = service as HealthMonitor;
        break;
      case "ollama":
        this.ollamaService = service as OllamaService;
        break;
      case "ollamaReranker":
        this.ollamaReranker = service as OllamaRerankerService;
        break;
      case "lmstudio":
        this.lmStudioService = service as LMStudioService;
        break;
      case "vectorStore":
        this.vectorStore = service as VectorStore;
        break;
      case "indexManager":
        this.indexManager = service as IndexManager;
        break;
      case "indexer":
        this.indexer = service as SimpleIndexer;
        break;
      case "search":
        this.searchPipeline = service as SearchPipeline;
        break;
      case "context":
        this.contextBuilder = service as VaultContextBuilder;
        break;
      case "vitals":
        this.vaultVitals = service as SimpleVaultVitals;
        break;
      case "intelligence":
        this.intelligence = service as NoteIntelligenceService;
        break;
      case "taskQueue":
        this.agentTaskQueue = service as AgentTaskQueue;
        break;
      case "llmProvider":
        this.llmProvider = service as LLMProvider;
        break;
      case "agent":
        this.notientAgent = service as NotientAgent;
        break;
      // Phase 2 services
      case "conversationStore":
        this.conversationStore = service as ConversationStore;
        break;
      case "actionHistory":
        this.actionHistory = service as ActionHistory;
        break;
      case "workflowRunner":
        this.workflowRunner = service as WorkflowRunner;
        break;
      case "trustLevelManager":
        this.trustLevelManager = service as TrustLevelManager;
        break;
      case "actionApplier":
        this.actionApplier = service as ActionApplier;
        break;
      case "actionOrchestrator":
        this.actionOrchestrator = service as ActionOrchestrator;
        break;
      case "profileManager":
        this.profileManager = service as ProfileManager;
        break;
      case "userEvolution":
        this.userEvolution = service as UserEvolutionService;
        break;
    }
  }

  /**
   * Get a registered service with type safety.
   *
   * Preferred usage (type-safe):
   *   const search = kernel.getService("search"); // Returns SearchPipeline | null
   *
   * Legacy usage (backward compatible):
   *   const search = kernel.getService<SearchPipeline>("search"); // Returns SearchPipeline | null
   *
   * @param name - The service name
   * @returns The service instance or null if not registered
   */
  getService<K extends ServiceName>(name: K): ServiceRegistry[K] | null;
  getService<T>(name: string): T | null;
  getService<K extends ServiceName | string>(name: K): unknown {
    switch (name) {
      case "healthMonitor":
        return this.healthMonitor;
      case "ollama":
        return this.ollamaService;
      case "ollamaReranker":
        return this.ollamaReranker;
      case "lmstudio":
        return this.lmStudioService;
      case "vectorStore":
        return this.vectorStore;
      case "indexManager":
        return this.indexManager;
      case "indexer":
        return this.indexer;
      case "search":
        return this.searchPipeline;
      case "context":
        return this.contextBuilder;
      case "vitals":
        return this.vaultVitals;
      case "intelligence":
        return this.intelligence;
      case "taskQueue":
        return this.agentTaskQueue;
      case "llmProvider":
        return this.llmProvider;
      case "agent":
        return this.notientAgent;
      // Phase 2 services
      case "conversationStore":
        return this.conversationStore;
      case "actionHistory":
        return this.actionHistory;
      case "workflowRunner":
        return this.workflowRunner;
      case "trustLevelManager":
        return this.trustLevelManager;
      case "actionApplier":
        return this.actionApplier;
      case "actionOrchestrator":
        return this.actionOrchestrator;
      case "profileManager":
        return this.profileManager;
      case "userEvolution":
        return this.userEvolution;
      default:
        return null;
    }
  }

  /**
   * Dispose of all services and cleanup
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }

    console.log("[Kernel] Disposing...");
    this._disposed = true;

    // Abort any pending operations
    this._abortController.abort();

    // Dispose services in reverse order
    const disposables = [
      // Phase 2 services first
      this.workflowRunner,
      this.actionApplier,
      this.actionHistory,
      this.conversationStore,
      this.trustLevelManager,
      // Phase 1 services
      this.vaultVitals,
      // Phase 3 services
      this.intelligence,
      this.contextBuilder,
      this.searchPipeline,
      this.indexer,
      this.indexManager,
      this.vectorStore,
      this.lmStudioService,
      this.ollamaReranker,
      this.ollamaService,
      this.healthMonitor,
    ];

    for (const service of disposables) {
      if (service && typeof (service as { dispose?: () => void }).dispose === "function") {
        try {
          (service as { dispose: () => void }).dispose();
        } catch (error) {
          console.error("[Kernel] Error disposing service:", error);
        }
      }
    }

    // Release lock
    this._vaultLock.dispose();

    // Dispose event bus last
    this._eventBus.dispose();

    console.log("[Kernel] Disposed");
  }
}
