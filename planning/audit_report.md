# Notient Codebase Audit Report

**Date:** 2026-01-07
**Auditor:** Antigravity

## 1. Executive Summary

The Notient codebase is significantly more advanced than indicated by `planning/prompts/bootstrap.md`. While the planning documents suggest completion of Phase 1 and readiness for Phase 2, the **backend implementation of Phase 2 (Agentic) and Phase 3 (Intelligence) is largely complete**.

However, these advanced backend capabilities are **not yet fully wired to the UI**. The frontend visualizes the data (intelligence summaries, health scores, review queues) but the interactive buttons (Apply Suggestion, Review Action) are currently mocked or disabled.

**Current State:** "Backend Complete (Phases 1-3), Frontend Partial (Phase 1 Complete, Phases 2-3 Visualization Only)"

---

## 2. Detailed Phase Assessment

### Phase 1: Foundation (✅ Complete)
*   **Core Architecture**: `Kernel`, `EventBus`, and Service Registry are solid.
*   **LLM Layer**: `LLMProvider` is fully abstract and implemented for OpenAI-compatible sources.
*   **Agent Logic**: `NotientAgent` loop correctly orchestrates RAG, Prompting, and Streaming.
*   **Basic UI**: Sidebar search, chat, and "Note Vitals" (basic) are functional.

### Phase 2: Agentic (⚠️ Partial - Backend Ready, UI Disabled)
The "Agentic" capabilities are implemented in `core/agentic/` but disabled in the Dashboard UI.

*   **TrustLevelManager** (`core/agentic/trustLevelManager.ts`): ✅ Implemented. Handles Low/Medium/High risk evaluation.
*   **ActionHistory** (`core/agentic/actionHistory.ts`): ✅ Implemented. Persists actions with undo data to disk.
*   **ActionApplier** (`core/agentic/actionApplier.ts`): ✅ Implemented. Can execute `frontmatter_add_tags`, `append_section`, `move_note`, etc., and record undo capability.
*   **WorkflowRunner** (`core/agentic/workflowRunner.ts`): ✅ Implemented. Manages sequential bulk operations and the "Review Queue".
*   **UI Integration**: ⚠️ **Incomplete**.
    *   `Dashboard` visualizes the "Review Queue" but the **Apply/Dismiss buttons are explicitly disabled** with `title: "Coming in Phase 3"`.
    *   `Sidebar` "Quick Actions" trigger chat prompts, which is good, but they don't yet leverage the `WorkflowRunner` directly for bulk actions.

### Phase 3: Intelligence (⚠️ Partial - Backend Ready, UI Mocked)
The "Intelligence" layer (`core/intelligence/`) is running and generating data, but user interaction is mocked.

*   **NoteIntelligenceService** (`core/intelligence/`): ✅ Implemented. Generates:
    *   Summaries (Short & Structured)
    *   Health Scores (Freshness, Connectivity, etc.)
    *   Entity Extraction
    *   Tag & Link Suggestions
    *   Inbox Triage Actions
*   **IntelligenceDb**: ✅ Implemented. Persists this metadata to JSON.
*   **UI Integration**: ⚠️ **Incomplete**.
    *   `Sidebar` correctly displays the health score, summary, and entities.
    *   **Suggestions**: The "Add Tag" and "Link" buttons in the sidebar **are mocked** (`TODO: actually apply tag`). They display a `Notice` but do not call `ActionApplier`.

---

## 3. Architecture & Code Quality

The codebase maintains a specialized, high-quality architecture:
*   **Strict Typing**: Consistency is high.
*   **Service Pattern**: The `Kernel` service registry nicely decouples components.
*   **Event-Driven**: Extensive use of `EventBus` keeps UI reactive without tight coupling to backend logic.
*   **Filesystem Safety**: `VaultLock` and atomic writes in `ActionHistory`/`IntelligenceDb` demonstrate attention to data safety.

## 4. Discrepancies vs Planning Docs

| Artifact | Claim | Actual State |
| :--- | :--- | :--- |
| `bootstrap.md` | "Ready for Phase 2: AGENTIC" | Phase 2 Backend is **DONE**. Phase 3 Backend is **DONE**. |
| `Dashboard.ts` | Buttons disabled "Coming in Phase 3" | Backend for these buttons (`ActionApplier`) exists now. |
| `Sidebar.ts` | Suggestion buttons "mock" | Backend for applying tags/links exists. |

## 5. Next Steps

The path forward is **Integration**, not implementation. We do not need to write new core logic. We need to **wire the existing backend to the frontend**.

1.  **Enable Dashboard Review Actions**:
    *   Update `views/dashboard.ts` to remove `disabled` attributes.
    *   Connect "Apply" button -> `ActionApplier.applyConfirmed()`.
    *   Connect "Dismiss" button -> Remove from `WorkflowRunner` queue.

2.  **Wire Sidebar Suggestions**:
    *   Update `views/sidebar.ts` to replace mocks.
    *   Connect "Add Tag" -> `ActionApplier.apply({ type: 'frontmatter_add_tags', ... })`.
    *   Connect "Link" -> `ActionApplier.apply({ type: 'append_related_links', ... })`.

3.  **Update Documentation**:
    *   Update `bootstrap.md` to reflect the true state of the codebase.
