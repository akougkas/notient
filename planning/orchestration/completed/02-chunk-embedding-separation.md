# Phase 2: Chunk/Embedding Separation

## Objective

Separate model-agnostic chunk content from model-specific embeddings. This enables:
- Model switching without re-chunking
- Background embedding loading (faster startup)
- Chunk structure preserved across model changes

## Prerequisites

- Phase 1 completed (storage paths updated)
- Read `/.claude/CLAUDE.md` for TSI v2 architecture
- Read `00-storage-restructure-overview.md` for context

## Files to Modify

1. `src/types/indexer.ts` - Add chunk-only types
2. `src/services/simpleVectorStore.ts` - Split storage logic
3. `src/services/indexManager.ts` - Manage separate files
4. `src/core/indexer/simpleIndexer.ts` - Write chunks and embeddings separately

## Current Architecture

Currently, everything is in one file (`idx_*.json`):
```json
{
  "meta": { "modelKey": "...", "dimension": 384, ... },
  "docs": [
    {
      "chunkId": "...",
      "text": "...",           // Chunk content
      "embedding": [0.1, ...], // Model-specific
      "noteId": "...",
      "tier": "note",
      ...
    }
  ]
}
```

## Target Architecture

### Chunk File (`data/chunks/notes/{noteId}.json`)

```json
{
  "noteId": "abc123",
  "path": "projects/auth/setup.md",
  "mtimeMs": 1704700000000,
  "contentHash": "def456...",
  "chunkerVersion": "tsi-v2",
  "chunks": [
    {
      "chunkId": "abc123-note-xyz",
      "tier": "note",
      "kind": "note",
      "parentChunkId": null,
      "headingPath": [],
      "text": "# JWT Setup Guide\n...",
      "blockRef": null,
      "startLine": null,
      "endLine": null,
      "tokenEstimate": 456,
      "tags": ["auth", "security"],
      "frontmatter": { "title": "JWT Setup Guide" }
    },
    { "chunkId": "abc123-section-...", ... },
    { "chunkId": "abc123-block-...", ... }
  ]
}
```

### Chunks Meta (`data/chunks/meta.json`)

```json
{
  "version": 1,
  "chunkerVersion": "tsi-v2",
  "noteCount": 102,
  "chunkCount": 1547,
  "lastUpdated": 1704705600000
}
```

### Embedding Index (`data/embeddings/active/{model}-{dim}d.json`)

```json
{
  "meta": {
    "version": 1,
    "modelKey": "qwen3-embedding",
    "dimension": 1024,
    "chunkCount": 1547,
    "createdAt": 1704700000000,
    "updatedAt": 1704705600000
  },
  "embeddings": {
    "abc123-note-xyz": [0.123, -0.456, ...],
    "abc123-section-...": [0.234, -0.567, ...],
    ...
  },
  "state": {
    "lastFullIndexAt": 1704700000000,
    "notes": {
      "projects/auth/setup.md": {
        "noteId": "abc123",
        "embeddedAt": 1704700600000
      }
    }
  }
}
```

## Implementation Steps

### Step 1: Add New Types (`types/indexer.ts`)

Add these interfaces:

```typescript
/**
 * Chunk content without embedding (model-agnostic)
 */
export interface StoredChunk {
  chunkId: string;
  noteId: string;
  path: string;
  tier: ChunkTier;
  kind: ChunkKind;
  parentChunkId: string | null;
  headingPath: string[];
  text: string;
  blockRef: string | null;
  startLine: number | null;
  endLine: number | null;
  tokenEstimate: number;
  tags: string[];
  frontmatter: Record<string, unknown>;
}

/**
 * Per-note chunk file structure
 */
export interface NoteChunkFile {
  noteId: string;
  path: string;
  mtimeMs: number;
  contentHash: string;
  chunkerVersion: string;
  chunks: StoredChunk[];
}

/**
 * Chunks meta file structure
 */
export interface ChunksMeta {
  version: number;
  chunkerVersion: string;
  noteCount: number;
  chunkCount: number;
  lastUpdated: number;
}

/**
 * Embedding index structure (model-specific)
 */
export interface EmbeddingIndex {
  meta: {
    version: number;
    modelKey: string;
    dimension: number;
    chunkCount: number;
    createdAt: number;
    updatedAt: number;
  };
  embeddings: Record<string, number[]>;  // chunkId -> vector
  state: {
    lastFullIndexAt: number | null;
    notes: Record<string, { noteId: string; embeddedAt: number }>;
  };
}
```

