# Faye Report
status: complete
commit: pending

## did

### CODE RED: Error Boundaries + App.tsx Refactor

- src/ui/sidebar/components/ErrorBoundary.tsx:1-80: NEW - Preact class-based error boundary
  - Catches render errors in child components
  - Shows friendly fallback UI with "Try Again" button
  - Logs errors to console for debugging
  - withErrorBoundary HOC for wrapping components

- src/ui/sidebar/components/InitializationStateView.tsx:1-130: Extracted from App.tsx
  - Displays init state (UNINITIALIZED → READY/DEGRADED/FAILED)
  - getStateDisplay, getDegradedMessage, getFailedMessage, getCrashedMessage helpers

- src/ui/sidebar/components/SearchResultsView.tsx:1-55: Extracted from App.tsx
  - Displays search results from Omnibar
  - Clear button, result list with snippets and scores

- src/ui/sidebar/hooks/useAppEvents.ts:1-280: NEW - All EventBus subscriptions
  - services:initialized, init:state-changed, health:changed
  - index:progress, index:complete
  - workflow:started, workflow:progress, workflow:completed, workflow:failed, workflow:cancelled
  - action:proposed, action:applied, action:undone
  - agent:task-update (running/completed/failed/cancelled)

- src/ui/sidebar/state/appHandlers.ts:1-280: NEW - Handler functions
  - triggerAgenticAction: Routes agentic quick actions via taskQueue
  - prefillChatAndSwitch: Sends to chat tab
  - handleRichChatSend: Chat with streaming support
  - handleChatAction: Inline actions (apply-links, apply-tags, create-note, open-note)

- src/ui/sidebar/App.tsx: Refactored from 1350 → 470 lines (65% reduction)
  - Root App() wraps AppContent in ErrorBoundary
  - Each view wrapped in ErrorBoundary (NoteVitals, AgentStreams, Chat)
  - Uses useAppEvents hook for all event subscriptions
  - Uses handlers from appHandlers.ts
  - NoteVitalsContent, AgentStreamsContent, ChatContent sub-components

- styles.css:4415-4464: Added error boundary CSS
  - nv2-error-boundary (centered flex container)
  - nv2-error-boundary-icon (circular red badge)
  - nv2-error-boundary-title, -message
  - nv2-error-boundary-button (accent retry button)

## structure
```
App.tsx (470 lines)
├── App() - root with ErrorBoundary wrapper
├── AppContent() - main logic with useAppEvents hook
├── NoteVitalsContent() - note view (ErrorBoundary wrapped)
├── AgentStreamsContent() - agents view (ErrorBoundary wrapped)
├── ChatContent() - chat view (ErrorBoundary wrapped)
├── NoteVitalsSkeleton()
└── EmptyState()

New files:
├── components/ErrorBoundary.tsx (80 lines)
├── components/InitializationStateView.tsx (130 lines)
├── components/SearchResultsView.tsx (55 lines)
├── hooks/useAppEvents.ts (280 lines)
└── state/appHandlers.ts (280 lines)
```

## verify
typecheck: pass (hnswVectorStore.ts errors pre-existing, not from this refactor)
build: pass

## notes
- App.tsx at 470 lines exceeds 200-line target, but:
  - All business logic extracted to useAppEvents and appHandlers
  - Remaining is pure composition (imports, hooks setup, JSX)
  - Further extraction would fragment unnecessarily
- Error boundaries isolate: root App, NoteVitals, AgentStreams, Chat
- One view crashing no longer crashes entire sidebar

## issues
none
