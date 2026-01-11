# Faye - Phase 2: Progressive Search UI
status: ready
phase: p2-s1
branch: ALPHA-SPEC-SPRINT

## context
Phase 2 transforms search into progressive enhancement UX.
Dropdown appears below Omnibar with results that shimmer during AI evaluation, then animate reorder.
DEEP search via button/Shift+Enter → toast notification → results to Insights Stream.

Spec: `planning/orchestration/phase-2-progressive-search.md`
Current Omnibar: `src/ui/sidebar/components/Omnibar.tsx` (has command dropdown, no search dropdown)

## do

### 1. Create search dropdown components (P0)
- src/ui/sidebar/components/search/ (NEW FOLDER)

- SearchDropdown.tsx:
  ```typescript
  interface SearchDropdownProps {
    isOpen: boolean;
    results: SearchResultItem[];
    phase: "idle" | "instant" | "evolving" | "deep";
    selectedIndex: number;
    onSelect: (result: SearchResultItem) => void;
    onDeepSearch: () => void;
    aiUnavailable?: boolean;
  }
  ```
  - Container with max-height 400px, overflow-y auto
  - Maps results to SearchResultItem components
  - Shows SearchFooter at bottom
  - Shows warning if aiUnavailable
  - role="listbox", aria-activedescendant for a11y

- SearchResultItem.tsx:
  ```typescript
  interface SearchResultItemProps {
    result: SearchResultItem;
    isSelected: boolean;
    isLoading: boolean;  // shimmer state
    onClick: () => void;
  }
  ```
  - Displays: icon, title, path, lastModified, score (if evolving)
  - Shimmer effect via CSS class `nv2-search-result--loading`
  - role="option", aria-selected

- SearchFooter.tsx:
  - "Go Deeper" button with search icon
  - Keyboard hint: "Shift+Enter"
  - Tab focus support

- DeepSearchIndicator.tsx:
  - Inline progress shown in Omnibar during deep search
  - Text: "Deep searching..."
  - Cancel X button

### 2. Add CSS animations (P0)
- styles.css (add to existing file, search section)

- Shimmer animation:
  ```css
  .nv2-search-result--loading::after {
    content: "";
    position: absolute;
    top: 0; left: -100%;
    width: 100%; height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
    animation: nv2-shimmer 1.5s infinite;
  }
  @keyframes nv2-shimmer { 100% { left: 100%; } }
  ```

- Respect reduced motion:
  ```css
  @media (prefers-reduced-motion: reduce) {
    .nv2-search-result--loading::after { animation: none; }
  }
  ```

- Dropdown styles:
  ```css
  .nv2-search-dropdown {
    position: absolute;
    top: 100%; left: 0; right: 0;
    max-height: 400px;
    overflow-y: auto;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 0 0 8px 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 100;
  }
  ```

### 3. Wire Omnibar to progressive search (P0)
- src/ui/sidebar/components/Omnibar.tsx
  - Add state for search dropdown:
    ```typescript
    const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
    const [searchPhase, setSearchPhase] = useState<"idle" | "instant" | "evolving" | "deep">("idle");
    const [showSearchDropdown, setShowSearchDropdown] = useState(false);
    const [deepSearchId, setDeepSearchId] = useState<string | null>(null);
    ```
  - On input change (after 300ms debounce, min 2 chars):
    - Get progressiveSearch from kernel
    - Iterate over search() generator
    - Update results + phase on each yield
    - Show dropdown when results arrive
  - On ESC: clear query, close dropdown
  - On click outside: close dropdown
  - On Enter: navigate to first result (if results exist)
  - On Shift+Enter: trigger deep search
  - On Tab: focus "Go Deeper" button

### 4. Add FLIP reorder animation (P1)
- src/ui/sidebar/components/search/SearchDropdown.tsx
  - When results change during "evolving" phase:
    - Record positions before update
    - Let DOM update
    - Calculate deltas, apply inverse transform
    - Animate to final position (300ms ease-out)
  - Use useLayoutEffect for FLIP technique

### 5. Wire deep search to Insights Stream (P1)
- src/ui/sidebar/App.tsx
  - Subscribe to "search:deep-complete" event
  - Convert deep search results to Insight format:
    ```typescript
    {
      text: `Deep search found "${query}": ${result.title}`,
      priority: "medium",
      linkPath: result.path,
      linkText: result.title,
    }
    ```
  - Add to insights array (mixed chronologically)

- Toast notifications:
  - On deep search start: "Deep search queued - results will appear in Insights"
  - On complete: "Deep search found X results" with [View] button

### 6. Keyboard navigation (P0)
- Arrow Up/Down: navigate results
- Enter: open selected result
- Shift+Enter: trigger deep search
- Tab: focus "Go Deeper" button
- ESC: dismiss dropdown, clear search

## anti-patterns
- Don't replace existing command dropdown - search dropdown is separate
- Don't show search dropdown when typing "/" (command mode)
- Don't block UI during EVOLVING - shimmer shows progress
- Don't show stale results - clear on new query
- Don't add inline styles - use CSS classes

## verify
- `bun run typecheck` → pass
- `bun run build` → pass
- manual: type query → dropdown appears with results
- manual: results shimmer during AI evaluation
- manual: results animate reorder when scores arrive
- manual: click result → opens note, sidebar stays
- manual: Shift+Enter → triggers deep search
- manual: ESC → dismisses dropdown
- manual: deep complete → toast appears
- manual: deep results → appear in Insights Stream

## git
files: src/ui/sidebar/components/search/*.tsx, src/ui/sidebar/components/Omnibar.tsx, src/ui/sidebar/App.tsx, styles.css, planning/orchestration/faye/REPORT.md
msg: "feat(ui): Add progressive search dropdown with shimmer and reorder animations"
