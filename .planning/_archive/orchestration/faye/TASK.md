# Faye - Polish & Integration Testing
status: ready
phase: universe-completion
branch: faye/polish

## do

### Context Menu Polish (from previous session)
- src/main.ts: Review context menu implementation
  - Menu item labels: Are they clear and concise?
  - Icons: Do search, sparkles, brain feel right?
  - Add `menu.addSeparator()` before Notient items to group them visually
  - Check if items should be hidden when services not ready

### Integration Testing Checklist
After Archie and Sage complete their work, verify:
- [ ] Context menus still work (D9 relied on actionOrchestrator, now ChiefOfStaff)
- [ ] "Enhance this section" action routes through new ChiefOfStaff
- [ ] "Analyze note" triggers intelligence regeneration
- [ ] "Find related" opens sidebar with search query

### UI Consistency Review
- src/ui/sidebar/components/: Check for any hardcoded styles
- Ensure all Notient UI uses CSS variables (var(--text-accent), etc.)
- Check for any inline styles that should be in styles.css

### Optional: Prepare D8 Infrastructure
If time permits, research and document:
- How CM6 StateField will integrate with Preact signals
- Strict separation: CM6 owns editor state, Preact owns sidebar
- Ghost text widget implementation approach

## context
Interview decisions (2026-01-13):
- D8 is DEFERRED (infrastructure first)
- Agent Streams: keep current design
- Ghost text on explicit request (Tab), not automatic
- Strict separation: CM6 for editor, Preact for sidebar

This session Faye's role is lighter - polish and verify integration after Archie/Sage refactors.

## anti-patterns
- NO implementing D8 this session (deferred)
- NO redesigning Agent Streams (keep current)
- NO breaking existing functionality while polishing

## verify
- `bun run typecheck` → passes
- `bun run build` → passes
- Manual: Right-click in editor shows Notient menu items
- Manual: Right-click on file shows "Analyze note"

## git
files: src/main.ts, src/ui/sidebar/components/*.tsx (if any changes)
msg: "polish(d9): context menu UX refinements and integration verification"