### Step 2: Create ChunkStore Class

Add a new class to `simpleVectorStore.ts` OR create `src/services/chunkStore.ts` (prefer extending existing file):

```typescript
/**
 * Manages chunk content storage (model-agnostic)
 */
export class ChunkStore {
  private chunks: Map<string, StoredChunk> = new Map();
  private noteChunks: Map<string, Set<string>> = new Map();  // noteId -> chunkIds
  private dirty: Set<string> = new Set();  // noteIds with unsaved changes

  constructor(private storagePaths: StoragePaths) {}

  /**
   * Load chunks for a specific note
   */
  async loadNoteChunks(noteId: string): Promise<StoredChunk[]> {
    const filePath = this.storagePaths.getChunkPath(noteId);

    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
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
   * Save chunks for a specific note
   */
  async saveNoteChunks(noteId: string, path: string, mtimeMs: number, contentHash: string, chunks: StoredChunk[]): Promise<void> {
    const filePath = this.storagePaths.getChunkPath(noteId);

    const data: NoteChunkFile = {
      noteId,
      path,
      mtimeMs,
      contentHash,
      chunkerVersion: 'tsi-v2',
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
    this.dirty.delete(noteId);
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
      .map(id => this.chunks.get(id))
      .filter((c): c is StoredChunk => c !== undefined);
  }

  /**
   * Remove chunks for a note
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
      `chunk-${noteId}-${Date.now()}.json`
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
        if (file.endsWith('.json')) {
          const noteId = file.replace('.json', '');
          await this.loadNoteChunks(noteId);
        }
      }
    } catch {
      // Directory might not exist yet
    }
  }

  /**
   * Get all chunk IDs (for embedding lookup)
   */
  getAllChunkIds(): string[] {
    return Array.from(this.chunks.keys());
  }
}
```

### Step 3: Modify SimpleVectorStore

Update `simpleVectorStore.ts` to:
1. Store only embeddings (not full chunk content)
2. Reference ChunkStore for chunk content during search
3. Load embeddings from new location

Key changes:

```typescript
export class SimpleVectorStore implements VectorStore {
  // Change: embeddings only, no full docs
  private embeddings: Map<string, Float32Array> = new Map();
  private chunkStore: ChunkStore;  // Reference to chunk content

  constructor(
    private storagePaths: StoragePaths,
    chunkStore: ChunkStore
  ) {
    this.chunkStore = chunkStore;
  }

  /**
   * Load embeddings from model-specific file
   */
  async loadEmbeddings(modelKey: string, dimension: number): Promise<boolean> {
    const indexPath = this.storagePaths.getEmbeddingIndexPath(modelKey, dimension);

    try {
      const content = await fs.promises.readFile(indexPath, 'utf-8');
      const data: EmbeddingIndex = JSON.parse(content);

      // Validate
      if (data.meta.modelKey !== modelKey || data.meta.dimension !== dimension) {
        return false;
      }

      // Load embeddings
      for (const [chunkId, vector] of Object.entries(data.embeddings)) {
        this.embeddings.set(chunkId, new Float32Array(vector));
      }

      // Load state
      this.state = data.state;

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save embeddings to model-specific file
   */
  async saveEmbeddings(modelKey: string, dimension: number): Promise<void> {
    const indexPath = this.storagePaths.getEmbeddingIndexPath(modelKey, dimension);

    const data: EmbeddingIndex = {
      meta: {
        version: 1,
        modelKey,
        dimension,
        chunkCount: this.embeddings.size,
        createdAt: this.createdAt,
        updatedAt: Date.now(),
      },
      embeddings: Object.fromEntries(
        Array.from(this.embeddings.entries())
          .map(([id, vec]) => [id, Array.from(vec)])
      ),
      state: this.state,
    };

    await atomicWriteFile(indexPath, JSON.stringify(data));
  }

  /**
   * Search - now looks up chunk content from ChunkStore
   */
  async search(queryEmbedding: number[], options: SearchOptions): Promise<ChunkSearchResult[]> {
    const results: ChunkSearchResult[] = [];

    for (const [chunkId, embedding] of this.embeddings) {
      // Get chunk content from ChunkStore
      const chunk = this.chunkStore.getChunk(chunkId);
      if (!chunk) continue;

      // Apply pre-filters
      if (options.tier && !matchesTier(chunk.tier, options.tier)) continue;
      if (options.noteIds && !options.noteIds.includes(chunk.noteId)) continue;

      // Calculate similarity
      const score = cosineSimilarity(queryEmbedding, embedding);

      // Apply lexical boost if query text provided
      // ... existing boost logic using chunk.text ...

      results.push({
        chunkId,
        noteId: chunk.noteId,
        path: chunk.path,
        tier: chunk.tier,
        kind: chunk.kind,
        title: extractTitle(chunk),
        text: chunk.text,
        score,
        // ...
      });
    }

    // Sort and filter
    return results
      .filter(r => r.score >= options.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, options.topK);
  }

  /**
   * Add embeddings for chunks (chunks already saved by ChunkStore)
   */
  async addEmbeddings(chunkEmbeddings: Array<{ chunkId: string; embedding: number[] }>): Promise<void> {
    for (const { chunkId, embedding } of chunkEmbeddings) {
      this.embeddings.set(chunkId, new Float32Array(embedding));
    }
    this.dirty = true;
  }

  /**
   * Remove embeddings for a note
   */
  async removeNoteEmbeddings(noteId: string): Promise<void> {
    const chunks = this.chunkStore.getChunksForNote(noteId);
    for (const chunk of chunks) {
      this.embeddings.delete(chunk.chunkId);
    }
    this.dirty = true;
  }
}
```

