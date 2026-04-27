import { signal } from "@preact/signals";
import type { StreamItem } from "../../../core/stream/types";
import { StreamItemCard } from "./StreamItemCard";

export const streamItemsState = signal<StreamItem[]>([]);
export const focusedProposalIdState = signal<string | null>(null);
export const streamActions = signal<{
  open: (item: StreamItem) => void;
  accept: (item: StreamItem) => void;
  reject: (item: StreamItem) => void;
  previewCanvas: (item: StreamItem) => void;
} | null>(null);

export function StreamTab() {
  const items = streamItemsState.value;
  const actions = streamActions.value;
  const focusedProposalId = focusedProposalIdState.value;
  if (items.length === 0) {
    return (
      <section class="notient-tab-body">
        <div class="notient-empty">
          <span class="notient-empty__dot" />
          <h3 class="notient-empty__title">The swarm watches.</h3>
          <p class="notient-empty__hint">
            Save a note. When agents have something to propose, it appears here.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section class="notient-tab-body notient-stream">
      <ul class="notient-stream__list">
        {items.map((item) => (
          <li key={item.id}>
            <StreamItemCard
              item={item}
              isFocused={item.id === focusedProposalId}
              onOpen={(target) => actions?.open(target)}
              onAccept={(target) => actions?.accept(target)}
              onReject={(target) => actions?.reject(target)}
              onPreviewCanvas={(target) => actions?.previewCanvas(target)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
