# Multi-Agent System Architecture

## White House Model

The Notient agent system follows a "White House" organizational model:

- **President** = User (decision maker)
- **Chief of Staff** = `ChiefOfStaff` class (coordinator, dispatcher, router, aggregator)
- **Department Heads** = Specialized agents

## Two-Tier Identity System

Every agent prompt is built from two tiers:

### Tier 1: Core Notient Identity (`identity.ts`)
- Research Chief of Staff persona
- User profile + domain expertise
- PARA methodology knowledge
- Reasoning style guidelines
- Output style preferences (formality)

### Tier 2: Agent Specialization (`agentIdentity.ts`)
- Role title (e.g., "Content Architect", "Knowledge Taxonomist")
- Mission statement
- Expertise areas
- Output format requirements
- Delegation capabilities (if applicable)

This ensures all agents share Notient's core identity while having distinct specializations.

## Agent Roster

### Core Agents (Department Heads)

| Agent | Role | Output Type | Temperature | Expertise |
|-------|------|-------------|-------------|-----------|
| **Chat** | Senior Advisor & Liaison | Conversational | 0.7 | Synthesis, coordination, delegation |
| **Note-Editor** | Content Architect | Structured JSON | 0.3 | Structure optimization, frontmatter |
| **Classifier** | Knowledge Taxonomist | Structured JSON | 0.2 | PARA methodology, tagging |
| **Link-Finder** | Connection Specialist | Structured JSON | 0.3 | Semantic relationships, graph analysis |
| **Context-Builder** | Intelligence Analyst | Internal | 0.1 | Information retrieval, briefing prep |

### Workflow Agents (Intelligence 2.0)

| Agent | Slash Command | Output Type | Temperature | Purpose |
|-------|---------------|-------------|-------------|---------|
| **Enhance** | `/enhance` | Structured JSON | 0.3 | Transform captures into structured notes |
| **Atomic** | `/atomize` | Structured JSON | 0.2 | Break notes into atomic concepts |
| **Synthesis** | `/synthesize` | Structured JSON | 0.3 | Create synthesis from related notes |
| **Task** | `/tasks` | Structured JSON | 0.2 | Extract actions, decisions, deadlines |
| **Brand** | `/brand` | Structured JSON | 0.3 | Check content against brand voice |
| **Connection** | `/connect` | Structured JSON | 0.3 | Build semantic connections (6 types) |
| **Antagonist** | `/challenge` | Structured JSON | 0.4 | Devil's advocate critique |
| **Clipping** | `/clipping` | Structured JSON | 0.2 | Process web clippings into notes |

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         ChiefOfStaff                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Task Routing                          │   │
│  │  /command → explicit agent │ keywords → intent detect   │   │
│  │            default → chat agent (can delegate)           │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│         ┌────────────────────┼────────────────────┐            │
│         ▼                    ▼                    ▼            │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐        │
│  │   Preflight │    │   Primary   │    │ Delegation  │        │
│  │   (context) │───▶│   Agent     │◀───│  Protocol   │        │
│  └─────────────┘    └─────────────┘    └─────────────┘        │
│                              │                                  │
│                     ┌────────┴────────┐                        │
│                     ▼                 ▼                        │
│              ┌───────────┐    ┌─────────────┐                  │
│              │ Streaming │    │  Aggregate  │                  │
│              │  Events   │    │   Results   │                  │
│              └───────────┘    └─────────────┘                  │
└─────────────────────────────────────────────────────────────────┘
```

## Key Features

### 1. Two-Tier Identity Prompts
All agents share core Notient identity but have distinct specializations:
```typescript
// Build complete system prompt with both tiers
const prompt = buildAgentSystemPrompt(
  "note-editor",  // Agent type
  profile,        // User profile for domain adaptation
  contextString,  // Note + vault context
);

// Result structure:
// ════════════════════════════════════════════════
// TIER 1: Core Notient Identity
// - Research Chief of Staff persona
// - User domain expertise context
// - PARA methodology
// - Reasoning/output style
// ════════════════════════════════════════════════
// TIER 2: Content Architect Specialization
// - Mission statement
// - Expertise areas
// - Output format requirements
// ════════════════════════════════════════════════
// Context: Current note, search results, etc.
```

### 2. Current Note Always in Context
Every agent receives the active note as primary context:
```typescript
interface AgentContext {
  currentNote: NoteContext;  // Always present
  query: string;
  chatHistory: ChatMessage[];
  // ... additional context
}
```

### 3. Agent Delegation
Chat agent can invoke specialist agents:
```typescript
// Chat agent detects delegation trigger
"I'll analyze this note for connections. [DELEGATE:connect]"

