# Intelligence 2.0: Genetic UI & Advanced Agent Actions

**Version:** 2.0
**Created:** 2026-01-07
**Interview Session:** vision-reality-gap-analysis
**Type:** architecture
**Status:** specification

---

## Executive Summary

This specification outlines **Intelligence 2.0** for Notient, implementing the full **"Genetic UI"** vision where every interactive element triggers specialized agent pipelines. The current implementation provides a foundation with 3 basic actions (Enrich, Link, Move) and 5 action types. Intelligence 2.0 expands this to **10 specialized agent actions** with dedicated prompts, orchestration, and UI surfaces.

**Gap Analysis:**
- **Vision:** 7 specialized agent actions with rich prompts
- **Current:** 3 generic actions with simple prompts
- **Missing:** 4 core actions (Atomic, Synthesis, Clipping, Task) + 3 domain-specific (Brand, Trim, Expand)

**Philosophy:**
> "Genetic UI" = Every button is an agent. Every click spawns intelligence.

---

## 1. Vision vs Reality: Comprehensive Audit

### 1.1 Original Vision (from `planning/notient-actions/`)

**7 Specialized Agent Actions:**

| Action | Purpose | Output | Status |
|--------|---------|--------|--------|
| **atomic** | Extract atomic concepts (100-300w) | 3-7 new atomic notes | ❌ Missing |
| **enhance** | Transform informal → structured | Enhanced note + metadata | ⚠️ Partial (basic enrich exists) |
| **synthesis** | Create synthesis from clusters | Synthesis note (500-800w) | ❌ Missing |
| **connection** | Build semantic knowledge graph | 6 connection types + context | ⚠️ Partial (simple link exists) |
| **clipping** | Web clipping → atomic notes | 3-5 atomic notes + PARA placement | ❌ Missing |
| **task** | Extract actions, decisions, deadlines | Task list + deadlines + decisions | ❌ Missing |
| **brand** | Check akougkas.io brand alignment | Alignment score + suggestions | ❌ Missing |

### 1.2 Current Implementation

**5 Task Types (`src/core/agent/types.ts:13`):**

| Task Type | Prompt | Action Types Generated | UI Entry Points |
|-----------|--------|----------------------|-----------------|
| `enrich` | "Suggest improvements: tags, metadata, topics" | frontmatter_add_tags, append_section | ✅ "Enrich" button |
| `link` | "Find notes that should be linked" | append_related_links | ✅ "Link" button |
| `classify` | "Suggest PARA category and folder" | move_note, frontmatter_set | ✅ "Move" button |
| `analyze` | "Assess completeness, clarity, structure" | - | ⚠️ Health metric click |
| `chat` | Generic Q&A | - | ✅ Chat input |

**5 Action Types (`src/core/agentic/types.ts:337`):**

| Action Type | Risk | Payload | Applied | Status |
|-------------|------|---------|---------|--------|
| `frontmatter_set` | LOW | `{key, value}` | ✅ Yes | Implemented |
| `frontmatter_add_tags` | LOW | `{tags: string[]}` | ✅ Yes | Implemented |
| `append_section` | LOW | `{heading?, content}` | ✅ Yes | Implemented |
| `append_related_links` | MEDIUM | `{links: string[]}` | ✅ Yes | Implemented |
| `move_note` | MEDIUM | `{from, to}` | ✅ Yes | Implemented |
| `merge_notes` | HIGH | `{sources: string[]}` | ❌ No | Phase 3 reserved |
| `trash_note` | HIGH | `{useSystemTrash?}` | ❌ No | Phase 3 reserved |

### 1.3 Genetic UI Status

**What Exists:**

```typescript
// Current "Genetic UI" implementation
const quickActions = [
  {
    icon: "sparkles",
    label: "Enrich",
    onClick: () => prefillChatAndSwitch(
      `Enrich and expand "${noteTitle}" with additional context and insights`
    )
  },
  {
    icon: "link",
    label: "Link",
    onClick: () => prefillChatAndSwitch(
      `Find notes that should be linked to "${noteTitle}"`
    )
  },
  {
    icon: "arrow-right-circle",
    label: "Move",
    onClick: () => prefillChatAndSwitch(
      `Suggest the best folder/category for "${noteTitle}"`
    )
  }
];
```

**Genetic UI Principles:**
- ✅ Buttons trigger agent pipelines (not direct actions)
- ✅ Asynchronous task orchestration (`AgentTaskQueue`)
- ✅ Streaming results (`AgentStreamEvent`)
- ✅ Action proposals with user approval
- ✅ Undo support (`ActionHistory`)
- ❌ Missing specialized prompts per action type
- ❌ Missing 4 core vision actions
- ❌ Missing progressive disclosure (complex multi-step workflows)

---

## 2. Intelligence 2.0: Complete Feature Set

### 2.1 New Agent Actions (7 → 10)

**Tier 1: Knowledge Restructuring** (NEW)

#### **1. Atomic Split** 🧬
**Original:** `planning/notient-actions/atomic.txt`

**Purpose:** Break down complex notes into atomic concepts (100-300 words each)

**Genetic UI:**
```typescript
{
  icon: "split",
  label: "Atomize",
  onClick: () => triggerAgentAction("atomic", {
    prompt: ATOMIC_SPLIT_PROMPT, // From planning/notient-actions/atomic.txt
    expectedActions: ["create_atomic_note", "update_original_note", "create_connections"],
    estimatedNotes: "3-7 new notes"
  })
}
```

**Agent Flow:**
```
User clicks "Atomize"
  ↓
Agent reads current note
  ↓
LLM analyzes structure (ATOMIC_SPLIT_PROMPT)
  ↓
Returns JSON: {
  "analysis": "This note covers 5 distinct concepts...",
  "proposed_atomic_notes": [
    {
      "title": "distributed-consensus-algorithms",
      "core_concept": "Algorithms ensuring agreement in distributed systems",
      "content_outline": ["Paxos", "Raft", "Byzantine"],
      "connections": ["[[fault-tolerance]]", "[[distributed-systems]]"],
      "priority": "high"
    }
  ],
  "original_note_restructure": "Keep overview, link to atomic notes",
  "implementation_order": ["consensus", "paxos", "raft"]
}
  ↓
Agent proposes actions:
  - create_note: "distributed-consensus-algorithms.md"
  - create_note: "paxos-algorithm.md"
  - create_note: "raft-consensus.md"
  - update_note: "original.md" (add links to new notes)
  ↓
User approves batch
  ↓
Notient executes sequentially
  ↓
✅ 3-7 new atomic notes created with bidirectional links
```

**New Action Types Needed:**
```typescript
| "create_note"       // NEW
| "batch_create"      // NEW
| "restructure_note"  // NEW
```

#### **2. Synthesis Creation** 🔗
**Original:** `planning/notient-actions/synthesis.txt`

**Purpose:** Create synthesis notes from concept clusters (500-800 words)

**Genetic UI:**
```typescript
{
  icon: "network",
  label: "Synthesize",
  onClick: () => triggerAgentAction("synthesis", {
    scope: "selection" | "folder" | "tags",
    prompt: SYNTHESIS_PROMPT,
    expectedActions: ["create_synthesis_note", "update_connections"],
    minNotes: 5 // Require at least 5 related notes
  })
}
```

**Agent Flow:**
```
User selects 5-10 related notes OR clicks "Synthesize" on a tag/folder
  ↓
Agent loads all selected notes
  ↓
RAG finds additional related notes (topK=10)
  ↓
LLM analyzes patterns (SYNTHESIS_PROMPT)
  ↓
Returns JSON: {
  "synthesis_overview": "These notes form a coherent framework for...",
  "synthesis_note": {
    "title": "distributed-systems-patterns-overview",
    "content": "# Distributed Systems Patterns\n\n## Overview\n...",
    "key_insights": ["New understanding X", "Pattern Y"],
    "connections_map": [
      { "source_note": "[[paxos]]", "relationship": "Foundational concept" }
    ]
  },
  "synthesis_type": "thematic"
}
  ↓
Agent proposes actions:
  - create_note: "distributed-systems-patterns-overview.md"
  - append_related_links: to each source note (bidirectional)
  ↓
User approves
  ↓
✅ Synthesis note created with rich connections
```

**New Action Types Needed:**
```typescript
| "create_synthesis_note"  // NEW
| "batch_append_links"      // NEW (bidirectional linking)
```

#### **3. Web Clipping Processor** 📰
**Original:** `planning/notient-actions/clipping.txt`

**Purpose:** Transform web articles into 3-5 atomic notes with PARA placement

**Genetic UI:**
```typescript
{
  icon: "clipboard",
  label: "Process Clipping",
  onClick: () => triggerAgentAction("clipping", {
    prompt: CLIPPING_PROMPT,
    requiresWebContent: true,
    expectedActions: ["create_atomic_note", "update_clipping_status"],
    expectedNotes: "3-5"
  })
}
```

