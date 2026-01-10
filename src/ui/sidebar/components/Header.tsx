/**
 * Header Component - Locked Chrome
 *
 * Three-tab navigation: Note Vitals | Agent Streams | Chat
 * Per spec: Locked layout with Notient branding + tabs
 */

import type { Signal } from "@preact/signals";
import { setIcon } from "obsidian";
import { useEffect, useRef } from "preact/hooks";

export type SidebarView = "note" | "agents" | "chat";

interface HeaderProps {
  activeView: Signal<SidebarView>;
  pendingReviewCount?: number;
  runningAgentsCount?: number;
}

const TABS: Array<{
  id: SidebarView;
  label: string;
  icon: string;
  ariaLabel: string;
}> = [
  { id: "note", label: "Note", icon: "file-text", ariaLabel: "Note Vitals view" },
  { id: "agents", label: "Agents", icon: "bot", ariaLabel: "Agent Streams view" },
  { id: "chat", label: "Chat", icon: "message-circle", ariaLabel: "Chat with Notient" },
];

// Icon component for Lucide icons in Preact
function Icon({ name, className }: { name: string; className?: string }) {
  const iconRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, name);
    }
  }, [name]);
  return <span ref={iconRef} class={className} aria-hidden="true" />;
}

// Brand icon component
function BrandIcon() {
  const iconRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, "sparkles");
    }
  }, []);
  return <span ref={iconRef} class="nv2-brand-mark" aria-hidden="true" />;
}

export function Header({
  activeView,
  pendingReviewCount = 0,
  runningAgentsCount = 0,
}: HeaderProps) {
  return (
    <header class="nv2-header" role="banner">
      <div class="nv2-header-row">
        <div class="nv2-header-brand">
          <BrandIcon />
          <span class="nv2-brand-name">Notient</span>
        </div>
        <nav class="nv2-tabs" role="tablist" aria-label="Sidebar views">
          {TABS.map((tab) => {
            const isActive = activeView.value === tab.id;
            const showBadge = tab.id === "agents" && pendingReviewCount > 0;
            const showPulse = tab.id === "agents" && runningAgentsCount > 0;

            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-label={tab.ariaLabel}
                class={`nv2-tab ${isActive ? "nv2-tab--active" : ""} ${showPulse ? "nv2-tab--pulse" : ""}`}
                onClick={() => (activeView.value = tab.id)}
              >
                <Icon name={tab.icon} className="nv2-tab-icon" />
                <span class="nv2-tab-label">{tab.label}</span>
                {showBadge && (
                  <span class="nv2-tab-badge" aria-label={`${pendingReviewCount} pending reviews`}>
                    {pendingReviewCount > 9 ? "9+" : pendingReviewCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
