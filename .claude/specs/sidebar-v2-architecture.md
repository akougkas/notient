# Notient Sidebar v2.0 - Architecture Specification

> Three-view tabbed sidebar with locked chrome and dynamic content

**Version**: 2.0.0
**Status**: Approved Design
**Date**: 2026-01-09

---

## Executive Summary

The Notient sidebar follows a **three-view tabbed architecture** with **locked chrome** (header/footer) and **locked layouts** per view. Content within each view is dynamic and adaptive, but the structure never changes.

### Core Principles

1. **Locked Layout, Dynamic Content** - Structure is fixed, only content changes
2. **No Layout Tricks** - No expanding/collapsing, no "fill available space" hacks
3. **Dedicated Space Per Concern** - Each view optimized for its purpose
4. **Sentient Note Philosophy** - Note Vitals view gives notes a breathing, living embodiment
5. **Predictable UX** - User always knows where to look for what

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  HEADER (locked)                                                │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Notient                    [📝 Note] [🤖 Agents] [💬 Chat] │ │
│  └───────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  CONTENT (view-specific, locked structure per view)             │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  FOOTER (locked - persistent status bar)                        │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ [Providers]      │      [Index]       │     [Agents]      │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## Header Component

### Structure (Locked)

```
┌─────────────────────────────────────────────────────────────────┐
│  Notient                           [📝 Note] [🤖 Agents] [💬 Chat]│
│  v0.2.0-alpha                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Behavior

- **Title**: "Notient" with version subtitle
- **Tabs**: Three view switchers (Note Vitals, Agent Streams, Chat)
- **Active Tab**: Highlighted state, others muted
- **Tab Badges**: Optional notification dots (e.g., pending reviews on Agents)

### Component Props

```typescript
interface HeaderProps {
  activeView: "note" | "agents" | "chat";
  onViewChange: (view: "note" | "agents" | "chat") => void;
  agentsPendingCount?: number;  // Badge on Agents tab
}
```

---

## Footer Component

### Structure (Locked - Three Zones)

```
┌─────────────────────┬─────────────────────┬─────────────────────┐
│ PROVIDERS           │ INDEX               │ AGENTS              │
├─────────────────────┼─────────────────────┼─────────────────────┤
│ LM● Ollama●         │ 1,247 notes         │ 2 running           │
│ Qwen 2.5 32B        │ ● Synced 2m ago     │ 3 pending review    │
│                     │ ███████░░░ 72%      │ [View →]            │
└─────────────────────┴─────────────────────┴─────────────────────┘
```

### Zone 1: Providers

| Element | Description |
|---------|-------------|
| Connection dots | Green = connected, Red = disconnected, Yellow = connecting |
| LM Studio model | Active reasoning model name |
| Ollama model | Active embedding model name |
| Click action | Opens Settings → AI Services |

```typescript
interface ProviderStatus {
  lmstudio: {
    connected: boolean;
    model: string | null;
  };
  ollama: {
    connected: boolean;
    model: string | null;
  };
}
```

### Zone 2: Index

| Element | Description |
|---------|-------------|
| Note count | Total indexed notes |
| Sync status | "Synced Xm ago" or "Syncing..." |
| Progress bar | Only visible during indexing/reindexing |
| Click action | Opens Index Management panel |

```typescript
interface IndexStatus {
  noteCount: number;
  lastSyncedAt: Date | null;
  isIndexing: boolean;
  indexingProgress?: number;  // 0-100
  indexingAction?: "sync" | "rebuild" | "trim";
}
```

### Zone 3: Agents

| Element | Description |
|---------|-------------|
| Running count | Number of active agents |
| Pending review | Actions awaiting user approval |
| Quick link | "[View →]" switches to Agents tab |
| Click action | Switches to Agents view |

```typescript
interface AgentStatus {
  runningCount: number;
  queuedCount: number;
  pendingReviewCount: number;
}
```

---

## View 1: Note Vitals ("The Sentient Note")

### Philosophy

The Note Vitals view treats each note as a **living entity** with:
- **Identity** - Who is this note?
- **Vitals** - How healthy is this note?
- **Actions** - What can be done for this note?
- **Insights** - What does AI observe about this note?

### Layout (Locked - 4 Sections)

```
┌─────────────────────────────────────────────────────────────────┐
│  SECTION 1: NOTE IDENTITY                                       │
│  ─────────────────────────────────────────────────────────────  │
│  "Research: Neural Network Architectures"                       │
│  📁 Projects/AI Research  •  🏷️ deep-learning, ml, research     │
│  📄 Research Note  •  🗂️ PARA: Projects                         │
├─────────────────────────────────────────────────────────────────┤
│  SECTION 2: VITALS                                              │
│  ─────────────────────────────────────────────────────────────  │
│    ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐              │
│    │   ❤️   │  │   🔗   │  │   📅   │  │   📊   │              │
│    │  85%   │  │   12   │  │   3d   │  │   A    │              │
│    │ Health │  │ Links  │  │ Fresh  │  │ Grade  │              │
│    └────────┘  └────────┘  └────────┘  └────────┘              │
│  Health: Good structure, missing summary                        │
├─────────────────────────────────────────────────────────────────┤
│  SECTION 3: QUICK ACTIONS                                       │
│  ─────────────────────────────────────────────────────────────  │
│  [🔍 Find Connections]  [✨ Enrich Note]  [🔗 Link Ideas]        │
│  [📝 Summarize]  [🏷️ Suggest Tags]  [📋 Extract Tasks]          │
├─────────────────────────────────────────────────────────────────┤
│  SECTION 4: AI INSIGHTS                                         │
│  ─────────────────────────────────────────────────────────────  │
│  ● High Priority                                                │
│    This note has 3 potential connections...                     │
│    [Apply Links] [Dismiss]                                      │
│                                                                 │
│  ○ Suggestion                                                   │
│    Consider adding a summary...                                 │
│    [Generate Summary]                                           │
└─────────────────────────────────────────────────────────────────┘
```

### Section 1: Note Identity

```typescript
interface NoteIdentity {
  title: string;
  path: string;
  folder: string;
  tags: string[];
  noteType: "research" | "journal" | "project" | "meeting" | "reference" | "inbox" | "unknown";
  paraType: "projects" | "areas" | "resources" | "archive" | "inbox" | "unknown";
}
```

### Section 2: Vitals (4 Metric Cards)

| Metric | Icon | Value | Description |
|--------|------|-------|-------------|
| Health | ❤️ | 0-100% | Completeness score (frontmatter, structure, links) |
| Links | 🔗 | Number | Backlinks + Outlinks count |
| Fresh | 📅 | Duration | Time since last modified |
| Grade | 📊 | A-F | Overall quality grade |

```typescript
interface NoteVitals {
  health: {
    score: number;  // 0-100
    issues: string[];  // "missing summary", "no tags", etc.
  };
  links: {
    backlinks: number;
    outlinks: number;
    total: number;
  };
  freshness: {
    lastModified: Date;
    age: string;  // "3d", "2w", "1mo"
  };
  grade: "A" | "B" | "C" | "D" | "F";
}
```

### Section 3: Quick Actions

Smart-filtered to show 4-6 most relevant actions based on note state.

```typescript
interface QuickAction {
  id: string;
  label: string;
  icon: string;
  prompt: string;  // Sent to agent when clicked
  relevanceScore?: number;  // For smart filtering
}

