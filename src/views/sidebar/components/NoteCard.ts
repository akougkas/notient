/**
 * NoteCard - Displays note metadata (title, tags, links)
 *
 * Extracted from sidebar.ts for modularity.
 */

import { setIcon } from "obsidian";
import type { NoteVitals } from "../../../services/noteVitalsCalculator";

export class NoteCard {
  constructor(
    private noteVitals: NoteVitals,
    private backlinkPreview: string,
  ) {}

  render(container: HTMLElement): HTMLElement {
    const card = container.createDiv({ cls: "nv2-note-card" });

    // Title
    card.createDiv({
      cls: "nv2-note-card-title",
      text: this.noteVitals.title,
    });

    // Tags
    this.renderTags(card);

    // Links section
    const links = card.createDiv({ cls: "nv2-note-card-links" });
    this.renderLinkRow(links, "link", this.noteVitals.links.backlinks, "backlink", this.backlinkPreview);
    this.renderLinkRow(links, "arrow-right", this.noteVitals.links.outlinks, "outlink");

    return card;
  }

  private renderTags(card: HTMLElement): void {
    const tags = this.noteVitals.tags.map((t) => t.replace(/^#/, "")).filter(Boolean);
    if (tags.length === 0) return;

    const tagsRow = card.createDiv({ cls: "nv2-note-card-tags" });
    for (const tag of tags.slice(0, 5)) {
      tagsRow.createDiv({ cls: "nv2-tag", text: `#${tag}` });
    }
    if (tags.length > 5) {
      tagsRow.createDiv({ cls: "nv2-tag", text: `+${tags.length - 5}` });
    }
  }

  private renderLinkRow(
    container: HTMLElement,
    icon: string,
    count: number,
    label: string,
    preview?: string,
  ): void {
    const row = container.createDiv({ cls: "nv2-link-row" });
    const iconEl = row.createDiv({ cls: "nv2-link-row-icon" });
    setIcon(iconEl, icon);

    const content = row.createDiv({ cls: "nv2-link-row-content" });
    content.createDiv({
      cls: "nv2-link-row-label",
      text: `${count} ${label}${count !== 1 ? "s" : ""}`,
    });

    if (preview && count > 0) {
      content.createDiv({ cls: "nv2-link-row-preview", text: preview });
    }
  }
}
