import type { SearchHit } from "../../../core/search/types";

export interface ResultRowProps {
  hit: SearchHit;
  selected: boolean;
  onHover: (notePath: string) => void;
  onOpen: (notePath: string) => void;
}

const AGENT_LABELS: Record<string, string> = {
  linker: "Linker",
  synthesizer: "Synthesizer",
  contradictionHunter: "Contradiction Hunter",
  "contradiction-hunter": "Contradiction Hunter",
  maturityAdvancer: "Maturity Advancer",
  "maturity-advancer": "Maturity Advancer",
  coauthor: "Co-author",
  "co-author": "Co-author",
};

function normalizeAgent(agent: string): string {
  if (agent === "contradictionHunter") return "contradiction-hunter";
  if (agent === "maturityAdvancer") return "maturity-advancer";
  if (agent === "coauthor") return "co-author";
  return agent;
}

export function ResultRow({ hit, selected, onHover, onOpen }: ResultRowProps) {
  const confidence = clampUnit(hit.score);
  const confidencePct = Math.round(confidence * 100);
  const breadcrumb = breadcrumbFromPath(hit.notePath);
  const dominantAgent = hit.agentTags && hit.agentTags.length > 0 ? hit.agentTags[0] : undefined;
  const agentNormalized = dominantAgent ? normalizeAgent(dominantAgent) : undefined;
  const agentLabel = dominantAgent ? (AGENT_LABELS[dominantAgent] ?? dominantAgent) : null;
  return (
    <button
      type="button"
      class={`notient-result notient-result-row${selected ? " notient-result-row--selected" : ""}`}
      data-note-path={hit.notePath}
      aria-pressed={selected}
      aria-selected={selected ? "true" : "false"}
      onMouseEnter={() => onHover(hit.notePath)}
      onFocus={() => onHover(hit.notePath)}
      onClick={() => onOpen(hit.notePath)}
    >
      <h3 class="notient-result__title notient-result-row__title">{titleFromPath(hit.notePath)}</h3>
      <div class="notient-result__breadcrumb notient-result-row__breadcrumb">{breadcrumb}</div>
      <p class="notient-result__snippet notient-result-row__snippet">{hit.snippet}</p>
      <div class="notient-result__meta notient-result-row__meta">
        {agentLabel ? (
          <span class="notient-pip" data-agent={agentNormalized}>
            {agentLabel}
          </span>
        ) : null}
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
        <span class="notient-pip notient-pip--num notient-result-row__confidence">
          {confidencePct}%
        </span>
      </div>
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
