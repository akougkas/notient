# Phase 4: Conversations Per-Note + On-Demand Rollups

## Objective

Restructure conversation storage from single file to per-note files with on-demand folder rollups. This enables:
- Better performance (only load conversation when needed)
- PARA-aware folder summaries
- Reasoning trace handling (strip, summarize, link to actions)

## Prerequisites

- Phase 1 completed (storage paths)
- Read `/.claude/CLAUDE.md` for project context
- Read current implementation:
  - `src/core/chat/conversationStore.ts`
  - `src/core/chat/types.ts`
  - `src/core/chat/chatService.ts`

## Files to Modify

1. `src/core/chat/types.ts` - Add new types
2. `src/core/chat/conversationStore.ts` - Rewrite for per-note files
3. `src/core/chat/chatService.ts` - Update to strip reasoning traces

## Current Architecture

**Single file**: `conversations.json`
```json
{
  "version": 1,
  "conversations": {
    "path/to/note.md": {
      "notePath": "path/to/note.md",
      "messages": [ ... ],
      "createdAt": "...",
      "lastAccessedAt": "..."
    }
  }
}
```

**Problems**:
- Full file loaded at startup
- `<think>` blocks stored inline (bloat)
- Empty messages stored
- No folder-level context

## Target Architecture

### Per-Note Files (`data/conversations/notes/{noteId}.json`)

```json
{
  "version": 2,
  "noteId": "abc123",
  "notePath": "projects/auth/setup.md",
  "messages": [
    {
      "id": "msg-001",
      "role": "user",
      "content": "How do I configure JWT?",
      "timestamp": "2026-01-10T12:00:00Z"
    },
    {
      "id": "msg-002",
      "role": "assistant",
      "content": "Here's how to configure JWT...",
      "timestamp": "2026-01-10T12:00:05Z",
      "reasoningSummary": "Analyzed note context and JWT best practices",
      "actionRef": "action-xyz",
      "status": "success"
    }
  ],
  "createdAt": "2026-01-10T11:55:00Z",
  "lastAccessedAt": "2026-01-10T12:00:05Z"
}
```

### Rollup Files (`data/conversations/rollups/{para-folder}.json`)

Generated **on-demand** when user requests folder summary:

```json
{
  "version": 1,
  "folder": "1-projects/iowarp",
  "noteCount": 12,
  "messageCount": 45,
  "topTopics": ["authentication", "deployment", "testing"],
  "recentNotes": [
    {
      "noteId": "abc123",
      "path": "1-projects/iowarp/auth.md",
      "messageCount": 8,
      "lastMessage": "2026-01-10T12:00:05Z"
    }
  ],
  "generatedAt": "2026-01-10T12:30:00Z"
}
```

### Root Fallback (`data/conversations/_root.json`)

For notes not in PARA folders (uses same format as per-note).

## Key Changes

### 1. Message Status Field

```typescript
interface SerializedMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: string;
  // NEW fields:
  status?: "success" | "failed" | "cancelled";
  reasoningSummary?: string;  // Summarized <think> block
  actionRef?: string;         // Link to action if this message caused one
}
```

### 2. Reasoning Trace Handling

When storing assistant messages:
1. Extract `<think>...</think>` block
2. Summarize to 1-2 sentences (using existing ThinkingParser)
3. Store summary in `reasoningSummary` field
4. If message triggered an action, store `actionRef`

### 3. Empty Message Handling

- Messages with `content: ""` get `status: "failed"` or `status: "cancelled"`
- Still stored for audit trail

## Implementation Steps

### Step 1: Update Types (`types.ts`)

