# Chat System Implementation - Continuation Prompt

## Mission
Complete the **RichChatView** implementation for Notient, an Obsidian plugin. The chat system was partially implemented but has critical bugs preventing it from working. Your job is to debug, fix, and polish the chat experience until it's production-ready.

---

## Current State

### What Exists (Created This Session)

**Core Infrastructure:**
- `src/core/chat/chatService.ts` - Lightweight chat orchestrator (bypasses ChiefOfStaff)
- `src/core/chat/thinkingParser.ts` - Parses `<think>` tags from reasoning models
- `src/core/chat/types.ts` - Extended with ChatStreamEvent, ChatStatistics, etc.

**UI Components:**
- `src/ui/sidebar/components/chat/RichChatView.tsx` - Main enhanced chat view
- `src/ui/sidebar/components/chat/MessageBubble.tsx` - Rich message rendering
- `src/ui/sidebar/components/chat/ThinkingBlock.tsx` - Collapsible reasoning panel
- `src/ui/sidebar/components/chat/StatsPanel.tsx` - Full dev statistics
- `src/ui/sidebar/components/chat/ActivityTrail.tsx` - Action breadcrumbs
- `src/ui/sidebar/components/chat/MarkdownRenderer.tsx` - Markdown + Prism.js

**Styles:**
- `src/ui/styles/components/chat-view.css` - All styles for chat components

**Integration:**
- `src/ui/sidebar/App.tsx` - Has RichChatView wired up with signals

---

## Critical Bugs To Fix

### Bug 1: "Chat service is not available"
**Location:** `src/ui/sidebar/App.tsx` lines 95-120

The ChatService is created in a `useMemo` but the LLM provider may not be available:
```typescript
const chatService = useMemo(() => {
  const llm = kernel.getService("llmProvider");
  if (llm) {
    // Creates ChatService
  }
  return null; // Returns null if no LLM!
}, [kernel]);
```

**Problem:**
- `kernel.getService("llmProvider")` returns null during initial render
- The `useMemo` dependency on `[kernel]` doesn't re-run when services initialize
- Need to listen for `services:initialized` event and recreate ChatService

**Fix approach:**
1. Use `useState` + `useEffect` instead of `useMemo` for ChatService
2. Listen to `services:initialized` event to trigger recreation
3. Check `kernel.isServicesInitialized` before creating

### Bug 2: User messages don't appear
**Location:** `src/ui/sidebar/App.tsx` line 443

When `handleRichChatSend` is called:
```typescript
richChatMessages.value = [...richChatMessages.value, userMsg];
```

**Problem:**
- Signal updates may not trigger re-render
- The `richChatMessages` signal might not be connected properly to RichChatView
- Check if RichChatView is receiving the signal updates

**Debug steps:**
1. Add console.log in handleRichChatSend to verify it's called
2. Check if RichChatView receives updated `messages` signal
3. Verify the signal subscription in RichChatView

### Bug 3: Text not selectable/copyable
**Location:** `src/ui/styles/components/chat-view.css`

**Problem:** CSS may have `user-select: none` or other blocking styles

**Fix:**
```css
.nv2-chat-bubble-content {
  user-select: text;
  -webkit-user-select: text;
}

.nv2-markdown-content {
  user-select: text;
  -webkit-user-select: text;
}
```

---

## Features To Complete

### 1. ChatService Integration (HIGH PRIORITY)
- [ ] Fix ChatService initialization timing
- [ ] Handle case when LLM provider changes mid-session
- [ ] Add proper error handling when ChatService is null
- [ ] Show helpful message when services are still initializing

### 2. Message Display (HIGH PRIORITY)
- [ ] Ensure user messages appear immediately
- [ ] Ensure assistant messages appear after streaming
- [ ] Fix signal reactivity if broken
- [ ] Add scroll-to-bottom on new messages

### 3. Text Selection (HIGH PRIORITY)
- [ ] Make all message text selectable
- [ ] Enable copy on code blocks
- [ ] Add copy button to code blocks

### 4. Streaming Experience (MEDIUM)
- [ ] Show typing indicator while waiting for first chunk
- [ ] Smooth streaming of content chunks
- [ ] Thinking block expands during reasoning, collapses after
- [ ] Activity trail shows current phase

### 5. Statistics Panel (MEDIUM)
- [ ] Show tokens/second during streaming
- [ ] Show response time after completion
- [ ] Expandable detailed stats
- [ ] Context window usage bar

