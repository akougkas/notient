# Notient - AI Assistant Context

> AI-powered vault management for Obsidian using local LLMs only.

## Core Mission

**Notient = Note + Sentient** — Transform Obsidian notes from passive files into living entities with health, context, and agency. Local-only. Privacy-first. Human-in-the-steering-wheel.

**Mental Model: White House**
- User = President (decision maker, commands agents)
- ChiefOfStaff = Orchestrator (routes tasks, manages delegation)
- Agents = Department Heads (specialized expertise)

---

## Tech Stack

| Layer | Technology | Decision Rationale |
|-------|------------|-------------------|
| Language | TypeScript (strict) | Type safety, IDE support, Obsidian ecosystem |
| Runtime | Bun | Fast, modern, excellent DX |
| Build | esbuild | Speed, simplicity |
| Lint | Biome | Fast, opinionated, replaces ESLint+Prettier |
| UI | Preact + @preact/signals | Lightweight React-like, reactive state |
| Reasoning LLM | LM Studio | OpenAI-compatible, local, user controls model |
| Embedding LLM | Ollama | Local embeddings, flexible model choice |
| Vector Store | Custom brute-force | Zero deps, predictable, good enough for vault sizes |

**Why not X?**
- No cloud APIs (OpenAI, Claude) — Privacy is non-negotiable
- No SQLite/IndexedDB for vectors — Overkill for <10K notes, adds complexity
- No React — Preact is smaller, signals are cleaner than hooks

---

## Commands

```bash
# Development
bun run dev              # Build + copy to test vault
bun run dev:watch        # Watch mode with auto-copy
bun run dev:clean        # Wipe plugin data + fresh build
bun run dev:reset        # Soft reset (settings only)
bun run dev:hard-reset   # Hard reset (everything)

# Production  
bun run build            # Typecheck + production build
bun run build:dev        # Dev build with sourcemaps
bun run analyze          # Bundle size analysis

# Quality
bun run typecheck        # TypeScript check
bun run lint             # Biome lint
bun run lint:fix         # Auto-fix
bun run format           # Format code
```

**Test Vault:** `/mnt/c/Users/akougk/Projects/vaultex`

---

## Component Architecture

### Core Layers

```
src/core/
├── kernel.ts              # Service registry, dependency injection
├── events/                # Typed EventBus for decoupling
├── llm/                   # LLM abstraction layer
│   ├── provider.ts        # LLMProvider interface
│   └── providers/         # LMStudio, Ollama implementations
├── agents/                # Multi-agent system (White House Model)
│   ├── chiefOfStaff.ts    # Central orchestrator
│   ├── base.ts            # BaseAgent abstract class
│   ├── agentIdentity.ts   # Tier 2 specializations
│   ├── *Agent.ts          # Individual agent implementations
│   └── workflowAgents.ts  # Intelligence 2.0 wrappers
├── agent/                 # Legacy (Tier 1 identity here)
│   └── identity.ts        # Core Notient persona
├── intelligence/          # Workflow prompts
│   └── prompts/           # Individual prompt builders
├── agentic/               # Trust levels, action applier
├── search/                # Vector search + LLM reranking
└── context/               # Vault context builder
```

### Key Patterns

**Kernel Pattern**
- All services registered in `kernel.ts`
- Dependency injection via `kernel.get<T>(ServiceName)`
- Startup orchestration with health checks

**Two-Tier Identity**
- Tier 1: `src/core/agent/identity.ts` — Core persona, shared by ALL agents
- Tier 2: `src/core/agents/agentIdentity.ts` — Agent-specific mission/expertise
- ALWAYS compose: `buildAgentSystemPrompt()` calls `buildBaseIdentity()` internally

**Event-Driven UI**
- Views subscribe to EventBus
- Services emit events
- No direct view-to-view communication

**Streaming First**
- All LLM calls support streaming via `AsyncIterable<AgentEvent>`
- AbortController for cancellation
- Never block UI

---

## Extending the System

### Adding a New Core Agent

1. **Create agent file** in `src/core/agents/`:
   ```typescript
   // newAgent.ts
   export class NewAgent extends BaseAgent {
     constructor(llm: LLMProvider, profile?: UserProfile) {
       super(llm, "new-agent");  // Must match AgentType
       this.profile = profile;
     }
     
     protected buildSystemPrompt(context: AgentContext): string {
       return buildAgentSystemPrompt("new-agent", this.profile, ...);
     }
     
     protected parseOutput(raw: string, context: AgentContext): AgentOutput { ... }
     
     async *execute(context: AgentContext, signal?: AbortSignal): AsyncIterable<AgentEvent> { ... }
   }
   ```

2. **Add type** to `src/core/agents/types.ts`:
   ```typescript
   export type AgentType = "chat" | "note-editor" | ... | "new-agent";
   ```

3. **Add specialization** to `src/core/agents/agentIdentity.ts`:
   ```typescript
   "new-agent": {
     role: "Role Title",
     mission: "What this agent does...",
     expertise: ["area1", "area2"],
     outputFormat: { type: "structured-json", instructions: "..." }
   }
   ```

4. **Wire into ChiefOfStaff** in `chiefOfStaff.ts`:
   - Add to constructor
   - Add routing logic in `determineRouting()`
   - Add to `getAgent()` switch

### Adding a New Workflow Command

1. **Create prompt builder** in `src/core/intelligence/prompts/`:
   ```typescript
   // newworkflow.ts
   export const NEWWORKFLOW_PROMPT = `...`;
   
   export function buildNewWorkflowPrompt(profile?: UserProfile): string {
     const base = buildBaseIdentity(profile);
     return `${base}\n\n${NEWWORKFLOW_PROMPT}`;
   }
   ```

2. **Export** from `src/core/intelligence/prompts/index.ts`

