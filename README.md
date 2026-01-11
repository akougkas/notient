# Notient

> **Your Research Chief of Staff for Obsidian**
> *AI-powered vault intelligence using local LLMs only.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.4.0+-purple.svg)](https://obsidian.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

**Notient** (Note + Sentient) transforms your Obsidian notes from passive files into living entities with health, context, and agency—all powered by local LLMs. No cloud, no data leaving your machine, ever.

---

## Vision

**Notient = Note + Sentient — Sentient Notes for the thinking human.**

Imagine a research assistant who:
- Analyzes your vault with expert-level pattern recognition
- Proposes structured, actionable improvements grounded in your actual content
- Adapts to your domain expertise (HPC, law, biology, business—you name it)
- Never hallucinates, always cites sources
- Respects your autonomy through trust levels and universal undo
- Evolves with you as your knowledge grows
- Challenges your ideas with a devil's advocate when you need it

That's Notient. It's the **Research Chief of Staff** you didn't know you needed.

### The Process (Not Just a Tagline)

```
Vaults that breathe  →  Notes that think  →  Knowledge that evolves
     (awareness)           (intelligence)          (growth)
```

This is **sequential**, not parallel:
1. **Vault awareness** (holistic health, pulse, structure) **enables**
2. **Note intelligence** (individual agency, suggestions) which **produces**
3. **Knowledge evolution** (learning, connecting, growing over time)

### The Sentient Notes Philosophy

- **Every note has a pulse** — Health scores, freshness indicators, connectivity metrics
- **Every note has context** — PARA classification, related notes, semantic connections
- **Every note can speak** — Proactive suggestions surface when notes need attention
- **You steer; Notient amplifies** — Human-in-the-steering-wheel always

---

## The White House Model

Notient's multi-agent architecture follows a "White House" organizational model—a mental model for understanding how AI agents collaborate:

```
                    ┌─────────────────────────────┐
                    │    YOU (The President)      │
                    │  Decision maker. Commander. │
                    │    Approves all actions.    │
                    └─────────────┬───────────────┘
                                  │
                    ┌─────────────▼───────────────┐
                    │     CHIEF OF STAFF          │
                    │   (Central Orchestrator)    │
                    │                             │
                    │  • Routes tasks to agents   │
                    │  • Builds context briefings │
                    │  • Manages delegation       │
                    │  • Aggregates intelligence  │
                    └─────────────┬───────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
        ▼                         ▼                         ▼
┌───────────────┐       ┌─────────────────┐       ┌─────────────────┐
│    CHAT       │       │   NOTE EDITOR   │       │   CLASSIFIER    │
│   ADVISOR     │       │                 │       │                 │
│               │       │ Content         │       │ Knowledge       │
│ Senior Advisor│       │ Architect       │       │ Taxonomist      │
│ & Liaison     │       │                 │       │                 │
│               │       │ Structural      │       │ PARA method,    │
│ Your primary  │──────►│ improvements,   │       │ tagging,        │
│ interface     │       │ edits,          │       │ organization    │
│               │       │ frontmatter     │       │                 │
└───────────────┘       └─────────────────┘       └─────────────────┘
        │
        │ can delegate
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    WORKFLOW AGENTS (Intelligence 2.0)                │
│                                                                      │
│  /enhance     Transform quick captures → structured, polished notes │
│  /atomize     Split complex notes → atomic concepts (100-300 words) │
│  /synthesize  Cluster related notes → synthesis narratives          │
│  /tasks       Extract actions & deadlines → task notes              │
│  /brand       Check content against your voice → consistency audit  │
│  /connect     Find semantic relationships → 6 connection types      │
│  /challenge   Devil's advocate → surface blind spots, stress-test   │
│  /clipping    Process web dumps → clean, tagged vault notes         │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

**Why this model?**
- **Clear hierarchy**: You're always in command. Agents propose, you decide.
- **Specialization**: Each agent has distinct expertise, not generic capabilities.
- **Delegation**: Complex requests flow through appropriate specialists.
- **Coherent voice**: All agents share core identity but maintain unique missions.

---

## Core Features

### 🧠 13 Specialized Agents

| Agent | Role | What It Does |
|-------|------|--------------|
| **Chat Advisor** | Senior Advisor & Liaison | Your primary interface. Answers questions grounded in vault content. Delegates to specialists when needed. |
| **Note Editor** | Content Architect | Proposes structural improvements, frontmatter updates, content expansions. Output: actionable edit proposals. |
| **Classifier** | Knowledge Taxonomist | PARA classification, smart tagging, folder recommendations. Expert in organizational methodology. |
| **Link Finder** | Connection Specialist | Discovers non-obvious semantic relationships. Explains *why* notes connect (6 connection types). |
| **Context Builder** | Intelligence Analyst | Pre-flight agent. Searches vault, builds briefings for other agents. Never user-facing. |
| **Enhance** | Enhancement Specialist | `/enhance` — Transforms quick captures into polished, structured notes. |
| **Atomic** | Atomic Architect | `/atomize` — Splits complex notes into atomic concepts (100-300 words each). Literature review → 8 concept notes. |
| **Synthesis** | Synthesis Specialist | `/synthesize` — Clusters related notes into narrative syntheses (500-800 words). 15 meeting notes → strategy doc. |
| **Task** | Task Extractor | `/tasks` — Pulls action items and deadlines. "Follow up Tuesday" → Task note with `2026-01-15`. |
| **Brand** | Brand Auditor | `/brand` — Evaluates content against your voice. Ensures consistency across your vault. |
| **Connection** | Graph Engineer | `/connect` — Classifies connections into 6 semantic types: conceptual, methodological, problem-solution, hierarchical, temporal, contrast. |
| **Antagonist** | Devil's Advocate | `/challenge` — Challenges your ideas. Surfaces blind spots. Stress-tests arguments. |
| **Clipping** | Clipping Processor | `/clipping` — Transforms messy web clippings into structured vault notes. |

### 🔍 LLM-Reranked Search

Not your typical vector search:

1. **Vector search** → top-50 candidates (<100ms)
2. **LLM reranking** → semantic relevance scoring (~500ms)
3. **Results with reasoning** → "This note matches because it discusses X methodology"

**Three Presets:**
- **Quick** — 5 results, no reranking, 0.5 min score. For fast lookups.
- **Balanced** — 10 results, reranking enabled, 0.3 min score. Default.
- **Thorough** — 25 results, reranking enabled, 0.2 min score. Deep research.

### 🎯 Trust Levels & Universal Undo

AI proposes. You decide.

| Risk Level | Actions | Behavior |
|------------|---------|----------|
| **Low** | Add tags, update frontmatter | Auto-apply, log to history |
| **Medium** | Move notes, create links | Show confirmation, one-click approve |
| **High** | Merge notes, archive, delete | Warning dialog, require explicit confirm |

Every action is reversible. Full action history in Dashboard. Universal undo.

### 📊 Note Vitals Dashboard

Real-time intelligence for the active note:
- **Health score** — Connectivity, freshness, completeness (0-100%)
- **Link count** — Backlinks + outlinks with quick navigation
- **Staleness** — Days since last modified
- **PARA classification** — Project | Area | Resource | Archive with confidence
- **Tags** — From frontmatter, with suggestions
- **Quick Actions** — Enhance, Link, Move → Trigger agentic tasks

### 🤝 Local-Only Architecture

**Zero cloud dependencies. Your notes never leave your machine.**

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Reasoning** | LM Studio | OpenAI-compatible API. Chat, classification, reranking. |
| **Embeddings** | Ollama | Vector embeddings for semantic search. |
| **Vector Store** | WASM HNSW | High-performance approximate nearest neighbor. Scales to 100K+ notes. |
| **Storage** | Local | Everything in `.obsidian/plugins/notient/` |

Privacy-first. No telemetry. No cloud calls. Period.

---

## Agent Architecture

**Key clarification**: Agents are **capabilities**, not personas. They have expertise and specialization, not voice or personality. The Chief of Staff IS Notient—it orchestrates everything.

### Two-Tier System

**Tier 1: Core Identity (Shared)**
- Analytical, grounded, professional
- Always cites sources (`[[Note#Heading]]`)
- Domain-aware via user profile

**Tier 2: Specialization (Per Capability)**
- Each agent has distinct expertise area
- Output varies: conversational (Chat) vs structured (Editors)
- Chief of Staff routes to appropriate capability

**Result:** Unified intelligence layer with specialized capabilities.

### User Profile Adaptation

Notient learns your domain without cluttering the UI:

```json
{
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

**Impact:**
- Without profile: "Add more details"
- With HPC profile: "Add scalability analysis and MPI communication patterns"

---

## Philosophy

### Core Principles

1. **Local-only** — No cloud APIs. Ever. Ollama + LM Studio only.
2. **Human-in-steering-wheel** — Trust levels for autonomy, universal undo, you command agents.
3. **Grounded reasoning** — LLM responses cite actual notes. Zero hallucination tolerance.
4. **Theme-aware** — Respects your Obsidian theme. Clean, native UI.
5. **Simplicity over complexity** — Modular architecture, clean abstractions, no debug cruft.

### Agentic UI Philosophy

Notient pioneers a new paradigm:

| Traditional Software | Agentic Software |
|---------------------|------------------|
| Static buttons do fixed things | AI analyzes context |
| User navigates menus | Relevant actions surface automatically |
| One-size-fits-all | UI adapts to note state |

**v0.x:** Static Quick Actions + AI-generated suggestions (hybrid)
**Future:** Fully contextual interface where the UI itself is AI-driven

*Software that talks back.*

---

## Current Status

**Version**: 0.4.0-beta (in development)

| Component | Status |
|-----------|--------|
| Progressive Search | ✅ Working |
| Chat with Notes | ✅ Working |
| Quick Actions | ✅ Working (6 actions) |
| Note Vitals | ✅ Working |
| 13 Agent Capabilities | ✅ Implemented |
| WASM Vector Store | 🔄 Upgrading |
| Insights Stream | 🔧 Fixing |
| Error Boundaries | 🔄 Adding |

**Spec**: See `planning/BETA-SPEC.md` for full product specification.

---

## Quick Start

### Prerequisites

1. **Obsidian** 1.4.0+ installed
2. **Ollama** running locally (for embeddings)
   ```bash
   # Install: https://ollama.ai
   ollama pull nomic-embed-text
   ```
3. **LM Studio** running locally (for reasoning)
   ```bash
   # Install: https://lmstudio.ai
   # Load a model (Llama 3.1, Mistral, Phi-3)
   # Start server on port 1234
   ```

### Installation

```bash
git clone https://github.com/akougkas/notient.git
cd notient
bun install
bun run dev  # Build + copy to test vault
```

### First Run

1. Enable Notient in Settings > Community Plugins
2. **Setup Wizard** guides provider connections
3. Build initial index
4. Explore Note Vitals for your active note
5. Try Quick Actions: Enhance, Link, Move

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                              UI Layer                                │
│         Sidebar │ Dashboard │ TaskModal │ Setup Wizard               │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │ Events (EventBus)
┌─────────────────────────────────▼───────────────────────────────────┐
│                          Kernel                                      │
│                   Service Registry & Orchestration                   │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │
┌─────────────────────────────────▼───────────────────────────────────┐
│                        ChiefOfStaff                                  │
│              Central Orchestrator (White House Model)                │
│                                                                      │
│    Chat Agent │ NoteEditor │ Classifier │ LinkFinder │ ContextBuilder│
│                                                                      │
│                     Workflow Agents (Intelligence 2.0)               │
│         Enhance │ Atomic │ Synthesis │ Task │ Brand │ etc.          │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
┌───────▼───────┐       ┌─────────▼─────────┐       ┌───────▼───────┐
│   Agentic     │       │      Search       │       │      LLM      │
│   Services    │       │     Pipeline      │       │   Providers   │
│               │       │                   │       │               │
│ Trust Levels  │       │ Vector Search     │       │ LM Studio     │
│ Action Apply  │       │ LLM Reranking     │       │ Ollama        │
│ Action History│       │ Context Builder   │       │               │
└───────────────┘       └───────────────────┘       └───────────────┘
                                  │
┌─────────────────────────────────▼───────────────────────────────────┐
│                       Storage & Indexing                             │
│                                                                      │
│  Vector Store │ Index Manager │ Intelligence DB │ Action History     │
│                                                                      │
│  Hybrid embeddings: note-level + section-level for flexible retrieval│
└─────────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Chunking | Hybrid (note + section) | Broad matching + precise retrieval |
| Search | LLM reranking of vector top-50 | Semantic relevance, not just similarity |
| Context | Dynamic per-query | Fresh, relevant, not stale scans |
| Agent autonomy | Trust levels + batch review | Human control without friction |
| Agent concurrency | Sequential, one at a time | Predictable, debuggable |
| Activity retention | Session-only | Privacy, simplicity |
| LLM abstraction | Provider interface | Swappable backends |

---

## Comparisons

### vs. Smart Connections v4

| Feature | Notient | Smart Connections v4 |
|---------|---------|---------------------|
| Local-only | ✅ Required | ⚠️ Optional |
| LLM reranking | ✅ Core feature | ❌ |
| Vault context | ✅ Dynamic per-query | ❌ Static |
| Dual-panel UI | ✅ Search + Chat | ⚠️ Chat only |
| Agent trust levels | ✅ Low/Med/High | ❌ |
| PARA-aware | ✅ Built-in | ❌ |
| Specialized agents | ✅ 13 agents | ❌ |
| Modular architecture | ✅ Clean abstractions | ❌ |

### vs. Obsidian Copilot

| Feature | Notient | Copilot |
|---------|---------|---------|
| Local-first | ✅ Required | ❌ Cloud-first |
| Privacy | ✅ Zero cloud | ⚠️ Sends to OpenAI/Claude |
| Cost | ✅ Free (local compute) | ⚠️ Freemium (API costs) |
| Vault intelligence | ✅ PARA, health, vitals | ❌ |
| Agentic workflows | ✅ Trust levels, undo | ❌ |
| Specialized agents | ✅ 13 agents | ❌ |

---

## Contributing

We welcome contributions! Notient is open-source and community-driven.

**Areas for contribution:**
- Additional LLM provider implementations
- Performance optimizations
- UI/UX improvements
- Documentation and tutorials
- Testing coverage
- Community prompts and profiles

See `CONTRIBUTING.md` for guidelines.

---

## License

MIT License — Free to use, modify, distribute. Attribution appreciated.

---

## Acknowledgments

**Built with:** [Obsidian](https://obsidian.md) | [LM Studio](https://lmstudio.ai) | [Ollama](https://ollama.ai) | [Bun](https://bun.sh) | [esbuild](https://esbuild.github.io) | [Biome](https://biomejs.dev)

**Inspired by:** [PARA Method](https://fortelabs.com/blog/para/) | [Zettelkasten](https://zettelkasten.de) | [Building a Second Brain](https://www.buildingasecondbrain.com)

---

<p align="center">
  <strong>Notient</strong> — Your Research Chief of Staff<br>
  <em>Notes that think. Vaults that breathe. Knowledge that evolves.</em>
</p>

<p align="center">
  <sub>Built with ❤️ and local LLMs by researchers, for researchers.</sub>
</p>
