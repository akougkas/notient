import type { AppEvent, EventHandler, EventType } from "./types";

type Handlers = Map<EventType, Set<EventHandler<EventType>>>;

export class EventBus {
  private handlers: Handlers = new Map();

  on<T extends EventType>(type: T, handler: EventHandler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as unknown as EventHandler<EventType>);
    return () => {
      set?.delete(handler as unknown as EventHandler<EventType>);
    };
  }

  emit(event: AppEvent): void {
    const set = this.handlers.get(event.type);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as unknown as (event: AppEvent) => void)(event);
      } catch (error) {
        console.error("[EventBus] handler error", event.type, error);
      }
    }
  }
}
