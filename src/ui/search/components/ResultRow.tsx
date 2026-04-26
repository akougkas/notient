import type { SearchHit } from "../../../core/search/types";

export interface ResultRowProps {
  hit: SearchHit;
  selected: boolean;
  onHover: (notePath: string) => void;
  onOpen: (notePath: string) => void;
}

export function ResultRow({ hit, selected, onHover, onOpen }: ResultRowProps) {
  const confidence = clampUnit(hit.score);
  const confidencePct = Math.round(confidence * 100);
  const breadcrumb = breadcrumbFromPath(hit.notePath);
  return (
    <button
      type="button"
      class={`notient-result-row${selected ? " notient-result-row--selected" : ""}`}
      data-note-path={hit.notePath}
      aria-pressed={selected}
      onMouseEnter={() => onHover(hit.notePath)}
      onFocus={() => onHover(hit.notePath)}
      onClick={() => onOpen(hit.notePath)}
    >
      <span class="notient-result-row__head">
        <span class="notient-result-row__title">{titleFromPath(hit.notePath)}</span>
        <span class="notient-result-row__breadcrumb">{breadcrumb}</span>
      </span>
      <span class="notient-result-row__snippet">{hit.snippet}</span>
      <span class="notient-result-row__meta">
        {hit.maturity ? (
          <span
            class={`notient-result-row__badge notient-result-row__badge--maturity-${hit.maturity}`}
          >
            {hit.maturity}
          </span>
        ) : null}
        {hit.vitalsTier ? (
          <span
            class={`notient-result-row__badge notient-result-row__badge--connectivity-${hit.vitalsTier}`}
          >
            {hit.vitalsTier}
          </span>
        ) : null}
        {hit.agentTags?.map((tag) => (
          <span key={tag} class="notient-result-row__chip">
            {tag}
          </span>
        ))}
        <span class="notient-result-row__confidence" aria-label="Confidence">
          <span class="notient-result-row__confidence-bar" style={{ width: `${confidencePct}%` }} />
          <span class="notient-result-row__confidence-text">{confidencePct}%</span>
        </span>
      </span>
    </button>
  );
}

function clampUnit(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function titleFromPath(path: string): string {
  const stripped = path.replace(/^\/+/, "");
  const last = stripped.split("/").pop() ?? stripped;
  return last.replace(/\.md$/, "");
}

function breadcrumbFromPath(path: string): string {
  const stripped = path.replace(/^\/+/, "");
  const segments = stripped.split("/");
  if (segments.length <= 1) return "";
  return segments.slice(0, -1).join(" / ");
}
