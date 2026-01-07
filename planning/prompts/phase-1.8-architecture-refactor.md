# Phase 1.8: Architecture Refactor — Clean Separation of Concerns

## Context

The current codebase has architectural debt from rapid iteration. Core Notient agent logic has leaked into LLM provider implementations, chat/modal code is scattered, and the build system needs modernization.

**This refactor establishes clean boundaries before adding more features.**

---

## Problem Statement

### Current Issues

1. **LLM Provider Pollution**
   - `src/services/lmstudio.ts` contains:
     - Notient-specific prompt building (`buildChatSystemPrompt`)
     - Task inference logic (`inferTaskInstructions`)
     - RAG formatting logic
   - Should be: A thin OpenAI-compatible API wrapper only

2. **Missing Abstractions**
   - No `LLMProvider` interface/abstract class
   - Can't easily swap providers (OpenAI, Anthropic, Ollama chat, etc.)
   - Embedding service (Ollama) and reasoning service (LM Studio) have different shapes

3. **Scattered Agent Logic**
   - Agent harness logic spread across:
     - `agentTaskQueue.ts` (execution)
     - `lmstudio.ts` (prompt building)
     - `taskModal.ts` (chat loop)
     - `vaultContextBuilder.ts` (context)
   - No central "Agent" or "Notient Brain" module

4. **Chat/Modal Coupling**
   - `TaskModal` contains chat streaming logic that should be reusable
   - Chat history management duplicated between queue and modal
   - No separation between UI and chat logic

5. **Build System**
   - Using custom `esbuild.config.ts` script
   - No strict TypeScript config
   - Missing modern tooling (biome/eslint, proper exports)

---

## Target Architecture

```
src/
├── core/
│   ├── kernel.ts                    # Service registry (keep)
│   ├── eventBus.ts                  # Events (keep)
│   │
│   ├── llm/                         # NEW: LLM abstraction layer
│   │   ├── types.ts                 # ChatMessage, CompletionOptions, etc.
│   │   ├── provider.ts              # Abstract LLMProvider interface
│   │   ├── providers/
│   │   │   ├── openai-compatible.ts # Base for OpenAI-style APIs
│   │   │   ├── lmstudio.ts          # LM Studio specifics (extends openai-compatible)
│   │   │   └── ollama-chat.ts       # Ollama chat (if needed)
│   │   └── index.ts                 # Exports
│   │
│   ├── embedding/                   # Embedding abstraction (similar pattern)
│   │   ├── types.ts
│   │   ├── provider.ts
│   │   └── providers/
│   │       └── ollama.ts
│   │
│   ├── agent/                       # NEW: Notient agent harness
│   │   ├── types.ts                 # AgentTask, TaskResult, etc.
│   │   ├── promptBuilder.ts         # Notient-specific prompt construction
│   │   ├── taskInference.ts         # Infer task type from query
│   │   ├── agentLoop.ts             # Core agent execution loop
│   │   ├── taskQueue.ts             # Task queue management
│   │   └── index.ts
│   │
│   ├── chat/                        # NEW: Reusable chat logic
│   │   ├── types.ts                 # ChatSession, ChatConfig
│   │   ├── session.ts               # Chat session management
│   │   ├── streaming.ts             # Stream handling utilities
│   │   └── index.ts
│   │
│   ├── context/                     # Keep, but clean up
│   │   └── vaultContextBuilder.ts
│   │
│   ├── search/                      # Keep
│   │   └── pipeline.ts
│   │
│   └── indexer/                     # Keep
│       └── simpleIndexer.ts
│
├── views/                           # UI only - no business logic
│   ├── sidebar.ts                   # Sidebar UI (delegates to services)
│   ├── taskModal.ts                 # Modal UI (uses chat/session)
│   └── dashboard.ts
│
├── services/                        # DEPRECATED - migrate to core/
│   └── (empty after refactor)
│
├── adapters/
│   └── obsidianFacade.ts            # Keep
│
├── types/                           # Shared types
│   ├── settings.ts
│   ├── search.ts
│   └── events.ts
│
└── main.ts                          # Plugin entry
```

---

## Detailed Tasks

### Task 1: Create LLM Provider Abstraction

**File: `src/core/llm/types.ts`**
```typescript
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
}

export interface StreamChunk {
  content: string;
  done: boolean;
}
```

