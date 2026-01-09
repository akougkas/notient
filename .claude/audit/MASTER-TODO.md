# Notient Codebase Audit - Master Implementation TODO

**Audit Date:** 2026-01-09
**Status:** Sidebar stuck on "Initializing services..." + incomplete Preact migration

---

## Executive Summary

| Area | Critical | High | Medium | Low | Total |
|------|----------|------|--------|-----|-------|
| Sidebar & Preact | 2 | 2 | 3 | 0 | 7 |
| Kernel & Services | 2 | 3 | 2 | 0 | 7 |
| Settings & Index | 2 | 5 | 8 | 2 | 17 |
| Search & Omnibar | 2 | 2 | 5 | 4 | 13 |
| Intelligence & Actions | 3 | 4 | 8 | 3 | 18 |
| Chat & Agent | 3 | 4 | 7 | 3 | 17 |
| **TOTAL** | **14** | **20** | **33** | **12** | **79** |

---

## CRITICAL FIXES (Must do first)

### 🔴 1. Sidebar Initialization (ROOT CAUSE)

**File:** `src/ui/sidebar/App.tsx:91`

```typescript
// CURRENT (broken):
const isReady = kernel.isServicesInitialized;  // Static read, never updates

// FIX: Add event subscription
const [isReady, setIsReady] = useState(kernel.isServicesInitialized);
useEventBus("services:initialized", () => setIsReady(true));
```

**Impact:** Fixes "Initializing services..." forever bug

---

### 🔴 2. Service Key Mismatch in NoteIntelligence

**File:** `src/core/intelligence/noteIntelligence.ts:503`

```typescript
// CURRENT (broken):
const search = this.kernel.getService<SearchPipeline>("searchPipeline");

// FIX:
const search = this.kernel.getService<SearchPipeline>("search");
```

**Impact:** Fixes "find related notes" feature

---

### 🔴 3. Async/Await on Synchronous Method

**File:** `src/core/agent/profileManager.ts:129`

```typescript
// CURRENT (wrong):
const indexedCount = await indexManager.getIndexedCount();

// FIX:
const indexedCount = indexManager.getIndexedCount();
```

**Impact:** Prevents runtime type errors

---

### 🔴 4. ChatHistory Truncation

**Files:** `src/ui/modals/TaskModal.ts:296, 360, 406`

```typescript
// CURRENT (truncates to 10 messages):
this.task.chatHistory = this.session.getMessagesForLLM();

// FIX (preserve full history):
this.task.chatHistory = this.session.getMessages();
```

**Impact:** Fixes conversation history loss

---

### 🔴 5. Early Return Without Flag Reset

**File:** `src/main.ts:231-241`

```typescript
// After early return, add:
this.kernel.setServicesInitializing(false);
// Emit failure event for UI
this.kernel.eventBus.emit("services:failed", { reason: "missing_config" });
```

**Impact:** Prevents permanent stuck state on config errors

---

## HIGH PRIORITY FIXES

### 🟠 6. Phase 3 Action Stubs
**File:** `src/core/agentic/actionApplier.ts:332-342`
**Action:** Either implement or remove `extract_to_calendar` and `highlight_text_issues`

### 🟠 7. Profile Updates Not Propagated to Agent
**Files:** `src/core/agent/agentLoop.ts:45-46`, `src/ui/settings/SettingsTab.ts`
**Action:** Wire ProfileManager changes to call `agent.setProfile()`

### 🟠 8. Omnibar Component Missing
**File:** Create `src/ui/sidebar/components/Omnibar.tsx`
**Action:** Implement search input component using existing CSS and CommandParser

### 🟠 9. Review Queue UI Missing
**File:** `src/ui/dashboard/`
**Action:** Add tab to display WorkflowRun.reviewQueue for user approval

### 🟠 10. Batch Operation Undo Incomplete
**File:** `src/core/agentic/actionApplier.ts:662-736`
**Action:** Handle partial failures correctly in undo state

### 🟠 11. Index Management Error Handling
**File:** `src/ui/settings/panels/IndexManagementPanel.ts`
**Action:** Add try/catch with user feedback for all async operations

### 🟠 12. ConversationStore Load Missing
**File:** `src/ui/modals/TaskModal.ts`
**Action:** Load persisted conversation history on modal open

---

## MEDIUM PRIORITY FIXES

### 🟡 Sidebar & Preact
- [ ] Add `useServicesInitialized` hook
- [ ] Fix `useCallback` circular dependency in KernelContext
- [ ] Remove or integrate dead `IntelligenceActions.ts`

### 🟡 Kernel & Services
- [ ] Make service initialization errors emit events
- [ ] Consistent error strategy across services
- [ ] Type service references (not `unknown`)

### 🟡 Settings & Index
- [ ] Add chunk size change warning
- [ ] Import index dimension validation
- [ ] Complete settings validation
- [ ] Fix button state management

### 🟡 Search & Omnibar
- [ ] Fix cache key generation bug
- [ ] Handle SearchPipeline disposal
- [ ] Add search progress events to UI

### 🟡 Intelligence & Actions
- [ ] Wire ProfileManager to ActionOrchestrator
- [ ] Enforce batch execution order
- [ ] Bound NoteIntelligenceService queue

### 🟡 Chat & Agent
- [ ] Add timeout to LLM calls
- [ ] Include profile in action plan prompts
- [ ] Consistent ExtendedChatMessage usage

---

## LOW PRIORITY / TECH DEBT

- [ ] Refactor ProfileManager.validate() (complexity 27)
- [ ] Refactor ActionPipeline.extractJson() (complexity 45)
- [ ] Export profile types from index
- [ ] Add PARA detection cache
- [ ] Semantic embedding cache deduplication
- [ ] Clean up lint warnings

---

## Files to Modify (By Priority)

### Immediate
1. `src/ui/sidebar/App.tsx` - Add services:initialized listener
2. `src/core/intelligence/noteIntelligence.ts` - Fix service key
3. `src/core/agent/profileManager.ts` - Remove await
4. `src/ui/modals/TaskModal.ts` - Fix history sync
5. `src/main.ts` - Add failure event

### Soon
6. `src/core/agentic/actionApplier.ts` - Handle Phase 3 stubs
7. `src/ui/sidebar/components/Omnibar.tsx` - Create component
8. `src/ui/settings/panels/IndexManagementPanel.ts` - Error handling
9. `src/core/agent/agentLoop.ts` - Profile propagation

### Later
10. Various lint/complexity fixes
11. Performance optimizations
12. Type safety improvements

---

## Testing Checklist

After fixes, verify:

- [ ] Sidebar shows content after services initialize
- [ ] "Find related notes" returns results
- [ ] Profile generation completes without error
- [ ] Chat history preserved across modal opens
- [ ] Settings changes persist correctly
- [ ] Search returns results with reranking
- [ ] Actions can be applied and undone
- [ ] Workflows show review queue

---

## Individual Audit Files

- `.claude/audit/sidebar-preact-findings.md`
- `.claude/audit/kernel-services-findings.md`
- `.claude/audit/settings-index-findings.md`
- `.claude/audit/search-omnibar-findings.md`
- `.claude/audit/intelligence-actions-findings.md`
- `.claude/audit/chat-agent-findings.md`
