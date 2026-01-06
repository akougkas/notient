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
