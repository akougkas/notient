/**
 * Suggestions Tab - Enhancement suggestion checklist
 * Shows suggestions from pipeline, expandable for preview/reasoning
 * Placeholder implementation - will be wired in G6
 */

import { signal } from "@preact/signals";
import type { EnhancementSuggestion } from "../../../types";

/** Placeholder suggestions - will come from pipeline in G6 */
const suggestions = signal<EnhancementSuggestion[]>([]);
const selectedIds = signal<Set<string>>(new Set());
const expandedIds = signal<Set<string>>(new Set());

export function SuggestionsTab() {
  const items = suggestions.value;
  const selected = selectedIds.value;
  const expanded = expandedIds.value;
  const selectedCount = selected.size;

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    selectedIds.value = next;
  };

  const toggleExpand = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    expandedIds.value = next;
  };

  const selectAll = () => {
    selectedIds.value = new Set(items.map((s) => s.id));
  };

  const dismissAll = () => {
    suggestions.value = [];
    selectedIds.value = new Set();
  };

  return (
    <div class="nv2-tab nv2-suggestions-tab" role="tabpanel" aria-label="Suggestions">
      <section class="nv2-section">
        <div class="nv2-section-header">
          <h2 class="nv2-section-title">Suggestions</h2>
          <span class="nv2-badge">{items.length} pending</span>
        </div>
      </section>

      {items.length === 0 ? (
        <section class="nv2-section nv2-empty-state">
          <p>No suggestions yet.</p>
          <p class="nv2-section-hint">Run Enhance on a note to get suggestions.</p>
        </section>
      ) : (
        <>
          <ul class="nv2-suggestion-list">
            {items.map((suggestion) => {
              const isSelected = selected.has(suggestion.id);
              const isExpanded = expanded.has(suggestion.id);

              return (
                <li key={suggestion.id} class="nv2-suggestion-item">
                  <div class="nv2-suggestion-row">
                    <label class="nv2-checkbox-label">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(suggestion.id)}
                        class="nv2-checkbox"
                      />
                      <span class="nv2-suggestion-description">{suggestion.description}</span>
                    </label>
                    <button
                      type="button"
                      class="nv2-expand-button"
                      onClick={() => toggleExpand(suggestion.id)}
                      aria-expanded={isExpanded}
                      aria-label={isExpanded ? "Collapse" : "Expand"}
                    >
                      {isExpanded ? "▲" : "▼"}
                    </button>
                  </div>

                  {isExpanded && (
                    <div class="nv2-suggestion-details">
                      <div class="nv2-suggestion-type">Type: {suggestion.type}</div>
                      <div class="nv2-suggestion-preview">Preview: {suggestion.preview}</div>
                      {suggestion.metadata.reasoning && (
                        <div class="nv2-suggestion-reasoning">
                          Reasoning: {suggestion.metadata.reasoning}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <section class="nv2-section nv2-suggestion-actions">
            <button
              type="button"
              class="nv2-button nv2-button--primary"
              disabled={selectedCount === 0}
            >
              Apply Selected ({selectedCount})
            </button>
            <button type="button" class="nv2-button" onClick={selectAll}>
              Select All
            </button>
            <button type="button" class="nv2-button" onClick={dismissAll}>
              Dismiss All
            </button>
          </section>
        </>
      )}
    </div>
  );
}
