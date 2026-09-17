/**
 * One palette for the whole surface, so no view invents its own colours.
 *
 * The palette is deliberately dark and its text colours assume a dark ground.
 * `bg` is therefore not decoration: `AppFrame` in `runtime.tsx` paints the
 * root box with it so the TUI reads the same way on a light terminal profile.
 */
export const COLOR = {
  bg: "#171B19",
  panel: "#202622",
  border: "#39443D",
  borderActive: "#A9C69B",
  label: "#B3BCAF",
  dim: "#89978B",
  text: "#DFE4DA",
  bright: "#F3F2E8",
  accent: "#BBD5A6",
  ok: "#A9C69B",
  warn: "#E2BD7D",
  bad: "#E79A8A",
  proposal: "#B9B5CF",
} as const;

/** Scrollbars live inside a panel's padded content column, never on its border. */
export const VERTICAL_SCROLLBAR_OPTIONS = {
  showArrows: false,
  trackOptions: {
    backgroundColor: COLOR.panel,
    foregroundColor: COLOR.border,
  },
} as const;

/** Vertical-only lists should not reserve a phantom row for a hidden x-axis. */
export const HORIZONTAL_SCROLLBAR_OPTIONS = { height: 0 } as const;

export function truncate(value: string, max: number): string {
  if (max <= 1) return value.slice(0, Math.max(0, max));
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Preserve both ends of paths and identifiers instead of losing the file. */
export function truncateMiddle(value: string, max: number): string {
  if (max <= 1) return truncate(value, max);
  if (value.length <= max) return value;
  const left = Math.ceil((max - 1) / 2);
  const right = Math.floor((max - 1) / 2);
  return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
}

/** Preserve a path's basename/extension when only its tail can be shown. */
export function truncatePath(value: string, max: number): string {
  if (max <= 1) return truncate(value, max);
  if (value.length <= max) return value;
  return `…${value.slice(value.length - (max - 1))}`;
}

/** Last path segment; the full path stays available for the detail panes. */
export function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function confidenceColor(confidence: number): string {
  if (confidence >= 0.8) return COLOR.ok;
  if (confidence >= 0.5) return COLOR.warn;
  return COLOR.bad;
}
/** Human labels for the established graph relation names. */
export function connectionLabel(table: string): string {
  if (table === "wikilink") return "link";
  if (table === "frontmatter_ref") return "property";
  if (table === "embed") return "embed";
  return table.replaceAll("_", " ");
}

export function connectionAssessment(table: string, proposed: boolean, assessment: number): string {
  if (proposed) return "idea";
  if (["wikilink", "embed", "frontmatter_ref"].includes(table)) return "file";
  return assessment.toFixed(2);
}
