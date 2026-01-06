# SESSION PROMPT: Notient Phase 1.5 - Architectural Reset

> **Mission:** Transform Notient from a broken search MVP into an intelligent vault assistant that competes with Smart Connections v4.

## Context

You are working on **Notient**, a local-first Obsidian AI plugin. The codebase has foundational issues that must be fixed before adding new capabilities. This session executes a comprehensive architectural reset.

**Repository:** `/home/akougkas/projects/notient`

**Constitutional Documents (READ THESE FIRST):**
- `planning/PRD.md` - Product requirements v2.0
- `planning/prompts/bootstrap.md` - Master plan v2.0

## Current State Assessment

### What Works
- Plugin loads, settings persist
- Ollama embeddings functional
- Vector store (brute-force cosine) works
- Basic search returns results
- Health monitoring for services
- Setup wizard complete

### What's Broken (CRITICAL)

1. **Debug Telemetry Shipped** - 3 locations sending data to external endpoint
   - `src/core/search/pipeline.ts` lines 88-103
   - `src/services/simpleVectorStore.ts` lines 261-290, 450-454
   - `src/core/indexer/simpleIndexer.ts` lines 424-432

2. **LM Studio Never Used** - Configured in settings but zero API calls
   - No `LMStudioService` class exists
   - No reasoning/reranking/chat functionality
   - Health check works, but that's all

3. **Dual Note ID Bug** - Two different hash algorithms
   - `IndexManager.generateNoteId()` uses simple hash
   - `simpleChunker.generateNoteId()` uses SHA256
   - Causes `trimIndex()` to delete wrong entries

4. **Search is Meaningless** - Just similarity percentages
   - No LLM reranking
   - No query understanding
   - No vault context awareness

5. **No Chat Interface** - Competition has this
   - Sidebar is search-only
   - No conversation capability
   - No RAG pipeline

## Strategic Decisions (FROM INTERVIEW)

| Decision | Choice |
|----------|--------|
| Embedding granularity | **Hybrid** - note-level + section-level |
| LM Studio role | **Phased** - search orchestrator → classifier → chat |
| Vault awareness | **Dynamic context** - built per query |
| Primary UX | **Dual panels** - search + chat both visible |
| Search ranking | **LLM reranking** - vector top-50 → LM sorts |
| Agent autonomy | **Trust levels** - low/medium/high risk |
| Observability | **Console-only** - remove all debug telemetry |

## Execution Plan

### Phase 1: Clean House (FIRST PRIORITY)

**1.1 Remove Debug Telemetry**

Delete all `fetch()` calls in `#region agent log` blocks:

```typescript
// REMOVE blocks like this:
// #region agent log
fetch('http://127.0.0.1:7243/ingest/...', {...}).catch(()=>{});
// #endregion
```

Files to clean:
- [ ] `src/core/search/pipeline.ts` - 2 blocks
- [ ] `src/services/simpleVectorStore.ts` - 3 blocks
- [ ] `src/core/indexer/simpleIndexer.ts` - 1 block

Also remove debug counters:
- `_debugCosineCount` in simpleVectorStore.ts
- `_embedLogCount` in simpleIndexer.ts
- `resetDebugCounters()` method

**1.2 Fix Note ID Generation**

Unify on ONE algorithm. Use the chunker's SHA256 approach:

```typescript
// In indexManager.ts, REPLACE generateNoteId with import from simpleChunker
import { generateNoteId } from "../core/indexer/simpleChunker";

// DELETE the local generateNoteId method (lines 379-388)
```

**1.3 Clean Console Logging**

Keep informative logs, remove noisy ones:
- Keep: Service initialization, errors, major state changes
- Remove: Per-document scoring details, embedding statistics

### Phase 2: Implement LMStudioService

Create `src/services/lmstudio.ts`:

```typescript
/**
 * LM Studio Reasoning Service
 *
 * Provides chat completions via OpenAI-compatible API.
 * Used for: search reranking, note classification, chat.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RankedResult {
  noteId: string;
  path: string;
  title: string;
  score: number;
  reasoning: string;  // WHY this result is relevant
}

export class LMStudioService {
  private baseUrl: string;
  private model: string;
  private disposed = false;

  constructor(private kernel: Kernel) {}

  async initialize(): Promise<void> {
    const settings = this.kernel.settings;
    this.baseUrl = settings.lmstudio.host;
    this.model = settings.lmstudio.reasoningModel;

    // Verify connectivity
    await this.listModels();
  }

  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/v1/models`);
    const data = await response.json();
    return data.data.map((m: { id: string }) => m.id);
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.7,
        max_tokens: 1000,
      }),
    });

    const data = await response.json();
    return data.choices[0].message.content;
  }

  async *chatStream(messages: ChatMessage[]): AsyncIterable<string> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.7,
        max_tokens: 1000,
        stream: true,
      }),
    });

    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      // Parse SSE format
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          const json = JSON.parse(line.slice(6));
          const content = json.choices?.[0]?.delta?.content;
          if (content) yield content;
        }
      }
    }
  }

  async rerank(
    query: string,
    candidates: Array<{ path: string; title: string; text: string; score: number }>
  ): Promise<RankedResult[]> {
    const prompt = this.buildRerankPrompt(query, candidates);
    const response = await this.chat([
      { role: "system", content: RERANK_SYSTEM_PROMPT },
      { role: "user", content: prompt }
    ]);
    return this.parseRerankResponse(response, candidates);
  }

  private buildRerankPrompt(query: string, candidates: Array<{...}>): string {
    // Build structured prompt for reranking
    // See prompt templates below
  }

  dispose(): void {
    this.disposed = true;
  }
}

const RERANK_SYSTEM_PROMPT = `You are a search relevance expert. Given a query and candidate documents, rank them by relevance. For each document, provide:
1. A relevance score (0-100)
2. A brief reason why it's relevant or not

Respond in JSON format:
{
  "rankings": [
    { "index": 0, "score": 95, "reason": "Directly answers the query" },
    { "index": 2, "score": 80, "reason": "Related topic, partial match" }
  ]
}`;
```

### Phase 3: Hybrid Vector Store

Modify `src/services/simpleVectorStore.ts` OR create new `hybridVectorStore.ts`:

**Schema change:**

```typescript
interface HybridDoc {
  noteId: string;
  path: string;
  title: string;

  // Note-level embedding (whole content)
  noteEmbedding: Float32Array;
  noteText: string;  // First N chars for context

  // Section-level embeddings
  sections: Array<{
    sectionId: string;
    heading: string;
    chunkIndex: number;
    text: string;
    embedding: Float32Array;
  }>;

  // Metadata
  mtimeMs: number;
  contentHash: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
}
```

**Search change:**

```typescript
async search(queryEmbedding: number[], options: SearchOptions): Promise<SearchResult[]> {
  // 1. Score note-level embeddings (broad match)
  const noteScores = this.scoreNoteLevel(queryEmbedding);

  // 2. Score section-level embeddings (precise match)
  const sectionScores = this.scoreSectionLevel(queryEmbedding);

  // 3. Combine scores (note gets weight, sections refine)
  const combined = this.combineScores(noteScores, sectionScores);

  // 4. Return top-50 for LLM reranking
  return combined.slice(0, 50);
}
```

### Phase 4: Search Pipeline with Reranking

Modify `src/core/search/pipeline.ts`:

```typescript
async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
  // Phase 1: Vector search (fast)
  const queryEmbedding = await this.getQueryEmbedding(query);
  const vectorResults = await this.vectorStore.search(queryEmbedding, {
    ...options,
    topK: 50,  // Get more for reranking
  });

  // Phase 2: LLM reranking (smart)
  const lmStudio = this.kernel.getService<LMStudioService>("lmstudio");
  if (lmStudio && vectorResults.length > 0) {
    const reranked = await lmStudio.rerank(query, vectorResults);
    return reranked.slice(0, options.topK);
  }

  // Fallback: return vector results if LM Studio unavailable
  return vectorResults.slice(0, options.topK);
}
```

### Phase 5: Vault Context Builder

Create `src/core/context/vaultContextBuilder.ts`:

```typescript
/**
 * Builds dynamic vault context for LLM prompts.
 * Context is relevant to the specific query/candidates.
 */

