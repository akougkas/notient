# CONTINUE.md - Notient Codebase Audit

> **Audit Date:** 2026-01-09
> **Purpose:** Comprehensive identification of incomplete implementations, broken pipelines, UI/backend mismatches, and missing functionality
> **Action:** Each section contains mini-prompts for coding agents to fix specific issues

---

## Executive Summary

| Category | Critical | High | Medium | Low | Total |
|----------|----------|------|--------|-----|-------|
| Broken Pipelines | 6 | 4 | 0 | 0 | 10 |
| Missing Backend Wiring | 3 | 5 | 4 | 2 | 14 |
| UI Not Connected | 2 | 6 | 5 | 3 | 16 |
| Dead/Unused Code | 0 | 2 | 5 | 8 | 15 |
| Missing Error Handling | 2 | 6 | 8 | 4 | 20 |
| Type Mismatches | 1 | 3 | 4 | 2 | 10 |
| **Architecture Rearchitecting** | **0** | **1** | **0** | **0** | **1** |
| **TOTAL** | **14** | **27** | **26** | **19** | **86** |

> **NEW: PART 9** added - Comprehensive initialization state machine with 40+ canonical scenarios across vault state, provider health, index persistence, configuration, and lifecycle edge cases.

---

## PART 1: CRITICAL PIPELINE BREAKERS

> **Assignment:** Mixed - see individual task tags

These issues prevent core features from functioning. Fix these first.

### 1.1 Sidebar Stuck on "Initializing services..." (CRITICAL) `[AGENT-2]`

**File:** `src/ui/sidebar/App.tsx`
**Lines:** 45, 84, 227, 242
**Root Cause:** Static read of signal value instead of reactive subscription

```typescript
// Line 227 - BUG: Reads once during render, never updates
const isReady = isServicesReady.value;

// Line 242 - Uses stale value forever
{!isReady ? (
    <LoadingState message="Initializing services..." />
) : ...
```

**PROMPT FOR AGENT:**
```
Fix the static isReady bug in src/ui/sidebar/App.tsx. The problem is at line 227 where
`isServicesReady.value` is read once as a plain variable instead of being used reactively.
The signal updates correctly (line 99 event handler works), but the component never re-renders.

Option 1: Use the signal directly in JSX: `{!isServicesReady.value ? ...}`
Option 2: Create a computed/derived signal that triggers re-render

Ensure the sidebar transitions from "Initializing services..." to the main content when
services:initialized fires. Test by adding console.log in the event handler to verify
the signal updates, then verify the DOM updates.
```

---

### 1.2 Antagonist Agent Feature Completely Non-Functional (CRITICAL) `[AGENT-1]`

**Files:**
- `src/core/intelligence/actionPipeline.ts` (lines 513-524)
- `src/core/intelligence/index.ts` (missing export)

**Root Cause:** Antagonist prompt exists but conversion pipeline is missing

```typescript
// actionPipeline.ts lines 513-521 - "antagonist" is NOT in converters map
const converters: Record<string, () => ProposedAction[]> = {
    atomic: () => this.convertAtomicActions(parsed),
    synthesis: () => this.convertSynthesisActions(parsed),
    // ... 5 more
    // antagonist: MISSING - returns empty [] silently
};
```

**PROMPT FOR AGENT:**
```
Complete the Antagonist agent implementation in src/core/intelligence/actionPipeline.ts:

1. Add "antagonist" key to the converters map at line 513-521
2. Create `convertAntagonistActions()` method following the pattern of other converters
3. Reference the outputSchema in src/core/intelligence/prompts/antagonist.ts (line 28-47)
   for the expected LLM response structure
4. The antagonist should return actions like: challenges, counter-arguments, blind-spot alerts

Also add missing exports in src/core/intelligence/index.ts:
- Export ANTAGONIST_PROMPT from "./prompts/antagonist"
- Export buildAntagonistPrompt from "./prompts/antagonist"
```

---

### 1.3 UserEvolutionService Never Instantiated (CRITICAL) `[AGENT-1]`

**File:** `src/main.ts` - missing instantiation
**File:** `src/core/evolution/userEvolutionService.ts` - stub implementation

**Root Cause:** Service class exists but is never created or registered in main.ts

```typescript
// main.ts - UserEvolutionService is NEVER instantiated
// VaultContextBuilder tries to use it at line 46 but gets null
const userEvolution = kernel.getService("user-evolution"); // Always null!
```

**PROMPT FOR AGENT:**
```
The UserEvolutionService exists but is never instantiated. Complete the implementation:

1. In src/main.ts (around line 338-342, after profileManager):
   - Import UserEvolutionService from "./core/evolution/userEvolutionService"
   - Create instance: `this.userEvolution = new UserEvolutionService(eventBus)`
   - Call: `await this.userEvolution.load()`
   - Register: `this.kernel.registerService("userEvolution", this.userEvolution)`

2. In src/core/evolution/userEvolutionService.ts:
   - Lines 21-29: Implement persistence (load from/save to profile.json or evolution.json)
   - Lines 40-48: Add subscriptions for: workflow:started, workflow:complete,
     action:applied, file:modified, search:complete, intelligence:updated
   - Lines 50-60: Expand analyzeTaskForEvolution beyond just 2 task types
   - Add unsubscription cleanup in unload()

3. Create src/core/evolution/index.ts barrel export for consistency
```

