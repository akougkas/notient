import type { ObsidianFacade } from "../adapters/obsidianFacade";
import type { Database } from "./db/database";
import type { EventBus } from "./events/eventBus";
import type { GraphStore } from "./graph/graphStore";
import type { LLMProvider } from "./llm/provider";
import type { EchoGuard } from "./services/echoGuard";
import type { HealthMonitor } from "./services/healthMonitor";
import type { VaultLockHandle } from "./services/vaultLock";
import type { SettingsService } from "./settings/settingsService";

export interface ServiceRegistry {
  bus: EventBus;
  settings: SettingsService;
  facade: ObsidianFacade;
  database: Database;
  graph: GraphStore;
  primaryLLM: LLMProvider;
  deepLLM: LLMProvider;
  health: HealthMonitor;
  lock: VaultLockHandle;
  echoGuard: EchoGuard;
}

export type ServiceKey = keyof ServiceRegistry;

const REQUIRED_KEYS: ServiceKey[] = [
  "bus",
  "settings",
  "facade",
  "database",
  "graph",
  "primaryLLM",
  "deepLLM",
  "health",
  "lock",
  "echoGuard",
];

export class Kernel {
  private services: Partial<ServiceRegistry> = {};
  private sealed = false;

  register<K extends ServiceKey>(key: K, value: ServiceRegistry[K]): void {
    if (this.sealed) throw new Error(`Kernel sealed; cannot register ${key}`);
    this.services[key] = value;
  }

  seal(): void {
    const missing = REQUIRED_KEYS.filter((k) => this.services[k] === undefined);
    if (missing.length > 0) {
      throw new Error(`Kernel.seal(): missing required services: ${missing.join(", ")}`);
    }
    this.sealed = true;
  }

  get<K extends ServiceKey>(key: K): ServiceRegistry[K] {
    const value = this.services[key];
    if (value === undefined) throw new Error(`Kernel: service '${key}' not registered`);
    return value as ServiceRegistry[K];
  }

  isSealed(): boolean {
    return this.sealed;
  }
}