**Agent Flow:**
```
User pastes web article into inbox note
  ↓
Clicks "Process Clipping"
  ↓
Agent detects web content (URL, formatting)
  ↓
LLM extracts atomic concepts (CLIPPING_PROMPT)
  ↓
Returns JSON: {
  "folder_recommendation": "3-resources/Technical",
  "atomic_concepts": [
    {
      "title": "distributed-consensus-algorithms",
      "content": "300 words with technical depth",
      "frontmatter": { "source": "https://...", "tags": ["distributed-systems"] },
      "connections": [{ "target": "[[fault-tolerance]]", "context": "Both handle failures" }]
    }
  ]
}
  ↓
Agent proposes actions:
  - create_note: "distributed-consensus.md" (3-resources/Technical/)
  - create_note: "paxos-deep-dive.md"
  - frontmatter_set: original note { status: "processed" }
  ↓
User approves batch
  ↓
✅ Clipping processed into organized atomic notes
```

**New Action Types Needed:**
```typescript
| "batch_create_with_placement"  // NEW (PARA-aware)
```

#### **4. Task Extraction** ✅
**Original:** `planning/notient-actions/task.txt`

**Purpose:** Extract actionable items, decisions, deadlines from meeting notes

**Genetic UI:**
```typescript
{
  icon: "check-square",
  label: "Extract Tasks",
  onClick: () => triggerAgentAction("task_extraction", {
    prompt: TASK_EXTRACTION_PROMPT,
    expectedActions: ["create_task_note", "append_task_section"],
    deadlineDetection: true
  })
}
```

**Agent Flow:**
```
User has meeting notes with actions scattered throughout
  ↓
Clicks "Extract Tasks"
  ↓
Agent analyzes note
  ↓
LLM extracts structured data (TASK_EXTRACTION_PROMPT)
  ↓
Returns JSON: {
  "tasks": [
    {
      "text": "Review architecture proposal",
      "category": "immediate",
      "deadline": "2026-01-15",
      "project_area": "1-projects/SystemRefactor",
      "dependencies": ["Waiting for team feedback"],
      "context": "Critical for Q1 timeline"
    }
  ],
  "decisions": [
    {
      "decision": "Use microservices architecture",
      "rationale": "Scalability requirements",
      "impact": "Affects entire system design"
    }
  ],
  "next_actions": ["Review proposal", "Schedule team meeting", "Draft RFC"]
}
  ↓
Agent proposes actions:
  - create_note: "tasks-from-meeting-2026-01-07.md" (with task list)
  - append_section: "## Decisions" to original note
  - append_section: "## Next Actions" to original note
  - frontmatter_set: { "has-tasks": true }
  ↓
User approves
  ↓
✅ Tasks extracted and organized
```

**New Action Types Needed:**
```typescript
| "create_task_note"        // NEW
| "append_task_section"     // NEW (formatted task list)
| "extract_to_calendar"     // NEW (deadline → calendar event)
```

**Tier 2: Knowledge Quality** (NEW)

#### **5. Brand Checker** 🎯
**Original:** `planning/notient-actions/brand.txt`

**Purpose:** Ensure content aligns with akougkas.io brand (authority, technical depth, credibility)

**Genetic UI:**
```typescript
{
  icon: "shield",
  label: "Brand Check",
  onClick: () => triggerAgentAction("brand", {
    prompt: BRAND_CHECK_PROMPT,
    targetAudience: "technical-researchers",
    expectedActions: ["append_revision_suggestions", "frontmatter_set"],
    scoreThreshold: 7.0
  })
}
```

**Agent Flow:**
```
User writing blog post or grant proposal
  ↓
Clicks "Brand Check"
  ↓
Agent analyzes tone, claims, evidence
  ↓
LLM evaluates (BRAND_CHECK_PROMPT)
  ↓
Returns JSON: {
  "brand_alignment": {
    "technical_authority": {"score": 8, "comment": "Strong expertise"},
    "professional_voice": {"score": 7, "comment": "Appropriate tone"},
    "credibility": {"score": 9, "comment": "Well-supported claims"},
    "value_proposition": {"score": 6, "comment": "Could be clearer"}
  },
  "strengths": ["Technical depth excellent", "Evidence-based"],
  "concerns": ["Some claims overstated without evidence"],
  "revision_suggestions": {
    "high_priority": ["Add citation for claim X"],
    "medium_priority": ["Soften tone in paragraph 3"],
    "enhancements": ["Add practical example"]
  },
  "overall_score": 7.5,
  "final_recommendation": "needs_revision"
}
  ↓
Agent proposes actions:
  - append_section: "## Brand Review Results" (with scores)
  - frontmatter_set: { "brand-score": 7.5, "review-date": "2026-01-07" }
  - append_section: "## Suggested Revisions" (high priority items)
  ↓
User sees actionable feedback
  ↓
✅ Content aligned with brand standards
```

**New Action Types Needed:**
```typescript
| "append_review_section"   // NEW (structured feedback)
| "highlight_text_issues"   // NEW (inline annotations)
```

**Tier 3: Existing Actions (Enhanced)**

#### **6. Enhanced Enrich** ✨ (UPGRADE)
**Current:** Generic enhancement
**Upgrade:** Structured transformation with sections

**Original:** `planning/notient-actions/enhance.txt`

**New Prompt Structure:**
```
INPUT TYPES:
- Meeting notes / quick jots
- Ideas / random thoughts
- Informal captures
- Voice-to-text transcriptions
- Rough drafts

ENHANCEMENT GOALS:
1. Structure: Add organization and flow
2. Metadata: Proper frontmatter and tags
3. Context: Fill in implied information
4. Connections: Link to relevant concepts
5. Actionability: Extract tasks
6. Clarity: Improve readability

OUTPUT:
{
  "content_type": "meeting|idea|technical|random|draft",
  "enhanced_note": {
    "title": "Descriptive title",
    "frontmatter": { "created": "YYYY-MM-DD", "tags": [...], "type": "capture" },
    "content": "Improved content with structure"
  },
  "para_placement": { "folder": "1-projects/X", "reasoning": "..." },
  "connections": ["[[note1]]", "[[note2]]"],
  "next_actions": ["Follow-up 1", "Follow-up 2"]
}
```

**Upgrade Changes:**
- Add content type detection
- Add PARA placement suggestion
- Add next actions extraction
- Add connection discovery

#### **7. Advanced Connection** 🕸️ (UPGRADE)
**Current:** Simple link suggestions
**Upgrade:** 6 connection types with semantic reasoning

**Original:** `planning/notient-actions/connection.txt`

**Connection Types:**
1. **conceptual** - Related technical concepts (e.g., consensus ↔ fault tolerance)
2. **methodological** - Similar approaches (e.g., gradient descent ↔ optimization)
3. **problem-solution** - Challenges & solutions (e.g., scalability ↔ partitioning)
4. **hierarchical** - General ↔ specific (e.g., neural nets ↔ CNNs)
5. **temporal** - Evolution (e.g., MapReduce ↔ Spark)
6. **practical** - Theory ↔ application (e.g., CAP theorem ↔ DB design)

**New Output:**
```json
{
  "suggested_connections": [
    {
      "target": "[[byzantine-fault-tolerance]]",
      "type": "conceptual",
      "context": "Both handle adversarial failures in distributed systems",
      "bidirectional_value": "Consensus needs BFT; BFT enables consensus",
      "link_text": "depends on Byzantine fault tolerance for safety",
      "score": 0.92
    }
  ],
  "synthesis_opportunities": [
    {
      "theme": "distributed-systems-patterns",
      "related_notes": ["[[note1]]", "[[note2]]", "[[note3]]"],
      "synthesis_value": "Would create comprehensive DS overview"
    }
  ]
}
```

**Upgrade Changes:**
- Add 6 connection type classification
- Add bidirectional value reasoning
- Add synthesis opportunity detection
- Add confidence scores

#### **8. Classify (Keep Current)** 📁
**Status:** Already well-implemented
**No changes needed**

#### **9. Analyze (Keep Current)** 🔍
**Status:** Already well-implemented
**No changes needed**

#### **10. Chat (Keep Current)** 💬
**Status:** Already well-implemented
**No changes needed**

---

## 3. New Action Types for Intelligence 2.0

### 3.1 Note Creation Actions

```typescript
/**
 * Create a new note with content
 */
export interface CreateNoteAction extends ProposedActionBase {
  type: "create_note";
  payload: {
    /** Path where note should be created */
    path: string;
    /** Note content (markdown) */
    content: string;
    /** Frontmatter to include */
    frontmatter?: Record<string, unknown>;
  };
}

/**
 * Create multiple notes in batch (atomic split, clipping)
 */
export interface BatchCreateNotesAction extends ProposedActionBase {
  type: "batch_create_notes";
  payload: {
    /** Notes to create */
    notes: Array<{
      path: string;
      content: string;
      frontmatter?: Record<string, unknown>;
    }>;
    /** Whether to create bidirectional links between notes */
    createBidirectionalLinks: boolean;
  };
}

/**
 * Restructure existing note (keep overview, extract sections)
 */
export interface RestructureNoteAction extends ProposedActionBase {
  type: "restructure_note";
  payload: {
    /** New content structure */
    content: string;
    /** Sections that were extracted (for linking) */
    extractedSections: Array<{
      heading: string;
      newNotePath: string;
    }>;
  };
}
```