---

### 1.4 ChatView Uses Fake Mock Response (CRITICAL) `[AGENT-2]`

**File:** `src/ui/sidebar/components/ChatView.tsx`
**Lines:** 382-393

```typescript
// Lines 382-393 - FAKE: setTimeout with hardcoded response
isChatStreaming.value = true;
setTimeout(() => {
    const assistantMsg: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: `I've received your message about "${chatContext.value.noteTitle}".
                  The full chat integration with the agent system is coming soon!`, // <-- FAKE
        timestamp: new Date(),
    };
    chatMessages.value = [...chatMessages.value, assistantMsg];
    isChatStreaming.value = false;
}, 1000);
```

**PROMPT FOR AGENT:**
```
Replace the fake setTimeout mock in ChatView.tsx with real agent integration:

1. Line 371 already enqueues a task to taskQueue - good
2. Subscribe to task completion events to receive streaming responses:
   - useEventBus("agent:task-update", ...) to get streaming chunks
   - Build response incrementally as chunks arrive

3. Connect to ConversationStore for persistence:
   - On component mount: Load history via conversationStore.getHistory(notePath)
   - On message send/receive: Save via conversationStore.appendMessage()

4. Wire action buttons (line 281 is just console.log):
   - Actually emit action:apply-requested with proper payload
   - Connect to ActionApplier service

Reference TaskModal.ts lines 385-430 for working streaming implementation pattern.
```

---

### 1.5 TaskModal Chat History Not Persisted (CRITICAL) `[AGENT-2]`

**File:** `src/ui/modals/TaskModal.ts`
**Lines:** 59-75, 78-92

**Root Cause:** History loaded from ConversationStore but never saved back

```typescript
// Line 69 - Loads history
const persistedHistory = conversationStore.getHistory(this.task.notePath);

// Line 78-92 onClose() - NO SAVE!
onClose(): void {
    // ... cleanup but no conversationStore.saveHistory() call
}
```

**PROMPT FOR AGENT:**
```
Fix chat history persistence in TaskModal.ts:

1. In onClose() method (line 78-92), add:
   ```typescript
   const conversationStore = this.kernel.getService<ConversationStore>("conversationStore");
   if (conversationStore && this.task.notePath && this.task.notePath !== "unknown") {
       conversationStore.appendMessages(this.task.notePath, this.session.getMessages());
       await conversationStore.flush(); // Force immediate save
   }
   ```

2. Also consider saving after each assistant response completes (line 385-430 area)
   to prevent data loss if plugin crashes

3. Type mismatch issue: Lines 33-34 use ExtendedChatMessage but task.chatHistory
   expects ChatMessage. Either:
   - Update AgentTask type to use ExtendedChatMessage
   - Or strip extra fields when syncing back
```

---

### 1.6 AgentStreamsView Has Zero Event Subscriptions (CRITICAL) `[AGENT-2]`

**File:** `src/ui/sidebar/components/AgentStreamsView.tsx`
**Lines:** 1-300 (entire component)

**Root Cause:** Component renders UI but never receives data from backend

```typescript
// The component has NO useEventBus() calls
// Signals activeAgents, pendingActions, recentActivity are never populated from events
// Data only comes from parent App.tsx props, but App.tsx doesn't populate them either
```

**PROMPT FOR AGENT:**
```
Wire AgentStreamsView.tsx to receive real data from backend events:

1. Add these event subscriptions (use useEventBus from ../hooks):
   - "workflow:started" -> Add to activeAgents signal
   - "workflow:progress" -> Update progress % in activeAgents
   - "workflow:completed" -> Move from activeAgents to recentActivity
   - "workflow:failed" -> Move to recentActivity with error
   - "action:proposed" -> Add to pendingActions signal (note: event type missing, add it)
   - "action:applied" -> Remove from pendingActions

2. Fix pause/resume functionality (lines 282-288):
   - Currently UI-only toggle
   - Should call workflowRunner.pause(id) / workflowRunner.resume(id)
   - WorkflowRunner needs pause/resume methods added if missing

3. Stop functionality (lines 290-301) calls cancel() but never sees updated state
   because it doesn't subscribe to workflow events
```

---

## PART 2: HIGH PRIORITY - MISSING BACKEND WIRING

> **Assignment:** Primarily `[AGENT-1]` - Backend architecture focus

### 2.1 Two Action Types Return "Not Implemented" Error `[AGENT-1]`

**File:** `src/core/agentic/actionApplier.ts`
**Lines:** 333-344

