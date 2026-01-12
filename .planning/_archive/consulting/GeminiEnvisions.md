---
title: "Gemini Envisions: The Phoenix Protocol"
description: "A comprehensive, unobstructed vision for re-architecting Notient into a robust, scalable, and portable intelligence engine for Obsidian."
author: "Antigravity (Gemini)"
date: "2026-01-12"
---

# 🦅 Gemini Envisions: The Phoenix Protocol

> **"Burn the bureaucracy, keep the intelligence."**

You asked for my honest, unobstructed, engineer's opinion. You explicitly gave me permission to be creative and authoritative.

**My Verdict:**
Notient is currently suffering from "Architecture Envy." It is trying to be a microservices cluster inside a single Electron rendering process. It has a "White House," "Departments," "Queues," and "Event Buses" for what is effectively a function call to an LLM.

We are over-engineering the *structure* while under-engineering the *foundation*.

This document outlines **The Phoenix Protocol**: a hypothetical (yet concrete) plan to rebuild Notient from the ground up, focusing on raw performance, data sovereignty, and "Invisible Intelligence."

---

## 🏗️ I. The Data Layer: "The Vault Within a Vault"

**Critique:**
Currently, we store vectors in HNSW RAM (serialized to disk) and metadata in JSON files.
*   **Problem:** JSON parsing is sync and slow (36s freeze). HNSW graph building on the main thread is a crime.
*   **Constraint:** Electronic/Obsidian plugins cannot easily spawn child processes or run binary daemons (Docker, Postgres server).
*   **Solution:** We need a *queryable* persistent store that doesn't block the UI.

### The New Stack: "SQLite + Worker HNSW"

I would reject `data.json` for anything other than basic settings.

1.  **Metadata Store: SQLite (WASM)**
    *   **Technology:** `sqlite-wasm` (official) or `PGlite` (Postgres in WASM).
    *   **Why:** You need structured queries. "Find all notes with `health < 50` AND `tags INCLUDE #project`." Doing this in JSON arrays is $O(N)$. Doing this in SQL is $O(1)$ with indices.
    *   **Storage:** Keep the SQLite DB file in `.obsidian/plugins/notient/data/notient.db`.
    *   **Benefit:** Zero JSON parsing overhead. Instant startup (lazy load).

2.  **Vector Store: HNSW in a Worker**
    *   **Technology:** `hnswlib-wasm` (Keep it, it's good) **BUT** moved strictly to a `Web Worker`.
    *   **Why:** The main thread should *never* touch a vector.
    *   **Protocol:**
        *   Main Thread -> Worker: `postMessage({ type: 'search', query: [...] })`
        *   Worker: Performs Euclidean calc.
        *   Worker -> Main Thread: `postMessage({ results: [...] })`
    *   **Persistence:** The Worker manages its own binary index file via `OPFS` (Origin Private File System) or IndexedDB blobs.

3.  **The "Shadow Vault" Concept**
    *   We mirror the vault structure in SQLite.
    *   Table `notes`: `path (PK), hash, last_updated, vector_id (FK)`.
    *   Table `vectors`: `id (PK), embedding (BLOB)`.
    *   **Migration:** When a file changes, we update the DB. We don't touch vector files directly.

---

## 🧠 II. The Intelligence Layer: "Reactive Capabilities"

**Critique:**
The "White House Model" (`ChiefOfStaff`, `TaskQueue`) is cute but rigid. It forces a bureaucratic "Planner -> Task -> Execution" flow even for simple things like "Fix this typo."

### The New Architecture: "The Intent Engine"

Replace `ChiefOfStaff` and `ActionOrchestrator` with a single **Intent Engine**.

1.  **Capability Registry (The Tools)**
    *   A flat list of annotated functions.
    *   `@Capability('fix_text')`
    *   `@Capability('find_connection')`
    *   `@Capability('graph_query')`

2.  **The "Fast Path" vs "Slow Path"**
    *   **Fast Path (Reactive):**
        *   User types `/fix`.
        *   System *immediately* invokes `fix_text` capability. No planning. No Chief of Staff. No overhead.
    *   **Slow Path (Reasoning):**
        *   User asks "Refactor my project notes."
        *   System invokes `planner` capability.
        *   `planner` yields a list of `intentions`.
        *   System executes `intentions` one by one.

3.  **The "Invisible AI" Loop**
    *   Instead of a "Task Queue" that the user watches, we use a **Background Stream**.
    *   The `NoteIntelligence` service puts "Analysis Jobs" into a `PresentationQueue` (low priority).
    *   The user sees nothing until the job is done.
    *   Result: "Obsidian feels alive," not "Obsidian provides a fast spinner."

---

## ⚡ III. The Code Structure: "Vertical Slices"

**Critique:**
The current `src/` is organized by *genus* (all agents here, all indices here).
I would organize by *domain* (Vertical Slices).

```
src/
├── features/
│   ├── chat/              # All chat logic, UI, and state
│   ├── search/            # HNSW, Indexer, Search UI
│   ├── intelligence/      # Note analysis, background jobs
│   └── context/           # RAG, Vault Context
├── core/
│   ├── db/                # SQLite + Worker wrappers
│   ├── llm/               # Provider adapters
│   └── bus.ts             # Simple event emitter
└── main.ts
```

**Why?**
*   If "Search" is broken, I go to `features/search`. I don't need to check `core/agents/searchAgent.ts` AND `core/services/searchPipeline.ts`.

---

## 🔥 IV. Redundancy to Burn (The Cleanup)

1.  **`ChiefOfStaff.ts`**: Delete it. Replace with a simple `Router` function in the LLM service.
2.  **`TaskQueue.ts` (Legacy)**: Delete it. Use a standard `PQueue` or `RxJS` subject for concurrency control.
3.  **JSON State Files**: Delete `index.json`, `queue.json`. Move to SQLite.
4.  **Complex Identity System**: If it's just prepending a system prompt, keep it simple. We don't need a "User Evolution Engine" unless it *actually* changes plugin behavior code-level. Start with "User Settings" and evolve later.

---

## 🚀 V. The "Phoenix" Roadmap (How to get there)

If I had unobstructed authority, here is the order or operations:

1.  **Phase 1: The Brain Transplant (Data)**
    *   Install `sqlite-wasm`.
    *   Create the `notes` and `vectors` tables.
    *   Rewrite `SimpleIndexer` to write to SQLite instead of `data.json`.
    *   **Result:** Instant startup, zero memory bloat for metadata.

2.  **Phase 2: The Parallel Universe (Worker)**
    *   Move `HNSWVectorStore` code to `worker/vector.worker.ts`.
    *   Implement message passing protocol.
    *   **Result:** UI never freezes, even during full index rebuild.

3.  **Phase 3: The Simplification (Agents)**
    *   Delete `ChiefOfStaff` and `ActionOrchestrator`.
    *   Implement `IntentEngine` (takes string -> returns `FunctionCall`).
    *   Wire Chat UI directly to `IntentEngine`.

4.  **Phase 4: The Interface (UI)**
    *   Keep the beautiful "Techno-Natural" aesthetic.
    *   But power it with live SQL queries (`SELECT * FROM notes WHERE vitals_score < 50`) instead of expensive JS updates.

---

### Final Thought

We are building a **Database with a Personality**, not a **Bureaucracy with a Database**.
Let's make the database fast, and the personality charming but lightweight.

**Signed,**
**Antigravity**
**Google Deepmind Team**
