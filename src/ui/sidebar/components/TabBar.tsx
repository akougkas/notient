import { type SidebarTab, activeTab, setActiveTab } from "../state";

interface TabDefinition {
  id: SidebarTab;
  label: string;
}

const TABS: TabDefinition[] = [
  { id: "stream", label: "Stream" },
  { id: "vitals", label: "Vitals" },
  { id: "chat", label: "Chat" },
];

export interface TabBarProps {
  pendingApprovals: number;
}

export function TabBar({ pendingApprovals }: TabBarProps) {
  const current = activeTab.value;
  return (
    <nav class="notient-tabs" role="tablist">
      {TABS.map((tab) => {
        const isActive = current === tab.id;
        const showBadge = tab.id === "stream" && pendingApprovals > 0;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-tab={tab.id}
            class={`notient-tab${isActive ? " notient-tab--active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span class="notient-tab__label">{tab.label}</span>
            {showBadge ? <span class="notient-tab__badge">{pendingApprovals}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