```typescript
case "highlight_text_issues":
    console.warn("[ActionApplier] highlight_text_issues action not yet implemented");
    return { success: false, error: "Action type 'highlight_text_issues' is not yet implemented" };

case "extract_to_calendar":
    console.warn("[ActionApplier] extract_to_calendar action not yet implemented");
    return { success: false, error: "Action type 'extract_to_calendar' is not yet implemented" };
```

**PROMPT FOR AGENT:**
```
Implement the two stubbed action types in actionApplier.ts:

1. highlight_text_issues (lines 333-337):
   - Type definition: src/core/agentic/types.ts lines 289-304
   - Should add inline annotations/callouts to highlight issues in note
   - Consider using Obsidian's comment syntax or callout blocks
   - Create undo record to remove highlights

2. extract_to_calendar (lines 340-344):
   - Type definition: src/core/agentic/types.ts lines 253-263
   - Should extract dates/deadlines and create calendar entries
   - Could create a task note or use frontmatter dates
   - Note: May need external calendar API - consider MVP of just extracting to task list

If these features are intentionally deferred, remove them from types.ts SUPPORTED_ACTION_TYPES
to prevent LLM from proposing them.
```

---

### 2.2 action:proposed Event Missing from Type System `[AGENT-1]`

**File:** `src/types/events.ts`
**Impact:** Pending actions can never be displayed in UI

```typescript
// EventType union (line 14-43) does NOT include "action:proposed"
// App.tsx line 156 comments: "Note: action:proposed not in event types"
```

**PROMPT FOR AGENT:**
```
Add the action:proposed event to complete pending actions workflow:

1. In src/types/events.ts:
   - Add "action:proposed" to EventType union (around line 30)
   - Add ActionProposedPayload interface:
     ```typescript
     export interface ActionProposedPayload {
       action: ProposedAction;
       noteContext: { path: string; title: string };
     }
     ```
   - Add to EventPayloads: "action:proposed": ActionProposedPayload;

2. Emit the event from appropriate location:
   - ActionOrchestrator.executeAction() after pipeline generates actions
   - Or WorkflowRunner when action is generated but awaiting review

3. Subscribe in App.tsx to populate pendingActions signal
```

---

### 2.3 action:apply-requested and action:undo-requested Never Handled `[AGENT-1]`

**File:** `src/ui/sidebar/App.tsx` lines 307, 343
**File:** Nowhere - no handlers exist

```typescript
// App.tsx emits these events but nothing listens
kernel.eventBus.emit("action:apply-requested", { actionId: id });  // Line 307
kernel.eventBus.emit("action:undo-requested", { actionId: id });   // Line 343
```

**PROMPT FOR AGENT:**
```
Create handlers for action:apply-requested and action:undo-requested events:

1. Add event types to src/types/events.ts (if not present)

2. In main.ts (or a dedicated ActionEventHandler service), subscribe to these events:
   ```typescript
   eventBus.on("action:apply-requested", async ({ actionId }) => {
       const action = pendingActionsStore.get(actionId); // Need a store
       if (action) {
           await actionApplier.apply(action);
       }
   });

   eventBus.on("action:undo-requested", async ({ actionId }) => {
       await actionHistory.undo(actionId);
   });
   ```

3. Create a PendingActionsStore (or use existing review queue in WorkflowRunner)
   to track proposed actions awaiting user decision
```

---

### 2.4 ProfileManager.infer() Can Crash on Missing Service `[AGENT-1]`

**File:** `src/core/agent/profileManager.ts`
**Lines:** 124-126

```typescript
// Line 124-126 - Weak inline type, no null check
this.kernel.getService<{getIndexedCount(): number}>()
// If service not registered, returns null and crashes
```

**PROMPT FOR AGENT:**
```
Fix service lookup safety in profileManager.ts:

1. Lines 124-126: Add proper type import and null check:
   ```typescript
   const indexManager = this.kernel.getService<IndexManager>("indexManager");
   if (!indexManager) {
       throw new Error("IndexManager not available - complete setup first");
   }
   const count = indexManager.getIndexedCount();
   ```

2. Line 140: Wrap getSampleNotesForInference() in try-catch

3. Line 351: Validate JSON.parse result before casting to DomainInferenceResult:
   ```typescript
   const parsed = JSON.parse(cleaned);
   if (!parsed.primary || !Array.isArray(parsed.secondary)) {
       throw new Error("Invalid inference response structure");
   }
   return parsed as DomainInferenceResult;
   ```
```

---

### 2.5 VaultContextBuilder PARA Type Mismatch `[AGENT-1]`

**File:** `src/core/context/vaultContextBuilder.ts`
**Line:** 205

```typescript
// Line 205 - BUG: Uses "archives" (plural) but ParaDetector returns "archive" (singular)
const dist: Record<string, number> = {
    projects: 0,
    areas: 0,
    resources: 0,
    archives: 0,  // <-- Should be "archive" to match ParaType
    unknown: 0,
};
```

