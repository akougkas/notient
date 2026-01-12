---
title: "The Phoenix Protocol: Master Plan"
description: "Detailed architecture and roadmap for re-engineering Notient, focusing on data sovereignty, performance, and the Intent Engine."
author: "Antigravity (Gemini)"
date: "2026-01-12"
status: "DRAFT"
---

# 🦅 The Phoenix Protocol: Master Plan
*From "Architecture Envy" to "The Sentient Local Vault"*

This is the comprehensive engineering roadmap to take Notient from its current "blocked" state to a robust v1.0 release. It represents a fundamental shift in architecture, prioritizing **Data Sovereignty**, **Raw Performance**, and **Invisible Intelligence**.

---

## 🏗️ Phase 1: The Iron Foundation (Weeks 1-2)
**Goal:** Replace the crumbling JSON/Sync foundation with a high-performance, queryable data layer.

### 1.1 The "Shadow Vault" (Metadata Layer)
*   **Technology:** `sqlite-wasm` with persistence.
*   **Library:** `kysely` (Type-safe SQL builder) wrapping a custom `SqliteWasmDialect`.
*   **Persistence Strategy:**
    *   **Primary:** `.obsidian/plugins/notient/data/notient.db` (Binary SQLite file).
    *   **Mechanism:** Use `sql.js` approach (load binary to memory -> operate -> periodically flush to disk) OR specific `sqlite-wasm` OPFS if viable in Obsidian. *Decision: Start with `sql.js` style load/save for max compatibility, move to `sqlite-wasm` VFS if performance demands.*
*   **Schema (Proposed):**
    ```sql
    CREATE TABLE notes (
      path TEXT PRIMARY KEY,
      content_hash TEXT,
      mtime INTEGER,
      health_score INTEGER,
      last_analyzed INTEGER
    );
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE
    );
    CREATE TABLE note_tags (
      note_path TEXT,
      tag_id INTEGER,
      FOREIGN KEY(note_path) REFERENCES notes(path),
      FOREIGN KEY(tag_id) REFERENCES tags(id)
    );
    ```

### 1.2 The "Parallel Universe" (Vector Layer)
*   **Technology:** `hnswlib-wasm` running inside a **Web Worker**.
*   **Communication:** `comlink` for RPC-style communication (`worker.search(query)`).
*   **Responsibility:**
    *   The Worker owns the Vector Index (memory + disk serialization).
    *   Main thread *never* imports `hnswlib-wasm`.
*   **Data Flow:**
    *   Main Thread: `indexer` parses note -> extracts chunks -> `worker.insert(chunk)`.
    *   Worker: Adds to HNSW graph -> saves `vectors.bin` to disk (periodically).

### 1.3 Migration Strategy
*   **Cold Boot:** On startup, check for `notient.db`. If missing, check `data.json` (legacy).
*   **Import:** Stream `data.json` to SQLite `INSERT`s.
*   **Validation:** Verify record counts match.
*   **Cleanup:** Rename `data.json` to `data.old.json`.

---

## 🧠 Phase 2: The Synapse System (Weeks 3-4)
**Goal:** Abolish the "Bureaucracy" (`ChiefOfStaff` / `TaskQueue`) and implement a reactive "Intent Engine."

### 2.1 The Capability Registry
*   A simplified, flat registry of pure functions.
*   **Decorator Pattern:**
    ```typescript
    @Capability({
      name: 'fix_typo',
      description: 'Fixes typos in the current selection',
      cost: 'low'
    })
    export async function fixTypo(ctx: Context, selection: string) { ... }
    ```

### 2.2 The Intent Engine (Router)
*   **Input:** User Query string ("Fix this text" or "How does this relate to X?").
*   **Logic:**
    1.  **Fast Path (Regex/Slash Commands):** `/fix` -> directly calls `fixTypo`.
    2.  **Semantic Path (Router LLM):**
        *   LLM classifies intent -> returns `FunctionCall`.
        *   System executes function.
*   **No "Task Objects":** We stop creating persistent JSON "Task" objects for ephemeral actions.

### 2.3 The "Invisible" Stream
*   Replace `TaskQueue` (Sidebar UI) with `BackgroundAnalysis` (Status Bar).
*   **Priority Queue:**
    *   **Immediate:** User interactions (Chat, Slash Commands).
    *   **Background:** Indexing, Health Analysis.
*   **UI Feedback:** A subtle "pulse" or progress bar, not a list of 50 pending items.

---

## ⚡ Phase 3: Vertical Slices & Deep Code (Weeks 5-6)
**Goal:** Refactor the codebase structure to match the new architecture.

### 3.1 Directory Restructure
From "Genus-based" to "Domain-based":
```text
src/
├── features/
│   ├── chat/              # Chat UI, Service, State
│   ├── search/            # HNSW Worker, Search UI
│   ├── analysis/          # Note Health, Auto-tagging
│   └── context/           # RAG Construction
├── infra/
│   ├── db/                # SQLite, Kysely types
│   ├── worker/            # Web Worker setups
│   └── llm/               # Provider Adapters
└── main.ts
```

### 3.2 The "Live" Context Builder
*   **Old Way:** grep-like regex search for context.
*   **New Way:** Complex SQL queries.
    *   *"Get me all notes tagged #urgent updated in last 3 days connected to 'Project X'"*
    *   `SELECT * FROM notes JOIN note_tags ...`
    *   Feed *this* precise context to RAG.

---

## 🎨 Phase 4: The Interface & Polish (Weeks 7-8)
**Goal:** Bind the UI to the live data layer.

### 4.1 Live Queries
*   **Library:** `tanstack-query` (aka React Query) or a custom hook `useLiveQuery`.
*   **Pattern:**
    ```typescript
    const { data: urgentNotes } = useLiveQuery(
      () => db.selectFrom('notes').where('health', '<', 50).execute()
    );
    ```
*   **Benefit:** UI is always consistent with DB. No manual event emitting needed for simple data updates.

### 4.2 "Techno-Natural" Refinement
*   **Visuals:** Glassmorphism, smooth transitions (FLIP animations).
*   **Performance:** Move heavy React renders to CSS animations where possible.
*   **Latency:** Ensure keypress-to-render is < 16ms.

---

## 🚀 Phase 5: v1.0 Beta Launch (Week 9+)
**Goal:** Stability, Documentation, Distribution.

1.  **Stress Test:** Load vault with 50,000 notes. Verify startup < 2s.
2.  **Plugin Guidelines:** Verify compliance with Obsidian Community Plugin rules (no external binary spawning, safe FS usage).
3.  **Documentation:** Release "The Notient Manual" (built in Obsidian).
4.  **Distribution:** Beta releases via `BRAT` -> Public Review.

---

## 🛠️ Technical Stack Summary

| Layer | New Choice | Rationale |
| :--- | :--- | :--- |
| **Metadata** | `sqlite-wasm` + `kysely` | Type-safe, relational queries, fast. |
| **Vector** | `hnswlib-wasm` (In Worker) | Parallel performance, prevents freeze. |
| **Worker Comms** | `comlink` | Type-safe RPC, simplifies code. |
| **State** | `tanstack-query` + Signals | Reactive data binding from DB. |
| **LLM** | Direct SDKs (Ollama, etc.) | Keep it simple, remove abstractions. |

---

**Signed,**
**Antigravity**
**Google Deepmind Team**
