import { useEffect, useRef } from "preact/hooks";
import type { StreamItem } from "../../../core/stream/types";

export interface StreamItemCardProps {
  item: StreamItem;
  isFocused: boolean;
  onOpen: (item: StreamItem) => void;
  onAccept: (item: StreamItem) => void;
  onReject: (item: StreamItem) => void;
  onPreviewCanvas: (item: StreamItem) => void;
}

const AGENT_LABELS: Record<string, string> = {
  linker: "Linker",
  synthesizer: "Synthesizer",
  "contradiction-hunter": "Contradiction Hunter",
  contradictionHunter: "Contradiction Hunter",
  "maturity-advancer": "Maturity Advancer",
  maturityAdvancer: "Maturity Advancer",
  "co-author": "Co-author",
  coauthor: "Co-author",
};

const TYPE_LABELS: Record<string, string> = {
  supports: "supports",
  contradicts: "contradicts",
  related: "related",
  synthesis: "synthesis",
  links_to: "links to",
};

function prettyAgent(agent: string): string {
  return AGENT_LABELS[agent] ?? agent;
}

function prettyType(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

function normalizeAgent(agent: string): string {
  if (agent === "contradictionHunter") return "contradiction-hunter";
  if (agent === "maturityAdvancer") return "maturity-advancer";
  if (agent === "coauthor") return "co-author";
  return agent;
}

export function StreamItemCard({
  item,
  isFocused,
  onOpen,
  onAccept,
  onReject,
  onPreviewCanvas,
}: StreamItemCardProps) {
  const articleRef = useRef<HTMLElement | null>(null);
  const confidence = Math.round(item.confidence * 100);
  const canPreviewCanvas = item.kind === "node" && item.type === "synthesis";
  const isEdge = item.kind === "edge";
  const dataAgent = normalizeAgent(item.agent);
  // Retain the legacy class names so existing tests assert against them.
  const className = [
    "notient-card",
    "notient-stream-item",
    `notient-stream-item--${item.kind}`,
    isFocused ? "notient-stream-item--focused" : "",
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    if (!isFocused) return;
    articleRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [isFocused]);

  const visiblePaths = item.notePaths.slice(0, 3);

  return (
    <article
      ref={articleRef}
      class={className}
      data-agent={dataAgent}
      data-focused={isFocused ? "true" : "false"}
      data-proposal-id={item.id}
      aria-current={isFocused ? "true" : undefined}
    >
      <h3 class="notient-card__title">{item.title}</h3>
      <div class="notient-card__meta">
        <span class="notient-pip" data-agent={dataAgent}>
          {prettyAgent(item.agent)}
        </span>
        <span>{prettyType(item.type)}</span>
        <span class="notient-pip notient-pip--num">{confidence}%</span>
      </div>
      {item.rationale ? <p class="notient-card__rationale">{item.rationale}</p> : null}
      {visiblePaths.length > 0 ? (
        <ul class="notient-card__paths">
          {visiblePaths.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      ) : null}
      <footer class="notient-card__actions">
        <button
          type="button"
          class="notient-button"
          data-emphasis="ghost"
          onClick={() => onOpen(item)}
        >
          Open
        </button>
        {isEdge ? (
          <>
            <button type="button" class="notient-button" onClick={() => onAccept(item)}>
              Approve
            </button>
            <button
              type="button"
              class="notient-button"
              data-emphasis="ghost"
              data-tone="danger"
              onClick={() => onReject(item)}
            >
              Reject
            </button>
          </>
        ) : null}
        {canPreviewCanvas ? (
          <button type="button" class="notient-button" onClick={() => onPreviewCanvas(item)}>
            Preview canvas
          </button>
        ) : null}
      </footer>
    </article>
  );
}