**PROMPT FOR AGENT:**
```
Fix the PARA type mismatch in vaultContextBuilder.ts line 205:

Change "archives" to "archive" to match the ParaType enum in types/search.ts line 38.

Currently all "archive" type notes are being counted as "unknown" because the key doesn't match.
```

---

## PART 3: UI COMPONENTS NOT CONNECTED TO BACKEND

> **Assignment:** Primarily `[AGENT-2]` - UI/UX and design focus

### 3.1 Omnibar Component Exists But Never Used `[AGENT-2]`

**File:** `src/ui/sidebar/components/Omnibar.tsx`
**Status:** Fully implemented, never imported

**PROMPT FOR AGENT:**
```
The Omnibar component is complete but unused. Decide:

Option A: Integrate into sidebar
- Import in App.tsx
- Add above tab content
- Wire to SearchPipeline

Option B: Remove as dead code
- Delete Omnibar.tsx
- Remove from index.ts exports
```

---

### 3.2 QuickActions "Chat about this" Not Connected `[AGENT-2]`

**File:** `src/ui/sidebar/components/QuickActions.tsx`
**Lines:** Where onAction callback fires for chat actions

**PROMPT FOR AGENT:**
```
QuickActions triggers onAction("chat", ...) but the chat integration is incomplete.
The callback in App.tsx should:

1. Switch to Chat tab
2. Pre-populate context with the quick action topic
3. Auto-send or just set up the input field

Currently onAction likely just logs or does nothing for chat type.
```

---

### 3.3 InsightStream Actions Not Wired `[AGENT-2]`

**File:** `src/ui/sidebar/components/InsightStream.tsx`

**PROMPT FOR AGENT:**
```
InsightStream shows insights with action buttons but actions may not be connected:

1. Verify onApply callback triggers actual action execution
2. Verify onDismiss updates backend state (not just UI)
3. Check if insights are being refreshed when intelligence:updated fires
```

---

### 3.4 Settings Profile Propagation May Fail Silently `[AGENT-2]`

**File:** `src/ui/settings/SettingsTab.ts`
**Lines:** 1102-1106

```typescript
private propagateProfileToAgent(profile: UserProfile | undefined): void {
    const agent = this.kernel.getService<NotientAgent>("agent");
    if (agent) {
        agent.setProfile(profile);  // No error handling if method doesn't exist
    }
}
```

**PROMPT FOR AGENT:**
```
Fix profile propagation in SettingsTab.ts:

1. Verify NotientAgent.setProfile() method exists and works
2. Add error handling:
   ```typescript
   try {
       agent.setProfile(profile);
   } catch (error) {
       console.error("[Settings] Failed to propagate profile:", error);
       new Notice("Profile saved but agent update failed");
   }
   ```
3. Consider emitting profile:updated event instead of direct call
```

---

### 3.5 Settings Service Health Not Live-Updating `[AGENT-2]`

**File:** `src/ui/settings/SettingsTab.ts`
**Lines:** 524-582

**PROMPT FOR AGENT:**
```
Settings tab reads service health once at render time but doesn't subscribe to updates.

Add health event subscriptions in SettingsTab:
1. In constructor or display(), subscribe to "health:changed" event
2. On health change, call this.display() to re-render
3. Remember to unsubscribe in hide() to prevent memory leaks
```

---

### 3.6 DashboardView Sync Button Doesn't Refresh After Complete `[AGENT-2]`

**File:** `src/ui/dashboard/DashboardView.ts`
**Lines:** 898-926

**PROMPT FOR AGENT:**
```
DashboardView sync button calls indexer.syncVault() but doesn't refresh display after.

Add subscription to "index:complete" event to refresh dashboard counts after indexing finishes.
```

---

## PART 4: DEAD CODE AND UNUSED EXPORTS `[AGENT-1]`

> **Assignment:** `[AGENT-1]` - Code cleanup and optimization

### 4.1 Remove or Wire These Items

| File | Item | Lines | Recommendation |
|------|------|-------|----------------|
| `services/agentTaskQueue.ts` | Entire file | 1-11 | Deprecated re-export shim - can remove |
| `services/lmstudio.ts` | Entire file | 1-358 | Marked deprecated but still used by SearchPipeline - migrate callers |
| `services/noteVitalsCalculator.ts` | `calculateVitalityScore()` | 120-131 | Never called, broken logic - remove |
| `services/indexManager.ts` | `listAvailableIndices()` | 689-692 | Returns `[]`, never called - remove |
| `services/indexManager.ts` | `deleteIndex()` | 754-757 | Deprecated, never called - remove |
| `ui/sidebar/components/SidebarFooter.ts` | Entire file | all | Old imperative footer, replaced by Preact - remove |
| `ui/sidebar/hooks/useNoteVitals.ts` | `useBacklinkPreview` | exported | Never imported elsewhere - remove if unused |
| `types/search.ts` | `SearchCacheEntry` | 113-126 | Duplicates internal CacheEntry in pipeline.ts - remove |
| `types/events.ts` | `note:context-changed` | line 28-29 | Defined but never emitted - remove or implement |