```typescript
/**
 * Extended message with status and reasoning
 */
export interface StoredChatMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: string;
  attachments?: Array<{
    id: string;
    type: "rag-citation" | "user-attached";
    filename: string;
    path: string;
  }>;
  // New fields
  status?: "success" | "failed" | "cancelled";
  reasoningSummary?: string;
  actionRef?: string;
}

/**
 * Per-note conversation file
 */
export interface ConversationFile {
  version: number;
  noteId: string;
  notePath: string;
  messages: StoredChatMessage[];
  createdAt: string;
  lastAccessedAt: string;
}

/**
 * Folder rollup structure
 */
export interface ConversationRollup {
  version: number;
  folder: string;
  noteCount: number;
  messageCount: number;
  topTopics: string[];
  recentNotes: Array<{
    noteId: string;
    path: string;
    messageCount: number;
    lastMessage: string;
  }>;
  generatedAt: string;
}
```

### Step 2: Rewrite ConversationStore

```typescript
const CONVERSATION_VERSION = 2;
const DEFAULT_MAX_MESSAGES_PER_NOTE = 50;
const DEFAULT_MAX_AGE_DAYS = 30;

export class ConversationStore {
  // In-memory cache (lazy loaded)
  private loaded: Map<string, StoredChatMessage[]> = new Map();
  private meta: Map<string, { createdAt: Date; lastAccessedAt: Date }> = new Map();
  private dirty: Set<string> = new Set();  // noteIds with unsaved changes
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private storagePaths: StoragePaths,
    private retention: ChatRetentionConfig = {
      maxMessagesPerNote: DEFAULT_MAX_MESSAGES_PER_NOTE,
      maxAgeDays: DEFAULT_MAX_AGE_DAYS,
    },
  ) {}

  /**
   * Load conversation for a specific note (lazy)
   */
  async loadConversation(noteId: string): Promise<StoredChatMessage[]> {
    // Check cache first
    if (this.loaded.has(noteId)) {
      return this.loaded.get(noteId)!;
    }

    const filePath = this.storagePaths.getConversationPath(noteId);

    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const data: ConversationFile = JSON.parse(content);

      this.loaded.set(noteId, data.messages);
      this.meta.set(noteId, {
        createdAt: new Date(data.createdAt),
        lastAccessedAt: new Date(data.lastAccessedAt),
      });

      return data.messages;
    } catch {
      // No conversation yet
      return [];
    }
  }

  /**
   * Get conversation history (loads if needed)
   */
  async getHistory(notePath: string, noteId: string): Promise<ExtendedChatMessage[]> {
    const messages = await this.loadConversation(noteId);

    // Update last accessed
    const meta = this.meta.get(noteId);
    if (meta) {
      meta.lastAccessedAt = new Date();
      this.dirty.add(noteId);
      this.scheduleFlush();
    }

    // Convert to ExtendedChatMessage format
    return messages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: new Date(m.timestamp),
      attachments: m.attachments,
    }));
  }

  /**
   * Append a message with reasoning handling
   */
  async appendMessage(
    notePath: string,
    noteId: string,
    message: ExtendedChatMessage,
    options?: {
      reasoningSummary?: string;
      actionRef?: string;
      status?: "success" | "failed" | "cancelled";
    }
  ): Promise<void> {
    // Load conversation if not cached
    if (!this.loaded.has(noteId)) {
      await this.loadConversation(noteId);
    }

    let messages = this.loaded.get(noteId);
    if (!messages) {
      messages = [];
      this.loaded.set(noteId, messages);
      this.meta.set(noteId, {
        createdAt: new Date(),
        lastAccessedAt: new Date(),
      });
    }

    // Determine status
    let status = options?.status;
    if (!status && message.role === "assistant") {
      status = message.content ? "success" : "failed";
    }

    // Create stored message
    const stored: StoredChatMessage = {
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp.toISOString(),
      attachments: message.attachments,
      status,
      reasoningSummary: options?.reasoningSummary,
      actionRef: options?.actionRef,
    };

    messages.push(stored);

    // Enforce limit
    if (messages.length > this.retention.maxMessagesPerNote) {
      const excess = messages.length - this.retention.maxMessagesPerNote;
      messages.splice(0, excess);
    }

    // Update meta
    const meta = this.meta.get(noteId);
    if (meta) {
      meta.lastAccessedAt = new Date();
    }

    this.dirty.add(noteId);
    this.scheduleFlush();
  }

  /**
   * Save a specific conversation to disk
   */
  private async saveConversation(noteId: string): Promise<void> {
    const messages = this.loaded.get(noteId);
    const meta = this.meta.get(noteId);
    if (!messages || !meta) return;

    // Find notePath from first message or lookup
    const notePath = messages[0]?.attachments?.[0]?.path || noteId;  // Fallback

    const filePath = this.storagePaths.getConversationPath(noteId);
    const data: ConversationFile = {
      version: CONVERSATION_VERSION,
      noteId,
      notePath,
      messages,
      createdAt: meta.createdAt.toISOString(),
      lastAccessedAt: meta.lastAccessedAt.toISOString(),
    };

    await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
  }

  /**
   * Flush all dirty conversations
   */
  async flush(): Promise<void> {
    if (this.dirty.size === 0) return;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const toSave = Array.from(this.dirty);
    this.dirty.clear();

    for (const noteId of toSave) {
      try {
        await this.saveConversation(noteId);
      } catch (error) {
        console.error(`[ConversationStore] Failed to save ${noteId}:`, error);
        this.dirty.add(noteId);  // Re-add for retry
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 500);
  }

  /**
   * Generate folder rollup (on-demand)
   */
  async generateRollup(folder: string): Promise<ConversationRollup> {
    const notesDir = this.storagePaths.conversationsNotes;
    const files = await fs.promises.readdir(notesDir);

    const recentNotes: ConversationRollup['recentNotes'] = [];
    let totalMessages = 0;

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const noteId = file.replace('.json', '');
      const filePath = path.join(notesDir, file);

      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const data: ConversationFile = JSON.parse(content);

        // Check if note is in this folder
        if (!data.notePath.startsWith(folder)) continue;

        totalMessages += data.messages.length;

        const lastMsg = data.messages[data.messages.length - 1];
        recentNotes.push({
          noteId: data.noteId,
          path: data.notePath,
          messageCount: data.messages.length,
          lastMessage: lastMsg?.timestamp ?? data.lastAccessedAt,
        });
      } catch {
        // Skip unreadable files
      }
    }

    // Sort by last message (most recent first)
    recentNotes.sort((a, b) =>
      new Date(b.lastMessage).getTime() - new Date(a.lastMessage).getTime()
    );

    const rollup: ConversationRollup = {
      version: 1,
      folder,
      noteCount: recentNotes.length,
      messageCount: totalMessages,
      topTopics: [],  // Could extract via LLM, but keeping simple for now
      recentNotes: recentNotes.slice(0, 10),  // Top 10
      generatedAt: new Date().toISOString(),
    };

    // Save rollup
    const rollupPath = this.storagePaths.getConversationRollupPath(folder);
    await atomicWriteFile(rollupPath, JSON.stringify(rollup, null, 2));

    return rollup;
  }

  /**
   * Handle note rename
   */
  async handleRename(oldPath: string, newPath: string, noteId: string): Promise<void> {
    // Update in-memory
    const messages = this.loaded.get(noteId);
    if (messages) {
      this.dirty.add(noteId);
      await this.flush();
    }

    // File stays the same (keyed by noteId, not path)
    // But we need to update notePath in the file
  }

  /**
   * Delete conversation
   */
  async deleteConversation(noteId: string): Promise<void> {
    this.loaded.delete(noteId);
    this.meta.delete(noteId);
    this.dirty.delete(noteId);

    // Move to _deleted
    const filePath = this.storagePaths.getConversationPath(noteId);
    const deletedPath = path.join(
      this.storagePaths.tempDeleted,
      `conversation-${noteId}-${Date.now()}.json`
    );

    try {
      await fs.promises.rename(filePath, deletedPath);
    } catch {
      // File might not exist
    }
  }

  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    this.loaded.clear();
    this.meta.clear();
  }
}
```

