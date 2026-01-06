# Task: Simplify and Redesign Notient's Vector Indexing System

## Project Context

**Notient** is an Obsidian plugin for AI-powered vault management using local LLMs.

- **Location:** `/home/akougkas/projects/notient`
- **Build:** `./dev.sh --reset` (uses Bun)
- **Environment:** WSL2 → Windows Obsidian

### Infrastructure

| Service | Host | Model | Purpose |
|---------|------|-------|---------|
| Ollama | `http://192.168.86.249:11434` | Various embedding models | Embeddings (384-4096 dims) |
| LM Studio | `http://192.168.86.249:1234/v1` | `ministral-3-14b` | Reasoning |
| Test Vault | ~930 markdown notes | Typical Obsidian vault | Test data |

---

## The Problem: Overengineered Complexity

The current indexing system grew organically and is now overly complex:

1. **Orama is overkill** — Full-text search engine with complex schema, JSON serialization overhead, buffer overflow on persistence (~16MB limit with seqproto)
2. **Chunking is fragile** — Edge cases cause excessive iterations, overlap logic is convoluted, required safety guards to prevent infinite loops
3. **Pipeline has too many layers** — JobQueue → IndexPipeline → Chunker → Ollama → Orama → Persistence
4. **No proper incremental indexing** — Full reindex is the default path, state tracking exists but isn't leveraged efficiently
5. **Single model assumption** — No clean way to manage indices from different embedding models/dimensions

### Current Files (Review Before Refactoring)

```
src/
├── core/
│   ├── indexer/
│   │   ├── pipeline.ts      # Main orchestration (complex, many responsibilities)
│   │   ├── chunker.ts       # Text splitting (has edge case bugs, over-engineered)
│   │   └── indexState.ts    # State tracking (good concept, under-utilized)
│   └── queue/
│       └── jobQueue.ts      # Job processing (overkill for this use case)
├── services/
│   ├── orama.ts             # Vector store (REPLACE - too heavy)
│   ├── vectorStore.ts       # Interface (KEEP - good abstraction)
│   └── ollama.ts            # Embeddings client (KEEP - works well)
└── types/
    ├── indexer.ts           # Type definitions
    └── search.ts            # Search types
```

---

## What We Actually Need

For a vault of 1000-5000 markdown notes (mostly 100-2000 chars each):

1. **Structure-preserving chunking** — Keep frontmatter with content, respect headings
2. **Simple in-memory vector search** — Fast similarity lookup
3. **Disk persistence** — Load quickly on startup, save incrementally
4. **Incremental updates** — Only re-embed changed/new notes
5. **Multi-model support** — Different indices for different embedding models/dimensions
6. **Non-blocking UI** — Background indexing that yields to Obsidian

---

## Proposed Solution: VectorDB.js

