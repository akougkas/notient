import { ItemView } from "obsidian";
import { h, render } from "preact";
import type { SearchMode } from "../../core/search/types";
import { SearchApp } from "./SearchApp";
import {
  type SearchAppActions,
  type SearchRunner,
  searchActions,
  searchMode,
  searchQuery,
  setSearchRunner,
} from "./state";

export const VIEW_TYPE_NOTIENT_SEARCH = "notient-search";

export interface SearchViewBindings {
  runner: SearchRunner;
  actions: SearchAppActions;
}

export class SearchView extends ItemView {
  private static pendingMode: SearchMode | null = null;
  private static pendingQuery: string | null = null;

  /**
   * Wires the SearchView to the live runtime. main.ts (Task 16) calls this
   * once after the SearchPipeline + SavedQueries + canvas exporter are
   * registered. Tests can stub it to avoid booting any kernel slice.
   */
  static configure(bindings: SearchViewBindings): void {
    setSearchRunner(bindings.runner);
    searchActions.value = bindings.actions;
  }

  /**
   * Seeds the next opened SearchView leaf with a mode (and optional query).
   * Used by the command palette entries (`notient-search-quick` etc.) so
   * opening a fresh leaf lands in the requested mode.
   */
  static prime(mode: SearchMode, query?: string): void {
    SearchView.pendingMode = mode;
    SearchView.pendingQuery = query ?? null;
  }

  getViewType(): string {
    return VIEW_TYPE_NOTIENT_SEARCH;
  }

  getDisplayText(): string {
    return "Notient Search";
  }

  getIcon(): string {
    return "search";
  }

  override async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement | undefined;
    const target = root ?? this.contentEl;
    target.empty();
    const mount = target.createDiv({ cls: "notient-search-mount" });
    if (SearchView.pendingMode) {
      searchMode.value = SearchView.pendingMode;
      SearchView.pendingMode = null;
    }
    if (SearchView.pendingQuery !== null) {
      searchQuery.value = SearchView.pendingQuery;
      SearchView.pendingQuery = null;
    }
    render(h(SearchApp, null), mount);
  }

  override async onClose(): Promise<void> {
    const mount = this.containerEl.querySelector(".notient-search-mount") as HTMLElement | null;
    if (mount) {
      render(null, mount);
    }
  }
}
