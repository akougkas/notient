# Faye - Phase 2.5: Search CSS Fix (BLOCKER)
status: ready
phase: p2.5
branch: ALPHA-SPEC-SPRINT

## context
Phase 2 search UI is UNSTYLED. You claimed ~300 lines CSS added but file doesn't exist.
Sage blocked on this. CEO not happy.

## do

### 1. Create search-dropdown.css (P0 BLOCKER)
- src/ui/styles/components/search-dropdown.css (NEW FILE)
- Must style ALL classes referenced in search/*.tsx:

```css
/* SearchDropdown container */
.nv2-search-dropdown { /* positioned below omnibar, max-height 400px */ }
.nv2-search-warning { /* AI unavailable banner */ }
.nv2-search-empty { /* "No results" state */ }
.nv2-search-results { /* results list */ }

/* SearchResultItem */
.nv2-search-result { /* result row */ }
.nv2-search-result--selected { /* keyboard selected */ }
.nv2-search-result--loading { /* shimmer animation */ }
.nv2-search-result-icon, -content, -title, -meta, -path, -dot, -time, -snippet, -score

/* SearchFooter */
.nv2-search-footer { /* "Go Deeper" row */ }
.nv2-search-deep-btn, --loading { /* button states */ }
.nv2-search-deep-icon, --spin { /* icon animation */ }

/* DeepSearchIndicator */
.nv2-deep-search-indicator, -spinner, -text, -cancel
```

- Include shimmer keyframes:
```css
@keyframes nv2-shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
```

- Include prefers-reduced-motion

### 2. Add import to index.css (P0)
- src/ui/styles/index.css
- Add: `@import "./components/search-dropdown.css";`

### 3. Fix itemRefs memory leak (P1)
- src/ui/sidebar/components/search/SearchDropdown.tsx
- Clear itemRefs.current when results change or component unmounts
- Add useEffect cleanup

### 4. Implement Tab → focus "Go Deeper" (P1)
- src/ui/sidebar/components/Omnibar.tsx
- When Tab pressed with dropdown open, focus the "Go Deeper" button
- Currently just a comment at line 481-485

## anti-patterns
- Don't add inline styles
- Don't skip reduced-motion handling
- Don't forget the shimmer animation

## verify
- `bun run typecheck` → pass
- `bun run build` → pass
- `bun run dev` → deploy to vaultex
- manual: search dropdown is styled
- manual: shimmer animation during evolving
- manual: Tab focuses "Go Deeper" button

## git
files: src/ui/styles/components/search-dropdown.css, src/ui/styles/index.css, src/ui/sidebar/components/search/SearchDropdown.tsx, src/ui/sidebar/components/Omnibar.tsx, planning/orchestration/faye/REPORT.md
msg: "fix(ui): Add missing search dropdown CSS and fix memory leak"
