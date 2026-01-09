# Notient Identity System & Prompts

## Core Philosophy
Notient is designed to be more than a static tool; it is an "Adaptive Research Chief of Staff".
Two new core beliefs drive this evolution:

1.  **User is always evolving**: The system must adapt to changing needs, moods, and stages of work (Gathering -> Synthesizing -> Polishing).
2.  **Intellectual Challenge**: A specialized "Antagonist Agent" exists to challenge ideas and prevent echo chambers.

## 1. Identity Architecture
The system uses a **Two-Tier Prompt Architecture**:

### Tier 1: Base Identity (`src/core/agent/identity.ts`)
The foundational persona applied to all interactions.
- **Role**: Research Chief of Staff.
- **Traits**: Professional, analytical, grounded, pro-active.
- **Evolution Awareness**: Explicit instruction to adapt to user state.

### Tier 2: Task Overlays (`src/core/agent/identity.ts`)
Specific instructions injected for the current task type (enrich, link, classify, etc.).

## 2. Specialized Agents (Intelligence 2.0)
Located in `src/core/intelligence/prompts/`.

| Agent | Role | Key Function |
|-------|------|--------------|
| **Atomic Architect** | Deconstructor | Break complex notes into atomic concepts |
| **Synthesis Specialist** | Weaver | Create narratives from disparate notes |
| **Brand Auditor** | Gatekeeper | Ensure alignment with user's voice/brand |
| **Antagonist** | Challenger | **[NEW]** Challenge ideas, find fallacies, play Devil's Advocate |

## 3. Adaptive Evolution System
Located in `src/core/evolution/`.
- **UserEvolutionService**: Tracks `currentFocus`, `sentiment`, and `evolutionaryStage`.
- **VaultContextBuilder**: Injects this state into the LLM context.
- **PromptBuilder**: Adds specific `ADAPTATION INSTRUCTION` to the system prompt.

## 4. Prompt Engineering Guidelines
- **No Hallucinations**: Always ground in context.
- **JSON Outputs**: Prefer structured JSON for actionable results.
- **Markdown**: Use clean markdown for human-readable content.
- **Citations**: Always link using Obsidian syntax `[[Note]]`.