**PROMPT FOR AGENT:**
```
Clean up dead code in Notient codebase. For each item in the list:

1. Verify it's truly unused with grep/search
2. If unused, delete it
3. If used but deprecated, create migration plan
4. Update any imports/exports that reference deleted items
5. Run typecheck after each deletion to catch broken references
```

---

## PART 5: ERROR HANDLING GAPS `[AGENT-1]`

> **Assignment:** `[AGENT-1]` - Backend resilience

### 5.1 OllamaService.getModelKey() Can Crash

**File:** `src/services/ollama.ts`
**Lines:** 227-231

**PROMPT FOR AGENT:**
```
Fix unsafe getModelKey() in ollama.ts:

```typescript
getModelKey(): string {
    const model = this.kernel.settings.ollama.embeddingModel;
    if (!model) {
        throw new Error("Embedding model not configured");
    }
    const dim = this.modelDimension ?? "unknown";
    return `${model.replace(/[^a-zA-Z0-9-]/g, "_")}_d${dim}`;
}
```
```

---

### 5.2 IndexManager State File Deletion Bug

**File:** `src/services/indexManager.ts`
**Lines:** 715-740

```typescript
// Line 718 - Regex only matches LEGACY format
const modelKeyMatch = baseName.match(/^index-(.+)\.json$/);
// Fails for new format: idx_20250107T143052_a7f3_nomic_embed_text_768d.json
```

**PROMPT FOR AGENT:**
```
Fix deleteIndexByPath() in indexManager.ts to handle new index format:

Update the regex at line 718 to also match new format:
`idx_{timestamp}_{hash}_{modelKey}_{dim}d.json`

Or extract modelKey from filename using a more robust pattern that handles both formats.
Currently orphaned state files accumulate when deleting new-format indices.
```

---

### 5.3 VaultLock Refresh Failure Silent

**File:** `src/services/vaultLock.ts`
**Lines:** 201-206

**PROMPT FOR AGENT:**
```
VaultLock silently clears lock flag on refresh failure without notifying system.

Add event emission when lock refresh fails:
```typescript
catch (error) {
    console.error("[VaultLock] Failed to refresh lock:", error);
    this.hasLock = false;
    this.stopRefresh();
    this.kernel.eventBus.emit("lock:lost", { reason: "refresh_failed" });
}
```
```

---

### 5.4 HealthMonitor.checkAll() Swallows Errors

**File:** `src/services/healthMonitor.ts`
**Lines:** 39-43

**PROMPT FOR AGENT:**
```
Add try-catch to HealthMonitor.checkAll():

```typescript
async checkAll(): Promise<void> {
    if (this.disposed) return;
    try {
        await Promise.all([this.checkOllama(), this.checkLMStudio()]);
    } catch (error) {
        console.error("[HealthMonitor] Health check failed:", error);
    }
}
```
```

---

### 5.5 ConversationStore.flush() No Retry on Failure

**File:** `src/core/chat/conversationStore.ts`
**Lines:** 159-161

**PROMPT FOR AGENT:**
```
Add retry logic to ConversationStore.flush():

```typescript
private async flush(): Promise<void> {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await this.save();
            return;
        } catch (error) {
            if (attempt === maxRetries) {
                console.error("[ConversationStore] Failed to save after retries:", error);
                // Consider emitting event to notify UI
            }
            await new Promise(r => setTimeout(r, 100 * attempt));
        }
    }
}
```
```

---

## PART 6: TYPE SYSTEM ISSUES `[AGENT-1]`

> **Assignment:** `[AGENT-1]` - Type safety and architecture

### 6.1 ChatMessage Type Mismatch in TaskModal

**File:** `src/ui/modals/TaskModal.ts`
**Lines:** 33-34, 321, 385

**PROMPT FOR AGENT:**
```
TaskModal uses ChatSession with ExtendedChatMessage but task.chatHistory expects ChatMessage.

Either:
1. Update AgentTask.chatHistory type to ExtendedChatMessage[]
2. Or strip extra fields when syncing: this.task.chatHistory = this.session.getMessages().map(m => ({
       role: m.role,
       content: m.content
   }))
```

---

### 6.2 Unused Type Definitions to Clean Up

**File:** `src/types/events.ts` line 28-29 - `note:context-changed` never emitted
**File:** `src/types/search.ts` lines 113-126 - `SearchCacheEntry` unused
**File:** `src/types/settings.ts` lines 25-26 - duplicate JSDoc comment

**PROMPT FOR AGENT:**
```
Clean up type definitions:
1. Remove note:context-changed from EventType if not implementing
2. Remove SearchCacheEntry (redundant with pipeline internal type)
3. Fix duplicate comment in settings.ts
```

---

## PART 7: MISSING FEATURES (Per README Vision)

> **Assignment:** Mixed - see individual task tags

These are features mentioned in README.md but not fully implemented:

### 7.1 Universal Undo Not Exposed in UI `[AGENT-2]`

