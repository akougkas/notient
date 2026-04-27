import { searchHistory, searchQuery } from "../state";

/**
 * Editorial dropdown listing recent queries. Saved-history wiring lives in
 * Task 9; this surface uses the same drawer chrome as the conversations list
 * so the QueryBar layout stays cohesive.
 */
export function HistoryDropdown() {
  const entries = searchHistory.value;
  const empty = entries.length === 0;
  return (
    <details class="notient-search-history notient-drawer" data-empty={empty}>
      <summary class="notient-search-history__trigger notient-drawer__head">
        <span>Recent</span>
      </summary>
      <ul class="notient-drawer__list">
        {entries.length === 0 ? (
          <li class="notient-drawer__item">
            <span class="notient-drawer__topic">No recent queries.</span>
          </li>
        ) : (
          entries.map((entry) => (
            <li key={entry} class="notient-drawer__item">
              <button
                type="button"
                class="notient-drawer__entry"
                onClick={() => {
                  searchQuery.value = entry;
                }}
              >
                <span class="notient-drawer__topic">{entry}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </details>
  );
}
