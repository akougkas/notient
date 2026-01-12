# Event Handler Analysis - useAppEvents.ts

## Analysis Table

| Event Name | Signals Mutated | Sync/Async | queueMicrotask? | Heavy Computation? | Issues |
|------------|----------------|------------|-----------------|-------------------|---------|
| `services:initialized` | `isServicesReady` | Sync | ❌ NO | ❌ No | Low priority - fires once |
| `init:state-changed` | `initState`, `initContext`, `isServicesReady` | Sync | ❌ NO | ❌ No | Low priority - fires infrequently |
| `health:changed` | `providerStatus` | Sync | ❌ NO | ❌ No | Low priority - fires infrequently |
| `index:progress` | `indexStatus` | Sync | ❌ NO | ❌ No | Medium - fires during indexing but infrequent |
| `index:complete` | `indexStatus` | Sync | ❌ NO | ❌ No | Low priority - fires once per index |
| `workflow:started` | `agentStatus`, `activeAgents` | Sync | ❌ NO | ❌ No | Medium - array spread |
| `workflow:progress` | `activeAgents` | Sync | ❌ NO | ⚠️ Yes (.map()) | **HIGH** - fires frequently, array iteration |
| `workflow:completed` | `agentStatus`, `activeAgents`, `recentActivity` | Sync | ❌ NO | ⚠️ Yes (.find(), .filter(), .slice()) | **HIGH** - multiple array ops |
| `workflow:failed` | `agentStatus`, `activeAgents`, `recentActivity` | Sync | ❌ NO | ⚠️ Yes (.find(), .filter(), .slice()) | **HIGH** - multiple array ops |
| `workflow:cancelled` | `agentStatus`, `activeAgents` | Sync | ❌ NO | ⚠️ Yes (.filter()) | Medium - array filter |
| `action:proposed` | `agentStatus`, `pendingActions` | Sync | ❌ NO | ❌ No | Low priority - fires infrequently |
| `action:applied` | `agentStatus`, `pendingActions`, `recentActivity` | Sync | ❌ NO | ⚠️ Yes (.filter(), .slice(), .split()) | Medium - array ops + string split |
| `action:undone` | `recentActivity` | Sync | ❌ NO | ⚠️ Yes (.map()) | Medium - array map |
| `agent:task-update` (running) | `activeAgents`, `agentStatus` | Sync | ❌ NO | ⚠️ Yes (.find(), .map()) | **CRITICAL** - fires VERY frequently during LLM streaming |
| `agent:task-update` (completed) | `activeAgents`, `agentStatus`, `pendingActions`, `agentInsights` | Async (setTimeout) | ⚠️ Uses setTimeout | ⚠️ Yes (JSON.stringify in buildResultData) | **CRITICAL** - should use queueMicrotask, JSON.stringify blocks |
| `agent:task-update` (failed) | `activeAgents`, `agentStatus`, `recentActivity` | Sync | ❌ NO | ⚠️ Yes (.find(), .filter(), .slice()) | **HIGH** - multiple array ops |
| `agent:task-update` (cancelled) | `activeAgents`, `agentStatus` | Sync | ❌ NO | ⚠️ Yes (.find(), .filter()) | Medium - array ops |
| `agent:task-update` (queued) | `activeAgents` | Sync | ❌ NO | ⚠️ Yes (.some()) | Low priority - fires once |

## Handlers NOT Using queueMicrotask

1. **CRITICAL**: `handleTaskRunning` - Fires frequently during LLM streaming
2. **HIGH**: `workflow:progress` - Fires frequently during workflow execution
3. **HIGH**: `workflow:completed` - Multiple synchronous array operations
4. **HIGH**: `workflow:failed` - Multiple synchronous array operations
5. **HIGH**: `handleTaskFailed` - Multiple synchronous array operations
6. **MEDIUM**: `workflow:cancelled` - Array filter operation
7. **MEDIUM**: `action:applied` - Array operations + string split
8. **MEDIUM**: `action:undone` - Array map operation
9. **MEDIUM**: `handleTaskCancelled` - Array operations
10. All other handlers (low priority, fire infrequently)

## Handlers Doing Heavy Computation

