/**
 * Vitals Tab - Note health display
 * Shows note maturity, health score, links, and Enhance button
 * Placeholder implementation - will be wired in G6
 */

import type { Signal } from "@preact/signals";
import type { TFile } from "obsidian";

interface VitalsTabProps {
  activeFile: Signal<TFile | null>;
}

export function VitalsTab({ activeFile }: VitalsTabProps) {
  const file = activeFile.value;
  return (
    <section class="nv2-tab nv2-vitals-tab" role="tabpanel" aria-label="Note Vitals">
      <section class="nv2-section">
        <h2 class="nv2-section-title">Note Vitals</h2>
        <p class="nv2-section-subtitle">{file ? file.basename : "Open a note to see its health"}</p>
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
