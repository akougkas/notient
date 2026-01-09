/**
 * Header Component - Locked Chrome
 *
 * Three-tab navigation: Note Vitals | Agent Streams | Chat
 * Per spec: Locked layout with Notient branding + tabs
 */

import type { Signal } from "@preact/signals";

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
	{ id: "note", label: "Note", icon: "📝", ariaLabel: "Note Vitals view" },
	{ id: "agents", label: "Agents", icon: "🤖", ariaLabel: "Agent Streams view" },
	{ id: "chat", label: "Chat", icon: "💬", ariaLabel: "Chat with Notient" },
];

export function Header({
	activeView,
	pendingReviewCount = 0,
	runningAgentsCount = 0,
}: HeaderProps) {
	return (
		<header class="nv2-header" role="banner">
			<div class="nv2-header-row">
				<div class="nv2-header-brand">
					<span class="nv2-brand-mark" aria-hidden="true">◆</span>
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
								<span class="nv2-tab-icon" aria-hidden="true">{tab.icon}</span>
								<span class="nv2-tab-label">{tab.label}</span>
								{showBadge && (
									<span
										class="nv2-tab-badge"
										aria-label={`${pendingReviewCount} pending reviews`}
									>
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
