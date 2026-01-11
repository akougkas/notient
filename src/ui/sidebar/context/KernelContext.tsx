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
import type { EventListener, EventType } from "../../../types/events";
import { debugLog } from "../../../utils/debugLog";

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
 * Reactive: re-renders when services become available after initialization
 * @param name - Service name registered with kernel.registerService()
 * @returns Service instance or null if not registered
 */
export function useService<T>(name: string): T | null {
  const kernel = useKernel();
  const [service, setService] = useState<T | null>(() => kernel.getService<T>(name));

  useEffect(() => {
    // Check immediately in case we missed initialization
    const current = kernel.getService<T>(name);
    if (current && !service) {
      debugLog("useService", `${name} now available`);
      setService(current);
    }

    // Subscribe to services:initialized to catch late availability
    const unsubscribe = kernel.eventBus.on("services:initialized", () => {
      const fresh = kernel.getService<T>(name);
      if (fresh) {
        debugLog("useService", `${name} available via event`);
        setService(fresh);
      }
    });

    return () => unsubscribe();
  }, [kernel, name, service]);

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
