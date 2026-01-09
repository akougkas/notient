# Technical Specification: Project "Notient" (Sentient Note)

## Architecture: The "Sidecar" Web-Integration Model

### 1. Executive Summary

This document outlines the technical architecture for **"Notient,"** an agentic UI layer sitting on top of an Obsidian Vault.

* **Goal:** Decouple the UI/Agent logic from Obsidian's plugin API limitations while maintaining seamless, low-latency access to the Note Vault.
* **Core Solution:** A **Hybrid Sidecar Architecture**. We will run a standalone React/Vite web application (The "Notient" Dashboard) and embed it inside Obsidian using a lightweight Plugin Wrapper.
* **Communication:** A bi-directional bridge using `window.postMessage` (for UI  Plugin) and WebSockets (for UI  Python/Go Backend).

---

### 2. System Architecture Diagram

```mermaid
graph TD
    subgraph "Obsidian (Electron Host)"
        A[Obsidian App Core]
        B[Notient Plugin Wrapper]
        C[Markdown Files (Vault)]
        
        A <-->|Obsidian API| B
        B <-->|File I/O| C
    end

    subgraph "The Notient Layer (Localhost)"
        D[Iframe / Webview]
        E[React/Vite Web App]
        F[Agent Backend (Python/Go)]
        
        B -- "postMessage Bridge (State Sync)" --> D
        D -- "Render" --> E
        E <-->|WebSockets (Streaming)| F
    end

```

---

### 3. The "Web Browser" Question: Feasibility & Implementation

**Question:** Can Obsidian run a web browser/web app to bypass plugin UI limitations?
**Answer:** **Yes.** Obsidian is built on **Electron**, which is essentially Google Chrome (Chromium).

* **Rendering:** It supports all modern web standards (Flexbox, Grid, WebGL, Canvas).
* **The Container:** We will not use a standard "Tab"; we will use a customized `ItemView` that acts as a browser window pointing to `http://localhost:3000` (or your chosen local port).

#### The Integration Strategy: `Iframe` vs. `Webview`

We will use an **Iframe** within the Plugin View. This provides the best balance of isolation and integration.

* **Why not just React inside the Plugin?** You want to decouple the backend and use complex frameworks. An Iframe allows the "Notient" app to run independently. If Obsidian crashes, your agent state survives. If you update the Web App, you don't need to reload the Obsidian plugin.

---

### 4. Communication Bridge (The "Nervous System")

To ensure the "Sentient Note" feels instant (no REST latency), we need two specific communication pipelines.

#### Pipeline A: The Context Bridge (Obsidian  Web App)

*Mechanism: `window.postMessage*`
This connects the **Plugin Wrapper** to your **React App**. It handles "Editor Awareness."

1. **Context Switching:** When the user clicks a different note in Obsidian, the Plugin detects the `active-leaf-change` event and fires a message to the Iframe:
```json
{ "type": "CONTEXT_SWITCH", "file": "Project_Alpha.md", "content": "..." }

```


2. **Instant Editing (The Macro):** When your Agent wants to write to the file, the Web App sends a message *up* to the Plugin:
```json
{ "type": "APPLY_EDIT", "file": "Project_Alpha.md", "diff": "..." }

```


*The Plugin then uses the native Obsidian API (`vault.modify`) to apply the change instantly from memory.*

#### Pipeline B: The Brain Bridge (Web App  Backend)

*Mechanism: WebSockets (Socket.io or FastAPI websockets)*
This connects your **React UI** to your **Python/Go Agents**.

1. **Heavy Lifting:** RAG pipelines, LLM inference, and agent reasoning happen here.
2. **Streaming:** Tokens are streamed via WebSocket to the React UI for that "Terminal/Sci-Fi" feel.

---

### 5. Data Synchronization & State

We need to solve the "Split Brain" problem (State in Obsidian vs. State in Agent).

* **Source of Truth:** Obsidian Filesystem.
* **Agent State:** Stored in the Python Backend (Vector DB / SQL), keyed by the File Path.

**The "Active State" Protocol:**

1. User opens `Meeting_Notes.md`.
2. Plugin sends `path: "Meeting_Notes.md"` to the Iframe.
3. React App queries the Python Backend: "Do we have active agents or memories for `Meeting_Notes.md`?"
4. Backend returns agent state.
5. UI renders the Dashboard overlay.

---

### 6. Step-by-Step Implementation Plan for the Coding AI

**Prompt to AI:** "Execute Phase 1 of the Notient Sidecar Plan."

#### Phase 1: The Plugin Wrapper (TypeScript)

* **Goal:** Create an Obsidian Plugin that opens a generic View containing an Iframe.
* **Key Files:**
* `main.ts`: Registers the View.
* `view.ts`: Creates the DOM element `<iframe src="http://localhost:3002" />`.
* **Crucial Logic:** Implement the `on('active-leaf-change')` listener to send the current file name to the Iframe.



#### Phase 2: The Web Host (React/Vite)

* **Goal:** A standalone React app running on Port 3002.
* **Key Logic:**
* Create a `useObsidianBridge` hook.
* This hook listens for `message` events from the parent window.
* It updates the local React State (`setCurrentNote`).



#### Phase 3: The Write-Back Capability

* **Goal:** Allow the Web App to edit the Obsidian Note.
* **Logic:**
* **React:** Button click sends `{ type: "APPEND_TEXT", text: "# Insight" }` via `postMessage`.
* **Plugin:** Receives message, uses `this.app.vault.append(file, text)`.



#### Phase 4: The Agent Backend

* **Goal:** Spin up the Python/Go server.
* **Logic:** Connect the React App to this backend via WebSockets to begin processing the "Sentient" aspects (embeddings, chat).

---

### 7. Known Limitations & Workarounds

* **CORS:** The React App (Port 3002) and Obsidian (Local File Protocol) have different origins.
* *Fix:* The Plugin creates the Iframe. We will need to ensure the `postMessage` target origin is set correctly (or `*` for local dev).


* **Theming:** The Web App won't inherently know Obsidian's theme (Dark/Light).
* *Fix:* Pass the CSS variables or theme class from Obsidian to the Iframe in the initial handshake message.


* **Hotkeys:** If the Iframe has focus, Obsidian hotkeys might not trigger.
* *Fix:* The React app must capture global hotkeys and pass unhandled ones back up to Obsidian via `postMessage`.



### 8. Next Immediate Action

Ask the Coding AI to:

> "Scaffold an Obsidian Plugin named 'Notient-Bridge' that registers a Custom ItemView. This view must render an Iframe pointing to `http://localhost:3002`. Implement a `postMessage` handshake that logs to the console when the Obsidian Plugin successfully talks to the Iframe."