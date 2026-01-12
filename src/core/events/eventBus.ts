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
    console.log(`[eventBus:on] TRACE: START event=${String(event)}`);
    if (this.disposed) {
      console.warn("[eventBus:on] TRACE: Attempted to subscribe after disposal");
      console.log("[eventBus:on] TRACE: END (disposed, returning no-op)");
      return () => {};
    }

    let listeners = this.listeners.get(event);
    if (!listeners) {
      console.log(`[eventBus:on] TRACE: Creating new listener set for event=${String(event)}`);
      listeners = new Set();
      this.listeners.set(event, listeners);
    }

    listeners.add(listener);
    console.log(`[eventBus:on] TRACE: Added listener, total for event=${listeners.size}`);
    console.log("[eventBus:on] TRACE: END");

    return () => {
      console.log(`[eventBus:on:unsubscribe] TRACE: Unsubscribing from event=${String(event)}`);
      listeners.delete(listener);
      console.log(`[eventBus:on:unsubscribe] TRACE: Remaining listeners=${listeners.size}`);
    };
  }

  /**
   * Subscribe to an event type for a single emission only
   * @param event - Event type to listen for
   * @param listener - Callback function
   * @returns Unsubscribe function
   */
  once<T extends EventType>(event: T, listener: EventListener<T>): Unsubscribe {
    console.log(`[eventBus:once] TRACE: START event=${String(event)}`);
    const unsubscribe = this.on(event, (payload) => {
      console.log(
        `[eventBus:once:handler] TRACE: One-time handler triggered for event=${String(event)}`,
      );
      unsubscribe();
      console.log("[eventBus:once:handler] TRACE: Calling original listener");
      listener(payload);
      console.log("[eventBus:once:handler] TRACE: Original listener complete");
    });
    console.log("[eventBus:once] TRACE: END");
    return unsubscribe;
  }

  /**
   * Emit an event to all listeners
   * @param event - Event type
   * @param payload - Event payload
   */
  emit<T extends EventType>(event: T, payload: EventPayloads[T]): void {
    console.log(`[eventBus:emit] TRACE: START event=${String(event)}`);
    if (this.disposed) {
      console.log("[eventBus:emit] TRACE: END (disposed, skipping)");
      return;
    }

    const listeners = this.listeners.get(event);
    if (!listeners || listeners.size === 0) {
      console.log(`[eventBus:emit] TRACE: END (no listeners for event=${String(event)})`);
      return;
    }

    console.log(
      `[eventBus:emit] TRACE: Found ${listeners.size} handlers for event=${String(event)}`,
    );
    // Copy to array to avoid issues if listener unsubscribes during emit
    const listenerArray = Array.from(listeners);
    for (let i = 0; i < listenerArray.length; i++) {
      const listener = listenerArray[i];
      try {
        console.log(`[eventBus:emit] TRACE: Calling handler ${i} for event=${String(event)}`);
        listener(payload);
        console.log(`[eventBus:emit] TRACE: Handler ${i} completed`);
      } catch (error) {
        console.error(`[eventBus:emit] TRACE: Error in handler ${i} for ${String(event)}:`, error);
      }
    }
    console.log(`[eventBus:emit] TRACE: END event=${String(event)}`);
  }

  /**
   * Remove all listeners for a specific event type
   * @param event - Event type to clear
   */
  off<T extends EventType>(event: T): void {
    console.log(`[eventBus:off] TRACE: START event=${String(event)}`);
    const listeners = this.listeners.get(event);
    console.log(`[eventBus:off] TRACE: Removing ${listeners?.size || 0} listeners`);
    this.listeners.delete(event);
    console.log("[eventBus:off] TRACE: END");
  }

  /**
   * Get the number of listeners for an event type
   * @param event - Event type
   */
  listenerCount<T extends EventType>(event: T): number {
    console.log(`[eventBus:listenerCount] TRACE: START event=${String(event)}`);
    const listeners = this.listeners.get(event);
    const count = listeners ? listeners.size : 0;
    console.log(`[eventBus:listenerCount] TRACE: END count=${count}`);
    return count;
  }

  /**
   * Dispose of the event bus, removing all listeners
   */
  dispose(): void {
    console.log("[eventBus:dispose] TRACE: START");
    console.log(`[eventBus:dispose] TRACE: Total event types registered=${this.listeners.size}`);
    this.disposed = true;
    this.listeners.clear();
    console.log("[eventBus:dispose] TRACE: END");
  }
}

/** Singleton event bus instance - created by Kernel */
let globalEventBus: EventBus | null = null;

export function setGlobalEventBus(bus: EventBus): void {
  console.log("[eventBus:setGlobalEventBus] TRACE: START");
  // Clear old event bus to prevent stale references on plugin reload
  if (globalEventBus && globalEventBus !== bus) {
    console.log("[eventBus:setGlobalEventBus] TRACE: Disposing previous event bus");
    globalEventBus.dispose();
  }
  globalEventBus = bus;
  console.log("[eventBus:setGlobalEventBus] TRACE: END (global event bus set)");
}

export function clearGlobalEventBus(): void {
  console.log("[eventBus:clearGlobalEventBus] TRACE: START");
  if (globalEventBus) {
    console.log("[eventBus:clearGlobalEventBus] TRACE: Disposing and clearing global event bus");
    globalEventBus.dispose();
    globalEventBus = null;
  } else {
    console.log("[eventBus:clearGlobalEventBus] TRACE: No global event bus to clear");
  }
  console.log("[eventBus:clearGlobalEventBus] TRACE: END");
}

export function getEventBus(): EventBus {
  console.log("[eventBus:getEventBus] TRACE: START");
  if (!globalEventBus) {
    console.log("[eventBus:getEventBus] TRACE: ERROR - EventBus not initialized");
    throw new Error("EventBus not initialized. Call setGlobalEventBus first.");
  }
  console.log("[eventBus:getEventBus] TRACE: END (returning global event bus)");
  return globalEventBus;
}
