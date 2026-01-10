/**
 * Simple debug logging utility
 * Set DEBUG_ENABLED = true to see logs, false to disable
 */
const DEBUG_ENABLED = false;

export function debugLog(component: string, message: string, data?: unknown): void {
  if (!DEBUG_ENABLED) return;

  if (data !== undefined) {
    console.log(`[${component}] ${message}`, data);
  } else {
    console.log(`[${component}] ${message}`);
  }
}

export function debugError(component: string, message: string, data?: unknown): void {
  if (!DEBUG_ENABLED) return;

  if (data !== undefined) {
    console.error(`[${component}] ${message}`, data);
  } else {
    console.error(`[${component}] ${message}`);
  }
}
