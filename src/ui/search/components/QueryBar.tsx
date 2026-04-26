import type { JSX } from "preact";
import type { SearchMode } from "../../../core/search/types";
import { searchActions, searchMode, searchQuery, searchRunning } from "../state";

const MODES: { value: SearchMode; label: string }[] = [
  { value: "quick", label: "Quick" },
  { value: "balanced", label: "Balanced" },
  { value: "deep", label: "Deep" },
];

export function QueryBar() {
  const running = searchRunning.value;
  const mode = searchMode.value;
  const query = searchQuery.value;

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
    <form class="notient-search-querybar" onSubmit={handleSubmit}>
      <input
        type="search"
        class="notient-search-querybar__input"
        placeholder="Search the vault"
        value={query}
        onInput={handleInput}
        aria-label="Search query"
      />
      <div class="notient-search-querybar__modes" aria-label="Search mode">
        {MODES.map((option) => {
          const isActive = mode === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={isActive}
              data-mode={option.value}
              class={`notient-search-mode${isActive ? " notient-search-mode--active" : ""}`}
              onClick={() => {
                searchMode.value = option.value;
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        class="notient-search-querybar__history"
        aria-label="Search history"
        disabled
      >
        History
      </button>
      {running ? (
        <button type="button" class="notient-search-querybar__cancel" onClick={handleCancel}>
          Cancel
        </button>
      ) : (
        <button type="submit" class="notient-search-querybar__run">
          Run
        </button>
      )}
    </form>
  );
}