### Step 4: Update IndexManager

Modify `indexManager.ts` to coordinate ChunkStore and VectorStore:

```typescript
export class IndexManager {
  private chunkStore: ChunkStore;
  private vectorStore: SimpleVectorStore;

  constructor(kernel: Kernel) {
    this.chunkStore = new ChunkStore(kernel.storagePaths);
    this.vectorStore = new SimpleVectorStore(kernel.storagePaths, this.chunkStore);
  }

  async initialize(): Promise<void> {
    // 1. Load chunks first (fast, model-agnostic)
    await this.chunkStore.loadAll();

    // 2. Get current model info
    const modelKey = this.ollama.getModelKey();
    const dimension = await this.ollama.getDimension();

    // 3. Load embeddings (may fail if model changed)
    const loaded = await this.vectorStore.loadEmbeddings(modelKey, dimension);

    if (!loaded) {
      // Model changed or no embeddings - need to rebuild
      console.log('[IndexManager] Embeddings not found for current model, rebuild required');
      // Emit event for UI to show rebuild prompt
      this.kernel.eventBus.emit('index:rebuild-required', { modelKey, dimension });
    }
  }

  /**
   * Index a note (called by SimpleIndexer)
   */
  async indexNote(
    noteId: string,
    path: string,
    mtimeMs: number,
    contentHash: string,
    chunks: NoteChunk[],
    embeddings: Array<{ chunkId: string; embedding: number[] }>
  ): Promise<void> {
    // 1. Save chunks (model-agnostic)
    const storedChunks = chunks.map(c => this.toStoredChunk(c));
    await this.chunkStore.saveNoteChunks(noteId, path, mtimeMs, contentHash, storedChunks);

    // 2. Save embeddings (model-specific)
    await this.vectorStore.addEmbeddings(embeddings);
  }

  /**
   * Remove a note from index
   */
  async removeNote(path: string, noteId: string): Promise<void> {
    // 1. Remove embeddings first
    await this.vectorStore.removeNoteEmbeddings(noteId);

    // 2. Remove chunks (moves to _deleted)
    await this.chunkStore.removeNoteChunks(noteId);
  }

  private toStoredChunk(chunk: NoteChunk): StoredChunk {
    return {
      chunkId: chunk.id,
      noteId: chunk.noteId,
      path: chunk.path,
      tier: chunk.tier,
      kind: chunk.kind,
      parentChunkId: chunk.parentChunkId,
      headingPath: chunk.headingPath,
      text: chunk.text,
      blockRef: chunk.blockRef,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      tokenEstimate: chunk.tokenEstimate,
      tags: chunk.tags,
      frontmatter: chunk.frontmatter,
    };
  }
}
```

### Step 5: Update SimpleIndexer

Modify `simpleIndexer.ts` to pass both chunks and embeddings to IndexManager:

```typescript
// In processBatch() or similar:

// 1. Chunk the note (existing logic)
const chunks = chunkNoteTiered(path, content, mtimeMs, metadata, options);

// 2. Embed the chunks (existing logic)
const embeddings = await this.embedChunks(chunks);

// 3. Save both via IndexManager (NEW)
await this.indexManager.indexNote(
  noteId,
  path,
  mtimeMs,
  contentHash,
  chunks,
  embeddings.map(e => ({ chunkId: e.chunkId, embedding: e.embedding }))
);
```

### Step 6: Migration Logic

Add migration in `IndexManager.initialize()`:

```typescript
async initialize(): Promise<void> {
  // Check for legacy index
  if (await this.hasLegacyIndex() && !this.storagePaths.hasNewStructure()) {
    console.log('[IndexManager] Migrating legacy index to new structure...');
    await this.migrateLegacyIndex();
  }

  // ... rest of initialization
}

private async hasLegacyIndex(): Promise<boolean> {
  const pluginRoot = this.kernel.storagePaths.pluginRoot;
  const files = await fs.promises.readdir(pluginRoot);
  return files.some(f => f.startsWith('idx_') && f.endsWith('.json'));
}

private async migrateLegacyIndex(): Promise<void> {
  // 1. Find legacy index file
  const legacyPath = await this.findLegacyIndex();
  if (!legacyPath) return;

  // 2. Read legacy data
  const content = await fs.promises.readFile(legacyPath, 'utf-8');
  const legacy = JSON.parse(content);

  // 3. Ensure new directories
  await this.kernel.storagePaths.ensureNewDirectories();

  // 4. Split into chunks and embeddings
  const noteChunks = new Map<string, StoredChunk[]>();
  const embeddings = new Map<string, number[]>();

  for (const doc of legacy.docs) {
    // Group chunks by noteId
    if (!noteChunks.has(doc.noteId)) {
      noteChunks.set(doc.noteId, []);
    }

    noteChunks.get(doc.noteId)!.push({
      chunkId: doc.chunkId,
      noteId: doc.noteId,
      path: doc.path,
      tier: doc.tier,
      kind: doc.kind,
      parentChunkId: doc.parentChunkId,
      headingPath: doc.headingPath,
      text: doc.text,
      blockRef: doc.blockRef,
      startLine: doc.startLine,
      endLine: doc.endLine,
      tokenEstimate: doc.tokenEstimate ?? 0,
      tags: doc.tags ?? [],
      frontmatter: doc.frontmatter ?? {},
    });

    // Collect embeddings
    if (doc.embedding) {
      embeddings.set(doc.chunkId, doc.embedding);
    }
  }

  // 5. Write chunk files
  for (const [noteId, chunks] of noteChunks) {
    const firstChunk = chunks[0];
    await this.chunkStore.saveNoteChunks(
      noteId,
      firstChunk.path,
      legacy.meta.state?.notes?.[firstChunk.path]?.mtimeMs ?? Date.now(),
      legacy.meta.state?.notes?.[firstChunk.path]?.contentHash ?? '',
      chunks
    );
  }

  // 6. Write embedding index
  const modelKey = legacy.meta.modelKey;
  const dimension = legacy.meta.dimension;
  await this.vectorStore.saveEmbeddings(modelKey, dimension);

  // 7. Move legacy file to _archived
  const archivedPath = this.kernel.storagePaths.getArchivedEmbeddingPath(
    modelKey,
    dimension,
    formatIndexTimestamp()
  );
  await fs.promises.rename(legacyPath, archivedPath);

  console.log('[IndexManager] Migration complete');
}
```

## Verification

### 1. Build Check
```bash
bun run typecheck
bun run build
```

### 2. Manual Test

1. Start Obsidian with existing index
2. Check console for migration messages
3. Verify new directory structure created:
   ```
   data/chunks/notes/*.json
   data/embeddings/active/*.json
   data/embeddings/_archived/*.json (old index moved here)
   ```

4. Test search still works
5. Test indexing new note creates both chunk and embedding

### 3. Model Switch Test

1. Change embedding model in settings
2. Verify chunks NOT re-generated
3. Verify embeddings rebuild from existing chunks

## Commit Message

```
refactor(index): Separate chunks from embeddings

- Add ChunkStore for model-agnostic chunk content
- Modify SimpleVectorStore to store embeddings only
- Update IndexManager to coordinate both stores
- Add migration for legacy single-file index
- Enable model switching without re-chunking

Part of storage restructure Phase 2.
```

## Next Phase

After this phase is complete, proceed to Phase 3 (Intelligence Tag-Based Sharding).
