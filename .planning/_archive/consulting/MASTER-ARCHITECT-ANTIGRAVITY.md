# MASTER-ARCHITECT-ANTIGRAVITY
> **Design Authority:** Antigravity (Google Deepmind / Agentic One)
> **Target:** Notient v1.0 ("The Sentient Chief of Staff")
> **Date:** 2026-01-12

## 1. Executive Summary: "The Shadow Brain"

The core failure of previous architectures was **Main Thread Contention**. By treating the plugin as a "Foreground Application" running logic alongside the UI, we inevitably blocked the unified Electron renderer process.

**The Solution:** The **"Shadow Brain" Architecture**.
We will decouple **Thought** from **Action**.
*   **The Face (UI):** A hyper-lightweight, 60fps Reactive View layer running on the Main Thread. It does *zero* heavy lifting.
*   **The Brain (Worker):** A massive, persistent Web Worker that houses the entire Agent Runtime, the Database, and the Vector Index.

This is not just "moving work to a thread." It is a fundamental inversion of control. The UI does not "command" the backend; it *subscribes* to it.

---

## 2. The Tech Stack (Uncompromising Performance)

| Layer | Technology | Justification |
| :--- | :--- | :--- |
| **Language** | **TypeScript (Strict)** | Non-negotiable for large-scale architecture. |
| **Runtime** | **Electron / Web Workers** | The only way to achieve non-blocking I/O in Obsidian. |
| **Data Core** | **SQLite (WASM) + NodeFS** | JSON is dead. `sqlite-wasm` offers SQL power without native node-module compilation hell. We use a custom VFS backed by `node:fs` for direct file access (bypassing slow browser storage like IndexedDB). |
| **Vector Engine** | **sqlite-vec (WASM)** | Integrated vector search within SQLite. Keeps metadata and embeddings strictly consistent (transactional). No "syncing". |
| **Query/ORM** | **Kysely** | A type-safe SQL query builder. Zero-overhead, unlike TypeORM/Prisma. |
| **Communication** | **Comlink** | Seamless RPC between Main Thread and Worker. Removes boilerplate message passing. |
| **UI State** | **Preact Signals** | Fine-grained reactivity. When a DB value changes, only the exact DOM node updates. No React render cycles. |
| **Agent Logic** | **XState** | Deterministic Finite Automata for the Agent's lifecycle. Prevents "Zombie Loops". |

### 🛑 What we are REJECTING:
*   **React Context/Redux:** Too much boilerplate and re-rendering for 60fps live updates.
*   **Native Modules (`better-sqlite3`):** Too brittle for cross-platform Obsidian plugins (ABI mismatch hell).
*   **Separate Vector DB (Voy/Pinecone):** Introduces "Distributed System" problems (consistency, sync latency) into a local single-user app. Consolidated Logic is faster.

---

## 3. System Architecture

```mermaid
graph TD
    subgraph "Obsidian Main Process"
        Obsidian[Obsidian Core]
        FS[File System]
    end

    subgraph "Renderer Process (Main Thread)"
        UI[Plugin UI (React/Preact)]
        SignalState[Signal State Store]
        BridgeStub[Comlink Proxy]
    end

    subgraph "The Shadow Brain (Web Worker)"
        Controller[Agent Controller]
        
        subgraph "Data Layer"
            SQLite[(SQLite WASM)]
            VecEngine{sqlite-vec}
            NoteIndex[Metadata Table]
        end

        subgraph "Cognitive Layer"
            Intent[Intent Classifier]
            Planner[Reactive Planner]
            LLM[LLM Interface (OpenRouter/Local)]
        end
    end

    %% Flow
    Obsidian --"Events (File Change)"--> UI
    UI --"Task Request"--> BridgeStub
    BridgeStub <--"RPC (Comlink)"--> Controller
    
    Controller --"SQL+Vector Query"--> SQLite
    SQLite --"Rows"--> Controller
    Controller --"State Update"--> BridgeStub
    BridgeStub --"Signal Update"--> SignalState
    SignalState --"Re-render"--> UI

    %% Independent Brain Loop
    Controller --"Tick"--> Planner
    Planner --"Action"--> LLM
    LLM --"Observation"--> Controller
    
    %% Storage
    SQLite <--"Access via VFS"--> FS
```

---

