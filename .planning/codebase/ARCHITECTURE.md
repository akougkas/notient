# Architecture

**Analysis Date:** 2026-01-11

## Pattern Overview

**Overall:** Plugin-Based Layered Architecture with Kernel DI Pattern

**Key Characteristics:**
- Obsidian plugin with centralized service registry (Kernel)
- Multi-agent system with White House organizational model
- Event-driven UI communication via typed EventBus
- Streaming-first LLM interactions with AbortController support
- Local-only, privacy-first design (no cloud APIs)

## Layers

**Adapter Layer:**
- Purpose: Abstract external system APIs for testability
- Contains: Obsidian facade wrapper
- Location: `src/adapters/obsidianFacade.ts`
- Depends on: Obsidian runtime only
- Used by: All services requiring vault access

**Service Kernel & Infrastructure:**
- Purpose: Central service registry, dependency injection, health monitoring
- Contains: Kernel registry, EventBus, health monitors, vector storage
- Location: `src/core/kernel.ts`, `src/core/events/`, `src/services/`
- Depends on: Adapters
- Used by: All domain services

**Core Domain Services:**
- Purpose: Business logic organized by domain
- Contains: Indexing, search, agents, chat, intelligence, agentic actions
- Location: `src/core/`
- Depends on: Kernel, Infrastructure services
- Used by: UI Layer

**LLM Abstraction Layer:**
- Purpose: Unified interface for LLM providers
- Contains: Provider interface, OpenAI-compatible base, LM Studio implementation
- Location: `src/core/llm/`
- Depends on: Kernel (settings)
- Used by: Agents, Chat service

**UI Layer:**
- Purpose: Preact-based user interface
- Contains: Sidebar views, modals, settings panel, dashboard
- Location: `src/ui/`
- Depends on: Core services via Kernel context
- Used by: End users

## Data Flow

**Search Request Lifecycle:**

1. User enters query in Omnibar (`src/ui/sidebar/components/Omnibar.tsx`)
2. SearchPipeline receives request (`src/core/search/pipeline.ts`)
3. Strategy router selects Quick/Balanced/Deep based on settings
4. Vector search via HNSWVectorStore (`src/services/hnswVectorStore.ts`)
5. Reranking via OllamaReranker (`src/services/ollamaReranker.ts`)
6. Results cached (LRU, max 100 queries)
7. UI renders results in SearchResultsView

**Chat Message Lifecycle:**

1. User sends message in RichChatView (`src/ui/sidebar/components/chat/RichChatView.tsx`)
2. ChatService.chat() invoked directly (`src/core/chat/chatService.ts`)
3. LLM streaming with thinking tag extraction (`src/core/chat/thinkingParser.ts`)
4. EventBus emits chat:message events
5. MessageBubble renders with optional ThinkingBlock

**Agent Task Lifecycle:**

1. Quick Action triggered in UI (`src/ui/sidebar/state/appHandlers.ts`)
2. AgentTaskQueue enqueues task (`src/core/agent/taskQueue.ts`)
3. ChiefOfStaff routes to specialized agent (`src/core/agents/chiefOfStaff.ts`)
4. Agent executes, streaming AgentEvents
5. TrustLevelManager evaluates action risk (`src/core/agentic/trustLevelManager.ts`)
6. User reviews in AgentStreamsView (if required)
7. ActionApplier modifies vault (`src/core/agentic/actionApplier.ts`)
8. ActionHistory persists undo record

**State Management:**
- Preact signals for reactive UI state (`src/ui/sidebar/state.ts`)
- EventBus for cross-component communication (`src/core/events/eventBus.ts`)
- File-based persistence in vault plugin folder

## Key Abstractions

**Kernel (Service Registry):**
- Purpose: Central DI container for all services
- Examples: `kernel.getService<SearchPipeline>("search")`
- Pattern: Lazy initialization, type-safe access via ServiceRegistry interface
- Location: `src/core/kernel.ts`

**EventBus (Pub/Sub):**
- Purpose: Typed event communication without tight coupling
- Examples: `kernel.eventBus.emit("note:analyzed", { noteId, analysis })`
- Pattern: Synchronous execution, error isolation per listener
- Location: `src/core/events/eventBus.ts`

**ChiefOfStaff (Agent Orchestrator):**
- Purpose: Routes tasks to specialized agents (White House model)
- Examples: ChatAgent, NoteEditorAgent, ClassifierAgent, LinkFinderAgent
- Pattern: Central router with capability-based dispatch
- Location: `src/core/agents/chiefOfStaff.ts`

**Two-Tier Identity:**
- Purpose: Consistent agent persona with role specialization
- Tier 1: Core Notient persona (`src/core/agent/identity.ts` → `buildBaseIdentity()`)
- Tier 2: Agent-specific expertise (`src/core/agents/agentIdentity.ts` → `buildAgentSystemPrompt()`)
- Pattern: Composition - Tier 2 always calls Tier 1 internally

**LLMProvider (Abstraction):**
- Purpose: Swap LLM backends without changing consumers
- Examples: LMStudioProvider, OpenAICompatibleProvider
- Pattern: Interface with streaming + completion + reranking methods
- Location: `src/core/llm/provider.ts`

## Entry Points

**Plugin Entry:**
- Location: `src/main.ts`
- Triggers: Obsidian plugin load event
- Responsibilities: Initialize Kernel, register views, setup services

**Sidebar View:**
- Location: `src/ui/sidebar/SidebarView.tsx`
- Triggers: User opens sidebar leaf
- Responsibilities: Render Preact app, provide Kernel context

**Agent Execution:**
- Location: `src/core/agents/chiefOfStaff.ts`
- Triggers: Task enqueued or direct execute() call
- Responsibilities: Route to appropriate agent, manage streaming

**Search Pipeline:**
- Location: `src/core/search/pipeline.ts`
- Triggers: User search query
- Responsibilities: Strategy selection, execution, caching

## Error Handling

**Strategy:** Throw errors, catch at boundaries, graceful degradation

**Patterns:**
- Services throw descriptive Error instances
- UI boundaries catch, log, and show user-friendly messages
- Agents return empty/fallback output on LLM parse failures
- EventBus isolates listener failures (one failure doesn't break others)

## Cross-Cutting Concerns

**Logging:**
- console.log with [ComponentName] prefixes for initialization
- No debug logging in production code (per project guidelines)

**Validation:**
- TypeScript strict mode for compile-time type safety
- Runtime validation via optional chaining for LLM responses
- Graceful fallbacks when validation fails

**Streaming:**
- AsyncIterable<string> for all LLM calls
- AbortController support throughout
- UI yields during long operations (batch size = 5)

---

*Architecture analysis: 2026-01-11*
*Update when major patterns change*
