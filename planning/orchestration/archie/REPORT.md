# Archie - Phase 4 Report

> **Status**: COMPLETE
> **Last Updated**: 2026-01-10
> **Branch**: `archie/backend-fixes`

---

## Summary

Phase 4 implements per-note conversation storage with lazy loading, reasoning summary extraction, and legacy migration support. The new architecture stores conversations in individual files keyed by noteId, enabling better performance through lazy loading and preparing for PARA-aware folder rollups.

---

## Files Modified

| File | Lines Changed | Key Changes |
|------|---------------|-------------|
| `src/core/chat/types.ts:1-80` | +73 | Added `StoredChatMessage`, `ConversationFile`, `ConversationRollup`, `AppendMessageOptions`, `MessageStatus` |
| `src/core/chat/conversationStore.ts:1-630` | Complete rewrite | Per-note file management, lazy loading, dual API (sync + async), migration |
| `src/core/chat/chatService.ts:32-60` | +29 | Added `extractReasoningSummary()` utility function |

---

## New Types (`types.ts:9-80`)

```typescript
MessageStatus           // "success" | "failed" | "cancelled"
StoredChatMessage       // Extended message with status, reasoningSummary, actionRef
ConversationFile        // Per-note file structure (version 2)
ConversationRollup      // Folder rollup structure for PARA summaries
AppendMessageOptions    // Options for appendMessageAsync
```

---

## Rewritten Class: ConversationStore (`conversationStore.ts`)

### Data Structure

```typescript
// In-memory cache (lazy loaded)
private loaded: Map<string, StoredChatMessage[]>  // noteId -> messages
private meta: Map<string, ConversationMeta>       // noteId -> metadata
private dirty: Set<string>                        // noteIds pending save
```

### Public Methods

| Method | Line | Signature | Purpose |
|--------|------|-----------|---------|
| `load()` | 90-92 | `async (): Promise<void>` | Backward-compatible (calls initialize) |
| `initialize()` | 82-84 | `async (): Promise<void>` | Initialize + migrate legacy |
| `loadConversation()` | 97-121 | `async (noteId): Promise<StoredChatMessage[]>` | Lazy load per-note |
| `getHistory()` | 130-151 | `(notePath): ExtendedChatMessage[]` | Sync, from cache only |
| `getHistoryAsync()` | 161-190 | `async (notePath, noteId?): Promise<ExtendedChatMessage[]>` | Async, lazy loading |
| `appendMessage()` | 199-243 | `(notePath, message): void` | Sync, backward-compatible |
| `appendMessageAsync()` | 254-313 | `async (notePath, message, options?, noteId?): Promise<void>` | Async with reasoning |
| `handleRename()` | 321-362 | `(oldPath, newPath): void` | Handles noteId migration |
| `deleteConversation()` | 369-389 | `(notePath): void` | Delete with archive |
| `hasConversation()` | 396-399 | `(notePath): boolean` | Check cache |
| `getConversationPaths()` | 405-407 | `(): string[]` | Backward-compatible |
| `flush()` | 416-425 | `async (): Promise<void>` | Save dirty conversations |
| `generateRollup()` | 430-488 | `async (folder): Promise<ConversationRollup>` | On-demand folder summary |
| `prune()` | 493-540 | `async (): Promise<void>` | Prune old (file-based) |

### Private Methods

| Method | Line | Purpose |
|--------|------|---------|
| `scheduleFlush()` | 589-595 | Debounced save (500ms) |
| `saveConversation()` | 600-620 | Save single conversation file |
| `migrateIfNeeded()` | 625-623 | Migrate legacy conversations.json |

---

## New Utility Function (`chatService.ts:43-60`)

```typescript
export function extractReasoningSummary(
  thinkingContent: string | null | undefined,
  maxLength: number = 200,
): string | undefined
```

**Purpose**: Extracts first 200 characters of thinking content for storage, avoiding full `<think>` block bloat.

---

## Backward Compatibility

The old synchronous API is preserved:

| Old Method | New Behavior |
|------------|--------------|
| `load()` | Calls `initialize()` |
| `getHistory(notePath)` | Returns from cache (sync), empty if not loaded |
| `appendMessage(notePath, msg)` | Sync append, auto-computes noteId |
| `handleRename(old, new)` | Handles noteId migration automatically |
| `deleteConversation(notePath)` | Takes path, computes noteId |
| `hasConversation(notePath)` | Checks cache by computed noteId |
| `getConversationPaths()` | Returns paths from meta |

New async API for enhanced features:

| New Method | Purpose |
|------------|---------|
| `getHistoryAsync(notePath, noteId?)` | Lazy loads from disk |
| `appendMessageAsync(notePath, msg, opts?, noteId?)` | Supports reasoning summary |

---

## File Structure

```
data/conversations/
  notes/
    {noteId}.json      # Per-note conversation
  rollups/
    {para-folder}.json # On-demand folder summaries
```

### ConversationFile Schema (v2)

```json
{
  "version": 2,
  "noteId": "abc123def456...",
  "notePath": "projects/auth/setup.md",
  "messages": [
    {
      "id": "msg-001",
      "role": "assistant",
      "content": "Here's how...",
      "timestamp": "2026-01-10T12:00:00Z",
      "status": "success",
      "reasoningSummary": "Analyzed JWT config...",
      "actionRef": "action-xyz"
    }
  ],
  "createdAt": "...",
  "lastAccessedAt": "..."
}
```

---

## Migration Approach

1. **Detection**: `migrateIfNeeded()` checks for legacy `conversations.json`
2. **Skip if migrated**: If `data/conversations/notes/` has files, skip
3. **Migration steps**:
   - Parse legacy file
   - Generate noteId from each notePath using `generateNoteId()`
   - Create per-note files with version 2 schema
   - Add `status` field based on content presence
4. **Archive**: Move legacy file to `_deleted/conversations-legacy-{timestamp}.json`

---

## Verification Results

### Build
- [x] `bun run typecheck` passes (no errors)
- [x] `bun run build` passes (554.6KB main.js)

### Code Quality
- [x] No TypeScript errors
- [x] Uses Phase 1 path methods (`storagePaths.conversationsNotes`, `getConversationPath()`)
- [x] Backward compatible with existing callers
- [x] Migrates legacy storage automatically

---

## Usage Example

### Storing assistant message with reasoning summary:

```typescript
import { extractReasoningSummary } from "./chatService";

// After receiving ChatStreamEvent with type: "complete"
const reasoningSummary = extractReasoningSummary(event.thinking);

await conversationStore.appendMessageAsync(
  notePath,
  {
    id: generateId(),
    role: "assistant",
    content: event.content,  // Content WITHOUT thinking
    timestamp: new Date(),
  },
  {
    reasoningSummary,
    status: event.content ? "success" : "failed",
    actionRef: resultingActionId,
  }
);
```

---

## Not Implemented (Deferred)

1. **Topic extraction for rollups** - `topTopics` field always empty (would require LLM)
2. **Automatic rollup generation** - On-demand only via `generateRollup(folder)`
3. **Cross-note conversation search** - Not in Phase 4 scope

---

## Previous Phases

### Phase 3: Intelligence Tag-Keyed Sharding (COMPLETE)
Reorganized intelligence from model-keyed to topic-keyed files.

### Phase 2: Chunk/Embedding Separation (COMPLETE)
Implemented separated storage for chunks (model-agnostic) and embeddings (model-specific).

### Phase 1: Storage Path Infrastructure (COMPLETE)
Established path infrastructure for hierarchical storage with 45+ path constants.

---

## Next Recommended Action

Proceed to Phase 5: Actions Time-Bucketed + Diff Undo.
