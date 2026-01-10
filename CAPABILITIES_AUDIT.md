# Notient Plugin - Complete Backend Capabilities Audit

**Generated:** Comprehensive audit of backend capabilities, APIs, call flows, configurations, and implementation details from source code analysis.

---

## Table of Contents

1. [Service Architecture & Call Flows](#service-architecture--call-flows)
2. [Service APIs & Methods](#service-apis--methods)
3. [Event System & Flows](#event-system--flows)
4. [Pipelines & Execution Flows](#pipelines--execution-flows)
5. [Configuration System](#configuration-system)
6. [Action System](#action-system)
7. [Indexing System](#indexing-system)
8. [Search System](#search-system)
9. [Intelligence System](#intelligence-system)
10. [Agent System](#agent-system)

---

## Service Architecture & Call Flows

### Kernel (Service Manager)

**Location**: `src/core/kernel.ts`

**Purpose**: Central orchestrator managing all services, capabilities, and lifecycle.

**Key Methods**:
- `initialize()`: Sets up storage paths, acquires vault lock
- `registerService<K>(name: K, service: ServiceRegistry[K])`: Registers a service
- `getService<K>(name: K): ServiceRegistry[K] | null`: Type-safe service retrieval
- `updateServiceHealth(service, health)`: Updates health status, recalculates capabilities
- `updateCapabilities()`: Recalculates capabilities based on service health
- `dispose()`: Disposes all services in reverse order

**Service Registry** (`ServiceRegistry`):
```typescript
{
  healthMonitor: HealthMonitor;
  ollama: OllamaService;
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
}
```

**Capability Calculation**:
- `embedding`: Requires Ollama healthy
- `reasoning`: Requires LM Studio healthy
- `vectorStore`: Always true (pure JS)
- `indexing`: Requires Ollama healthy AND write lock held
- `search`: Requires Ollama healthy

**Call Flow - Service Initialization** (from `main.ts`):
```
main.ts::initializeServicesAsync()
  → HealthMonitor.initialize()
  → OllamaService.initialize() (required)
  → LMStudioService.initialize() (optional)
  → SimpleVectorStore() (created)
  → IndexManager.initialize()
    → IndexManager.discoverBestIndex()
    → IndexManager.loadIndexFromPath()
      → VectorStore.loadFromData()
  → SimpleIndexer.initialize()
  → SearchPipeline.initialize()
  → VaultContextBuilder() (created)
  → SimpleVaultVitals() (created)
  → LMStudioProvider.initialize()
  → ProfileManager.load()
  → UserEvolutionService.load()
  → NoteIntelligenceService.initialize()
  → NotientAgent() (created)
  → AgentTaskQueue() (created)
  → ConversationStore.load()
  → TrustLevelManager() (created)
  → ActionHistory.load()
  → ActionApplier() (created)
  → WorkflowRunner() (created)
  → ActionOrchestrator() (created)
```

---

## Service APIs & Methods

### 1. VectorStore (`SimpleVectorStore`)

**Location**: `src/services/simpleVectorStore.ts`

**Interface**: `src/services/vectorStore.ts`

**Public API**:
```typescript
// Core operations
initialize(options?: VectorStoreInitOptions): Promise<void>
upsertChunks(chunks: EmbeddedChunk[]): Promise<void>
deleteByNoteId(noteId: string): Promise<void>
deleteByPathPrefix(prefix: string): Promise<void>
search(embedding: number[], options: SearchOptions): Promise<ChunkSearchResult[]>
getChunksByNoteId(noteId: string): Promise<NoteChunk[]>
countChunks(): Promise<number>
countNotes(): Promise<number>
isReady(): boolean
dispose(): Promise<void>

// Bulk operations
beginBulkUpdate?(): void
endBulkUpdate?(): Promise<void>
clearAll?(): Promise<void>

// State management (v3)
getNoteState?(notePath: string): EmbeddedNoteState | null
setNoteState?(notePath: string, state: EmbeddedNoteState): void
removeNoteState?(notePath: string): void
getIndexedPaths?(): string[]
getIndexedNoteCount?(): number
isNoteIndexed?(notePath: string): boolean
getLastFullIndexAt?(): number | null
recordFullIndex?(): void
clearState?(): void

// Data transfer (for IndexManager)
loadFromData?(data: {...}): void
exportData?(): {...}
setModelConfig?(modelKey: string, dimension: number): void
isDirty?(): boolean
clearDirty?(): void
```

**Implementation Details**:
- In-memory storage: `Map<string, StoredDoc>` for chunks
- Brute-force cosine similarity search
- Tiered chunks: `note`, `section`, `block`
- Embedded state (v3): Note states stored in memory, persisted by IndexManager
- Dirty tracking: Flags when data needs saving

**Who Calls**:
- `IndexManager`: Loads/saves data, manages state
- `SimpleIndexer`: Upserts chunks during indexing
- `SearchPipeline`: Searches for similar chunks

---

### 2. IndexManager

**Location**: `src/services/indexManager.ts`

**Public API**:
```typescript
// Initialization
initialize(): Promise<void>
dispose(): Promise<void>

// Index discovery
static discoverIndices(storagePaths): Promise<DiscoveredIndex[]>
discoverIndices(): Promise<DiscoveredIndex[]>
discoverBestIndex(): Promise<string | null>
loadIndexFromPath(indexPath: string): Promise<boolean>

// Index operations
saveIndex(): Promise<void>
scheduleSave(): void
clearAll(): Promise<void>
switchToIndex(indexPath: string): Promise<void>
deleteIndexByPath(indexPath: string): Promise<boolean>
trimIndex(): Promise<{ removed: number }>
exportIndex(): Promise<string>
importIndex(jsonData: string): Promise<{ modelKey: string; noteCount: number }>

// State tracking
getNoteState(notePath: string): NoteState | null
setNoteState(notePath: string, state: NoteState): void
removeNoteState(notePath: string): void
needsReindex(notePath: string, mtimeMs: number, contentHash: string): boolean
getIndexedPaths(): string[]
getIndexedCount(): number
isNoteIndexed(notePath: string): boolean
recordFullIndex(): void
getLastFullIndexAt(): number | null
getStats(): Promise<IndexStats>

// Vector operations (delegates to VectorStore)
addChunks(chunks: EmbeddedChunk[]): Promise<void>
removeNote(notePath: string, noteId: string): Promise<void>
search(embedding: number[], options: SearchOptions): Promise<ChunkSearchResult[]>
getChunksByNoteId(noteId: string): Promise<NoteChunk[]>
countChunks(): Promise<number>
countNotes(): Promise<number>
isReady(): boolean

// Bulk operations
beginBulkUpdate(): void
endBulkUpdate(): Promise<void>

// Metadata
getDimension(): number
getActiveModelKey(): string
getActiveIndexPath(): string | null
isReadOnly(): boolean
getErrorCount(): number
recordError(notePath: string): void
clearErrors(): void
clearDiscoveryCache(): void
```

**Index File Formats**:
- **v3**: `idx_{timestamp}_v{version}_{model}_{dim}d.json` (embedded state)
- **v2**: `idx_{timestamp}_{vaultHash}_{model}_{dim}d.json` (separate state file)
- **Legacy**: `index-{model}-{dim}d.json`

**Call Flow - Index Loading**:
```
IndexManager.initialize()
  → OllamaService.getModelKey() + getDimension()
  → VectorStore.setModelConfig()
  → discoverBestIndex() OR loadIndexFromPath()
    → parseIndexFilename()
    → fs.readFile()
    → validate model/dimension match
    → VectorStore.loadFromData()
  → VectorStore.initialize()
```

**Call Flow - Index Saving**:
```
IndexManager.scheduleSave() (debounced 10s)
  → VectorStore.isDirty() check
  → VectorStore.exportData()
  → atomicWriteFile()
  → VectorStore.clearDirty()
```

---

### 3. SimpleIndexer

**Location**: `src/core/indexer/simpleIndexer.ts`

**Public API**:
```typescript
initialize(): Promise<void>
syncVault(): Promise<IndexResult>
fullReindex(): Promise<IndexResult>
indexNote(path: string): Promise<void>
abort(): void
getProgress(): IndexProgress
dispose(): void
```

**IndexResult**:
```typescript
{
  added: number;
  updated: number;
  removed: number;
  errors: number;
  durationMs: number;
}
```

**Call Flow - Sync Vault**:
```
SimpleIndexer.syncVault()
  → check hasWriteLock
  → scanForChanges()
    → getMarkdownFiles()
    → for each file: needsReindex() check
    → compare indexedPaths vs currentPaths
  → removeNote() for deleted files
  → beginBulkUpdate()
  → processBatch() (5 notes per batch)
    → processNote()
      → chunkNoteTiered() (creates NoteChunk[])
      → embedChunks() (batch size 4)
        → OllamaService.embedBatch()
      → IndexManager.removeNote() (clear old)
      → IndexManager.addChunks()
      → IndexManager.setNoteState()
  → endBulkUpdate()
  → recordFullIndex()
  → emit("index:complete")
```

**File Watcher Integration**:
- Subscribes to: `onFileCreate`, `onFileModify`, `onFileRename`, `onFileDelete`
- Debounced per-file (default 5000ms)
- Concurrent indexing protection per note path

---

### 4. SearchPipeline

**Location**: `src/core/search/pipeline.ts`

**Public API**:
```typescript
initialize(): Promise<void>
search(query: string, options?: Partial<ExtendedSearchOptions>): Promise<SearchResult[]>
findRelated(path: string, options?: { topK?, minScore? }): Promise<RelatedNote[]>
clearCache(): void
dispose(): void
```

**Call Flow - Search**:
```
SearchPipeline.search(query, options)
  → getCacheKey() → check queryCache (LRU)
  → getQueryEmbedding() (cached)
    → OllamaService.embed()
  → VectorStore.search() (tier=note, topK=80/40)
    → get candidate note IDs
  → VectorStore.search() (tier=block, topK=120/60, maxPerNote=5/3)
    → get candidate chunks
  → rerankChunksWithLLM() (if enabled)
    → LLMProvider.rerank() OR LMStudioService.rerank()
  → aggregateChunksToNotes() (max 3 chunks per note)
  → slice(0, requestedTopK)
  → updateCache() (LRU eviction)
  → emit("search:complete")
```

**Cache Strategy**:
- Query cache: LRU with TTL (`CACHE_CONFIG.SEARCH_CACHE_TTL_MS`)
- Embedding cache: LRU, max size `CACHE_CONFIG.MAX_QUERY_CACHE_SIZE`
- Cache key includes: query, topK, minScore, paraType, folderPaths, tags, enableReranking

**Reranking**:
- Prefers `LLMProvider.rerank()`, falls back to `LMStudioService.rerank()`
- Reranks top 25 chunks
- Remaining chunks keep vector scores with 0.85 penalty

---

### 5. NotientAgent

**Location**: `src/core/agent/agentLoop.ts`

**Public API**:
```typescript
constructor(llm: LLMProvider, search: SearchPipeline | null, contextBuilder: VaultContextBuilder | null, obsidian: ObsidianFacade, profile?: UserProfile)
setProfile(profile: UserProfile | undefined): void
execute(task: AgentTask): Promise<TaskResult>
executeStreaming(task: AgentTask, signal?: AbortSignal): AsyncIterable<AgentStreamEvent>
updateLLM(llm: LLMProvider): void
updateSearch(search: SearchPipeline | null): void
updateContextBuilder(contextBuilder: VaultContextBuilder | null): void
```

**Call Flow - Execute Task**:
```
NotientAgent.executeStreaming(task)
  → inferTaskType(query)
  → load current note content (if notePath provided)
  → SearchPipeline.search() (query + note title, topK=7)
  → VaultContextBuilder.buildForQuery()
  → extract citations and relevant notes
  → NotientPromptBuilder.buildSystemPrompt()
  → LLMProvider.stream() (sliding window: last 10 messages)
  → parseActionPlan() (if agentic task type)
    → LLMProvider.complete() (non-streaming for JSON)
    → validate and sanitize actions
  → yield events: progress, chunk, citations, actions, complete
```

**Task Types**:
- `enrich`: Expand note with additional context
- `link`: Find and add related links
- `classify`: Move/organize note
- `analyze`: Health analysis
- `chat`: General conversation

**Action Plan Generation**:
- Only for: `enrich`, `link`, `classify`
- Uses separate prompt: `buildActionPlanPrompt()`
- Validates against `SUPPORTED_ACTION_TYPES`
- Overrides risk levels from `ACTION_RISK_MAP`
- Sanitizes target paths (normalizes, validates .md extension)

---

### 6. ActionOrchestrator

**Location**: `src/core/intelligence/actionOrchestrator.ts`

**Public API**:
```typescript
constructor(llm: LMStudioService, search: SearchPipeline, profileProvider?: ProfileProvider)
setProfileProvider(provider: ProfileProvider): void
dispatch(actionType: IntelligenceActionType, context: ActionContext, triggerConfig?: TriggerConfig): Promise<DispatchResult>
execute(actionType: IntelligenceActionType, context: ActionContext, triggerConfig?: TriggerConfig): AsyncGenerator<PipelineEvent>
getEstimatedDuration(actionType: IntelligenceActionType): string
requiresMultipleNotes(actionType: IntelligenceActionType): boolean
getActionInfo(actionType: IntelligenceActionType): { icon, label, description }
```

**Intelligence Action Types**:
- `atomic`: Split into atomic concepts (batch, ~45-90s)
- `synthesis`: Create synthesis note (batch, ~45-90s)
- `clipping`: Process web clipping (batch, ~45-90s)
- `task`: Extract tasks/deadlines (complex, ~30-60s)
- `brand`: Brand alignment check (complex, ~30-60s)
- `connection`: Find semantic connections (simple, ~15-30s)
- `enhance`: Enhance note structure (simple, ~15-30s)
- `antagonist`: Critical review (simple, ~15-30s)

**Call Flow - Dispatch Action**:
```
ActionOrchestrator.dispatch(actionType, context, triggerConfig)
  → ProfileProvider() (get current profile)
  → getProfileAwarePrompt(actionType, profile)
  → detectComplexity(actionType)
  → createActionPipeline(config)
  → return DispatchResult { pipeline, actionType, complexity, prompt }
```

---

### 7. ActionPipeline

**Location**: `src/core/intelligence/actionPipeline.ts`

**Public API**:
```typescript
execute(): AsyncGenerator<PipelineEvent>
```

**PipelineEvent Types**:
- `{ type: "phase", phase: PipelinePhase, progress: number }`
- `{ type: "chunk", content: string }`
- `{ type: "analysis", analysis: string }`
- `{ type: "actions", actions: ProposedAction[] }`
- `{ type: "batches", batches: ActionBatch[] }`
- `{ type: "complete", result: PipelineResult }`
- `{ type: "error", error: Error }`

**Call Flow - Execute Pipeline**:
```
ActionPipeline.execute()
  → prepare()
    → SearchPipeline.search() (if relatedNotes not provided)
    → format related notes
  → buildUserPrompt() (replace {{placeholders}})
  → streamAnalysis()
    → LMStudioService.chatStream()
  → parseResponse()
    → extractJson() (multiple strategies)
    → convertToActions() (type-specific converters)
  → createBatches() (if complexity="batch")
  → yield complete event
```

**Action Converters** (per type):
- `convertAtomicActions()`: Creates `create_note` + `restructure_note`
- `convertSynthesisActions()`: Creates `create_synthesis_note`
- `convertClippingActions()`: Creates `create_note` per concept
- `convertTaskActions()`: Creates `create_task_note`
- `convertBrandActions()`: Creates `append_review_section`
- `convertConnectionActions()`: Creates `append_related_links`
- `convertEnhanceActions()`: Creates `frontmatter_set`, `frontmatter_add_tags`, `append_section`
- `convertAntagonistActions()`: Creates `append_review_section`

---

### 8. ActionApplier

**Location**: `src/core/agentic/actionApplier.ts`

**Public API**:
```typescript
constructor(kernel: Kernel, obsidian: ObsidianFacade, actionHistory: ActionHistory, trustManager: TrustLevelManager)
apply(action: ProposedAction, taskId?: string, workflowId?: string, skipConfirmation?: boolean): Promise<ApplyResult>
applyConfirmed(action: ProposedAction, taskId?: string, workflowId?: string): Promise<ApplyResult>
```

**Call Flow - Apply Action**:
```
ActionApplier.apply(action, taskId, workflowId, skipConfirmation)
  → check hasWriteLock
  → TrustLevelManager.evaluate(action) (if !skipConfirmation)
  → validateAction(action)
  → applyAction(action, taskId, workflowId)
    → switch(action.type):
      → frontmatter_set: readFile → parseFrontmatter → set field → writeFile
      → frontmatter_add_tags: readFile → parseFrontmatter → add tags → writeFile
      → append_section: readFile → append content → writeFile
      → append_related_links: readFile → append "## Related Notes" → writeFile
      → move_note: obsidian.renameFile()
      → create_note: obsidian.createFile()
      → batch_create_notes: create multiple files
      → restructure_note: readFile → replace content → writeFile
      → create_task_note: create file with task structure
      → append_review_section: readFile → append review → writeFile
      → batch_append_links: append links to multiple notes
  → ActionHistory.record(action, undoPayload)
  → emit("action:applied")
```

**Undo Payloads**:
- `restore_content`: `{ type: "restore_content", files: [{ path, before }] }`
- `rename_back`: `{ type: "rename_back", from: string, to: string }`

---

### 9. WorkflowRunner

**Location**: `src/core/agentic/workflowRunner.ts`

**Public API**:
```typescript
constructor(kernel: Kernel, eventBus: EventBus, taskQueue: AgentTaskQueue, obsidian: ObsidianFacade, config: WorkflowConfig)
startFromCommand(parsed: ParsedCommand): Promise<StartWorkflowResult>
cancel(workflowId: string): boolean
getCurrentWorkflow(): WorkflowRun | null
getQueuedWorkflows(): WorkflowRun[]
getWorkflow(id: string): WorkflowRun | null
dismissReviewItem(actionId: string): void
```

**Call Flow - Start Workflow**:
```
WorkflowRunner.startFromCommand(parsed)
  → resolveTargets(scope, target)
    → getMarkdownFiles()
    → filter by scope (note/folder/vault)
    → filter excluded folders
  → limit to maxNotesPerWorkflow (default 100)
  → create WorkflowSpec
  → create WorkflowRun (status="queued")
  → queue.push(run)
  → processNextWorkflow() (if no current workflow)
```

**Call Flow - Execute Workflow**:
```
WorkflowRunner.executeWorkflow(workflow)
  → for each target note:
    → processNote(workflow, notePath, command)
      → create AgentTask
      → AgentTaskQueue.enqueue(task)
      → wait for task completion
      → extract ProposedAction[] from result
      → for each action:
        → TrustLevelManager.evaluate()
        → if low-risk + autoApply: ActionApplier.apply()
        → else: add to reviewQueue
    → delayBetweenTasksMs (default 500ms)
  → emit("workflow:completed")
```

**Workflow Status**:
- `queued`: Waiting to start
- `running`: Currently executing
- `completed`: Finished successfully
- `cancelled`: User cancelled
- `failed`: Error occurred

---

### 10. NoteIntelligenceService

**Location**: `src/core/intelligence/noteIntelligence.ts`

**Public API**:
```typescript
constructor(kernel: Kernel, eventBus: EventBus)
initialize(): Promise<void>
dispose(): void
getRecord(path: string): IntelligenceRecord | null
regenerate(path: string): Promise<void>
```

**Call Flow - Process Note**:
```
NoteIntelligenceService.processNote(notePath)
  → computeHealth() (heuristic: tags, headings, links, freshness)
  → generateSummary()
    → LLMProvider.complete()
    → parseSummaryJson()
  → extractEntitiesAndTags()
    → LLMProvider.complete()
  → suggestLinks()
    → SearchPipeline.findRelated()
  → inboxTriage()
    → LLMProvider.complete()
  → IntelligenceDb.upsert()
  → emit("intelligence:updated")
```

**IntelligenceRecord Structure**:
```typescript
{
  noteId: string;
  path: string;
  mtimeMs: number;
  contentHash: string;
  modelKey: string;
  generatedAt: number;
  summaryShort: string | null;
  summaryStructured: IntelligenceSummaryStructured | null;
  health: IntelligenceHealth;
  entities: IntelligenceEntity[];
  suggestedTags: IntelligenceSuggestedTag[];
  suggestedLinks: IntelligenceSuggestedLink[];
  triageAction: IntelligenceTriageAction | null;
}
```

**Queue Processing**:
- Enqueues stale records after `index:complete` event
- Processes queue with UI yielding
- Max queue size: 1000
- Refreshes link stats once per run

---

## Event System & Flows

### EventBus

**Location**: `src/core/events/eventBus.ts`

**API**:
```typescript
on<T>(event: T, listener: EventListener<T>): Unsubscribe
once<T>(event: T, listener: EventListener<T>): Unsubscribe
emit<T>(event: T, payload: EventPayloads[T]): void
off<T>(event: T): void
listenerCount<T>(event: T): number
dispose(): void
```

### Event Types & Payloads

**Health Events**:
- `health:changed`: `{ service: "ollama" | "lmstudio", health: ServiceHealth }`

**Initialization Events**:
- `init:state-changed`: `{ previousState, currentState, context }`
- `services:initialized`: `{}`
- `services:failed`: `{ reason: "missing_config" | "connection_failed" | "unknown" }`

**Index Events**:
- `index:progress`: `{ progress: IndexProgress }`
- `index:complete`: `{ totalIndexed: number, durationMs: number }`
- `index:error`: `{ path?: string, error: string, source?: string }`

**Search Events**:
- `search:started`: `{ query: string }`
- `search:progress`: `{ query: string, stage: SearchStage, detail?: string }`
- `search:complete`: `{ query: string, results: SearchResult[], durationMs: number, cached: boolean, reranked?: boolean }`
- `search:error`: `{ query: string, error: string, operation: "search" | "findRelated" }`

**Vitals Events**:
- `vitals:updated`: `{ vitals: VaultVitalsData }`

**Intelligence Events**:
- `intelligence:updated`: `{ path: string, record: IntelligenceRecord }`

**Settings Events**:
- `settings:changed`: `{ changedFields: string[] }`

**Agent Events**:
- `agent:task-update`: `{ task: AgentTask }`

**Workflow Events**:
- `workflow:started`: `{ workflow: WorkflowRun }`
- `workflow:progress`: `{ workflow: WorkflowRun }`
- `workflow:completed`: `{ workflow: WorkflowRun }`
- `workflow:cancelled`: `{ workflow: WorkflowRun }`
- `workflow:failed`: `{ workflow: WorkflowRun, error: string }`
- `workflow:reviewDismissed`: `{ workflowId: string, actionId: string }`

**Action Events**:
- `action:proposed`: `{ action: ProposedAction, noteContext: { path, title }, source?: string }`
- `action:applied`: `{ record: AppliedActionRecord }`
- `action:undone`: `{ recordId: string }`
- `action:apply-requested`: `{ actionId: string, action?: ProposedAction }`
- `action:undo-requested`: `{ actionId: string }`

**Profile Events**:
- `profile:updated`: `{ profile: UserProfile | undefined }`

**Lock Events**:
- `lock:lost`: `{ reason: "refresh_failed" | "stale_detected" | "manual_release", error?: string }`

### Event Flow Examples

**Indexing Flow**:
```
SimpleIndexer.syncVault()
  → emit("index:progress", { progress })
  → emit("index:complete", { totalIndexed, durationMs })
  
NoteIntelligenceService subscribes:
  → on("index:complete", () => enqueueStaleFromIndex())
```

**Search Flow**:
```
SearchPipeline.search()
  → emit("search:started", { query })
  → emit("search:progress", { query, stage })
  → emit("search:complete", { query, results, durationMs, cached, reranked })
```

**Action Flow**:
```
UI → emit("action:apply-requested", { actionId, action })
main.ts handler:
  → ActionApplier.apply(action)
  → emit("action:applied", { record })
```

---

## Configuration System

### Settings Structure

**Location**: `src/types/settings.ts`

**NotientSettings**:
```typescript
{
  version: number; // Schema version (currently 2)
  
  ollama: {
    host: string; // Default: "http://127.0.0.1:11434"
    embeddingModel: string; // Default: "nomic-embed-text"
    enabled: boolean; // Default: true
  };
  
  lmstudio: {
    host: string; // Default: "http://127.0.0.1:1234"
    reasoningModel: string; // Default: ""
    enabled: boolean; // Default: true
  };
  
  indexing: {
    chunkSize: number; // 32-8192, default: 1500
    debounceMs: number; // Default: 5000
    batchSize: number; // Default: 4
    excludedFolders: string[]; // Default: [".obsidian", ".trash"]
    activeIndexPath: string | null; // Default: null
    activeIndexMeta: {
      modelKey: string;
      dimension: number;
      isUserProvided: boolean;
    } | null;
  };
  
  para: {
    inbox: string[]; // Default: ["0-inbox", "inbox", "daily"]
    projects: string[]; // Default: ["1-projects", "projects"]
    areas: string[]; // Default: ["2-areas", "areas"]
    resources: string[]; // Default: ["2-knowledge", "3-resources", "resources", "reference"]
    archive: string[]; // Default: ["4-archive", "archive"]
  };
  
  ui: {
    showVitalsOnStartup: boolean; // Default: true
    sidebarPosition: "left" | "right"; // Default: "right"
  };
  
  search: {
    preset: "quick" | "balanced" | "thorough" | "custom"; // Default: "balanced"
    custom: {
      topK: number; // Default: 10
      enableReranking: boolean; // Default: true
      minScore: number; // Default: 0.3
    };
  };
  
  advanced: {
    debugLogging: boolean; // Default: false
    keepAliveMs: number; // Default: 300000 (5 minutes)
  };
  
  setupComplete: boolean; // Default: false
  
  agent: {
    trustPolicy: {
      autoApplyLowRisk: boolean; // Default: false
      requireConfirmMediumRisk: boolean; // Default: true
      requireConfirmHighRisk: boolean; // Default: true
    };
    history: {
      maxEntries: number; // Default: 200
      maxAgeDays: number; // Default: 30
    };
    bulk: {
      maxNotesPerWorkflow: number; // Default: 100
      delayBetweenTasksMs: number; // Default: 500
    };
  };
  
  chatRetention: {
    maxMessagesPerNote: number; // Default: 50
    maxAgeDays: number; // Default: 30
  };
}
```

**Search Presets**:
- `quick`: `{ topK: 5, enableReranking: false, minScore: 0.5 }`
- `balanced`: `{ topK: 10, enableReranking: true, minScore: 0.3 }`
- `thorough`: `{ topK: 25, enableReranking: true, minScore: 0.2 }`

**Settings Loading/Saving**:
- `loadSettings(plugin: Plugin): Promise<NotientSettings>`
- `saveSettings(plugin: Plugin, settings: NotientSettings): Promise<void>`
- Validates and migrates on load
- Emits `settings:changed` event with `changedFields`

---

## Action System

### ProposedAction Types

**Phase 2 Actions**:
- `frontmatter_set`: Set frontmatter field (risk: low)
- `frontmatter_add_tags`: Add tags (risk: low)
- `append_section`: Append section (risk: low)
- `append_related_links`: Append links section (risk: medium)
- `move_note`: Move note (risk: medium)

**Intelligence 2.0 Actions**:
- `create_note`: Create new note (risk: low)
- `batch_create_notes`: Create multiple notes (risk: medium)
- `restructure_note`: Restructure note (risk: medium)
- `create_task_note`: Create task note (risk: low)
- `extract_to_calendar`: Extract to calendar (risk: low)
- `append_review_section`: Append review (risk: low)
- `highlight_text_issues`: Highlight issues (risk: low)
- `batch_append_links`: Batch append links (risk: medium)
- `create_synthesis_note`: Create synthesis (risk: low)

**Reserved (Phase 3)**:
- `merge_notes`: Merge notes (risk: high)
- `trash_note`: Trash note (risk: high)

### Action Risk Mapping

**ACTION_RISK_MAP** (from `src/core/agentic/types.ts`):
```typescript
{
  frontmatter_set: "low",
  frontmatter_add_tags: "low",
  append_section: "low",
  append_related_links: "medium",
  move_note: "medium",
  merge_notes: "high",
  trash_note: "high",
  create_note: "low",
  batch_create_notes: "medium",
  restructure_note: "medium",
  create_task_note: "low",
  extract_to_calendar: "low",
  append_review_section: "low",
  highlight_text_issues: "low",
  batch_append_links: "medium",
  create_synthesis_note: "low",
}
```

### Trust Level Manager

**Location**: `src/core/agentic/trustLevelManager.ts`

**TrustDecision**:
```typescript
{
  allowed: boolean;
  requiresConfirmation: boolean;
  requiresDangerConfirm: boolean;
  reason?: string;
}
```

**Evaluation Logic**:
- Low-risk + `autoApplyLowRisk=true`: Auto-apply, no confirmation
- Low-risk + `autoApplyLowRisk=false`: Requires confirmation
- Medium-risk: Always requires confirmation (`requireConfirmMediumRisk=true`)
- High-risk: Always requires danger confirmation (`requireConfirmHighRisk=true`)

---

## Indexing System

### Chunking Strategy

**Tiered Semantic Chunking** (`chunkNoteTiered`):
- **Tier 1 (note)**: Note-level sketch (larger, ~chunkSize * 2.2)
- **Tier 2 (section)**: Section-level chunks (~chunkSize * 1.6)
- **Tier 3 (block)**: Block-level chunks (smaller, ~chunkSize * 0.8)

**Chunk Structure**:
```typescript
{
  chunkId: string;
  noteId: string;
  path: string;
  title: string;
  headingPath: string[];
  tier: "note" | "section" | "block";
  kind: "sketch" | "content" | "metadata";
  parentChunkId: string | null;
  blockRef: string | null;
  startLine: number | null;
  endLine: number | null;
  tokenEstimate: number;
  importance?: number;
  chunkIndex: number;
  text: string;
  embedding: number[];
  mtimeMs: number;
  contentHash: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
}
```

### Index File Structure (v3)

```typescript
{
  meta: {
    version: 3;
    modelKey: string;
    dimension: number;
    docCount: number;
    createdAt: number;
    updatedAt: number;
    chunker: { name: "tiered-semantic", version: 1 };
    tiers: { note: true, section: true, block: true };
    state: {
      lastFullIndexAt: number | null;
      notes: Record<string, EmbeddedNoteState>;
    };
  };
  docs: PersistedDoc[];
}
```

---

## Search System

### Search Options

```typescript
{
  topK?: number; // Default from preset
  minScore?: number; // Default from preset
  enableReranking?: boolean; // Default from preset
  includeContent?: boolean; // Default: true
  paraType?: string;
  folderPaths?: string[];
  tags?: string[];
  queryText?: string;
  noteIds?: string[]; // Filter by note IDs
  maxPerNote?: number; // Max chunks per note
  tier?: "note" | "block"; // Tier filter
}
```

### Hierarchical Retrieval (TSI v2)

**Stage 1 - Note Candidates**:
- Search with `tier="note"`, `includeContent=false`
- With reranking: topK=80
- Without reranking: topK=max(40, requestedTopK * 4)
- Extract unique note IDs

**Stage 2 - Chunk Candidates**:
- Search with `tier="block"`, `includeContent=true`, `noteIds` filter
- With reranking: topK=120, maxPerNote=5
- Without reranking: topK=max(60, requestedTopK * 6), maxPerNote=3
- Fallback to legacy if no tiered chunks available

**Stage 3 - Reranking**:
- Rerank top 25 chunks with LLM
- Remaining chunks: vector score * 0.85 penalty
- Sort by final score

**Stage 4 - Aggregation**:
- Group chunks by note
- Keep max 3 chunks per note (best scores)
- Sort notes by best chunk score

---

## Intelligence System

### Intelligence Database

**Location**: `src/core/intelligence/intelligenceDb.ts`

**Storage**: JSON file per model: `intelligence-{modelKey}.json`

**Structure**:
```typescript
{
  modelKey: string;
  records: Record<string, IntelligenceRecord>;
}
```

### Health Scoring

**Factors** (from `NoteIntelligenceService.computeHealth`):
- Has title: +20
- Has content (min length): +20
- Has tags: +15
- Has links (backlinks or outlinks): +20
- Has frontmatter: +10
- Recent modification: +15 (decays over time)

**Score Ranges**:
- 70-100: `healthy`
- 40-69: `attention`
- 0-39: `unhealthy`

### Summary Generation

**LLM Prompt**:
```
System: "You write compact note intelligence for an Obsidian vault. Output ONLY valid JSON."
Schema: {
  "summaryShort": "1-2 sentences",
  "keyPoints": ["bullet", "..."],
  "purpose": "what this note is for (string or null)"
}
```

**Input**: Title, path, tags, headings, note content (max 12000 chars)

---

## Agent System

### Agent Task Queue

**Location**: `src/core/agent/taskQueue.ts`

**Public API**:
```typescript
constructor(agent: NotientAgent, eventBus: EventBus)
enqueue(task: AgentTask): string // Returns task ID
cancel(taskId: string): boolean
getTask(taskId: string): AgentTask | null
getAllTasks(): AgentTask[]
```

**Task States**:
- `queued`: Waiting to execute
- `running`: Currently executing
- `completed`: Finished successfully
- `failed`: Error occurred
- `cancelled`: User cancelled

**Execution**:
- Sequential execution (one task at a time)
- Streams events: `progress`, `chunk`, `citations`, `actions`, `complete`, `error`
- Emits `agent:task-update` on state changes

---

## Summary

This audit documents the actual backend implementation:

- **21 Services** with documented APIs and call flows
- **Event System** with 25+ event types and payloads
- **4 Major Pipelines** with detailed execution flows
- **16 Action Types** with risk levels and validation
- **50+ Configuration Options** across 10 categories
- **Index System** with v3 format, tiered chunking, state tracking
- **Search System** with hierarchical retrieval, reranking, caching
- **Intelligence System** with health scoring, summaries, entity extraction
- **Agent System** with task queue, streaming, action planning

All APIs, call flows, and implementation details are sourced directly from the codebase.