// ChiefOfStaff handles delegation
private async handleDelegation(request: DelegationRequest): Promise<DelegatedResult>
```

### 4. Session Awareness
Agents know what other agents are active:
```typescript
interface AgentSession {
  activeAgents: Set<AgentType>;
  completedAgents: Map<AgentType, AgentOutput>;
  // ...
}
```

### 5. Resource-Aware Parameters
Model parameters vary by agent and model capabilities:
```typescript
const selector = new ModelSelector("falcon-h1r-7b");
const options = selector.getOptionsForAgent("chat", noteContext);
// Returns optimized temperature, maxTokens based on model profile
```

### 6. Structured vs Conversational Output
Different parsing per agent type:
```typescript
type AgentOutputKind = "conversational" | "structured" | "internal";

// Chat → streaming text
// Note-Editor → ProposedAction[]
// Classifier → ClassificationOutput
// Link-Finder → LinkSuggestionsOutput
// Context-Builder → InternalOutput (not shown to user)
```

## Usage

### Basic Chat Execution
```typescript
const chief = new ChiefOfStaff(llm, search, contextBuilder, obsidian, profile);

const task: ChiefOfStaffTask = {
  query: "What's this note about?",
  notePath: "notes/example.md",
  noteTitle: "Example Note",
  chatHistory: [],
};

for await (const event of chief.execute(task)) {
  switch (event.type) {
    case "chunk":
      console.log(event.content); // Streaming response
      break;
    case "complete":
      console.log(event.output); // Final output
      break;
  }
}
```

### Explicit Agent Targeting
```typescript
// Force specific agent
const task: ChiefOfStaffTask = {
  query: "/classify",
  notePath: "notes/example.md",
  noteTitle: "Example Note",
  chatHistory: [],
  targetAgent: "classifier", // Bypass routing
};
```

### Aggregated Results
```typescript
const result = await chief.executeAndAggregate(task);

console.log(result.primary);        // Main output
console.log(result.supporting);     // Supporting agent outputs
console.log(result.proposedActions); // All proposed actions
console.log(result.allCitations);   // All cited notes
```

## File Structure

```
src/core/agents/
├── index.ts              # Module exports
├── types.ts              # Type definitions
├── base.ts               # BaseAgent abstract class
├── agentIdentity.ts      # Two-tier identity system for core agents
├── chatAgent.ts          # Senior Advisor & Liaison
├── noteEditorAgent.ts    # Content Architect
├── classifierAgent.ts    # Knowledge Taxonomist
├── linkFinderAgent.ts    # Connection Specialist
├── contextBuilderAgent.ts # Intelligence Analyst
├── workflowAgents.ts     # Workflow agents (Intelligence 2.0)
├── chiefOfStaff.ts       # Central coordinator
├── modelSelector.ts      # Resource-aware parameters
└── README.md             # This file
```

## Identity Integration

The system integrates three identity/prompt sources:

```
src/core/agent/identity.ts          → Tier 1: Core Notient identity
                                       (buildBaseIdentity, formatPARAContext)

src/core/agents/agentIdentity.ts    → Tier 2: Core agent specializations
                                       (AGENT_SPECIALIZATIONS, buildAgentSystemPrompt)

src/core/intelligence/prompts/*.ts  → Tier 2: Workflow agent prompts
                                       (buildEnhancePrompt, buildAtomicSplitPrompt, etc.)
```

All agents share Tier 1 (Research Chief of Staff + user profile). Tier 2 varies:
- Core agents use `agentIdentity.ts` specializations
- Workflow agents use `intelligence/prompts/*.ts` builders

## Slash Commands → Workflow Mapping

```typescript
// Slash commands are automatically routed to workflow agents
"/enhance"   → EnhanceAgent     // Transform captures
"/atomize"   → AtomicAgent      // Break into concepts
"/synthesize"→ SynthesisAgent   // Create synthesis note
"/tasks"     → TaskAgent        // Extract actions
"/brand"     → BrandAgent       // Check brand voice
"/connect"   → ConnectionAgent  // Find connections
"/challenge" → AntagonistAgent  // Devil's advocate
"/clipping"  → ClippingAgent    // Process web clippings
```

## Migration from agentLoop.ts

The new system replaces the monolithic `NotientAgent` with specialized agents:

| Old | New |
|-----|-----|
| `NotientAgent.execute()` | `ChiefOfStaff.execute()` |
| `NotientPromptBuilder` | Agent-specific `buildSystemPrompt()` |
| `parseActionPlan()` | `NoteEditorAgent.parseOutput()` |
| Single temperature | Per-agent temperatures |
| Hardcoded context | `ModelSelector` resource-aware |

The old system can be deprecated once the new agents are integrated with the UI.