### 3.2 Task & Project Actions

```typescript
/**
 * Create a task note with deadline tracking
 */
export interface CreateTaskNoteAction extends ProposedActionBase {
  type: "create_task_note";
  payload: {
    /** Path for task note */
    path: string;
    /** Structured task list */
    tasks: Array<{
      text: string;
      category: "immediate" | "planned" | "backlog" | "blocked";
      deadline?: string; // YYYY-MM-DD
      project?: string;
    }>;
    /** Decisions extracted */
    decisions?: Array<{
      decision: string;
      rationale: string;
      date?: string;
    }>;
  };
}

/**
 * Extract deadline to calendar integration
 */
export interface ExtractToCalendarAction extends ProposedActionBase {
  type: "extract_to_calendar";
  payload: {
    /** Task description */
    task: string;
    /** Deadline in YYYY-MM-DD format */
    deadline: string;
    /** Project context */
    project?: string;
  };
}
```

### 3.3 Review & Quality Actions

```typescript
/**
 * Append review results (brand check, quality check)
 */
export interface AppendReviewSectionAction extends ProposedActionBase {
  type: "append_review_section";
  payload: {
    /** Review type */
    reviewType: "brand" | "quality" | "technical";
    /** Score (0-10) */
    score: number;
    /** Structured findings */
    findings: {
      strengths: string[];
      concerns: string[];
      suggestions: string[];
    };
    /** Review date */
    date: string;
  };
}

/**
 * Highlight specific text issues (inline annotations)
 */
export interface HighlightTextIssuesAction extends ProposedActionBase {
  type: "highlight_text_issues";
  payload: {
    /** Issues to highlight */
    issues: Array<{
      /** Line number or text snippet to find */
      location: string;
      /** Issue type */
      type: "accuracy" | "tone" | "clarity" | "evidence";
      /** Description of issue */
      issue: string;
      /** Suggested fix */
      suggestion: string;
    }>;
  };
}
```

### 3.4 Batch Operations

```typescript
/**
 * Batch append links to multiple notes (bidirectional)
 */
export interface BatchAppendLinksAction extends ProposedActionBase {
  type: "batch_append_links";
  payload: {
    /** Links to add */
    linkPairs: Array<{
      fromNote: string;
      toNote: string;
      context: string; // Why these should be linked
    }>;
  };
}
```

### 3.5 Updated Action Type Union

```typescript
export type ProposedActionType =
  // Existing (Phase 2)
  | "frontmatter_set"
  | "frontmatter_add_tags"
  | "append_section"
  | "append_related_links"
  | "move_note"

  // Intelligence 2.0 (NEW)
  | "create_note"
  | "batch_create_notes"
  | "restructure_note"
  | "create_task_note"
  | "extract_to_calendar"
  | "append_review_section"
  | "highlight_text_issues"
  | "batch_append_links"
  | "create_synthesis_note"

  // Phase 3 (Reserved)
  | "merge_notes"
  | "trash_note";

/** Intelligence 2.0 action types */
export const INTELLIGENCE_2_ACTION_TYPES: ProposedActionType[] = [
  "create_note",
  "batch_create_notes",
  "restructure_note",
  "create_task_note",
  "extract_to_calendar",
  "append_review_section",
  "highlight_text_issues",
  "batch_append_links",
  "create_synthesis_note",
];
```

---

## 4. Genetic UI Architecture

### 4.1 Current Architecture

```
Button Click
    ↓
prefillChatAndSwitch(prompt)
    ↓
TaskQueue.enqueue(task)
    ↓
AgentLoop.execute(task)
    ↓
  [Phase 1] Load current note
  [Phase 2] Search for context (RAG)
  [Phase 3] Build system prompt
  [Phase 4] Stream LLM response
  [Phase 5] Generate action plan
    ↓
Yield actions to UI
    ↓
User approves
    ↓
ActionApplier.apply(action)
```

**Limitations:**
- Generic prompts (not specialized per action)
- Single-phase execution (no progressive disclosure)
- Limited action types (5 implemented)
- No batch operations
- No multi-step workflows

### 4.2 Intelligence 2.0 Architecture

```
Button Click
    ↓
triggerSpecializedAgentAction(actionType, config)
    ↓
ActionOrchestrator.dispatch(actionType)
    ↓
  Load specialized prompt from AGENT_PROMPTS[actionType]
  Detect workflow complexity (simple | complex | batch)
  Initialize ActionPipeline
    ↓
ActionPipeline.execute()
    ↓
  [Phase 1] Preparation
    - Load current note
    - Load related notes (if needed)
    - Build specialized context

  [Phase 2] Analysis (streaming)
    - LLM analyzes with specialized prompt
    - Stream analysis to user
    - Generate insights

  [Phase 3] Planning
    - LLM proposes actions (specialized format)
    - Validate actions
    - Calculate risks

  [Phase 4] Batch Handling (if applicable)
    - Group related actions
    - Detect dependencies
    - Create execution plan

  [Phase 5] Progressive Disclosure
    - Show phased execution plan
    - Request user approval per phase
    - Execute with rollback support
    ↓
Yield phased actions to UI
    ↓
User approves phase-by-phase
    ↓
ActionApplier.applyBatch(actions, phase)
```

### 4.3 New Core Components

#### **ActionOrchestrator**
**Location:** `src/core/intelligence/actionOrchestrator.ts` (NEW)

```typescript
export class ActionOrchestrator {
  async dispatch(
    actionType: IntelligenceActionType,
    context: ActionContext
  ): Promise<ActionPipeline> {
    // Load specialized prompt
    const prompt = AGENT_PROMPTS[actionType];

    // Detect workflow complexity
    const complexity = this.detectComplexity(actionType);

    // Create pipeline
    return new ActionPipeline({
      actionType,
      prompt,
      complexity,
      context,
      llm: this.llm,
      search: this.search
    });
  }

  private detectComplexity(actionType: IntelligenceActionType): WorkflowComplexity {
    switch (actionType) {
      case "atomic":
      case "synthesis":
      case "clipping":
        return "batch"; // Multiple notes created

      case "task":
      case "brand":
        return "complex"; // Multi-phase analysis

      case "enhance":
      case "connection":
        return "simple"; // Single-note operation

      default:
        return "simple";
    }
  }
}
```

#### **ActionPipeline**
**Location:** `src/core/intelligence/actionPipeline.ts` (NEW)

```typescript
export class ActionPipeline {
  async execute(): AsyncGenerator<PipelineEvent> {
    // Phase 1: Preparation
    yield { type: "phase", phase: "preparation", progress: 10 };
    const context = await this.prepare();

    // Phase 2: Analysis (streaming)
    yield { type: "phase", phase: "analysis", progress: 30 };
    let analysis = "";
    for await (const chunk of this.analyze(context)) {
      analysis += chunk;
      yield { type: "chunk", content: chunk };
    }

    // Phase 3: Planning
    yield { type: "phase", phase: "planning", progress: 70 };
    const actions = await this.plan(analysis, context);

    // Phase 4: Batch Handling
    if (this.complexity === "batch") {
      yield { type: "phase", phase: "batching", progress: 85 };
      const batches = this.createBatches(actions);
      yield { type: "batches", batches };
    } else {
      yield { type: "actions", actions };
    }

    // Phase 5: Completion
    yield { type: "phase", phase: "complete", progress: 100 };
  }

  private createBatches(actions: ProposedAction[]): ActionBatch[] {
    // Group related actions
    // Example: All create_note actions in one batch
    const batches: ActionBatch[] = [];

    const createActions = actions.filter(a => a.type === "create_note");
    if (createActions.length > 0) {
      batches.push({
        id: "batch-create",
        title: `Create ${createActions.length} atomic notes`,
        actions: createActions,
        dependencies: []
      });
    }

    const updateActions = actions.filter(a => a.type === "restructure_note");
    if (updateActions.length > 0) {
      batches.push({
        id: "batch-update",
        title: "Update source note",
        actions: updateActions,
        dependencies: ["batch-create"] // Wait for notes to exist
      });
    }

    return batches;
  }
}
```

---

## 5. Specialized Agent Prompts

### 5.1 Prompt Storage Architecture

**Location:** `src/core/intelligence/prompts/` (NEW)

```
src/core/intelligence/prompts/
├── index.ts                    # Prompt registry
├── atomic.ts                   # ATOMIC_SPLIT_PROMPT
├── synthesis.ts                # SYNTHESIS_PROMPT
├── clipping.ts                 # CLIPPING_PROMPT
├── task.ts                     # TASK_EXTRACTION_PROMPT
├── brand.ts                    # BRAND_CHECK_PROMPT
├── connection.ts               # CONNECTION_PROMPT (enhanced)
└── enhance.ts                  # ENHANCE_PROMPT (enhanced)
```