README says: "Every action is reversible. Universal undo."

**Current State:** ActionHistory tracks undo data but no UI exposes undo capability beyond recent activity dismissal.

**PROMPT FOR AGENT:**
```
Add universal undo UI:
1. Add "Undo Last Action" command to Command Palette
2. Add undo button in AgentStreamsView recent activity cards
3. Consider undo stack visualization in Dashboard
```

---

### 7.2 Search Mode Selection Not Exposed `[AGENT-2]`

README says: "Modes: Quick (fast) | Balanced (default) | Thorough (comprehensive)"

**Current State:** SearchPipeline supports modes but no UI to select them.

**PROMPT FOR AGENT:**
```
Add search mode selector:
1. In Omnibar or search UI, add dropdown for Quick/Balanced/Thorough
2. Wire to SearchPipeline.search() options parameter
3. Consider saving preference in settings
```

---

### 7.3 Dashboard Action History Tab Incomplete `[AGENT-2]`

README says: "Full action history in Dashboard."

**PROMPT FOR AGENT:**
```
Dashboard History tab should show:
1. List of all applied actions from ActionHistory
2. Undo button per action
3. Filtering by action type, date, note
4. Currently may just show placeholder or partial data
```

---

## PART 8: TESTING CHECKLIST

After implementing fixes, verify:

- [ ] Sidebar loads and shows Note Vitals (not stuck on Initializing)
- [ ] Chat in sidebar produces real responses (not mock)
- [ ] AgentStreamsView shows active workflows when running
- [ ] Pending actions appear when agent proposes them
- [ ] Actions can be applied and undone
- [ ] Profile changes propagate to agent prompts
- [ ] Index sync reflects in UI counts
- [ ] Service health updates in Settings without page refresh
- [ ] Chat history persists across modal opens
- [ ] Search works with all three modes

---

## PART 9: INITIALIZATION STATE MACHINE REARCHITECTING (HIGH PRIORITY) `[AGENT-1]`

> **Priority:** HIGH
> **Estimated Effort:** 2-3 days
> **Files to Create:** `src/core/services/registry.ts`, `src/core/services/initializationStateMachine.ts`
> **Files to Modify:** `src/main.ts`, `src/types/services.ts`

### 9.1 Current Problem Summary

`main.ts` is 962 lines with fragmented initialization logic:
- No formal state machine for initialization stages
- Poor error handling for provider failures
- No handling for edge cases: empty vaults, large vaults, corrupt indices
- Settings page and initialization logic misaligned
- Fragmented across multiple phases without clear contracts

### 9.2 State Machine Design

```
                          ┌─────────────────────────────────────────────┐
                          │                                             │
                          ▼                                             │
┌──────────────┐    ┌─────────────────┐    ┌────────────────┐    ┌─────┴─────┐
│ UNINITIALIZED│───▶│CHECKING_PROVIDERS│───▶│  LOADING_INDEX │───▶│  WARMING  │
└──────────────┘    └─────────────────┘    └────────────────┘    └───────────┘
                           │                       │                   │
                           │                       │                   │
                           ▼                       ▼                   ▼
                    ┌─────────────┐         ┌───────────┐       ┌───────────┐
                    │   FAILED    │         │  CRASHED  │       │   READY   │
                    │ (both down) │         │ (recovery)│       │ (nominal) │
                    └─────────────┘         └───────────┘       └───────────┘
                           │                       │                   │
                           └───────────────────────┴───────────────────┘
                                                   │
                                                   ▼
                                            ┌───────────┐
                                            │ DEGRADED  │
                                            │(partial)  │
                                            └───────────┘
```

### 9.3 State Definitions

| State | Entry Conditions | Capabilities |
|-------|-----------------|--------------|
| `UNINITIALIZED` | Plugin load, settings not complete | None, wizard only |
| `CHECKING_PROVIDERS` | After settings valid | Polling Ollama/LM Studio |
| `LOADING_INDEX` | Providers healthy | Reading index files |
| `WARMING_SERVICES` | Index loaded | Initializing agents, vitals |
| `READY` | All services initialized | Full functionality |
| `DEGRADED` | LM Studio down OR index stale | Search works, chat limited |
| `FAILED` | Ollama down OR critical error | Show recovery UI |
| `CRASHED` | `indexingInProgress=true` on load | Offer recovery options |

### 9.4 Canonical Scenarios - Vault State

