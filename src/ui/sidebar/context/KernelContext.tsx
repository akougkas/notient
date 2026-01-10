/**
 * Preact Context for Kernel access in sidebar components
 *
 * Provides:
 * - KernelProvider: Wraps sidebar component tree
 * - useKernel(): Access the Kernel instance
 * - useApp(): Access Obsidian App
 * - useService<T>(name): Get a registered service
 * - useEventBus(event, callback): Subscribe to EventBus events
 */

import type { App } from "obsidian";
import { createContext } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Kernel } from "../../../core/kernel";
import type { EventListener, EventPayloads, EventType } from "../../../types/events";

// ============ Context ============

interface KernelContextValue {
  kernel: Kernel;
  app: App;
}

const KernelContext = createContext<KernelContextValue | null>(null);

// ============ Provider ============

interface KernelProviderProps {
  kernel: Kernel;
  app: App;
  children: preact.ComponentChildren;
}

export function KernelProvider({ kernel, app, children }: KernelProviderProps) {
  const value = useMemo(() => ({ kernel, app }), [kernel, app]);
  return <KernelContext.Provider value={value}>{children}</KernelContext.Provider>;
}

// ============ Hooks ============

/**
 * Access the Kernel instance
 * @throws if used outside KernelProvider
 */
export function useKernel(): Kernel {
  const ctx = useContext(KernelContext);
  if (!ctx) {
    throw new Error("useKernel must be used within a KernelProvider");
  }
  return ctx.kernel;
}

/**
 * Access the Obsidian App instance
 * @throws if used outside KernelProvider
 */
export function useApp(): App {
  const ctx = useContext(KernelContext);
  if (!ctx) {
    throw new Error("useApp must be used within a KernelProvider");
  }
  return ctx.app;
}

/**
 * Get a registered service from the Kernel
 * @param name - Service name registered with kernel.registerService()
 * @returns Service instance or null if not registered
 */
export function useService<T>(name: string): T | null {
  const kernel = useKernel();
  const service = kernel.getService<T>(name);
  console.log("[useService]", name, "→", service);
  return service;
}

/**
 * Subscribe to EventBus events with automatic cleanup
 * @param event - Event type to subscribe to
 * @param callback - Handler function called with event payload
 */
export function useEventBus<T extends EventType>(event: T, callback: EventListener<T>): void {
  const kernel = useKernel();

  // Use ref to hold latest callback - avoids circular dependency from useCallback([callback])
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const handler: EventListener<T> = (payload) => callbackRef.current(payload);
    const unsubscribe = kernel.eventBus.on(event, handler);
    return () => unsubscribe();
  }, [kernel.eventBus, event]);
}

/**
 * Track whether services have been initialized
 * @returns Object with isInitialized boolean and optional error
 */
export function useServicesInitialized(): { isInitialized: boolean; error: string | null } {
  const kernel = useKernel();
  const [isInitialized, setIsInitialized] = useState(kernel.isServicesInitialized);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check current state in case we missed the event
    if (kernel.isServicesInitialized) {
      setIsInitialized(true);
    }

    const unsubInit = kernel.eventBus.on("services:initialized", () => {
      setIsInitialized(true);
      setError(null);
    });

    const unsubFail = kernel.eventBus.on("services:failed", (payload) => {
      setIsInitialized(false);
      setError(payload.reason);
    });

    return () => {
      unsubInit();
      unsubFail();
    };
  }, [kernel]);

  return { isInitialized, error };
}
