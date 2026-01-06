/**
 * Job queue types for persistent background processing
 */

/** Job status */
export type JobStatus = "pending" | "in_progress" | "completed" | "failed";

/** Job types */
export type JobType = "index" | "reindex" | "delete" | "search";

/** Base job structure */
export interface Job<T extends JobType = JobType, P = unknown> {
  /** Unique job ID */
  id: string;
  /** Job type */
  type: T;
  /** Job payload */
  payload: P;
  /** Current status */
  status: JobStatus;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
  /** Attempt count */
  attempts: number;
  /** Max attempts before permanent failure */
  maxAttempts: number;
  /** Error message if failed */
  error: string | null;
  /** Priority (higher = sooner) */
  priority: number;
}

/** Index job payload */
export interface IndexJobPayload {
  path: string;
  reason: "create" | "modify" | "startup" | "manual";
}

/** Reindex job payload */
export interface ReindexJobPayload {
  reason: "model_change" | "settings_change" | "manual";
}

/** Delete job payload */
export interface DeleteJobPayload {
  path: string;
  noteId: string;
}

/** Job queue status */
export interface JobQueueStatus {
  /** Pending jobs count */
  pending: number;
  /** In-progress jobs count */
  inProgress: number;
  /** Completed jobs count (recent) */
  completed: number;
  /** Failed jobs count */
  failed: number;
  /** Is the queue processing */
  processing: boolean;
  /** Is the queue paused */
  paused: boolean;
}

/** Typed job helpers */
export type IndexJob = Job<"index", IndexJobPayload>;
export type ReindexJob = Job<"reindex", ReindexJobPayload>;
export type DeleteJob = Job<"delete", DeleteJobPayload>;
