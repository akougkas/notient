# Faye - Frontend Wiring Fixes
status: ready
phase: p1-s3
branch: ALPHA-SPEC-SPRINT

## do

### 1. Make all 6 Quick Actions use triggerAgent() (P1)
- src/ui/sidebar/components/QuickActions.tsx:145-166
  - Currently: "Summary" and "Tasks" use `sendToChat()` → Chat UI
  - Change to: use `triggerAgent()` → Agent Streams (like other 4 buttons)
  - Update action definitions:
    ```typescript
    {
      id: "summarize",
      icon: "file-text",
      label: "Summary",
      primary: false,
      description: "Generate summary (Agent)",
      onClick: () =>
        triggerAgent(
          `Create a concise summary of "${noteTitle}" that captures the key points`,
          "analyze"  // Uses chat agent but shows in Agent Streams
        ),
    },
    {
      id: "extract-tasks",
      icon: "check-square",
      label: "Tasks",
      primary: false,
      description: "Extract tasks (Agent)",
      onClick: () =>
        triggerAgent(
          `Extract any actionable items or tasks mentioned in "${noteTitle}"`,
          "analyze"
        ),
    },
    ```
  - Remove `sendToChat` from QuickActionCallbacks interface if no longer used
  - Update JSDoc comments to reflect all 6 are agentic

### 2. Remove duplicate agent result emissions (P2)
- src/ui/sidebar/App.tsx
  - Current issue: `triggerAgenticAction()` adds to activeAgents synchronously (line ~498-507)
  - AND `agent:task-update` event handler also adds (line ~328-389)
  - Fix: Remove the synchronous add in `triggerAgenticAction()`
  - Let the event handler be the SINGLE source of truth
  - The event fires quickly enough that UX won't suffer
  - Location: inside `triggerAgenticAction()`, remove:
    ```typescript
    activeAgents.value = [...activeAgents.value, { id: taskId, ... }];
    ```
  - Keep only the event-driven update in the subscription

### 3. Update QuickActions section header (minor)
- src/ui/sidebar/components/QuickActions.tsx
  - Update comments to reflect all 6 actions are now agentic
  - Remove "CONVERSATIONAL ACTIONS" comment section since they're all agentic now

## context
Root cause: 2 Quick Actions bypass Agent Streams and go to Chat, causing confusion.
User expects consistent behavior: click button → see result in Agent Streams.
Also: double-emission of agent results causes potential race conditions.

## anti-patterns
- Don't add new Quick Actions - just fix existing ones
- Don't change the visual styling of buttons
- Don't remove sendToChat functionality entirely (Chat input field still needs it)

## verify
- `bun run typecheck` → pass
- `bun run build` → pass
- manual: click "Summary" → agent card appears in Agent Streams (not Chat)
- manual: click "Tasks" → agent card appears in Agent Streams (not Chat)
- manual: all 6 Quick Actions show in Agent Streams consistently
- manual: agent cards don't appear twice or flicker

## git
files: src/ui/sidebar/components/QuickActions.tsx, src/ui/sidebar/App.tsx, planning/orchestration/faye/REPORT.md
msg: "fix(ui): Make all Quick Actions use Agent Streams consistently"
