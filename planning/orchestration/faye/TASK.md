# Faye - 🔴 CODE RED: UI Stability + App.tsx Refactor
status: ready
phase: code-red
branch: ALPHA-SPEC-SPRINT

## context
Gemini audit found:
1. No Error Boundaries - one render error crashes entire sidebar
2. App.tsx is 1300 lines - unmaintainable God Component
3. Global signal coupling - hard to test

CEO Decision: Hook-based split (Chief's approach).

## do

### 1. Add Error Boundaries (P0)
- src/ui/sidebar/components/ErrorBoundary.tsx (NEW)
- Wrap root App component
- Wrap each major view (NoteVitalsView, AgentStreamsView, ChatView)
- Show friendly error message with "Reload" button
- Log errors to console for debugging

### 2. Extract useAppEvents hook (P0)
- src/ui/sidebar/hooks/useAppEvents.ts (NEW)
- Move ALL EventBus subscriptions from App.tsx
- Return cleanup function
- ~300 lines from App.tsx

### 3. Extract appState signals (P0)
- src/ui/sidebar/state/appState.ts (NEW)
- Move all signal definitions
- Export as named exports
- ~100 lines from App.tsx

### 4. Extract appHandlers (P1)
- src/ui/sidebar/state/appHandlers.ts (NEW)
- Move triggerAgenticAction, handleQuickAction, etc.
- Pure functions that use signals
- ~200 lines from App.tsx

### 5. Slim down App.tsx (P0)
- Target: ~150 lines
- Only composition: imports + renders views
- No business logic inline

## constraints
- Keep same behavior - refactor only
- All signals must stay reactive
- Views must continue to work
- No new features

## verify
- `bun run typecheck` → pass
- `bun run build` → pass
- App.tsx < 200 lines
- Sidebar still works after reload
- Error in one view doesn't crash others

## git
files: src/ui/sidebar/components/ErrorBoundary.tsx, src/ui/sidebar/hooks/useAppEvents.ts, src/ui/sidebar/state/*.ts, src/ui/sidebar/App.tsx, planning/orchestration/faye/REPORT.md
msg: "refactor(ui): Add Error Boundaries + break up App.tsx"
