# Critical Bug Analysis: Obsidian Plugin Freezes UI

## Your Role

You are debugging a performance crisis in a TypeScript/Preact Obsidian plugin. I need:

1. **Root cause identification** - What specific operations are blocking?
2. **Theory** - Why does this cause CPU spin and UI freeze?
3. **Validation approach** - How would you confirm the diagnosis?
4. **Fix strategy** - High-level approach (not code), what patterns to apply

Do NOT provide code fixes. I have a separate implementation workflow. I need your debugging expertise to identify what's wrong.

---

## Project Context

### What is Notient?

Notient (Note + Sentient) is an Obsidian plugin that adds AI capabilities to note management:
- Vector search across vault notes using local embeddings
- AI-powered note analysis and suggestions
- Multi-agent system for different tasks (chat, classify, connect notes)
- **All AI runs locally** - Ollama for embeddings, LM Studio for reasoning

### Tech Stack

| Layer | Technology |
|-------|------------|
| Host | Obsidian Desktop (Electron) |
| Language | TypeScript (strict mode) |
| UI Framework | Preact + @preact/signals |
| Vector Search | HNSW algorithm via `hnswlib-wasm` (WebAssembly) |
| Embeddings | Ollama (remote server, qwen3-embedding) |
| Reasoning LLM | LM Studio (localhost, falcon-h1r-7b) |
| Build | esbuild, Bun |

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Obsidian (Electron Main Process)                               │
├─────────────────────────────────────────────────────────────────┤
│  Plugin Entry (main.ts)                                         │
│    └── Kernel (service registry, dependency injection)          │
│          ├── OllamaService (embeddings, remote HTTP)            │
│          ├── LMStudioService (reasoning, localhost HTTP)        │
│          ├── HNSWVectorStore (WASM-based vector search)         │
│          ├── ChunkStore (note chunks, file-per-note storage)    │
│          ├── IndexManager (coordinates chunks + embeddings)     │
│          ├── ChiefOfStaff (agent orchestrator)                  │
│          │     ├── ChatAgent                                    │
│          │     ├── ConnectionAgent                              │
│          │     ├── ClassifierAgent                              │
│          │     └── NoteEditorAgent                              │
│          └── SearchPipeline (vector + reranking)                │
├─────────────────────────────────────────────────────────────────┤
│  UI Layer (Preact, runs in Obsidian's renderer)                 │
│    └── App.tsx (sidebar component)                              │
│          ├── useAppEvents() - EventBus subscriptions            │
│          ├── ~20 Preact signals for reactive state              │
│          └── Three views: Note Vitals | Agent Streams | Chat    │
└─────────────────────────────────────────────────────────────────┘
```

### Data Scale

- **Vault size**: 895 markdown notes
- **Indexed notes**: 471 notes (partial index)
- **Chunks**: 29,050 (hierarchical: note → section → block)
- **Embeddings**: 22,313 vectors (1024 dimensions each)
- **Storage**: ~316MB JSON index file

---

## The Problem

### Symptoms

1. **CPU spins to 100%** when plugin loads
2. **Laptop overheating** - fans at maximum
3. **UI completely frozen** - Obsidian unresponsive for 30+ seconds
4. **Actions never complete** - user clicks button, nothing happens
5. **Load time**: 1+ minute for a plugin that should load in <3 seconds

### Console Logs (Verbatim)

```
[Notient] Loading plugin...
[Notient] Settings loaded, setupComplete = true
[Kernel] Starting initialization...
[Kernel] Step 1: Ensuring directories...
[Kernel] Step 1: Directories ready
[Kernel] Step 2: Acquiring lock...
[VaultLock] Removed stale lock
[VaultLock] Lock acquired on attempt 1
[Kernel] Step 2: Lock status = true
[Kernel] Initialization complete
[Notient] Plugin loaded successfully

[Notient] Initializing services...
[InitStateMachine] UNINITIALIZED → CHECKING_PROVIDERS
[OllamaService] Initializing with host=http://192.168.86.249:11434, model=qwen3-embedding:0.6b
[OllamaService] Discovered qwen3-embedding:0.6b: arch=qwen3, ctx=32768, dim=1024
[OllamaRerankerService] Initializing with model=B-A-M-N/Qwen3-Reranker-4B
[OllamaRerankerService] Ready with model=B-A-M-N/Qwen3-Reranker-4B
[LMStudioService] Initialized with model=falcon-h1r-7b
[InitStateMachine] CHECKING_PROVIDERS → LOADING_INDEX

[HNSWVectorStore] HNSW library loaded
[IndexManager] Initializing for model=qwen3-embedding_0_6b_d1024, dim=1024
[ChunkStore] Loaded 29050 chunks from 542 notes      // <-- SUSPECT #1
[HNSWVectorStore] Loaded 22313 chunks, 471 note states  // <-- SUSPECT #2

[InitStateMachine] LOADING_INDEX → WARMING_SERVICES
[SearchPipeline] Ready
[lmstudio] Initialized with model=falcon-h1r-7b
[InitStateMachine] WARMING_SERVICES → READY

// User clicks an action button...
[triggerAgenticAction] {agentType: 'connection', notePath: 'guide.md'}
[ChiefOfStaff] Routing: connection
[Connection Agent] Finding connections for: claude-code-setup-guide
[Connection Agent] Raw LLM output: { "links": [] }
[Connection Agent] Found 0 connection suggestions

// BUT THE UI NEVER UNFREEZES. STUCK.
```

---

## Suspected Problem Areas

I've identified 4 files that may be causing the issue. Full code for each follows.

### Suspect #1: ChunkStore - Sequential File Loading

**File**: `src/services/chunkStore.ts`

The `loadAll()` method loads 542 JSON files. Each file contains chunks for one note.

```typescript
/**
 * Chunk Store
 *
 * Model-agnostic chunk content storage.
 * Stores one JSON file per note in data/chunks/notes/{noteId}.json
 *
 * Separated from VectorStore to allow switching embedding models
 * without re-chunking notes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { NoteChunkFile, StoredChunk } from "../types/indexer";
import { atomicWriteFile } from "../utils/atomicWrite";
import type { StoragePaths } from "./storagePaths";

const CHUNKER_VERSION = "tsi-v2";

/**
 * Manages chunk content storage (model-agnostic).
 * Stores one JSON file per note in data/chunks/notes/{noteId}.json
 */
export class ChunkStore {
  private chunks: Map<string, StoredChunk> = new Map();
  private noteChunks: Map<string, Set<string>> = new Map();

  constructor(private storagePaths: StoragePaths) {}

  /**
   * Load chunks for a specific note from disk
   */
  async loadNoteChunks(noteId: string): Promise<StoredChunk[]> {
    const filePath = this.storagePaths.getChunkPath(noteId);

    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const data: NoteChunkFile = JSON.parse(content);

      // Store in memory
      const chunkIds = new Set<string>();
      for (const chunk of data.chunks) {
        this.chunks.set(chunk.chunkId, chunk);
        chunkIds.add(chunk.chunkId);
      }
      this.noteChunks.set(noteId, chunkIds);

      return data.chunks;
    } catch {
      return [];
    }
  }

  /**
   * Save chunks for a specific note to disk
   */
  async saveNoteChunks(
    noteId: string,
    notePath: string,
    mtimeMs: number,
    contentHash: string,
    chunks: StoredChunk[],
  ): Promise<void> {
    const filePath = this.storagePaths.getChunkPath(noteId);

    const data: NoteChunkFile = {
      noteId,
      path: notePath,
      mtimeMs,
      contentHash,
      chunkerVersion: CHUNKER_VERSION,
      chunks,
    };

    await atomicWriteFile(filePath, JSON.stringify(data, null, 2));

    // Update in-memory state
    const chunkIds = new Set<string>();
    for (const chunk of chunks) {
      this.chunks.set(chunk.chunkId, chunk);
      chunkIds.add(chunk.chunkId);
    }
    this.noteChunks.set(noteId, chunkIds);
  }

  /**
   * Get chunk by ID (from memory)
   */
  getChunk(chunkId: string): StoredChunk | null {
    return this.chunks.get(chunkId) ?? null;
  }

  /**
   * Get all chunks for a note
   */
  getChunksForNote(noteId: string): StoredChunk[] {
    const chunkIds = this.noteChunks.get(noteId);
    if (!chunkIds) return [];

    return Array.from(chunkIds)
      .map((id) => this.chunks.get(id))
      .filter((c): c is StoredChunk => c !== undefined);
  }

  /**
   * Remove chunks for a note from memory and move file to _deleted
   */
  async removeNoteChunks(noteId: string): Promise<void> {
    const chunkIds = this.noteChunks.get(noteId);
    if (chunkIds) {
      for (const id of chunkIds) {
        this.chunks.delete(id);
      }
      this.noteChunks.delete(noteId);
    }

    // Move file to _deleted
    const filePath = this.storagePaths.getChunkPath(noteId);
    const deletedPath = path.join(
      this.storagePaths.tempDeleted,
      `chunk-${noteId}-${Date.now()}.json`,
    );

    try {
      await fs.promises.rename(filePath, deletedPath);
    } catch {
      // File might not exist
    }
  }

  /**
   * Load all chunks from disk (for startup)
   */
  async loadAll(): Promise<void> {
    const notesDir = this.storagePaths.chunksNotes;

    try {
      const files = await fs.promises.readdir(notesDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const noteId = file.replace(".json", "");
          await this.loadNoteChunks(noteId);
        }
      }
      console.log(
        `[ChunkStore] Loaded ${this.chunks.size} chunks from ${this.noteChunks.size} notes`,
      );
    } catch {
      // Directory might not exist yet
      console.log("[ChunkStore] No existing chunks directory");
    }
  }

  /**
   * Get all chunk IDs (for embedding lookup)
   */
  getAllChunkIds(): string[] {
    return Array.from(this.chunks.keys());
  }

  /**
   * Get count of notes with chunks
   */
  getNoteCount(): number {
    return this.noteChunks.size;
  }

  /**
   * Get total chunk count
   */
  getChunkCount(): number {
    return this.chunks.size;
  }

  /**
   * Check if chunks exist for a note
   */
  hasNoteChunks(noteId: string): boolean {
    return this.noteChunks.has(noteId);
  }

  /**
   * Clear all chunks from memory
   */
  clear(): void {
    this.chunks.clear();
    this.noteChunks.clear();
  }
}
```

**Observation**: The `loadAll()` method (lines 133-151) uses `await` inside a `for` loop. This loads files sequentially, not in parallel.

---

### Suspect #2: HNSWVectorStore - WASM Vector Loading

**File**: `src/services/hnswVectorStore.ts` (partial - the critical method)

The `loadFromData()` method loads 22,313 embeddings into a WASM-based HNSW index.

```typescript
  loadFromData(data: {
    meta: {
      modelKey: string;
      dimension: number;
      createdAt: number;
      updatedAt: number;
    };
    docs: Array<{
      chunkId: string;
      noteId: string;
      path: string;
      title: string;
      headingPath: string[];
      tier: ChunkTier;
      kind: ChunkKind;
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
    }>;
    state?: {
      lastFullIndexAt: number | null;
      notes: Record<string, NoteState>;
    };
  }): void {
    this.modelKey = data.meta.modelKey;
    this.dimension = data.meta.dimension;
    this.createdAt = data.meta.createdAt || Date.now();

    // Clear existing data
    this.docs.clear();
    this.chunkIdToLabel.clear();
    this.labelToChunkId.clear();
    this.noteIdToLabels.clear();
    this.embeddings.clear();

    // Ensure index is created
    this.ensureIndex();

    if (!this.index) {
      console.error("[HNSWVectorStore] Index not available for loading");
      return;
    }

    // Prepare vectors and metadata
    const vectors: Float32Array[] = [];
    const docMetadata: Array<{ persisted: (typeof data.docs)[0]; embedding: Float32Array }> = [];

    for (const persisted of data.docs) {
      const embedding = new Float32Array(persisted.embedding);
      vectors.push(embedding);
      docMetadata.push({ persisted, embedding });
    }

    // Batch add to HNSW index - returns assigned labels
    if (vectors.length > 0) {
      let assignedLabels: number[];
      try {
        assignedLabels = this.index.addItems(vectors, false);
      } catch (error) {
        console.error("[HNSWVectorStore] Failed to load index:", error);
        return;
      }

      // Store metadata with assigned labels
      for (let i = 0; i < docMetadata.length; i++) {
        const { persisted, embedding } = docMetadata[i];
        const label = assignedLabels[i];

        const doc: StoredDoc = {
          chunkId: persisted.chunkId,
          noteId: persisted.noteId,
          path: persisted.path,
          title: persisted.title,
          headingPath: persisted.headingPath,
          tier: persisted.tier,
          kind: persisted.kind,
          parentChunkId: persisted.parentChunkId,
          blockRef: persisted.blockRef,
          startLine: persisted.startLine,
          endLine: persisted.endLine,
          tokenEstimate: persisted.tokenEstimate,
          importance: persisted.importance,
          chunkIndex: persisted.chunkIndex,
          text: persisted.text,
          mtimeMs: persisted.mtimeMs,
          contentHash: persisted.contentHash,
          tags: persisted.tags,
          frontmatter: persisted.frontmatter,
        };

        this.docs.set(label, doc);
        this.chunkIdToLabel.set(persisted.chunkId, label);
        this.labelToChunkId.set(label, persisted.chunkId);
        this.embeddings.set(label, embedding);

        // Track noteId -> labels
        if (!this.noteIdToLabels.has(persisted.noteId)) {
          this.noteIdToLabels.set(persisted.noteId, new Set());
        }
        this.noteIdToLabels.get(persisted.noteId)?.add(label);
      }
    }

    // Load state
    this.noteStates.clear();
    this.lastFullIndexAt = null;

    if (data.state) {
      this.lastFullIndexAt = data.state.lastFullIndexAt;
      for (const [notePath, state] of Object.entries(data.state.notes)) {
        this.noteStates.set(notePath, state);
      }
    }

    this.dirty = false;
    console.log(
      `[HNSWVectorStore] Loaded ${this.docs.size} chunks, ${this.noteStates.size} note states`,
    );
  }
