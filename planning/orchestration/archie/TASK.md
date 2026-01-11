# Archie - Phase 2.5: Settings + Architecture Decision
status: ready
phase: p2.5
branch: ALPHA-SPEC-SPRINT

## context
Phase 2 spec requires SearchSettings.progressive object. Also need decision on orchestrator usage.

## do

### 1. Add SearchSettings.progressive (P1)
- src/types/settings.ts
- Add to SearchSettings interface:
```typescript
interface SearchSettings {
  preset: SearchPreset;
  custom: { topK: number; enableReranking: boolean; minScore: number };

  // NEW: Progressive search settings
  progressive: {
    enabled: boolean;      // Default: true - toggle progressive vs legacy
    showScores: boolean;   // Default: false - display AI scores in results
    autoDeep: boolean;     // Default: false - auto-trigger deep for complex queries
  };
}
```

- Update DEFAULT_SETTINGS to include progressive defaults

### 2. Architecture decision (P2 - await CEO)
Current state: Omnibar implements progressive search inline, doesn't use ProgressiveSearchOrchestrator.

Options:
- A) Wire Omnibar → ProgressiveSearchOrchestrator (clean architecture)
- B) Delete ProgressiveSearchOrchestrator, keep inline (less code)

If CEO chooses A: Update Omnibar to use kernel.getService("progressiveSearch")
If CEO chooses B: Delete src/core/search/progressiveSearch.ts, remove from kernel

## anti-patterns
- Don't add progressive settings without defaults
- Don't change Omnibar behavior without CEO decision

## verify
- `bun run typecheck` → pass
- `bun run build` → pass

## git
files: src/types/settings.ts, planning/orchestration/archie/REPORT.md
msg: "feat(settings): Add SearchSettings.progressive configuration"
