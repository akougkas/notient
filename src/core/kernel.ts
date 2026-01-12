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
  healthMonitor: HealthMonitor;
  ollama: OllamaService;
  ollamaReranker: OllamaRerankerService;
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
  private healthMonitor: HealthMonitor | null = null;
  private ollamaService: OllamaService | null = null;
  private ollamaReranker: OllamaRerankerService | null = null;
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
    console.log("[kernel:constructor] TRACE: START");
    this._eventBus = new EventBus();
    console.log("[kernel:constructor] TRACE: EventBus created");
    setGlobalEventBus(this._eventBus);
    console.log("[kernel:constructor] TRACE: Global event bus set");

    this._obsidian = new ObsidianFacade(context.app);
    console.log("[kernel:constructor] TRACE: ObsidianFacade created");
    this._storagePaths = new StoragePaths(context.app);
    console.log("[kernel:constructor] TRACE: StoragePaths created");
    this._vaultLock = new VaultLock(this._storagePaths, (reason, error) => {
      console.log(`[kernel:vaultLock:callback] TRACE: Lock lost reason=${reason}`);
      this._eventBus.emit("lock:lost", { reason, error });
    });
    console.log("[kernel:constructor] TRACE: VaultLock created");
    this._abortController = new AbortController();
    console.log("[kernel:constructor] TRACE: AbortController created");
    console.log("[kernel:constructor] TRACE: END");
  }

  // ============ Getters ============

  get eventBus(): EventBus {
    console.log("[kernel:get:eventBus] TRACE: Accessing eventBus");
    return this._eventBus;
  }

  get storagePaths(): StoragePaths {
    console.log("[kernel:get:storagePaths] TRACE: Accessing storagePaths");
    return this._storagePaths;
  }

  get vaultLock(): VaultLock {
    console.log("[kernel:get:vaultLock] TRACE: Accessing vaultLock");
    return this._vaultLock;
  }

  get obsidian(): ObsidianFacade {
    console.log("[kernel:get:obsidian] TRACE: Accessing obsidian");
    return this._obsidian;
  }

  get abortSignal(): AbortSignal {
    console.log("[kernel:get:abortSignal] TRACE: Accessing abortSignal");
    return this._abortController.signal;
  }

  get settings(): NotientSettings {
    console.log("[kernel:get:settings] TRACE: Accessing settings");
    return this.context.settings;
  }

  /** Update settings reference (used after settings change) */
  updateSettings(settings: NotientSettings): void {
    console.log("[kernel:updateSettings] TRACE: START");
    this.context.settings = settings;
    console.log("[kernel:updateSettings] TRACE: END");
  }

  /** Save current settings to disk */
  async saveSettings(): Promise<void> {
    console.log("[kernel:saveSettings] TRACE: START");
    const { saveSettings } = await import("../ui/settings");
    console.log("[kernel:saveSettings] TRACE: Imported saveSettings, calling...");
    await saveSettings(this.context.plugin, this.context.settings);
    console.log("[kernel:saveSettings] TRACE: END");
  }

  get capabilities(): Readonly<CapabilityStatus> {
    console.log("[kernel:get:capabilities] TRACE: Accessing capabilities");
    return { ...this._capabilities };
  }

  get serviceHealth(): Readonly<ServiceState> {
    console.log("[kernel:get:serviceHealth] TRACE: Accessing serviceHealth");
    return { ...this._serviceHealth };
  }

  get isInitialized(): boolean {
    console.log(`[kernel:get:isInitialized] TRACE: value=${this._initialized}`);
    return this._initialized;
  }

  get hasWriteLock(): boolean {
    console.log("[kernel:get:hasWriteLock] TRACE: START");
    const held = this._vaultLock.isHeld();
    console.log(`[kernel:get:hasWriteLock] TRACE: END value=${held}`);
    return held;
  }

  get isServicesInitializing(): boolean {
    console.log(`[kernel:get:isServicesInitializing] TRACE: value=${this._servicesInitializing}`);
    return this._servicesInitializing;
  }

  get isServicesInitialized(): boolean {
    console.log(`[kernel:get:isServicesInitialized] TRACE: value=${this._servicesInitialized}`);
    return this._servicesInitialized;
  }

  /** Mark services as initializing (called by main.ts) */
  setServicesInitializing(value: boolean): void {
    console.log(`[kernel:setServicesInitializing] TRACE: START value=${value}`);
    this._servicesInitializing = value;
    console.log("[kernel:setServicesInitializing] TRACE: END");
  }

  /** Mark services as initialized and emit event (called by main.ts) */
  setServicesInitialized(): void {
    console.log("[kernel:setServicesInitialized] TRACE: START");
    this._servicesInitializing = false;
    this._servicesInitialized = true;
    console.log("[kernel:setServicesInitialized] TRACE: Emitting services:initialized event");
    this._eventBus.emit("services:initialized", {});
    console.log("[kernel:setServicesInitialized] TRACE: END");
  }

  // ============ Lifecycle ============

  /**
   * Initialize kernel
   */
  async initialize(): Promise<void> {
    console.log("[kernel:initialize] TRACE: START");
    if (this._initialized || this._disposed) {
      console.log("[kernel:initialize] TRACE: END (already initialized or disposed)");
      return;
    }

    console.log("[Kernel] Starting initialization...");

    try {
      // 1. Ensure storage directories (with timeout protection)
      console.log("[kernel:initialize] TRACE: Step 1 - Ensuring directories...");
      try {
        await Promise.race([
          this._storagePaths.ensureDirectories(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Directory creation timeout")), 5000),
          ),
        ]);
        console.log("[kernel:initialize] TRACE: Step 1 - Directories ready");
      } catch (dirError) {
        console.warn(
          "[kernel:initialize] TRACE: Directory creation failed, continuing anyway:",
          dirError,
        );
      }

      // 2. Try to acquire write lock (with timeout - allows for 3 retries with backoff)
      console.log("[kernel:initialize] TRACE: Step 2 - Acquiring lock...");
      try {
        const hasLock = await Promise.race([
          this._vaultLock.tryAcquire(),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
        ]);
        if (!hasLock) {
          console.warn(
            "[kernel:initialize] TRACE: Could not acquire write lock - running in read-only mode",
          );
        }
        console.log(`[kernel:initialize] TRACE: Step 2 - Lock status=${hasLock}`);
      } catch (lockError) {
        console.warn("[kernel:initialize] TRACE: Lock acquisition failed:", lockError);
      }

      this._initialized = true;
      console.log("[kernel:initialize] TRACE: END (initialization complete)");
    } catch (error) {
      console.error("[kernel:initialize] TRACE: Initialization failed:", error);
      // Don't throw - let plugin continue
      this._initialized = true; // Mark as initialized anyway
      console.log("[kernel:initialize] TRACE: END (marked initialized despite error)");
    }
  }

  /**
   * Update external service health status
   */
  updateServiceHealth(service: keyof ServiceState, health: ServiceHealth): void {
    console.log(
      `[kernel:updateServiceHealth] TRACE: START service=${service} status=${health.status}`,
    );
    this._serviceHealth[service] = health;
    console.log("[kernel:updateServiceHealth] TRACE: Calling updateCapabilities");
    this.updateCapabilities();

    console.log("[kernel:updateServiceHealth] TRACE: Emitting health:changed event");
    this._eventBus.emit("health:changed", { service, health });
    console.log("[kernel:updateServiceHealth] TRACE: END");
  }

  /**
   * Recalculate capabilities based on service health
   */
  private updateCapabilities(): void {
    console.log("[kernel:updateCapabilities] TRACE: START");
    const hasOllama = this._serviceHealth.ollama.status === "healthy";
    const hasLMStudio = this._serviceHealth.lmstudio.status === "healthy";
    const hasLock = this._vaultLock.isHeld();

    console.log(
      `[kernel:updateCapabilities] TRACE: hasOllama=${hasOllama} hasLMStudio=${hasLMStudio} hasLock=${hasLock}`,
    );

    this._capabilities = {
      embedding: hasOllama,
      reasoning: hasLMStudio,
      vectorStore: true, // HNSWVectorStore is always available (WASM)
      indexing: hasOllama && hasLock,
      search: hasOllama,
    };
    console.log(
      `[kernel:updateCapabilities] TRACE: END capabilities=${JSON.stringify(this._capabilities)}`,
    );
  }

  /**
   * Register a service with the kernel
   * @param name - The service name (must be a valid ServiceName)
   * @param service - The service instance
   */
  registerService<K extends ServiceName>(name: K, service: ServiceRegistry[K]): void {
    console.log(`[kernel:registerService] TRACE: START name=${name}`);
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
    console.log(`[kernel:registerService] TRACE: END registered=${name}`);
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
    console.log(`[kernel:getService] TRACE: START name=${name}`);
    let result: unknown = null;
    switch (name) {
      case "healthMonitor":
        result = this.healthMonitor;
        break;
      case "ollama":
        result = this.ollamaService;
        break;
      case "ollamaReranker":
        result = this.ollamaReranker;
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
    console.log(`[kernel:getService] TRACE: END name=${name} found=${result !== null}`);
    return result;
  }

  /**
   * Dispose of all services and cleanup
   */
  dispose(): void {
    console.log("[kernel:dispose] TRACE: START");
    if (this._disposed) {
      console.log("[kernel:dispose] TRACE: END (already disposed)");
      return;
    }

    console.log("[Kernel] Disposing...");
    this._disposed = true;

    // Abort any pending operations
    console.log("[kernel:dispose] TRACE: Aborting pending operations");
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
      this.progressiveSearch,
      this.searchPipeline,
      this.indexer,
      this.indexManager,
      this.vectorStore,
      this.ollamaReranker,
      this.ollamaService,
      this.healthMonitor,
    ];

    console.log(`[kernel:dispose] TRACE: Disposing ${disposables.length} services`);
    for (let i = 0; i < disposables.length; i++) {
      const service = disposables[i];
      if (service && typeof (service as { dispose?: () => void }).dispose === "function") {
        try {
          console.log(`[kernel:dispose] TRACE: Disposing service ${i}`);
          (service as { dispose: () => void }).dispose();
          console.log(`[kernel:dispose] TRACE: Service ${i} disposed`);
        } catch (error) {
          console.error(`[kernel:dispose] TRACE: Error disposing service ${i}:`, error);
        }
      }
    }

    // Release lock
    console.log("[kernel:dispose] TRACE: Disposing vaultLock");
    this._vaultLock.dispose();

    // Dispose event bus last
    console.log("[kernel:dispose] TRACE: Disposing eventBus");
    this._eventBus.dispose();

    console.log("[kernel:dispose] TRACE: END");
    console.log("[Kernel] Disposed");
  }
}