### 6. Markdown Rendering (MEDIUM)
- [ ] Code syntax highlighting working
- [ ] Wiki-links clickable `[[Note Name]]`
- [ ] External links open in browser
- [ ] Lists, blockquotes, headers styled

### 7. Thinking Tokens (MEDIUM)
- [ ] Parse `<think>...</think>` tags
- [ ] Collapsible thinking block
- [ ] Show thinking duration
- [ ] Token count for thinking section

### 8. Context Bar (LOW)
- [ ] Show current note title
- [ ] Click to open note
- [ ] Clear context button
- [ ] Show "No note selected" when empty

### 9. Empty State (LOW)
- [ ] Welcoming message
- [ ] Suggestion chips for common actions
- [ ] Animate suggestion chips in

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/ui/sidebar/App.tsx` | Main integration point (lines 95-548 are chat-related) |
| `src/core/chat/chatService.ts` | The chat orchestrator |
| `src/ui/sidebar/components/chat/RichChatView.tsx` | Main chat UI component |
| `src/ui/sidebar/components/chat/MessageBubble.tsx` | Individual message rendering |
| `src/core/chat/thinkingParser.ts` | Parses thinking tokens |
| `src/ui/styles/components/chat-view.css` | All chat styles |

---

## Signals Used in App.tsx

```typescript
// Chat context
const chatContext = signal<ChatContext>({ notePath: null, noteTitle: null });

// Rich chat state
const richChatMessages = signal<RichChatMessage[]>([]);
const isChatStreaming = signal(false);
const chatStreamingContent = signal("");
const chatStreamingThinking = signal("");
const isChatThinking = signal(false);
const chatActivities = signal<ActivityItem[]>([]);
const useRichChat = signal(true); // Feature flag
```

---

## How ChatService.chat() Works

```typescript
async *chat(message, noteContext, history, signal): AsyncIterable<ChatStreamEvent>
```

Events yielded:
1. `{ type: "started" }` - Chat began
2. `{ type: "activity", message, phase }` - Status update
3. `{ type: "thinking", content }` - Thinking chunk
4. `{ type: "thinking-complete", content, durationMs }` - Thinking done
5. `{ type: "chunk", content }` - Response chunk
6. `{ type: "complete", content, thinking, statistics }` - Done
7. `{ type: "error", error }` - Failed

---

## Testing Checklist

After fixes, verify:

1. **Basic Chat:**
   - [ ] Open a note in Obsidian
   - [ ] Switch to Chat tab in sidebar
   - [ ] Type a message and press Enter
   - [ ] User message appears immediately
   - [ ] Streaming indicator shows
   - [ ] Assistant response streams in
   - [ ] Statistics show after completion

2. **Text Interaction:**
   - [ ] Can select text in messages
   - [ ] Can copy text with Ctrl+C
   - [ ] Code blocks have copy button
   - [ ] Links are clickable

3. **Edge Cases:**
   - [ ] Chat works after switching notes
   - [ ] Chat works after changing LLM settings
   - [ ] Error messages display gracefully
   - [ ] Cancel mid-stream works (if implemented)

---

## Architecture Notes

**White House Mental Model:**
- User = President (decision maker)
- ChiefOfStaff = Orchestrator for agentic tasks
- ChatService = Direct line for conversation (bypasses ChiefOfStaff)

**Why ChatService exists:**
- ChiefOfStaff adds overhead (context-builder preflight, routing, etc.)
- Pure chat doesn't need agentic capabilities
- Faster response time for conversational queries
- Still supports delegation when user asks to "edit", "classify", etc.

---

## Commands

```bash
bun run dev          # Build + copy to test vault
bun run typecheck    # Check types
bun run build        # Production build
```

Test vault: `/mnt/c/Users/akougk/Projects/vaultex`

---

## Success Criteria

The chat is complete when:
1. User can have a fluent conversation about their notes
2. Messages display correctly with markdown formatting
3. Thinking tokens are shown in collapsible blocks
4. Statistics show generation speed and timing
5. All text is selectable and copyable
6. Activity trail shows what's happening
7. No console errors during normal operation
8. Works after settings changes and note switches

---

## Start Here

1. First, read `src/ui/sidebar/App.tsx` to understand current integration
2. Add console.logs to trace why ChatService is null
3. Fix the initialization timing issue
4. Test that messages appear
5. Fix text selection CSS
6. Polish remaining features

Good luck! Make this chat experience exceptional.