const QUICK_ACTIONS: QuickAction[] = [
  { id: "find-connections", label: "Find Connections", icon: "🔍", prompt: "Find notes related to..." },
  { id: "enrich", label: "Enrich Note", icon: "✨", prompt: "Enrich this note with..." },
  { id: "link-ideas", label: "Link Ideas", icon: "🔗", prompt: "Suggest links for..." },
  { id: "summarize", label: "Summarize", icon: "📝", prompt: "Summarize this note..." },
  { id: "suggest-tags", label: "Suggest Tags", icon: "🏷️", prompt: "Suggest tags for..." },
  { id: "extract-tasks", label: "Extract Tasks", icon: "📋", prompt: "Extract tasks from..." },
];
```

### Section 4: AI Insights

Rolling stream of AI-generated observations and suggestions.

```typescript
interface Insight {
  id: string;
  priority: "high" | "medium" | "low";
  text: string;
  actions?: InsightAction[];
  source: "analysis" | "agent" | "system";
  timestamp: Date;
}

interface InsightAction {
  label: string;
  type: "apply" | "dismiss" | "preview" | "undo";
  handler: () => void;
}
```

---

## View 2: Agent Streams

### Layout (Locked - 3 Sections)

```
┌─────────────────────────────────────────────────────────────────┐
│  SECTION 1: ACTIVE AGENTS                                       │
│  ─────────────────────────────────────────────────────────────  │
│  🔄 Enriching "Project Alpha.md"                                │
│     Started 45s ago • Progress: ███████░░░ 70%                  │
│     [Pause] [Stop]                                              │
│                                                                 │
│  ⏳ Queued: "Research Notes.md" (waiting)                       │
│     [Cancel] [Move Up]                                          │
├─────────────────────────────────────────────────────────────────┤
│  SECTION 2: PENDING REVIEW                                      │
│  ─────────────────────────────────────────────────────────────  │
│  ⚠️ Add 5 tags to "Meeting Notes"                               │
│     Proposed: #meeting, #project-x, #q1-2024...                 │
│     [Preview] [Apply] [Dismiss]                                 │
│                                                                 │
│  ⚠️ Create synthesis note from 4 sources                        │
│     [Preview] [Apply] [Dismiss]                                 │
├─────────────────────────────────────────────────────────────────┤
│  SECTION 3: RECENT ACTIVITY                                     │
│  ─────────────────────────────────────────────────────────────  │
│  ✓ Enhanced "Daily Journal" • 2m ago                            │
│    Added: 3 tags, backlinks section                             │
│    [Undo]                                                       │
│                                                                 │
│  ✗ Failed: "Corrupt File.md" • 10m ago                          │
│    Error: Could not parse frontmatter                           │
│    [Retry] [Ignore]                                             │
└─────────────────────────────────────────────────────────────────┘
```

### Section 1: Active Agents

```typescript
interface ActiveAgent {
  id: string;
  type: "enrich" | "link" | "atomic" | "synthesis" | "task" | "classify";
  targetNote: string;
  status: "running" | "paused" | "queued";
  progress?: number;  // 0-100
  startedAt?: Date;
  controls: ("pause" | "resume" | "stop" | "cancel" | "move-up")[];
}
```

### Section 2: Pending Review

```typescript
interface PendingAction {
  id: string;
  actionType: string;
  targetNote: string;
  summary: string;
  details?: string;
  riskLevel: "low" | "medium" | "high";
  controls: ("preview" | "apply" | "dismiss")[];
}
```

### Section 3: Recent Activity

```typescript
interface RecentActivity {
  id: string;
  status: "success" | "failed" | "undone";
  actionType: string;
  targetNote: string;
  summary: string;
  completedAt: Date;
  canUndo: boolean;
  error?: string;
}
```

---

## View 3: Chat with Notient

### Layout (Locked - 3 Sections)

```
┌─────────────────────────────────────────────────────────────────┐
│  SECTION 1: CONTEXT BAR                                         │
│  ─────────────────────────────────────────────────────────────  │
│  Chatting about: "Research: Neural Networks"                    │
│  [Change Note] [Clear Context]                                  │
├─────────────────────────────────────────────────────────────────┤
│  SECTION 2: MESSAGE STREAM (scrollable)                         │
│  ─────────────────────────────────────────────────────────────  │
│  🤖 Notient                                                     │
│  I've analyzed your note...                                     │
│                                                                 │
│  📝 You                                                         │
│  What other notes should I link this to?                        │
│                                                                 │
│  🤖 Notient                                                     │
│  Based on semantic similarity, I recommend:                     │
│  • [[Machine Learning Basics]] (0.89)                           │
│  [Add These Links]                                              │
├─────────────────────────────────────────────────────────────────┤
│  SECTION 3: INPUT                                               │
│  ─────────────────────────────────────────────────────────────  │
│  [Ask Notient about this note...                         ] [Send]│
└─────────────────────────────────────────────────────────────────┘
```

### Data Types

```typescript
interface ChatContext {
  notePath: string | null;
  noteTitle: string | null;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  citations?: string[];  // Note paths
  actions?: ChatAction[];
}

