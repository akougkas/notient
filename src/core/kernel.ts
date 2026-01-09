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
import { StoragePaths } from "../services/storagePaths";
import { VaultLock } from "../services/vaultLock";
import type { CapabilityStatus, ServiceHealth } from "../types/services";
import type { NotientSettings } from "../types/settings";
import { EventBus, setGlobalEventBus } from "./events/eventBus";

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
  private healthMonitor: unknown = null;
  private ollamaService: unknown = null;
  private lmStudioService: unknown = null;
  private vectorStore: unknown = null;
  private indexManager: unknown = null;
  private indexer: unknown = null;
  private searchPipeline: unknown = null;
  private contextBuilder: unknown = null;
  private vaultVitals: unknown = null;
  private agentTaskQueue: unknown = null;
  // Phase 3 services (Intelligence)
  private intelligence: unknown = null;
  // New architecture services (Phase 1.8)
  private llmProvider: unknown = null;
  private notientAgent: unknown = null;

  // Phase 2 services (Agentic)
  private conversationStore: unknown = null;
  private actionHistory: unknown = null;
  private workflowRunner: unknown = null;
  private trustLevelManager: unknown = null;
  private actionApplier: unknown = null;
  // Intelligence 2.0
  private actionOrchestrator: unknown = null;

  constructor(private context: KernelContext) {
    this._eventBus = new EventBus();
    setGlobalEventBus(this._eventBus);

    this._obsidian = new ObsidianFacade(context.app);
    this._storagePaths = new StoragePaths(context.app);
    this._vaultLock = new VaultLock(this._storagePaths);
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
    const { saveSettings } = await import("../settings");
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
   */
  registerService(name: string, service: unknown): void {
    switch (name) {
      case "healthMonitor":
        this.healthMonitor = service;
        break;
      case "ollama":
        this.ollamaService = service;
        break;
      case "lmstudio":
        this.lmStudioService = service;
        break;
      case "vectorStore":
        this.vectorStore = service;
        break;
      case "indexManager":
        this.indexManager = service;
        break;
      case "indexer":
        this.indexer = service;
        break;
      case "search":
        this.searchPipeline = service;
        break;
      case "context":
        this.contextBuilder = service;
        break;
      case "vitals":
        this.vaultVitals = service;
        break;
      case "intelligence":
        this.intelligence = service;
        break;
      case "taskQueue":
        this.agentTaskQueue = service;
        break;
      case "llmProvider":
        this.llmProvider = service;
        break;
      case "agent":
        this.notientAgent = service;
        break;
      // Phase 2 services
      case "conversationStore":
        this.conversationStore = service;
        break;
      case "actionHistory":
        this.actionHistory = service;
        break;
      case "workflowRunner":
        this.workflowRunner = service;
        break;
      case "trustLevelManager":
        this.trustLevelManager = service;
        break;
      case "actionApplier":
        this.actionApplier = service;
        break;
      case "actionOrchestrator":
        this.actionOrchestrator = service;
        break;
    }
  }

  /**
   * Get a registered service
   */
  getService<T>(name: string): T | null {
    switch (name) {
      case "healthMonitor":
        return this.healthMonitor as T;
      case "ollama":
        return this.ollamaService as T;
      case "lmstudio":
        return this.lmStudioService as T;
      case "vectorStore":
        return this.vectorStore as T;
      case "indexManager":
        return this.indexManager as T;
      case "indexer":
        return this.indexer as T;
      case "search":
        return this.searchPipeline as T;
      case "context":
        return this.contextBuilder as T;
      case "vitals":
        return this.vaultVitals as T;
      case "intelligence":
        return this.intelligence as T;
      case "taskQueue":
        return this.agentTaskQueue as T;
      case "llmProvider":
        return this.llmProvider as T;
      case "agent":
        return this.notientAgent as T;
      // Phase 2 services
      case "conversationStore":
        return this.conversationStore as T;
      case "actionHistory":
        return this.actionHistory as T;
      case "workflowRunner":
        return this.workflowRunner as T;
      case "trustLevelManager":
        return this.trustLevelManager as T;
      case "actionApplier":
        return this.actionApplier as T;
      case "actionOrchestrator":
        return this.actionOrchestrator as T;
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
