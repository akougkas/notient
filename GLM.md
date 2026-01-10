🎨 Notient UI Redesign Plan: "Polished Personality, Preserved Context"
Vision Statement
Transform Notient's sidebar into a refined, intelligent workspace where notes feel like living companions. Every interaction should feel thoughtful, context should never be lost, and each note should develop its own character based on how you work with it.
Core Principles:
- Polished: Tasteful animations, clear hierarchy, professional feel
- Living: Notes have personalities that evolve
- Contextual: Never force the user to lose their mental flow
- Effortless: Keyboard-first, instant feedback, minimal friction
---
🏗️ Architecture Foundations
Phase 0: Tech Stack Clarification
Decision: Preact for Sidebar, Obsidian Native for Modals
| Component | Tech | Rationale |
|------------|-------|-----------|
| Sidebar UI | Preact (keep current) | Complex state, reactivity, animations |
| Simple Modals | Obsidian Modal | Native accessibility, keyboard handling |
| Settings | Obsidian Setting API (keep current) | Consistent with Obsidian ecosystem |
| Quick Actions | Obsidian Menu API | Native context menu feel |
Rationale: Keep Preact for the complex sidebar (chat, agents, streams) but leverage Obsidian's native components for simple dialogs. This reduces code complexity while maintaining Obsidian's native feel.
---
🎯 Phase 1: Note Personality System
1.1 Note Emotional States
Concept: Each note develops an emotional state based on content analysis and user interaction patterns.
Emotional State Categories
┌─────────────────────────────────────────────────────────────┐
│ Note Emotional States                                    │
├─────────────────────────────────────────────────────────────┤
│                                                          │
│  ⚡ Energized  (High activity, new connections)         │
│  🧘 Peaceful    (Stable, mature, reference material)   │
│  😰 Stressed    (Many tasks, deadlines, TODOs)          │
│  😴 Dormant     (Not edited in 30+ days)              │
│  🌟 Popular    (High backlink count, frequently linked)   │
│  🏚️ Orphaned   (No links, no tags, isolated)            │
│                                                          │
└─────────────────────────────────────────────────────────────┘
Visual Expression
/* Enhanced design tokens for emotional states */
--nv2-emotion-energized: var(--color-purple);  /* Vibrant, glowing */
--nv2-emotion-peaceful: var(--color-green);    /* Calm, stable */
--nv2-emotion-stressed: var(--color-orange);    /* Urgent, pulsing */
--nv2-emotion-dormant: var(--text-faint);      /* Dimmed, ghostly */
--nv2-emotion-popular: var(--color-blue);       /* Connected, thriving */
--nv2-emotion-orphaned: var(--text-muted);     /* Isolated, needs help */
Implementation: Extend NoteVitalsCalculator to compute emotional score:
// New property in NoteVitals
interface NoteVitals {
  // ... existing properties
  emotionalState: EmotionalState;
  emotionalScore: number; // 0-100
  personalityTraits: PersonalityTrait[];
}
interface EmotionalState {
  type: 'energized' | 'peaceful' | 'stressed' | 'dormant' | 'popular' | 'orphaned';
  confidence: number; // 0-1
}
interface PersonalityTrait {
  type: 'creative' | 'analytical' | 'action-oriented' | 'reference';
  score: number; // 0-100
}
1.2 Dynamic Pulse Timeline
Current Issue: Pulse is constant 4-second breathing animation regardless of note activity.
Redesign: Pulse syncs with note's emotional state and recent activity.
┌──────────────────────────────────────────────────────────────┐
│ 📝 My Research Note                ○───●───○───○         │
│  Energetic (edited 2h ago)      ←→ Created      Now       │
│                                                            │
│ Pulse: Fast, vibrant purple glow                           │
│ • Speed scales with edit frequency                          │
│ • Color matches emotional state                              │
│ • Sparkle appears when agent works on this note             │
└──────────────────────────────────────────────────────────────┘
Behavior Mapping:
| State | Pulse Speed | Pulse Color | Glow Intensity |
|-------|-------------|-------------|----------------|
| Energized | 1.5s | Purple | Strong, shimmering |
| Peaceful | 4s | Green | Soft, steady |
| Stressed | 1s | Orange | Urgent, throbbing |
| Dormant | 8s | Gray (40% opacity) | Faint, ghostly |
| Popular | 2s | Blue | Connected, ripple effect |
| Orphaned | 6s | Muted | Lonely, seeking |
CSS Animation:
.nv2-pulse--energized {
  animation: nv2-pulse-energized 1.5s infinite ease-in-out;
}
@keyframes nv2-pulse-energized {
  0%, 100% {
    transform: scale(1);
    box-shadow: 0 0 0 2px var(--nv2-emotion-energized);
  }
  50% {
    transform: scale(1.05);
    box-shadow: 0 0 0 6px var(--nv2-emotion-energized),
                0 0 20px var(--nv2-emotion-energized);
  }
}
/* Sparkle animation when agent processes note */
.nv2-pulse--working::after {
  content: "";
  position: absolute;
  top: -8px;
  right: -8px;
  width: 16px;
  height: 16px;
  background: var(--nv2-color-accent);
  clip-path: polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%);
  animation: nv2-sparkle 0.6s ease-out;
}
@keyframes nv2-sparkle {
  0% { transform: scale(0) rotate(0deg); opacity: 1; }
  100% { transform: scale(1.2) rotate(180deg); opacity: 0; }
}
1.3 Note Birth Animation
Concept: When opening a note, it should "materialize" rather than just appear.
.nv2-note-card {
  animation: nv2-note-birth 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes nv2-note-birth {
  0% {
    opacity: 0;
    transform: translateY(12px) scale(0.96);
  }
  50% {
    opacity: 0.6;
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
Stagger children (tags, badges, vitals):
.nv2-note-card > *:nth-child(1) { animation-delay: 0.05s; }  /* Title */
.nv2-note-card > *:nth-child(2) { animation-delay: 0.08s; }  /* Folder */
.nv2-note-card > *:nth-child(3) { animation-delay: 0.11s; }  /* Tags */
.nv2-note-card > *:nth-child(4) { animation-delay: 0.14s; }  /* Vitals */

---
🔄 Phase 2: Context-Preserving Interactions
2.1 Inline Agent Results (No Modal!)
Problem: Current "View Results" button opens a modal, breaking flow.
Solution: Expand agent card inline with smooth drawer animation.
┌──────────────────────────────────────────────────────────────┐
│ 🔗 Link Finder                                      ● 23%  │
│ My Research Note                                        │
│ ─────────────────────────────────────────────────────────   │
│ │ [+] View Results                                      │
│ │                                                      │
│ └─────────────────────────────────────────────────────────── │
│                                                          │
│ ▼ Expanded (click "View Results"):                         │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ 🔗 Link Finder Results                                │ │
│ │ ────────────────────────────────────────────────────────  │ │
│ │                                                      │ │
│ │ 📄 Related Notes Found:                               │ │
│ │   • AI Ethics (92% match)              [Add Link]    │ │
│ │   • Neural Networks (87% match)          [Add Link]    │ │
│ │   • Transformer Paper (84% match)        [Add Link]    │ │
│ │                                                      │ │
│ │ 💡 Suggested Connections:                              │ │
│ │   → Connect to "Machine Learning Notes"                │ │
│ │   → Move to Projects/Machine Learning/                │ │
│ │                                                      │ │
│ │ [Apply All] [Apply Selected] [Dismiss]                │ │
│ └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
Implementation:
// Enhanced AgentCard component
function AgentCard({ agent }: { agent: ActiveAgent }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [results, setResults] = useState<AgentResultData | null>(null);
  
  const handleViewResults = async () => {
    // Fetch results in-place, no modal
    const agentResults = await fetchAgentResults(agent.id);
    setResults(agentResults);
    setIsExpanded(true);
  };
  
  return (
    <div class="nv2-agent-card nv2-agent-card--{agent.status}">
      <div class="nv2-agent-header">
        <AgentAvatar type={agent.type} status={agent.status} />
        <div class="nv2-agent-info">
          <span class="nv2-agent-title">{getAgentTitle(agent.type)}</span>
          <span class="nv2-agent-target">{agent.targetNote}</span>
        </div>
        <div class="nv2-agent-status">
          {agent.status === 'running' && (
            <Progress percent={agent.progress} />
          )}
          <ActionButtons agent={agent} />
        </div>
      </div>
      
      {/* Inline expansion drawer */}
      <div class={`nv2-agent-drawer nv2-agent-drawer--${isExpanded ? 'open' : 'closed'}`}>
        {isExpanded && results && (
          <AgentResultsDrawer results={results} agent={agent} />
        )}
      </div>
    </div>
  );
}
// CSS for smooth drawer animation
.nv2-agent-drawer {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s cubic-bezier(0.16, 1, 0.3, 1),
              opacity 0.3s ease;
  opacity: 0;
}
.nv2-agent-drawer--open {
  max-height: 600px; /* Arbitrary large value */
  opacity: 1;
}
2.2 Floating Quick Actions Toolbar
Problem: Quick Actions fixed below vitals cards. Scroll to bottom to access.
Solution: Float them as a mini toolbar that follows scroll position.
┌─────────────────────────────────────────────────────────────┐
│ ⚡  🔗  🏷️  📊  💬  ✓                             │
│ Floating Quick Actions (scrolls with you)                 │
└─────────────────────────────────────────────────────────────┘
Behavior:
- Collapses to icon-only bar when not hovered
- Expands to show labels on hover (200ms delay)
- Floats 8px from bottom edge
- Backdrop blur for glass effect
- Auto-hides when scroll to bottom (Quick Actions section visible)
Implementation:
// FloatingQuickActions component
function FloatingQuickActions() {
  const [isVisible, setIsVisible] = useState(true);
  const [isHovered, setIsHovered] = useState(false);
  
  // Auto-hide when Quick Actions section is in viewport
  const quickActionsRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(!entry.isIntersecting);
      },
      { threshold: 0.1 }
    );
    
    if (quickActionsRef.current) {
      observer.observe(quickActionsRef.current);
    }
    
    return () => observer.disconnect();
  }, []);
  
  return (
    <>
      {/* Reference to original QuickActions section */}
      <div ref={quickActionsRef} class="nv2-quick-actions-anchor" />
      
      {/* Floating toolbar */}
      <div 
        class={`
          nv2-floating-toolbar
          nv2-floating-toolbar--${isVisible ? 'visible' : 'hidden'}
          nv2-floating-toolbar--${isHovered ? 'expanded' : 'collapsed'}
        `}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {quickActions.map(action => (
          <ActionButton 
            key={action.id}
            action={action}
            showLabel={isHovered}
            onClick={() => executeAction(action)}
          />
        ))}
      </div>
    </>
  );
}
CSS:
.nv2-floating-toolbar {
  position: fixed;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%) translateY(20px);
  background: color-mix(in srgb, var(--background-primary) 95%, var(--background-secondary));
  backdrop-filter: blur(12px);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--nv2-radius-lg);
  box-shadow: var(--nv2-shadow-lg);
  padding: var(--nv2-space-sm);
  gap: var(--nv2-space-sm);
  display: flex;
  opacity: 0;
  pointer-events: none;
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1),
              opacity 0.3s ease;
}
.nv2-floating-toolbar--visible {
  opacity: 1;
  pointer-events: auto;
  transform: translateX(-50%) translateY(0);
}
.nv2-floating-toolbar--collapsed {
  gap: var(--nv2-space-sm);
}
.nv2-floating-toolbar--expanded {
  gap: var(--nv2-space-md);
}
2.3 Search Results Overlay (Not Replacement)
Problem: Search results hide all note content. Can't reference note while searching.
Solution: Search results as a slide-over drawer, preserving note context.
┌──────────────────────────────────────────────────────────────┐
│ 🔍 My Research Note...                                   │
│ ──────────────────────────────────────────────────────────   │
│                                                          │
│ 📝 My Awesome Note           ⚡ Energetic                 │
│ Projects/Research             🔧 3 pending actions          │
│ #ai #ml                                                │
│                                                          │
│ Health: 78  Links: 12  Freshness: 7d  Grade: A-       │
│                                                          │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ 🔍 Search Results (3)                                │ │
│ │ ───────────────────────────────────────────────────────  │ │
│ │                                                      │ │
│ │ 📄 Neural Networks Primer          94% match          │ │
│ │    "Introduction to neural networks and..."             │ │
│ │    Tags: #ai #ml #tutorial                           │ │
│ │                                                      │ │
│ │ 📄 Transformer Architecture      87% match            │ │
│ │    "Self-attention mechanisms for..."                   │ │
│ │                                                      │ │
│ │ [View All Results] [Clear Search]                     │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                          │
│ 💡 💡 💡 Insights (3)                                   │
│ ⚡ 🔗  🏷️  Quick Actions                              │
└──────────────────────────────────────────────────────────────┘
Implementation:
// SearchResultsOverlay component
function SearchResultsOverlay({ results, query, onClose }: SearchResultsProps) {
  return (
    <div class="nv2-search-overlay">
      <div class="nv2-search-overlay-header">
        <h3>
          🔍 Search Results ({results.length})
          <span class="nv2-search-query">"{query}"</span>
        </h3>
        <div class="nv2-search-actions">
          <button onClick={onClose}>Clear</button>
        </div>
      </div>
      
      <div class="nv2-search-results-list">
        {results.slice(0, 3).map((result, idx) => (
          <SearchResultItem 
            key={result.path} 
            result={result}
            style={{ animationDelay: `${idx * 0.05}s` }}
          />
        ))}
      </div>
      
      {results.length > 3 && (
        <div class="nv2-search-footer">
          <button onClick={onClose}>
            View All {results.length} Results
          </button>
        </div>
      )}
    </div>
  );
}
CSS:
.nv2-search-overlay {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--nv2-bg-secondary);
  border: 1px solid var(--nv2-border-color);
  border-radius: var(--nv2-radius-md);
  margin-bottom: var(--nv2-space-lg);
  box-shadow: var(--nv2-shadow-lg);
  animation: nv2-slide-down 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes nv2-slide-down {
  0% {
    opacity: 0;
    transform: translateY(-12px);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}
---
⌨️ Phase 3: Keyboard-First Navigation

### Arrow Key Navigation
Navigate lists with keyboard:
// KeyboardNavigableList component
function KeyboardNavigableList<T>({ 
  items, 
  renderItem, 
  onActivate,
  initialIndex = 0 
}: KeyboardNavigableListProps<T>) {
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex(prev => Math.min(prev + 1, items.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(prev => Math.max(prev - 1, 0));
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          onActivate(items[selectedIndex]);
          break;
        case 'Escape':
          // Clear selection
          break;
      }
    };
    
    const container = containerRef.current;
    container?.addEventListener('keydown', handleKeyDown);
    return () => container?.removeEventListener('keydown', handleKeyDown);
  }, [items, onActivate]);
  
  // Scroll selected item into view
  useEffect(() => {
    const selectedElement = itemRefs.current[selectedIndex];
    selectedElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIndex]);
  
  return (
    <div 
      ref={containerRef}
      class="nv2-kb-list"
      role="listbox"
      tabIndex={0}
    >
      {items.map((item, idx) => (
        <div
          key={idx}
          ref={el => itemRefs.current[idx] = el}
          class={`
            nv2-kb-item
            nv2-kb-item--${idx === selectedIndex ? 'selected' : 'default'}
          `}
          onClick={() => onActivate(item)}
        >
          {renderItem(item, idx === selectedIndex)}
        </div>
      ))}
    </div>
  );
}
---
✨ Phase 4: Polish & Delight
4.1 Staggered Animations
Problem: Multiple items appear simultaneously, causing visual shock.
Solution: Stagger animations with cascading delays.
// StaggeredContainer component
function StaggeredContainer({ 
  children, 
  staggerDelay = 50 
}: StaggeredContainerProps) {
  const childrenArray = useMemo(() => {
    return Children.toArray(children);
  }, [children]);
  
  return (
    <div class="nv2-staggered-container">
      {childrenArray.map((child, idx) => (
        <div
          key={idx}
          class="nv2-staggered-item"
          style={{ '--stagger-delay': `${idx * staggerDelay}ms` }}
        >
          {child}
        </div>
      ))}
    </div>
  );
}
CSS:
.nv2-staggered-item {
  animation: nv2-fade-in-up 0.3s cubic-bezier(0.16, 1, 0.3, 1)
             var(--stagger-delay)
             backwards;
}
@keyframes nv2-fade-in-up {
  0% {
    opacity: 0;
    transform: translateY(8px);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}
Apply to:
- Search results (list of results)
- Insights (multiple insights appearing)
- Agent cards (new agents added)
- Recent activity (new activity items)
4.2 Micro-Interactions
Enhanced Hover Effects:
/* Card hover with subtle lift */
.nv2-card {
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1),
              box-shadow 0.2s ease,
              border-color 0.2s ease;
}
.nv2-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--nv2-shadow-lg);
  border-color: color-mix(in srgb, var(--nv2-color-accent) 30%, transparent);
}
/* Button ripple effect */
.nv2-button {
  position: relative;
  overflow: hidden;
}
.nv2-button::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  width: 0;
  height: 0;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text-on-accent) 20%, transparent);
  transform: translate(-50%, -50%);
  transition: width 0.4s ease, height 0.4s ease;
}
.nv2-button:active::after {
  width: 200%;
  height: 200%;
}
Success Feedback Flash:
@keyframes nv2-success-flash {
  0% {
    background: color-mix(in srgb, var(--nv2-status-healthy) 50%, var(--nv2-bg-secondary));
  }
  100% {
    background: var(--nv2-bg-secondary);
  }
}
.nv2-card--applied {
  animation: nv2-success-flash 0.5s ease-out;
}
4.3 Focus State Enhancement
Polished focus rings:
/* Enhanced focus for keyboard navigation */
button:focus-visible,
[role="button"]:focus-visible,
input:focus-visible,
textarea:focus-visible {
  outline: none;
  box-shadow: 
    0 0 0 2px var(--interactive-accent),
    0 0 0 4px color-mix(in srgb, var(--interactive-accent) 20%, transparent);
  transform: scale(1.02);
  transition: box-shadow 0.2s ease, transform 0.2s ease;
}
/* Focus ring for list items */
.nv2-kb-item--selected {
  background: color-mix(in srgb, var(--interactive-accent) 10%, transparent);
  border-color: var(--interactive-accent);
  box-shadow: 
    0 0 0 2px var(--interactive-accent),
    inset 0 0 12px color-mix(in srgb, var(--interactive-accent) 5%, transparent);
}
4.4 Loading States
Skeleton loading with shimmer:
// SkeletonCard component
function SkeletonCard() {
  return (
    <div class="nv2-skeleton-card">
      <div class="nv2-skeleton-title" />
      <div class="nv2-skeleton-line" />
      <div class="nv2-skeleton-line short" />
      <div class="nv2-skeleton-line" />
    </div>
  );
}
CSS:
.nv2-skeleton-card {
  padding: var(--nv2-space-md);
  background: var(--nv2-bg-secondary);
  border-radius: var(--nv2-radius-md);
}
.nv2-skeleton-title,
.nv2-skeleton-line {
  background: linear-gradient(
    90deg,
    var(--background-modifier-hover) 0%,
    var(--background-modifier-border) 50%,
    var(--background-modifier-hover) 100%
  );
  background-size: 200% 100%;
  animation: nv2-shimmer 1.5s infinite linear;
  border-radius: var(--nv2-radius-sm);
}
.nv2-skeleton-title {
  height: 20px;
  width: 70%;
  margin-bottom: var(--nv2-space-md);
}
.nv2-skeleton-line {
  height: 14px;
  width: 100%;
  margin-bottom: var(--nv2-space-sm);
}
.nv2-skeleton-line.short {
  width: 60%;
}
@keyframes nv2-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
---
🎨 Phase 5: Visual Design System
5.1 Enhanced Design Tokens
Add to tokens.css:
:root {
  /* === NEW: Emotion Colors === */
  --nv2-emotion-energized: var(--color-purple);
  --nv2-emotion-peaceful: var(--color-green);
  --nv2-emotion-stressed: var(--color-orange);
  --nv2-emotion-dormant: var(--text-faint);
  --nv2-emotion-popular: var(--color-blue);
  --nv2-emotion-orphaned: var(--text-muted);
  
  /* === NEW: Animation Durations === */
  --nv2-duration-instant: 0.05s;
  --nv2-duration-fast: 0.1s;
  --nv2-duration-normal: 0.15s;
  --nv2-duration-slow: 0.25s;
  --nv2-duration-breathe: 4s;
  
  /* === NEW: Easing Functions === */
  --nv2-ease-out-back: cubic-bezier(0.16, 1, 0.3, 1);
  --nv2-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
  --nv2-ease-bounce: cubic-bezier(0.175, 0.885, 0.32, 1.275);
  
  /* === NEW: Z-Index Scale === */
  --nv2-z-base: 1;
  --nv2-z-dropdown: 100;
  --nv2-z-modal: 200;
  --nv2-z-tooltip: 300;
  --nv2-z-toast: 400;
  
  /* === NEW: Color Opacities === */
  --nv2-opacity-subtle: 0.6;
  --nv2-opacity-muted: 0.4;
  --nv2-opacity-faint: 0.2;
}
5.2 Color Mixing Utilities
Extract repeated patterns:
/* Utility: Background tints */
.nv2-bg-tint-accent { 
  background: color-mix(in srgb, var(--nv2-color-accent) 8%, transparent); 
}
.nv2-bg-tint-healthy { 
  background: color-mix(in srgb, var(--nv2-status-healthy) 15%, transparent); 
}
.nv2-bg-tint-warning { 
  background: color-mix(in srgb, var(--nv2-status-warning) 15%, transparent); 
}
.nv2-bg-tint-error { 
  background: color-mix(in srgb, var(--nv2-status-error) 15%, transparent); 
}
.nv2-bg-tint-energized { 
  background: color-mix(in srgb, var(--nv2-emotion-energized) 15%, transparent); 
}
5.3 Animation Token Usage
Replace hardcoded values:
/* Before */
transition: all 0.15s ease;
animation: nv2-pulse 4s infinite;
/* After */
transition: all var(--nv2-duration-normal) var(--nv2-ease-in-out);
animation: nv2-pulse var(--nv2-duration-breathe) infinite;
5.4 Enhanced Typography Scale
Add to tokens:
:root {
  /* === NEW: Typography === */
  --nv2-text-xs: var(--font-smallest);    /* 10px */
  --nv2-text-sm: var(--font-smaller);     /* 11-12px */
  --nv2-text-base: var(--font-text-size);  /* 16px */
  --nv2-text-lg: var(--font-ui-larger);  /* 18px */
  --nv2-text-xl: 20px;
  
  /* Font weights */
  --nv2-font-regular: 400;
  --nv2-font-medium: 500;
  --nv2-font-semibold: 600;
  --nv2-font-bold: 700;
  
  /* Line heights */
  --nv2-leading-tight: 1.2;
  --nv2-leading-normal: 1.5;
  --nv2-leading-relaxed: 1.75;
}
---
🏗️ Implementation Roadmap
Priority 1: Quick Wins (Week 1)
| Feature | Impact | Effort | File Changes |
|---------|---------|---------|--------------|
| Fix "View Results" modal | High | Low | AgentStreamsView.tsx |
| Stagger insight animations | Medium | Low | InsightStream.tsx + CSS |
| Add global keyboard shortcuts | High | Low | App.tsx + HotkeyHelp.tsx |
| Enhanced focus states | Medium | Low | tokens.css |
| Remove duplicate Icon component | Medium | Low | Shared Icon.tsx |
| Add note birth animation | Medium | Low | NoteCard.tsx + CSS |
Priority 2: Core UX Improvements (Week 2-3)
| Feature | Impact | Effort | File Changes |
|---------|---------|---------|--------------|
| Inline agent results drawer | High | Medium | AgentStreamsView.tsx + CSS |
| Floating quick actions toolbar | High | Medium | FloatingQuickActions.tsx + CSS |
| Search results overlay | High | Medium | Omnibar.tsx + CSS |
| Arrow key navigation | Medium | Medium | KeyboardNavigableList.tsx |
| Enhanced design tokens | Low | Medium | tokens.css |
| Color mixing utilities | Low | Low | utilities.css |
Priority 3: Note Personality (Week 3-4)
| Feature | Impact | Effort | File Changes |
|---------|---------|---------|--------------|
| Emotional state calculation | High | High | NoteVitalsCalculator.ts + types |
| Dynamic pulse timeline | High | Medium | PulseTimeline.tsx + CSS |
| Personality traits display | Medium | Medium | NoteCard.tsx + CSS |
| Note state persistence | Medium | Medium | StoragePaths.ts + IndexManager |
| Emotion-aware color system | High | Low | tokens.css + component CSS |
Priority 4: Polish & Performance (Week 4-5)
| Feature | Impact | Effort | File Changes |
|---------|---------|---------|--------------|
| Staggered animations everywhere | Medium | Low | StaggeredContainer.tsx + CSS |
| Micro-interactions (hover, ripple) | Medium | Low | CSS |
| Enhanced loading skeletons | Low | Low | SkeletonCard.tsx + CSS |
| Batch signal updates | Medium | Low | App.tsx |
| Computed signals for derived state | Medium | Medium | state.ts |
| Performance optimization | High | Medium | Profiling + optimization |
---
📁 File Structure Changes
New Components
src/ui/sidebar/components/
├── shared/
│   ├── Icon.tsx                 # Extract shared Icon
│   ├── StaggeredContainer.tsx   # Stagger animations
│   └── KeyboardNavigableList.tsx # Arrow key nav
├── feedback/
│   ├── SuccessFlash.tsx         # Success animation
│   └── SkeletonCard.tsx        # Loading skeleton
├── floating/
│   └── FloatingQuickActions.tsx # Floating toolbar
├── keyboard/
│   ├── HotkeyHelp.tsx          # Keyboard shortcuts overlay
│   └── HotkeyGroup.tsx         # Hotkey group display
└── results/
    └── SearchResultsOverlay.tsx # Search overlay