**Prompt Registry (`prompts/index.ts`):**

```typescript
export const AGENT_PROMPTS: Record<IntelligenceActionType, AgentPrompt> = {
  atomic: ATOMIC_SPLIT_PROMPT,
  synthesis: SYNTHESIS_PROMPT,
  clipping: CLIPPING_PROMPT,
  task: TASK_EXTRACTION_PROMPT,
  brand: BRAND_CHECK_PROMPT,
  connection: CONNECTION_PROMPT,
  enhance: ENHANCE_PROMPT,
  // ... existing prompts
};

export interface AgentPrompt {
  /** System prompt for the LLM */
  system: string;
  /** User prompt template (with placeholders) */
  userTemplate: string;
  /** Expected output schema (for validation) */
  outputSchema: object;
  /** Example outputs (few-shot) */
  examples?: Array<{
    input: string;
    output: string;
  }>;
  /** Temperature override */
  temperature?: number;
  /** Max tokens override */
  maxTokens?: number;
}
```

### 5.2 Example: Atomic Split Prompt

**File:** `src/core/intelligence/prompts/atomic.ts`

```typescript
export const ATOMIC_SPLIT_PROMPT: AgentPrompt = {
  system: `You are a knowledge architect specializing in breaking down complex technical content into atomic concepts for a research vault.

TASK: Analyze the current note and extract distinct atomic concepts that should be separate notes.

ATOMIC PRINCIPLES:
- One core concept per note
- 100-300 words maximum
- Self-contained and independently valuable
- Technical depth maintained
- Clear conceptual boundaries

CURRENT VAULT CONTEXT:
- User researches HPC, AI/ML, distributed systems
- PARA methodology organization
- Focus on actionable, interconnected knowledge
- Emphasis on technical accuracy and research depth

EXTRACTION CRITERIA:
1. **Distinct Concepts**: Identify separate ideas that can stand alone
2. **Technical Depth**: Maintain research-level detail
3. **Interconnections**: Map relationships between concepts
4. **Practical Value**: Ensure each concept has independent utility

NAMING CONVENTION:
- Use descriptive, technical terms
- Kebab-case for multi-word concepts
- Avoid acronyms unless widely recognized
- Example: "distributed-consensus-algorithms" not "DCA-stuff"`,

  userTemplate: `Current note: "{{noteTitle}}"
Path: {{notePath}}
Content:
{{noteContent}}

Analyze and extract atomic concepts. Output ONLY valid JSON.`,

  outputSchema: {
    type: "object",
    properties: {
      analysis: { type: "string" },
      proposed_atomic_notes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            core_concept: { type: "string" },
            content_outline: { type: "array", items: { type: "string" } },
            connections: { type: "array", items: { type: "string" } },
            priority: { type: "string", enum: ["high", "medium", "low"] }
          },
          required: ["title", "core_concept", "content_outline", "priority"]
        }
      },
      original_note_restructure: { type: "string" },
      implementation_order: { type: "array", items: { type: "string" } }
    },
    required: ["analysis", "proposed_atomic_notes", "original_note_restructure", "implementation_order"]
  },

  temperature: 0.2, // More deterministic for structural tasks
  maxTokens: 2000  // Larger for batch operations
};
```

---

## 6. UI Enhancements: Full Genetic UI

### 6.1 Quick Actions (Expanded)

**Current:** 3 buttons (Enrich, Link, Move)
**Intelligence 2.0:** 10 buttons organized by category

```typescript
export function createNoteQuickActionsV2(
  noteTitle: string,
  noteType: "capture" | "atomic" | "synthesis" | "clipping",
  triggerAgent: (actionType: IntelligenceActionType, config: ActionConfig) => void
): QuickActionCategory[] {
  return [
    {
      category: "Knowledge Restructuring",
      icon: "brain",
      actions: [
        {
          icon: "split",
          label: "Atomize",
          description: "Break into atomic concepts",
          onClick: () => triggerAgent("atomic", { estimatedNotes: "3-7" }),
          showWhen: noteType === "capture" || noteType === "clipping"
        },
        {
          icon: "network",
          label: "Synthesize",
          description: "Create synthesis from related notes",
          onClick: () => triggerAgent("synthesis", { scope: "folder" }),
          requiresSelection: true,
          showWhen: noteType === "atomic"
        },
        {
          icon: "sparkles",
          label: "Enhance",
          description: "Transform informal → structured",
          onClick: () => triggerAgent("enhance", {}),
          showWhen: noteType === "capture"
        }
      ]
    },
    {
      category: "Connections",
      icon: "link-2",
      actions: [
        {
          icon: "link",
          label: "Connect",
          description: "Find semantic connections (6 types)",
          onClick: () => triggerAgent("connection", { showTypes: true })
        },
        {
          icon: "git-branch",
          label: "Map Relations",
          description: "Visualize knowledge graph",
          onClick: () => triggerAgent("relation_map", {})
        }
      ]
    },
    {
      category: "Productivity",
      icon: "check-circle",
      actions: [
        {
          icon: "check-square",
          label: "Extract Tasks",
          description: "Find actions & deadlines",
          onClick: () => triggerAgent("task", { extractDeadlines: true })
        },
        {
          icon: "clipboard",
          label: "Process Clipping",
          description: "Web article → atomic notes",
          onClick: () => triggerAgent("clipping", {}),
          showWhen: noteType === "clipping"
        }
      ]
    },
    {
      category: "Quality",
      icon: "shield-check",
      actions: [
        {
          icon: "shield",
          label: "Brand Check",
          description: "Verify akougkas.io alignment",
          onClick: () => triggerAgent("brand", { scoreThreshold: 7.0 }),
          showWhen: isPublicContent(noteTitle)
        },
        {
          icon: "activity",
          label: "Health",
          description: "Assess note quality",
          onClick: () => triggerAgent("analyze", {})
        }
      ]
    },
    {
      category: "Organization",
      icon: "folder",
      actions: [
        {
          icon: "arrow-right-circle",
          label: "Classify",
          description: "Suggest PARA placement",
          onClick: () => triggerAgent("classify", {})
        }
      ]
    }
  ];
}
```

### 6.2 Progressive Disclosure UI

**For Complex Actions (Atomic, Synthesis, Clipping):**

```typescript
// When user clicks "Atomize"
<ActionPipelineModal>
  <Phase id="preparation" status="completed">
    ✓ Loaded note: "Complex ML Systems" (3,245 chars)
    ✓ Detected 5 distinct concepts
  </Phase>

  <Phase id="analysis" status="streaming">
    Analysis: This note covers five distinct concepts that should be
    separated for better understanding and reuse...

    [Streaming continues...]
  </Phase>

  <Phase id="planning" status="pending">
    Waiting for analysis...
  </Phase>

  <Phase id="execution" status="pending">
    Waiting for user approval...
  </Phase>
</ActionPipelineModal>

// After analysis completes
<BatchActionReview>
  <BatchSummary>
    Creating 5 atomic notes from "Complex ML Systems"
    Estimated time: ~30 seconds
  </BatchSummary>

  <Batch id="create-notes" dependencies={[]}>
    <Action type="create_note" risk="low">
      📝 Create "gradient-descent-optimization.md"
      Content: 247 words
      Location: 3-resources/Technical/ML/
      Connections: [[optimization-techniques]], [[neural-networks]]
    </Action>

    <Action type="create_note" risk="low">
      📝 Create "backpropagation-algorithm.md"
      Content: 198 words
      ...
    </Action>

    [... 3 more notes ...]
  </Batch>

  <Batch id="update-source" dependencies={["create-notes"]}>
    <Action type="restructure_note" risk="medium">
      ✏️ Update "Complex ML Systems"
      Changes: Keep overview, add links to new atomic notes
      Preview: [Show diff]
    </Action>
  </Batch>

  <Batch id="create-links" dependencies={["create-notes", "update-source"]}>
    <Action type="batch_append_links" risk="low">
      🔗 Create bidirectional links (10 connections)
      Preview: [Show graph]
    </Action>
  </Batch>

  <Controls>
    [Approve All] [Approve Phase 1] [Reject] [Modify]
  </Controls>
</BatchActionReview>
```

---

## 7. Implementation Roadmap

### Phase 1: Core Infrastructure (Week 1-2)

**Tasks:**
1. Create `ActionOrchestrator` class
2. Create `ActionPipeline` class
3. Create `prompts/` directory with all specialized prompts
4. Add new action types to `agentic/types.ts`
5. Extend `ActionApplier` to handle new action types

**Files to Create:**
- `src/core/intelligence/actionOrchestrator.ts`
- `src/core/intelligence/actionPipeline.ts`
- `src/core/intelligence/prompts/index.ts`
- `src/core/intelligence/prompts/atomic.ts`
- `src/core/intelligence/prompts/synthesis.ts`
- `src/core/intelligence/prompts/clipping.ts`
- `src/core/intelligence/prompts/task.ts`
- `src/core/intelligence/prompts/brand.ts`