3. **Add to workflow configs** in `src/core/agents/workflowAgents.ts`:
   ```typescript
   export const WORKFLOW_CONFIGS: Record<WorkflowAgentType, WorkflowConfig> = {
     // ...existing...
     "newworkflow": {
       type: "newworkflow",
       command: "/newcommand",
       promptBuilder: buildNewWorkflowPrompt,
       temperature: 0.3,
       outputType: "structured"
     }
   };
   ```

4. ChiefOfStaff routes `/newcommand` automatically via `isWorkflowCommand()`

### Adding a New LLM Provider

1. **Extend base** in `src/core/llm/providers/`:
   ```typescript
   export class NewProvider extends OpenAICompatibleProvider {
     constructor() {
       super({
         baseUrl: "http://localhost:PORT",
         defaultModel: "model-name"
       });
     }
   }
   ```

2. **Register** in Kernel startup if needed

---

## Anti-Patterns (DON'Ts)

### Architecture

❌ **Don't duplicate Tier 1 identity**
- NEVER copy persona prompts into agent files
- ALWAYS call `buildBaseIdentity()` or `buildAgentSystemPrompt()`

❌ **Don't put business logic in views**
- Views are UI only
- Delegate to services via Kernel

❌ **Don't bypass ChiefOfStaff**
- All agent execution goes through `ChiefOfStaff.execute()`
- Don't instantiate agents directly in UI code

❌ **Don't create parallel type systems**
- Reuse existing types from `types.ts`
- Extend, don't duplicate

### Code Style

❌ **Don't use abbreviations**
- `context` not `ctx`
- `configuration` not `cfg`
- `message` not `msg`

❌ **Don't add debug logging**
- No `console.log` in production code
- Use proper error boundaries

❌ **Don't use `any` without justification**
- TypeScript strict mode is enforced
- Comment why if `any` is necessary (e.g., LLM JSON parsing)

### LLM Integration

❌ **Don't assume LLM availability**
- Always handle connection failures gracefully
- Provide fallbacks where possible

❌ **Don't ignore abort signals**
- All streaming must respect `AbortController`
- Clean up resources on cancellation

❌ **Don't hardcode prompts in agents**
- Prompts belong in `agentIdentity.ts` (core) or `prompts/*.ts` (workflows)
- Agents build prompts from these sources

### UI

❌ **Don't change sidebar structure**
- Layout is locked: Note Vitals | Agent Streams | Chat
- Content is dynamic, structure is static

❌ **Don't use inline styles**
- Use CSS classes with `nv2-*` prefix
- Design system tokens in `styles.css`

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/main.ts` | Plugin entry point |
| `src/core/kernel.ts` | Service registry |
| `src/core/agents/chiefOfStaff.ts` | Agent orchestrator |
| `src/core/agents/agentIdentity.ts` | Tier 2 agent prompts |
| `src/core/agent/identity.ts` | Tier 1 core identity |
| `src/core/llm/provider.ts` | LLM interface |
| `src/core/chat/chatService.ts` | Chat orchestrator (streaming, thinking, stats) |
| `src/core/chat/thinkingParser.ts` | Parse `<think>` tags from reasoning models |
| `src/core/agentic/trustLevelManager.ts` | Action risk evaluation |
| `src/core/search/pipeline.ts` | Vector + reranking |
| `src/ui/sidebar/App.tsx` | Main sidebar UI (Preact) |
| `src/ui/sidebar/components/chat/` | Rich chat components |
| `src/ui/sidebar/components/AgentStreamsView.tsx` | Agent activity dashboard |
| `planning/PRD.md` | Product requirements |
| `planning/ROADMAP.md` | Deferred features |

---

## UI Architecture

### Sidebar Views (Three-Tab Layout)

```
┌─────────────────────────────────────────┐
│ NavDeck (Note | Agents | Chat tabs)     │
├─────────────────────────────────────────┤
│                                         │
│  View Content (based on active tab)     │
│                                         │
├─────────────────────────────────────────┤
│ SystemDashboard (status footer)         │
└─────────────────────────────────────────┘
```

**Note Vitals View:**
- NoteCard (health, links, freshness metrics)
- VitalsCards (detailed breakdown)
- QuickActions (agentic triggers)
- InsightStream (AI insights + agent results)

**Agent Streams View:**
- CapabilityCards (Search, Context, Chat status)
- ActiveAgents (running/completed with progress)
- PendingReview (actions awaiting approval)
- RecentActivity (completed actions with undo)

**Chat View:**
- RichChatView (markdown, thinking blocks, streaming)
- Direct ChatService integration (not via taskQueue)

### Quick Actions Pipeline

```
Vitals Quick Actions → triggerAgenticAction() → TaskQueue
                                                    ↓
                                              ChiefOfStaff
                                                    ↓
                                              Agent executes
                                                    ↓
                              ┌─────────────────────┴──────────────────────┐
                              ↓                                            ↓
                    Agent Streams View                           InsightStream (Vitals)
                    (card with progress,                         (1-liner insight from
                     View Results button)                         agent result)
```

### Chat Pipeline (Separate)

```
Chat Input → ChatService.chat() → LLM Stream → RichChatView
                                      ↓
                              ThinkingParser
                              (separates <think> from content)
                                      ↓
                              MessageBubble + ThinkingBlock
```

**Key distinction:**
- Quick Actions → Background agents → Results in Agent Streams + Insights
- Chat → Direct conversation → Results in Chat UI

---

## Deferred Features

Track in `ROADMAP.md` with structure:
- Title, Description
- Why Deferred, Blockers
- Priority (High/Medium/Low)
- Effort Estimate

---

## Version

- **Current:** 0.3.1 (Chat + Agent Streams UI)
- **Min Obsidian:** 1.4.0
