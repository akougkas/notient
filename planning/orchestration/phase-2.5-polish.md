# Phase 2.5: Progressive Search Polish

**Status**: Ready for implementation
**Blocked by**: Phase 2 incomplete - CSS missing, architecture gaps

---

## Critical Bugs (BLOCKER)

### 1. Missing Search CSS (Faye)
Sage found: Search components reference ~30 CSS classes that don't exist.

**Missing file**: `src/ui/styles/components/search-dropdown.css`

```css
/* Required classes */
.nv2-search-dropdown
.nv2-search-warning, .nv2-search-warning-icon
.nv2-search-empty, .nv2-search-empty-text, .nv2-search-empty-hint
.nv2-search-results
.nv2-search-result, .nv2-search-result--selected, .nv2-search-result--loading
.nv2-search-result-icon, .nv2-search-result-content
.nv2-search-result-title, .nv2-search-result-meta
.nv2-search-result-path, .nv2-search-result-dot, .nv2-search-result-time
.nv2-search-result-snippet, .nv2-search-result-score
.nv2-search-footer, .nv2-search-footer-hint
.nv2-search-deep-btn, .nv2-search-deep-btn--loading
.nv2-search-deep-icon, .nv2-search-deep-icon--spin
.nv2-search-deep-label
.nv2-deep-search-indicator, .nv2-deep-search-spinner
.nv2-deep-search-text, .nv2-deep-search-cancel
```

**Must include**:
- Shimmer animation (@keyframes nv2-shimmer)
- prefers-reduced-motion handling
- FLIP reorder transition support

### 2. Add to index.css imports (Faye)
```css
@import "./components/search-dropdown.css";
```

---

## Architecture Gaps

### 3. Omnibar doesn't use ProgressiveSearchOrchestrator (Archie/Faye)

**Current**: Omnibar implements progressive search inline
**Spec**: Should use `ProgressiveSearchOrchestrator` from kernel

**Options**:
- A) Wire Omnibar → orchestrator (clean, matches spec)
- B) Delete orchestrator, keep inline (less code, works)

**Decision needed from CEO.**

---

## Missing Spec Features

### 4. Tab → Focus "Go Deeper" button (Faye)
Spec §2.3 line 123. Currently just a comment, not implemented.

### 5. SearchSettings.progressive object (Archie)
Spec §4.3 lines 275-279. Settings missing:
```typescript
progressive: {
  enabled: boolean;      // Toggle progressive vs legacy
  showScores: boolean;   // Display AI relevance scores
  autoDeep: boolean;     // Auto-trigger for complex queries
}
```

### 6. itemRefs memory leak (Faye)
SearchDropdown.tsx `itemRefs.current` Map never cleared - stale refs accumulate.

---

## Lower Priority

### 7. Network error retry (Faye)
Spec §6 line 384: "Connection lost - retrying..." with spinner. Not implemented.

### 8. Screen reader phase announcements (Faye)
Spec §7 line 395: Announce phase transitions for a11y.

---

## Work Assignment

### Faye (P0 - BLOCKER)
1. Create `src/ui/styles/components/search-dropdown.css` (~150 lines)
2. Add import to `src/ui/styles/index.css`
3. Fix itemRefs memory leak
4. Implement Tab → focus "Go Deeper"

### Archie (P1)
5. Add SearchSettings.progressive to settings.ts
6. (Pending decision) Wire Omnibar → orchestrator OR delete orchestrator

### Faye (P2)
7. Network error retry UI
8. Screen reader announcements

---

## Verify
- `bun run typecheck` → pass
- `bun run build` → pass
- `bun run dev` → test in vaultex
- Search dropdown visually styled
- Shimmer animation works
- Reorder animation works
- "Go Deeper" focusable via Tab

---

## Files

**New**:
- src/ui/styles/components/search-dropdown.css

**Modified**:
- src/ui/styles/index.css (add import)
- src/ui/sidebar/components/search/SearchDropdown.tsx (itemRefs fix)
- src/ui/sidebar/components/Omnibar.tsx (Tab handling)
- src/types/settings.ts (progressive object)