**File: `src/core/llm/provider.ts`**
```typescript
export interface LLMProvider {
  readonly name: string;
  readonly isReady: boolean;
  
  initialize(): Promise<void>;
  dispose(): void;
  
  // Non-streaming
  complete(messages: ChatMessage[], options?: CompletionOptions): Promise<string>;
  
  // Streaming
  stream(
    messages: ChatMessage[], 
    options?: CompletionOptions,
    signal?: AbortSignal
  ): AsyncIterable<string>;
}
```

**File: `src/core/llm/providers/openai-compatible.ts`**
```typescript
/**
 * Base provider for any OpenAI-compatible API (LM Studio, Ollama, vLLM, etc.)
 * Contains ONLY HTTP/streaming logic - NO Notient-specific code
 */
export class OpenAICompatibleProvider implements LLMProvider {
  constructor(
    protected baseUrl: string,
    protected model: string,
    protected name: string = 'openai-compatible'
  ) {}
  
  // Implement complete() and stream() with pure API calls
}
```

**File: `src/core/llm/providers/lmstudio.ts`**
```typescript
/**
 * LM Studio specific provider - just configuration, extends base
 */
export class LMStudioProvider extends OpenAICompatibleProvider {
  constructor(host: string, model: string) {
    super(host, model, 'lmstudio');
  }
  
  // Override only if LM Studio has quirks
}
```

### Task 2: Create Agent Module (Notient Brain)

**File: `src/core/agent/promptBuilder.ts`**
```typescript
/**
 * Builds Notient-specific prompts with vault context
 * THIS is where the Notient personality and RAG formatting lives
 */
export class NotientPromptBuilder {
  constructor(private contextBuilder: VaultContextBuilder) {}
  
  buildSystemPrompt(params: {
    currentNote?: NoteContext;
    relatedNotes: NoteContext[];
    vaultSummary: string;
    taskType?: TaskType;
  }): string;
  
  private formatNoteForPrompt(note: NoteContext): string;
  private getTaskInstructions(type: TaskType): string;
}
```

**File: `src/core/agent/taskInference.ts`**
```typescript
export type TaskType = 'enrich' | 'link' | 'classify' | 'analyze' | 'chat';

export function inferTaskType(query: string): TaskType;
```

**File: `src/core/agent/agentLoop.ts`**
```typescript
/**
 * Core agent execution - orchestrates LLM, search, context
 */
export class NotientAgent {
  constructor(
    private llm: LLMProvider,
    private search: SearchPipeline,
    private promptBuilder: NotientPromptBuilder,
    private obsidian: ObsidianFacade
  ) {}
  
  async execute(task: AgentTask): Promise<TaskResult>;
  
  async *executeStreaming(
    task: AgentTask,
    signal?: AbortSignal
  ): AsyncIterable<AgentStreamEvent>;
}
```

### Task 3: Create Chat Module

**File: `src/core/chat/session.ts`**
```typescript
/**
 * Manages a chat session - history, context window, etc.
 * Reusable between TaskModal, potential future chat views
 */
export class ChatSession {
  private history: ChatMessage[] = [];
  private maxHistoryLength = 10;
  
  addUserMessage(content: string): void;
  addAssistantMessage(content: string): void;
  getMessages(): ChatMessage[];
  getRecentMessages(n: number): ChatMessage[];
  clear(): void;
}
```

**File: `src/core/chat/streaming.ts`**
```typescript
/**
 * Utilities for handling streaming responses
 */
export async function* mergeStreams<T>(
  streams: AsyncIterable<T>[]
): AsyncIterable<T>;

export function createStreamController(): {
  stream: AsyncIterable<string>;
  push: (chunk: string) => void;
  close: () => void;
  abort: () => void;
};
```

### Task 4: Refactor Views to Pure UI

**File: `src/views/taskModal.ts`**
```typescript
/**
 * AFTER refactor: UI only, delegates to NotientAgent
 */
export class TaskModal extends Modal {
  private agent: NotientAgent;
  private session: ChatSession;
  
  // UI rendering methods stay
  // Remove: generateResponse() logic → use agent.executeStreaming()
  // Remove: context building → handled by agent
}
```

### Task 5: Modernize Build System