interface ChatAction {
  label: string;
  type: "apply-links" | "apply-tags" | "create-note" | "open-note";
  payload: unknown;
}
```

---

## State Management

### Global State (Shared Across Views)

```typescript
interface SidebarState {
  // View state
  activeView: "note" | "agents" | "chat";

  // Footer state (always visible)
  providers: ProviderStatus;
  index: IndexStatus;
  agents: AgentStatus;

  // Services initialized
  isReady: boolean;
}
```

### Per-View State

```typescript
// Note Vitals view
interface NoteViewState {
  currentNote: NoteIdentity | null;
  vitals: NoteVitals | null;
  insights: Insight[];
  isLoading: boolean;
}

// Agent Streams view
interface AgentViewState {
  activeAgents: ActiveAgent[];
  pendingReview: PendingAction[];
  recentActivity: RecentActivity[];
}

// Chat view
interface ChatViewState {
  context: ChatContext;
  messages: ChatMessage[];
  isStreaming: boolean;
}
```

---

## Event Subscriptions

### Footer Events

| Event | Source | Action |
|-------|--------|--------|
| `services:initialized` | Kernel | Update `isReady` |
| `health:lmstudio` | HealthMonitor | Update provider status |
| `health:ollama` | HealthMonitor | Update provider status |
| `index:progress` | Indexer | Update progress bar |
| `index:complete` | Indexer | Update note count, hide progress |
| `workflow:started` | WorkflowRunner | Increment running count |
| `workflow:complete` | WorkflowRunner | Decrement running, add to recent |
| `action:proposed` | ActionPipeline | Increment pending review |

### Note Vitals Events

| Event | Source | Action |
|-------|--------|--------|
| `active-leaf-change` | Obsidian Workspace | Load new note vitals |
| `file:modified` | Obsidian Vault | Refresh vitals if current note |
| `intelligence:updated` | NoteIntelligence | Update insights |

### Agent Streams Events

| Event | Source | Action |
|-------|--------|--------|
| `workflow:progress` | WorkflowRunner | Update agent progress |
| `workflow:complete` | WorkflowRunner | Move to recent activity |
| `action:proposed` | ActionPipeline | Add to pending review |
| `action:applied` | ActionApplier | Remove from pending, add to recent |
| `action:dismissed` | ActionApplier | Remove from pending |
| `action:undone` | ActionHistory | Update recent activity |

---

## Component Hierarchy

```
SidebarView (ItemView wrapper)
└── App (Preact root)
    ├── Header
    │   └── TabBar
    ├── Content
    │   ├── NoteVitalsView (when activeView === "note")
    │   │   ├── NoteIdentity
    │   │   ├── VitalsCards
    │   │   ├── QuickActions
    │   │   └── InsightStream
    │   ├── AgentStreamsView (when activeView === "agents")
    │   │   ├── ActiveAgents
    │   │   ├── PendingReview
    │   │   └── RecentActivity
    │   └── ChatView (when activeView === "chat")
    │       ├── ContextBar
    │       ├── MessageStream
    │       └── ChatInput
    └── Footer
        ├── ProviderStatus
        ├── IndexStatus
        └── AgentStatus
