/**
 * Typed event bus for cross-component communication
 */

import type { EventListener, EventPayloads, EventType, Unsubscribe } from "../../types/events";

/**
 * Typed pub/sub event bus for Notient
 *
 * Provides type-safe event emission and subscription across all components.
 * Events are processed synchronously in order of subscription.
 */
export class EventBus {
  // biome-ignore lint/suspicious/noExplicitAny: EventBus needs to store listeners of different types
  private listeners: Map<EventType, Set<EventListener<any>>> = new Map();
  private disposed = false;

  /**
   * Subscribe to an event type
   * @param event - Event type to listen for
   * @param listener - Callback function
   * @returns Unsubscribe function
   */
  on<T extends EventType>(event: T, listener: EventListener<T>): Unsubscribe {
    if (this.disposed) {
      console.warn("[EventBus] Attempted to subscribe after disposal");
      return () => {};
    }

    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }

    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }

  /**
   * Subscribe to an event type for a single emission only
   * @param event - Event type to listen for
   * @param listener - Callback function
   * @returns Unsubscribe function
   */
  once<T extends EventType>(event: T, listener: EventListener<T>): Unsubscribe {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      listener(payload);
    });
    return unsubscribe;
  }

  /**
   * Emit an event to all listeners
   * @param event - Event type
   * @param payload - Event payload
   */
  emit<T extends EventType>(event: T, payload: EventPayloads[T]): void {
    if (this.disposed) {
      return;
    }

    const listeners = this.listeners.get(event);
    if (!listeners || listeners.size === 0) {
      return;
    }

    // Copy to array to avoid issues if listener unsubscribes during emit
    const listenerArray = Array.from(listeners);
    for (const listener of listenerArray) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`[EventBus] Error in listener for ${event}:`, error);
      }
    }
  }

  /**
   * Remove all listeners for a specific event type
   * @param event - Event type to clear
   */
  off<T extends EventType>(event: T): void {
    this.listeners.delete(event);
  }

  /**
   * Get the number of listeners for an event type
   * @param event - Event type
   */
  listenerCount<T extends EventType>(event: T): number {
    const listeners = this.listeners.get(event);
    return listeners ? listeners.size : 0;
  }

  /**
   * Dispose of the event bus, removing all listeners
   */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

/** Singleton event bus instance - created by Kernel */
let globalEventBus: EventBus | null = null;

export function setGlobalEventBus(bus: EventBus): void {
  globalEventBus = bus;
}

export function getEventBus(): EventBus {
  if (!globalEventBus) {
    throw new Error("EventBus not initialized. Call setGlobalEventBus first.");
  }
  return globalEventBus;
}