**Files to Modify:**
- `src/core/agentic/types.ts` (add new action types)
- `src/core/agentic/actionApplier.ts` (handle new actions)
- `src/core/agent/types.ts` (add new task types)

### Phase 2: Specialized Actions (Week 3-4)

**Implement 4 Missing Actions:**

#### **2.1 Atomic Split**
- Prompt: Copy from `planning/notient-actions/atomic.txt`
- Action types: `create_note`, `batch_create_notes`, `restructure_note`
- UI: "Atomize" button (show when note >1000 words)
- Test: Split complex ML note into 5 atomic concepts

#### **2.2 Synthesis Creation**
- Prompt: Copy from `planning/notient-actions/synthesis.txt`
- Action types: `create_synthesis_note`, `batch_append_links`
- UI: "Synthesize" button (requires 5+ related notes)
- Test: Create synthesis from 7 distributed systems notes

#### **2.3 Clipping Processor**
- Prompt: Copy from `planning/notient-actions/clipping.txt`
- Action types: `batch_create_with_placement`
- UI: "Process Clipping" button (auto-detect web content)
- Test: Process Medium article into 4 atomic notes

#### **2.4 Task Extraction**
- Prompt: Copy from `planning/notient-actions/task.txt`
- Action types: `create_task_note`, `extract_to_calendar`
- UI: "Extract Tasks" button (show for meeting notes)
- Test: Extract 8 tasks + 3 decisions from meeting note

### Phase 3: Enhanced Actions (Week 5)

**Upgrade Existing Actions:**

#### **3.1 Enhanced Enrich**
- Use full prompt from `planning/notient-actions/enhance.txt`
- Add content type detection
- Add PARA placement
- Add next actions extraction

#### **3.2 Advanced Connection**
- Use full prompt from `planning/notient-actions/connection.txt`
- Implement 6 connection types
- Add bidirectional value reasoning
- Add synthesis opportunity detection

### Phase 4: UI & UX (Week 6-7)

**4.1 Progressive Disclosure Modal**
- Create `ActionPipelineModal` component
- Implement phased action review
- Add batch action preview
- Add dependency visualization

**4.2 Action Buttons**
- Expand Quick Actions to 10 buttons
- Add category grouping (collapsible)
- Add context-aware visibility (showWhen)
- Add action descriptions (tooltips)

**4.3 Batch Action UI**
- Create `BatchActionReview` component
- Add dependency graph visualization
- Add phase-by-phase approval
- Add selective approval (approve specific actions)

### Phase 5: Domain-Specific Actions (Week 8)

**Additional Specialized Actions:**

#### **5.1 Brand Check**
- Prompt: Copy from `planning/notient-actions/brand.txt`
- Target: Blog posts, grant proposals, public content
- Output: Brand alignment score + revision suggestions

#### **5.2 Trim Note** (NEW)
- Prompt: Remove fluff, keep essence
- Target: Verbose notes, redundant content
- Output: Condensed version + what was removed

#### **5.3 Expand Note** (NEW)
- Prompt: Add depth, examples, evidence
- Target: Sparse notes, bullet points
- Output: Expanded version with sections

---

## 8. Missing Features: Detailed Analysis

### 8.1 Specialized Prompts Gap

**Current Prompts:**
- 5 task types with generic instructions (20-100 words each)
- No domain knowledge
- No output schemas
- No few-shot examples

**Original Vision Prompts:**
- 7 specialized prompts (200-400 words each)
- Rich domain context (HPC, AI/ML, research)
- Structured JSON output schemas
- Detailed extraction criteria

**Gap:** ~85% of prompt sophistication missing

### 8.2 Action Types Gap

**Current:** 5 action types (all single-note operations)

**Original Vision Implied:**
- Batch note creation (atomic split → 3-7 notes)
- Bidirectional linking (synthesis → N×N connections)
- Task extraction (meeting → task list + calendar)
- Content transformation (clipping → atomic notes)
- Quality checks (brand → review results)

**Gap:** ~60% of action types missing

### 8.3 Agent Orchestration Gap

**Current:**
- Single-phase execution
- One action type per task
- No batch operations
- No progressive disclosure
- No dependency handling

**Original Vision:**
- Multi-phase pipelines
- Batch operations (create 5 notes atomically)
- Progressive disclosure (phase-by-phase approval)
- Dependency graphs (create notes → update source → add links)
- Rollback support (undo entire batch)

**Gap:** ~75% of orchestration sophistication missing

### 8.4 UI Surface Gap

**Current:**
- 3 action buttons
- Generic prompts
- Single approval flow
- No batch previews
- No phase indicators

**Original Vision:**
- 10+ action buttons (context-aware)
- Specialized prompts (domain-specific)
- Phased approval (batch operations)
- Rich previews (diff views, graph views)
- Progress indicators (per-phase)

**Gap:** ~70% of UI sophistication missing

---

## 9. Genetic UI: Deep Dive

### 9.1 What Is Genetic UI?

**Definition:**
> A UI paradigm where interactive elements spawn intelligent agents rather than deterministic functions.

**Traditional UI:**
```typescript
// Button → Direct function call
<button onClick={() => deleteNote(path)}>
  Delete
</button>

// Predictable: Always deletes, no intelligence
```

**Genetic UI:**
```typescript
// Button → Agent pipeline
<button onClick={() => triggerAgent("atomic", { context })}>
  Atomize
</button>

// Intelligent: Agent analyzes, proposes actions, user approves
// Each execution is unique based on content
```

### 9.2 Genetic UI Characteristics

**1. Non-Deterministic:**
- Same button + different content = different actions
- Example: "Atomize" on ML note → 5 notes; on simple note → 2 notes

**2. Context-Aware:**
- Button visibility based on note type
- Action parameters based on note content
- Prompt adaptation based on vault context

**3. Asynchronous:**
- Button click → task queued
- User can continue working
- Notification when complete

**4. Explainable:**
- Agent streams analysis
- Actions are proposed, not executed
- User sees reasoning
- Approval required

**5. Reversible:**
- All actions have undo
- Batch operations can be rolled back
- History tracking for audit

### 9.3 Genetic UI Components

```typescript
interface GeneticButton {
  /** Visual representation */
  icon: string;
  label: string;
  description: string;

  /** Intelligence layer */
  agentActionType: IntelligenceActionType;
  agentPrompt: AgentPrompt;

  /** Context awareness */
  showWhen: (context: NoteContext) => boolean;
  requiresSelection?: boolean;
  requiresWebContent?: boolean;

  /** Execution config */
  expectedActions: ProposedActionType[];
  estimatedDuration: string; // "~30s", "~2min"
  complexity: "simple" | "complex" | "batch";

  /** User feedback */
  streamAnalysis: boolean; // Show LLM thinking
  progressIndicator: "spinner" | "percentage" | "phase";

  /** Result preview */
  previewType: "diff" | "graph" | "list" | "table";
}
```

**Example Implementation:**

```typescript
const AtomizeButton: GeneticButton = {
  icon: "split",
  label: "Atomize",
  description: "Break note into atomic concepts (100-300 words each)",

  agentActionType: "atomic",
  agentPrompt: ATOMIC_SPLIT_PROMPT,

  showWhen: (context) => {
    // Show if note is long and not already atomic
    return context.wordCount > 1000 && context.type !== "atomic";
  },

  expectedActions: ["batch_create_notes", "restructure_note", "batch_append_links"],
  estimatedDuration: "~45s",
  complexity: "batch",

  streamAnalysis: true,
  progressIndicator: "phase",
  previewType: "list" // Show list of notes to create
};
```

---

## 10. Advanced Features for Intelligence 2.0

### 10.1 Smart Action Recommendations

**Auto-suggest actions based on note characteristics:**

```typescript
function suggestActions(note: NoteContext): GeneticButton[] {
  const suggestions: GeneticButton[] = [];

  // Long, complex notes → Atomize
  if (note.wordCount > 1000 && note.conceptCount > 3) {
    suggestions.push(AtomizeButton);
  }

  // Inbox captures → Enhance + Classify
  if (note.path.includes("inbox") && note.hasUnstructuredContent) {
    suggestions.push(EnhanceButton, ClassifyButton);
  }

  // Meeting notes → Extract Tasks
  if (note.type === "meeting" || note.content.includes("Action Items")) {
    suggestions.push(ExtractTasksButton);
  }

  // Web clipping → Process Clipping
  if (note.hasURL && note.type === "clipping") {
    suggestions.push(ProcessClippingButton);
  }

  // Multiple related notes selected → Synthesize
  if (selectedNotes.length >= 5) {
    suggestions.push(SynthesizeButton);
  }

  // Public-facing content → Brand Check
  if (note.tags.includes("blog") || note.tags.includes("grant-proposal")) {
    suggestions.push(BrandCheckButton);
  }

  return suggestions;
}
```