1. **CRITICAL**: `buildResultData` (called by `handleTaskCompleted`)
   - Synchronously calls `JSON.stringify(task.result?.data || {}, null, 2)`
   - Can be expensive for large LLM responses
   - Should be deferred or done in chunks

2. **HIGH**: `handleTaskRunning`
   - `.find()` + `.map()` on `activeAgents` array
   - Fires VERY frequently during streaming (every progress update)

3. **HIGH**: `workflow:progress`
   - `.map()` on `activeAgents` array
   - Fires frequently during workflow execution

4. **MEDIUM**: `workflow:completed`, `workflow:failed`, `handleTaskFailed`
   - Multiple array operations: `.find()`, `.filter()`, `.slice()`
   - Array spreads with `.slice()`

5. **MEDIUM**: `action:applied`
   - `.filter()` + `.slice()` + `.split()` operations

## Memory Leaks

✅ **NO MEMORY LEAKS DETECTED**
- `useEventBus` properly returns unsubscribe function in `useEffect` cleanup
- All event listeners are cleaned up when component unmounts

## Specific Questions Answered

### 1. What happens when `task:completed` event fires?
- Event `agent:task-update` with `status: "completed"` triggers `handleTaskCompleted`
- Uses `setTimeout(..., 0)` to defer (should use `queueMicrotask`)
- Synchronously calls `buildResultData` which does `JSON.stringify` (expensive)
- Mutates multiple signals: `activeAgents`, `agentStatus`, `pendingActions`, `agentInsights`
- Creates Notice

### 2. What happens when `task:progress` event fires?
- Event `agent:task-update` with `status: "running"` triggers `handleTaskRunning`
- **CRITICAL**: Runs synchronously, blocking UI thread
- Does `.find()` + `.map()` on `activeAgents` array
- Mutates `activeAgents` and `agentStatus` signals
- Fires VERY frequently during LLM streaming (every chunk/progress update)

### 3. Any handlers that process agent output synchronously?
- ✅ **YES**: `buildResultData` processes `task.result.data` synchronously
- Calls `JSON.stringify` synchronously which can block for large responses

### 4. Any handlers that iterate over large data structures?
- ✅ **YES**: Multiple handlers iterate over `activeAgents`, `recentActivity`, `pendingActions`
- `.map()`, `.filter()`, `.find()`, `.slice()` operations
- While arrays are limited (MAX_RECENT_ACTIVITY_COUNT = 9), operations still block UI

### 5. Are event listeners properly cleaned up in useEffect return?
- ✅ **YES**: `useEventBus` properly implements cleanup
- Returns `unsubscribe()` function from `useEffect` cleanup
- No memory leaks detected

## EXACT Fixes Applied ✅

1. ✅ **CRITICAL**: Wrapped `handleTaskRunning` in `queueMicrotask` - prevents UI freeze during frequent progress updates
2. ✅ **CRITICAL**: Changed `handleTaskCompleted` from `setTimeout` to `queueMicrotask` - better performance
3. ✅ **CRITICAL**: Optimized `JSON.stringify` in `buildResultData` - added size limits and error handling to prevent UI freeze
4. ✅ **HIGH**: Wrapped `workflow:progress` handler in `queueMicrotask` - prevents UI freeze during workflow execution
5. ✅ **HIGH**: Wrapped `workflow:completed` handler in `queueMicrotask` - defers array operations
6. ✅ **HIGH**: Wrapped `workflow:failed` handler in `queueMicrotask` - defers array operations
7. ✅ **HIGH**: Wrapped `handleTaskFailed` in `queueMicrotask` - defers array operations
8. ✅ **MEDIUM**: Wrapped `workflow:started`, `workflow:cancelled`, `action:proposed`, `action:applied`, `action:undone`, `handleTaskCancelled`, `handleTaskQueued` in `queueMicrotask`

## Summary of Changes

All event handlers that mutate signals now use `queueMicrotask` to defer execution, preventing synchronous blocking of the UI thread. The most critical fix is `handleTaskRunning` which fires very frequently during LLM streaming - this was likely the primary cause of UI freezes.

The `buildResultData` function has been optimized to handle large JSON objects more efficiently by:
- Limiting stringification size to 10KB (truncates larger results)
- Using compact JSON format for large objects
- Adding error handling for serialization failures
