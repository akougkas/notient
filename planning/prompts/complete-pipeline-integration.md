# Task: Complete Notient Pipeline Integration & Fix Broken Features

## Project Context

**Notient** is an Obsidian plugin for AI-powered vault management using local LLMs only.

- **Location:** `/home/akougkas/projects/notient`
- **Build:** `./dev.sh --reset` (uses Bun)
- **Environment:** WSL2 → Windows Obsidian
- **Test Vault:** ~930 markdown notes

### Infrastructure

| Service | Host | Model | Purpose |
|---------|------|-------|---------|
| Ollama | `http://192.168.86.249:11434` | Various embedding models | Embeddings (384-4096 dims) |
| LM Studio | `http://192.168.86.249:1234/v1` | `ministral-3-14b` | Reasoning/Processing |

---

## Previous Session Summary

We successfully simplified the vector indexing system by:

1. **Replaced Orama** with a custom brute-force cosine similarity `SimpleVectorStore` (pure JS, zero native dependencies)
2. **Simplified chunking** in `simpleChunker.ts` - splits by headings, preserves frontmatter
3. **Streamlined pipeline** with `SimpleIndexer` - no JobQueue, simple async batches with UI yields
4. **Added IndexManager** for state tracking and multi-model support
5. **Cleaned up** old code (Orama, JobQueue, complex pipeline)

The indexing now completes successfully (~930 notes indexed). However, the **end-to-end pipeline is broken**.

---

## Current Problems (Must Fix)

### 1. Related Notes Sidebar Shows "unavailable - complete setup first"

Despite indexing being complete and Obsidian restarted, the sidebar shows this message.

**Root cause analysis:**
- `sidebar.ts` line 226-234 checks `!this.searchPipeline || !this.kernel.capabilities.search`
- Views are registered in `registerViews()` at line 237-246 in `main.ts` 
- BUT `this.searchPipeline` is passed as `null` because services initialize AFTER views are registered
- The view constructor captures `searchPipeline` at creation time, not dynamically

**Evidence in code:**
```typescript
// main.ts line 239-241
this.registerView(VIEW_TYPE_SIDEBAR, (leaf) => {
  return new NotientSidebarView(leaf, this.kernel, this.searchPipeline); // <-- null at this point!
});
```

### 2. Search Doesn't Work

Same root cause - the `searchPipeline` reference is captured as `null` when the view is created.

### 3. Services Not Properly Wired

The initialization order creates a timing problem:
1. `onload()` → `registerViews()` (searchPipeline is null)
2. `setTimeout(() => initializeServicesAsync(), 1000)` → creates searchPipeline
3. Views never get the updated reference

---

## What Needs to Be Fixed

### Phase 1: Fix View-Service Wiring (Critical)

The core problem is that views capture service references at construction time. Options:

**Option A: Lazy Service Resolution**
- Views get services from kernel on-demand instead of constructor injection
- Example: `this.kernel.getService<SearchPipeline>('search')?.search(query)`

**Option B: Observable Service Registry**
- Views subscribe to service availability
- Re-render when services become available

**Option C: Defer View Registration**
- Only register views after services are initialized
- Show loading state until ready

**Recommended: Option A** - simplest, most idiomatic for Obsidian plugins.

### Phase 2: Verify Search Pipeline Works

Once wiring is fixed, verify:
1. Query embedding works (Ollama embed)
2. Vector store search returns results
3. Results are properly grouped by note
4. Related notes finds similar content (excludes self)

Add logging at each step to diagnose issues.

### Phase 3: Improve Chunking Strategy

Current chunker (`simpleChunker.ts`) is basic. For better semantic search quality:

1. **Preserve document structure** - frontmatter, title, headings should always be searchable
2. **Smart chunk boundaries** - don't split mid-sentence or mid-paragraph
3. **Context chunks** - first chunk should always have title + frontmatter + summary
4. **Section awareness** - heading path helps users understand context in results
5. **Code block handling** - don't split code blocks
6. **Frontmatter extraction** - parse YAML properly, handle arrays/objects

### Phase 4: Consider Better Search Algorithms

Current brute-force cosine similarity is O(n) per query. For 50K vectors this is ~20ms which is fine.

For future scalability (100K+ vectors), consider:
- **IVF (Inverted File Index)** - cluster vectors, search nearby clusters only
- **Product Quantization** - compress vectors, trade accuracy for speed
- **Locality-Sensitive Hashing** - hash similar vectors to same buckets

For now, brute-force is acceptable. Focus on search quality over speed.

---

## The Bigger Picture: Note Processing Pipeline