```

---

## CSS Structure

```
src/ui/styles/
├── index.css                 # Entry point
├── tokens.css                # Design tokens
├── base.css                  # Reset, layout
└── components/
    ├── header.css            # Header + TabBar
    ├── footer.css            # Footer + 3 zones
    ├── note-identity.css     # Note identity section
    ├── vitals-cards.css      # 4 metric cards
    ├── quick-actions.css     # Action buttons grid
    ├── insight-stream.css    # Insight items
    ├── active-agents.css     # Running/queued agents
    ├── pending-review.css    # Pending actions
    ├── recent-activity.css   # Activity log
    ├── chat-context.css      # Chat context bar
    ├── chat-messages.css     # Message bubbles
    └── chat-input.css        # Input field
```

---

## Implementation Phases

### Phase 1: Fix Critical Bugs
1. Add `services:initialized` event subscription to App.tsx
2. Fix service key mismatch in noteIntelligence.ts
3. Fix async/await on sync method in profileManager.ts

### Phase 2: Lock Header & Footer
1. Create Header component with TabBar
2. Create Footer component with 3 status zones
3. Wire up event subscriptions for status updates

### Phase 3: Note Vitals View
1. Create NoteIdentity component
2. Create VitalsCards component (4 metrics)
3. Restore QuickActions with full action set
4. Enhance InsightStream with priorities

### Phase 4: Agent Streams View
1. Create ActiveAgents component
2. Create PendingReview component
3. Create RecentActivity component
4. Wire up workflow/action events

### Phase 5: Chat View Integration
1. Create ContextBar component
2. Integrate existing Chat UI
3. Connect to ChatSession/ConversationStore

---

## Success Criteria

- [ ] Header tabs switch views without page reload
- [ ] Footer shows live status for all three zones
- [ ] Note Vitals displays all 4 metric cards
- [ ] Quick Actions send tasks to agent queue
- [ ] AI Insights stream shows real-time updates
- [ ] Agent Streams shows running/queued agents
- [ ] Pending Review allows apply/dismiss actions
- [ ] Recent Activity shows undo capability
- [ ] Chat maintains context with current note
- [ ] All views have consistent locked layout