Replace Orama with [VectorDB.js](https://vectordbjs.themaximalist.com/) ([GitHub](https://github.com/themaximalist/vectordb.js)):

### Why VectorDB.js?

- **Pure JS** — Uses hnswlib-node for vector search, no complex native dependencies
- **Simple API** — `add(text, metadata)`, `search(query, k, threshold)`
- **In-memory with persistence** — Fast operations, easy save/load
- **Configurable dimensions** — Works with any embedding model
- **Lightweight** — MIT licensed, minimal footprint
- **Auto-resizing** — Handles growth automatically

### Basic Usage

```javascript
import VectorDB from "@themaximalist/vectordb.js"

// Create DB with specific dimensions (match your embedding model)
const db = new VectorDB({ dimensions: 1024 });

// Add documents with metadata
await db.add("note content here", { 
  path: "notes/foo.md", 
  hash: "abc123",
  title: "My Note"
});

// Search returns sorted by distance (lower = more similar)
const results = await db.search("query text", 10, 0.5);
// [{ input: "...", distance: 0.23, object: { path, hash, title } }]
```

### Key Difference from Orama

| Aspect | Orama | VectorDB.js |
|--------|-------|-------------|
| Primary use | Full-text + vector search engine | Pure vector similarity |
| Schema | Complex typed schema | Simple key-value metadata |
| Persistence | seqproto/JSON (size limits) | JSON or custom |
| Dependencies | Heavy | Minimal |
| Learning curve | Steep | Minimal |

---

## Architecture Redesign

### 1. Simple Note Chunker (`src/core/chunker.ts`)

```typescript
interface NoteChunk {
  id: string;           // Hash of path + content
  path: string;         // Note path in vault
  title: string;        // Extracted title
  section: string;      // Section heading (if any)
  content: string;      // Text to embed
  metadata: {
    frontmatter: Record<string, unknown>;
    tags: string[];
    mtime: number;
  };
}

function chunkNote(path: string, content: string, mtime: number): NoteChunk[] {
  // Rules:
  // 1. Frontmatter + title = always first chunk (context chunk)
  // 2. Each H1/H2 section = separate chunk  
  // 3. Long sections (>1500 chars) split at paragraph boundaries
  // 4. Small notes (<500 chars) = single chunk
  // 5. Preserve metadata on all chunks for filtering
}
```

### 2. Index Manager (`src/services/indexManager.ts`)

```typescript
interface IndexManager {
  // State tracking
  getNoteState(path: string): NoteState | null;
  setNoteState(path: string, state: NoteState): void;
  
  // Vector operations (delegates to VectorDB)
  addChunks(chunks: EmbeddedChunk[]): Promise<void>;
  removeNote(path: string): Promise<void>;
  search(embedding: number[], options: SearchOptions): Promise<SearchResult[]>;
  
  // Persistence
  save(): Promise<void>;
  load(): Promise<void>;
  
  // Multi-model support
  getActiveModelKey(): string;
  switchModel(modelKey: string): Promise<void>;
  listAvailableIndices(): string[];
}

interface NoteState {
  path: string;
  mtime: number;
  contentHash: string;
  chunkIds: string[];
  embeddedAt: number;
}
```

### 3. Simplified Pipeline (`src/core/indexer.ts`)

```typescript
class Indexer {
  // Single entry point for indexing
  async syncVault(): Promise<IndexResult> {
    const vaultNotes = await this.scanVault();
    const changes = this.diffWithState(vaultNotes);
    
    // Process in batches, yielding to UI
    for (const batch of this.batchChanges(changes, 20)) {
      await this.processBatch(batch);
      await this.yieldToUI();
    }
    
    await this.indexManager.save();
    return { added, updated, removed, errors };
  }
  
  // Incremental update for single note
  async updateNote(path: string): Promise<void> {
    const content = await this.readNote(path);
    const chunks = chunkNote(path, content, Date.now());
    const embedded = await this.embedChunks(chunks);
    await this.indexManager.removeNote(path);
    await this.indexManager.addChunks(embedded);
  }
}
```

### 4. Storage Layout

```
.obsidian/plugins/notient/
├── indices/
│   ├── qwen3-embedding_0.6b_d1024.json      # VectorDB serialized
│   ├── qwen3-embedding_0.6b_d1024.state.json # Note states
│   ├── nomic-embed-text_d768.json           # Another model's index
│   └── nomic-embed-text_d768.state.json
└── settings.json                             # Plugin settings
```

---

## Implementation Plan

### Phase 1: Replace Vector Store (Day 1)

1. Install VectorDB.js: `bun add @themaximalist/vectordb.js`
2. Create new `src/services/vectorDb.ts` — thin wrapper
3. Implement `IndexManager` with state tracking
4. Add JSON persistence (simple, portable)
5. Test with existing chunker

### Phase 2: Simplify Chunking (Day 1-2)

1. Rewrite `chunker.ts` with clear rules:
   - Parse frontmatter separately
   - Split by headings (H1/H2)
   - Max chunk size with paragraph breaks
   - Generate stable chunk IDs
2. Remove overlap logic entirely (not needed for notes)
3. Add unit tests for edge cases

### Phase 3: Streamline Pipeline (Day 2)

1. Merge `pipeline.ts` + `indexState.ts` → `indexer.ts`
2. Remove `jobQueue.ts` — use simple async batching
3. Implement efficient diff algorithm
4. Add progress events for UI

### Phase 4: Multi-Model Support (Day 3)

1. Detect existing indices on startup
2. Handle model switching gracefully
3. Offer migration path when model changes
4. Benchmark different dimensions

### Phase 5: Cleanup (Day 3)

1. Remove Orama and related code
2. Remove unused debug instrumentation
3. Update types and interfaces
4. Update settings UI for new options

---

## Benchmarking Plan

Test with different configurations:

| Model | Dimensions | Notes | Expected Index Time | Search Quality |
|-------|------------|-------|---------------------|----------------|
| all-MiniLM-L6-v2 | 384 | 1000 | ~2 min | Good |
| nomic-embed-text | 768 | 1000 | ~3 min | Better |
| qwen3-embedding:0.6b | 1024 | 1000 | ~4 min | Best |
| mxbai-embed-large | 1024 | 1000 | ~4 min | Best |

Metrics to capture:
- Index build time (full)
- Index load time (from disk)
- Incremental update time (single note)
- Search latency (p50, p99)
- Memory usage
- Disk size

---

## Constraints & Requirements

1. **UI must never freeze** — Yield every 10-20 notes, not every operation
2. **Scale to 5000+ notes** — Must handle large vaults
3. **Support 384 to 4096 dimensions** — User choice based on model
4. **Incremental by default** — Full reindex only on explicit user request
5. **Obsidian compatibility** — Use their file APIs, works in Electron
6. **Portable data** — JSON persistence, easy backup/restore

---

## Success Criteria

1. ✅ Index 1000 notes in < 5 minutes
2. ✅ UI stays responsive throughout indexing
3. ✅ Search returns relevant results in < 100ms
4. ✅ Startup with existing index < 2 seconds
5. ✅ Incremental update for single note < 1 second
6. ✅ Clean codebase with < 500 lines for indexing logic

---

## Files to Delete After Refactor

```
src/services/orama.ts           # Replaced by vectorDb.ts
src/core/queue/jobQueue.ts      # Complexity not needed
src/types/queue.ts              # Queue types no longer needed
```

---

## Notes for Implementation

- **Chunk size should adapt** — Small notes (< 500 chars) = single chunk
- **Frontmatter is metadata, not content** — Store as object, don't embed as text
- **Tags should be filterable** — Store in metadata for search filtering
- **Hash stability matters** — Same content = same chunk ID (for deduplication)
- **VectorDB auto-resizes** — Don't worry about initial size
- **Consider lazy embedding** — Don't embed until first search?

---

## Reference: VectorDB.js API

```javascript
// Initialize
const db = new VectorDB({
  dimensions: 1024,  // Must match embedding model
  size: 100,         // Initial size (auto-grows)
});

// Add with metadata
await db.add("text to embed", { any: "metadata" });

// Search
const results = await db.search("query", numResults, maxDistance);
// Returns: [{ input, distance, object }]

// Resize (automatic, but can be manual)
db.resize(newSize);
```

---

## Start Here

1. Read current `src/services/orama.ts` to understand the interface
2. Read `src/core/indexer/pipeline.ts` to understand the flow
3. Sketch the new `IndexManager` interface
4. Implement VectorDB.js wrapper
5. Migrate one piece at a time, testing as you go
