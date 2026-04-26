import { signal } from "@preact/signals";
import type { StreamItem } from "../../../core/stream/types";
import { StreamItemCard } from "./StreamItemCard";

export const streamItemsState = signal<StreamItem[]>([]);
export const streamActions = signal<{
  open: (item: StreamItem) => void;
  accept: (item: StreamItem) => void;
  reject: (item: StreamItem) => void;
} | null>(null);

export function StreamTab() {
  const items = streamItemsState.value;
  const actions = streamActions.value;
  if (items.length === 0) {
    return (
      <section class="notient-tab-body notient-tab-body--stream">
        <p class="notient-empty">No pending insights. Save a note or wait for the swarm.</p>
      </section>
    );
  }
  return (
    <section class="notient-tab-body notient-tab-body--stream">
      <ul class="notient-stream-list">
        {items.map((item) => (
          <li key={item.id}>
            <StreamItemCard
              item={item}
              onOpen={(target) => actions?.open(target)}
              onAccept={(target) => actions?.accept(target)}
              onReject={(target) => actions?.reject(target)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