### 10.2 Workflow Templates

**Pre-defined multi-action workflows:**

```typescript
const WORKFLOW_TEMPLATES = {
  "inbox-to-knowledge": {
    name: "Inbox → Knowledge Base",
    description: "Process inbox capture into organized atomic notes",
    phases: [
      {
        phase: 1,
        action: "enhance",
        description: "Structure informal capture"
      },
      {
        phase: 2,
        action: "atomic",
        description: "Extract atomic concepts",
        dependsOn: [1]
      },
      {
        phase: 3,
        action: "connection",
        description: "Build semantic connections",
        dependsOn: [2]
      },
      {
        phase: 4,
        action: "classify",
        description: "Place in PARA structure",
        dependsOn: [2]
      }
    ]
  },

  "research-to-publication": {
    name: "Research → Publication",
    description: "Transform research notes into publication-ready content",
    phases: [
      {
        phase: 1,
        action: "synthesis",
        description: "Create synthesis from research notes"
      },
      {
        phase: 2,
        action: "brand",
        description: "Check brand alignment for publication"
      },
      {
        phase: 3,
        action: "enhance",
        description: "Polish for target audience"
      }
    ]
  }
};
```

### 10.3 Agent Specialization

**Domain-Specific Agents:**

```typescript
export type AgentSpecialization =
  | "knowledge-architect"    // Atomic, Synthesis
  | "content-enhancer"       // Enhance, Brand
  | "connection-specialist"  // Connection, Link
  | "task-manager"          // Task extraction, Classify
  | "research-assistant"    // Clipping, Synthesis
  | "quality-auditor";      // Brand, Analyze

// Each specialization has:
// - Specialized prompts
// - Domain knowledge context
// - Output format preferences
// - Quality thresholds
```

### 10.4 Batch Operation Engine

**Handle complex multi-action workflows:**

```typescript
class BatchOperationEngine {
  async executeBatch(
    batch: ActionBatch,
    onProgress: (progress: BatchProgress) => void
  ): Promise<BatchResult> {
    // Phase 1: Validate all actions
    const validations = await this.validateActions(batch.actions);
    if (validations.some(v => !v.valid)) {
      return { success: false, errors: validations.filter(v => !v.valid) };
    }

    // Phase 2: Resolve dependencies
    const executionOrder = this.topologicalSort(batch.actions);

    // Phase 3: Execute in order
    const results: ActionResult[] = [];
    for (const action of executionOrder) {
      onProgress({
        phase: "executing",
        currentAction: action.id,
        completed: results.length,
        total: executionOrder.length
      });

      const result = await this.actionApplier.apply(action);
      results.push(result);

      // Stop on first failure if strict mode
      if (!result.success && batch.strictMode) {
        await this.rollbackAll(results);
        return { success: false, partial: results };
      }
    }

    // Phase 4: Validate final state
    const finalValidation = await this.validateFinalState(results);

    return { success: true, results, finalValidation };
  }

  private topologicalSort(actions: ProposedAction[]): ProposedAction[] {
    // Build dependency graph
    // Sort actions by dependencies
    // Return execution order
  }
}
```

---

## 11. Detailed Feature Specifications

### 11.1 Atomic Split Action

**Trigger Conditions:**
- Note word count > 800
- Multiple headings (H2+) detected
- Conceptual density high (>3 concepts detected)
- User explicitly clicks "Atomize"

**Agent Prompt:**
```
System: {ATOMIC_SPLIT_PROMPT from planning/notient-actions/atomic.txt}

User: Current note: "{noteTitle}"
Content: {noteContent}

Analyze and extract atomic concepts. Output ONLY valid JSON.
```

**Expected Output:**
```json
{
  "analysis": "This note covers 5 distinct concepts: gradient descent, backpropagation, optimization techniques, learning rates, and convergence criteria. Each should be separated for better reusability.",
  "proposed_atomic_notes": [
    {
      "title": "gradient-descent-optimization",
      "core_concept": "Iterative optimization using gradients to minimize loss functions",
      "content_outline": [
        "Mathematical foundation (∇f)",
        "Update rule: θ = θ - α∇f",
        "Variants: SGD, Mini-batch, Momentum",
        "Convergence guarantees"
      ],
      "connections": [
        "[[optimization-techniques]]",
        "[[loss-functions]]",
        "[[neural-network-training]]"
      ],
      "priority": "high"
    },
    {
      "title": "backpropagation-algorithm",
      "core_concept": "Efficient gradient computation for neural networks using chain rule",
      "content_outline": [
        "Chain rule application",
        "Forward pass computation",
        "Backward pass gradient flow",
        "Computational complexity O(n)"
      ],
      "connections": [
        "[[gradient-descent-optimization]]",
        "[[neural-networks]]",
        "[[automatic-differentiation]]"
      ],
      "priority": "high"
    }
  ],
  "original_note_restructure": "Transform into overview note with links to atomic concepts. Keep high-level relationships and context.",
  "implementation_order": [
    "gradient-descent-optimization",
    "backpropagation-algorithm",
    "learning-rate-schedules",
    "convergence-analysis"
  ]
}
```

**Actions Generated:**
1. `batch_create_notes` (create 4-5 atomic notes)
2. `restructure_note` (update original to overview)
3. `batch_append_links` (bidirectional connections)

**User Experience:**
```
[1/4] Analysis: Detecting atomic concepts...
      ✓ Found 5 distinct concepts
      ✓ Identified 12 connections
      ⏱️ ~30s

[2/4] Planning: Proposing structure...
      ✓ 5 atomic notes planned
      ✓ 1 overview note restructure
      ⏱️ ~15s

[3/4] Review: Preview proposed notes

      Batch: Create 5 Atomic Notes
      ├─ 📝 gradient-descent-optimization.md (247 words)
      │    Location: 3-resources/Technical/ML/
      │    Connects: [[optimization-techniques]], [[loss-functions]]
      │
      ├─ 📝 backpropagation-algorithm.md (198 words)
      │    Location: 3-resources/Technical/ML/
      │    Connects: [[gradient-descent]], [[neural-networks]]
      │
      └─ ... [3 more notes]

      [✓ Approve All] [Approve Selected] [Reject]

[4/4] Execution: Creating notes...
      ✓ Created gradient-descent-optimization.md
      ✓ Created backpropagation-algorithm.md
      ⏱️ 3 of 5 complete...

      ✅ Complete! Created 5 atomic notes with 12 bidirectional links.
```

### 11.2 Synthesis Creation Action

**Trigger Conditions:**
- User selects 5+ related notes
- User clicks "Synthesize" on tag (gathers all notes with tag)
- User clicks "Synthesize" on folder
- Auto-suggested when conceptual clusters detected

**Agent Prompt:**
```
System: {SYNTHESIS_PROMPT from planning/notient-actions/synthesis.txt}

User: Related notes: 7 notes on distributed systems
[Note 1]: "paxos-consensus.md" - Basic Paxos algorithm...
[Note 2]: "raft-consensus.md" - Leader-based consensus...
[Note 3]: "byzantine-generals.md" - Byzantine fault tolerance...
... [4 more notes]

Build a synthesis note. Output ONLY valid JSON.
```

**Expected Output:**
```json
{
  "synthesis_overview": "These 7 notes form a comprehensive framework for understanding distributed consensus, from basic algorithms to Byzantine fault tolerance.",
  "synthesis_note": {
    "title": "distributed-consensus-frameworks",
    "frontmatter": {
      "created": "2026-01-07",
      "tags": ["synthesis", "distributed-systems", "consensus"],
      "type": "synthesis",
      "synthesis_type": "thematic"
    },
    "content": "# Distributed Consensus Frameworks\n\n## Overview\n[500-800 words synthesizing all concepts]\n\n## Key Concepts\n...",
    "key_insights": [
      "Paxos and Raft solve same problem with different tradeoffs",
      "Byzantine tolerance requires 3f+1 nodes vs simple majority for CFT",
      "Leader-based approaches trade availability for simplicity"
    ],
    "connections_map": [
      {
        "source_note": "[[paxos-consensus]]",
        "relationship": "Contributes foundational concept"
      },
      {
        "source_note": "[[raft-consensus]]",
        "relationship": "Provides practical alternative"
      }
    ]
  },
  "application_opportunities": "Supports current distributed storage research and grant proposals",
  "research_directions": [
    "Hybrid consensus mechanisms",
    "Performance comparisons at scale"
  ]
}
```

**Actions Generated:**
1. `create_synthesis_note` (500-800 words)
2. `batch_append_links` (7 source notes ← synthesis, synthesis → 7 sources)
3. `frontmatter_add_tags` (add "synthesis" tag to source notes)

### 11.3 Task Extraction Action

**Trigger Conditions:**
- Note type = "meeting"
- Note contains keywords: "Action Items", "TODO", "Decisions", "Next Steps"
- User explicitly clicks "Extract Tasks"

