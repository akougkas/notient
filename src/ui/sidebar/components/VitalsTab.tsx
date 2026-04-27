import { signal } from "@preact/signals";
import type { VitalsSnapshot } from "../../../core/vitals/types";
import { VitalMeter } from "./VitalMeter";

export const vitalsSnapshotState = signal<VitalsSnapshot | null>(null);
export const vitalsActions = signal<{ deepen: (path: string) => void } | null>(null);

function titleFromPath(path: string): string {
  const stripped = path.replace(/^\/+/, "");
  const last = stripped.split("/").pop() ?? stripped;
  return last.replace(/\.md$/, "");
}

function freshnessWord(value: number): string {
  if (value >= 0.7) return "fresh";
  if (value >= 0.3) return "settled";
  return "fading";
}

function healthWord(value: number): string {
  if (value >= 0.7) return "healthy";
  if (value >= 0.4) return "developing";
  return "thin";
}

function connectivityWord(value: number): string {
  if (value >= 4) return "well-connected";
  if (value >= 1) return "loosely linked";
  return "orphaned";
}

export function interpret(snapshot: VitalsSnapshot): string {
  const fresh = freshnessWord(snapshot.freshness);
  const health = healthWord(snapshot.health);
  const linked = connectivityWord(snapshot.connectivityCount);
  return `This note is ${fresh}, ${health}, and ${linked}; maturity is ${snapshot.maturity}.`;
}

export function VitalsTab() {
  const snapshot = vitalsSnapshotState.value;
  const actions = vitalsActions.value;
  if (!snapshot) {
    return (
      <section class="notient-tab-body">
        <div class="notient-empty">
          <span class="notient-empty__dot" />
          <h3 class="notient-empty__title">No note in focus.</h3>
          <p class="notient-empty__hint">Open an indexed note to read its vitals.</p>
        </div>
      </section>
    );
  }
  const title = titleFromPath(snapshot.notePath);
  return (
    <section class="notient-tab-body">
      <div class="notient-vitals">
        <div>
          <h3 class="notient-vitals__title">{title}</h3>
          <div class="notient-vitals__path">{snapshot.notePath}</div>
        </div>
        <div class="notient-vitals__grid">
          <VitalMeter tone="freshness" label="Freshness" value={snapshot.freshness} />
          <VitalMeter tone="health" label="Health" value={snapshot.health} />
          <VitalMeter
            tone="connectivity"
            label="Connectivity"
            value={snapshot.connectivityCount}
            suffix=" links"
          />
          <VitalMeter tone="maturity" label="Maturity" value={snapshot.maturity} isCategory />
        </div>
        <p class="notient-vitals__interpretation">{interpret(snapshot)}</p>
        <div class="notient-vitals__actions">
          <button
            type="button"
            class="notient-button"
            data-emphasis="ghost"
            onClick={() => actions?.deepen(snapshot.notePath)}
          >
            Deepen this note
          </button>
        </div>
      </div>
    </section>
  );
}
