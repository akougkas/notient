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
import { useCallback, useContext, useEffect, useMemo } from "preact/hooks";
import type { EventListener, EventPayloads, EventType } from "../../../types/events";
import type { Kernel } from "../../../core/kernel";

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
	return (
		<KernelContext.Provider value={value}>{children}</KernelContext.Provider>
	);
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
	return kernel.getService<T>(name);
}

/**
 * Subscribe to EventBus events with automatic cleanup
 * @param event - Event type to subscribe to
 * @param callback - Handler function called with event payload
 */
export function useEventBus<T extends EventType>(
	event: T,
	callback: EventListener<T>,
): void {
	const kernel = useKernel();

	// Memoize callback to prevent unnecessary resubscriptions
	const stableCallback = useCallback(callback, [callback]);

	useEffect(() => {
		const unsubscribe = kernel.eventBus.on(event, stableCallback);
		return () => unsubscribe();
	}, [kernel.eventBus, event, stableCallback]);
}
