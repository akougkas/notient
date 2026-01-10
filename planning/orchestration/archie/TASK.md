# Archie - Phase 4: Conversations Per-Note + Rollups

> **Status**: ASSIGNED
> **Assigned**: 2026-01-10
> **Branch**: `archie/backend-fixes`
> **Spec**: `planning/coding_tasks/04-conversations-per-note.md`

---

## Git Workflow (CRITICAL)

### Before Starting
```bash
git status
git diff --name-only
```
Understand what files are already modified. DO NOT touch files you don't need.

### During Work
- ONLY modify files listed in "Files to Modify" below
- Keep changes focused and minimal

### After Completing
```bash
# Stage ONLY your files
git add src/core/chat/types.ts
git add src/core/chat/conversationStore.ts
git add src/core/chat/chatService.ts
git add planning/orchestration/archie/REPORT.md

# Commit with descriptive message
git commit -m "refactor(chat): Implement per-note conversation storage

- Replace single conversations.json with per-note files
- Add lazy loading (only load when needed)
- Strip <think> blocks, store reasoning summary
- Add status field for failed/cancelled messages
- Add on-demand folder rollup generation
- Migrate legacy conversations

Phase 4 of storage restructure."

# DO NOT PUSH - only commit
```

### Rules
- **NO `git push`** - Only local commits
- **NO staging unrelated files** - Check `git status` before commit
- **NO amending** other people's commits

---

## Objective

Restructure conversation storage from single file to per-note files with on-demand folder rollups. This enables:
- Better performance (only load conversation when needed)
- PARA-aware folder summaries
- Reasoning trace handling (strip, summarize, link to actions)

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/core/chat/types.ts` | Add StoredChatMessage, ConversationFile, ConversationRollup types |
| `src/core/chat/conversationStore.ts` | Rewrite for per-note files, lazy loading, migration |
| `src/core/chat/chatService.ts` | Update to strip reasoning traces, pass status |

---

## Implementation Steps

### 1. Add Types (`types.ts`)

```typescript
export interface StoredChatMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: string;
  attachments?: Array<{ id: string; type: string; filename: string; path: string; }>;
  status?: "success" | "failed" | "cancelled";
  reasoningSummary?: string;
  actionRef?: string;
}

export interface ConversationFile {
  version: number;
  noteId: string;
  notePath: string;
  messages: StoredChatMessage[];
  createdAt: string;
  lastAccessedAt: string;
}

export interface ConversationRollup {
  version: number;
  folder: string;
  noteCount: number;
  messageCount: number;
  topTopics: string[];
  recentNotes: Array<{ noteId: string; path: string; messageCount: number; lastMessage: string; }>;
  generatedAt: string;
}
```

### 2. Rewrite ConversationStore

- Replace single-file with per-note file management
- Use `storagePaths.getConversationPath(noteId)` from Phase 1
- Key methods:
  - `loadConversation(noteId)` - Lazy load per-note
  - `getHistory(notePath, noteId)` - Get messages
  - `appendMessage(notePath, noteId, message, options)` - Add with reasoning handling
  - `flush()` - Save dirty conversations
  - `generateRollup(folder)` - On-demand folder summary
  - `migrateIfNeeded()` - Migrate legacy conversations.json

### 3. Update ChatService

- After receiving response, parse thinking blocks with ThinkingParser
- Summarize reasoning (first 200 chars)
- Store message with summary, NOT full thinking
- Set status field appropriately

### 4. Migration Logic

- Detect legacy `conversations.json`
- Parse and split by note
- Write per-note files to `data/conversations/notes/`
- Move legacy file to `_deleted/`

---

## Use Phase 1 Path Methods

```typescript
storagePaths.conversationsNotes           // Directory for per-note files
storagePaths.conversationsRollups         // Directory for rollups
storagePaths.getConversationPath(noteId)  // {noteId}.json path
storagePaths.getConversationRollupPath(folder)  // rollup path
storagePaths.tempDeleted                  // For archived legacy file
```

---

## Verification

```bash
bun run typecheck && bun run build
```

### Manual Test
1. Start with existing `conversations.json` file
2. Load plugin → migration should run
3. Verify `data/conversations/notes/` created
4. Test chat → verify per-note file created
5. Verify `<think>` blocks are summarized, not stored in full

---

## Report

When complete, update `planning/orchestration/archie/REPORT.md` with:
- Files modified (with line ranges)
- New types added
- Key methods implemented
- Migration approach
- Build verification results