export interface VaultContext {
  // Structural context
  relevantFolders: string[];
  activeTags: string[];
  paraDistribution: Record<ParaType, number>;

  // Graph context
  linkedNotes: string[];  // 1-hop from candidates

  // Temporal context
  recentlyModified: string[];  // In relevant folders

  // Summary
  contextSummary: string;  // Human-readable for LLM
}

export class VaultContextBuilder {
  constructor(private kernel: Kernel) {}

  buildForQuery(query: string, candidates: SearchResult[]): VaultContext {
    // Extract folders from candidates
    const folders = this.extractFolders(candidates);

    // Extract tags from candidates
    const tags = this.extractTags(candidates);

    // Get linked notes (1-hop)
    const linked = this.getLinkedNotes(candidates);

    // PARA distribution
    const para = this.getParaDistribution(candidates);

    // Recent in relevant folders
    const recent = this.getRecentInFolders(folders);

    // Build summary
    const summary = this.buildSummary(folders, tags, para, candidates.length);

    return {
      relevantFolders: folders,
      activeTags: tags,
      paraDistribution: para,
      linkedNotes: linked,
      recentlyModified: recent,
      contextSummary: summary,
    };
  }

  private buildSummary(...args): string {
    return `Your vault has ${args.noteCount} potentially relevant notes across ${args.folders.length} folders. Common tags: ${args.tags.join(", ")}. PARA distribution: ${JSON.stringify(args.para)}.`;
  }
}
```

### Phase 6: Dual-Panel Sidebar

Redesign `src/views/sidebar.ts`:

```typescript
export class NotientSidebarView extends ItemView {
  private searchPanel: HTMLElement;
  private chatPanel: HTMLElement;
  private chatMessages: ChatMessage[] = [];

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("notient-sidebar");

    // Status bar
    this.renderStatus(container);

    // Search panel (top 40%)
    this.searchPanel = container.createDiv({ cls: "notient-search-panel" });
    this.renderSearchPanel();

    // Divider (draggable later)
    container.createDiv({ cls: "notient-panel-divider" });