```

**Observations**:
1. This method is **synchronous** (`void` return, no `async`)
2. Creates 22,313 `Float32Array` objects in a loop
3. `this.index.addItems(vectors, false)` is a WASM call - likely blocking
4. Stores data in 5 different Maps (22K entries each)

---

### Suspect #3: IndexManager - Orchestrates the Loading

**File**: `src/services/indexManager.ts` (partial - initialization)

```typescript
  async initialize(): Promise<void> {
    const activePath = this.kernel.settings.indexing.activeIndexPath;

    // Determine if this is a user-provided external index (read-only)
    this.isUserProvidedIndex = activePath
      ? activePath.includes("system/index") || activePath.includes("system\\index")
      : false;

    // Get model info from Ollama first (we need this for discovery)
    const ollama = this.kernel.getService<{
      getModelKey(): string;
      getDimension(): Promise<number>;
    }>("ollama");

    if (!ollama) {
      throw new Error("Ollama service not available");
    }

    this.modelKey = ollama.getModelKey();
    this.dimension = await ollama.getDimension();

    console.log(`[IndexManager] Initializing for model=${this.modelKey}, dim=${this.dimension}`);

    // Set model config on VectorStore
    this.vectorStore.setModelConfig?.(this.modelKey, this.dimension);

    // Phase 2: Check for new structure and load chunks
    this.useNewStructure = this.kernel.storagePaths.hasNewStructure();
    if (this.useNewStructure) {
      console.log("[IndexManager] Loading chunks from new structure...");
      await this.chunkStore.loadAll();  // <-- CALLS SUSPECT #1
    }

    // ... discovery logic ...

    // Load index
    if (activePath) {
      console.log(`[IndexManager] Loading from settings path: ${activePath}`);
      this.activeIndexPath = activePath;
      await this.loadIndexFromPath(activePath);  // <-- CALLS loadFromData (SUSPECT #2)
    } else {
      const discovered = await this.discoverBestIndex();
      if (discovered) {
        console.log(`[IndexManager] Discovered existing index: ${discovered}`);
        this.activeIndexPath = discovered;
        await this.loadIndexFromPath(discovered);  // <-- CALLS loadFromData (SUSPECT #2)
      }
    }

    // ... rest of initialization ...
  }

  private async loadIndexFromPath(indexPath: string): Promise<boolean> {
    console.log(`[IndexManager] Loading index from: ${indexPath}`);

    try {
      await this.vectorStore.waitForReady?.();

      const exists = await fs.promises.access(indexPath).then(() => true).catch(() => false);
      if (!exists) {
        console.log(`[IndexManager] Index file not found: ${indexPath}`);
        return false;
      }

      const raw = await fs.promises.readFile(indexPath, "utf-8");  // Reads ~316MB JSON
      const data = JSON.parse(raw);  // Parses ~316MB JSON

      // ... validation ...

      // Load into VectorStore - THIS IS THE SYNCHRONOUS CALL
      this.vectorStore.loadFromData?.({
        meta: { ... },
        docs: data.docs,  // 22,313 documents
        state: state,
      });

      return true;
    } catch (error) {
      console.error("[IndexManager] Failed to load index:", error);
      return false;
    }
  }
