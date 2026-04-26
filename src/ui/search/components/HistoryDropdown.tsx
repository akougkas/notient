import { searchHistory } from "../state";

/**
 * Placeholder dropdown. Task 9 wires real history storage and pre-fill behavior;
 * for now this renders a disabled chip so the QueryBar layout is stable.
 */
export function HistoryDropdown() {
  const entries = searchHistory.value;
  return (
    <div class="notient-search-history" data-empty={entries.length === 0}>
      <button type="button" class="notient-search-history__trigger" disabled>
        History
      </button>
    </div>
  );
}
