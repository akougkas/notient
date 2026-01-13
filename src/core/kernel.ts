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
import type { DatabaseService } from "./db/database";
import type { HealthMonitor } from "../services/healthMonitor";
import type { IndexManager } from "../services/indexManager";
import type { OllamaService } from "../services/ollama";
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
import type { ProgressiveSearchOrchestrator } from "./search/progressiveSearch";
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
  database: DatabaseService;
  healthMonitor: HealthMonitor;
  ollama: OllamaService;
  vectorStore: VectorStore;
  indexManager: IndexManager;
  indexer: SimpleIndexer;
  search: SearchPipeline;
  progressiveSearch: ProgressiveSearchOrchestrator;
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
    vectorStore: true, // HNSWVectorStore uses WASM, always available
    indexing: false,
    search: false,
  };

  // Service references (set during initialization)
  private database: DatabaseService | null = null;
  private healthMonitor: HealthMonitor | null = null;
  private ollamaService: OllamaService | null = null;
  private vectorStore: VectorStore | null = null;
  private indexManager: IndexManager | null = null;
  private indexer: SimpleIndexer | null = null;
  private searchPipeline: SearchPipeline | null = null;
  private progressiveSearch: ProgressiveSearchOrchestrator | null = null;
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
      try {
        await Promise.race([
          this._storagePaths.ensureDirectories(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Directory creation timeout")), 5000),
          ),
        ]);
      } catch (dirError) {
        console.warn("[kernel:initialize] Directory creation failed, continuing anyway:", dirError);
      }

      // 2. Try to acquire write lock (with timeout - allows for 3 retries with backoff)
      try {
        const hasLock = await Promise.race([
          this._vaultLock.tryAcquire(),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
        ]);
        if (!hasLock) {
          console.warn(
            "[kernel:initialize] Could not acquire write lock - running in read-only mode",
          );
        }
      } catch (lockError) {
        console.warn("[kernel:initialize] Lock acquisition failed:", lockError);
      }

      this._initialized = true;
    } catch (error) {
      console.error("[kernel:initialize] Initialization failed:", error);
      // Don't throw - let plugin continue
      this._initialized = true; // Mark as initialized anyway
    }
  }

  /**
   * Update external service health status
   */
  updateServiceHealth(service: keyof ServiceState, health: ServiceHealth): void {
    const previous = this._serviceHealth[service];
    const statusChanged = previous.status !== health.status;

    this._serviceHealth[service] = health;

    // Only emit and recalculate when status actually changes
    if (statusChanged) {
      this.updateCapabilities();
      this._eventBus.emit("health:changed", { service, health });
    }
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
      vectorStore: true, // HNSWVectorStore is always available (WASM)
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
      case "database":
        this.database = service as DatabaseService;
        break;
      case "healthMonitor":
        this.healthMonitor = service as HealthMonitor;
        break;
      case "ollama":
        this.ollamaService = service as OllamaService;
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
      case "progressiveSearch":
        this.progressiveSearch = service as ProgressiveSearchOrchestrator;
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
    let result: unknown = null;
    switch (name) {
      case "database":
        result = this.database;
        break;
      case "healthMonitor":
        result = this.healthMonitor;
        break;
      case "ollama":
        result = this.ollamaService;
        break;
      case "vectorStore":
        result = this.vectorStore;
        break;
      case "indexManager":
        result = this.indexManager;
        break;
      case "indexer":
        result = this.indexer;
        break;
      case "search":
        result = this.searchPipeline;
        break;
      case "progressiveSearch":
        result = this.progressiveSearch;
        break;
      case "context":
        result = this.contextBuilder;
        break;
      case "vitals":
        result = this.vaultVitals;
        break;
      case "intelligence":
        result = this.intelligence;
        break;
      case "taskQueue":
        result = this.agentTaskQueue;
        break;
      case "llmProvider":
        result = this.llmProvider;
        break;
      case "agent":
        result = this.notientAgent;
        break;
      // Phase 2 services
      case "conversationStore":
        result = this.conversationStore;
        break;
      case "actionHistory":
        result = this.actionHistory;
        break;
      case "workflowRunner":
        result = this.workflowRunner;
        break;
      case "trustLevelManager":
        result = this.trustLevelManager;
        break;
      case "actionApplier":
        result = this.actionApplier;
        break;
      case "actionOrchestrator":
        result = this.actionOrchestrator;
        break;
      case "profileManager":
        result = this.profileManager;
        break;
      case "userEvolution":
        result = this.userEvolution;
        break;
      default:
        result = null;
    }
    return result;
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
      this.database, // Add database here
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
      this.progressiveSearch,
      this.searchPipeline,
      this.indexer,
      this.indexManager,
      this.vectorStore,
      this.ollamaService,
      this.healthMonitor,
    ];

    for (let i = 0; i < disposables.length; i++) {
      const service = disposables[i];
      if (service && typeof (service as { dispose?: () => void }).dispose === "function") {
        try {
          (service as { dispose: () => void }).dispose();
        } catch (error) {
          console.error(`[kernel:dispose] Error disposing service ${i}:`, error);
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