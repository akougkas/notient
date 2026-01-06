# Notient UI/UX Design Revamp - CSS & Layout Focus

## Context
Obsidian plugin with three main surfaces that need cohesive, polished design:
1. **Setup Wizard** - Modal for first-time configuration
2. **Settings Page** - Plugin settings tab
3. **Sidebar** - Main interaction surface (search + related notes)

## Design Requirements

### General Aesthetic
- Match Obsidian's native feel (respect CSS variables)
- Support both light and dark themes seamlessly
- Compact but not cramped - information density matters
- Clear visual hierarchy - users should know what to do next

### Setup Wizard
Current layout has:
- Header with title
- Two service cards side-by-side (Ollama, LM Studio)
- Each card: Local/Network toggle, host:port inputs, model dropdown
- Chunk size slider with tooltip
- Vault stats + excluded folders
- Action buttons

Design needs:
- Better card styling - make connected/error states visually distinct
- Improve button toggle styling (Local/Network)
- Make the slider thumb more visible/draggable
- Better error message styling (not just red text)
- Clear visual flow top-to-bottom
- Action button should feel "ready" vs "disabled"

### Settings Page  
Current: Standard Obsidian settings with custom sections
Design needs:
- Consistent spacing between sections
- Clear section headers
- Toggle buttons should match wizard style
- Slider should match wizard style
- Warning/info notices should be styled consistently
- Index management section needs visual distinction (danger zone vs info)

### Sidebar
Three states:
1. **Search mode** - Input at top, results below
2. **Related notes mode** - Shows notes related to current file
3. **Loading/unavailable states**

Design needs:
- Clean search input with clear affordances
- Result cards that show: note title, match preview, similarity score
- Compact but readable result list
- Empty states that guide user action
- Loading spinners that don't jump around
- Status indicators (connected, indexing progress, etc.)

### CSS Variables to Use
```css
--background-primary, --background-secondary
--text-normal, --text-muted, --text-faint, --text-accent
--interactive-accent, --interactive-accent-hover
--color-red, --color-green, --color-yellow
--radius-s, --radius-m, --radius-l
--font-ui-small, --font-ui-medium, --font-smallest
```

### Key Interactions
- Hover states on all clickable elements
- Focus states for keyboard navigation
- Smooth transitions (not jarring)
- Responsive within Obsidian's layout constraints

## Files to Edit
- `src/styles.css` - All plugin styles
- `src/views/setupWizard.ts` - Wizard DOM structure (if needed for layout)
- `src/settings.ts` - Settings DOM structure (if needed for layout)
- `src/views/sidebar.ts` - Sidebar DOM structure (if needed for layout)

## Success Criteria
1. Wizard feels polished and guides user through setup
2. Settings page is scannable and organized
3. Sidebar is the "main event" - beautiful search experience
4. All three surfaces feel like they belong to same plugin
5. Works in both light and dark Obsidian themes
