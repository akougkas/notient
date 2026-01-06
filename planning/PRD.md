  # Notient - Product Requirements Document

  > **Vision:** "Notient replaces Smart Connections as #1 Obsidian AI plugin"

  ## Executive Summary

  Notient is a free, open-source Obsidian community plugin that provides AI-powered vault management using local LLMs only. It combines lightning-fast semantic search with intelligent note processing, health monitoring, and an agentic UI that can perform vault operations with user confirmation.

  **Core Differentiators vs Smart Connections:**
  1. **Speed** - Hybrid cache architecture: instant results + async deep processing
  2. **UI/UX** - Beautiful Vault Vitals dashboard + context-aware sidebar
  3. **Intelligence** - Full agentic capabilities, not just search
  4. **Privacy** - Local-only, period. Zero cloud. Zero data leaves machine.

  ---

  ## Target User

  - Obsidian power users with large vaults (500+ notes)
  - Privacy-conscious knowledge workers
  - Users following PARA method or similar organizational systems
  - People who want AI assistance without cloud dependencies

  ---

  ## Core Principles

  1. **Local-only** - Ollama + LM Studio only. No cloud APIs. Ever.
  2. **Human-in-control** - Suggest by default, confirm before any vault modifications
  3. **Theme-aware** - Respects user's Obsidian theme and aesthetic
  4. **Incremental shipping** - Release early, iterate based on real usage

  ---

  ## Technical Architecture

  ### Stack
  - **Language:** TypeScript (strict mode)
  - **Build:** Bun + esbuild
  - **LLM (Reasoning):** LM Studio (OpenAI-compatible API)
  - **LLM (Embeddings):** Ollama (local or remote on LAN)
  - **Vector Store:** Custom brute-force cosine similarity (pure JS, zero dependencies)
  - **UI Framework:** Obsidian API + native components

  ### Data Storage
  .obsidian/plugins/notient/
  ├── data.json           # Plugin settings
  ├── index-{modelKey}.json   # Vector embeddings (per model)
  ├── state-{modelKey}.json   # Index state (per model)
  ├── cache/              # Search result cache
  └── locks/              # Multi-window safety

  ### Embedding Strategy
  - **Model:** User chooses during setup wizard
  - **Updates:** Debounced (batch every N minutes, configurable)
  - **Architecture:** Fast local cache for instant queries + async deep processing for refinement

  ---

  ## User Experience

  ### Primary Interaction: Hybrid Sidebar + Dashboard

  **Sidebar (always available):**
  - Context-aware content based on note type:
    - **Inbox notes:** Suggested classification, tags, destination folder
    - **Knowledge notes:** Related notes, missing links, health score
    - **Project notes:** Connected resources, action items, timeline
    - **Archive notes:** Potential duplicates, merge candidates

  **Dashboard (dedicated view):**
  - Vault Vitals - the hero feature
  - Full-screen knowledge visualization
  - Batch operations interface
  - Settings and configuration

  ### Vault Vitals Dashboard

  Key metrics displayed:
  1. **Note Freshness** - Last modified, last processed, decay warnings
  2. **Connectivity** - Orphan notes, hub notes, cluster visualization
  3. **Coverage Gaps** - Topics you write about vs topics with thin coverage
  4. **Processing Status** - Inbox size, queue length, pending suggestions

  ### Onboarding

  **Guided Setup Wizard:**
  1. **AI Services Configuration**
     - Separate Local/Network toggle per service (Ollama, LM Studio)
     - Default IPs: localhost or 192.168.86.249 (configurable)
     - Model auto-detection from connected services
     - Embedding model dimension displayed (768d, 1024d, etc.)
  2. **Indexing Configuration**
     - Chunk size slider (32-8192 chars) with performance tooltip
     - Excluded folders list
     - Vault statistics preview (note count, est. time)
  3. **Multi-Index Awareness**
     - Shows existing indexes if returning user
     - Model change creates new index (old preserved)
  4. **Start Indexing** - Background process begins

  ### Smart Connections Migration

  One-click migration wizard:
  - Detect existing Smart Connections installation
  - Offer to import embeddings (if compatible) or re-index
  - Preserve user's workflow continuity

  ---

  ## Features

  ### Phase 1: Core (MVP)
  - [x] Setup wizard with LLM detection (Ollama + LM Studio)
    - [x] Separate Local/Network toggles per service
    - [x] Model auto-detection and dimension display
    - [x] Chunk size slider (32-8192 chars)
    - [x] Vault statistics display
  - [x] Simple vector store with brute-force cosine similarity
  - [x] Multi-index architecture (index per model, preserve on switch)
  - [x] Semantic search (sidebar command)
  - [x] Related notes panel
  - [x] Basic Vault Vitals (note count, inbox size, orphan count)
  - [x] PARA-aware note type detection
  - [ ] **NEEDS FIX:** Pipeline integration after wizard completion

  ### Phase 2: Intelligence
  - [ ] Multi-pass note processing (classify → enrich → link)
  - [ ] Suggested tags and links
  - [ ] Context-aware sidebar
  - [ ] Batch processing queue
  - [ ] Full Vault Vitals dashboard

  ### Phase 3: Agentic
  - [ ] AI agent with confirmation dialogs
  - [ ] Automated suggestions (human approves)
  - [ ] Full vault operations (move, merge, archive) with confirmation
  - [ ] Processing rules and automations

  ### Phase 4: Polish
  - [ ] Smart Connections migration wizard
  - [ ] Advanced visualizations (knowledge graph, timeline)
  - [ ] Performance optimization
  - [ ] Multi-modal support (images, PDFs) - architecture ready

  ---

  ## Agent Capabilities

  The AI agent can perform full vault operations WITH user confirmation:

  | Action | Requires Confirmation |
  |--------|----------------------|
  | Add/modify tags | Yes |
  | Add frontmatter | Yes |
  | Create links | Yes |
  | Move notes | Yes |
  | Merge notes | Yes |
  | Archive notes | Yes |
  | Delete notes | Yes (extra warning) |

  **Philosophy:** AI suggests, human confirms. No autonomous operations without explicit approval.

  ---

  ## Note Type System (PARA)

  Out-of-the-box support for PARA method:

  | Type | Detection | Sidebar Behavior |
  |------|-----------|------------------|
  | **Inbox** (0-inbox/) | Path-based | Classification suggestions |
  | **Projects** (1-projects/) | Path + active markers | Resources, timeline |
  | **Areas** (2-areas/, 3-areas/) | Path-based | Related knowledge |
  | **Resources** (2-knowledge/) | Path-based | Related notes, links |
  | **Archive** (4-archive/) | Path-based | Duplicate detection |

  ---

  ## Performance Targets

  | Metric | Target |
  |--------|--------|
  | Search latency (cached) | < 100ms |
  | Search latency (uncached) | < 500ms |
  | Indexing speed | 100 notes/second |
  | Memory footprint | < 200MB |
  | Startup time | < 2 seconds |

  ---

  ## Success Metrics

  1. **Community:** 1,000 GitHub stars within 6 months
  2. **Adoption:** 10,000 downloads from Obsidian community plugins
  3. **Ranking:** Top 10 in Obsidian plugin directory (AI category)
  4. **Engagement:** Active GitHub Discussions community

  ---

  ## Non-Goals (Explicitly Out of Scope)

  - Cloud API support (OpenAI, Claude, etc.) - LOCAL ONLY
  - CLI companion tool - plugin handles everything
  - Mobile support (Obsidian mobile) - desktop first
  - Real-time collaboration features
  - Sync across devices (vault sync is Obsidian's job)

  ---

  ## Community & Support

  - **Primary:** GitHub Discussions
  - **Issues:** GitHub Issues for bugs/features
  - **License:** MIT (100% free and open source)

  ---

  ## Timeline

  Ship incrementally as features become ready:
  - Week 1-2: Project setup, core architecture, basic sidebar
  - Week 3-4: Vector store integration (Orama), semantic search
  - Week 5-6: Vault Vitals dashboard MVP
  - Week 7-8: Context-aware sidebar, PARA detection
  - Ongoing: Agent capabilities, polish, community feedback

  ---

  ## Competitive Analysis

  | Feature | Notient | Smart Connections | Copilot |
  |---------|---------|-------------------|---------|
  | Local-only | ✅ Required | ✅ Optional | ⚠️ Cloud-first |
  | Vault health metrics | ✅ Core feature | ❌ | ❌ |
  | Agentic operations | ✅ With confirmation | ❌ | ⚠️ Limited |
  | PARA-aware | ✅ Built-in | ❌ | ❌ |
  | Migration wizard | ✅ From SC | N/A | ❌ |
  | Price | Free | Free | Freemium |
  | Speed focus | ✅ Hybrid cache | ⚠️ Standard | ⚠️ Standard |

  ---

  ## Open Questions

  1. Exact embedding models to recommend for different hardware tiers?
  2. ~~LanceDB vs alternatives~~ → Custom brute-force cosine similarity (pure JS, zero dependencies)
  3. Obsidian API limitations for vault operations?
  4. Hot reload during development - best Bun workflow?

  ---

  *Last updated: 2026-01-06*
  *Author: Anthony Kougkas*