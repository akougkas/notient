import { ItemView } from "obsidian";
import { render } from "preact";
import { App, footerState } from "./App";
import type { FooterEndpoint } from "./components/StatusFooter";

export const VIEW_TYPE_NOTIENT = "notient-sidebar";

export class NotientSidebarView extends ItemView {
  getViewType(): string {
    return VIEW_TYPE_NOTIENT;
  }

  getDisplayText(): string {
    return "Notient";
  }

  getIcon(): string {
    return "brain-circuit";
  }

  async onOpen(): Promise<void> {
    render(<App />, this.contentEl);
  }

  async onClose(): Promise<void> {
    render(null, this.contentEl);
  }

  static updateFooter(endpoints: FooterEndpoint[], noteCount: number): void {
    footerState.value = { endpoints, noteCount };
  }
}