The vector embeddings are just ONE component of the full Notient system. The complete pipeline is:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         NOTIENT NOTE PROCESSING PIPELINE                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────┐    ┌──────────┐    ┌───────────┐    ┌──────────────────────┐  │
│  │ Vault    │───▶│ Chunking │───▶│ Embedding │───▶│ Vector Store         │  │
│  │ Scanner  │    │          │    │ (Ollama)  │    │ (SimpleVectorStore)  │  │
│  └──────────┘    └──────────┘    └───────────┘    └──────────┬───────────┘  │
│                                                               │              │
│  ┌────────────────────────────────────────────────────────────┘              │
│  │                                                                           │
│  ▼                                                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                     QUERY & RETRIEVAL LAYER                          │   │
│  │                                                                       │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │   │
│  │  │  Semantic   │  │  Related    │  │  Similar    │  │  Cluster    │  │   │
│  │  │  Search     │  │  Notes      │  │  Topics     │  │  Analysis   │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘  │   │
│  │                                                                       │   │
│  └───────────────────────────────────┬──────────────────────────────────┘   │
│                                      │                                       │
│                                      ▼                                       │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                     LLM REASONING LAYER                              │   │
│  │                     (LM Studio - ministral-3-14b)                    │   │
│  │                                                                       │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │   │
│  │  │  Note       │  │  Frontmatter│  │  Tag        │  │  Link       │  │   │
│  │  │  Summary    │  │  Generation │  │  Suggestion │  │  Discovery  │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘  │   │
│  │                                                                       │   │
│  └───────────────────────────────────┬──────────────────────────────────┘   │
│                                      │                                       │
│                                      ▼                                       │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                     OUTPUT LAYER                                     │   │
│  │                                                                       │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │   │
│  │  │  Sidebar    │  │  Dashboard  │  │  Frontmatter│  │  Vault      │  │   │
│  │  │  (Related)  │  │  (Vitals)   │  │  Updates    │  │  Operations │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘  │   │
│  │                                                                       │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### What Embeddings Enable

The vector embeddings power multiple features:

1. **Related Notes** (sidebar) - find semantically similar notes to current note
2. **Semantic Search** - search by meaning, not just keywords
3. **Link Discovery** - suggest wikilinks to related content
4. **Backlink Enhancement** - find notes that SHOULD link here but don't
5. **Topic Clustering** - group notes by semantic similarity
6. **Classification** - auto-categorize notes (PARA, themes, areas)
7. **Duplicate Detection** - find near-duplicate content

### What LLM Reasoning Enables

The LM Studio reasoning model powers:

1. **Frontmatter Generation** - create/update rich frontmatter (see target format below)
2. **Summary Generation** - create concise summaries
3. **Tag Suggestions** - intelligent tag recommendations based on content + related notes
4. **Quality Assessment** - rate notes (value, certainty, permanence)
5. **Agent Operations** - move, merge, archive notes with understanding

---

## Target Frontmatter Format

The ultimate goal is to generate and maintain rich frontmatter like this:

```yaml
---
title: 'The agentic organization: Contours of the next paradigm for the AI era'
type: web-clip
source: https://www.mckinsey.com/capabilities/people-and-organizational-performance/our-insights/the-agentic-organization-contours-of-the-next-paradigm-for-the-ai-era#/
domain: mckinsey.com
site: McKinsey & Company
author:
- Alexander Sukharevsky
- Alexis Krivkovich
- Arne Gast
- Arsen Storozhev
- Dana Maor
- Deepak Mahadevan
- Lari Hämäläinen
- Sandra Durth
published: 2025-09-26
tags:
- clippings
- ai-agents
- agentic-organization
- ai-native-channels
- guardrail-agents
- microservices
- data-products
- ai
- agents
- topics/artificial_intelligence
- contexts/professional
- paradigms/organizational_transformation
- applications/business_strategy
clipped: 2025-10-13 20:40:33-05:00
wordcount: '3177'
value: gold                    # gold | silver | bronze | unrated
certainty: likely              # certain | likely | possible | speculative
permanence: temporal           # evergreen | temporal | ephemeral
source_type: web               # web | book | paper | video | podcast | original
ingested: 2025-10-13
processed: '2026-01-05'
distilled: null
last_referenced: null
sensitive: false
rating: 7                      # 1-10 quality score
original: Agentic organization contours of the next paradigm for the AI era.md
themes:
- ai
areas:
- professional
summary: Explores the 'agentic organization' paradigm—a revolutionary AI-driven model integrating human and AI agents for scalable, near-zero-cost collaboration.
related:
- '[[ai4science_references]]'
- '[[gemini-slides-v3]]'
- '[[Stop Calling Workflows 'Agents' – A Guide to Real Agentic AI]]'
---
```

### Frontmatter Fields