New Hooks
src/ui/sidebar/hooks/
├── useEmotionalState.ts        # Note emotion calculation
├── useKeyboardNavigation.ts    # Keyboard shortcuts
├── useStaggeredAnimation.ts   # Stagger timing
└── useFloatingElement.ts      # Floating element positioning
New CSS Files
src/ui/styles/components/
├── shared/
│   ├── animations.css          # All animations
│   ├── micro-interactions.css  # Hover, ripple, feedback
│   └── focus-states.css       # Keyboard focus
├── emotions/
│   └── emotional-states.css   # Emotion-based styling
└── floating/
    └── floating-toolbar.css    # Floating elements
---
🎯 Success Metrics
Qualitative
- User Delight: "Wow, that's smooth!" moments
- Flow Maintenance: Never losing context during actions
- Discovery: Users discover features naturally without help
- Personality: Notes feel alive, distinct from each other
Quantitative
| Metric | Before | Target | Measure |
|---------|---------|---------|----------|
| Modal switches per session | ~5-10 | <2 | Telemetry |
| Time to find results | ~3s | <1s | Time measurement |
| Keyboard shortcuts usage | Unknown | >40% | Telemetry |
| Animation frame rate | 60fps | 60fps | Profiler |
| Initial load time | ~800ms | <500ms | Lighthouse |
| CSS bundle size | ~50KB | <40KB | Bundle analysis |
---
💡 Future Enhancements (Beyond Scope)
Phase 6: Advanced Features
1. Note Memory System
   - Remember user's preferences per note
   - "You usually ask for summaries on this note"
   - Adaptive quick actions
