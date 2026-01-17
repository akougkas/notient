/**
 * Vitals Tab - Note health display
 * Shows note maturity, health score, links, and Enhance button
 * Reactive to active note changes
 */

import type { Signal } from "@preact/signals";
import type { TFile } from "obsidian";
import { kernel } from "../../../core/kernel";

interface VitalsTabProps {
  activeFile: Signal<TFile | null>;
}

/** Derive I-PARA category from folder path */
function deriveIpara(path: string): string {
  const folder = path.split("/")[0]?.toLowerCase() ?? "";
  const iparaMap: Record<string, string> = {
    inbox: "Inbox",
    projects: "Projects",
    areas: "Areas",
    resources: "Resources",
    archive: "Archive",
  };
  return iparaMap[folder] ?? "Uncategorized";
}

/** Get link counts from Obsidian metadataCache */
function getLinkCounts(file: TFile): { inbound: number; outbound: number } {
  const facade = kernel.get("obsidianFacade");
  const links = facade.getLinks(file);
  return {
    inbound: links.inbound.length,
    outbound: links.outbound.length,
  };
}

export function VitalsTab({ activeFile }: VitalsTabProps) {
  const file = activeFile.value;

  const handleEnhance = () => {
    if (!file) return;
    const eventBus = kernel.get("eventBus");
    eventBus.emit("enhance:start", {
      noteId: file.path,
      timestamp: Date.now(),
    });
  };

  // No active file - show placeholder
  if (!file) {
    return (
      <section class="nv2-tab nv2-vitals-tab" role="tabpanel" aria-label="Note Vitals">
        <section class="nv2-section">
          <h2 class="nv2-section-title">Note Vitals</h2>
          <p class="nv2-section-subtitle">Open a note to see its health</p>
        </section>

        <section class="nv2-section nv2-vitals-grid">
          <div class="nv2-vital-card">
            <span class="nv2-vital-label">Health</span>
            <span class="nv2-vital-value">--</span>
          </div>
          <div class="nv2-vital-card">
            <span class="nv2-vital-label">Links</span>
            <span class="nv2-vital-value">-- in / -- out</span>
          </div>
          <div class="nv2-vital-card">
            <span class="nv2-vital-label">Maturity</span>
            <span class="nv2-vital-value">--</span>
          </div>
          <div class="nv2-vital-card">
            <span class="nv2-vital-label">I-PARA</span>
            <span class="nv2-vital-value">--</span>
          </div>
        </section>

        <section class="nv2-section">
          <button type="button" class="nv2-enhance-button" disabled>
            Enhance
          </button>
          <p class="nv2-section-hint">Last enhanced: Never</p>
        </section>
      </section>
    );
  }

  // Active file - show vitals
  const links = getLinkCounts(file);
  const ipara = deriveIpara(file.path);

  return (
    <section class="nv2-tab nv2-vitals-tab" role="tabpanel" aria-label="Note Vitals">
      <section class="nv2-section">
        <h2 class="nv2-section-title">{file.basename}</h2>
        <p class="nv2-section-subtitle">Note health and insights</p>
      </section>

      <section class="nv2-section nv2-vitals-grid">
        <div class="nv2-vital-card">
          <span class="nv2-vital-label">Health</span>
          <span class="nv2-vital-value">75%</span>
        </div>
        <div class="nv2-vital-card">
          <span class="nv2-vital-label">Links</span>
          <span class="nv2-vital-value">
            {links.inbound} in / {links.outbound} out
          </span>
        </div>
        <div class="nv2-vital-card">
          <span class="nv2-vital-label">Maturity</span>
          <span class="nv2-vital-value">Unknown</span>
        </div>
        <div class="nv2-vital-card">
          <span class="nv2-vital-label">I-PARA</span>
          <span class="nv2-vital-value">{ipara}</span>
        </div>
      </section>

      <section class="nv2-section">
        <button type="button" class="nv2-enhance-button" onClick={handleEnhance}>
          Enhance
        </button>
        <p class="nv2-section-hint">Last enhanced: Never</p>
      </section>
    </section>
  );
}
