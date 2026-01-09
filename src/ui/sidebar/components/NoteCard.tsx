/**
 * NoteCard - Preact component displaying note metadata
 *
 * Shows: title, tags, backlinks, outlinks
 */

import { setIcon } from "obsidian";
import { useEffect, useRef } from "preact/hooks";
import type { NoteVitals } from "../../../services/noteVitalsCalculator";

interface NoteCardProps {
	noteVitals: NoteVitals;
	backlinkPreview?: string;
}

export function NoteCard({ noteVitals, backlinkPreview = "" }: NoteCardProps) {
	return (
		<div class="nv2-note-card">
			{/* Title */}
			<div class="nv2-note-card-title">{noteVitals.title}</div>

			{/* Tags */}
			<TagsRow tags={noteVitals.tags} />

			{/* Links */}
			<div class="nv2-note-card-links">
				<LinkRow
					icon="link"
					count={noteVitals.links.backlinks}
					label="backlink"
					preview={backlinkPreview}
				/>
				<LinkRow
					icon="arrow-right"
					count={noteVitals.links.outlinks}
					label="outlink"
				/>
			</div>
		</div>
	);
}

interface TagsRowProps {
	tags: string[];
}

function TagsRow({ tags }: TagsRowProps) {
	const cleanTags = tags.map((t) => t.replace(/^#/, "")).filter(Boolean);
	if (cleanTags.length === 0) return null;

	return (
		<div class="nv2-note-card-tags">
			{cleanTags.slice(0, 5).map((tag) => (
				<div key={tag} class="nv2-tag">
					#{tag}
				</div>
			))}
			{cleanTags.length > 5 && (
				<div class="nv2-tag">+{cleanTags.length - 5}</div>
			)}
		</div>
	);
}

interface LinkRowProps {
	icon: string;
	count: number;
	label: string;
	preview?: string;
}

function LinkRow({ icon, count, label, preview }: LinkRowProps) {
	const iconRef = useRef<HTMLDivElement>(null);

	// Use Obsidian's setIcon after mount
	useEffect(() => {
		if (iconRef.current) {
			setIcon(iconRef.current, icon);
		}
	}, [icon]);

	return (
		<div class="nv2-link-row">
			<div class="nv2-link-row-icon" ref={iconRef} />
			<div class="nv2-link-row-content">
				<div class="nv2-link-row-label">
					{count} {label}
					{count !== 1 ? "s" : ""}
				</div>
				{preview && count > 0 && (
					<div class="nv2-link-row-preview">{preview}</div>
				)}
			</div>
		</div>
	);
}
