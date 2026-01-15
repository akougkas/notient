# Pipeline Review Part 3: Lifecycle + Concurrency + Type Boundaries

You've found routing and agent output issues. Now audit the **system edges** — startup, shutdown, background tasks, and type boundaries.

## Focus Areas

### 1. Initialization Sequence
Plugin startup has many moving parts. Are they ordered correctly?

```
src/main.ts                        — onload(), initializeServices()
src/core/kernel.ts                 — service registration order
src/ui/sidebar/state/initStateMachine.ts — state transitions
src/services/indexManager.ts       — index initialization
```

Questions to answer:
- Are services initialized before they're used?
- Can race conditions occur during startup?
- Does the state machine handle all failure modes?
- What happens if a service init fails halfway?

### 2. Background Task Management
Tasks run in background. Are they properly managed?

```
src/core/agent/taskQueue.ts        — task lifecycle
src/core/indexer/simpleIndexer.ts  — background indexing
src/workers/embed.worker.ts        — embedding worker
src/workers/vector.worker.ts       — vector operations
```

Questions to answer:
- Are AbortControllers properly propagated and respected?
- What happens to in-flight tasks on plugin unload?
- Are there task leaks (started but never completed/cancelled)?
- Do workers handle errors or silently fail?

### 3. Type Boundaries
Types cross boundaries (UI ↔ Core ↔ Workers). Are they consistent?

```
src/types/*.ts                     — shared type definitions
src/core/agents/types.ts           — agent-specific types
src/core/events/types.ts           — event payload types
```

Questions to answer:
- Are event payloads typed correctly at emit AND subscribe?
- Do worker message types match between sender and receiver?
- Are there `any` casts hiding type mismatches?
- Do optional fields cause runtime undefined access?

### 4. Cleanup and Disposal
When things stop, are resources released?

```
src/main.ts                        — onunload()
src/core/kernel.ts                 — service disposal
src/services/hnswVectorStore.ts    — cleanup
```

Questions to answer:
- Are event listeners removed on unload?
- Are workers terminated?
- Are timers/intervals cleared?
- Are file handles/locks released?

## Patterns to Flag

### Startup Race Conditions
```typescript
// BAD: Using service before init completes
this.registerService("foo", new FooService());
this.getService("bar").useFoo(); // bar might init before foo

// GOOD: Explicit dependency order or lazy access
```

### Orphan Tasks
```typescript
// BAD: Fire and forget
setTimeout(() => this.doSomething(), 1000);

// GOOD: Tracked and cancellable
this.pendingTimer = setTimeout(...);
// In cleanup: clearTimeout(this.pendingTimer);
```

### Type Erosion
```typescript
// BAD: Cast away safety
const data = event.data as any;
this.process(data.maybeMissing); // Runtime error

// GOOD: Validate or narrow
if (isValidPayload(event.data)) {
  this.process(event.data.field);
}
```

## Same Rules Apply

- **Be specific**: file:line, code snippets
- **Minimal fixes**: no redesigns
- **No scope creep**: one issue per finding
- **Severity labels**: CRITICAL / HIGH / MEDIUM / LOW

## Start Point

Begin with `main.ts:onload()` — trace the full initialization sequence. Note any ordering assumptions that could break.

Then check `onunload()` — is cleanup symmetric with init?

Continue your audit.
