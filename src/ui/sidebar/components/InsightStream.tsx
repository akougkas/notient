/**
 * InsightStream - AI Insights section (Section 4 of Note Vitals)
 *
 * Per spec: Rolling stream of AI-generated observations and suggestions
 * with priority levels (high, medium, low) and inline actions.
 */

import { setIcon } from "obsidian";
import { useCallback, useEffect, useRef } from "preact/hooks";
import type { Insight } from "../../../services/insightGenerator";

interface InsightStreamProps {
	insights: Insight[];
	onOpenFile: (path: string) => void;
}

// Priority icons and labels
const PRIORITY_CONFIG = {
	high: { icon: "●", label: "High Priority", className: "nv2-insight--high" },
	medium: { icon: "◐", label: "Suggestion", className: "nv2-insight--medium" },
	low: { icon: "○", label: "Info", className: "nv2-insight--low" },
};

export function InsightStream({ insights, onOpenFile }: InsightStreamProps) {
	// Sort insights by priority
	const sortedInsights = [...insights].sort((a, b) => {
		const order = { high: 0, medium: 1, low: 2 };
		return (order[a.priority] || 2) - (order[b.priority] || 2);
	});

	const highPriorityCount = insights.filter((i) => i.priority === "high").length;

	return (
		<section class="nv2-insight-section" aria-label="AI Insights">
			<h3 class="nv2-section-label">
				AI Insights
				{highPriorityCount > 0 && (
					<span class="nv2-insight-badge">{highPriorityCount}</span>
				)}
			</h3>
			<div class="nv2-insight-stream" role="feed" aria-busy="false">
				{sortedInsights.length === 0 ? (
					<InsightEmptyState />
				) : (
					sortedInsights.map((insight, index) => (
						<InsightItem
							key={insight.text + index}
							insight={insight}
							onOpenFile={onOpenFile}
							isFirst={index === 0}
						/>
					))
				)}
			</div>
		</section>
	);
}

function InsightEmptyState() {
	return (
		<div class="nv2-insight-empty">
			<span class="nv2-insight-empty-icon">💡</span>
			<span class="nv2-insight-empty-text">
				AI insights will appear here as Notient analyzes your note.
			</span>
		</div>
	);
}

interface InsightItemProps {
	insight: Insight;
	onOpenFile: (path: string) => void;
	isFirst?: boolean;
}

function InsightItem({ insight, onOpenFile, isFirst }: InsightItemProps) {
	const priority = insight.priority || "low";
	const config = PRIORITY_CONFIG[priority];

	const handleLinkClick = useCallback(() => {
		if (insight.linkPath) {
			onOpenFile(insight.linkPath);
		}
	}, [insight.linkPath, onOpenFile]);

	const handleActionClick = useCallback(() => {
		if (insight.actionCallback) {
			insight.actionCallback();
		}
	}, [insight.actionCallback]);

	return (
		<article
			class={`nv2-insight ${config.className} ${isFirst ? "nv2-insight--featured" : ""}`}
			role="article"
			aria-label={`${config.label}: ${insight.text}`}
		>
			<div class="nv2-insight-indicator" title={config.label}>
				<span class="nv2-insight-dot" aria-hidden="true">{config.icon}</span>
			</div>
			<div class="nv2-insight-body">
				<InsightText
					text={insight.text}
					linkText={insight.linkText}
					onLinkClick={handleLinkClick}
				/>
				{insight.action && (
					<InsightAction
						action={insight.action}
						icon={insight.actionIcon}
						primary={insight.actionPrimary || priority === "high"}
						onClick={handleActionClick}
					/>
				)}
			</div>
		</article>
	);
}

interface InsightTextProps {
	text: string;
	linkText?: string;
	onLinkClick: () => void;
}

function InsightText({ text, linkText, onLinkClick }: InsightTextProps) {
	if (!linkText) {
		return <p class="nv2-insight-text">{text}</p>;
	}

	const parts = text.split(linkText);
	return (
		<p class="nv2-insight-text">
			{parts[0]}
			<button
				type="button"
				class="nv2-insight-link"
				onClick={onLinkClick}
			>
				{linkText}
			</button>
			{parts[1]}
		</p>
	);
}

interface InsightActionProps {
	action: string;
	icon?: string;
	primary?: boolean;
	onClick: () => void;
}

function InsightAction({ action, icon, primary, onClick }: InsightActionProps) {
	const iconRef = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		if (iconRef.current && icon) {
			setIcon(iconRef.current, icon);
		}
	}, [icon]);

	return (
		<button
			type="button"
			class={`nv2-insight-action ${primary ? "nv2-insight-action--primary" : ""}`}
			onClick={onClick}
			aria-label={action}
		>
			{icon && <span class="nv2-insight-action-icon" ref={iconRef} aria-hidden="true" />}
			<span>{action}</span>
		</button>
	);
}
