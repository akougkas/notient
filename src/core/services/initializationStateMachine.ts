/**
 * Initialization State Machine
 *
 * Manages the plugin initialization lifecycle with formal state transitions,
 * timeouts, retries, and capability gating.
 *
 * State flow:
 * UNINITIALIZED → CHECKING_PROVIDERS → LOADING_INDEX → WARMING_SERVICES → READY
 *                        ↓                   ↓                ↓
 *                     FAILED             CRASHED          DEGRADED
 */

import type {
  CrashedReason,
  DegradedReason,
  FailedReason,
  InitializationContext,
  InitializationState,
} from "../../types/services";
import type { EventBus } from "../events/eventBus";

/** Valid state transitions */
const VALID_TRANSITIONS: Record<InitializationState, InitializationState[]> = {
  UNINITIALIZED: ["CHECKING_PROVIDERS", "FAILED"],
  CHECKING_PROVIDERS: ["LOADING_INDEX", "FAILED", "DEGRADED"],
  LOADING_INDEX: ["WARMING_SERVICES", "CRASHED", "FAILED"],
  WARMING_SERVICES: ["READY", "DEGRADED", "FAILED"],
  READY: ["DEGRADED", "FAILED", "CHECKING_PROVIDERS"], // Can go back for reinit
  DEGRADED: ["READY", "FAILED", "CHECKING_PROVIDERS"], // Can recover or reinit
  FAILED: ["UNINITIALIZED", "CHECKING_PROVIDERS"], // Can retry from start
  CRASHED: ["UNINITIALIZED", "LOADING_INDEX"], // Can recover or restart
};

/** Timeout configuration per state (ms) */
const STATE_TIMEOUTS: Partial<Record<InitializationState, number>> = {
  CHECKING_PROVIDERS: 30_000, // 30s to check providers
  LOADING_INDEX: 60_000, // 60s to load index
  WARMING_SERVICES: 30_000, // 30s to warm services
};

/** Retry configuration */
const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 4000,
};

export interface InitStateMachineOptions {
  eventBus: EventBus;
  onStateChange?: (context: InitializationContext) => void;
}

/**
 * Initialization State Machine
 *
 * Provides formal state management for the plugin initialization process.
 * Emits `init:state-changed` events and enforces valid state transitions.
 */
export class InitializationStateMachine {
  private _context: InitializationContext;
  private _eventBus: EventBus;
  private _timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private _retryCount = 0;
  private _onStateChange?: (context: InitializationContext) => void;

  constructor(options: InitStateMachineOptions) {
    this._eventBus = options.eventBus;
    this._onStateChange = options.onStateChange;

    this._context = {
      state: "UNINITIALIZED",
      stateChangedAt: Date.now(),
      capabilities: {
        embeddings: false,
        chat: false,
        search: false,
        indexing: false,
      },
    };
  }

  /** Get current context (immutable) */
  get context(): Readonly<InitializationContext> {
    return { ...this._context };
  }

  /** Get current state */
  get state(): InitializationState {
    return this._context.state;
  }

  /** Check if currently in a terminal/stable state */
  get isStable(): boolean {
    return ["READY", "DEGRADED", "FAILED", "CRASHED"].includes(this._context.state);
  }

  /** Check if services are usable (READY or DEGRADED) */
  get isOperational(): boolean {
    return this._context.state === "READY" || this._context.state === "DEGRADED";
  }

