import type { VaultAdapter } from "../adapters/vaultAdapter";
import type { ApprovalService } from "./approvals/approvalService";
import type { BackgroundRegistry } from "./awaken/backgroundRegistry";
import type { ApprovalGate } from "./chat/approvalGate";
import type { ChatService } from "./chat/chatService";
import type { ContextManager } from "./chat/contextManager";
import type { ConversationIndex } from "./chat/conversationIndex";
import type { ConversationStore } from "./chat/conversationStore";
import type { ToolModeCache } from "./chat/toolModeProbe";
import type { ToolRegistry } from "./chat/tools/registry";
import type { VaultConfig } from "./config/configFile";
import type { Coordinator } from "./coordinator/coordinator";
import type { ReasoningMutex } from "./coordinator/reasoningMutex";
import type { SurrealConnection } from "./db/surreal";
import type { TranscriptDistiller } from "./distill/transcriptDistiller";
import type { EventBus } from "./events/eventBus";
import type { HistoryService } from "./history/historyService";
import type { Embedder } from "./indexer/embedder";
import type { Extractor } from "./indexer/extractor";
import type { IndexerQueue } from "./indexer/indexerQueue";
import type { LLMProvider } from "./llm/provider";
import type { SavedQueries } from "./search/savedQueries";
import type { SearchHistory } from "./search/searchHistory";
import type { SearchPipeline } from "./search/searchPipeline";
import type { AgentEventStore } from "./services/agentEventStore";
import type { HealthMonitor } from "./services/healthMonitor";
import type { IdleDetector } from "./services/idleDetector";
import type { ProbeCache } from "./services/probeCache";
import type { SessionGrants } from "./services/sessionGrants";
import type { VaultBootstrap } from "./services/vaultBootstrap";
import type { VaultLockHandle } from "./services/vaultLock";
import type { SettingsService } from "./settings/settingsService";
import type { VitalsService } from "./vitals/vitalsService";

export interface ServiceRegistry {
  bus: EventBus;
  settings: SettingsService;
  vault: VaultAdapter;
  primaryLLM: LLMProvider;
  deepLLM: LLMProvider;
  embeddingLLM: LLMProvider;
  health: HealthMonitor;
  lock: VaultLockHandle;
  probeCache: ProbeCache;
  agentEventStore: AgentEventStore;
  sessionGrants: SessionGrants;
  /**
   * Process-wide registry of in-flight `awaken --background` workers.
   * The daemon's shutdown path reads this registry to await pending
   * workers within a bounded grace window before flipping any rows that
   * remained `running` to `failed` with `failure_reason='daemon_shutdown'`.
   * Bootstrap registers the concrete instance during Phase A so the
   * registry is available before the awaken handlers wire up.
   */
  awakenBackgroundRegistry: BackgroundRegistry;
  indexer: IndexerQueue;
  embedder: Embedder;
  extractor: Extractor;
  coordinator: Coordinator;
  idleDetector: IdleDetector;
  reasoningMutex: ReasoningMutex;

  // Phase 4 services. Each registers in main.ts before kernel.seal().
  vitalsService: VitalsService;
  searchPipeline: SearchPipeline;
  savedQueries: SavedQueries;
  searchHistory: SearchHistory;
  conversationStore: ConversationStore;
  conversationIndex: ConversationIndex;
  toolRegistry: ToolRegistry;
  toolModeCache: ToolModeCache;
  approvalGate: ApprovalGate;
  contextManager: ContextManager;
  chatService: ChatService;
  historyService: HistoryService;
  approvalService: ApprovalService;
  transcriptDistiller: TranscriptDistiller;
  vaultBootstrap: VaultBootstrap;

  // Phase C — optional vision routing slot. Registered only when the primary
  // LM Studio model passes the vision probe OR `chat.vision.enabled` is true
  // and the configured fallback baseUrl probes successfully. Bootstrap omits
  // this key when neither path is viable; chat handlers must guard with has().
  visionLLM: VisionRouterLike;

