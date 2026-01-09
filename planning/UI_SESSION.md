# Notient UI Redesign Session

You are implementing UI for **Notient** — an Obsidian plugin giving notes intelligence via local AI. This is v0.3.0 alpha.

**Your job:** Write production `.tsx` and `.css` code. Not mockups. Interview the user for preferences when unclear.

---

## Core Principles

1. **ZERO EMOJI** — Use Obsidian's Lucide icons or CSS-only indicators
2. **OBSIDIAN-NATIVE** — Must feel like part of Obsidian, not a foreign app
3. **LESS IS MORE** — Maximum impact with minimum code complexity
4. **CONSISTENT BRAND** — Same visual language across all 12 surfaces

---

## Spec

Read `VISUALS.md` for design intent per surface. Adapt specs to follow the principles above (ignore any emoji references in that doc).

## Tech Stack

- **Preact** + `@preact/signals`
- **Plain CSS** with `.nv2-*` prefix
- **Obsidian's Lucide icons** via `setIcon(el, "icon-name")` or CSS
- **320-400px** sidebar constraint
- **CSS variables only** — dark/light theme support

## Colors

```css
/* Semantic status */
--nv2-healthy: #4CAF50;
--nv2-attention: #FF9800;
--nv2-unhealthy: #E57373;

/* Always inherit Obsidian base */
var(--background-primary)
var(--background-secondary)
var(--text-normal)
var(--text-muted)
var(--interactive-accent)
```

## File Locations

```
src/ui/sidebar/components/*.tsx
src/ui/styles/components/*.css
src/ui/modals/*.ts
src/ui/settings/*.ts
```

---

## Phases

| Phase | Surfaces | VISUALS.md Prompts |
|-------|----------|-------------------|
| **1** | Sidebar Shell, Note Vitals, Agent Streams, Chat | 1, 2, 3, 4 |
| **2** | Empty/Loading States, Micro-interactions | 11, 12 |
| **3** | Setup Wizard, Settings Panel | 5, 7 |
| **4** | Task Modal, Index Options, Profile, Search Results | 6, 8, 9, 10 |

---

## Handoffs Between Phases

**Phase 1 establishes:** Shell layout, card patterns, status indicators, chat bubbles
**Phase 2 adds:** Skeleton loaders, empty states, button/input behaviors
**Phase 3 uses:** Patterns from 1+2 for wizard steps and settings sections
**Phase 4 uses:** All patterns for modal variations

---

## Output Format

```
// ComponentName.tsx
[code]

// component-name.css
[code]

// Wire: [one line]
```

---

## Start

Tell me which phase or surface. I'll read VISUALS.md, adapt to principles, and ask clarifying questions before coding.
