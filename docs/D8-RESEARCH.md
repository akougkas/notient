# D8 Research: Editor Integration & Ghost Text

**Status**: Research & Planning
**Date**: 2026-01-13
**Context**: Deferred D8 task from Universe Completion phase.

## 1. Architecture: Strict Separation

The core architectural principle for Notient's editor integration is **strict separation** between the Preact-based Sidebar UI and the CodeMirror 6 (CM6) Editor.

*   **Sidebar (Preact)**: Owns the "Agent" and "Vitals" state. Reacts to signals.
*   **Editor (CM6)**: Owns the document state and decorations. Pure CM6 extension.
*   **Bridge**: `EventBus` and `Signals` serve as the communication layer, but they must be bridged correctly to avoiding tight coupling.

### The "No Preact in Editor" Rule
*   Do **NOT** mount Preact components inside CodeMirror widgets.
*   Widgets should be lightweight, vanilla DOM elements (`HTMLElement`).
*   Reasoning: Performance (CM6 redraws often) and complexity management.

## 2. Integration: Signals → CM6 StateField

The challenge is updating CM6 decorations (functional, immutable state) based on Preact Signals (mutable, reactive state).

### Recommended Pattern: "The Signal Bridge"

Do not read signals directly inside `StateField.update()`. Instead, use a listener that dispatches CM6 transactions when the signal changes.

```typescript
// 1. The Signal (e.g., in src/ui/sidebar/state.ts)
export const suggestionSignal = signal<string | null>(null);

// 2. The Bridge (in src/main.ts or a specialized service)
// When the signal changes, we need to tell the editor to update.
function setupBridge(editor: EditorView) {
  return effect(() => {
    const suggestion = suggestionSignal.value;
    
    // Dispatch a transaction to update the specific StateField
    editor.dispatch({
      effects: setGhostTextEffect.of(suggestion)
    });
  });
}

// 3. The StateField (in src/ui/editor/ghostText.ts)
const setGhostTextEffect = StateEffect.define<string | null>();

export const ghostTextField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGhostTextEffect)) {
        // Recompute decorations based on new value
        return effect.value ? createGhostTextDecoration(effect.value) : Decoration.none;
      }
    }
    // Map existing decorations (handle typing/deletions)
    return decorations.map(tr.changes);
  },
  provide: f => EditorView.decorations.from(f)
});
```

## 3. Ghost Text Implementation

Ghost text (like Copilot) should be implemented as an **inline widget** or **replaced decoration** (depending on if it overwrites or appends).

### Approach: `WidgetType`
For "grey text" that appears after the cursor:

```typescript
import { WidgetType, Decoration } from "@codemirror/view";

class GhostTextWidget extends WidgetType {
  constructor(readonly text: string) { super(); }

  toDOM() {
    const span = document.createElement("span");
    span.textContent = this.text;
    span.className = "cm-ghost-text"; // Style in styles.css
    span.style.opacity = "0.5";
    span.style.pointerEvents = "none";
    return span;
  }
}

function createGhostTextDecoration(text: string) {
  // Logic to find cursor position and place widget
  // usually at `state.selection.main.head`
  return Decoration.set([
    Decoration.widget({
      widget: new GhostTextWidget(text),
      side: 1 // Appears after cursor
    }).range(cursorPos)
  ]);
}
```

### Interaction (Tab to Accept)
Use a **Keymap** extension to intercept `Tab`.

```typescript
import { keymap } from "@codemirror/view";

export const ghostTextKeymap = keymap.of([
  {
    key: "Tab",
    run: (view) => {
      // Check if ghost text exists in state
      const ghostText = view.state.field(ghostTextField, false);
      // If active, insert text and clear decoration
      if (ghostText && ghostText.size > 0) {
        // Logic to insert text...
        return true; // Handled
      }
      return false; // Propagate
    }
  }
]);
```

## 4. Next Steps (When D8 Resumes)

1.  **Create `src/ui/editor/`**: Folder for CM6 extensions.
2.  **Define `ghostText.ts`**: Implement the StateField and Widget.
3.  **Define `editorBridge.ts`**: Service to subscribe to `suggestionSignal` and dispatch to active editor view.
4.  **Register in `main.ts`**: `this.registerEditorExtension([ghostTextField, ghostTextKeymap])`.