| # | Scenario | Current Handling | Required Action |
|---|----------|------------------|-----------------|
| **V1** | New vault (no index, no notes) | Partial - starts indexing on empty vault | Add `EMPTY_VAULT` state, skip indexing, show "Add some notes first" |
| **V2** | New vault (no index, <100 notes) | Works | `BUILDING_INDEX` → sync, fast path |
| **V3** | New vault (no index, 100-5k notes) | Works but no progress feedback | Add progress modal with ETA |
| **V4** | Large vault (5k-10k notes) | Works but slow, no chunked progress | Add batched indexing with yield points |
| **V5** | Very large vault (10k+ notes) | Risk of timeout/OOM | Add memory guard, streaming batch, optional background-only mode |
| **V6** | Existing vault with valid plugin index | Works | `use_existing` fast path |
| **V7** | Existing vault with user-provided external index | Works (read-only mode) | Correctly sets `isUserProvidedIndex = true` |
| **V8** | Vault with mixed index states | Not handled | Add model-switching wizard step if dimension mismatch |
| **V9** | Vault path contains special characters | Likely broken | Normalize paths in `storagePaths.ts` |
| **V10** | Vault on network drive / slow I/O | No handling | Add timeout escalation and retry logic |

### 9.5 Canonical Scenarios - Provider Health

| # | Scenario | Current Handling | Required Action |
|---|----------|------------------|-----------------|
| **P1** | Both providers available and healthy | Works | `READY` state |
| **P2** | Ollama available, LM Studio down | Partial (`lmError` logged, continues) | Enter `DEGRADED` state: indexing/search work, chat/rerank disabled |
| **P3** | Ollama down, LM Studio available | Fails initialization with notice | `FAILED` state, block all operations, show recovery wizard |
| **P4** | Both providers down | Emits `services:failed` | `FAILED` state, blocking modal with "Check services" button |
| **P5** | Provider available but wrong model loaded | `detectDimension` fails | Show "Model not found" error, list available models |
| **P6** | Provider host unreachable (network) | Throws with generic message | Add specific network error detection, suggest "Is Ollama running?" |
| **P7** | Provider responds but with 5xx error | Generic failure | Add retry with exponential backoff (3 attempts) |
| **P8** | Provider responds very slowly (>30s) | Times out at `embedRequest` | Add configurable timeout, show "Provider slow" warning |
| **P9** | Provider becomes unavailable mid-session | Health monitor detects | Emit `health:changed`, transition to `DEGRADED` |
| **P10** | Provider switches model mid-session | Not handled | Detect via `getModelKey()` mismatch, warn user index is stale |
| **P11** | Embedding dimension mismatch (index vs model) | Throws at vectorStore | Add dimension validation gate before indexing |

### 9.6 Canonical Scenarios - Index & Persistence

| # | Scenario | Current Handling | Required Action |
|---|----------|------------------|-----------------|
| **I1** | Valid index file exists | Works | Fast load path |
| **I2** | Index file exists but is corrupt (invalid JSON) | `JSON.parse` throws | Catch, move to `.deleted/`, rebuild from scratch |
| **I3** | Index file exists but dimension mismatch | Throws or silent failure | Gate at load, offer "Rebuild?" modal |
| **I4** | Index file missing but state file exists | Treats as "crashed" | Correct - offers recovery |
| **I5** | Both index and state files missing | Starts fresh | `none` state, full rebuild |
| **I6** | State file corrupt | Not explicitly handled | Add corruption recovery: move aside, rebuild state from index |
| **I7** | Index locked by another process | EBUSY/EACCES error | Add file locking detection, show "Close other Obsidian instances" |
| **I8** | Disk full during index write | `atomicWriteFile` fails | Catch ENOSPC, show "Disk full" notice, don't corrupt partial writes |
| **I9** | Crash during indexing (power loss) | `indexingInProgress = true` persisted | Existing crash recovery modal (needs verification) |
| **I10** | Index outdated (vault changed externally) | `stale` state detection | Works, but no auto-recovery; add "Index outdated" banner |
| **I11** | User switches embedding model in settings | Partial - wizard handles | Add settings-side "Rebuild required" warning |

### 9.7 Canonical Scenarios - Configuration

| # | Scenario | Current Handling | Required Action |
|---|----------|------------------|-----------------|
| **C1** | Fresh install, no settings | Wizard launches | `UNINITIALIZED` → wizard flow |
| **C2** | Existing settings, setup incomplete | Wizard re-launches | Works |
| **C3** | Existing settings, setup complete | Services init | Works |
| **C4** | Settings version mismatch (migration) | `SETTINGS_VERSION` check | Add migration logic in `loadSettings()` |
| **C5** | Settings file corrupt | `JSON.parse` fails | Reset to defaults, show "Settings reset" notice |
| **C6** | Ollama host configured but port wrong | Connection fails | Add port validation (11434 default) |
| **C7** | LM Studio host configured but wrong | Connection fails | Add port validation (1234 default) |
| **C8** | PARA folders don't exist in vault | Classification fails silently | Add folder existence check, offer to create |
| **C9** | Excluded folders pattern invalid | Silent skip | Add glob validation in settings UI |

### 9.8 Canonical Scenarios - Lifecycle & Edge Cases

