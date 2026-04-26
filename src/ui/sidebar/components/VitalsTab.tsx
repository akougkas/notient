import { signal } from "@preact/signals";
import type { VitalsSnapshot } from "../../../core/vitals/types";
import { VitalMeter } from "./VitalMeter";

export const vitalsSnapshotState = signal<VitalsSnapshot | null>(null);
export const vitalsActions = signal<{ deepen: (path: string) => void } | null>(null);

export function VitalsTab() {
  const snapshot = vitalsSnapshotState.value;
  const actions = vitalsActions.value;
  if (!snapshot) {
    return (
      <section class="notient-tab-body notient-tab-body--vitals">
        <p class="notient-empty">Open a note to see its vitals.</p>
      </section>
    );
  }
  return (
    <section class="notient-tab-body notient-tab-body--vitals">
      <h3 class="notient-vitals__title">{snapshot.notePath}</h3>
      <span class={`notient-vitals__maturity notient-vitals__maturity--${snapshot.maturity}`}>
        {snapshot.maturity}
      </span>
      <VitalMeter
        label="Freshness"
        value={snapshot.freshness}
        display={`${Math.round(snapshot.freshness * 100)}%`}
      />
      <VitalMeter
        label="Health"
        value={snapshot.health}
        display={`${Math.round(snapshot.health * 100)}%`}
      />
      <VitalMeter
        label="Connectivity"
        value={Math.min(1, snapshot.connectivityCount / 12)}
        display={`${snapshot.connectivityCount} edges (${snapshot.connectivityTier})`}
      />
      <button type="button" class="notient-btn" onClick={() => actions?.deepen(snapshot.notePath)}>
        Deepen this note
      </button>
    </section>
  );
}