## 4. The Data Layer: "The Twin-Vault"

We cannot query 50k notes instantly. We need a **Twin Vault**: a SQL mirror of the physical vault.

### The Schema (Robust & Typed)
```sql
-- The Core Truth
CREATE TABLE notes (
    path TEXT PRIMARY KEY,
    hash TEXT NOT NULL,         -- For detecting changes
    title TEXT,
    content_summary TEXT,       -- First 1k chars for fast peek
    mtime INTEGER,
    health_score REAL,          -- Computed metric
    tags TEXT                   -- JSON array of tags
);

-- The Vector Dimension
-- Using sqlite-vec virtual table for HNSW index
CREATE VIRTUAL TABLE vec_notes USING vec0(
    embedding float[1536]
);

-- The Linking Tissue
CREATE TABLE dependencies (
    source_path TEXT,
    target_path TEXT,
    type TEXT,                  -- 'link', 'embed', 'tag'
    PRIMARY KEY (source_path, target_path)
);
```

### The Ingestion Pipeline (Non-Blocking)
1.  **Boot:** Worker starts. Checks `mtime` of `notes.sqlite` vs Vault.
2.  **Diff:** If Vault changed, Worker computes a Diff (Added/Modified/Deleted paths).
3.  **Hydro-Dynamic Indexing:**
    *   **User Active?** Throttle indexing to 1 file/sec (Invisible).
    *   **User Idle?** Burst indexing to Max IO/sec.
4.  **Vectorization:** New notes are queued for Embedding. This happens strictly in the Worker.

---

## 5. The Agent Logic: "Reactive Intent Engine"

We replace the rigid "Task Queue" with an **Intent-Based Loop**.

**The Cycle:**
1.  **Stimulus:** User types in Omnibar OR File changes OR Time passes.
2.  **Classification:** Input is classified into an `Intent` (e.g., `QUERY_VAULT`, `SUMMARIZE_NOTE`, `DRAFT_CONTENT`). 
    *   *Optimization:* Use regex/keywords for 90% of disjoint commands. Use LLM only for ambiguity.
3.  **Execution:** The `AgentController` (in Worker) executes the handler.
4.  **Reaction:** The Result is not just "returned" to the UI. It is written to the **Application State**. The UI typically just watches the State.

**Example: "Show me urgent notes"**
1.  User types "Urgent".
2.  Algorithm detects "Urgent" -> `Intent: FILTER_VIEW { criteria: "health < 50" }`.
3.  Worker executes SQL: `SELECT path FROM notes WHERE health_score < 50`.
4.  Worker updates `state.currentView.results` with the row IDs.
5.  UI Signal triggers List re-render using a Virtual List (RecyclerListView) to show 50k rows smoothly.

---

## 6. Implementation Plan: Vertical Slice (v0.1)

**Goal:** Implement the "Data Engine" and "Urgent Query" capability.

### Phase 1: The Foundation (Worker + SQLite)
1.  **Scaffold:** Setup `esbuild` to bundle the Worker separate from Main.
2.  **Database:** precise setup of `sqlite-wasm` with a NodeFS VFS (reading directly from Vault `.obsidian/plugins/notient/data.sqlite`).
3.  **Communication:** Wrapper around `Comlink` to expose `database.query(sql)` to Main.

### Phase 2: The Indexer
1.  **Watcher:** Listen to `vault.on('modify')` in Main, send path to Worker.
2.  **Parser:** Worker reads file, parses Frontmatter/Tags, inserts to SQLite.
3.  **Performance Test:** Ingest 10k dummy files. Measure main-thread jank (Target: 0ms).

### Phase 3: The View
1.  **Signal Store:** Create global state in Main.
2.  **Live Query:** UI component `<UrgentNotesList />` that observes a Signal.
3.  **Wiring:** When Indexer updates SQLite, it sends a `DATA_UPDATED` signal. The Query re-runs (or smart-updates).

## 7. Performance Manifesto
1.  **Zero Main-Thread IO:** The Main thread never reads a file.
2.  **Zero Main-Thread Transform:** The Main thread never parses Markdown.
3.  **Zero Main-Thread Search:** The Main thread never filters a list > 100 items. (Worker does it, sends windowed results).

**This architecture guarantees the "Invisible Intelligence" vision by physically isolating the intelligence from the interface.**
