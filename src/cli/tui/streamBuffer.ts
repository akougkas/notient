import type React from "react";
import type { Action } from "./store";

const MIN_FRAME_MS = 33;
const MAX_FRAME_MS = 100;

export interface StreamDispatch {
  dispatch: React.Dispatch<Action>;
  flush: () => void;
}

export function createStreamDispatch(target: React.Dispatch<Action>): StreamDispatch {
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlush = Number.NEGATIVE_INFINITY;
  let interval = MIN_FRAME_MS;
  let dueAt = 0;

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending === "") return;
    const text = pending;
    pending = "";
    lastFlush = performance.now();
    target({ type: "ask/assistantDelta", text });
  };

  const dispatch: React.Dispatch<Action> = (action) => {
    if (action.type !== "ask/assistantDelta") {
      flush();
      target(action);
      return;
    }
    pending += action.text;
    if (timer !== null) return;
    const wait = Math.max(0, interval - (performance.now() - lastFlush));
    if (wait === 0) {
      flush();
      return;
    }
    dueAt = performance.now() + wait;
    timer = setTimeout(() => {
      const late = Math.max(0, performance.now() - dueAt);
      interval = Math.min(
        MAX_FRAME_MS,
        Math.max(MIN_FRAME_MS, interval * 0.7 + (MIN_FRAME_MS + late * 2) * 0.3),
      );
      flush();
    }, wait);
  };

  return { dispatch, flush };
}
