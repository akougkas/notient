/**
 * Tab navigation component for sidebar
 * Three tabs: Vitals | Suggestions | Activity
 */

import type { Signal } from "@preact/signals";
import type { SidebarTab } from "../types";

interface NavDeckProps {
  activeTab: Signal<SidebarTab>;
}

const TABS: Array<{ id: SidebarTab; label: string }> = [
  { id: "vitals", label: "Vitals" },
  { id: "suggestions", label: "Suggestions" },
  { id: "activity", label: "Activity" },
];

export function NavDeck({ activeTab }: NavDeckProps) {
  return (
    <>
      {TABS.map((tab) => {
        const isActive = activeTab.value === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            class={`nv2-header-tab ${isActive ? "nv2-header-tab--active" : ""}`}
            aria-selected={isActive}
            onClick={() => {
              activeTab.value = tab.id;
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </>
  );
}
