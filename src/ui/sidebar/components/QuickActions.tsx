/**
 * QuickActions - Quick action buttons (Section 3 of Note Vitals)
 *
 * Per spec: 6 smart-filtered actions based on note state
 * [🔍 Find Connections] [✨ Enrich Note] [🔗 Link Ideas]
 * [📝 Summarize] [🏷️ Suggest Tags] [📋 Extract Tasks]
 */

import { setIcon } from "obsidian";
import { useCallback, useEffect, useRef } from "preact/hooks";

export interface QuickAction {
	id: string;
	icon: string;
	label: string;
	primary: boolean;
	description?: string;
	onClick: () => void;
}

interface QuickActionsProps {
	actions: QuickAction[];
}

export function QuickActions({ actions }: QuickActionsProps) {
	return (
		<section class="nv2-quick-actions-section" aria-label="Quick actions">
			<h3 class="nv2-section-label">Quick Actions</h3>
			<div class="nv2-quick-actions" role="toolbar" aria-label="Note actions">
				{actions.map((action) => (
					<ActionButton key={action.id} action={action} />
				))}
			</div>
		</section>
	);
}

interface ActionButtonProps {
	action: QuickAction;
}

function ActionButton({ action }: ActionButtonProps) {
	const iconRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (iconRef.current) {
			setIcon(iconRef.current, action.icon);
		}
	}, [action.icon]);

	const handleClick = useCallback(() => {
		action.onClick();
	}, [action.onClick]);

	return (
		<button
			type="button"
			class={`nv2-quick-action ${action.primary ? "nv2-quick-action--primary" : ""}`}
			onClick={handleClick}
			title={action.description || action.label}
			aria-label={action.description || action.label}
		>
			<span class="nv2-quick-action-icon" ref={iconRef} aria-hidden="true" />
			<span class="nv2-quick-action-label">{action.label}</span>
		</button>
	);
}

/**
 * Factory function to create standard quick actions for a note
 * Per spec: 6 actions, smart-filtered to show 4-6 most relevant
 */
export function createNoteQuickActions(
	noteTitle: string,
	prefillChatAndSwitch: (prompt: string) => void,
): QuickAction[] {
	return [
		{
			id: "find-connections",
			icon: "search",
			label: "Find",
			primary: true,
			description: "Find related notes",
			onClick: () =>
				prefillChatAndSwitch(
					`Find notes semantically related to "${noteTitle}" and explain the connections`,
				),
		},
		{
			id: "enrich",
			icon: "sparkles",
			label: "Enrich",
			primary: false,
			description: "Enrich with context",
			onClick: () =>
				prefillChatAndSwitch(
					`Enrich and expand "${noteTitle}" with additional context, examples, and insights`,
				),
		},
		{
			id: "link-ideas",
			icon: "link",
			label: "Link",
			primary: false,
			description: "Suggest links",
			onClick: () =>
				prefillChatAndSwitch(
					`Suggest internal wiki-links to add to "${noteTitle}" that connect it to related notes`,
				),
		},
		{
			id: "summarize",
			icon: "file-text",
			label: "Summary",
			primary: false,
			description: "Generate summary",
			onClick: () =>
				prefillChatAndSwitch(
					`Create a concise summary of "${noteTitle}" that captures the key points`,
				),
		},
		{
			id: "suggest-tags",
			icon: "tag",
			label: "Tags",
			primary: false,
			description: "Suggest tags",
			onClick: () =>
				prefillChatAndSwitch(
					`Suggest relevant tags for "${noteTitle}" based on its content and themes`,
				),
		},
		{
			id: "extract-tasks",
			icon: "check-square",
			label: "Tasks",
			primary: false,
			description: "Extract tasks",
			onClick: () =>
				prefillChatAndSwitch(
					`Extract any actionable items or tasks mentioned in "${noteTitle}"`,
				),
		},
	];
}