**Agent Prompt:**
```
System: {TASK_EXTRACTION_PROMPT from planning/notient-actions/task.txt}

User: Meeting note: "Project Kickoff - 2026-01-07"
Content: {noteContent with action items, decisions, deadlines}

Extract tasks, decisions, and deadlines. Output ONLY valid JSON.
```

**Expected Output:**
```json
{
  "summary": "Project kickoff meeting with 8 action items, 3 decisions, and 5 deadlines identified",
  "tasks": [
    {
      "text": "Review architecture proposal and provide feedback",
      "category": "immediate",
      "owner": "self",
      "deadline": "2026-01-15",
      "project_area": "1-projects/SystemRefactor",
      "dependencies": ["Architecture proposal document"],
      "context": "Critical for Q1 timeline, blocks other team members"
    },
    {
      "text": "Schedule follow-up with stakeholders",
      "category": "planned",
      "owner": "self",
      "deadline": "2026-01-20",
      "project_area": "2-areas/Project-Management",
      "dependencies": [],
      "context": "Ensure alignment before proceeding to Phase 2"
    }
  ],
  "decisions": [
    {
      "decision": "Use microservices architecture instead of monolith",
      "rationale": "Scalability requirements exceed monolith capacity",
      "impact": "Affects all subsequent design work, increases operational complexity",
      "date": "2026-01-07"
    },
    {
      "decision": "Deploy on AWS rather than on-prem",
      "rationale": "Faster time-to-market, reduced infrastructure management",
      "impact": "Monthly costs ~$5K, vendor lock-in risk",
      "date": "2026-01-07"
    }
  ],
  "next_actions": [
    "Review architecture proposal by Jan 15",
    "Draft RFC for microservices approach",
    "Schedule stakeholder alignment meeting"
  ]
}
```

**Actions Generated:**
1. `create_task_note` (formatted task list with metadata)
2. `append_section` (add "## Decisions" to meeting note)
3. `append_section` (add "## Next Actions" to meeting note)
4. `extract_to_calendar` (8 deadlines → calendar events)
5. `frontmatter_set` ({ "has-tasks": true, "task-count": 8 })

**Task Note Format:**
```markdown
---
created: 2026-01-07
tags: [tasks, project-refactor]
type: task-list
source: [[Project Kickoff - 2026-01-07]]
deadline-range: 2026-01-15 to 2026-01-31
---

# Tasks from Project Kickoff (2026-01-07)

## Immediate (Next 1-2 weeks)

- [ ] Review architecture proposal (Due: 2026-01-15) #project-refactor
  - Owner: @self
  - Depends: Architecture proposal document
  - Context: Critical for Q1 timeline

- [ ] Draft RFC for microservices (Due: 2026-01-18) #architecture
  - Owner: @self
  - Depends: Architecture review complete

## Planned (Next Month)

- [ ] Schedule stakeholder meeting (Due: 2026-01-20) #project-management
  - Owner: @self

## Backlog

... [other tasks]

---

## Decisions Made

**2026-01-07: Microservices Architecture**
- Rationale: Scalability requirements
- Impact: Affects all design work
- Tradeoff: +Operational complexity

**2026-01-07: AWS Deployment**
- Rationale: Faster time-to-market
- Impact: $5K/month, vendor lock-in
- Tradeoff: -Infrastructure management

---

*Extracted from [[Project Kickoff - 2026-01-07]]*
```

### 11.4 Brand Check Action

**Trigger Conditions:**
- Note tagged with "blog", "grant-proposal", "publication"
- Note in "akougkas.io" folder
- User explicitly requests brand check

**Agent Prompt:**
```
System: {BRAND_CHECK_PROMPT from planning/notient-actions/brand.txt}

User: Content for brand check: "{noteTitle}"
Type: {blog-post | grant-proposal | documentation}
Target audience: {technical-professionals | researchers | funding-agencies}

Content: {noteContent}

Evaluate brand alignment. Output ONLY valid JSON.
```

**Expected Output:**
```json
{
  "brand_alignment": {
    "technical_authority": {
      "score": 8,
      "comment": "Demonstrates strong expertise in HPC and distributed systems"
    },
    "professional_voice": {
      "score": 7,
      "comment": "Tone is appropriate but some sections too casual"
    },
    "credibility": {
      "score": 9,
      "comment": "Claims well-supported with specific examples from NSF work"
    },
    "value_proposition": {
      "score": 6,
      "comment": "Provides value but could be more actionable for readers"
    }
  },
  "strengths": [
    "Technical depth excellent - shows real HPC experience",
    "Evidence-based claims with specific examples",
    "Appropriate academic rigor for researcher audience"
  ],
  "concerns": [
    "Paragraph 3: Claim about '10x performance' lacks supporting data",
    "Section 2: Tone shifts to promotional rather than educational",
    "Missing citations for some algorithmic claims"
  ],
  "technical_issues": [
    "Line 45: CAP theorem explanation oversimplified",
    "Section 4: Consensus algorithm comparison missing nuance"
  ],
  "voice_adjustments": [
    "Replace 'revolutionary' with 'significant improvement'",
    "Add data to support performance claims",
    "Maintain analytical tone throughout"
  ],
  "revision_suggestions": {
    "high_priority": [
      "Add citation for '10x performance' claim or remove",
      "Fix CAP theorem explanation in line 45",
      "Add supporting data for consensus comparison"
    ],
    "medium_priority": [
      "Adjust tone in Section 2 to be more educational",
      "Add practical examples for academic audience",
      "Strengthen conclusion with actionable takeaways"
    ],
    "enhancements": [
      "Consider adding diagram for consensus comparison",
      "Link to related research papers",
      "Add author bio emphasizing NSF/HPC credentials"
    ]
  },
  "final_recommendation": "needs_revision",
  "overall_score": 7.5
}
```

**Actions Generated:**
1. `append_review_section` (brand score + findings)
2. `highlight_text_issues` (inline annotations for concerns)
3. `frontmatter_set` ({ "brand-score": 7.5, "brand-review-date": "2026-01-07" })

**User Experience:**
```
Brand Check Results for "HPC Performance Analysis"
Overall Score: 7.5/10 (Needs Revision)

✅ Strengths:
• Technical depth excellent
• Evidence-based claims
• Appropriate academic rigor

⚠️ Concerns (3):
• Paragraph 3: "10x performance" lacks supporting data
• Section 2: Tone too promotional
• Missing citations

🐛 Technical Issues (2):
• Line 45: CAP theorem oversimplified
• Section 4: Consensus comparison lacks nuance

📝 High Priority Revisions:
1. Add citation for "10x performance" or remove
2. Fix CAP theorem explanation (line 45)
3. Add data for consensus comparison

[Apply Review to Note] [Dismiss] [Re-check After Edits]
```

---

## 12. Configuration & Settings

### 12.1 Intelligence 2.0 Settings

**Location:** `src/types/settings.ts`

```typescript
export interface Intelligence2Settings {
  /** Enable Intelligence 2.0 features */
  enabled: boolean;

  /** Which specialized actions are enabled */
  enabledActions: {
    atomic: boolean;
    synthesis: boolean;
    clipping: boolean;
    task: boolean;
    brand: boolean;
    connection_advanced: boolean;
  };

  /** Batch operation settings */
  batch: {
    /** Maximum notes per batch operation */
    maxNotesPerBatch: number; // Default: 10
    /** Require confirmation for batch size > N */
    confirmThreshold: number; // Default: 5
    /** Auto-rollback on first failure */
    strictMode: boolean; // Default: true
  };

  /** Atomic split settings */
  atomic: {
    /** Minimum word count to suggest atomization */
    minWordCount: number; // Default: 800
    /** Target size for atomic notes */
    targetWordCount: number; // Default: 200
    /** Maximum atomic notes per split */
    maxNotesPerSplit: number; // Default: 7
  };

  /** Synthesis settings */
  synthesis: {
    /** Minimum notes for synthesis */
    minNotesForSynthesis: number; // Default: 5
    /** Maximum notes to include */
    maxNotesForSynthesis: number; // Default: 15
    /** Synthesis note target length */
    targetWordCount: number; // Default: 600
  };

  /** Task extraction settings */
  task: {
    /** Enable deadline detection */
    detectDeadlines: boolean; // Default: true
    /** Enable calendar export */
    exportToCalendar: boolean; // Default: false
    /** Task categorization threshold */
    immediateWindowDays: number; // Default: 14
  };

  /** Brand check settings */
  brand: {
    /** Minimum score for publication */
    minScoreThreshold: number; // Default: 7.0
    /** Target audience preset */
    targetAudience: "technical" | "general" | "academic"; // Default: "technical"
    /** Check frequency (days) */
    recheckAfterDays: number; // Default: 7
  };
}

export const DEFAULT_INTELLIGENCE_2_SETTINGS: Intelligence2Settings = {
  enabled: false, // Opt-in for now
  enabledActions: {
    atomic: true,
    synthesis: true,
    clipping: true,
    task: true,
    brand: true,
    connection_advanced: true,
  },
  batch: {
    maxNotesPerBatch: 10,
    confirmThreshold: 5,
    strictMode: true,
  },
  atomic: {
    minWordCount: 800,
    targetWordCount: 200,
    maxNotesPerSplit: 7,
  },
  synthesis: {
    minNotesForSynthesis: 5,
    maxNotesForSynthesis: 15,
    targetWordCount: 600,
  },
  task: {
    detectDeadlines: true,
    exportToCalendar: false,
    immediateWindowDays: 14,
  },
  brand: {
    minScoreThreshold: 7.0,
    targetAudience: "technical",
    recheckAfterDays: 7,
  },
};
```