    // Chat panel (bottom 60%)
    this.chatPanel = container.createDiv({ cls: "notient-chat-panel" });
    this.renderChatPanel();
  }

  private renderSearchPanel(): void {
    // Search input
    const input = this.searchPanel.createEl("input", {
      type: "text",
      placeholder: "Search your vault...",
      cls: "notient-search-input"
    });

    // Results container
    const results = this.searchPanel.createDiv({ cls: "notient-search-results" });

    // Wire up search with debounce
    input.addEventListener("input", debounce(async (e) => {
      const query = (e.target as HTMLInputElement).value;
      if (query.length >= 2) {
        const searchResults = await this.performSearch(query);
        this.renderSearchResults(results, searchResults);
      }
    }, 300));
  }

  private renderChatPanel(): void {
    // Chat header
    this.chatPanel.createEl("div", {
      cls: "notient-chat-header",
      text: "💬 Chat with your vault"
    });

    // Messages container
    const messages = this.chatPanel.createDiv({ cls: "notient-chat-messages" });

    // Input area
    const inputArea = this.chatPanel.createDiv({ cls: "notient-chat-input-area" });
    const chatInput = inputArea.createEl("textarea", {
      placeholder: "Ask a question about your notes...",
      cls: "notient-chat-input"
    });
    const sendBtn = inputArea.createEl("button", { text: "Send", cls: "notient-chat-send" });

    // Wire up chat
    sendBtn.addEventListener("click", () => this.sendChatMessage(chatInput, messages));
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendChatMessage(chatInput, messages);
      }
    });
  }

  private async sendChatMessage(input: HTMLTextAreaElement, container: HTMLElement): Promise<void> {
    const query = input.value.trim();
    if (!query) return;

    // Add user message
    this.addMessage(container, "user", query);
    input.value = "";

    // Get relevant notes via search
    const searchResults = await this.performSearch(query);

    // Build context
    const context = this.kernel.getService<VaultContextBuilder>("context")
      ?.buildForQuery(query, searchResults);

    // Get LM response
    const lmStudio = this.kernel.getService<LMStudioService>("lmstudio");
    if (!lmStudio) {
      this.addMessage(container, "assistant", "LM Studio not available. Please check settings.");
      return;
    }

    // Build RAG prompt
    const systemPrompt = this.buildSystemPrompt(context, searchResults);
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...this.chatMessages,
      { role: "user", content: query }
    ];

    // Stream response
    const responseEl = this.addMessage(container, "assistant", "");
    let fullResponse = "";

    for await (const chunk of lmStudio.chatStream(messages)) {
      fullResponse += chunk;
      responseEl.setText(fullResponse);
    }

    // Save to history
    this.chatMessages.push({ role: "user", content: query });
    this.chatMessages.push({ role: "assistant", content: fullResponse });
  }

  private buildSystemPrompt(context: VaultContext, results: SearchResult[]): string {
    const noteSummaries = results.slice(0, 5).map(r =>
      `- ${r.title} (${r.path}): ${r.chunks[0]?.text?.slice(0, 200) || ""}`
    ).join("\n");

    return `You are Notient, an AI assistant for the user's Obsidian vault.

VAULT CONTEXT:
${context.contextSummary}

RELEVANT NOTES:
${noteSummaries}

INSTRUCTIONS:
- Answer based on the user's notes when possible
- Cite specific notes using [Note Title] format
- If unsure, say so rather than making things up
- Be concise but helpful`;
  }
}
```

### Phase 7: Wire Everything Together

**In `main.ts`:**

```typescript
// Add LMStudioService initialization after OllamaService
this.lmStudioService = new LMStudioService(this.kernel);
await this.lmStudioService.initialize();
this.kernel.registerService("lmstudio", this.lmStudioService);

// Add VaultContextBuilder
this.contextBuilder = new VaultContextBuilder(this.kernel);
this.kernel.registerService("context", this.contextBuilder);
```

**In `kernel.ts`:**

Add to service registry switch:
```typescript
case "lmstudio": this.lmStudioService = service; break;
case "context": this.contextBuilder = service; break;
```

## CSS Updates

Add to `src/styles.css`:

```css
/* Dual-panel layout */
.notient-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.notient-search-panel {
  flex: 0 0 40%;
  overflow-y: auto;
  border-bottom: 1px solid var(--background-modifier-border);
}

.notient-panel-divider {
  height: 4px;
  background: var(--background-modifier-border);
  cursor: ns-resize;
}

.notient-chat-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.notient-chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: var(--size-4-2);
}

.notient-chat-input-area {
  display: flex;
  gap: var(--size-4-2);
  padding: var(--size-4-2);
  border-top: 1px solid var(--background-modifier-border);
}

.notient-chat-input {
  flex: 1;
  min-height: 60px;
  resize: none;
}

.notient-chat-message {
  margin-bottom: var(--size-4-2);
  padding: var(--size-4-2);
  border-radius: var(--radius-s);
}

.notient-chat-message.user {
  background: var(--background-secondary);
  margin-left: 20%;
}