  /**
   * Optional SurrealDB connection slot. Registered by bootstrap after the
   * embedded `surreal start` server is spawned, the SDK connects, and the
   * schema is applied. Intentionally absent from REQUIRED_KEYS and every
   * PHASE_*_KEYS list during Phase 1; consumers must guard with
   * `kernel.has("surrealDb")` before calling `kernel.get("surrealDb")`.
   */
  surrealDb: SurrealConnection;

  /**
   * Per-vault TOML config loaded once at boot from
   * `<vault>/.notient/config.toml`. Bootstrap writes it before the indexer
   * queue, embedder, extractor, and surreal start are configured; every
   * consumer of indexer concurrency / chunk sizes / awaken defaults reads
   * from this slot rather than re-parsing the TOML file. Phase 4 Task 10.
   */
  vaultConfig: VaultConfig;
}

/**
 * Structural type for the vision routing slot. The concrete VisionRouter
 * lives in `src/agent/visionProbe.ts`; the kernel is intentionally decoupled
 * so it does not depend on the agent module.
 */
export interface VisionRouterLike {
  describe(image: { path: string; bytes: ArrayBuffer; mediaType: string }): Promise<string>;
}

export type ServiceKey = keyof ServiceRegistry;

const REQUIRED_KEYS: ServiceKey[] = [
  "bus",
  "settings",
  "vault",
  "primaryLLM",
  "deepLLM",
  "embeddingLLM",
  "health",
  "lock",
  "probeCache",
  "agentEventStore",
  "sessionGrants",
  "awakenBackgroundRegistry",
  "indexer",
  "embedder",
  "extractor",
  "reasoningMutex",
  "idleDetector",
  "coordinator",
  "approvalService",
  "vitalsService",
  "searchPipeline",
  "savedQueries",
  "searchHistory",
  "conversationStore",
  "conversationIndex",
  "toolRegistry",
  "toolModeCache",
  "approvalGate",
  "contextManager",
  "chatService",
  "historyService",
  "transcriptDistiller",
  "vaultBootstrap",
];

const PHASE_A_KEYS: ServiceKey[] = [
  "bus",
  "settings",
  "vault",
  "primaryLLM",
  "deepLLM",
  "embeddingLLM",
  "health",
  "lock",
  "probeCache",
  "agentEventStore",
  "sessionGrants",
  "awakenBackgroundRegistry",
];

const PHASE_B_KEYS: ServiceKey[] = [
  ...PHASE_A_KEYS,
  "indexer",
  "embedder",
  "extractor",
  "vaultBootstrap",
  "idleDetector",
  "reasoningMutex",
  "searchPipeline",
  "savedQueries",
  "searchHistory",
  "vitalsService",
  "coordinator",
];

const PHASE_C_KEYS: ServiceKey[] = [
  ...PHASE_B_KEYS,
  "conversationStore",
  "conversationIndex",
  "approvalGate",
  "toolRegistry",
  "toolModeCache",
  "contextManager",
  "chatService",
  "historyService",
  "approvalService",
  "transcriptDistiller",
];

export class Kernel {
  private services: Partial<ServiceRegistry> = {};
  private sealed = false;

  register<K extends ServiceKey>(key: K, value: ServiceRegistry[K]): void {
    if (this.sealed) throw new Error(`Kernel sealed; cannot register ${key}`);
    this.services[key] = value;
  }

  seal(options: { phase?: "A" | "B" | "C" } = {}): void {
    let required: ServiceKey[];
    if (options.phase === "A") required = PHASE_A_KEYS;
    else if (options.phase === "B") required = PHASE_B_KEYS;
    else if (options.phase === "C") required = PHASE_C_KEYS;
    else required = REQUIRED_KEYS;
    const missing = required.filter((key) => this.services[key] === undefined);
    if (missing.length > 0) {
      throw new Error(`Kernel.seal(): missing required services: ${missing.join(", ")}`);
    }
    this.sealed = true;
  }

  get<K extends ServiceKey>(key: K): ServiceRegistry[K] {
    const value = this.services[key];
    if (value === undefined) throw new Error(`Kernel: service '${key}' not registered`);
    return value as ServiceRegistry[K];
  }

  has(key: ServiceKey): boolean {
    return this.services[key] !== undefined;
  }

  isSealed(): boolean {
    return this.sealed;
  }
}
