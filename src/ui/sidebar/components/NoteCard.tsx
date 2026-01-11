/**
 * NoteCard - Note Identity Component (Section 1 of Note Vitals)
 *
 * Per spec: This represents the note's "living identity" - the Sentient Note philosophy.
 * Shows: title, path/folder, tags, note type, PARA classification
 */

import type { NoteVitals } from "../../../services/noteVitalsCalculator";
import { Icon } from "./Icon";
import { PulseTimeline } from "./PulseTimeline";

interface NoteCardProps {
  noteVitals: NoteVitals;
}

// Note type icons for the "Sentient Note" personality
const NOTE_TYPE_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
  research: { icon: "flask-conical", label: "Research", color: "var(--color-purple)" },
  journal: { icon: "book-open", label: "Journal", color: "var(--color-blue)" },
  project: { icon: "target", label: "Project", color: "var(--color-green)" },
  meeting: { icon: "users", label: "Meeting", color: "var(--color-orange)" },
  reference: { icon: "library", label: "Reference", color: "var(--text-muted)" },
  inbox: { icon: "inbox", label: "Inbox", color: "var(--color-yellow)" },
  unknown: { icon: "file-text", label: "Note", color: "var(--text-muted)" },
};

const PARA_CONFIG: Record<string, { icon: string; label: string }> = {
  projects: { icon: "target", label: "Projects" },
  areas: { icon: "home", label: "Areas" },
  resources: { icon: "book-open", label: "Resources" },
  archive: { icon: "archive", label: "Archive" },
  inbox: { icon: "inbox", label: "Inbox" },
  unknown: { icon: "help-circle", label: "" },
};

export function NoteCard({ noteVitals }: NoteCardProps) {
  const folder = extractFolder(noteVitals.path);
  // Use unknown as default since noteType may not exist on NoteVitals
  const noteTypeKey = (noteVitals as { noteType?: string }).noteType || "unknown";
  const noteType = NOTE_TYPE_CONFIG[noteTypeKey] || NOTE_TYPE_CONFIG.unknown;
  const paraType = PARA_CONFIG[noteVitals.paraType || "unknown"] || PARA_CONFIG.unknown;

  // Health state class for "Sentient Note" breathing animation
  const healthState = noteVitals.health?.status || "healthy";

  return (
    <article class={`nv2-note-card nv2-note-card--${healthState}`} aria-label="Note identity">
      {/* Note Type Badge - The "personality" indicator */}
      <div class="nv2-note-card-header">
        <span
          class="nv2-note-type-badge"
          style={{ "--type-color": noteType.color }}
          title={noteType.label}
        >
          <Icon name={noteType.icon} className="nv2-note-type-icon" />
          <span class="nv2-note-type-label">{noteType.label}</span>
        </span>
        {noteVitals.isIndexed && (
          <span class="nv2-indexed-badge" title="Indexed for semantic search">
            <span class="nv2-indexed-dot" />
            Indexed
          </span>
        )}
      </div>

      {/* Title - The note's "name" */}
      <h2 class="nv2-note-card-title">{noteVitals.title}</h2>

      {/* Location & Classification */}
      <div class="nv2-note-card-meta">
        <span class="nv2-meta-item nv2-meta-folder" title={noteVitals.path}>
          <Icon name="folder" className="nv2-meta-icon" />
          <span class="nv2-meta-text">{folder}</span>
        </span>
        {paraType.label && (
          <span class="nv2-meta-item nv2-meta-para">
            <Icon name={paraType.icon} className="nv2-meta-icon" />
            <span class="nv2-meta-text">{paraType.label}</span>
          </span>
        )}
      </div>

      {/* Tags - The note's "interests" */}
      <TagsRow tags={noteVitals.tags} />

      {/* Pulse Timeline - The note's "heartbeat" */}
      <PulseTimeline
        createdAt={noteVitals.lifecycle.createdAt}
        modifiedAt={noteVitals.lifecycle.modifiedAt}
        totalLinks={noteVitals.links.backlinks + noteVitals.links.outlinks}
        isIndexed={noteVitals.isIndexed}
        healthStatus={noteVitals.health.status}
      />
    </article>
  );
}

function extractFolder(path: string): string {
  if (!path.includes("/")) return "Root";
  const folder = path.substring(0, path.lastIndexOf("/"));
  // Truncate long paths from the beginning
  if (folder.length > 30) {
    return `...${folder.slice(-27)}`;
  }
  return folder || "Root";
}

interface TagsRowProps {
  tags: string[];
}

function TagsRow({ tags }: TagsRowProps) {
  const cleanTags = tags.map((t) => t.replace(/^#/, "")).filter(Boolean);
  if (cleanTags.length === 0) {
    return (
      <div class="nv2-note-card-tags nv2-note-card-tags--empty">
        <span class="nv2-tag nv2-tag--placeholder">No tags yet</span>
      </div>
    );
  }

  const visibleCount = 4;
  const visible = cleanTags.slice(0, visibleCount);
  const remaining = cleanTags.length - visibleCount;

  return (
    <div class="nv2-note-card-tags" role="list" aria-label="Tags">
      {visible.map((tag) => (
        <span key={tag} class="nv2-tag" role="listitem">
          #{tag}
        </span>
      ))}
      {remaining > 0 && (
        <span class="nv2-tag nv2-tag--more" title={cleanTags.slice(visibleCount).join(", ")}>
          +{remaining}
        </span>
      )}
    </div>
  );
}