.notient-chat-message.assistant {
  background: var(--background-primary-alt);
  margin-right: 20%;
}
```

## Testing Checklist

After implementation, verify:

- [ ] No debug `fetch()` calls in code
- [ ] `bun run build` succeeds without warnings
- [ ] Plugin loads in Obsidian
- [ ] Search returns results with LLM reasoning (if LM Studio running)
- [ ] Chat responds using vault context
- [ ] Sidebar shows both panels
- [ ] Indexing still works (hybrid embeddings)
- [ ] No data sent to external endpoints

## Success Criteria

**Phase 1.5 is COMPLETE when:**

1. ✅ All debug telemetry removed
2. ✅ Note ID generation unified
3. ✅ LMStudioService implemented and wired
4. ✅ Search uses LLM reranking
5. ✅ Dynamic vault context built per query
6. ✅ Dual-panel sidebar with search + chat
7. ✅ Chat answers questions with citations
8. ✅ Clean console-only logging

## Brand Guidelines

Remember Notient's differentiators:
- **Local-first:** Everything runs on user's machine
- **Human-centered:** User is always in control
- **Intelligent:** LLM-powered, not just vectors
- **Private:** Zero data leaves the machine
- **Simple:** Clean code, no over-engineering

---

## Revision 2: Post-Testing Feedback (2026-01-06)

### Issues Identified During Testing

#### 1. Index Detection False Positives
- **Problem:** Setup wizard reported "nomic text" index when it never existed
- **Root Cause:** Detection scans for `index-*.json` files but doesn't validate metadata
- **Fix Required:**
  - Add proper index metadata schema (model name, dimensions, creation date, note count)
  - Store metadata in dedicated `index-meta-{modelKey}.json` file
  - Validate index integrity before reporting to user
  - Show actual dimensions and model info in wizard

#### 2. Sidebar UX Issues - CRITICAL
- **Problem:** Cannot copy/paste text from sidebar panels
- **Problem:** Search and chat panels not visually distinct enough
- **Problem:** Only input boxes are interactive; everything else is "useless"
- **Fixes Required:**
  - Make all text selectable (remove `user-select: none`)
  - Add copy buttons to chat messages and search results
  - Add visual distinction between panels (headers, backgrounds, icons)
  - Make search results clickable to open notes
  - Add hover states and cursor feedback

#### 3. Lost Context Awareness - MAJOR
- **Problem:** Lost the "open note" concept that was central to UX
- **Missing Features:**
  - Related notes for currently open note
  - Note staleness indicators
  - Recommended actions based on note context
  - Open note awareness in chat/agent responses
- **Fixes Required:**
  - Re-implement `activeFile` tracking via `workspace.on('active-leaf-change')`
  - Show "Related Notes" section when a note is open
  - Add staleness indicator (days since modified, index status)
  - Add recommended actions (PARA suggestions, linking opportunities)
  - Pass open note context to agent/chat for awareness

#### 4. Index Action Ignored
- **Problem:** User didn't select rebuild but indexing was forced anyway
- **Root Cause:** `_pendingIndexAction` may not be preserving wizard selection properly
- **Fix Required:**
  - Debug the wizard result flow
  - Ensure "use_existing" action truly skips indexing
  - Log the index action at each stage for debugging

#### 5. Agent Context Integration
- **Problem:** Agent/chat not using full vault context awareness
- **Required Agent Context:**
  - Current open note (path, title, content)
  - Vault embeddings (relevant search results)
  - Previous chat history
  - User's PARA configuration
  - Note's frontmatter and tags
  - Linked notes (outgoing + backlinks)
- **Fix:** Build comprehensive `AgentContext` object for all LM Studio calls

### Action Log

| Date | Action | Status |
|------|--------|--------|
| 2026-01-06 | Initial Phase 1.5 implementation | ✅ Complete |
| 2026-01-06 | Revision 2 - Enhanced wizard with index detection | ✅ Complete |
| 2026-01-06 | Revision 2 - TypeScript fixes | ✅ Complete |
| 2026-01-06 | Revision 2 - Build verification | ✅ Complete |
| 2026-01-06 | User testing revealed 5 major issues | 📝 Documented |
| 2026-01-06 | Revision 3 - Fix sidebar UX (selectable, copyable) | ✅ Complete |
| 2026-01-06 | Revision 3 - Add copy buttons to chat/search | ✅ Complete |
| 2026-01-06 | Revision 3 - Make search results clickable | ✅ Complete |
| 2026-01-06 | Revision 3 - Restore open note context awareness | ✅ Complete |
| 2026-01-06 | Revision 3 - Add related notes (backlinks/outlinks) | ✅ Complete |
| 2026-01-06 | Revision 3 - Add staleness indicator | ✅ Complete |
| 2026-01-06 | Revision 3 - Add recommended actions | ✅ Complete |
| 2026-01-06 | Revision 3 - Fix index action flow | ✅ Complete |
| 2026-01-06 | Revision 3 - Pass open note to agent context | ✅ Complete |
| 2026-01-06 | Revision 3 - Build verification | ✅ Complete |
| 2026-01-06 | Revision 3 - Better index metadata | 🔄 Pending (future) |
| 2026-01-06 | Revision 4 - Fix LMStudio rerank parsing | ✅ Complete |
| 2026-01-06 | Revision 4 - Handle empty/truncated LLM responses | ✅ Complete |
| 2026-01-06 | Revision 4 - Simplify rerank prompt for smaller models | ✅ Complete |
| 2026-01-06 | Revision 4 - Add JSON repair for incomplete responses | ✅ Complete |
| 2026-01-06 | Revision 5 - Add isNoteIndexed() to IndexManager | ✅ Complete |
| 2026-01-06 | Revision 5 - Add debug logging for empty LLM responses | ✅ Complete |
| 2026-01-06 | Revision 6 - Complete rewrite of index detection | ✅ Complete |
| 2026-01-06 | Revision 6 - Use Obsidian adapter instead of Node fs | ✅ Complete |
| 2026-01-06 | Revision 6 - Fix meta reading from index files | ✅ Complete |
| 2026-01-06 | Revision 6 - Dimension compatibility checking | ✅ Complete |
| 2026-01-06 | Revision 6 - Auto-select compatible index after model selection | ✅ Complete |
| 2026-01-06 | Revision 6 - Build verification | ✅ Complete |

### Revision 6: Index Detection Overhaul (2026-01-06)

#### Root Cause Analysis
The index detection was fundamentally broken because:
1. **Using Node's fs module** instead of Obsidian's adapter (doesn't work properly in Obsidian)
2. **Reading wrong metadata location** - tried `indexData.modelKey` but data is at `indexData.meta.modelKey`
3. **Comparing against default settings model** ("nomic-embed-text") instead of selected model
4. **Checking compatibility before model was selected** - impossible to know dimensions

#### Fixes Applied
1. **Replaced Node fs with Obsidian adapter** - proper `app.vault.adapter.list()`, `.read()`, `.exists()`
2. **Fixed metadata reading** - now correctly reads from `indexData.meta.modelKey` and `indexData.meta.dimension`
3. **Deferred compatibility check** - indexes are scanned on wizard open, but compatibility is calculated ONLY after a model is selected
4. **Auto-selection logic** - when model is selected, automatically pick the best compatible index
5. **Visual dimension display** - show dimension badges on indexes (e.g., "768d", "1024d")
6. **Clear compatibility feedback** - red dashed border for incompatible, green highlight for compatible

#### Index File Structure Reference
```json
{
  "meta": {
    "version": 1,
    "modelKey": "nomic-embed-text",
    "dimension": 768,
    "docCount": 1234,
    "createdAt": 1704556800000
  },
  "docs": [...]
}
```

### Revision 3 Execution Plan

#### Priority 1: Sidebar UX Fixes
1. Remove `user-select: none` from all text elements
2. Add copy button to chat messages
3. Add copy button to search result snippets
4. Make search result titles clickable (opens note)
5. Add visual panel headers with icons

#### Priority 2: Open Note Context
1. Register `workspace.on('active-leaf-change')` event
2. Create `OpenNoteContext` interface
3. Show "Open Note" section at top of sidebar when note is active
4. Display: title, PARA type, staleness, related notes
5. Add recommended actions based on PARA type

#### Priority 3: Index Action Flow
1. Debug `_pendingIndexAction` preservation
2. Add logging at each stage
3. Ensure "use_existing" truly skips indexing
4. Verify "sync" only indexes changed notes

#### Priority 4: Agent Context
1. Create comprehensive `AgentContext` type
2. Pass open note to chat system prompt
3. Include search results as context
4. Add chat history (last N messages)
5. Include vault statistics

---

*This prompt is for the Notient Phase 1.5 Architectural Reset session.*
*Reference: planning/PRD.md v2.0, planning/prompts/bootstrap.md v2.0*