```

**Observations**:
1. `loadIndexFromPath` reads a 316MB JSON file
2. `JSON.parse()` on 316MB is expensive
3. Then calls `loadFromData()` which is synchronous
4. No yielding to event loop anywhere in this chain

---

### Suspect #4: useAppEvents - Signal Update Cascade

**File**: `src/ui/sidebar/hooks/useAppEvents.ts`

```typescript
/**
 * useAppEvents - Centralized EventBus subscriptions for App
 *
 * Extracts all EventBus event handling from App.tsx into a single hook.
 * Updates the centralized signals in response to system events.
 */

import { Notice } from "obsidian";
import type { ChatService } from "../../../core/chat";
import { UI_LIMITS } from "../../../core/constants";
import type { Insight } from "../../../services/insightGenerator";
import type { AgentResultData } from "../components/AgentStreamsView";
import { useEventBus } from "../context/KernelContext";
import {
  activeAgents,
  activeView,
  agentInsights,
  agentStatus,
  indexStatus,
  initContext,
  initState,
  isServicesReady,
  pendingActions,
  providerStatus,
  recentActivity,
} from "../state";
import { ACTION_LABELS } from "../state/appHandlers";

interface UseAppEventsOptions {
  chatService: ChatService | null;
  createChatService: () => ChatService | null;
}

