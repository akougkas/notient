/**
 * Type-safe EventBus for Notient
 * Provides pub/sub communication between components
 */

import type { EventName, EventPayloadMap } from "../types";

/** Listener callback type */
type EventListener<T extends EventName> = (payload: EventPayloadMap[T]) => void;

/** Wildcard listener receives event name + payload */
type WildcardListener = <T extends EventName>(event: T, payload: EventPayloadMap[T]) => void;

/**
 * Type-safe pub/sub event bus
 *
 * @example
 * eventBus.on('enhance:start', (payload) => {
 *   console.log(`Enhancing note: ${payload.noteId}`);
 * });
 *
 * eventBus.emit('enhance:progress', { noteId: 'x', percent: 50, stage: 'analyst' });
 */
export class EventBus {
  private listeners = new Map<EventName, Set<EventListener<EventName>>>();
  private wildcardListeners = new Set<WildcardListener>();

  /**
   * Subscribe to an event
   * @param event Event name to subscribe to
   * @param callback Function called when event is emitted
   */
  on<T extends EventName>(event: T, callback: EventListener<T>): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback as EventListener<EventName>);
  }

  /**
   * Unsubscribe from an event
   * @param event Event name to unsubscribe from
   * @param callback Function to remove
   */
  off<T extends EventName>(event: T, callback: EventListener<T>): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(callback as EventListener<EventName>);
      if (set.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  /**
   * Emit an event to all subscribers
   * @param event Event name to emit
   * @param payload Typed payload for the event
   */
  emit<T extends EventName>(event: T, payload: EventPayloadMap[T]): void {
    // Notify specific listeners
    const set = this.listeners.get(event);
    if (set) {
      for (const listener of set) {
        listener(payload);
      }
    }

    // Notify wildcard listeners
    for (const listener of this.wildcardListeners) {
      listener(event, payload);
    }
  }

  /**
   * Subscribe to an event once (auto-removes after first call)
   * @param event Event name to subscribe to
   * @param callback Function called once when event is emitted
   */
  once<T extends EventName>(event: T, callback: EventListener<T>): void {
    const wrapper: EventListener<T> = (payload) => {
      this.off(event, wrapper);
      callback(payload);
    };
    this.on(event, wrapper);
  }

  /**
   * Subscribe to all events (useful for debugging/logging)
   * @param callback Function called for every event
   */
  onAny(callback: WildcardListener): void {
    this.wildcardListeners.add(callback);
  }

  /**
   * Unsubscribe from wildcard listener
   * @param callback Function to remove
   */
  offAny(callback: WildcardListener): void {
    this.wildcardListeners.delete(callback);
  }

  /**
   * Remove all listeners (useful for cleanup)
   */
  clear(): void {
    this.listeners.clear();
    this.wildcardListeners.clear();
  }
}

/** Singleton instance for application-wide event communication */
export const eventBus = new EventBus();