### Step 3: Update ChatService for Reasoning Handling

In `chatService.ts`, modify message storage to strip and summarize reasoning:

```typescript
// After receiving complete assistant response:

// 1. Parse thinking blocks
const { content, thinkingBlocks } = ThinkingParser.parse(rawResponse);

// 2. Summarize reasoning (simple approach)
let reasoningSummary: string | undefined;
if (thinkingBlocks.length > 0) {
  // Take first 200 chars of first thinking block as summary
  const fullThinking = thinkingBlocks.map(b => b.content).join('\n');
  reasoningSummary = fullThinking.slice(0, 200);
  if (fullThinking.length > 200) {
    reasoningSummary += '...';
  }
}

// 3. Store message with summary (not full thinking)
await this.conversationStore.appendMessage(
  notePath,
  noteId,
  {
    id: generateId(),
    role: 'assistant',
    content,  // Content WITHOUT thinking blocks
    timestamp: new Date(),
  },
  {
    reasoningSummary,
    actionRef: resultingActionId,  // If message caused an action
    status: content ? 'success' : 'failed',
  }
);
```

### Step 4: Migration Logic

Add to ConversationStore constructor or separate method:

```typescript
async migrateIfNeeded(): Promise<void> {
  const legacyPath = this.storagePaths.legacyConversations;

  try {
    const exists = await fs.promises.access(legacyPath).then(() => true).catch(() => false);
    if (!exists) return;

    // Check if already migrated
    const newDir = this.storagePaths.conversationsNotes;
    const newExists = await fs.promises.access(newDir).then(() => true).catch(() => false);
    if (newExists) {
      const files = await fs.promises.readdir(newDir);
      if (files.length > 0) return;  // Already migrated
    }

    console.log('[ConversationStore] Migrating legacy conversations...');

    // Read legacy file
    const content = await fs.promises.readFile(legacyPath, 'utf-8');
    const legacy = JSON.parse(content);

    // Ensure new directory
    await fs.promises.mkdir(newDir, { recursive: true });

    // Migrate each conversation
    for (const [notePath, conv] of Object.entries(legacy.conversations ?? {})) {
      const conversation = conv as any;
      const noteId = generateNoteId(notePath);

      // Convert messages
      const messages: StoredChatMessage[] = (conversation.messages ?? []).map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        attachments: m.attachments,
        status: m.content ? 'success' : 'failed',
      }));

      // Save per-note file
      const data: ConversationFile = {
        version: CONVERSATION_VERSION,
        noteId,
        notePath,
        messages,
        createdAt: conversation.createdAt,
        lastAccessedAt: conversation.lastAccessedAt,
      };

      const filePath = this.storagePaths.getConversationPath(noteId);
      await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
    }

    // Move legacy file
    const deletedPath = path.join(
      this.storagePaths.tempDeleted,
      `conversations-legacy-${Date.now()}.json`
    );
    await fs.promises.rename(legacyPath, deletedPath);

    console.log('[ConversationStore] Migration complete');
  } catch (error) {
    console.error('[ConversationStore] Migration failed:', error);
  }
}
```

## Verification

### 1. Build Check
```bash
bun run typecheck
bun run build
bun run dev
```

### 2. Migration Test

1. Start with existing `conversations.json`
2. Load plugin
3. Verify:
   - `data/conversations/notes/` created
   - Per-note files created
   - Legacy file moved to `_deleted/`

### 3. Functionality Test

1. Open a note
2. Send a chat message
3. Verify:
   - Per-note file created/updated
   - `<think>` blocks summarized (not stored in full)
   - `status` field set appropriately

4. Test with failed message (empty response)
5. Verify `status: "failed"` in stored message

### 4. Rollup Test

```typescript
// Generate rollup for a PARA folder
const rollup = await conversationStore.generateRollup('1-projects/iowarp');
console.log(rollup);
```

## Commit Message

```
refactor(chat): Implement per-note conversation storage

- Replace single conversations.json with per-note files
- Add lazy loading (only load when needed)
- Strip <think> blocks, store reasoning summary
- Add status field for failed/cancelled messages
- Add on-demand folder rollup generation
- Migrate legacy conversations

Part of storage restructure Phase 4.
```

## Next Phase

After this phase is complete, proceed to Phase 5 (Actions Time-Bucketed + Diff Undo).