/**
 * Subscribe to all system events and update sidebar state accordingly.
 * Call this once in the root App component.
 */
export function useAppEvents({ chatService, createChatService }: UseAppEventsOptions): void {
  // Services initialization
  useEventBus("services:initialized", () => {
    isServicesReady.value = true;
    if (!chatService) {
      createChatService();
    }
  });

  // Initialization state machine changes
  useEventBus("init:state-changed", (data) => {
    initState.value = data.currentState;
    initContext.value = data.context;
    const isOperational = data.currentState === "READY" || data.currentState === "DEGRADED";
    isServicesReady.value = isOperational;
  });

  // Provider health events
  useEventBus("health:changed", (data) => {
    const isHealthy = data.health.status === "healthy";
    const modelName = (data.health.details?.model as string) || null;

    if (data.service === "lmstudio") {
      providerStatus.value = {
        ...providerStatus.value,
        lmstudio: { connected: isHealthy, model: modelName },
      };
      if (isHealthy && !chatService) {
        createChatService();
      }
    } else if (data.service === "ollama") {
      providerStatus.value = {
        ...providerStatus.value,
        ollama: { connected: isHealthy, model: modelName },
      };
    }
  });

  // Index events
  useEventBus("index:progress", (data) => {
    const progress = data.progress;
    indexStatus.value = {
      ...indexStatus.value,
      isIndexing: true,
      indexingProgress:
        progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0,
    };
  });

  useEventBus("index:complete", (data) => {
    indexStatus.value = {
      ...indexStatus.value,
      noteCount: data.totalIndexed,
      isIndexing: false,
      lastSyncedAt: new Date(),
    };
  });

  // Workflow events
  useEventBus("workflow:started", (data) => {
    const workflow = data.workflow;
    agentStatus.value = {
      ...agentStatus.value,
      runningCount: agentStatus.value.runningCount + 1,
    };
    activeAgents.value = [
      ...activeAgents.value,
      {
        id: workflow.id,
        type: workflow.spec.command || "workflow",
        targetNote: workflow.spec.targets[0] || "vault",
        status: "running",
        progress: 0,
        startedAt: workflow.startedAt ? new Date(workflow.startedAt) : new Date(),
      },
    ];
  });

  useEventBus("workflow:progress", (data) => {
    const workflow = data.workflow;
    activeAgents.value = activeAgents.value.map((agent) =>
      agent.id === workflow.id
        ? {
            ...agent,
            progress:
              workflow.progress.total > 0
                ? Math.round((workflow.progress.completed / workflow.progress.total) * 100)
                : 0,
          }
        : agent,
    );
  });

  useEventBus("workflow:completed", (data) => {
    const workflow = data.workflow;
    const agent = activeAgents.value.find((a) => a.id === workflow.id);
    agentStatus.value = {
      ...agentStatus.value,
      runningCount: Math.max(0, agentStatus.value.runningCount - 1),
    };
    activeAgents.value = activeAgents.value.filter((a) => a.id !== workflow.id);
    if (agent) {
      recentActivity.value = [
        {
          id: `activity-${Date.now()}`,
          status: "success",
          actionType: "workflow",
          targetNote: agent.targetNote,
          summary: `${agent.type} completed`,
          completedAt: new Date(),
          canUndo: false,
        },
        ...recentActivity.value.slice(0, UI_LIMITS.MAX_RECENT_ACTIVITY_COUNT),
      ];
    }
  });

  useEventBus("workflow:failed", (data) => {
    const workflow = data.workflow;
    const agent = activeAgents.value.find((a) => a.id === workflow.id);
    agentStatus.value = {
      ...agentStatus.value,
      runningCount: Math.max(0, agentStatus.value.runningCount - 1),
    };
    activeAgents.value = activeAgents.value.filter((a) => a.id !== workflow.id);
    if (agent) {
      recentActivity.value = [
        {
          id: `activity-${Date.now()}`,
          status: "failed",
          actionType: "workflow",
          targetNote: agent.targetNote,
          summary: `${agent.type} failed`,
          completedAt: new Date(),
          canUndo: false,
          error: data.error,
        },
        ...recentActivity.value.slice(0, UI_LIMITS.MAX_RECENT_ACTIVITY_COUNT),
      ];
    }
  });

  useEventBus("workflow:cancelled", (data) => {
    const workflow = data.workflow;
    agentStatus.value = {
      ...agentStatus.value,
      runningCount: Math.max(0, agentStatus.value.runningCount - 1),
    };
    activeAgents.value = activeAgents.value.filter((a) => a.id !== workflow.id);
  });

  // Action events
  useEventBus("action:proposed", (data) => {
    const action = data.action;
    agentStatus.value = {
      ...agentStatus.value,
      pendingReviewCount: agentStatus.value.pendingReviewCount + 1,
    };
    pendingActions.value = [
      ...pendingActions.value,
      {
        id: action.id,
        actionType: action.type,
        targetNote: data.noteContext.title || action.target,
        summary: action.title,
        riskLevel: action.risk,
      },
    ];
  });

  useEventBus("action:applied", (data) => {
    const record = data.record;
    agentStatus.value = {
      ...agentStatus.value,
      pendingReviewCount: Math.max(0, agentStatus.value.pendingReviewCount - 1),
    };
    pendingActions.value = pendingActions.value.filter((a) => a.id !== record.action.id);
    recentActivity.value = [
      {
        id: record.id,
        status: "success",
        actionType: record.action.type,
        targetNote: record.action.target.split("/").pop() || record.action.target,
        summary: record.action.title,
        completedAt: new Date(record.timestamp),
        canUndo: true,
      },
      ...recentActivity.value.slice(0, UI_LIMITS.MAX_RECENT_ACTIVITY_COUNT),
    ];
  });

  useEventBus("action:undone", (data) => {
    recentActivity.value = recentActivity.value.map((a) =>
      a.id === data.recordId ? { ...a, status: "undone" as const, canUndo: false } : a,
    );
  });

  // Agent task updates - dispatch to handlers
  useEventBus("agent:task-update", (data) => {
    const task = data.task;
    if (!task.taskType || task.taskType === "chat") return;

    switch (task.status) {
      case "running":
        handleTaskRunning(task);
        break;
      case "completed":
        handleTaskCompleted(task);
        break;
      case "failed":
        handleTaskFailed(task);
        break;
      case "cancelled":
        handleTaskCancelled(task);
        break;
      case "queued":
        handleTaskQueued(task);
        break;
    }
  });
}

