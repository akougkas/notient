/**
 * Service and capability types
 */

/** Service health status */
export type ServiceStatus = "unknown" | "checking" | "healthy" | "unhealthy";

export interface ServiceHealth {
  status: ServiceStatus;
  lastChecked: number | null;
  error: string | null;
  details?: Record<string, unknown>;
}

/** Available models from a service */
export interface AvailableModel {
  name: string;
  displayName: string;
  size?: number;
  quantization?: string;
  capabilities: ModelCapability[];
}

export type ModelCapability = "embedding" | "chat" | "completion";

/** Capability status for the plugin */
export interface CapabilityStatus {
  embedding: boolean;
  reasoning: boolean;
  vectorStore: boolean;
  indexing: boolean;
  search: boolean;
}

/** Service lifecycle interface */
export interface Service {
  /** Initialize the service */
  initialize(): Promise<void>;
  /** Dispose of the service */
  dispose(): void;
}

/** Service with health checking */
export interface HealthCheckable {
  /** Check the service health */
  checkHealth(): Promise<ServiceHealth>;
}

// =============================================================================
// Initialization State Machine
// =============================================================================

/**
 * Initialization states for the plugin lifecycle
 *
 * State transitions:
 * UNINITIALIZED → CHECKING_PROVIDERS → LOADING_INDEX → WARMING_SERVICES → READY
 *                        ↓                   ↓                ↓
 *                     FAILED             CRASHED          DEGRADED
 */
export type InitializationState =
  | "UNINITIALIZED"
  | "CHECKING_PROVIDERS"
  | "LOADING_INDEX"
  | "WARMING_SERVICES"
  | "READY"
  | "DEGRADED"
  | "FAILED"
  | "CRASHED";

/** Reason for degraded or failed state */
export type DegradedReason =
  | "lmstudio_down"
  | "index_stale"
  | "embedding_mismatch"
  | "partial_init";

export type FailedReason =
  | "ollama_down"
  | "missing_config"
  | "connection_failed"
  | "index_corrupt"
  | "critical_error";

export type CrashedReason = "indexing_interrupted" | "recovery_needed";

/**
 * Context for the current initialization state
 */
export interface InitializationContext {
  /** Current state */
  state: InitializationState;
  /** Error message if in FAILED or CRASHED state */
  errorMessage?: string;
  /** Reason for DEGRADED state */
  degradedReason?: DegradedReason;
  /** Reason for FAILED state */
  failedReason?: FailedReason;
  /** Reason for CRASHED state */
  crashedReason?: CrashedReason;
  /** Timestamp of last state change */
  stateChangedAt: number;
  /** Available capabilities in current state */
  capabilities: {
    embeddings: boolean;
    chat: boolean;
    search: boolean;
    indexing: boolean;
  };
  /** Progress info for LOADING_INDEX or WARMING_SERVICES states */
  progress?: {
    stage: string;
    percent: number;
    message: string;
  };
}

/**
 * State transition definition for the initialization state machine
 */
export interface StateTransition {
  from: InitializationState;
  to: InitializationState;
  guard?: () => boolean | Promise<boolean>;
  onTransition?: () => void | Promise<void>;
}