  /**
   * Transition to a new state
   *
   * @throws Error if transition is invalid
   */
  transition(
    to: InitializationState,
    options?: {
      errorMessage?: string;
      degradedReason?: DegradedReason;
      failedReason?: FailedReason;
      crashedReason?: CrashedReason;
      progress?: InitializationContext["progress"];
    },
  ): void {
    const from = this._context.state;

    // Validate transition
    if (!this.canTransition(to)) {
      throw new Error(
        `[InitStateMachine] Invalid transition: ${from} → ${to}. ` +
          `Valid targets: ${VALID_TRANSITIONS[from].join(", ")}`,
      );
    }

    // Clear any existing timeout
    this.clearTimeout();

    // Build new context
    const previousContext = { ...this._context };
    this._context = {
      state: to,
      stateChangedAt: Date.now(),
      capabilities: this.computeCapabilities(to, options?.degradedReason),
      errorMessage: options?.errorMessage,
      degradedReason: to === "DEGRADED" ? options?.degradedReason : undefined,
      failedReason: to === "FAILED" ? options?.failedReason : undefined,
      crashedReason: to === "CRASHED" ? options?.crashedReason : undefined,
      progress: options?.progress,
    };

    // Reset retry count on successful forward progress
    if (to === "LOADING_INDEX" || to === "WARMING_SERVICES" || to === "READY") {
      this._retryCount = 0;
    }

    // Log transition
    console.log(`[InitStateMachine] ${from} → ${to}`, {
      capabilities: this._context.capabilities,
      ...(options?.errorMessage && { error: options.errorMessage }),
      ...(options?.degradedReason && { degradedReason: options.degradedReason }),
    });

    // Emit event
    this._eventBus.emit("init:state-changed", {
      previousState: from,
      currentState: to,
      context: this._context,
    });

    // Callback
    this._onStateChange?.(this._context);

    // Start timeout for non-terminal states
    this.startTimeoutIfNeeded(to);

    // Emit legacy events for backward compatibility
    if (to === "READY") {
      this._eventBus.emit("services:initialized", {});
    } else if (to === "FAILED") {
      this._eventBus.emit("services:failed", {
        reason: options?.failedReason === "missing_config" ? "missing_config" : "connection_failed",
      });
    }
  }

  /**
   * Check if a transition to the target state is valid
   */
  canTransition(to: InitializationState): boolean {
    return VALID_TRANSITIONS[this._context.state].includes(to);
  }

  /**
   * Update progress without changing state
   */
  updateProgress(progress: InitializationContext["progress"]): void {
    this._context = {
      ...this._context,
      progress,
    };

    // Emit update event (using same event type with no state change)
    this._eventBus.emit("init:state-changed", {
      previousState: this._context.state,
      currentState: this._context.state,
      context: this._context,
    });
  }

  /**
   * Attempt retry with exponential backoff
   * @returns delay in ms if retry allowed, null if max retries exceeded
   */
  getRetryDelay(): number | null {
    if (this._retryCount >= RETRY_CONFIG.maxAttempts) {
      return null;
    }

    const delay = Math.min(
      RETRY_CONFIG.baseDelayMs * 2 ** this._retryCount,
      RETRY_CONFIG.maxDelayMs,
    );

    this._retryCount++;
    return delay;
  }

  /**
   * Reset retry counter (call after successful operation)
   */
  resetRetries(): void {
    this._retryCount = 0;
  }

  /**
   * Compute capabilities based on state
   */
  private computeCapabilities(
    state: InitializationState,
    degradedReason?: DegradedReason,
  ): InitializationContext["capabilities"] {
    switch (state) {
      case "READY":
        return {
          embeddings: true,
          chat: true,
          search: true,
          indexing: true,
        };

      case "DEGRADED":
        // Degraded mode: search works, chat may be limited
        if (degradedReason === "lmstudio_down") {
          return {
            embeddings: true,
            chat: false, // No chat without LM Studio
            search: true, // Vector search works
            indexing: true, // Can still index
          };
        }
        if (degradedReason === "index_stale") {
          return {
            embeddings: true,
            chat: true,
            search: true, // Search works but may have stale results
            indexing: true, // Rebuild recommended
          };
        }
        // Default degraded: partial capabilities
        return {
          embeddings: true,
          chat: false,
          search: true,
          indexing: false,
        };

      case "FAILED":
      case "CRASHED":
      case "UNINITIALIZED":
        return {
          embeddings: false,
          chat: false,
          search: false,
          indexing: false,
        };

      case "CHECKING_PROVIDERS":
      case "LOADING_INDEX":
      case "WARMING_SERVICES":
        // Transitional states: no capabilities until complete
        return {
          embeddings: false,
          chat: false,
          search: false,
          indexing: false,
        };

      default:
        return {
          embeddings: false,
          chat: false,
          search: false,
          indexing: false,
        };
    }
  }

  /**
   * Start timeout for states that have time limits
   */
  private startTimeoutIfNeeded(state: InitializationState): void {
    const timeout = STATE_TIMEOUTS[state];
    if (!timeout) return;

    this._timeoutHandle = setTimeout(() => {
      console.warn(`[InitStateMachine] Timeout in state: ${state}`);

      // Transition to failed on timeout
      if (this._context.state === state) {
        this.transition("FAILED", {
          errorMessage: `Initialization timed out in ${state}`,
          failedReason: "critical_error",
        });
      }
    }, timeout);
  }

  /**
   * Clear any pending timeout
   */
  private clearTimeout(): void {
    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.clearTimeout();
  }
}
