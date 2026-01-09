# Notient

> **Your Research Chief of Staff for Obsidian**
> *AI-powered vault intelligence using local LLMs only.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.4.0+-purple.svg)](https://obsidian.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

**Notient** (Note + Sentient) transforms your Obsidian notes from passive files into living entities with health, context, and agency—all powered by local LLMs. No cloud, no data leaving your machine, ever.

---

## Table of Contents

- [Vision](#vision)
- [Core Features](#core-features)
- [Philosophy](#philosophy)
- [Current Status](#current-status)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Identity System](#identity-system)
- [Development](#development)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Vision

**Notient = Note + Sentient — Sentient Notes for the thinking human.**

Imagine a research assistant who:
- Analyzes your vault with expert-level pattern recognition
- Proposes structured, actionable improvements grounded in your actual content
- Adapts to your domain expertise (HPC, law, biology, business—you name it)
- Never hallucinates, always cites sources
- Respects your autonomy through trust levels and universal undo
- User is always evolving so Notient must be able to adapt to your changing needs
- Create a antagonist agent that can challenge your ideas and provide counterpoints

That's Notient. It's the **Research Chief of Staff** you didn't know you needed.

### The Sentient Notes Philosophy

- **Every note has a pulse** - Health scores, freshness indicators, connectivity metrics
- **Every note has context** - PARA classification, related notes, semantic connections
- **Every note can speak** - Proactive suggestions surface when notes need attention
- **You steer; Notient amplifies** - Human-in-the-steering-wheel always

---

## Core Features

### 🧠 Intelligence 2.0: 7 Specialized Agents

Notient doesn't just chat—it orchestrates **7 specialized AI agents** for knowledge work:

| Agent | Purpose | Example |
|-------|---------|---------|
| **Atomic Architect** | Split complex notes into atomic concepts (100-300 words) | Literature review → 8 standalone concept notes |
| **Synthesis Specialist** | Cluster related notes into synthesis narratives (500-800 words) | 15 meeting notes → "Q3 Product Strategy" synthesis |
| **Clipping Processor** | Transform messy web clippings into structured vault notes | Browser clipper dump → Clean, tagged resource note |
| **Task & Decision Extractor** | Pull action items and deadlines from meeting notes | "Follow up next Tuesday" → Task note with `2026-01-15` |
| **Brand Auditor** | Evaluate content against your brand voice | Check if research note matches academic tone |
| **Knowledge Graph Engineer** | Classify connections into 6 semantic types (conceptual, methodological, problem-solution...) | Suggest links with reasoning: "These share a methodology" |
| **Enhancement Specialist** | Enrich informal notes with structure and depth | Quick jot → Polished, well-organized note |

### 🔍 LLM-Reranked Search

Not your typical vector search:
1. **Vector search** → top-50 candidates (<100ms)
2. **LLM reranking** → semantic relevance scoring (~500ms)
3. **Results with reasoning** → "This note matches because it discusses X methodology"

**Modes:** Quick (fast) | Balanced (default) | Thorough (comprehensive)

### 🎯 Agentic Workflows with Trust Levels

AI proposes. You decide.

- **Low-risk actions** (add tags, update frontmatter) → Auto-apply, log to history
- **Medium-risk** (move notes, create links) → One-click confirmation
- **High-risk** (merge notes, delete) → Explicit approval required

Every action is reversible. Universal undo. Full action history in Dashboard.

### 📊 Note Vitals Dashboard

Real-time intelligence for the active note:
- **Health score** (connectivity, freshness, completeness)
- **Link count** (backlinks + outlinks)
- **Staleness** (days since last modified)
- **PARA classification** (Project | Area | Resource | Archive)
- **Quick Actions** (Enhance, Link, Move) → Trigger agentic tasks
- **Intelligence suggestions** (tags, links, triage actions)

### 🤝 Local-Only Architecture

**Zero cloud dependencies.**
- **Reasoning:** LM Studio (OpenAI-compatible API)
- **Embeddings:** Ollama
- **Vector Store:** Custom brute-force cosine similarity (pure JS, zero deps)
- **Data:** Everything stays in `.obsidian/plugins/notient/`

Privacy-first. Your notes never leave your machine.

---

## Philosophy

### Core Principles

1. **Local-only** - No cloud APIs. Ever. Ollama + LM Studio only.
2. **Human-in-steering-wheel** - Trust levels for autonomy, universal undo, user commands agents.
3. **Grounded reasoning** - LLM responses cite actual notes. No hallucination tolerance.
4. **Theme-aware** - Respects your Obsidian theme. Clean, native UI.
5. **Simplicity over complexity** - Modular architecture, clean abstractions, no debug cruft.

### Design Philosophy: Agentic UI

Notient pioneers the **Agentic UI** paradigm:
- Traditional software: Static buttons do fixed things
- Agentic software: AI analyzes context → surfaces relevant actions → adapts UI dynamically

**v0.1:** Static Quick Actions + AI-generated suggestions (hybrid approach)
**Future:** Fully contextual interface where the UI itself is AI-driven

This is the future of software: *Software that talks back.*

---

## Current Status

### ✅ Phase 1-3 Complete (Jan 2026)

**What's Built:**
- ✅ Kernel & service orchestration
- ✅ LLM abstraction layer (swappable providers: <50 lines to add new LLM)
- ✅ Agent loop with streaming, task queue, action generation
- ✅ Trust level manager + action applier + undo system
- ✅ Workflow runner (bulk operations: `/enrich folder`, `/classify vault`)
- ✅ Search pipeline (vector + LLM reranking, 3 presets)
- ✅ Chat sessions with sliding window (last 10 messages)
- ✅ TieredSemanticChunker (3-tier embeddings: note/section/block)
- ✅ NoteIntelligenceService (summaries, entities, tags, health)
- ✅ All 7 specialized Intelligence prompts implemented
- ✅ UI: Sidebar (Note Vitals + Agent Streams), Dashboard, TaskModal, Setup Wizard

**What's Designed but Not Implemented:**
- ⏳ **Identity System** (see `docs/IDENTITY_AND_PROMPTS.md`)
  - Research Chief of Staff persona
  - User profile management (domain expertise, PARA config)
  - Two-tier prompt architecture (base + specialized overlays)
  - Profile inference from vault embeddings

### 🚀 Next: Identity System Implementation

**Current Sprint:** Implement the complete identity system for v0.1 launch.

See `docs/IDENTITY_AND_PROMPTS.md` for full specification.

---

## Quick Start

### Prerequisites

1. **Obsidian** 1.4.0+ installed
2. **Ollama** running locally (for embeddings)
   ```bash
   # Install Ollama: https://ollama.ai
   ollama pull nomic-embed-text  # Or your preferred embedding model
   ```
3. **LM Studio** running locally (for reasoning)
   ```bash
   # Install LM Studio: https://lmstudio.ai
   # Load a model (e.g., Llama 3.1, Mistral, Phi-3)
   # Start server on port 1234 (default)
   ```

### Installation (Development)

```bash
# Clone the repository
git clone https://github.com/akougkas/notient.git
cd notient

# Install dependencies (using Bun)
bun install

# Build and copy to test vault
bun run dev

# Or watch mode (auto-rebuild on changes)
bun run dev:watch
```

**Test Vault:** Set in `.claude/CLAUDE.md` (default: `/mnt/c/Users/akougk/Projects/vaultex`)

### First Run

1. Open Obsidian
2. Enable Notient in Settings > Community Plugins
3. **Setup Wizard** appears:
   - Connect to Ollama (test connection)
   - Select embedding model
   - Connect to LM Studio (test connection)
   - Select reasoning model
   - Build initial index (shows progress)
4. **Sidebar opens** showing Note Vitals for active note
5. Try omnibar search: "notes about X"
6. Try Quick Actions: "Enhance", "Link", "Move"

---

## Architecture

### High-Level Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         UI Layer                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ Sidebar  │  │Dashboard │  │TaskModal │  │  Wizard  │    │
│  │(60KB)    │  │(31KB)    │  │(23KB)    │  │(27KB)    │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
└────────────────────────┬────────────────────────────────────┘
                         │ Events (EventBus)
┌────────────────────────┴────────────────────────────────────┐
│                     Kernel (Orchestration)                   │
│                   16 Services Registered                     │
└────────────────────────┬────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
┌───────▼──────┐  ┌──────▼──────┐  ┌─────▼──────┐
│  Agent Core  │  │ Intelligence │  │  Agentic   │
│              │  │   Layer      │  │  Services  │
│ • AgentLoop  │  │ • 7 Prompts  │  │ • Trust    │
│ • TaskQueue  │  │ • Pipeline   │  │ • Action   │
│ • Prompts    │  │ • Inference  │  │   Applier  │
└──────┬───────┘  └──────┬───────┘  └─────┬──────┘
       │                 │                 │
┌──────▼─────────────────▼─────────────────▼──────┐
│              LLM Abstraction Layer                │
│  ┌──────────────┐       ┌──────────────┐        │
│  │ LMStudioProv │       │ OllamaProv   │        │
│  │(Reasoning)   │       │(Embeddings)  │        │
│  └──────────────┘       └──────────────┘        │
└───────────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────┐
│              Storage & Indexing                 │
│  • SimpleVectorStore (25KB, brute-force cosine) │
│  • IndexManager (state tracking per model)      │
│  • TieredSemanticChunker (3-tier)               │
│  • IntelligenceDb (note metadata)               │
│  • ActionHistory (undo stack)                   │
└──────────────────────────────────────────────────┘
```

### Key Components

| Component | Purpose | File |
|-----------|---------|------|
| **Kernel** | Service registry & dependency injection | `core/kernel.ts` |
| **Agent Loop** | 5-phase execution: load note → search → stream LLM → generate actions → complete | `core/agent/agentLoop.ts` |
| **LLMProvider** | Abstraction for swappable LLM backends | `core/llm/provider.ts` |
| **TrustLevelManager** | Risk evaluation (low/medium/high) for actions | `core/agentic/trustLevelManager.ts` |
| **ActionApplier** | Execute validated actions with undo tracking | `core/agentic/actionApplier.ts` |
| **WorkflowRunner** | Bulk operations with progress & review queue | `core/agentic/workflowRunner.ts` |
| **SearchPipeline** | Vector search → LLM reranking | `core/search/pipeline.ts` |
| **NoteIntelligence** | Background analysis: summaries, entities, health | `core/intelligence/noteIntelligence.ts` |

### Data Files

Stored in `.obsidian/plugins/notient/`:

```
data.json                      # Plugin settings
idx_*_{modelKey}_Xd.json       # Vector index (new format)
state-{modelKey}.json          # Index state per model
intelligence-{modelKey}.json   # Note intelligence metadata
conversations.json             # Chat history
action-history.json            # Applied actions (for undo)
profile.json                   # User profile (domain expertise) - NEW
cache/                         # Search result cache
locks/                         # Multi-window safety
```

---

## Identity System

### The Research Chief of Staff Persona

Notient is not a generic chatbot. It's your **Research Chief of Staff**:
- **Analytical** - Data-driven, evidence-based reasoning
- **Grounded** - Never invents, always cites sources (`[[Note#Heading]]`)
- **Professional** - Formal but accessible tone
- **Proactive** - Surfaces insights without being asked
- **Transparent** - Shows reasoning, not just conclusions
- **Domain-Aware** - Adapts to your field via user profile

### User Profile System (v0.1)

**Purpose:** Let Notient adapt its expertise to your domain without cluttering the UI.

**Profile Schema (Minimal):**
```json
{
  "version": "1.0",
  "domain": {
    "primary": "High-Performance Computing",
    "secondary": ["AI/ML", "Distributed Systems"],
    "keywords": ["NSF grants", "supercomputing", "MPI"]
  },
  "para": {
    "projects": ["10 Projects/"],
    "areas": ["20 Areas/"],
    "resources": ["30 Resources/"],
    "archives": ["40 Archives/"]
  }
}
```

**How It Works:**
1. **Generate:** Settings > Identity > "Generate from Vault" (uses embeddings-based clustering)
2. **Edit:** Manually refine inferred profile
3. **Silent Usage:** Profile influences LLM prompts invisibly—no badges, no UI chrome
4. **Result:** Smarter suggestions, domain-appropriate terminology, relevant tag recommendations

**Example Impact:**
- **Without profile:** Generic suggestion: "Add more details"
- **With HPC profile:** Specific suggestion: "Add scalability analysis and MPI communication patterns"

### Two-Tier Prompt Architecture

Notient uses a compositional prompt system:

**Tier 1: Base Identity**
- Core Research Chief of Staff persona
- PARA methodology
- User domain expertise (if profile loaded)
- Grounding rules ("never hallucinate")

**Tier 2: Specialized Overlays**
- Task-specific instructions (enrich, link, classify, analyze)
- Agent-specific roles (Atomic Architect, Synthesis Specialist, etc.)

**Benefits:**
- ✅ Consistent voice across all interactions
- ✅ DRY (Don't Repeat Yourself) for shared context
- ✅ Easy to maintain and version
- ✅ Clear separation: identity vs. task logic

See full specification: `docs/IDENTITY_AND_PROMPTS.md`

---

## Development

### Tech Stack

- **Language:** TypeScript (strict mode)
- **Runtime:** Bun (v1.0+)
- **Build:** esbuild (see `scripts/build.ts`)
- **Lint:** Biome
- **LLM (Reasoning):** LM Studio (OpenAI-compatible)
- **LLM (Embeddings):** Ollama
- **Vector Store:** Custom brute-force cosine similarity (zero dependencies)
- **UI:** Obsidian API + native components

### Commands

```bash
# Development
bun run dev              # Build + copy to test vault
bun run dev:watch        # Watch mode with auto-copy
bun run dev:reset        # Soft reset (clear settings, keep index)
bun run dev:hard-reset   # Hard reset (wipe everything)

# Production
bun run build            # Typecheck + production build (minified)
bun run build:dev        # Development build (with sourcemaps)
bun run build:analyze    # Bundle analysis

# Quality
bun run typecheck        # TypeScript check
bun run lint             # Biome lint
bun run lint:fix         # Auto-fix lint issues
bun run format           # Format code
```

### Project Structure

```
notient/
├── src/
│   ├── main.ts                # Plugin entry point
│   ├── settings.ts            # Settings tab UI
│   ├── styles.css             # Design system (nv2-* classes)
│   ├── core/
│   │   ├── kernel.ts          # Service orchestration
│   │   ├── events/            # Typed event bus
│   │   ├── llm/               # LLM abstraction (provider interface)
│   │   ├── agent/             # Agent loop, prompts, task queue
│   │   ├── chat/              # Chat sessions, streaming
│   │   ├── agentic/           # Trust levels, action applier, workflows
│   │   ├── intelligence/      # 7 specialized prompts, pipeline
│   │   ├── search/            # Search pipeline (vector + rerank)
│   │   ├── indexer/           # Batch indexing, chunking
│   │   ├── context/           # Vault context builder
│   │   ├── para/              # PARA classification
│   │   └── vitals/            # Vault health metrics
│   ├── services/              # Storage services (vector, index, health)
│   ├── views/                 # UI components (sidebar, dashboard, modal, wizard)
│   ├── adapters/              # Obsidian API facade
│   └── types/                 # TypeScript types
├── docs/
│   ├── IDENTITY_AND_PROMPTS.md  # Identity system spec (NEW)
│   ├── NOTE_JOURNEY_FLOWCHART.md
│   └── flowcharts/              # UI action flows
├── planning/
│   ├── PRD.md                   # Product requirements
│   ├── bootstrap.md             # Architecture master plan
│   └── coding_tasks/            # Implementation notes
├── scripts/
│   └── build.ts                 # esbuild configuration
├── .claude/
│   └── CLAUDE.md                # Project context for Claude
├── manifest.json                # Obsidian plugin manifest
├── package.json
├── tsconfig.json
└── biome.json
```

### Build Health

| Check | Status | Notes |
|-------|--------|-------|
| TypeScript | ✅ PASS | `bun run typecheck` |
| ESBuild | ✅ PASS | 290KB minified, ~1.9MB dev |
| Biome Lint | ⚠️ WARN | Complexity warnings (expected) |

**Known Warnings:**
- `agentLoop.ts:77` - `executeStreaming()` complexity 44 (inherent to 5-phase pipeline)
- `agentLoop.ts:298` - `parseActionPlan()` complexity 24 (JSON parsing edge cases)
- `noteIntelligence.ts` - `any` type in JSON parsing (acceptable for LLM responses)

### Contributing

We welcome contributions! Notient is open-source and community-driven.

**Areas for contribution:**
- [ ] Additional LLM provider implementations (Anthropic Claude local, OpenAI-compatible variants)
- [ ] Performance optimizations (vector search, indexing)
- [ ] UI/UX improvements (design system, accessibility)
- [ ] Documentation (tutorials, examples, use cases)
- [ ] Testing (unit tests, integration tests, E2E)
- [ ] Community prompts (domain-specific profiles, specialized agents)

**Contribution Guidelines:**
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

**Code Standards:**
- TypeScript strict mode (no `any` without justification)
- Biome for linting and formatting
- Meaningful variable names (no abbreviations like `ctx`, `cfg`)
- Comments for complex logic only (code should be self-documenting)
- Follow existing architecture patterns (Kernel services, two-tier prompts)

---

## Roadmap

### v0.1 - Identity System (Current Sprint)

**Goal:** Ship complete identity system with user profiles and refined prompts.

- [ ] Implement `ProfileManager` (load, save, infer from vault)
- [ ] Create two-tier prompt architecture (base + overlays)
- [ ] Refactor all 7 Intelligence prompts to be profile-aware
- [ ] Add Settings > Identity UI (generate, edit, manual fields)
- [ ] Add Command Palette: "Generate Profile from Vault"
- [ ] Embeddings-based domain inference (cluster vault → detect themes)
- [ ] Silent profile usage (no badges, works in background)
- [ ] Measure baseline action acceptance rate

**Target:** Ship in 2-3 weeks (Jan 2026)

### v0.2 - Enhanced Autonomy (Q1 2026)

- [ ] Setup Wizard integration for profile generation
- [ ] Profile badge in UI (optional toggle)
- [ ] Contextual Quick Actions (dynamic based on note state)
- [ ] Conversation persistence across sessions
- [ ] Advanced search filters (by PARA type, date range, health score)
- [ ] Batch review UI improvements (bulk approve/reject)

### v0.3 - Learning & Adaptation (Q2 2026)

- [ ] Learning from user feedback (track rejected suggestions by domain)
- [ ] Profile refinement suggestions ("Your vault has grown—regenerate profile?")
- [ ] Multi-profile support (Research mode, Teaching mode, Grant writing mode)
- [ ] Workspace-aware profiles (different profile per Obsidian workspace)
- [ ] A/B test prompt variants (measure impact on acceptance rate)

### v1.0 - Community & Ecosystem (Q3 2026)

- [ ] Prompt marketplace (community-contributed prompts and profiles)
- [ ] "Install Academic Researcher Profile" one-click
- [ ] Prompt versioning and migration system
- [ ] Plugin API for third-party extensions
- [ ] Mobile support (Obsidian mobile)
- [ ] Real-time collaboration features (shared vault intelligence)

### Future Vision: Agentic UI 2.0

- [ ] Fully contextual interface (UI generated by AI based on note state)
- [ ] Proactive note organization (vault auto-cleans based on learned patterns)
- [ ] Multi-agent orchestration (agents collaborate on complex tasks)
- [ ] "Software talks back" paradigm fully realized

---

## Why Notient?

### vs. Smart Connections v4

| Feature | Notient | Smart Connections v4 |
|---------|---------|----------------------|
| **Local-only** | ✅ Required | ⚠️ Optional |
| **LLM reranking** | ✅ Core feature | ❌ |
| **Vault context** | ✅ Dynamic per-query | ❌ Static |
| **Agentic actions** | ✅ Trust levels + undo | ❌ |
| **PARA-aware** | ✅ Built-in | ❌ |
| **Identity system** | ✅ User profiles | ❌ |
| **Specialized agents** | ✅ 7 agents | ❌ |
| **UI** | ✅ Dual-panel (search + chat) | ⚠️ Chat only |
| **Architecture** | ✅ Modular, clean abstractions | ❌ |

### vs. Obsidian Copilot

| Feature | Notient | Copilot |
|---------|---------|---------|
| **Local-first** | ✅ | ❌ (Cloud-first) |
| **Privacy** | ✅ Zero cloud | ⚠️ Sends to OpenAI/Claude |
| **Cost** | ✅ Free (local compute) | ⚠️ Freemium (API costs) |
| **Vault intelligence** | ✅ PARA, health, vitals | ❌ |
| **Agentic workflows** | ✅ Trust levels, undo | ❌ |
| **Specialized agents** | ✅ 7 agents | ❌ |

**Notient's Unique Value:**
1. **Privacy-first** - Your research stays yours
2. **Research Chief of Staff persona** - Not just a chatbot
3. **Agentic UI** - Software that talks back
4. **Domain adaptation** - Learns your field
5. **Trust levels** - You're always in control
6. **Open-source** - Community-driven, transparent

---

## License

MIT License - see [LICENSE](LICENSE) file for details.

**TL;DR:** Free to use, modify, distribute. Attribution appreciated.

---

## Acknowledgments

Built with:
- [Obsidian](https://obsidian.md) - The extensible knowledge base
- [LM Studio](https://lmstudio.ai) - Local LLM inference
- [Ollama](https://ollama.ai) - Local embeddings
- [Bun](https://bun.sh) - Fast JavaScript runtime
- [esbuild](https://esbuild.github.io) - Blazing fast bundler
- [Biome](https://biomejs.dev) - Fast linter and formatter

Inspired by:
- [PARA Method](https://fortelabs.com/blog/para/) - Tiago Forte
- [Zettelkasten](https://zettelkasten.de) - Niklas Luhmann
- [Building a Second Brain](https://www.buildingasecondbrain.com) - Tiago Forte

---

## Contact

- **Author:** Anthony Kougkas
- **GitHub:** [@akougkas](https://github.com/akougkas)
- **Website:** [akougkas.io](https://akougkas.io)
- **Discussions:** [GitHub Discussions](https://github.com/akougkas/notient/discussions)
- **Issues:** [GitHub Issues](https://github.com/akougkas/notient/issues)

---

<p align="center">
  <strong>Notient</strong> — Your Research Chief of Staff<br>
  <em>Notes that think. Vaults that breathe. Knowledge that evolves.</em>
</p>

<p align="center">
  <sub>Built with ❤️ and local LLMs by researchers, for researchers.</sub>
</p>