2. Proactive Intelligence
   - Floating suggestions in editor
   - "💡 This note mentions 'deadline'. Create task?"
   - Real-time link suggestions
3. Collaborative Agent Visualization
   - Animated lines between agents
   - "Context Builder → Link Finder: passing 20 candidates"
   - Agent dependency graph
4. Living Knowledge Graph Preview
   - Hover over linked note → mini graph
   - Animated nodes/lines
   - Relationship strength visualization
5. Voice Input
   - Web Speech API integration
   - Push-to-talk for chat
   - Hands-free brainstorming
---
🚀 Getting Started
Week 1: Sprint 1
1. Day 1-2: Quick wins
   - Extract shared Icon component
   - Fix "View Results" modal
   - Add note birth animation
2. Day 3-4: Keyboard system
   - Add global hotkey system
   - Implement HotkeyHelp overlay
   - Arrow key navigation
3. Day 5: Polish
   - Enhanced focus states
   - Stagger insight animations
   - Success feedback flashes
Week 2: Sprint 2
1. Day 1-3: Context-preserving
   - Inline agent results drawer
   - Floating quick actions toolbar
   - Search results overlay
2. Day 4-5: Design system
   - Enhanced design tokens
   - Color mixing utilities
   - Animation token usage
Week 3-4: Note Personality
1. Week 3: Core personality
   - Emotional state calculation
   - Dynamic pulse timeline
   - Emotion-aware colors
2. Week 4: Polish
   - Personality traits display
   - Note state persistence
   - Final polish and testing