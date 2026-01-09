# VISUALS.md — Notient UI Design Prompts

> **Purpose:** Comprehensive prompts for a designer AI to create consistent mockups across all UI surfaces of the Notient Obsidian plugin.

---

## DESIGN SYSTEM FOUNDATION

### Brand Identity: Notient

**Tagline:** "Your vault, alive."

**Core Concept:** Notient transforms static notes into living entities with vital signs, health metrics, and intelligent behaviors. The UI embodies the concept of a **"Sentient Note"** — where each note has a life force that can be monitored, nurtured, and enhanced through local AI.

### Visual Philosophy: TECHNO-NATURAL

A design language that bridges the organic and the digital:

| Principle | Expression |
|-----------|------------|
| **Breathing** | Subtle pulse animations on healthy elements, like a heartbeat |
| **Growth** | Progress indicators feel like organic expansion, not mechanical filling |
| **Vitality** | Status colors evoke biological states (healthy green, attention amber, critical red) |
| **Intelligence** | AI elements have a soft glow, suggesting neural activity without harsh tech aesthetics |
| **Roots** | Strong connection to Obsidian's existing design language — we're an extension, not a replacement |

### Color Philosophy

```
HEALTHY     → Forest Green (#4CAF50 family) — Life, thriving
ATTENTION   → Amber (#FF9800 family) — Caution, needs care
UNHEALTHY   → Soft Red (#E57373 family) — Urgent, needs healing
NEUTRAL     → Obsidian's theme grays — Foundation, stability
ACCENT      → Electric Blue (#42A5F5 family) — AI activity, intelligence
```

**Critical:** All colors MUST use Obsidian CSS variables (`var(--text-*)`, `var(--background-*)`, `var(--interactive-*)`) as the base, with our semantic overlays for states.

### Typography

- **Primary:** Obsidian's theme font (respect user's choice)
- **Monospace:** Code elements, metrics, technical data
- **Hierarchy:** Clear size steps (h1 → body → caption)
- **Weight:** Semantic — bold for emphasis, not decoration

### Iconography

- **Style:** Minimalist emoji-based for universal compatibility
- **Vitals Icons:** ❤️ Health, 🔗 Links, 📅 Freshness, 📊 Grade
- **Action Icons:** 🔍 Find, ✨ Enrich, 📝 Summary, 🏷️ Tags
- **Status Dots:** ● (filled), ◐ (half), ○ (empty)

### Animation Principles

- **Duration:** 200-300ms for micro-interactions, 500ms for state changes
- **Easing:** `ease-out` for exits, `ease-in-out` for transforms
- **Purpose:** Every animation serves feedback or orientation — never decorative
- **Breathing:** Slow 2-4s pulse cycles for "alive" elements

---

## GLOBAL DESIGN CONSTRAINTS

Apply these to ALL prompts:

1. **Obsidian Integration:** Must feel native to Obsidian. Use its modal system, button styles, scrollbars, and form elements as foundation.

2. **Sidebar Width:** 320-400px fixed width. All layouts must work within this constraint.

3. **Dark/Light:** Design for both themes. Rely on CSS variables, never hardcoded colors.

4. **Density:** Information-dense but not cluttered. Use whitespace strategically.

5. **Accessibility:** All interactive elements need clear focus states. Minimum touch targets 32x32px.

6. **Local-First Aesthetic:** No cloud icons, sync spinners, or external service imagery. Everything suggests local, private, on-device processing.

---

## PROMPT 1: SIDEBAR SHELL — The Container

**Surface:** Main sidebar view wrapper (Header + Content + Footer)

### Context for Designer

You're designing the outer shell of Notient's sidebar — the permanent chrome that never changes regardless of which view is active. This is the "skeleton" that gives the plugin its identity and navigation structure.

### Design Brief

Create a **320-400px wide sidebar panel** that docks into Obsidian's right sidebar area. The shell has three fixed zones:

**HEADER (48px height, fixed)**
- Left: Notient brand mark — a small diamond ◆ icon followed by "Notient" text
- Right: Three tab buttons in a horizontal row
  - Tab 1: 📝 "Note" — Note Vitals view
  - Tab 2: 🤖 "Agents" — Agent Streams (can show notification badge)
  - Tab 3: 💬 "Chat" — Conversation interface
- Active tab: Distinct background, subtle bottom border accent
- Inactive tabs: Muted, interactive hover state