**Update `tsconfig.json`:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "baseUrl": ".",
    "paths": {
      "@core/*": ["src/core/*"],
      "@views/*": ["src/views/*"],
      "@types/*": ["src/types/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Update `package.json`:**
```json
{
  "type": "module",
  "scripts": {
    "build": "bun run build:check && bun run build:bundle",
    "build:check": "tsc --noEmit",
    "build:bundle": "bun build src/main.ts --outdir=dist --target=node --format=esm",
    "dev": "bun run build --watch",
    "lint": "biome check src/",
    "lint:fix": "biome check --write src/",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "typescript": "^5.6.0"
  }
}
```

**Add `biome.json`:**
```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "complexity": {
        "noExcessiveCognitiveComplexity": "warn"
      }
    }
  },
  "formatter": {
    "indentStyle": "space",
    "indentWidth": 2
  }
}
```

---

## Migration Strategy

### Phase A: Create New Structure (Non-Breaking)
1. Create `src/core/llm/` with new abstraction
2. Create `src/core/agent/` with NotientAgent
3. Create `src/core/chat/` with ChatSession
4. Keep old code working alongside new

### Phase B: Migrate Consumers
1. Update `main.ts` to use new providers
2. Update `agentTaskQueue.ts` to use NotientAgent
3. Update `taskModal.ts` to use ChatSession + NotientAgent
4. Update `sidebar.ts` to delegate properly

### Phase C: Cleanup
1. Delete `src/services/lmstudio.ts` (migrated to core/llm)
2. Delete `src/services/agentTaskQueue.ts` (migrated to core/agent)
3. Remove deprecated code paths
4. Update imports throughout

### Phase D: Build Modernization
1. Update `tsconfig.json`
2. Add Biome for linting
3. Update build scripts
4. Add path aliases

---

## Success Criteria

- [ ] `lmstudio.ts` contains ZERO Notient-specific logic (only API calls)
- [ ] New LLM provider can be added in <50 lines
- [ ] `NotientAgent` is the single source of agent logic
- [ ] `TaskModal` has <200 lines (UI only)
- [ ] `ChatSession` is reusable across views
- [ ] `bun run build` uses modern bundling
- [ ] `bun run lint` passes with Biome
- [ ] All existing functionality works unchanged

---

## Files to Create

```
src/core/llm/types.ts
src/core/llm/provider.ts
src/core/llm/providers/openai-compatible.ts
src/core/llm/providers/lmstudio.ts
src/core/llm/index.ts
src/core/agent/types.ts
src/core/agent/promptBuilder.ts
src/core/agent/taskInference.ts
src/core/agent/agentLoop.ts
src/core/agent/taskQueue.ts
src/core/agent/index.ts
src/core/chat/types.ts
src/core/chat/session.ts
src/core/chat/streaming.ts
src/core/chat/index.ts
biome.json
```

## Files to Modify

```
src/main.ts                          # Wire up new services
src/views/taskModal.ts               # Simplify to UI only
src/views/sidebar.ts                 # Delegate to agent
tsconfig.json                        # Modernize
package.json                         # Update scripts
```

## Files to Delete (After Migration)

```
src/services/lmstudio.ts             # → core/llm/providers/lmstudio.ts
src/services/agentTaskQueue.ts       # → core/agent/taskQueue.ts
```

---

## Notes for Implementation

1. **Do NOT change behavior** - this is a refactor, not a feature addition
2. **Test after each phase** - ensure nothing breaks
3. **Keep git history clean** - logical commits per phase
4. **Preserve all console.log debugging** - can remove in future cleanup
5. **Path aliases are optional** - can skip if causing bundling issues

---

## Reference: Current Flow (Before)

```
Quick Action → sidebar.prefillChatAndSwitch()
            → agentTaskQueue.enqueue()
            → agentTaskQueue.executeTask()
                → lmstudio.buildChatSystemPrompt() ← WRONG PLACE
                → lmstudio.chatStream()
            → taskModal.generateResponse()
                → lmstudio.buildChatSystemPrompt() ← DUPLICATED
                → lmstudio.chatStream()
```

## Reference: Target Flow (After)

```
Quick Action → sidebar.prefillChatAndSwitch()
            → NotientAgent.execute()
                → promptBuilder.buildSystemPrompt()
                → llmProvider.stream()
            → TaskModal (UI updates only)
                → ChatSession.addMessage()
```
