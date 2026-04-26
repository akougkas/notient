import type { Signal } from "@preact/signals";

export interface FooterEndpoint {
  label: string;
  ok: boolean;
}

export interface FooterState {
  endpoints: FooterEndpoint[];
  noteCount: number;
}

export function StatusFooter({ state }: { state: Signal<FooterState> }) {
  const current = state.value;
  return (
    <div class="notient-status-footer">
      {current.endpoints.map((endpoint) => (
        <span
          class={`notient-dot ${endpoint.ok ? "ok" : "down"}`}
          key={endpoint.label}
          title={endpoint.label}
        >
          ●
        </span>
      ))}
      <span class="notient-count">{current.noteCount} notes</span>
    </div>
  );
}
