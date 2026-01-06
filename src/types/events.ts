/**
 * Typed event definitions for the EventBus
 */

import type { ServiceHealth } from "./services";
import type { IndexProgress } from "./indexer";
import type { VaultVitalsData } from "./vitals";
import type { SearchResult } from "./search";

/** All event types supported by the EventBus */
export type EventType =
  | "health:changed"
  | "index:progress"
  | "index:complete"
  | "index:error"
  | "search:started"
  | "search:complete"
  | "vitals:updated"
  | "settings:changed"
  | "note:context-changed";

/** Event payload mapping */
export interface EventPayloads {
  "health:changed": HealthChangedEvent;
  "index:progress": IndexProgressEvent;
  "index:complete": IndexCompleteEvent;
  "index:error": IndexErrorEvent;
  "search:started": SearchStartedEvent;
  "search:complete": SearchCompleteEvent;
  "vitals:updated": VitalsUpdatedEvent;
  "settings:changed": SettingsChangedEvent;
  "note:context-changed": NoteContextChangedEvent;
}

export interface HealthChangedEvent {
  service: "ollama" | "lmstudio";
  health: ServiceHealth;
}

export interface IndexProgressEvent {
  progress: IndexProgress;
}

export interface IndexCompleteEvent {
  totalIndexed: number;
  durationMs: number;
}

export interface IndexErrorEvent {
  path: string;
  error: string;
}

export interface SearchStartedEvent {
  query: string;
}

export interface SearchCompleteEvent {
  query: string;
  results: SearchResult[];
  durationMs: number;
  cached: boolean;
}

export interface VitalsUpdatedEvent {
  vitals: VaultVitalsData;
}

export interface SettingsChangedEvent {
  changedFields: string[];
}

export interface NoteContextChangedEvent {
  path: string | null;
}

/** Event listener function type */
export type EventListener<T extends EventType> = (
  payload: EventPayloads[T]
) => void;

/** Unsubscribe function returned by subscribe */
export type Unsubscribe = () => void;
