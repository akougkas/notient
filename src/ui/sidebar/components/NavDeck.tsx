import type { Signal } from "@preact/signals";
import type { AgentStatus, SidebarView } from "../types";
import { Icon } from "./Icon";

interface NavDeckProps {
  activeView: Signal<SidebarView>;
  agentStatus: Signal<AgentStatus>;
}

const TABS: Array<{
  id: SidebarView;
  label: string;
  icon: string;
}> = [
  { id: "note", label: "Note", icon: "file-text" },
  { id: "agents", label: "Agents", icon: "bot" },
  { id: "chat", label: "Chat", icon: "message-circle" },
];

export function NavDeck({ activeView, agentStatus }: NavDeckProps) {
  const { runningCount, pendingReviewCount } = agentStatus.value;

  return (
    <nav class="nv2-nav-deck" aria-label="Main Navigation">
      {TABS.map((tab) => {
        const isActive = activeView.value === tab.id;
        const isAgents = tab.id === "agents";

        // Agent notifications
        const showBadge = isAgents && pendingReviewCount > 0;
        const isRunning = isAgents && runningCount > 0;

        return (
          <button
            key={tab.id}
            type="button"
            class={`nv2-nav-item ${isActive ? "nv2-nav-item--active" : ""} ${isRunning ? "nv2-nav-item--pulse" : ""}`}
            onClick={() => (activeView.value = tab.id)}
            aria-selected={isActive}
            aria-current={isActive ? "page" : undefined}
            role="tab"
            title={`${tab.label} View`}
          >
            <div class="nv2-nav-icon-wrapper">
              <Icon name={tab.icon} className="nv2-nav-icon" />
              {showBadge && (
                <span class="nv2-nav-badge">
                  {pendingReviewCount > 9 ? "9+" : pendingReviewCount}
                </span>
              )}
            </div>
            <span class="nv2-nav-label">{tab.label}</span>
            {isActive && <div class="nv2-nav-glow" />}
          </button>
        );
      })}
    </nav>
  );
}
