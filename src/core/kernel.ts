import type { VaultAdapter } from "../adapters/vaultAdapter";
import type { ApprovalService } from "./approvals/approvalService";
import type { CanvasFromResults } from "./canvas/canvasFromResults";
import type { ApprovalGate } from "./chat/approvalGate";
import type { ChatService } from "./chat/chatService";
import type { ContextManager } from "./chat/contextManager";
import type { ConversationIndex } from "./chat/conversationIndex";
import type { ConversationStore } from "./chat/conversationStore";
import type { ToolRegistry } from "./chat/tools/registry";
import type { CoAuthorService } from "./coAuthor/chatStream";
import type { Coordinator } from "./coordinator/coordinator";
import type { ReasoningMutex } from "./coordinator/reasoningMutex";
import type { Database } from "./db/database";
import type { EventBus } from "./events/eventBus";
import type { GraphStore } from "./graph/graphStore";
import type { NativeGraphBridge } from "./graph/nativeGraphBridge";
import type { HistoryService } from "./history/historyService";
import type { Embedder } from "./indexer/embedder";
import type { Extractor } from "./indexer/extractor";
import type { IndexerQueue } from "./indexer/indexerQueue";
import type { VectorIndex } from "./indexer/vectorIndex";
import type { LLMProvider } from "./llm/provider";
import type { SavedQueries } from "./search/savedQueries";
import type { SearchHistory } from "./search/searchHistory";
import type { SearchPipeline } from "./search/searchPipeline";
import type { EchoGuard } from "./services/echoGuard";
import type { HealthMonitor } from "./services/healthMonitor";
import type { IdleDetector } from "./services/idleDetector";
import type { VaultBootstrap } from "./services/vaultBootstrap";
import type { VaultLockHandle } from "./services/vaultLock";
import type { SettingsService } from "./settings/settingsService";
import type { StreamService } from "./stream/streamService";
import type { VitalsService } from "./vitals/vitalsService";

export interface ServiceRegistry {
  bus: EventBus;
  settings: SettingsService;
  vault: VaultAdapter;
  database: Database;
  graph: GraphStore;
  primaryLLM: LLMProvider;
  deepLLM: LLMProvider;
  embeddingLLM: LLMProvider;
  health: HealthMonitor;
  lock: VaultLockHandle;
  echoGuard: EchoGuard;
  indexer: IndexerQueue;
  vectorIndex: VectorIndex;
  embedder: Embedder;
  extractor: Extractor;
  coordinator: Coordinator;
  idleDetector: IdleDetector;
  reasoningMutex: ReasoningMutex;
  approvalService: ApprovalService;
  coAuthor: CoAuthorService;

  // Phase 4 services. Each registers in main.ts before kernel.seal().
  streamService: StreamService;
  vitalsService: VitalsService;
  nativeGraphBridge: NativeGraphBridge;
  canvasFromResults: CanvasFromResults;
  searchPipeline: SearchPipeline;
  savedQueries: SavedQueries;
  searchHistory: SearchHistory;
  conversationStore: ConversationStore;
  conversationIndex: ConversationIndex;
  toolRegistry: ToolRegistry;
  approvalGate: ApprovalGate;
  contextManager: ContextManager;
  chatService: ChatService;
  historyService: HistoryService;
  vaultBootstrap: VaultBootstrap;

  // Phase C — optional vision routing slot. Registered only when the primary
  // LM Studio model passes the vision probe OR `chat.vision.enabled` is true
  // and the configured fallback baseUrl probes successfully. Bootstrap omits
  // this key when neither path is viable; chat handlers must guard with has().
  visionLLM: VisionRouterLike;
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
  "database",
  "graph",
  "primaryLLM",
  "deepLLM",
  "embeddingLLM",
  "health",
  "lock",
  "echoGuard",
  "indexer",
  "vectorIndex",
  "embedder",
  "extractor",
  "reasoningMutex",
  "idleDetector",
  "coordinator",
  "approvalService",
  "coAuthor",
  "streamService",
  "vitalsService",
  "nativeGraphBridge",
  "canvasFromResults",
  "searchPipeline",
  "savedQueries",
  "searchHistory",
  "conversationStore",
  "conversationIndex",
  "toolRegistry",
  "approvalGate",
  "contextManager",
  "chatService",
  "historyService",
  "vaultBootstrap",
];

const PHASE_A_KEYS: ServiceKey[] = [
  "bus",
  "settings",
  "vault",
  "database",
  "graph",
  "primaryLLM",
  "deepLLM",
  "embeddingLLM",
  "health",
  "lock",
  "echoGuard",
];

const PHASE_B_KEYS: ServiceKey[] = [
  ...PHASE_A_KEYS,
  "indexer",
  "vectorIndex",
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
  "contextManager",
  "chatService",
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
