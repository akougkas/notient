import type { Signal } from "@preact/signals";
import { tickState } from "../App";

export interface FooterEndpoint {
  label: string;
  ok: boolean;
  kind?: "chat" | "embedding";
  latencyMs?: number;
}

export interface FooterIndexerState {
  processed: number;
  total: number;
  queueDepth: number;
  etaSeconds: number | null;
}

export interface FooterActivity {
  agent: string;
  startedAt: number;
}

export interface FooterState {
  endpoints: FooterEndpoint[];
  noteCount: number;
  indexer?: FooterIndexerState;
  currentActivity?: FooterActivity;
}

function pipKindFor(kind: FooterEndpoint["kind"], ok: boolean): string {
  if (!ok) return "contradiction-hunter";
  if (kind === "chat") return "co-author";
  if (kind === "embedding") return "linker";
  return "synthesizer";
}

function formatSeconds(elapsed: number): string {
  if (elapsed < 0) return "0s";
  return `${Math.floor(elapsed)}s`;
}

export function StatusFooter({ state }: { state: Signal<FooterState> }) {
  const current = state.value;
  // Re-read tick so the activity row updates every second while a run is in flight.
  const tick = tickState.value;
  void tick;

  const chat = current.endpoints.find((endpoint) => endpoint.kind === "chat") ?? null;
  const embedding = current.endpoints.find((endpoint) => endpoint.kind === "embedding") ?? null;
  const fallbackEndpoints =
    chat || embedding
      ? []
      : current.endpoints.filter(
          (endpoint) => endpoint.kind !== "chat" && endpoint.kind !== "embedding",
        );
  const indexer = current.indexer;
  const activity = current.currentActivity;

  const indexerLabel = (() => {
    if (!indexer) {
      return `Awake. ${current.noteCount} notes indexed.`;
    }
    if (indexer.total > 0 && indexer.processed < indexer.total) {
      return `Indexing... ${indexer.processed}/${indexer.total}`;
    }
    return `Awake. ${indexer.total || current.noteCount} notes indexed.`;
  })();

  return (
    <div class="notient-status">
      {chat ? (
        <div class="notient-status__row">
          <span class="notient-pip" data-agent={pipKindFor(chat.kind, chat.ok)}>
            chat
          </span>
          <span class="notient-status__main" title={chat.label}>
            {chat.label}
          </span>
          {typeof chat.latencyMs === "number" ? (
            <span class="notient-status__aux">{chat.latencyMs}ms</span>
          ) : null}
        </div>
      ) : null}
      {embedding ? (
        <div class="notient-status__row">
          <span class="notient-pip" data-agent={pipKindFor(embedding.kind, embedding.ok)}>
            embed
          </span>
          <span class="notient-status__main" title={embedding.label}>
            {embedding.label}
          </span>
          {typeof embedding.latencyMs === "number" ? (
            <span class="notient-status__aux">{embedding.latencyMs}ms</span>
          ) : null}
        </div>
      ) : null}
      {fallbackEndpoints.map((endpoint) => (
        <div class="notient-status__row" key={endpoint.label}>
          <span class="notient-pip" data-agent={pipKindFor(endpoint.kind, endpoint.ok)}>
            link
          </span>
          <span class="notient-status__main" title={endpoint.label}>
            {endpoint.label}
          </span>
          {typeof endpoint.latencyMs === "number" ? (
            <span class="notient-status__aux">{endpoint.latencyMs}ms</span>
          ) : null}
        </div>
      ))}
      <div class="notient-status__row">
        {activity ? (
          <>
            <span class="notient-status__main">
              <span class="notient-status__activity">{activity.agent} thinking...</span>
            </span>
            <span class="notient-status__aux">
              {formatSeconds((Date.now() - activity.startedAt) / 1000)}
            </span>
          </>
        ) : (
          <span class="notient-status__main">{indexerLabel}</span>
        )}
      </div>
    </div>
  );
}
