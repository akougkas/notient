import type { VaultAdapter } from "../adapters/vaultAdapter";
import type { NoteAnalysis } from "./analysis/noteAnalysis";
import type { ApprovalService } from "./approvals/approvalService";
import type { BackgroundRegistry } from "./awaken/backgroundRegistry";
import type { ApprovalGate } from "./chat/approvalGate";
import type { ChatService } from "./chat/chatService";
import type { ContextManager } from "./chat/contextManager";
import type { ConversationIndex } from "./chat/conversationIndex";
import type { ConversationStore } from "./chat/conversationStore";
import type { ToolModeCache } from "./chat/toolModeProbe";
import type { ToolRegistry } from "./chat/tools/registry";
import type { AgentRunExecutor } from "./coordinator/agentRunExecutor";
import type { Coordinator } from "./coordinator/coordinator";
import type { ReasoningScheduler } from "./coordinator/reasoningScheduler";
import type { SurrealConnection } from "./db/surreal";
import type { TranscriptDistiller } from "./distill/transcriptDistiller";
import type { EventBus } from "./events/eventBus";
import type { GraphService } from "./graph/graphService";
import type { ChangeService } from "./history/changeService";
import type { DurableNoteWriter } from "./history/durableNoteWriter";
import type { HistoryService } from "./history/historyService";
import type { Embedder } from "./indexer/embedder";
import type { Extractor } from "./indexer/extractor";
import type { IndexerQueue } from "./indexer/indexerQueue";
import type { LLMProvider } from "./llm/provider";
import type { JobService } from "./pipelines/jobService";
import type { SearchPipeline } from "./search/searchPipeline";
import type { AgentEventStore } from "./services/agentEventStore";
import type { HealthMonitor } from "./services/healthMonitor";
import type { SentienceActivity } from "./services/sentienceActivity";
import type { SessionGrants } from "./services/sessionGrants";
import type { VaultLockHandle } from "./services/vaultLock";
import type { SettingsService } from "./settings/settingsService";
import type { DaemonMutationJournal } from "./vault/daemonMutationJournal";
import type { VitalsService } from "./vitals/vitalsService";

export interface ServiceRegistry {
  analysis: NoteAnalysis;
  graph: GraphService;
  changes: ChangeService;
  jobs: JobService;
  bus: EventBus;
  settings: SettingsService;
  vault: VaultAdapter;
  primaryLLM: LLMProvider;
  deepLLM: LLMProvider;
  embeddingLLM: LLMProvider;
  health: HealthMonitor;
  lock: VaultLockHandle;
  agentEventStore: AgentEventStore;
  sessionGrants: SessionGrants;
  /**
   * Process-wide registry of in-flight `awaken --background` workers.
   * The daemon's shutdown path reads this registry to await pending
   * workers within a bounded grace window before flipping any rows that
   * remained `running` to `failed` with `failure_reason='daemon_shutdown'`.
   * Bootstrap registers the concrete instance with the infrastructure
   * services so it exists before awaken handlers wire up.
   */
  awakenBackgroundRegistry: BackgroundRegistry;
  /**
   * Vault-relative-path predicate compiled from
   * `settings.indexer.excludePaths` / `excludeGlobs`. Registered in
   * alongside the infrastructure services so the vault listing, indexer
   * queue, watcher, and awaken/reindex handlers all consult one instance.
   */
  indexExclusion: (vaultPath: string) => boolean;
  indexer: IndexerQueue;
  embedder: Embedder;
  extractor: Extractor;
  coordinator: Coordinator;
  sentienceActivity: SentienceActivity;
  daemonMutationJournal: DaemonMutationJournal;
  reasoningScheduler: ReasoningScheduler;
  agentRunExecutor: AgentRunExecutor;

  // Runtime services. Each registers before the kernel is sealed.
  vitalsService: VitalsService;
  searchPipeline: SearchPipeline;
  conversationStore: ConversationStore;
  conversationIndex: ConversationIndex;
  toolRegistry: ToolRegistry;
  toolModeCache: ToolModeCache;
  approvalGate: ApprovalGate;
  contextManager: ContextManager;
  chatService: ChatService;
  historyService: HistoryService;
  durableNoteWriter: DurableNoteWriter;
  approvalService: ApprovalService;
  transcriptDistiller: TranscriptDistiller;

  // Vision routing is the one capability-gated slot. Bootstrap registers it
  // only when the primary model passes its probe; chat handlers guard access
  // with has().
  visionLLM: VisionRouterLike;

  /**
   * Canonical SurrealDB substrate. Bootstrap registers it only after the
   * embedded server is live, the SDK connects, and the schema is applied.
   * Every sealed kernel phase requires this connection.
   */
  surrealDb: SurrealConnection;
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
  "agentEventStore",
  "sessionGrants",
  "awakenBackgroundRegistry",
  "indexExclusion",
  "surrealDb",
  "indexer",
  "embedder",
  "extractor",
  "reasoningScheduler",
  "agentRunExecutor",
  "sentienceActivity",
  "daemonMutationJournal",
  "coordinator",
  "approvalService",
  "vitalsService",
  "searchPipeline",
  "conversationStore",
  "conversationIndex",
  "toolRegistry",
  "toolModeCache",
  "approvalGate",
  "contextManager",
  "chatService",
  "historyService",
  "durableNoteWriter",
  "transcriptDistiller",
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
  "agentEventStore",
  "sessionGrants",
  "awakenBackgroundRegistry",
  "indexExclusion",
  "surrealDb",
];

const PHASE_B_KEYS: ServiceKey[] = [
  ...PHASE_A_KEYS,
  "indexer",
  "embedder",
  "extractor",
  "sentienceActivity",
  "daemonMutationJournal",
  "reasoningScheduler",
  "agentRunExecutor",
  "searchPipeline",
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
  "durableNoteWriter",
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