| # | Scenario | Current Handling | Required Action |
|---|----------|------------------|-----------------|
| **L1** | Plugin unload during indexing | `dispose()` called | Cancel in-flight operations via AbortController |
| **L2** | Obsidian window closed abruptly | OS terminates process | Atomic writes protect index; state may be stale on restart |
| **L3** | Multiple vaults open simultaneously | Separate plugin instances | Should work (isolated storagePaths) |
| **L4** | Plugin disabled then re-enabled | Full reload cycle | Works |
| **L5** | Obsidian mobile sync conflict | Not handled | Add index file conflict detection |
| **L6** | Settings changed via settings.json directly | Not detected | Add file watcher or checksum on focus |

### 9.9 Implementation Tasks

**PROMPT FOR AGENT:**
```
Rearchitect src/main.ts initialization into a formal state machine:

PHASE 1: Create State Machine Infrastructure

1. Create src/types/services.ts - Add InitializationState type:
   ```typescript
   export type InitializationState =
     | "UNINITIALIZED"
     | "CHECKING_PROVIDERS"
     | "LOADING_INDEX"
     | "WARMING_SERVICES"
     | "READY"
     | "DEGRADED"
     | "FAILED"
     | "CRASHED";

   export interface InitializationContext {
     state: InitializationState;
     errorMessage?: string;
     degradedReason?: string;
     capabilities: {
       embeddings: boolean;
       chat: boolean;
       search: boolean;
       indexing: boolean;
     };
   }
   ```

2. Create src/core/services/initializationStateMachine.ts:
   - Define state transitions with guards
   - Emit events on state changes: `init:state-changed`
   - Handle timeouts per state (e.g., 30s max for CHECKING_PROVIDERS)
   - Implement retry logic for transient failures

3. Create src/core/services/registry.ts - ServiceRegistry class:
   - Extract all service instantiation from main.ts
   - Provide getService<T>(name) with proper typing
   - Track service health and ready state
   - Support dispose() for clean shutdown

PHASE 2: Handle All Canonical Scenarios

4. Vault scenarios (V1-V10):
   - V1: Detect empty vault, skip indexing with informative message
   - V3-V5: Add progress modal with cancel button for large vaults
   - V9: Normalize paths before use
   - V10: Add configurable I/O timeout in settings

5. Provider scenarios (P1-P11):
   - P2: Create DEGRADED state with limited capabilities
   - P6: Parse network errors specifically
   - P7: Implement exponential backoff (3 attempts, 1s/2s/4s)
   - P11: Validate dimension before any indexing

6. Index scenarios (I1-I11):
   - I2, I6: Move corrupt files to .deleted/ with timestamp
   - I7: Detect EBUSY/EACCES, show "close other instances" modal
   - I8: Catch ENOSPC, prevent data loss

7. Configuration scenarios (C1-C9):
   - C4: Add settings migration function
   - C5: Reset to defaults with Notice
   - C8: Validate PARA folders exist

8. Lifecycle scenarios (L1-L6):
   - L1: Add AbortController to all long-running operations
   - L5: Consider adding .lock file for sync conflict detection

PHASE 3: Refactor main.ts

9. Reduce main.ts to ~300 lines:
   - Move initializeServicesAsync() to ServiceRegistry
   - Move registerCommands() to separate CommandRegistrar
   - Move showSetupWizard() flow to WizardController
   - Keep only: onload(), onunload(), ribbon icon

10. Add blocking modal for FAILED state:
    - Show when both providers down
    - "Check Services" button retries health check
    - "Run Setup Wizard" button for reconfiguration
```

---

## APPENDIX A: File Locations Quick Reference

| Category | Files |
|----------|-------|
| **Sidebar Components** | `src/ui/sidebar/App.tsx`, `src/ui/sidebar/components/*.tsx` |
| **Event Types** | `src/types/events.ts` |
| **Action Pipeline** | `src/core/intelligence/actionPipeline.ts`, `actionOrchestrator.ts` |
| **Agent System** | `src/core/agent/*.ts` |
| **Agentic Services** | `src/core/agentic/*.ts` |
| **Chat System** | `src/core/chat/*.ts`, `src/ui/modals/TaskModal.ts` |
| **Services Layer** | `src/services/*.ts` |
| **Plugin Entry** | `src/main.ts` |

---

## APPENDIX B: Event Flow Reference

**Events that ARE emitted:**
- `services:initialized` - Kernel after all services ready
- `health:changed` - HealthMonitor on status change
- `index:progress` / `index:complete` - SimpleIndexer during indexing
- `workflow:started/progress/completed/failed/cancelled` - WorkflowRunner
- `action:applied` / `action:undone` - ActionHistory
- `intelligence:updated` - NoteIntelligenceService
- `profile:updated` - ProfileManager
- `agent:task-update` - TaskQueue on task state change
- `search:started/progress/complete/error` - SearchPipeline

**Events that SHOULD be emitted but aren't:**
- `action:proposed` - When LLM generates actions awaiting review
- `lock:lost` - When VaultLock fails to maintain lock

**Events emitted but never handled:**
- `action:apply-requested` - From UI, needs handler
- `action:undo-requested` - From UI, needs handler

---

*End of CONTINUE.md - Generated by comprehensive codebase audit*
