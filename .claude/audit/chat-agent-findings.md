# Chat & Agent Loop Audit Findings

## Critical Issues (Blocking)

### 1. Async/Await Type Mismatch in ProfileManager
- [ ] `await indexManager.getIndexedCount()` on synchronous method | File: `src/core/agent/profileManager.ts:129` | **Impact: Runtime type error**

```typescript
const indexedCount = await indexManager.getIndexedCount();
// getIndexedCount() returns number, not Promise<number>
```

### 2. ChatHistory Synchronization Loss in TaskModal
- [ ] `task.chatHistory` overwritten with truncated window | Files: `src/ui/modals/TaskModal.ts:296, 360, 406` | **Impact: History corruption**

Problem flow:
1. User sends 15 messages
2. TaskModal renders chat (shows 15)
3. TaskModal writes `this.task.chatHistory = this.session.getMessagesForLLM()` (10 max)
4. Modal closes
5. Task reopened → only 10 messages

**Fix:** Use `getMessages()` (full history) not `getMessagesForLLM()` (windowed)

### 3. Missing Conversation Persistence Integration
- [ ] ConversationStore persists but TaskModal never loads | Files: `src/ui/modals/TaskModal.ts`, `src/core/agent/taskQueue.ts:54-93` | **Impact: Multi-session chat broken**

---

## Implementation Gaps (Missing Features)

### 4. Action Plan Generation Missing Conversation Context
- [ ] PromptParams doesn't include conversation history | File: `src/core/agent/agentLoop.ts:248-286` | **Impact: Multi-turn guidance ignored**

Only uses: current note + related notes + context summary
Ignores: previous user instructions in conversation

### 5. ProposedAction Type Casting Without Validation
- [ ] Uses `as ProposedAction` without verifying required fields | File: `src/core/agent/agentLoop.ts:386` | **Risk: Silent failures on interface changes**

### 6. TaskResult Type Mismatch
- [ ] "enrichment", "links", "classification" types defined but never used | File: `src/core/agent/agentLoop.ts:291, 296` | **Impact: UI can't distinguish result types**

### 7. SearchPipeline and ContextBuilder Null Handling
- [ ] Behavior unclear when search unavailable | File: `src/core/agent/agentLoop.ts:33-34, 130-174` | **Impact: Poor results without RAG**

---

## Type Errors / Runtime Errors

### 8. ExtendedChatMessage Field Inconsistency
- [ ] Some code creates plain ChatMessage, others use ExtendedChatMessage | Files: `agentLoop.ts:202`, `taskQueue.ts:84-90`, `TaskModal.ts:359` | **Impact: Missing metadata**

### 9. No Validation of ConversationStore Loading
- [ ] TaskModal assumes task.chatHistory has all context | File: `src/ui/modals/TaskModal.ts:33-34` | **Impact: Lost multi-session conversations**

---

## Integration Issues

### 10. Profile Not Injected Into Action Plan Prompt
- [ ] `buildActionPlanPrompt()` ignores profile context | File: `src/core/agent/promptBuilder.ts:186-227` | **Impact: Action plans not personalized**

`buildSystemPrompt()` uses profile ✓
`buildActionPlanPrompt()` does not ✗

### 11. Agent.setProfile() Never Called
- [ ] Method exists but has no callers | File: `src/core/agent/agentLoop.ts:45-46` | **Impact: Profile changes require restart**

**Missing Integration:**
1. Monitor profile changes in ProfileManager
2. Call agent.setProfile() when profile updated

### 12. Chat Session State Management Fragmented
- [ ] Three places manage chat state with sync issues | Impact: Truncation and data loss

State locations:
1. `ChatSession` (in-memory, full history)
2. `task.chatHistory` (on AgentTask)
3. `ConversationStore` (persisted)

---

## Missing Error Handling

### 13. No Timeout for Action Plan Generation
- [ ] `await this.llm.complete()` with no timeout | File: `src/core/agent/agentLoop.ts:273-274` | **Impact: UI hangs on LLM freeze**

### 14. No Recovery if Citation Link Generation Fails
- [ ] `buildCitationLink()` errors not caught | File: `src/core/agent/agentLoop.ts:158` | **Risk: Runtime exception**

### 15. No Validation of Search Results Structure
- [ ] Assumes searchResults has expected structure | File: `src/core/agent/agentLoop.ts:135-164` | **Risk: Malformed results crash**

---

## Lint Warnings

### 16. ProfileManager.validate() Complexity
- [ ] Cognitive complexity 27 (max 15) | File: `src/core/agent/profileManager.ts:179` | **Impact: Hard to test/maintain**

### 17. ActionPipeline.extractJson() Complexity
- [ ] Cognitive complexity 45 (max 15) | File: `src/core/intelligence/actionPipeline.ts` | **Impact: Hard to test/maintain**

---

## Summary Table

| Category | Count | Severity |
|----------|-------|----------|
| Critical Issues | 3 | HIGH |
| Implementation Gaps | 4 | MEDIUM |
| Type/Runtime Errors | 2 | MEDIUM |
| Integration Issues | 3 | HIGH |
| Error Handling | 3 | MEDIUM |
| Lint Warnings | 2 | LOW |

**Total Issues:** 17

**Priority Fixes:**
1. **CRITICAL:** Remove `await` on sync getIndexedCount()
2. **CRITICAL:** Fix chatHistory truncation - use getMessages() not getMessagesForLLM()
3. **HIGH:** Load persisted conversation history in TaskModal
4. **HIGH:** Wire profile updates to agent via observer pattern
