/**
 * Root Preact component for Notient Sidebar
 * Tab-based layout: Vitals | Suggestions | Activity
 * Source of truth: .planning/PHASE-GALAXY.md (Phase G4)
 */

import { signal } from "@preact/signals";
import type { TFile } from "obsidian";
import { ActivityTab } from "./components/ActivityTab";
import { NavDeck } from "./components/NavDeck";
import { StatusFooter } from "./components/StatusFooter";
import { SuggestionsTab } from "./components/SuggestionsTab";
import { VitalsTab } from "./components/VitalsTab";
import type { SidebarTab, SystemStatus } from "./types";

/** Active tab state */
const activeTab = signal<SidebarTab>("vitals");

/** Currently active file - updated by SidebarView */
const activeFile = signal<TFile | null>(null);

/** System status - will be wired to EventBus in G6 */
const systemStatus = signal<SystemStatus>({
  connected: false,
  noteCount: 0,
  version: "0.1.0",
});

/**
 * Update the active file signal from SidebarView
 * Called when Obsidian's active leaf changes
 */
export function setActiveFile(file: TFile | null): void {
  activeFile.value = file;
}

export function App() {
  const currentTab = activeTab.value;

  return (
    <div class="nv2-app">
      <header class="nv2-header">
        <h1 class="nv2-header-title">Notient</h1>
      </header>

      <NavDeck activeTab={activeTab} />

      <main class="nv2-content">
        {currentTab === "vitals" && <VitalsTab activeFile={activeFile} />}
        {currentTab === "suggestions" && <SuggestionsTab />}
        {currentTab === "activity" && <ActivityTab />}
      </main>

      <StatusFooter status={systemStatus} />
    </div>
  );
}
