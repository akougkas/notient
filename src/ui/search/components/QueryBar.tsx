import type { JSX } from "preact";
import { searchActions, searchFilters, searchQuery, searchRunning } from "../state";

export interface QueryBarProps {
  filtersOpen?: boolean;
  onToggleFilters?: () => void;
}

function countActiveFilters(): number {
  const filters = searchFilters.value;
  let count = 0;
  if (filters.maturity?.length) count += filters.maturity.length;
  if (filters.agents?.length) count += filters.agents.length;
  if (filters.connectivityTiers?.length) count += filters.connectivityTiers.length;
  if (filters.hasPendingProposals) count += 1;
  if (typeof filters.minConfidence === "number") count += 1;
  if (typeof filters.fromDate === "number") count += 1;
  if (typeof filters.toDate === "number") count += 1;
  if (filters.folders?.length) count += filters.folders.length;
  return count;
}

export function QueryBar({ filtersOpen = false, onToggleFilters }: QueryBarProps) {
  const running = searchRunning.value;
  const query = searchQuery.value;
  const filterCount = countActiveFilters();

  const handleInput = (event: JSX.TargetedEvent<HTMLInputElement>): void => {
    searchQuery.value = event.currentTarget.value;
  };

  const handleSubmit = (event: JSX.TargetedEvent<HTMLFormElement>): void => {
    event.preventDefault();
    searchActions.value?.runSearch();
  };

  const handleCancel = (): void => {
    searchActions.value?.cancelSearch();
  };

  return (
    <form class="notient-search__query notient-search-querybar" onSubmit={handleSubmit}>
      <input
        type="search"
        class="notient-search__field notient-search-querybar__input"
        placeholder="Search the vault..."
        value={query}
        onInput={handleInput}
        aria-label="Search query"
      />
      {onToggleFilters ? (
        <button
          type="button"
          class="notient-search__filters-pill"
          aria-expanded={filtersOpen}
          onClick={onToggleFilters}
        >
          Filters{filterCount > 0 ? ` (${filterCount})` : ""}
        </button>
      ) : null}
      {running ? (
        <button
          type="button"
          class="notient-button notient-search-querybar__cancel"
          data-emphasis="ghost"
          data-tone="danger"
          onClick={handleCancel}
        >
          Cancel
        </button>
      ) : (
        <button
          type="submit"
          class="notient-button notient-search-querybar__run"
          data-emphasis="primary"
        >
          Run
        </button>
      )}
    </form>
  );
}
