import type { StreamItem } from "../../../core/stream/types";

export interface StreamItemCardProps {
  item: StreamItem;
  onOpen: (item: StreamItem) => void;
  onAccept: (item: StreamItem) => void;
  onReject: (item: StreamItem) => void;
}

export function StreamItemCard({ item, onOpen, onAccept, onReject }: StreamItemCardProps) {
  const confidence = Math.round(item.confidence * 100);
  return (
    <article class={`notient-stream-item notient-stream-item--${item.kind}`}>
      <header class="notient-stream-item__head">
        <span class={`notient-stream-item__agent notient-stream-item__agent--${item.agent}`}>
          {item.agent}
        </span>
        <span class="notient-stream-item__type">{item.type}</span>
        <span class="notient-stream-item__confidence">{confidence}%</span>
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
      </footer>
    </article>
  );
}
