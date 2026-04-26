import { signal } from "@preact/signals";
import { type FooterState, StatusFooter } from "./components/StatusFooter";

export interface AgentRun {
  id: number;
  agent: string;
  trigger: string;
  ok: boolean;
  proposals: number;
  durationMs: number;
  error?: string;
  finishedAt: number;
}

export interface SidebarActions {
  openCoAuthor: () => void;
  openApprovals: () => void;
  openAwaken: () => void;
}

export const footerState = signal<FooterState>({ endpoints: [], noteCount: 0 });
export const recentRunsState = signal<AgentRun[]>([]);
export const pendingApprovalsState = signal<number>(0);
export const sidebarActions = signal<SidebarActions | null>(null);
export const tickState = signal<number>(0);

function relativeTime(now: number, then: number): string {
  const delta = Math.max(0, now - then);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export function App() {
  const actions = sidebarActions.value;
  const runs = recentRunsState.value;
  const pending = pendingApprovalsState.value;
  void tickState.value;
  const now = Date.now();

  return (
    <div class="notient-app">
      <header class="notient-header">
        <h2>Notient</h2>
        <p class="notient-subtitle">Mind layer online</p>
      </header>
      <main class="notient-body">
        <div class="notient-actions">
          <button type="button" class="notient-btn" onClick={() => actions?.openCoAuthor()}>
            Open Co-author
          </button>
          <button type="button" class="notient-btn" onClick={() => actions?.openApprovals()}>
            Open Approvals
            {pending > 0 ? <span class="notient-badge">{pending}</span> : null}
          </button>
          <button
            type="button"
            class="notient-btn notient-btn--secondary"
            onClick={() => actions?.openAwaken()}
          >
            Awaken Vault
          </button>
        </div>
        <section class="notient-runs">
          <h3>Recent agent activity</h3>
          {runs.length === 0 ? (
            <p class="notient-runs__empty">
              No agent runs yet. Save a note, wait 30s idle, or click Awaken Vault.
            </p>
          ) : (
            <ul class="notient-runs__list">
              {runs.map((run) => (
                <li
                  key={run.id}
                  class={`notient-run notient-run--${run.ok ? "ok" : "fail"}`}
                  title={run.error ?? ""}
                >
                  <span class="notient-run__agent">{run.agent}</span>
                  <span class="notient-run__trigger">{run.trigger}</span>
                  <span class="notient-run__proposals">+{run.proposals}</span>
                  <span class="notient-run__time">{relativeTime(now, run.finishedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
      <StatusFooter state={footerState} />
    </div>
  );
}