---

## 13. Performance & Safety

### 13.1 Performance Characteristics

**Single Note Actions (Enrich, Link, Move):**
- Latency: ~15-30s
- LLM calls: 2-4
- Tokens: ~3K input, ~1K output

**Batch Operations (Atomic, Synthesis, Clipping):**
- Latency: ~45-90s
- LLM calls: 1 analysis + N action validations
- Tokens: ~10K input, ~5K output
- Note creation: 3-7 notes

**Complex Workflows (Brand Check, Task Extraction):**
- Latency: ~30-60s
- LLM calls: 2-3 (analysis + structured extraction)
- Tokens: ~5K input, ~2K output

### 13.2 Safety Mechanisms

**Batch Operation Safety:**

```typescript
class BatchSafety {
  // 1. Dry-run validation
  async validateBatch(batch: ActionBatch): Promise<ValidationResult> {
    const results = await Promise.all(
      batch.actions.map(a => this.validateAction(a))
    );

    return {
      valid: results.every(r => r.valid),
      errors: results.flatMap(r => r.errors),
      warnings: results.flatMap(r => r.warnings)
    };
  }

  // 2. Atomic execution (all or nothing)
  async executeBatchAtomic(batch: ActionBatch): Promise<BatchResult> {
    const snapshot = await this.createSnapshot(batch.affectedPaths);

    try {
      const results = await this.executeActions(batch.actions);
      if (results.some(r => !r.success)) {
        throw new Error("Batch failed");
      }
      return { success: true, results };
    } catch (error) {
      // Rollback all changes
      await this.restoreSnapshot(snapshot);
      return { success: false, error, rolledBack: true };
    }
  }

  // 3. Conflict detection
  detectConflicts(actions: ProposedAction[]): Conflict[] {
    const conflicts: Conflict[] = [];

    // Check for same-file modifications
    const pathModifications = new Map<string, ProposedAction[]>();
    for (const action of actions) {
      const path = action.target;
      if (!pathModifications.has(path)) {
        pathModifications.set(path, []);
      }
      pathModifications.get(path)!.push(action);
    }

    for (const [path, mods] of pathModifications) {
      if (mods.length > 1) {
        conflicts.push({
          type: "concurrent_modification",
          path,
          actions: mods,
          resolution: "sequence" // Execute sequentially
        });
      }
    }

    return conflicts;
  }
}
```

**User Protection:**
- ✅ All batch operations show preview
- ✅ Confirm threshold (default: 5 notes)
- ✅ Dry-run validation before execution
- ✅ Atomic execution (all or nothing)
- ✅ Auto-rollback on failure
- ✅ Conflict detection (same-file modifications)
- ✅ Undo support for entire batch

---

## 14. Migration Path: v1 → Intelligence 2.0

### Step 1: Enable Intelligence 2.0 (Opt-in)

```typescript
// Settings UI
new Setting(containerEl)
  .setName("Enable Intelligence 2.0")
  .setDesc("Unlock advanced agent actions: Atomic Split, Synthesis, Task Extraction, Brand Check")
  .addToggle(toggle => toggle
    .setValue(settings.intelligence2.enabled)
    .onChange(async (value) => {
      settings.intelligence2.enabled = value;
      if (value) {
        // Show welcome modal explaining new features
        showIntelligence2WelcomeModal();
      }
      await saveSettings();
    })
  );
```

### Step 2: Phased Rollout

**Phase 1: Core Actions (v2.0.0)**
- ✅ Atomic Split
- ✅ Synthesis Creation
- ✅ Task Extraction

**Phase 2: Quality Actions (v2.1.0)**
- ✅ Brand Check
- ✅ Advanced Connection (6 types)
- ✅ Enhanced Enrich

**Phase 3: Advanced Features (v2.2.0)**
- ✅ Workflow Templates
- ✅ Smart Action Recommendations
- ✅ Agent Specialization

### Step 3: Backward Compatibility

```typescript
// Support both v1 and v2 action types
function applyAction(action: ProposedAction): Promise<ActionResult> {
  // v1 actions
  if (isV1ActionType(action.type)) {
    return legacyActionApplier.apply(action);
  }

  // Intelligence 2.0 actions
  if (isIntelligence2ActionType(action.type)) {
    if (!settings.intelligence2.enabled) {
      throw new Error("Intelligence 2.0 is disabled. Enable in settings.");
    }
    return intelligence2ActionApplier.apply(action);
  }

  throw new Error(`Unknown action type: ${action.type}`);
}
```

---

## 15. Implementation Checklist

### Core Infrastructure
- [ ] Create `ActionOrchestrator` class
- [ ] Create `ActionPipeline` class
- [ ] Create `BatchOperationEngine` class
- [ ] Create `prompts/` directory structure
- [ ] Add Intelligence 2.0 settings to schema

### Specialized Prompts
- [ ] Port `atomic.txt` → `prompts/atomic.ts`
- [ ] Port `synthesis.txt` → `prompts/synthesis.ts`
- [ ] Port `clipping.txt` → `prompts/clipping.ts`
- [ ] Port `task.txt` → `prompts/task.ts`
- [ ] Port `brand.txt` → `prompts/brand.ts`
- [ ] Port `connection.txt` → `prompts/connection.ts`
- [ ] Port `enhance.txt` → `prompts/enhance.ts`

### New Action Types
- [ ] Implement `create_note` action
- [ ] Implement `batch_create_notes` action
- [ ] Implement `restructure_note` action
- [ ] Implement `create_task_note` action
- [ ] Implement `extract_to_calendar` action
- [ ] Implement `append_review_section` action
- [ ] Implement `highlight_text_issues` action
- [ ] Implement `batch_append_links` action
- [ ] Implement `create_synthesis_note` action

### UI Components
- [ ] Create `ActionPipelineModal` component
- [ ] Create `BatchActionReview` component
- [ ] Create `PhaseProgress` component
- [ ] Expand `QuickActions` to 10 buttons
- [ ] Add category grouping (collapsible sections)
- [ ] Add smart action recommendations
- [ ] Add workflow template selector

### Testing
- [ ] Test atomic split on complex note (>1000 words)
- [ ] Test synthesis with 7 related notes
- [ ] Test clipping with web article
- [ ] Test task extraction from meeting note
- [ ] Test brand check on blog post
- [ ] Test batch rollback on failure
- [ ] Test dependency resolution
- [ ] Test conflict detection

### Documentation
- [ ] Update AI_ARCHITECTURE.md with Intelligence 2.0
- [ ] Create GENETIC_UI.md guide
- [ ] Document each specialized action
- [ ] Add user guide for new features
- [ ] Create video demos

---

## 16. Success Metrics

**Adoption Metrics:**
- % of users enabling Intelligence 2.0
- Most-used specialized actions
- Average actions per session

**Quality Metrics:**
- Atomic note quality (self-contained, proper size)
- Synthesis note value (insights generated)
- Task extraction accuracy (vs manual)
- Brand check adoption (for public content)

**Performance Metrics:**
- Latency per action type
- LLM token consumption
- User approval rate (% of proposed actions approved)
- Batch operation success rate

**User Satisfaction:**
- Time saved vs manual processing
- Note organization improvement
- Knowledge graph density increase
- User feedback scores

---

## 17. Conclusion

**Intelligence 2.0 unlocks the full "Genetic UI" vision** where every button spawns intelligent agents tailored to specific knowledge work scenarios.

**Key Achievements:**
1. ✅ 7 → 10 specialized agent actions
2. ✅ 5 → 14 action types (batch, create, extract)
3. ✅ Generic → Domain-specific prompts
4. ✅ Single-phase → Multi-phase pipelines
5. ✅ Simple → Batch operations
6. ✅ 3 buttons → 10 context-aware buttons

**Philosophy Realized:**
> "Every click is a conversation with intelligence. Every button adapts to content. Every action is explainable, reversible, and valuable."

**Next Steps:**
1. Enable Intelligence 2.0 in settings (opt-in)
2. Implement Phase 1 (Core Infrastructure)
3. Add Atomic Split action (highest ROI)
4. Gather user feedback
5. Iterate on prompt quality
6. Expand to full 10-action suite

---

**Document Version:** 1.0
**Created:** 2026-01-07
**Type:** Architecture Specification
**Status:** Ready for Implementation
**Estimated Effort:** 6-8 weeks (phased rollout)
**License:** MIT