**CONTENT (flexible height, scrollable)**
- Takes remaining vertical space
- Light gray background (slightly darker than Obsidian's main content)
- Content-specific scrollbar styling
- 12-16px padding on sides

**FOOTER (40px height, fixed)**
- Three-zone horizontal layout
- Zone 1 (Left): Provider status — Two service indicators with colored dots
  - "LM" with green/red dot
  - "Ollama" with green/red dot
- Zone 2 (Center): Index status
  - Note count "1,247 notes"
  - Sync indicator "● Synced 2m ago"
- Zone 3 (Right): Agent status
  - When idle: "Idle" text
  - When active: "● 2 active" with pulse + "3 pending" (clickable)

### Visual States

1. **Normal:** All services connected, index ready, agents idle
2. **Degraded:** One service disconnected (red dot, grayed label)
3. **Active Agents:** Right zone pulses, shows counts
4. **Indexing:** Center zone shows progress bar instead of note count

### Mood Board Keywords

Clean chrome, status dashboard, minimal tabs, utility footer, system tray aesthetic, medical monitor sidebar

### Key Details

- Header tabs should have 4px border-radius
- Active tab uses accent color or slightly elevated background
- Footer text is 11-12px, mono or system font for technical data
- Status dots are 6-8px circles with optional glow on active states
- Separator lines between footer zones: subtle 1px borders

---

## PROMPT 2: NOTE VITALS VIEW — The Living Note

**Surface:** Primary sidebar content when "Note" tab is active

### Context for Designer

This is Notient's signature view — the **Note Vitals** interface that gives every note a living presence. When users open a note, this view displays its "vital signs" like a medical dashboard. The design should feel like monitoring a living organism, not reading a database.

### Design Brief

Create a **vertical scrolling layout** within the sidebar content area (320-400px width). From top to bottom:

**SECTION 1: OMNIBAR (Search Input)**
- Full-width search input with soft rounded corners (8px)
- Left: 🔍 magnifying glass icon (muted)
- Center: Input field with placeholder "Search notes..."
- Right: Mode selector pill showing current preset (⚡ Quick / ⚖️ Balanced / 🧠 Thorough)
- Far right: "Enter" keyboard hint badge

**SECTION 2: NOTE CARD (Note Identity)**
- Card container with subtle border, soft shadow (floating appearance)
- Top row: Two badges
  - Note Type badge (e.g., "📔 Journal", "🔬 Research") — left
  - Indexed status badge (e.g., "Indexed" with checkmark) — right
- Title: Large h2-style text, the note's filename
- Metadata row:
  - 📁 Folder path (truncated)
  - Separator dot ·
  - PARA classification (🎯 Project, 🏠 Area, 📚 Resource, 🗄️ Archive)
- Tags row: Up to 4 tag pills + overflow indicator "+3 more"

**SECTION 3: VITALS CARDS (Four Metrics)**
- 2×2 grid of metric cards
- Each card (clickable):
  - Large emoji icon (❤️, 🔗, 📅, 📊)
  - Primary metric (large text): "87%", "23", "2d", "B+"
  - Secondary label (small): "Health", "Links", "Fresh", "Grade"
  - Status indicator bar (3px bottom border in healthy/attention/unhealthy color)
- Card 1: **Health** — Percentage, heart icon, green/amber/red
- Card 2: **Links** — Count, chain icon, subtitle "12 in / 11 out"
- Card 3: **Freshness** — Time since edit, calendar icon
- Card 4: **Grade** — Letter grade, chart icon

**SECTION 4: QUICK ACTIONS (Action Buttons)**
- Section label: "Quick Actions"
- Horizontal row of 4-6 pill buttons (wrap to second row if needed)
- Each button: Icon + Label
  - 🔍 Find Related
  - ✨ Enrich
  - 🔗 Suggest Links
  - 📝 Summary
  - 🏷️ Tags
  - 📋 Tasks
- First button styled as "primary" (filled background)
- Others: outline/ghost style

**SECTION 5: INSIGHT STREAM (AI Observations)**
- Section label: "Insights" with badge showing high-priority count
- Scrollable feed of insight items (max-height 200px)
- Each insight item:
  - Priority indicator: ● (high/red), ◐ (medium/amber), ○ (low/gray)
  - Body text (1-2 lines, truncated)
  - Optional action link (blue, underlined)
- First item: "Featured" styling with slight background highlight
- Empty state: Centered 💡 icon + "AI insights will appear here as you write"

### Visual States

1. **Healthy Note:** Green status bars, high metrics, bright vitals cards
2. **Needs Attention:** Amber accents on specific cards, insight showing issues
3. **Unhealthy Note:** Red accents, low grade, multiple warnings in insights
4. **No Note Open:** Empty state with centered message "Open a note to see its vitals"
5. **Loading:** Skeleton placeholders in card shapes with shimmer animation

### Special Effects

- **Breathing Animation:** The Note Card should have a very subtle pulsing shadow/border that expands and contracts every 3-4 seconds, as if the note is "breathing"
- **Health Glow:** Cards with "healthy" status get a faint green ambient glow
- **Attention Pulse:** Cards with "attention" status pulse their amber border once every 2 seconds

### Mood Board Keywords

Medical dashboard, vital signs monitor, organism health, living document, biometric interface, smart home panel, wellness app

---

## PROMPT 3: AGENT STREAMS VIEW — Mission Control

**Surface:** Sidebar content when "Agents" tab is active

### Context for Designer

This is Notient's **mission control** — where users monitor autonomous AI agents working on their vault. The aesthetic should feel like a ground control station: organized, status-oriented, with clear action items. Think NASA mission control meets a kanban board.

### Design Brief

Create a **three-section vertical layout** for monitoring agent activity:

**SECTION 1: ACTIVE AGENTS**
- Section header: "Active" with count badge (e.g., "2")
- List of agent cards (vertical stack)
- Each agent card:
  - Status icon: Spinner (running), ⏸ (paused), ⏳ (queued)
  - Agent type label: "Enriching", "Linking", "Synthesizing"
  - Target: Note name (truncated, monospace)
  - Progress bar: Animated fill, percentage text
  - Action buttons (right side): "Pause" | "Stop"
- When running: Card has subtle animated border glow
- Empty state: "All agents idle" with ☕ icon

**SECTION 2: PENDING REVIEW**
- Section header: "Pending Review" with count badge (pulsing if > 0)
- List of action cards requiring approval
- Each action card:
  - Risk level badge (prominent):
    - ⚠️ HIGH — Red background, white text
    - ⚡ MEDIUM — Amber background, dark text
    - ✓ LOW — Green background, white text
  - Summary: Action title in bold
  - Target: "→ Note Name" with arrow
  - Reason: Smaller italic text (if provided)
  - Action buttons: "Apply" (primary) | "Dismiss" (text button)
- Cards sorted by risk level (HIGH first)
- Empty state: "No actions need review" with ✓ icon

**SECTION 3: RECENT ACTIVITY**
- Section header: "Recent Activity"
- Scrollable log of completed actions (max 8 visible)
- Each activity item (compact):
  - Status icon: ✓ (success/green), ✗ (failed/red), ↩ (undone/gray)
  - Summary text
  - Meta: "Note Name · 2m ago"
  - Undo button (if applicable): Small "Undo" text link
- If error: Expandable error message in red
- Empty state: "No recent activity"

### Visual States

1. **Idle:** Empty active section, few or no pending
2. **Busy:** Multiple active cards with progress, spinning indicators
3. **Needs Attention:** Large pending count, pulsing badge, HIGH risk items visible
4. **Post-Action:** Recent activity populated, undo options available

### Special Effects

- **Progress Animation:** Smooth linear fill with subtle shimmer
- **Risk Badge Glow:** HIGH risk items have a subtle red pulse/glow
- **Success Flash:** When action applied, brief green flash on the card before it moves to activity

### Mood Board Keywords

Mission control, kanban, task queue, approval workflow, CI/CD pipeline, notification center, operations dashboard

---

## PROMPT 4: CHAT VIEW — Conversation Interface

**Surface:** Sidebar content when "Chat" tab is active

### Context for Designer

This is Notient's **conversational AI interface** — a chat window for asking questions about notes and the vault. The design should feel warm and intelligent, like talking to a knowledgeable colleague who has read all your notes.

### Design Brief

Create a **chat interface layout** with header, messages, and input:

**HEADER: CONTEXT BAR**
- Shows current context (the note being discussed)
- When note is set:
  - 📝 Icon
  - Note title (truncated, clickable to open)
  - × Clear context button (right side)
- When no note:
  - 📝 Icon
  - "Open a note to chat about it"
- Subtle bottom border separator

**MAIN: MESSAGE STREAM**
- Scrollable message area (flex-grow)
- Message types:

  **User Message Bubble:**
  - Right-aligned
  - Background: Slightly lighter than content area
  - Rounded corners (16px)
  - Max-width: 85% of container
  - Timestamp below (10px, muted)

  **Assistant Message Bubble:**
  - Left-aligned
  - Background: Slightly elevated from content area
  - 🤖 Small avatar icon top-left of bubble
  - Rounded corners (16px, but squared top-left)
  - Max-width: 85%
  - Content can include:
    - Regular text (markdown rendered)
    - [[Note Links]] as clickable pills
    - Code blocks (monospace, dark background)
  - Citations section (if sources used):
    - "Sources:" label
    - List of clickable note names
  - Action buttons (if actions proposed):
    - Inline buttons like "Apply links" | "Apply tags"
  - Timestamp below

  **Streaming Bubble:**
  - Same as assistant but with:
    - Pulsing cursor indicator (●●● typing animation)
    - Content appearing word-by-word
    - Subtle glow border indicating "live" state

**EMPTY STATE** (when no messages):
- Centered vertically
- 🤖 Large avatar icon
- "Chat with Notient" header
- "Ask me anything about this note" subtext
- Two suggestion chips below:
  - "Summarize this note"
  - "Find related notes"
- Chips are clickable, pill-shaped buttons

**FOOTER: INPUT AREA**
- Textarea with auto-expand (1-3 lines)
- Left: No icon needed
- Placeholder: "Ask about 'Note Title'..." (dynamic)
- Right: Send button
  - Normal: ↑ (up arrow in circle)
  - Sending: Spinner
  - Disabled: Grayed out
- Keyboard hint: "Enter to send, Shift+Enter for newline"

### Visual States

1. **Fresh Chat:** Empty state with suggestions visible
2. **Active Conversation:** Multiple message bubbles, scrolled to bottom
3. **Streaming:** Latest message is being typed out with cursor
4. **Disabled:** No context set, input disabled with helper text
5. **With Actions:** Messages showing inline action buttons

### Special Effects

- **Typing Animation:** Three dots cycling with fade: ●○○ → ○●○ → ○○● → ●○○
- **Message Appear:** New messages slide in from bottom with fade
- **Streaming Glow:** Assistant bubble has faint border glow while streaming
- **Send Animation:** Button briefly pulses on successful send

### Mood Board Keywords

iMessage, Slack, GPT interface, helpdesk chat, document assistant, contextual AI, conversation thread

---

## PROMPT 5: SETUP WIZARD — First-Run Experience

**Surface:** Full-screen modal for initial plugin configuration

### Context for Designer

This is the **first impression** — a guided wizard that walks users through connecting their local AI services and setting up the index. The tone should be welcoming, clear, and confidence-building. Users should feel that setting up local AI is approachable, not intimidating.

### Design Brief

Create a **multi-step wizard modal** (max 600px wide, centered overlay):

**MODAL CHROME:**
- Dark overlay behind (50% opacity)
- Rounded modal container (12px radius)
- Subtle shadow for depth
- No close X button (must complete or cancel)

**HEADER (all steps):**
- Title text (changes per step)
- Subtitle/description (1-2 lines)
- Step indicator: 4 dots (● ● ○ ○) showing progress

**STEP 0: INTRO/WELCOME**
- Large centered icon: ✨ (sparkles)
- Title: "Power up your notes"
- Description: "Notient uses local AI to give your notes intelligence. No data leaves your machine."
- Three feature bullets with icons:
  - 🔍 "Semantic search across your vault"
  - 🤖 "AI agents that help you connect ideas"
  - 🧠 "Intelligence that learns from your notes"
- Single button: "Get Started →"

**STEP 1: SERVICES CONFIGURATION**
- Title: "Connect your AI services"
- Two service cards side-by-side:

  **Ollama Card:**
  - 🦙 Icon + "Ollama" label
  - Purpose: "For embeddings & search"
  - Toggle buttons: "Local" | "Network"
  - If Network: Host + Port inputs appear
  - Model dropdown (auto-populated when connected)
  - Status badge: "Connected" (green) / "Checking..." (amber) / "Offline" (red)

  **LM Studio Card:**
  - 🤖 Icon + "LM Studio" label
  - Purpose: "For chat & reasoning"
  - Same layout as Ollama

- Helper text at bottom: "Make sure your services are running before continuing"
- Buttons: "← Back" | "Next →"

**STEP 2: INDEXING CONFIGURATION**
- Title: "Configure your vault"
- Chunk size slider:
  - Label: "Chunk Size: 512 chars"
  - Range: 200-2000
  - Helper: "Smaller = precise search, Larger = more context"
- Excluded folders input:
  - Label: "Excluded Folders"
  - Placeholder: "templates, archive/old"
  - Helper: "Comma-separated folder paths to skip"
- Existing index discovery panel:
  - "Found existing indices:" header
  - List of discovered indices with:
    - Model name + dimension badge (e.g., "768d")
    - Note count
    - Compatibility indicator (✓ compatible / ⚠️ dimension mismatch)
  - Radio buttons: "Use existing" | "Create new"
- Buttons: "← Back" | "Finish Setup →"

**STEP 3: CONFIRM/COMPLETE**
- Title: "You're all set!"
- Summary panel:
  - "Ollama: Connected (nomic-embed-text)"
  - "LM Studio: Connected (llama-3.1-8b)"
  - "Index: Creating new / Using existing (1,247 notes)"
- Large checkmark or success icon
- Single button: "Open Notient" (closes modal)

### Visual States

1. **Service Checking:** Card shows spinner, "Checking..." badge
2. **Service Connected:** Green checkmark, "Connected" badge
3. **Service Failed:** Red X, "Offline" badge, error message below
4. **Model Loading:** Dropdown shows "Loading models..."
5. **Index Incompatible:** Warning icon, amber text explaining dimension mismatch

### Special Effects

- **Step Transition:** Slide left/right animation between steps (200ms)
- **Connection Success:** Brief green flash on service card when connected
- **Progress Dots:** Animate fill as steps complete

### Mood Board Keywords

Onboarding wizard, setup flow, installation guide, SaaS welcome, getting started, configuration panel

---

## PROMPT 6: TASK MODAL — Deep Dive Chat

**Surface:** Focused modal for specific agent task interaction

### Context for Designer

This modal opens when users want to **dive deep into a specific task or agent interaction**. It's an expanded chat interface focused on one topic, with the ability to see context, sources, and proposed actions all in one place.

### Design Brief

Create a **large modal dialog** (max 800px wide, 70% viewport height):

**HEADER:**
- Left: Icon based on task type (🔍 search, 💬 chat, 🤖 agent)
- Center: Note title as the modal title
- Right: Status badge — "Queued" | "Running ●" | "Completed ✓" | "Failed ✗"
- Below: Subtitle with task description

**LEFT COLUMN (30% width, optional):**
- **Note Preview Section:**
  - "Note Preview" label
  - Scrollable text preview (first 500 chars)
  - Fade gradient at bottom
- **Sources Section:**
  - "Sources:" label
  - List of clickable note links that were referenced
  - Each link has file icon + name

**MAIN COLUMN (70% width or full if no preview):**
- **Chat Area:**
  - Scrollable message history
  - Same bubble styling as Chat View (Prompt 4)
  - Streaming support with typing indicator

- **Proposed Actions Panel** (below chat, if actions exist):
  - Header: "Proposed Actions (3)" with count
  - List of action items:
    - Risk badge (same as Agent Streams)
    - Action title with ✓ if applied
    - Type + Target: "Add link → Related Note"
    - Reason text (if provided)
    - Buttons: "Apply" | "Undo" (if already applied)
  - Info text: "Click Apply to execute an action"

**FOOTER:**
- Full-width input area
- Textarea (1-3 lines auto-expand)
- Placeholder: "Ask a follow-up... (Enter to send)"
- Send button (right side)

### Visual States

1. **Loading Task:** Content area shows skeleton loaders
2. **Streaming Response:** Chat area shows typing indicator
3. **With Actions:** Actions panel visible below chat
4. **Actions Applied:** Applied actions show checkmark, Apply becomes Undo
5. **Task Failed:** Error message displayed, retry option

### Mood Board Keywords

Detailed view, expanded chat, task detail, thread view, side panel, document inspection

---

## PROMPT 7: SETTINGS INTERFACE — Configuration Panel

**Surface:** Plugin settings in Obsidian's settings modal

### Context for Designer

This is the **full settings panel** that appears within Obsidian's native settings modal. It must feel like a native Obsidian settings page while maintaining Notient's visual identity. The design should be organized, scannable, and not overwhelming despite having many options.

### Design Brief

Create a **vertical scrolling settings layout** (standard Obsidian settings width ~600px):

**SECTION: CONNECTION STATUS (Top)**
- Two service status indicators inline:
  - ● Ollama: Connected | ○ Ollama: Offline
  - ● LM Studio: Connected | ○ LM Studio: Offline
- Capability icons: 🔍 Search, 🤖 Chat, 📝 Indexing (grayed if unavailable)
- Note count: "📊 1,247 notes ready for search"
- Button: "Reconnect Services"

**SECTION: EMBEDDINGS (OLLAMA)**
- Section title with icon: "🦙 Embeddings (Ollama)"
- Toggle buttons in a row: "Local" | "Network"
- If Network visible:
  - Host input (placeholder: "192.168.1.100")
  - Port input (placeholder: "11434")
- Model dropdown with Refresh button next to it
- Helper text: "Current: nomic-embed-text (768d)"
- Warning text (if model changed): "Changing models requires re-indexing"

**SECTION: CHAT (LM STUDIO)**
- Section title with icon: "🤖 Chat (LM Studio)"
- Same layout as Embeddings section
- Helper text: "Current: llama-3.1-8b"

**SECTION: INDEXING**
- Section title: "Indexing Configuration"
- Chunk Size:
  - Slider input (32-8192)
  - Label: "Chunk Size: 512 chars"
  - Helper: "⚡ Smaller = precise | 📚 Larger = context"
- Excluded Folders:
  - Text input
  - Placeholder: "templates, archive"
  - Helper: "Comma-separated paths"

**SECTION: INDEX MANAGEMENT** (Collapsible/Expandable)
- Section title: "Index Management" with expand arrow
- Current Index panel:
  - Model key badge
  - Dimension badge
  - Source badge ("Plugin" | "External")
  - Note count
- Index Grid:
  - List of available indices (expandable rows)
  - Each row: Model name | Dimension | Count | Active indicator
  - Expanded: Created date, Updated date, Action buttons
- Import button: "Import Index"

**SECTION: SEARCH CONFIGURATION**
- Search Mode dropdown:
  - ⚡ Quick — Fast, no reranking
  - ⚖️ Balanced — Recommended
  - 🧠 Thorough — Deep search
  - ⚙️ Custom...
- If Custom selected:
  - Result Count slider (1-50)
  - AI Reranking toggle
  - Minimum Similarity slider (0.0-1.0)

**SECTION: IDENTITY (PROFILE)**
- Section title: "Identity Configuration"
- Description: "Configure Notient's understanding of your domain"
- Generate button: "Generate from Vault"
- Manual inputs:
  - Primary Domain (text)
  - Secondary Domains (comma-separated)
  - Domain Keywords (comma-separated)
- Reset button: "Reset Profile" (with warning)

**SECTION: PARA FOLDERS**
- Section title: "PARA Folder Mapping"
- Description: "Map your folders to the PARA method"
- Five inputs with icons:
  - 📥 Inbox
  - 🎯 Projects
  - 🏠 Areas
  - 📚 Resources
  - 📦 Archive
- Each: text input with comma-separated folder paths

**SECTION: ADVANCED**
- Debug Logging toggle
- Button: "Run Setup Wizard"
- Button: "Full Reindex" (destructive styling)
- Button: "Clear All Indexes" (destructive styling, with confirmation)

### Visual Principles

- Use Obsidian's native form elements (`.setting-item`, `.setting-item-control`)
- Section headers use `.setting-item-heading`
- Destructive buttons use red accent
- Toggle button groups: Custom styled but match Obsidian segmented controls
- Sliders: Native range inputs with value display

### Mood Board Keywords

Obsidian settings, preferences panel, configuration form, admin panel, system preferences

---

## PROMPT 8: INDEX OPTIONS MODAL — Decision Point

**Surface:** Small modal for choosing index handling strategy

### Context for Designer

This modal appears when Notient detects existing index data and needs user input on how to proceed. It's a **decision modal** — clear options, consequences stated, single choice required.

### Design Brief

Create a **compact decision modal** (400px wide):

**HEADER:**
- Title: "Index Found"
- Subtitle varies by state

**STATE INFO SECTION:**
- Icon + status message:
  - ✅ "Complete index found" — N notes, M passages
  - ⏳ "Incomplete index" — N/M notes (X% done)
  - ⚠️ "Previous indexing interrupted"
  - 🔄 "Unclear index state"
  - (none) "No index found"
- Last indexed date if available
- Vault state hash (truncated, monospace)

**OPTIONS LIST:**
- Radio button group (single selection)
- Each option:
  - Radio button
  - Icon + Label (bold)
  - Description (smaller text explaining consequence)

  **For Complete:**
  - ✅ "Use Existing Index" (default) — "Continue with your current search index"
  - 🔄 "Rebuild From Scratch" — "Delete and create a fresh index"

  **For Incomplete/Crashed:**
  - ▶️ "Resume Indexing" (default) — "Continue where it left off"
  - 🔄 "Start Fresh" — "Delete partial data and restart"
  - ⏸️ "Use As-Is" — "Search with incomplete index"

  **For Stale:**
  - 🔄 "Rebuild Index" (default) — "Create a fresh index"
  - 🤔 "Try Using Anyway" — "May have issues"

**FOOTER:**
- Buttons: "Cancel" | "Continue" (primary)

### Mood Board Keywords

Confirmation dialog, decision modal, recovery options, migration wizard

---

## PROMPT 9: PROFILE MODAL — Identity Review

**Surface:** Modal for reviewing/editing user profile data

### Context for Designer

This modal lets users **review and edit** the profile that Notient has inferred from their vault. It shows what the AI has learned about the user's domains of expertise and preferences.

### Design Brief

Create a **form modal** (500px wide):

**HEADER:**
- Title: "Review Inferred Profile"
- Description: "Notient analyzed your vault and inferred this profile. Adjust as needed."

**SECTION: DOMAIN EXPERTISE**
- Primary Domain:
  - Label + text input
  - Placeholder: "Software Engineering"
- Secondary Domains:
  - Label + text input
  - Placeholder: "Machine Learning, Data Science"
  - Helper: "Comma-separated"
- Domain Keywords:
  - Label + textarea (2 rows)
  - Placeholder: "AI, neural networks, python, research"

**SECTION: PARA FOLDERS (Detected)**
- Title: "Detected PARA Structure"
- Four inputs (prefilled if detected):
  - 🎯 Projects
  - 🏠 Areas
  - 📚 Resources
  - 🗄️ Archive
- Helper: "Folder paths that match your PARA structure"

**SECTION: PREFERENCES**
- Citation Style dropdown:
  - "Wikilink [[Note]]" (default for Obsidian)
  - "Markdown [Note](path)"
- Response Formality dropdown:
  - "Formal" — Professional tone
  - "Balanced" — Natural mix
  - "Casual" — Conversational

**FOOTER:**
- Buttons: "Cancel" | "Save Profile" (primary)

### Mood Board Keywords

Profile settings, user preferences, personalization, onboarding form

---

## PROMPT 10: SEARCH RESULTS OVERLAY — Query Feedback

**Surface:** Results panel that appears below omnibar after search

### Context for Designer

When users search via the omnibar, results appear in a **dropdown panel** below the search input. This is a transient overlay that should feel quick, scannable, and immediately useful.

### Design Brief

Create a **dropdown results panel** (full sidebar width, max-height 60% of content area):

**HEADER:**
- "Results for 'query text'" — left aligned
- "✕ Clear" button — right aligned (clears search and results)

**RESULTS LIST:**
- Vertical list of result cards (10-20 max visible)
- Each result card:
  - Note title (bold, clickable)
  - Snippet (1-2 lines, with highlighted match terms in bold)
  - Score: "95% match" — right aligned, small monospace text
  - Status indicator: ● if note is already open in editor
- Card hover: Slight background change, cursor pointer
- Card click: Opens note in editor, closes results

**EMPTY STATE:**
- Icon: 🔍
- Message: "No notes found matching your query."
- Suggestion: "Try different keywords or check excluded folders."

**LOADING STATE:**
- Skeleton cards with shimmer animation
- "Searching..." text with spinner

### Visual Principles

- Results panel has shadow to float above content
- Smooth slide-down animation when appearing
- Scroll within panel (content below doesn't move)
- Match highlighting uses accent color background (soft highlight)

### Mood Board Keywords

Search autocomplete, command palette results, spotlight search, dropdown menu

---

## PROMPT 11: EMPTY STATES & LOADING — Transition Moments

**Surface:** Various empty and loading states throughout the UI

### Context for Designer

Empty and loading states are **critical micro-moments** that shape user perception. They should feel intentional, informative, and maintain the TECHNO-NATURAL aesthetic even when there's no content to show.

### Design Brief

Create **consistent empty/loading patterns** for reuse:

**EMPTY STATE PATTERN:**
- Centered vertically in container
- Large icon (40-48px) in muted color
- Title text (16px, medium weight)
- Description text (14px, muted color)
- Optional action button below
- Generous padding (32px+)

**Examples:**
| Location | Icon | Title | Description |
|----------|------|-------|-------------|
| Note Vitals (no note) | 📝 | "Open a note" | "Select a note to see its vitals" |
| Agent Streams (idle) | ☕ | "All agents idle" | "Agents will appear here when working" |
| Chat (empty) | 🤖 | "Chat with Notient" | "Ask me anything about your notes" |
| Insights (none) | 💡 | "No insights yet" | "AI observations will appear as you write" |
| Search (no results) | 🔍 | "No matches found" | "Try different keywords" |
| Pending Review (none) | ✓ | "All clear" | "No actions need your review" |
| Recent Activity (none) | 📋 | "No activity" | "Completed actions will appear here" |

**LOADING STATE PATTERN:**
- **Skeleton loaders:** Rounded rectangles matching content shape
- **Shimmer animation:** Left-to-right sweep every 1.5s
- **Spinner:** Small (16-20px) for inline, large (32px) for centered
- **Opacity:** 50% with subtle pulse

**INITIALIZATION STATE:**
- During app startup, show progressive states:
  1. "Connecting to services..." (spinner)
  2. "Loading index..." (progress)
  3. "Warming up..." (spinner)
- Use state machine messaging (CHECKING_PROVIDERS → LOADING_INDEX → WARMING → READY)
- Capability badges (grayed if unavailable): 🔍 Search | 🤖 Chat | 📝 Indexing

**ERROR STATE PATTERN:**
- Red accent border or background tint
- ⚠️ or ❌ icon
- Error title in bold
- Error description (technical details expandable)
- Retry button if applicable

### Mood Board Keywords

Skeleton loading, empty state illustration, loading indicator, progress feedback, error message

---

## PROMPT 12: MICRO-INTERACTIONS — The Details

**Surface:** Buttons, toggles, badges, and interactive elements

### Context for Designer

The **micro-interactions** define how the UI feels in use. These small details — button states, toggle animations, badge pulses — are what make the interface feel alive and responsive.

### Design Brief

Define **interaction patterns** for common elements:

**BUTTONS:**
- **Primary:** Filled background, white text, 8px radius
  - Hover: Slightly darker, subtle lift shadow
  - Active: Darker still, pressed shadow
  - Disabled: 50% opacity, no cursor change
- **Secondary:** Border only (outline), theme text color
  - Hover: Light fill, darker border
  - Active: Darker fill
- **Text/Ghost:** No border or fill, just text
  - Hover: Subtle background
  - Active: Slightly darker background
- **Destructive:** Red accent color for delete/clear actions

**TOGGLE BUTTONS (Group):**
- Row of options ("Local" | "Network")
- Selected: Filled background, white text
- Unselected: Transparent, theme text
- Transition: 200ms background slide

**STATUS DOTS:**
- Size: 6-8px circle
- Green (connected): `#4CAF50` with subtle glow
- Red (disconnected): `#E57373`
- Amber (checking): `#FF9800` with pulse
- Gray (unknown): Muted theme color

**BADGES:**
- Notification badge (red): Small circle with count
  - Position: Top-right of parent element
  - Animation: Scale pop on increment
  - "9+" for counts over 9
- Status badge (text): Rounded pill
  - "Connected" — green text on green tint
  - "Offline" — red text on red tint
  - "Checking" — amber with spinner

**PROGRESS BARS:**
- Height: 4-6px
- Background: Muted theme color
- Fill: Accent color with gradient
- Animation: Smooth width transition (300ms)
- Indeterminate: Shimmer sweep animation

**INPUT FIELDS:**
- Border: 1px theme border
- Focus: Accent color border, subtle glow
- Error: Red border
- Disabled: Reduced opacity, different background

**CARDS:**
- Background: Slightly elevated from container
- Border: 1px subtle border
- Radius: 8px
- Shadow: Subtle on hover (2px blur)
- Active/Selected: Accent border

**TOOLTIPS:**
- Background: Dark (inverted from theme)
- Text: Light
- Position: Below element with arrow
- Animation: Fade in (150ms delay before show)
- Max-width: 200px

### Animation Timing

| Element | Duration | Easing |
|---------|----------|--------|
| Button hover | 150ms | ease-out |
| Button active | 100ms | ease-in |
| Card hover | 200ms | ease-out |
| Modal open | 200ms | ease-out |
| Slide transition | 200ms | ease-in-out |
| Fade in | 150ms | linear |
| Pulse | 2000ms | ease-in-out (infinite) |
| Shimmer | 1500ms | linear (infinite) |

### Mood Board Keywords

Micro-interactions, button states, form elements, design system components

---

## DESIGN CROSS-REFERENCE

To ensure consistency, all surfaces share:

| Element | Specification |
|---------|---------------|
| Border radius (cards) | 8px |
| Border radius (buttons) | 8px |
| Border radius (badges) | 12px (full pill) |
| Border radius (inputs) | 6px |
| Section padding | 12-16px |
| Card gap | 8-12px |
| Icon size (inline) | 16-18px |
| Icon size (featured) | 24-32px |
| Font size (body) | 14px |
| Font size (caption) | 12px |
| Font size (header) | 16-18px |
| Status dot size | 6-8px |
| Minimum touch target | 32x32px |

---

## FINAL NOTES FOR DESIGNER

1. **Test in Both Themes:** Every design must work in Obsidian's light and dark themes. Use CSS variables exclusively for colors that need to adapt.

2. **Respect the Chrome:** The sidebar width (320-400px) is fixed. All designs must work within this constraint without horizontal scrolling.

3. **Breathing is Key:** The TECHNO-NATURAL aesthetic depends on subtle "alive" animations. Don't skip the breathing effects on key elements like the Note Card and active status indicators.

4. **Obsidian Native Feel:** When in doubt, match Obsidian's existing patterns. We're an extension of the app, not a foreign implant.

5. **Local-First Messaging:** Any status indicators, loading states, or error messages should reinforce that everything is local. "Connecting to local services..." not "Connecting to cloud..."

6. **Information Density:** Power users expect dense UIs. Don't oversimplify — but use whitespace and grouping to prevent overwhelm.

---

**END OF DESIGN PROMPTS**
