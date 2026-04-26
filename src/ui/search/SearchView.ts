import { ItemView } from "obsidian";
import { h, render } from "preact";
import { SearchApp } from "./SearchApp";

export const VIEW_TYPE_NOTIENT_SEARCH = "notient-search";

export class SearchView extends ItemView {
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
    render(h(SearchApp, null), mount);
  }

  override async onClose(): Promise<void> {
    const mount = this.containerEl.querySelector(".notient-search-mount") as HTMLElement | null;
    if (mount) {
      render(null, mount);
    }
  }
}
