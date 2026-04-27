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
    <nav class="notient-tabbar" role="tablist">
      {TABS.map((tab) => {
        const isActive = current === tab.id;
        const showBadge = tab.id === "stream" && pendingApprovals > 0;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-tab={tab.id}
            aria-current={isActive ? "page" : undefined}
            aria-selected={isActive}
            class="notient-tabbar__btn"
            onClick={() => setActiveTab(tab.id)}
          >
            <span class="notient-tabbar__label">{tab.label}</span>
            {showBadge ? (
              <span class="notient-tabbar__count" data-pulse="true">
                {pendingApprovals}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
