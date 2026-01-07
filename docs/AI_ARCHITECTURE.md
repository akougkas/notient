# Notient AI Architecture Guide

**Version:** 2.0
**Last Updated:** 2026-01-07
**Status:** Comprehensive Developer Documentation

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [AI Interaction Points](#ai-interaction-points)
3. [Provider Architecture](#provider-architecture)
4. [Note Processing Pipeline](#note-processing-pipeline)
5. [Search & RAG Pipeline](#search--rag-pipeline)
6. [Agent & Chat Pipeline](#agent--chat-pipeline)
7. [Intelligence Generation](#intelligence-generation)
8. [Request Analysis & Safety](#request-analysis--safety)
9. [Configuration Deep Dive](#configuration-deep-dive)
10. [Sequence Diagrams](#sequence-diagrams)
11. [Performance & Optimization](#performance--optimization)
12. [Security & Privacy](#security--privacy)
13. [Troubleshooting](#troubleshooting)

---

## Executive Summary

### What Notient Sends to AI Models

**Embeddings (Ollama):**
- Note content chunks (600-3600 chars depending on tier)
- Batch size: 4 chunks per API call
- No system prompts (embeddings are pure vector conversion)
- Models used: `nomic-embed-text` (default)

**Chat/Reasoning (LM Studio):**
- System prompt (~500-2000 chars) with task instructions + vault context
- Current note content (up to 3000 chars)
- Related notes from RAG (up to 5 notes, 400 chars each)
- User chat history (last 10 messages, sliding window)
- Temperature: 0.7 (chat), 0.2 (summaries), 0.1 (extraction)
- Max tokens: 500-1500 depending on task type

**Privacy Guarantee:** All AI processing is **100% local**. Nothing leaves your machine.

---

## AI Interaction Points

### 1. Embedding Generation (`OllamaService`)
**Location:** `src/services/ollama.ts`

```typescript
// Single embedding
await ollama.embed(text: string)
// → { embedding: number[], dimension: number }

// Batch embeddings (used during indexing)
await ollama.embedBatch(texts: string[])
// → { embeddings: number[][], dimension: number }
```

**Usage:**
- Note indexing (chunking phase)
- Search query embedding
- Related note detection

**API Endpoint:** `POST http://localhost:11434/api/embed`

**Request Payload:**
```json
{
  "model": "nomic-embed-text",
  "input": ["text1", "text2", "..."],
  "keep_alive": "5m"
}
```

**Configuration:**
- No temperature (deterministic)
- No top_k/top_p (N/A for embeddings)
- Dimension detected automatically (768 for nomic-embed-text)

---

### 2. Chat Completions (`LMStudioProvider`)
**Location:** `src/core/llm/providers/lmstudio.ts` (extends `OpenAICompatibleProvider`)

```typescript
// Non-streaming
await llmProvider.complete(messages: ChatMessage[], options?: CompletionOptions)
// → string

// Streaming
async *llmProvider.stream(messages: ChatMessage[], options?, signal?: AbortSignal)
// → AsyncIterable<string>

// Reranking
await llmProvider.rerank(query: string, candidates: RerankCandidate[])
// → RankedResult[]
```

**API Endpoint:** `POST http://localhost:1234/v1/chat/completions`

**Request Payload:**
```json
{
  "model": "ministral-3b-instruct",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "temperature": 0.7,
  "max_tokens": 1500,
  "stream": false
}
```

---

### 3. Reranking (`LLMProvider.rerank`)
**Location:** `src/core/llm/providers/openai-compatible.ts:214-245`

**System Prompt:**
```
You rank search results by relevance. Output ONLY valid JSON.

Example output:
{"rankings":[{"index":0,"score":90,"reason":"exact match"}]}

Rules:
- score: 0-100
- index: candidate number
- reason: brief (under 30 chars)
- Only include relevant results (score >= 30)
```

**Configuration:**
- Temperature: 0.3 (more deterministic)
- Max tokens: 500
- Top 10 candidates only

---

## Provider Architecture

### Hierarchy

```
LLMProvider (interface)
    ↓
OpenAICompatibleProvider (base implementation)
    ↓
LMStudioProvider (thin wrapper, just sets name)
```

### Why This Design?

**OpenAICompatibleProvider** (`src/core/llm/providers/openai-compatible.ts`):
- Pure HTTP/streaming logic
- Works with ANY OpenAI-compatible API (LM Studio, Ollama chat, vLLM, etc.)
- No Notient-specific code
- Handles SSE streaming, JSON parsing, error recovery

**LMStudioProvider** (`src/core/llm/providers/lmstudio.ts`):
- Extends OpenAICompatibleProvider
- Only difference: `name = "lmstudio"`
- Exists for future LM Studio-specific quirks

**Why Not a Separate Ollama Chat Provider?**
- Ollama is currently only used for embeddings (via dedicated Ollama SDK)
- If needed, could easily create: `new OpenAICompatibleProvider("http://localhost:11434", "llama3", "ollama")`

### Service Layer vs Provider Layer

**Service Layer** (Legacy, being phased out):
- `src/services/lmstudio.ts` - Deprecated, kept for SearchPipeline compatibility
- `src/services/ollama.ts` - Active, wraps Ollama SDK for embeddings

**Provider Layer** (New Architecture):
- `src/core/llm/providers/*` - Clean, testable, swappable LLM abstraction
- Used by Agent, NoteIntelligence, SearchPipeline (via reranker)

---

## Note Processing Pipeline

### Overview

**Trigger:** File create/modify/rename, or manual "Sync Index" button

**Flow:**
```
Note.md (Vault File)
    ↓
[1] SimpleIndexer.scanForChanges()
    ↓
[2] TieredSemanticChunker.chunkNoteTiered()
    ↓
[3] OllamaService.embedBatch() [BATCH_SIZE=4]
    ↓
[4] IndexManager.addChunks()
    ↓
[5] SimpleVectorStore.addEmbedding()
```

### Step-by-Step

#### 1. **File Change Detection**
**Location:** `src/core/indexer/simpleIndexer.ts:267-290`

- Debounced file watchers (default: 5s)
- Content hash comparison (SHA-256)
- mtime check for stale detection

#### 2. **Tiered Semantic Chunking (TSI v2)**
**Location:** `src/core/indexer/tieredSemanticChunker.ts`

**Produces 3 tiers:**

**Tier 0: Note** (1 chunk per note)
- Contains: Title, path, tags, outline, content sketch
- Size: 2000-8000 chars (configurable via `noteSketchMaxChars`)
- Purpose: Fast note-level similarity search

**Tier 1: Section** (per H1-H3 heading)
- Contains: Context header + section content
- Size: 1200-6000 chars (configurable via `sectionMaxChars`)
- Purpose: Heading-level retrieval

**Tier 2: Block** (paragraphs, lists, code, callouts, tables)
- Contains: Context header + block content
- Size: 600-2400 chars (configurable via `blockMaxChars`)
- Purpose: Precise citation with block references

**Example Chunk (Tier 2 - Block):**
```markdown
# Project Alpha
## Meeting Notes

Tags: project, alpha, meeting

This is a paragraph about the budget discussion. ^abc123
```

**Chunk ID Generation:**
```typescript
stableChunkId(noteId, tier, anchor)
// Example: "note-abc123-block-xyz789"
// Anchor: "Meeting Notes#^abc123"
```

#### 3. **Batch Embedding**
**Location:** `src/core/indexer/simpleIndexer.ts:438-468`

```typescript
const EMBED_BATCH_SIZE = 4;

for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
  const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
  const texts = batch.map(c => c.text);

  const { embeddings } = await ollama.embedBatch(texts);

  for (let j = 0; j < batch.length; j++) {
    embedded.push({
      ...batch[j],
      embedding: embeddings[j],
      modelKey: "nomic-embed-text:768"
    });
  }

  await yieldToUI(); // Keep UI responsive
}
```

**What's Sent to Ollama:**
```json
{
  "model": "nomic-embed-text",
  "input": [
    "# Project Alpha\n## Budget\n\nDiscussed Q1 budget allocation...",
    "# Project Alpha\n## Timeline\n\nAgreed on March deadline...",
    "# Project Alpha\n## Resources\n\nNeed 2 additional engineers...",
    "# Project Alpha\n## Risks\n\nSupply chain delays possible..."
  ]
}
```

**Response:**
```json
{
  "embeddings": [
    [0.123, -0.456, 0.789, ...], // 768 dimensions
    [0.234, -0.567, 0.890, ...],
    [0.345, -0.678, 0.901, ...],
    [0.456, -0.789, 0.012, ...]
  ]
}
```

#### 4. **Storage**
**Location:** `src/services/simpleVectorStore.ts`

- Flat array of embeddings (simple, fast)
- Metadata: chunkId, noteId, path, tier, blockRef, headingPath
- Persisted to: `.obsidian/plugins/notient/data/index-{modelKey}.json`

**Index File Structure:**
```json
{
  "version": 2,
  "modelKey": "nomic-embed-text:768",
  "dimension": 768,
  "chunks": [
    {
      "chunkId": "note-abc-block-xyz",
      "noteId": "note-abc",
      "embedding": [...],
      "text": "...",
      "tier": "block",
      "headingPath": ["Meeting Notes"],
      "blockRef": "abc123"
    }
  ]
}
```

### Performance Metrics

**Full Vault Indexing (1000 notes):**
- Chunking: ~15-30s (pure JS, fast)
- Embedding: ~2-5min (depends on Ollama performance)
- Storage: ~5-10s (JSON serialization)

**Incremental Update (1 note changed):**
- Detection: <100ms
- Re-chunking: <500ms
- Re-embedding: ~1-3s (for ~10-20 chunks)
- Storage: <100ms

---

## Search & RAG Pipeline

### User Search Flow

**Trigger:** User types in search bar or agent needs context

**Flow:**
```
User Query
    ↓
[1] SearchPipeline.search()
    ↓
[2] OllamaService.embed(query) → queryEmbedding
    ↓
[3] VectorStore.search(queryEmbedding, options)
    ↓ [Two-stage hierarchical retrieval]
[4a] Stage 1: Candidate notes (tier=note, topK=80)
[4b] Stage 2: Candidate chunks (tier=block, within candidates, topK=120)
    ↓
[5] LLMProvider.rerank(query, chunks) [OPTIONAL, if enableReranking=true]
    ↓
[6] Aggregate chunks → notes (bestScore = max chunk score)
    ↓
[7] Return top N results
```

### Step-by-Step

#### 1-2. **Query Embedding**
**Location:** `src/core/search/pipeline.ts:372-386`

```typescript
// Cached for performance
const queryEmbedding = await getQueryEmbedding(query);
```

**What's Sent:**
```json
{
  "model": "nomic-embed-text",
  "input": "machine learning techniques"
}
```

**Response:**
```json
{
  "embeddings": [
    [0.234, -0.567, 0.123, ...] // 768 dims
  ]
}
```

#### 3-4. **Hierarchical Vector Search**
**Location:** `src/core/search/pipeline.ts:124-155`

**Stage 1: Note-level candidates**
```typescript
const noteCandidates = await vectorStore.search(queryEmbedding, {
  topK: 80, // Wide net
  tier: "note", // Only note-tier chunks
  minScore: 0.3
});
// → ["note-abc", "note-def", "note-ghi", ...]
```

**Stage 2: Block-level chunks within candidates**
```typescript
const chunkCandidates = await vectorStore.search(queryEmbedding, {
  topK: 120,
  tier: "block", // Only block-tier chunks
  noteIds: candidateNoteIds, // FILTER: only search within stage 1 results
  maxPerNote: 5, // Max 5 chunks per note
  minScore: 0.3
});
```

**Why Hierarchical?**
- **Speed:** Stage 1 narrows search space from 10,000+ chunks to ~400 chunks
- **Quality:** Stage 2 finds precise blocks within relevant notes
- **Scalability:** Works even with 100k+ chunks

**Cosine Similarity (used for scoring):**
```typescript
function cosineSimilarity(a: number[], b: number[]): number {
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (magA * magB); // Range: [-1, 1], typically [0, 1]
}
```

#### 5. **LLM Reranking (Optional)**
**Location:** `src/core/search/pipeline.ts:193-234`

**When:** `enableReranking=true` (default for "balanced" and "thorough" presets)

**What's Sent to LLM:**
```json
{
  "model": "ministral-3b-instruct",
  "messages": [
    {
      "role": "system",
      "content": "You rank search results by relevance. Output ONLY valid JSON.\n\nExample output:\n{\"rankings\":[{\"index\":0,\"score\":90,\"reason\":\"exact match\"}]}\n\nRules:\n- score: 0-100\n- index: candidate number\n- reason: brief (under 30 chars)\n- Only include relevant results (score >= 30)"
    },
    {
      "role": "user",
      "content": "Query: \"machine learning techniques\"\n\n[0] Deep Learning Basics — Introduction: Deep learning is a subset of machine learning...\n[1] ML Algorithms — Overview: Machine learning algorithms can be categorized...\n[2] Neural Networks — Architecture: Neural networks form the foundation...\n\nReturn JSON with rankings array. Example: {\"rankings\":[{\"index\":0,\"score\":90,\"reason\":\"best match\"}]}"
    }
  ],
  "temperature": 0.3,
  "max_tokens": 500
}
```

**Expected Response:**
```json
{
  "rankings": [
    { "index": 1, "score": 95, "reason": "direct topic match" },
    { "index": 0, "score": 85, "reason": "related subset" },
    { "index": 2, "score": 75, "reason": "implementation detail" }
  ]
}
```

**Robustness:**
- Strips markdown code fences
- Handles incomplete JSON (auto-completes braces)
- Falls back to vector scores on parse failure
- Validates score range and index bounds

#### 6. **Aggregation**
**Location:** `src/core/search/pipeline.ts:242-278`

```typescript
// Group chunks by note
const noteMap: Map<string, SearchResult> = new Map();

for (const chunk of chunks) {
  const existing = noteMap.get(chunk.noteId);
  if (existing) {
    existing.chunks.push(chunk);
    if (chunk.score > existing.bestScore) {
      existing.bestScore = chunk.score; // Note score = best chunk score
    }
  } else {
    noteMap.set(chunk.noteId, {
      noteId: chunk.noteId,
      path: chunk.path,
      title: chunk.title,
      bestScore: chunk.score,
      chunks: [chunk],
    });
  }
}

// Limit chunks per note
for (const result of results) {
  result.chunks.sort((a, b) => b.score - a.score);
  result.chunks = result.chunks.slice(0, 3); // Max 3 chunks per note
}

results.sort((a, b) => b.bestScore - a.bestScore);
return results.slice(0, topK);
```

### Caching Strategy

**Query Cache:**
- Key: `JSON.stringify({ query, topK, minScore, paraType, folderPaths, tags })`
- TTL: 5 minutes
- LRU eviction (max 50 queries)

**Embedding Cache:**
- Key: Raw query string
- TTL: Until cache full
- LRU eviction (max 100 queries)

---

## Agent & Chat Pipeline

### "Enhance" Button Flow

**Trigger:** User clicks "Enhance" button in Note Vitals view
**Location:** `src/views/sidebar/components/QuickActions.ts:52-58`

```typescript
{
  icon: "sparkles",
  label: "Enrich",
  primary: true,
  onClick: () => prefillChatAndSwitch(
    `Enrich and expand "${noteTitle}" with additional context and insights`
  ),
}
```

**What Happens:**
1. Chat input is pre-filled with prompt
2. User is switched to Chat tab
3. User presses Enter (or can edit first)
4. Agent execution begins

### Agent Execution Flow

**Location:** `src/core/agent/agentLoop.ts`

```
User Message
    ↓
[1] Task Inference (classify query intent)
    ↓
[2] Load Current Note (readFileByPath)
    ↓
[3] Search for Context (SearchPipeline.search, topK=7)
    ↓
[4] Build System Prompt (PromptBuilder.buildSystemPrompt)
    ↓
[5] Stream LLM Response (LLMProvider.stream)
    ↓
[6] Generate Action Plan (if task type = enrich/link/classify)
    ↓
[7] Return Result (text + citations + actions)
```

### Step-by-Step

#### 1. **Task Inference**
**Location:** `src/core/agent/taskInference.ts`

```typescript
function inferTaskType(query: string): TaskType | null {
  const q = query.toLowerCase();

  if (q.includes("enrich") || q.includes("expand")) return "enrich";
  if (q.includes("link") || q.includes("connections")) return "link";
  if (q.includes("move") || q.includes("classify")) return "classify";
  if (q.includes("analyze") || q.includes("health")) return "analyze";

  return null; // Generic chat
}
```

**Task Types:**
- `enrich`: Add tags, metadata, expand content
- `link`: Find related notes
- `classify`: Suggest PARA category/folder
- `analyze`: Health score, insights
- `null`: Generic Q&A

#### 2. **Load Current Note**
**Location:** `src/core/agent/agentLoop.ts:95-111`

```typescript
let currentNoteData: NoteContext | undefined;

if (task.notePath && task.notePath !== "unknown") {
  const content = await obsidian.readFileByPath(task.notePath);
  if (content) {
    currentNoteData = {
      title: task.noteTitle,
      path: task.notePath,
      content: content, // FULL CONTENT (truncated later in prompt)
    };
  }
}
```

#### 3. **Search for Context (RAG)**
**Location:** `src/core/agent/agentLoop.ts:120-165`

```typescript
const searchQuery = currentNoteData
  ? `${query} ${currentNoteData.title}`
  : query;

const searchResults = await this.search.search(searchQuery, {
  topK: 7,
  enableReranking: this.llm.isReady, // Only if LLM available
});

// Build context
const relevantNotes: Array<{ title: string; path: string; text: string }> = [];

for (const result of searchResults) {
  // Exclude current note from context (avoid duplication)
  if (currentNoteData && result.path === currentNoteData.path) {
    continue;
  }

  if (relevantNotes.length >= 5) break;

  citations.push(result.path);
  const bestChunk = result.chunks[0];
  const citationLink = buildCitationLink(result.path, bestChunk);

  relevantNotes.push({
    title: result.title,
    path: result.path,
    text: `${citationLink}\n${bestChunk?.text || ""}`.trim(),
  });
}
```

**Citation Link Format:**
```typescript
// If block reference exists:
`[[Note Title#^blockRef]]`

// If heading path exists:
`[[Note Title#Heading 1#Heading 2]]`

// Otherwise:
`[[Note Title]]`
```

#### 4. **Build System Prompt**
**Location:** `src/core/agent/promptBuilder.ts:70-106`

**Base Prompt:**
```
You are Notient, an AI assistant for an Obsidian vault. You help users understand, navigate, and improve their notes.

CRITICAL RULES:
- Always ground your responses in the actual note content provided
- Cite notes using Obsidian wiki-links. Prefer precise citations when available: [[Note Title#Heading]] and [[Note Title#^blockRef]].
- Be concise, specific, and actionable
- If information isn't in the notes, explicitly say so
- Never invent or hallucinate content that isn't in the provided context
```

**Current Note Section:**
```
=== CURRENT NOTE (FOCUS) ===
Title: Project Alpha
Path: projects/alpha.md

# Project Alpha

## Budget
Discussed Q1 budget allocation...
[... up to 3000 chars ...]
=== END CURRENT NOTE ===
```

**Task Instructions (example for "enrich"):**
```
TASK INSTRUCTIONS:
Analyze the current note and suggest improvements:
- Add relevant tags based on content
- Suggest related topics or sections to expand
- Identify missing connections to other notes
- Propose frontmatter metadata
```

**Related Notes Section:**
```
RELATED NOTES FROM VAULT:
### [[Project Beta#Budget Planning]] (projects/beta.md)
Similar project with detailed budget breakdown...

### [[Budget Template#Q1 Allocation]] (templates/budget.md)
Standard template for quarterly budgets...

[... up to 5 notes ...]
```

**Final Prompt Size:** ~500-2000 chars (depends on context)

#### 5. **Stream LLM Response**
**Location:** `src/core/agent/agentLoop.ts:190-218`

```typescript
const messages: ChatMessage[] = [
  { role: "system", content: systemPrompt },
  ...task.chatHistory.slice(-10), // Last 10 messages (sliding window)
];

let fullResponse = "";

for await (const chunk of this.llm.stream(messages, undefined, signal)) {
  if (signal?.aborted) break;

  fullResponse += chunk;
  yield { type: "chunk", content: chunk };

  // Update progress (40-90%)
  const progressDelta = Math.min(50, fullResponse.length / 20);
  yield { type: "progress", progress: Math.min(90, 40 + progressDelta) };
}
```

**What's Sent to LLM:**
```json
{
  "model": "ministral-3b-instruct",
  "messages": [
    {
      "role": "system",
      "content": "<FULL SYSTEM PROMPT FROM STEP 4>"
    },
    {
      "role": "user",
      "content": "Enrich and expand \"Project Alpha\" with additional context and insights"
    }
  ],
  "temperature": 0.7,
  "max_tokens": 1500,
  "stream": true
}
```

**Streaming Response (SSE format):**
```
data: {"choices":[{"delta":{"content":"Based"}}]}

data: {"choices":[{"delta":{"content":" on"}}]}

data: {"choices":[{"delta":{"content":" the"}}]}

data: {"choices":[{"delta":{"content":" current"}}]}

...

data: [DONE]
```

#### 6. **Generate Action Plan**
**Location:** `src/core/agent/agentLoop.ts:226-265`

**When:** Task type is `enrich`, `link`, or `classify`

**Action Plan System Prompt:**
```
You are an AI assistant analyzing an Obsidian note. Based on the user's request and note content, output ONLY a valid JSON object with proposed actions.

Output format:
{
  "actions": [
    {
      "type": "frontmatter_set" | "frontmatter_add_tags" | "append_section" | "append_related_links" | "move_note",
      "risk": "low" | "medium" | "high",
      "title": "Short description (max 50 chars)",
      "reason": "Why this action helps the user",
      "target": "path/to/note.md",
      "payload": { /* type-specific */ }
    }
  ]
}

[... payload format examples ...]

Rules:
- Output ONLY valid JSON, no explanation or markdown code fences
- Maximum 10 actions per response
- Paths must be relative to vault root
- If no actions are appropriate, return { "actions": [] }
```

**What's Sent:**
```json
{
  "model": "ministral-3b-instruct",
  "messages": [
    {
      "role": "system",
      "content": "<ACTION PLAN PROMPT>"
    },
    {
      "role": "user",
      "content": "Based on my request \"Enrich and expand 'Project Alpha' with additional context and insights\" and the note content, propose specific actions to improve this note. Output only valid JSON."
    }
  ],
  "temperature": 0.7,
  "max_tokens": 1500,
  "stream": false
}
```

**Expected Response:**
```json
{
  "actions": [
    {
      "type": "frontmatter_add_tags",
      "title": "Add project-related tags",
      "reason": "Categorize this as an active project",
      "target": "projects/alpha.md",
      "payload": {
        "tags": ["project", "alpha", "q1-2026", "budget"]
      }
    },
    {
      "type": "append_related_links",
      "title": "Link to related projects",
      "reason": "Connect to similar ongoing projects",
      "target": "projects/alpha.md",
      "payload": {
        "links": ["Project Beta", "Budget Template", "Q1 Planning"]
      }
    }
  ]
}
```

**Action Validation:**
**Location:** `src/core/agent/agentLoop.ts:287-419`

- ✅ Validate action type is supported
- ✅ Validate required fields present
- ✅ Override target to match current note (security)
- ✅ Reject non-.md files
- ✅ Override risk level (don't trust LLM)
- ✅ Validate payload structure
- ✅ Truncate strings to max lengths

**Security Note:** Actions are **NEVER auto-applied**. User must approve each action.

---

## Intelligence Generation

**Background Service:** `NoteIntelligenceService`
**Location:** `src/core/intelligence/noteIntelligence.ts`

### What It Does

For each note, generates:
1. **Summary** (short + structured)
2. **Health Score** (0-100, based on freshness/connectivity/structure/metadata)
3. **Entities** (people, projects, tools, concepts)
4. **Suggested Tags**
5. **Suggested Links**
6. **Triage Action** (for inbox notes)

### When It Runs

- After indexing completes
- On manual "regenerate" button click
- Automatically refreshes stale records (contentHash mismatch)

### LLM Requests Per Note

**4 LLM calls per note:**

#### 1. **Summary Generation**
**Prompt:**
```
You write compact note intelligence for an Obsidian vault. Output ONLY valid JSON.

Schema:
{
  "summaryShort": "1-2 sentences",
  "keyPoints": ["bullet", "..."],
  "purpose": "what this note is for (string or null)"
}

Rules:
- Be concrete, avoid fluff.
- keyPoints: 3-7 items, short.
- Never include markdown fences.
```

**User Message:**
```
Title: Project Alpha
Path: projects/alpha.md
Tags: project, alpha

Headings:
# Project Alpha
## Budget
## Timeline
## Resources

Note:
[... first 12,000 chars ...]
```

**Config:**
- Temperature: 0.2 (very deterministic)
- Max tokens: 500

#### 2. **Entity & Tag Extraction**
**Prompt:**
```
You are an expert knowledge graph extractor.
Analyze the note content and extract:
1. Significant entities (people, projects, tools, concepts).
2. Suggested tags (kebab-case) that categorize this note (exclude existing tags).

Return JSON only:
{
  "entities": [{ "name": "...", "type": "person|project|tool|concept|org|other", "context": "brief reason" }],
  "suggestedTags": [{ "tag": "tag-name", "confidence": 0-1, "reason": "why" }]
}
```

**Config:**
- Temperature: 0.1 (most deterministic)
- Max tokens: 800

#### 3. **Link Suggestions**
**Uses SearchPipeline, no LLM call:**
```typescript
const related = await search.findRelated(notePath, { topK: 5, minScore: 0.45 });
```

#### 4. **Inbox Triage**
**Only for inbox notes:**

**Prompt:**
```
You are a strict inbox zero assistant.
Review this note and recommend a Triage Action:
- "move" -> if it belongs in a specific project/area folder.
- "tag" -> if it needs a status tag (e.g. #todo/triage).
- "status" -> if it seems like a fleeting note or scratchpad.

Return JSON:
{ "type": "move|tag|status", "target": "folder/path or #tag", "reason": "...", "confidence": 0-1 }
```

**Config:**
- Temperature: 0.1
- Max tokens: 300

### Total LLM Cost Per Note

- 3-4 LLM calls (4 if inbox note)
- ~1500-2300 total tokens consumed
- Run in background queue (rate limited: 10ms delay between notes)

---

## Request Analysis & Safety

### What Data Leaves Your Machine?

**NOTHING.** All AI processing is 100% local:
- Ollama: `http://localhost:11434`
- LM Studio: `http://localhost:1234`

### What's In Each Request?

#### Embeddings (Ollama)

**Request:**
```json
{
  "model": "nomic-embed-text",
  "input": [
    "# Meeting Notes\n\n## Action Items\n\n- Follow up with John...",
    "# Meeting Notes\n\n## Decisions\n\n- Approved budget increase..."
  ]
}
```

**Privacy:** Only note text chunks. No file paths, no metadata, no frontmatter.

#### Chat (LM Studio)

**Request:**
```json
{
  "model": "ministral-3b-instruct",
  "messages": [
    {
      "role": "system",
      "content": "You are Notient...\n\n=== CURRENT NOTE (FOCUS) ===\nTitle: Meeting Notes\n...\n\nRELATED NOTES:\n### [[Previous Meeting#Decisions]]\n..."
    },
    {
      "role": "user",
      "content": "Summarize the key decisions from this meeting"
    }
  ]
}
```

**Privacy Concerns:**
- ✅ Note titles and content are sent
- ✅ Wikilink citations are sent
- ⚠️ File paths are sent (but only to localhost)
- ✅ User queries are sent

**Mitigation:** Everything stays local. No external API calls.

### Request Count Per User Query

**Example: User clicks "Enhance" button**

1. **Query Embedding:** 1 Ollama request
2. **Vector Search:** 0 requests (local computation)
3. **Reranking:** 1 LM Studio request (if enabled)
4. **Chat Response:** 1 LM Studio request (streaming)
5. **Action Plan:** 1 LM Studio request

**Total: 2-4 LLM requests per "Enhance" click**

**Token Usage:**
- Query embedding: ~10 input tokens
- Reranking: ~200 input tokens, ~100 output tokens
- Chat: ~1500 input tokens, ~500 output tokens
- Action plan: ~1200 input tokens, ~400 output tokens
- **Total: ~2900 input tokens, ~1000 output tokens**

### Interpretability & Transparency

**✅ System Prompts Are Fixed and Auditable:**
- All prompts defined in `src/core/agent/promptBuilder.ts`
- No dynamic prompt injection
- User can inspect prompts before running

**✅ Citations Are Mandatory:**
- Agent must cite sources
- Block references provide exact locations
- User can verify claims

**✅ Actions Are Never Auto-Applied:**
- All proposed actions go to review queue
- User approves/rejects each action
- Risk level shown clearly (low/medium/high)

**⚠️ LLM Output Is Unpredictable:**
- JSON parsing can fail (fallback to defaults)
- LLM can hallucinate despite instructions
- Validation layer catches most issues

---

## Configuration Deep Dive

### Ollama Configuration

**Location:** `src/types/settings.ts:12-16`

```typescript
ollama: {
  host: string;           // Default: "http://127.0.0.1:11434"
  embeddingModel: string; // Default: "nomic-embed-text"
  enabled: boolean;       // Default: true
}
```

**Model Selection:**
- Detected automatically on setup
- Filters for embedding-capable models
- Dimension auto-detected (768 for nomic-embed-text)

**NOT Configurable:**
- Temperature (N/A for embeddings)
- Top-k, top-p (N/A)
- Max tokens (N/A)
- System prompt (N/A)

### LM Studio Configuration

**Location:** `src/types/settings.ts:18-23`

```typescript
lmstudio: {
  host: string;         // Default: "http://127.0.0.1:1234"
  reasoningModel: string; // User-selected
  enabled: boolean;     // Default: true
}
```

**Model Loading:**
- **NOT managed by Notient**
- User must manually load model in LM Studio
- Notient verifies model is loaded on init

**Configuration Parameters (Hardcoded):**

```typescript
// Chat (general)
{
  temperature: 0.7,
  max_tokens: 1500,
  stream: true
}

// Summaries (deterministic)
{
  temperature: 0.2,
  max_tokens: 500,
  stream: false
}

// Extraction (very deterministic)
{
  temperature: 0.1,
  max_tokens: 800,
  stream: false
}

// Reranking (somewhat deterministic)
{
  temperature: 0.3,
  max_tokens: 500,
  stream: false
}
```

**NOT Exposed to User:**
- Temperature sliders (hardcoded per task type)
- Top-k, top-p (uses LM Studio defaults)
- Reasoning effort (not supported by API yet)
- Penalty % (uses defaults)
- Custom system prompts (fixed per task type)

### Why Not Fully Configurable?

**Philosophy:** Notient is a **product**, not a playground.

**Pros of Fixed Config:**
- ✅ Consistent experience
- ✅ Optimized for each task type
- ✅ Simpler UI
- ✅ Less user error

**Cons:**
- ❌ Power users can't tweak
- ❌ Can't experiment with different temps
- ❌ Locked into Notient's choices

**Recommendation:** Add "Advanced" settings panel for power users.

### Missing Configuration Features

**From Official SDKs:**

**Ollama:**
- ❌ `truncate` (auto-truncate long inputs)
- ❌ `keep_alive` (currently uses default 5m)
- ❌ `options.num_ctx` (context window size)

**LM Studio:**
- ❌ `top_p` (nucleus sampling)
- ❌ `top_k` (top-k filtering)
- ❌ `presence_penalty`
- ❌ `frequency_penalty`
- ❌ `repeat_penalty`
- ❌ `seed` (reproducibility)
- ❌ `stop` (custom stop sequences)
- ❌ `logit_bias` (token biasing)

**Recommendations:**
1. Add `keep_alive` control for Ollama (reduce memory usage)
2. Add temperature/top_p/top_k sliders in "Advanced" panel
3. Expose system prompt templates for customization
4. Add seed parameter for reproducible outputs

---

## Sequence Diagrams

### 1. Note Indexing Flow

```
┌──────┐                  ┌─────────────┐                  ┌────────┐                  ┌──────────┐
│ User │                  │SimpleIndexer│                  │Chunker │                  │  Ollama  │
└──┬───┘                  └──────┬──────┘                  └───┬────┘                  └────┬─────┘
   │                             │                             │                            │
   │  Save Note.md               │                             │                            │
   ├─────────────────────────────>                             │                            │
   │                             │                             │                            │
   │                          [Debounce 5s]                    │                            │
   │                             │                             │                            │
   │                             │  scanForChanges()           │                            │
   │                             ├────────┐                    │                            │
   │                             │        │                    │                            │
   │                             │<───────┘                    │                            │
   │                             │                             │                            │
   │                             │  chunkNoteTiered()          │                            │
   │                             ├─────────────────────────────>                            │
   │                             │                             │                            │
   │                             │                      [Parse & Chunk]                     │
   │                             │                             │                            │
   │                             │  NoteChunk[]                │                            │
   │                             │<─────────────────────────────                            │
   │                             │                             │                            │
   │                             │  embedBatch([chunk1, chunk2, chunk3, chunk4])           │
   │                             ├───────────────────────────────────────────────────────────>
   │                             │                             │                            │
   │                             │                             │                     POST /api/embed
   │                             │                             │                       {input: [...]}
   │                             │                             │                            │
   │                             │  [embedding1, embedding2, embedding3, embedding4]        │
   │                             │<───────────────────────────────────────────────────────────
   │                             │                             │                            │
   │                          [Repeat for all chunks in batches of 4]                       │
   │                             │                             │                            │
   │                             │  saveToIndex()              │                            │
   │                             ├────────┐                    │                            │
   │                             │        │                    │                            │
   │                             │<───────┘                    │                            │
   │                             │                             │                            │
   │  ✅ Index updated            │                             │                            │
   │<─────────────────────────────                             │                            │
```

### 2. Search & RAG Flow

```
┌──────┐         ┌──────────────┐         ┌────────┐         ┌─────────┐         ┌──────────┐
│ User │         │SearchPipeline│         │Ollama  │         │VectorDB │         │LMStudio  │
└──┬───┘         └──────┬───────┘         └───┬────┘         └────┬────┘         └────┬─────┘
   │                    │                     │                   │                   │
   │ "ML techniques"    │                     │                   │                   │
   ├────────────────────>                     │                   │                   │
   │                    │                     │                   │                   │
   │                    │ embed(query)        │                   │                   │
   │                    ├─────────────────────>                   │                   │
   │                    │                     │                   │                   │
   │                    │ queryEmbedding[]    │                   │                   │
   │                    │<─────────────────────                   │                   │
   │                    │                     │                   │                   │
   │                    │ search(tier=note, topK=80)              │                   │
   │                    ├─────────────────────────────────────────>                   │
   │                    │                     │                   │                   │
   │                    │                     │         [Cosine similarity]           │
   │                    │                     │                   │                   │
   │                    │ candidateNoteIds[]  │                   │                   │
   │                    │<─────────────────────────────────────────                   │
   │                    │                     │                   │                   │
   │                    │ search(tier=block, noteIds=candidates, topK=120)            │
   │                    ├─────────────────────────────────────────>                   │
   │                    │                     │                   │                   │
   │                    │ chunkResults[]      │                   │                   │
   │                    │<─────────────────────────────────────────                   │
   │                    │                     │                   │                   │
   │                    │ rerank(query, chunks)                   │                   │
   │                    ├───────────────────────────────────────────────────────────────>
   │                    │                     │                   │              POST /v1/chat/completions
   │                    │                     │                   │              system: "You rank..."
   │                    │                     │                   │              temp: 0.3
   │                    │                     │                   │                   │
   │                    │ rankedResults[]     │                   │                   │
   │                    │<───────────────────────────────────────────────────────────────
   │                    │                     │                   │                   │
   │                    │ aggregate()         │                   │                   │
   │                    ├────────┐            │                   │                   │
   │                    │        │            │                   │                   │
   │                    │<───────┘            │                   │                   │
   │                    │                     │                   │                   │
   │ SearchResult[]     │                     │                   │                   │
   │<────────────────────                     │                   │                   │
```

### 3. Agent Chat Flow (with "Enhance")

```
┌──────┐    ┌───────┐    ┌───────────┐    ┌──────────────┐    ┌──────────┐    ┌──────────┐
│ User │    │Sidebar│    │AgentLoop  │    │SearchPipeline│    │LMStudio  │    │Obsidian  │
└──┬───┘    └───┬───┘    └─────┬─────┘    └──────┬───────┘    └────┬─────┘    └────┬─────┘
   │            │               │                 │                  │               │
   │ Click      │               │                 │                  │               │
   │ "Enhance"  │               │                 │                  │               │
   ├────────────>               │                 │                  │               │
   │            │               │                 │                  │               │
   │            │ prefillChat() │                 │                  │               │
   │            │ "Enrich..."   │                 │                  │               │
   │            ├──────────┐    │                 │                  │               │
   │            │          │    │                 │                  │               │
   │            │<─────────┘    │                 │                  │               │
   │            │               │                 │                  │               │
   │ Press Enter│               │                 │                  │               │
   ├────────────>               │                 │                  │               │
   │            │               │                 │                  │               │
   │            │ execute()     │                 │                  │               │
   │            ├───────────────>                 │                  │               │
   │            │               │                 │                  │               │
   │            │               │ inferTaskType() │                  │               │
   │            │               ├────────┐        │                  │               │
   │            │               │        │        │                  │               │
   │            │               │<───────┘        │                  │               │
   │            │               │ → "enrich"      │                  │               │
   │            │               │                 │                  │               │
   │            │               │ readFileByPath(currentNote)        │               │
   │            │               ├───────────────────────────────────────────────────>
   │            │               │                 │                  │               │
   │            │               │ noteContent     │                  │               │
   │            │               │<───────────────────────────────────────────────────
   │            │               │                 │                  │               │
   │            │               │ search(query + title, topK=7)      │               │
   │            │               ├─────────────────>                  │               │
   │            │               │                 │                  │               │
   │            │               │ relatedNotes[]  │                  │               │
   │            │               │<─────────────────                  │               │
   │            │               │                 │                  │               │
   │            │               │ buildSystemPrompt()                │               │
   │            │               ├────────┐        │                  │               │
   │            │               │        │        │                  │               │
   │            │               │<───────┘        │                  │               │
   │            │               │                 │                  │               │
   │            │               │ stream(messages)│                  │               │
   │            │               ├─────────────────────────────────────>              │
   │            │               │                 │            POST /v1/chat/completions
   │            │               │                 │            stream: true
   │            │               │                 │            temp: 0.7
   │            │               │                 │                  │               │
   │            │               │ chunk "Based"   │                  │               │
   │            │<───────────────────────────────────────────────────                │
   │ "Based"    │               │                 │                  │               │
   │<────────────               │                 │                  │               │
   │            │               │ chunk " on"     │                  │               │
   │            │<───────────────────────────────────────────────────                │
   │ " on"      │               │                 │                  │               │
   │<────────────               │                 │                  │               │
   │            │               │                 │                  │               │
   │         [Streaming continues...]            │                  │               │
   │            │               │                 │                  │               │
   │            │               │ complete(actionPlanPrompt)         │               │
   │            │               ├─────────────────────────────────────>              │
   │            │               │                 │            POST /v1/chat/completions
   │            │               │                 │            stream: false
   │            │               │                 │            temp: 0.7
   │            │               │                 │                  │               │
   │            │               │ {"actions": [...]}                 │               │
   │            │               │<─────────────────────────────────────              │
   │            │               │                 │                  │               │
   │            │               │ parseActionPlan()                  │               │
   │            │               ├────────┐        │                  │               │
   │            │               │        │        │                  │               │
   │            │               │<───────┘        │                  │               │
   │            │               │                 │                  │               │
   │            │ result        │                 │                  │               │
   │            │ {text, citations, actions}      │                  │               │
   │            │<───────────────                 │                  │               │
   │            │               │                 │                  │               │
   │ Display    │               │                 │                  │               │
   │ Actions    │               │                 │                  │               │
   │<────────────               │                 │                  │               │
```

---

## Performance & Optimization

### Bottlenecks

**Indexing:**
- ⚠️ Ollama embedding speed (2-5min for 1000 notes)
- ✅ Chunking is fast (pure JS)
- ✅ Storage is fast (JSON serialization)

**Search:**
- ✅ Vector search is instant (<50ms for 10k chunks)
- ⚠️ LLM reranking adds ~1-2s
- ✅ Caching eliminates repeat queries

**Chat:**
- ⚠️ LLM streaming speed (20-50 tokens/sec)
- ⚠️ Context size limits responses
- ✅ Sliding window keeps history manageable

### Optimization Strategies

**1. Batch Embeddings**
```typescript
const EMBED_BATCH_SIZE = 4; // Optimal for most systems
```

**2. Hierarchical Search**
- Stage 1: Note-level (fast, wide net)
- Stage 2: Block-level (precise, within candidates)

**3. Caching**
- Query cache (5min TTL)
- Embedding cache (LRU, 100 queries)

**4. UI Yielding**
```typescript
await yieldToUI(); // Every 5 notes during indexing
```

**5. Streaming**
- Chat uses SSE streaming
- User sees tokens as they arrive
- Abortable mid-stream

### Performance Metrics

**Full Vault Indexing (1000 notes, ~5000 chunks):**
- Chunking: 15-30s
- Embedding: 2-5min (depends on Ollama)
- Storage: 5-10s
- **Total: ~3-6min**

**Incremental Update (1 note, ~10 chunks):**
- Detection: <100ms
- Chunking: <500ms
- Embedding: 1-3s
- Storage: <100ms
- **Total: ~2-4s**

**Search (10k chunks, reranking enabled):**
- Query embedding: ~100ms
- Vector search: ~50ms
- Reranking: ~1-2s
- **Total: ~1.2-2.2s**

**Chat (with RAG):**
- Query embedding: ~100ms
- Search: ~1-2s
- LLM response: ~10-30s (streaming)
- Action plan: ~5-10s
- **Total: ~16-42s**

---

## Security & Privacy

### Threat Model

**Assumptions:**
- ✅ User trusts Ollama and LM Studio (running locally)
- ✅ No external API calls
- ✅ No telemetry
- ✅ No analytics

**Risks:**
- ⚠️ LLM hallucination (mitigated by validation)
- ⚠️ Malicious prompt injection (mitigated by fixed prompts)
- ⚠️ Action execution bugs (mitigated by user approval)

### Data Flow Analysis

**What Stays Local:**
- ✅ All note content
- ✅ All embeddings
- ✅ All search results
- ✅ All chat history

**What Goes to Localhost:**
- ⚠️ Note chunks → Ollama (localhost:11434)
- ⚠️ Prompts + context → LM Studio (localhost:1234)

**What NEVER Leaves Machine:**
- ✅ File paths
- ✅ Frontmatter
- ✅ Metadata
- ✅ User queries

### Action Safety

**Risk Levels:**
- **Low:** Frontmatter changes, append content
- **Medium:** Move notes, add links
- **High:** (Reserved for future: merge, delete)

**Safety Mechanisms:**
1. **No Auto-Apply:** All actions require user approval
2. **Target Override:** Actions can't target other notes
3. **File Type Check:** Only .md files allowed
4. **Payload Validation:** Type-specific checks
5. **Risk Override:** Risk level enforced by code, not LLM

### Prompt Injection Defense

**Fixed Prompts:**
- System prompts are hardcoded
- No user-controlled prompt templates
- No dynamic prompt generation

**Input Sanitization:**
- String truncation (max lengths enforced)
- JSON validation (strict parsing)
- Type checking (all fields validated)

---

## Troubleshooting

### Ollama Issues

**"Ollama not connected"**
1. Check Ollama is running: `ollama list`
2. Check host: `http://localhost:11434/api/tags`
3. Verify model is pulled: `ollama pull nomic-embed-text`

**"Model not loaded"**
- Ollama auto-loads on first request
- Check logs: `journalctl -u ollama -f`

**"Embeddings dimension mismatch"**
1. Full reindex required
2. Settings → Index Options → "Rebuild Entire Index"
3. Old index incompatible with new model

### LM Studio Issues

**"LM Studio not connected"**
1. Launch LM Studio
2. Go to "Local Server" tab
3. Click "Start Server"
4. Verify: `curl http://localhost:1234/v1/models`

**"Model not loaded"**
1. LM Studio doesn't auto-load models
2. Manually load model in UI
3. Check green "Model Loaded" indicator

**"Chat completions empty"**
- Model might not support chat format
- Try different model (e.g., Mistral, Llama)
- Check LM Studio logs for errors

### Index Issues

**"Search returns no results"**
1. Check index exists: `.obsidian/plugins/notient/data/index-*.json`
2. Run manual sync: Settings → "Sync Index Now"
3. Check excluded folders (might be hiding notes)

**"Index is corrupted"**
1. Settings → Index Options → "Rebuild Entire Index"
2. Wait for completion (can take 5-10min)
3. Check browser console for errors

**"Index is huge (>100MB)"**
- Normal for large vaults (10k+ notes)
- Embeddings are ~3KB each
- 10,000 notes × 10 chunks × 3KB = ~300MB

### Performance Issues

**"Indexing is slow"**
- Check Ollama performance: GPU vs CPU
- Reduce batch size: `EMBED_BATCH_SIZE = 2`
- Exclude large folders: Settings → Indexing → Excluded Folders

**"Search is slow"**
- Disable reranking: Settings → Search → Preset = "quick"
- Reduce topK: Settings → Search → Custom → Top K = 5
- Check LM Studio is using GPU

**"Chat is slow"**
- Check LM Studio model size (3B models are fastest)
- Enable GPU acceleration in LM Studio
- Reduce context: Settings → Advanced → Keep Alive = 1m

---

## Appendix: File References

### Core Files

**LLM Providers:**
- `src/core/llm/provider.ts` - LLMProvider interface
- `src/core/llm/providers/openai-compatible.ts` - Base implementation
- `src/core/llm/providers/lmstudio.ts` - LM Studio wrapper
- `src/core/llm/types.ts` - Shared types

**Agent:**
- `src/core/agent/agentLoop.ts` - Main orchestration
- `src/core/agent/promptBuilder.ts` - System prompt generation
- `src/core/agent/taskInference.ts` - Task type classification

**Indexing:**
- `src/core/indexer/simpleIndexer.ts` - Index orchestration
- `src/core/indexer/tieredSemanticChunker.ts` - TSI v2 chunking
- `src/services/ollama.ts` - Ollama embedding service

**Search:**
- `src/core/search/pipeline.ts` - Search + RAG
- `src/services/simpleVectorStore.ts` - Vector storage

**Intelligence:**
- `src/core/intelligence/noteIntelligence.ts` - Background intelligence

**UI:**
- `src/views/sidebar/components/QuickActions.ts` - "Enhance" button
- `src/views/sidebar.ts` - Main sidebar view

---

## Conclusion

Notient's AI architecture is designed for:
- **Privacy:** 100% local processing
- **Transparency:** Auditable prompts and requests
- **Safety:** User approval for all actions
- **Performance:** Hierarchical search, caching, batching
- **Extensibility:** Clean provider abstraction

**Key Takeaways:**
1. Embeddings are fast and deterministic (Ollama)
2. Chat is configurable but not exposed to users (LM Studio)
3. Search uses 2-stage hierarchical retrieval + optional reranking
4. Agent uses RAG with precise citations
5. All actions require user approval
6. No data ever leaves your machine

**Next Steps:**
1. Add advanced configuration panel
2. Expose temperature/top_p/top_k settings
3. Add custom system prompt templates
4. Implement multi-provider support (Ollama chat, OpenAI, etc.)
5. Add telemetry toggle for usage analytics (opt-in)

---

**Document Version:** 2.0
**Last Updated:** 2026-01-07
**Maintainer:** Notient Development Team
**License:** MIT
