# Legacy Reference Material

Pre-v1.0 source trees and planning documents, archived 2026-04-25 when Notient was reset for the June 1 launch.

## Contents

| Path | What it is |
|------|------------|
| `v0.1-galaxy-source/` | The "Phase Galaxy" rewrite (~40 TS files). Compiled cleanly but the pipeline was broken at runtime: `kernel.ts` never instantiated `LLMProvider`, so `enhancePipeline.ts:178` always failed and the UI rendered hardcoded mock suggestions. Useful only as a reference for what NOT to do with DI wiring. |
| `v0.3-helios-source/` | The pre-Galaxy implementation (~159 TS files). Contains the full 4-agent swarm, action engine with diff-based undo, chat service, multi-strategy search, skills registry, atomic-write utilities, and 8 domain prompts. ~90% sound code but laden with 4 months of architectural drift. v1.0 reimplements ideas from here, not the code itself. |
| `PHASE-UNIVERSE.md`, `PHASE-HELIOS.md`, `PHASE-GALAXY.md`, `PHASE-GALAXY-DEBUG.md` | The four iteration phases that preceded v1.0. Each represented a complete philosophical reset. Read for historical context, not for design guidance. |
| `STATE-2026-01-16-galaxy.md` | Final state of Phase Galaxy. Claimed "ready for testing" but never user-tested — the Enhance pipeline was broken at runtime as noted above. |
| `PROJECT-galaxy.md`, `ISSUES-galaxy.md`, `ROADMAP-deferred-features-2026-01.md` | Phase Galaxy meta-docs. |

## Why this is archived, not deleted

Four months of design exploration matters. The `_archive/` subdirectories under `.planning/` (preserved in place) capture the intellectual arc — original CEO/PRD/BETA-SPEC docs, consulting reports from external models, skills design files, and the eight-prompt workflow library. The current spec at `docs/superpowers/specs/2026-04-25-notient-v1-design.md` builds on insights distilled from this material. The code itself is reference, not source.

## Rules

- **Do not import from `_legacy/`.** v1.0 is a clean rebuild. If you find yourself wanting to copy code, copy the *idea* and re-derive the implementation against the v1.0 architecture.
- **Do not edit files here.** Treat as immutable history.
- **Do read it** when designing a v1.0 feature that has a v0.x precedent. Atomic writes, the thinking parser, the action-history diff model, the skills registry pattern — all worth understanding before redoing.