// ... handler functions follow (handleTaskRunning, handleTaskCompleted, etc.)
// Each handler updates signals like:
//   activeAgents.value = activeAgents.value.map(...);  // Creates new array
//   agentStatus.value = { ...agentStatus.value, ... }; // Creates new object
```

**Observations**:
1. Subscribes to 14+ different events
2. Every handler creates new objects/arrays via spread operator
3. Preact signals trigger re-renders on every `.value` assignment
4. During initialization, events may fire rapidly

---

## The Initialization Call Chain

```
main.ts: onload()
  └── setTimeout(initializeServicesAsync, 1000)
        │
        ├── [Phase 1: CHECKING_PROVIDERS]
        │   ├── OllamaService.initialize()     // HTTP call to remote server
        │   ├── OllamaRerankerService.initialize()
        │   └── LMStudioService.initialize()   // HTTP call to localhost
        │
        ├── [Phase 2: LOADING_INDEX]
        │   ├── HNSWVectorStore.initialize()   // Loads WASM module
        │   └── IndexManager.initialize()      // THE PROBLEM AREA
        │         ├── chunkStore.loadAll()     // 542 sequential file reads
        │         │     └── for each file: await loadNoteChunks()
        │         └── loadIndexFromPath()
        │               ├── fs.readFile (316MB)
        │               ├── JSON.parse (316MB)
        │               └── vectorStore.loadFromData()  // SYNCHRONOUS
        │                     ├── 22K Float32Array allocations
        │                     ├── WASM addItems() call
        │                     └── 22K entries into 5 Maps
        │
        └── [Phase 3: WARMING_SERVICES]
            ├── SearchPipeline.initialize()
            └── ... other services
