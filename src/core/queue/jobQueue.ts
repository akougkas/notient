/**
 * Persistent Job Queue
 * 
 * Manages background processing with crash recovery.
 * Jobs persist to disk and recover on restart.
 */

import * as fs from "fs";
import * as path from "path";
import type { StoragePaths } from "../../services/storagePaths";
import type { EventBus } from "../events/eventBus";
import type { Job, JobType, JobStatus, JobQueueStatus } from "../../types/queue";
import { PERFORMANCE } from "../constants";

const QUEUE_FILE = "queue.json";
const MAX_RETRIES = 3;

interface QueueState {
  jobs: Job[];
  version: number;
}

type JobProcessor<T extends JobType, P> = (job: Job<T, P>) => Promise<void>;

/**
 * Persistent job queue with crash recovery
 */
export class JobQueue {
  private jobs: Map<string, Job> = new Map();
  private processors: Map<JobType, JobProcessor<JobType, unknown>> = new Map();
  private processing = false;
  private paused = false;
  private queueFile: string;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private storagePaths: StoragePaths,
    private eventBus: EventBus
  ) {
    this.queueFile = path.join(storagePaths.queue, QUEUE_FILE);
  }

  /**
   * Initialize the queue, loading persisted state
   */
  async initialize(): Promise<void> {
    await this.loadQueue();
    await this.recoverInProgressJobs();
  }

  /**
   * Register a processor for a job type
   */
  registerProcessor<T extends JobType, P>(
    type: T,
    processor: JobProcessor<T, P>
  ): void {
    this.processors.set(type, processor as JobProcessor<JobType, unknown>);
  }

  /**
   * Add a job to the queue
   */
  async enqueue<T extends JobType, P>(
    type: T,
    payload: P,
    options: { priority?: number; maxAttempts?: number } = {}
  ): Promise<string> {
    const id = this.generateId();
    const job: Job<T, P> = {
      id,
      type,
      payload,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempts: 0,
      maxAttempts: options.maxAttempts ?? MAX_RETRIES,
      error: null,
      priority: options.priority ?? 0,
    };

    this.jobs.set(id, job);
    await this.saveQueue();
    this.emitStatusChange();

    // Start processing if not already
    if (!this.processing && !this.paused) {
      this.processNext();
    }

    return id;
  }

  /**
   * Enqueue multiple jobs at once
   */
  async enqueueBatch<T extends JobType, P>(
    type: T,
    payloads: P[],
    options: { priority?: number; maxAttempts?: number } = {}
  ): Promise<string[]> {
    const ids: string[] = [];
    
    for (const payload of payloads) {
      const id = this.generateId();
      const job: Job<T, P> = {
        id,
        type,
        payload,
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempts: 0,
        maxAttempts: options.maxAttempts ?? MAX_RETRIES,
        error: null,
        priority: options.priority ?? 0,
      };
      this.jobs.set(id, job);
      ids.push(id);
    }

    await this.saveQueue();
    this.emitStatusChange();

    if (!this.processing && !this.paused) {
      this.processNext();
    }

    return ids;
  }

  /**
   * Get queue status
   */
  getStatus(): JobQueueStatus {
    let pending = 0;
    let inProgress = 0;
    let completed = 0;
    let failed = 0;

    for (const job of this.jobs.values()) {
      switch (job.status) {
        case "pending":
          pending++;
          break;
        case "in_progress":
          inProgress++;
          break;
        case "completed":
          completed++;
          break;
        case "failed":
          failed++;
          break;
      }
    }

    return {
      pending,
      inProgress,
      completed,
      failed,
      processing: this.processing,
      paused: this.paused,
    };
  }

  /**
   * Get a job by ID
   */
  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /**
   * Get all jobs of a specific type
   */
  getJobsByType(type: JobType): Job[] {
    return Array.from(this.jobs.values()).filter((j) => j.type === type);
  }

  /**
   * Pause queue processing
   */
  pause(): void {
    this.paused = true;
    this.emitStatusChange();
  }

  /**
   * Resume queue processing
   */
  resume(): void {
    this.paused = false;
    this.emitStatusChange();
    if (!this.processing) {
      this.processNext();
    }
  }

  /**
   * Clear completed and failed jobs
   */
  async clearFinished(): Promise<void> {
    for (const [id, job] of this.jobs) {
      if (job.status === "completed" || job.status === "failed") {
        this.jobs.delete(id);
      }
    }
    await this.saveQueue();
    this.emitStatusChange();
  }

  /**
   * Remove a specific job
   */
  async removeJob(id: string): Promise<boolean> {
    const deleted = this.jobs.delete(id);
    if (deleted) {
      await this.saveQueue();
      this.emitStatusChange();
    }
    return deleted;
  }

  /**
   * Dispose of the queue
   */
  dispose(): void {
    this.disposed = true;
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    // Force save on dispose
    this.saveQueueSync();
  }

  // ============ Private Methods ============

  private async processNext(): Promise<void> {
    if (this.disposed || this.paused) {
      this.processing = false;
      return;
    }

    const next = this.getNextJob();
    if (!next) {
      this.processing = false;
      return;
    }

    this.processing = true;
    const processor = this.processors.get(next.type);

    if (!processor) {
      console.error(`[JobQueue] No processor for job type: ${next.type}`);
      next.status = "failed";
      next.error = `No processor for type: ${next.type}`;
      next.updatedAt = Date.now();
      await this.saveQueue();
      this.emitStatusChange();
      
      // Time slice before next job
      setTimeout(() => this.processNext(), PERFORMANCE.QUEUE_TIME_SLICE_MS);
      return;
    }

    // Mark as in progress
    next.status = "in_progress";
    next.attempts++;
    next.updatedAt = Date.now();
    this.emitStatusChange();

    try {
      await processor(next);
      next.status = "completed";
      next.error = null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[JobQueue] Job ${next.id} failed:`, errorMessage);

      if (next.attempts >= next.maxAttempts) {
        next.status = "failed";
        next.error = errorMessage;
      } else {
        // Retry
        next.status = "pending";
        next.error = `Attempt ${next.attempts} failed: ${errorMessage}`;
      }
    }

    next.updatedAt = Date.now();
    await this.saveQueue();
    this.emitStatusChange();

    // Time slice before next job to keep UI responsive
    setTimeout(() => this.processNext(), PERFORMANCE.QUEUE_TIME_SLICE_MS);
  }

  private getNextJob(): Job | null {
    const pending = Array.from(this.jobs.values())
      .filter((j) => j.status === "pending")
      .sort((a, b) => {
        // Higher priority first
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        // Then by creation time
        return a.createdAt - b.createdAt;
      });

    return pending[0] ?? null;
  }

  private async loadQueue(): Promise<void> {
    try {
      const content = await fs.promises.readFile(this.queueFile, "utf-8");
      const state: QueueState = JSON.parse(content);
      
      this.jobs.clear();
      for (const job of state.jobs) {
        this.jobs.set(job.id, job);
      }
    } catch (error) {
      // File doesn't exist or is invalid - start fresh
      this.jobs.clear();
    }
  }

  private async recoverInProgressJobs(): Promise<void> {
    // Jobs that were in_progress when we crashed should be retried
    for (const job of this.jobs.values()) {
      if (job.status === "in_progress") {
        console.log(`[JobQueue] Recovering interrupted job: ${job.id}`);
        job.status = "pending";
        job.updatedAt = Date.now();
      }
    }
    await this.saveQueue();
  }

  private async saveQueue(): Promise<void> {
    // Debounce saves
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(async () => {
      try {
        const state: QueueState = {
          version: 1,
          jobs: Array.from(this.jobs.values()),
        };
        await fs.promises.mkdir(this.storagePaths.queue, { recursive: true });
        await fs.promises.writeFile(
          this.queueFile,
          JSON.stringify(state, null, 2)
        );
      } catch (error) {
        console.error("[JobQueue] Failed to save queue:", error);
      }
    }, 100);
  }

  private saveQueueSync(): void {
    try {
      const state: QueueState = {
        version: 1,
        jobs: Array.from(this.jobs.values()),
      };
      fs.mkdirSync(this.storagePaths.queue, { recursive: true });
      fs.writeFileSync(this.queueFile, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error("[JobQueue] Failed to save queue sync:", error);
    }
  }

  private emitStatusChange(): void {
    this.eventBus.emit("queue:changed", { status: this.getStatus() });
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
