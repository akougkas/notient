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
  const className = [
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

  return (
    <article
      ref={articleRef}
      class={className}
      data-proposal-id={item.id}
      aria-current={isFocused ? "true" : undefined}
    >
      <header class="notient-stream-item__head">
        <h4 class="notient-stream-item__title">{item.title}</h4>
        <div class="notient-stream-item__meta">
          <span class={`notient-stream-item__agent notient-stream-item__agent--${item.agent}`}>
            {item.agent}
          </span>
          <span class="notient-stream-item__type">{item.type}</span>
          <span class="notient-stream-item__confidence">{confidence}%</span>
        </div>
      </header>
      <p class="notient-stream-item__rationale">{item.rationale ?? "(no rationale)"}</p>
      <ul class="notient-stream-item__paths">
        {item.notePaths.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
      <footer class="notient-stream-item__actions">
        <button type="button" onClick={() => onOpen(item)}>
          Open
        </button>
        <button type="button" onClick={() => onAccept(item)}>
          Accept
        </button>
        <button type="button" onClick={() => onReject(item)}>
          Reject
        </button>
        {canPreviewCanvas ? (
          <button type="button" onClick={() => onPreviewCanvas(item)}>
            Preview as canvas
          </button>
        ) : null}
      </footer>
    </article>
  );
}