```

**Key insight**: The entire `IndexManager.initialize()` blocks the main thread. No `await new Promise(resolve => setTimeout(resolve, 0))` to yield. No chunked processing. No Web Workers.

---

## Questions for You

1. **Root Cause**: Which of these 4 suspects is the primary cause of the freeze? Or is it the combination?

2. **Theory**:
   - Is this a classic "blocking the event loop" problem?
   - Could there be memory pressure issues with 29K + 22K objects?
   - Is the WASM `addItems()` call synchronous and blocking?
   - Could the Preact signal updates be causing render thrashing?

3. **Validation**: How would you instrument or test to confirm which operation is the bottleneck?
   - Add timing logs?
   - Use Chrome DevTools Performance tab?
   - Add `setTimeout(0)` yields to see if UI becomes responsive?

4. **Fix Strategy** (high-level, not code):
   - Should we move heavy operations to a Web Worker?
   - Should we chunk the loading into batches with yields?
   - Should we lazy-load (load on demand, not at startup)?
   - Should we debounce/batch the signal updates?

---

## Constraints

- **Must remain an Obsidian plugin** - can't move to separate process
- **WASM library (hnswlib-wasm)** - third-party, limited control
- **Preact signals** - committed to this state management
- **Large vault support** - must handle 1000+ notes eventually

Please provide your analysis. I will implement fixes using our own development workflow.