| Field | Source | Description |
|-------|--------|-------------|
| `title` | Extracted/User | Clean title without file extension |
| `type` | LLM Classification | note, web-clip, reference, project, etc. |
| `source` | Extracted | URL or reference for clippings |
| `domain`, `site` | Extracted | From source URL |
| `author` | Extracted/LLM | Author(s) as array |
| `published` | Extracted | Publication date |
| `tags` | LLM + User | Hierarchical tags with namespaces |
| `wordcount` | Computed | Automatic |
| `value` | LLM Assessment | gold/silver/bronze/unrated |
| `certainty` | LLM Assessment | How confident is the information |
| `permanence` | LLM Assessment | How timeless is the content |
| `source_type` | LLM Classification | Type of source |
| `ingested` | Automatic | When note was created |
| `processed` | Automatic | Last AI processing date |
| `distilled` | Automatic | When summary was created |
| `rating` | LLM + User | 1-10 quality score |
| `themes` | LLM Classification | High-level topics |
| `areas` | LLM Classification | PARA areas |
| `summary` | LLM Generated | Concise summary |
| `related` | **From Embeddings** | Wikilinks to similar notes |

**Key insight:** The `related` field is populated using the vector embeddings! This is why the embedding pipeline must work correctly.

---

## Implementation Tasks

### Immediate Priority (Fix What's Broken)

1. **Fix view-service wiring** - Views should get services dynamically
   - Modify `NotientSidebarView` to use `kernel.getService()` instead of constructor injection
   - Same for `NotientDashboardView`
   
2. **Add service availability detection** - Show "loading" or "initializing" instead of "unavailable"
   - Check if services are still initializing vs actually unavailable
   
3. **Verify search end-to-end** - Add detailed logging
   - Log query → embedding → search → results at each step
   - Verify chunks are actually in the vector store after indexing

### Medium Priority (Improve Quality)

4. **Enhance chunker** for markdown/Obsidian notes
   - Better frontmatter parsing (handle all YAML types)
   - Code block awareness
   - Better sentence boundary detection
   - Create "context chunk" that includes title + summary for every note
   
5. **Improve search result quality**
   - Filter out low-quality matches
   - Boost matches in same folder
   - Boost matches with shared tags
   - Consider title matches specially

### Future Priority (Complete Pipeline)

6. **Note processing pipeline** (Phase 2 features)
   - LLM-powered frontmatter generation
   - Summary generation
   - Tag suggestions
   - Link discovery
   
7. **Agent capabilities** (Phase 3 features)
   - Vault operations with confirmation
   - Batch processing

---

## Files to Examine/Modify

### Fix View-Service Wiring

```
src/views/sidebar.ts      # Fix to use dynamic service lookup
src/views/dashboard.ts    # Same fix
src/main.ts               # Review initialization order
```

### Verify Search Works

```
src/core/search/pipeline.ts        # Search implementation
src/services/simpleVectorStore.ts  # Vector search
src/services/indexManager.ts       # State management
```

### Improve Chunking

```
src/core/indexer/simpleChunker.ts  # Chunking logic
src/types/indexer.ts               # Chunk types
```

### Add Note Processing (Future)

```
src/core/processing/              # New directory for LLM processing
  noteProcessor.ts               # Main orchestrator
  frontmatterGenerator.ts        # Frontmatter creation/update
  summarizer.ts                  # Summary generation
  tagSuggester.ts                # Tag recommendations
  linkDiscovery.ts               # Related note linking
```

---

## Testing Strategy

1. **Console logging** - Add `console.log` at key points during development
2. **Debug command** - Create a "debug diagnostics" command that dumps:
   - Service health status
   - Vector store stats (chunk count, note count)
   - Index manager state
   - Sample search result
3. **Verify in UI** - After fixes:
   - Sidebar should show related notes
   - Search should return results
   - No "unavailable" messages after setup

---

## Success Criteria

1. ✅ Related notes appear in sidebar when viewing any indexed note
2. ✅ Semantic search returns relevant results
3. ✅ Search results show note title, path, and preview
4. ✅ Related notes excludes the current note
5. ✅ UI stays responsive during all operations
6. ✅ Services reconnect gracefully after Ollama restart
7. ✅ No "unavailable" messages when services are healthy

---

## Additional Context

### Key Patterns in Codebase

- **Kernel** is the service container - access services via `kernel.getService<T>(name)`
- **EventBus** for decoupled communication - `kernel.eventBus.emit()` / `.on()`
- **ObsidianFacade** wraps Obsidian API - use for file operations
- **StoragePaths** manages all file paths - consistent location handling

### Important Constraints

1. **No native dependencies** - Must work in Electron/Obsidian
2. **Non-blocking UI** - Always yield during long operations
3. **Local only** - No cloud APIs, ever
4. **Human-in-control** - Suggest, don't auto-modify without confirmation

---

## Start Here

1. Read `src/views/sidebar.ts` to understand the related notes flow
2. Read `src/main.ts` initialization order
3. Fix the service wiring (Option A: lazy resolution)
4. Test search with console logging
5. Iterate on chunking quality based on search results

---

*Last updated: 2026-01-06*
*Previous session: simplify-vector-indexing.md*
