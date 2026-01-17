/**
 * Kernel Service Registry for Notient
 * Provides type-safe dependency injection with lazy instantiation
 * Source of truth: .planning/PHASE-GALAXY.md
 */

import type { App, Plugin } from "obsidian";
import type { ObsidianFacade } from "../adapters/obsidian";
import type { NotientSettings } from "../types";
import type { Database } from "./db/database";
import type { EventBus } from "./events";
import type { Indexer } from "./indexer";
import type { LLMProvider } from "./llm";

/**
 * Context passed to kernel during initialization.
 * Contains Obsidian primitives and plugin settings.
 */
export interface KernelContext {
  app: App;
  plugin: Plugin;
  settings: NotientSettings;
}

/**
 * Service registry type map - maps service names to their types.
 * Extend this interface as new services are added.
 */
export interface ServiceRegistry {
  eventBus: EventBus;
  database: Database;
  obsidianFacade: ObsidianFacade;
  llmProvider: LLMProvider;
  indexer: Indexer;
  // Future services for Galaxy MVP:
  // planner: PlannerAgent
  // contextBuilder: ContextBuilderAgent
  // analyst: AnalystAgent
  // writer: WriterAgent
}

/** Valid service names (keys of ServiceRegistry) */
export type ServiceName = keyof ServiceRegistry;

/** Factory function type for lazy service creation */
type ServiceFactory<T> = () => T;

/**
 * Kernel - Central service registry with lazy instantiation
 *
 * @example
 * // Register services with factories
 * kernel.register('eventBus', () => new EventBus());
 *
 * // Initialize with context
 * await kernel.initialize({ app, plugin, settings });
 *
 * // Get services (type-safe)
 * const eventBus = kernel.get('eventBus');
 */
export class Kernel {
  private context: KernelContext | null = null;
  private factories = new Map<ServiceName, ServiceFactory<unknown>>();
  private instances = new Map<ServiceName, unknown>();
  private initialized = false;

  /**
   * Register a service factory for lazy instantiation.
   * The factory is called only on first `get()` call.
   *
   * @param name - Service name (must be key of ServiceRegistry)
   * @param factory - Function that creates the service instance
   */
  register<K extends ServiceName>(name: K, factory: ServiceFactory<ServiceRegistry[K]>): void {
    if (this.instances.has(name)) {
      throw new Error(`Service '${name}' already instantiated`);
    }
    this.factories.set(name, factory as ServiceFactory<unknown>);
  }

  /**
   * Get a service instance (lazily created on first access).
   * Throws if service not registered.
   *
   * @param name - Service name to retrieve
   * @returns The service instance (typed based on ServiceRegistry)
   */
  get<K extends ServiceName>(name: K): ServiceRegistry[K] {
    // Return cached instance if exists
    if (this.instances.has(name)) {
      return this.instances.get(name) as ServiceRegistry[K];
    }

    // Get factory and create instance
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`Service '${name}' not registered`);
    }

    const instance = factory();
    this.instances.set(name, instance);
    return instance as ServiceRegistry[K];
  }

  /**
   * Check if a service is registered (factory exists).
   *
   * @param name - Service name to check
   * @returns true if registered
   */
  has(name: ServiceName): boolean {
    return this.factories.has(name);
  }

  /**
   * Initialize kernel with Obsidian context.
   * Stores context for services that need it during instantiation.
   *
   * @param context - App, Plugin, and Settings references
   */
  async initialize(context: KernelContext): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.context = context;
    this.initialized = true;
  }

  /**
   * Get the kernel context (app, plugin, settings).
   * Throws if kernel not initialized.
   */
  getContext(): KernelContext {
    if (!this.context) {
      throw new Error("Kernel not initialized");
    }
    return this.context;
  }

  /**
   * Check if kernel has been initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Shutdown and cleanup all instantiated services.
   * Calls dispose/close methods on services that have them.
   */
  async shutdown(): Promise<void> {
    // Shutdown in reverse registration order
    const names = Array.from(this.instances.keys()).reverse();

    for (const name of names) {
      const instance = this.instances.get(name);
      if (!instance) continue;

      // Handle different cleanup method names
      if (typeof (instance as { shutdown?: () => unknown }).shutdown === "function") {
        await (instance as { shutdown: () => Promise<void> }).shutdown();
      } else if (typeof (instance as { dispose?: () => unknown }).dispose === "function") {
        (instance as { dispose: () => void }).dispose();
      } else if (typeof (instance as { close?: () => unknown }).close === "function") {
        (instance as { close: () => void }).close();
      } else if (typeof (instance as { clear?: () => unknown }).clear === "function") {
        (instance as { clear: () => void }).clear();
      }
    }

    this.instances.clear();
    this.factories.clear();
    this.context = null;
    this.initialized = false;
  }
}

/** Singleton kernel instance for application-wide service access */
export const kernel = new Kernel();
