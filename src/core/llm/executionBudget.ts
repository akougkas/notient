import { AsyncLocalStorage } from "node:async_hooks";
import { NoteApiError } from "../../api/schema";
import type { CompletionMetadata } from "./completion";
import type { ChatMessage } from "./provider";

export interface InferenceBudgetLimits {
  modelCalls: number;
  tokens: number;
  durationMs: number;
  generationTokens?: number;
}
export interface InferenceAttempt {
  sequence: number;
  inputTokenEstimate: number;
  generationCeiling: number;
  chargedTokens: number;
  accounting: "reserved-estimate" | "provider-total" | "provider-components";
  completion: CompletionMetadata | null;
}

const activeBudget = new AsyncLocalStorage<InferenceBudget>();

/** One run owns all nested calls, retries and finalization. Reservations happen
 * before dispatch and stay charged on disconnect/cancel without reported usage. */
export class InferenceBudget {
  readonly attempts: InferenceAttempt[] = [];
  readonly signal: AbortSignal;
  private readonly parent = activeBudget.getStore();
  private readonly timeout: AbortSignal;
  private readonly start = performance.now();
  private checkpointTail: Promise<void> = Promise.resolve();
  constructor(
    readonly limits: InferenceBudgetLimits,
    priorAttempts: InferenceAttempt[] = [],
    private readonly persist?: (attempts: InferenceAttempt[]) => Promise<void>,
    parentSignal?: AbortSignal,
  ) {
    for (const key of ["modelCalls", "tokens", "durationMs"] as const) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 0)
        throw new Error(`invalid inference budget ${key}`);
    }
    if (
      limits.generationTokens !== undefined &&
      (!Number.isSafeInteger(limits.generationTokens) ||
        limits.generationTokens < 1 ||
        limits.generationTokens > 131072)
    )
      throw new Error("invalid inference generation ceiling");
    this.attempts = structuredClone(priorAttempts);
    this.timeout = AbortSignal.timeout(Math.max(1, limits.durationMs));
    const deadline = new AbortController();
    this.timeout.addEventListener(
      "abort",
      () =>
        deadline.abort(new NoteApiError("LIMIT_EXCEEDED", "inference duration budget exhausted")),
      { once: true },
    );
    this.signal = AbortSignal.any([
      deadline.signal,
      ...(parentSignal ? [parentSignal] : []),
      ...(this.parent ? [this.parent.signal] : []),
    ]);
  }
  get chargedTokens(): number {
    return this.attempts.reduce((sum, item) => sum + item.chargedTokens, 0);
  }
  assertAvailable(): void {
    this.signal.throwIfAborted();
    this.parent?.assertAvailable();
    if (performance.now() - this.start >= this.limits.durationMs)
      throw new NoteApiError("LIMIT_EXCEEDED", "inference duration budget exhausted");
    if (this.chargedTokens > this.limits.tokens)
      throw new NoteApiError(
        "LIMIT_EXCEEDED",
        "provider usage exceeded the reserved run token budget; further effects are forbidden",
      );
  }
  run<T>(task: () => Promise<T>): Promise<T> {
    if (activeBudget.getStore() !== this.parent)
      throw new Error(
        "cannot replace an active inference budget; construct child budgets inside their owning run",
      );
    return activeBudget.run(this, task);
  }
  reserve(
    inputTokenEstimate: number,
    requestedCeiling: number,
  ): { maxTokens: number; ready: Promise<void>; settle: (metadata: CompletionMetadata) => void } {
    if (
      !Number.isSafeInteger(inputTokenEstimate) ||
      inputTokenEstimate < 0 ||
      !Number.isSafeInteger(requestedCeiling) ||
      requestedCeiling < 0
    )
      throw new Error("inference reservation requires nonnegative integer estimates and ceilings");
    const chain: InferenceBudget[] = [];
    for (let member: InferenceBudget | undefined = this; member; member = member.parent)
      chain.push(member);
    // Preflight the entire chain synchronously before reserving any member.
    // Parallel sibling tools cannot each spend the same parent remainder.
    let maxTokens = requestedCeiling;
    for (const member of chain) {
      member.assertAvailable();
      if (member.attempts.length >= member.limits.modelCalls)
        throw new NoteApiError("LIMIT_EXCEEDED", "inference model-call budget exhausted");
      maxTokens = Math.min(
        maxTokens,
        member.limits.generationTokens ?? requestedCeiling,
        member.limits.tokens - member.chargedTokens - inputTokenEstimate,
      );
    }
    if (maxTokens < 0 || (requestedCeiling > 0 && maxTokens < 1))
      throw new NoteApiError(
        "LIMIT_EXCEEDED",
        "inference token budget cannot admit another request",
      );
    const reservations = chain.map((member) => member.reserveLocal(inputTokenEstimate, maxTokens));
    return {
      maxTokens,
      ready: Promise.all(reservations.map((reservation) => reservation.ready)).then(() => {}),
      settle: (metadata) => {
        for (const reservation of reservations) reservation.settle(metadata);
      },
    };
  }
  private reserveLocal(inputTokenEstimate: number, maxTokens: number) {
    const attempt: InferenceAttempt = {
      sequence: this.attempts.length + 1,
      inputTokenEstimate,
      generationCeiling: maxTokens,
      chargedTokens: inputTokenEstimate + maxTokens,
      accounting: "reserved-estimate",
      completion: null,
    };
    this.attempts.push(attempt);
    let settled = false;
    return {
      maxTokens,
      ready: this.checkpoint(),
      settle: (metadata: CompletionMetadata) => {
        if (settled) return;
        settled = true;
        attempt.completion = structuredClone(metadata);
        const usage = metadata.usage;
        if (usage.totalTokens !== null) {
          attempt.chargedTokens = usage.totalTokens;
          attempt.accounting = "provider-total";
        } else if (usage.promptTokens !== null && usage.completionTokens !== null) {
          attempt.chargedTokens = usage.promptTokens + usage.completionTokens;
          attempt.accounting = "provider-components";
        }
        void this.checkpoint().catch(() => {});
      },
    };
  }
  /** Effects and final job state must await durable provider accounting. */
  flush(): Promise<void> {
    return Promise.all([this.checkpointTail, this.parent?.flush()]).then(() => {});
  }
  private checkpoint(): Promise<void> {
    const snapshot = structuredClone(this.attempts);
    this.checkpointTail = this.checkpointTail.then(async () => {
      await this.persist?.(snapshot);
    });
    return this.checkpointTail;
  }
}

export function reserveGeneration(
  messages: ChatMessage[],
  requested: number,
  extra: unknown,
  signal?: AbortSignal,
  observer?: (metadata: CompletionMetadata) => void,
): {
  maxTokens: number;
  signal?: AbortSignal;
  onCompletion: (metadata: CompletionMetadata) => void;
  ready: Promise<void>;
} {
  const budget = activeBudget.getStore();
  // UTF-8 byte count plus framing is a conservative estimate, not measured
  // prompt usage. Include tools/schema and all prior results on every round.
  const inputEstimate = estimateInputTokens(messages, extra);
  const reservation = budget?.reserve(inputEstimate, requested);
  return {
    maxTokens: reservation?.maxTokens ?? requested,
    ready: reservation?.ready ?? Promise.resolve(),
    signal: budget ? (signal ? AbortSignal.any([signal, budget.signal]) : budget.signal) : signal,
    onCompletion: (metadata) => {
      reservation?.settle(metadata);
      observer?.(metadata);
    },
  };
}

/** Conservative UTF-8/framing estimate, never provider-measured usage. */
export function estimateInputTokens(messages: ChatMessage[], extra: unknown): number {
  return Buffer.byteLength(JSON.stringify({ messages, extra })) + 256 + messages.length * 64;
}

/** Domain effects must not outlive a turn's resource authority. */
export function assertInferenceBudgetAvailable(): void {
  activeBudget.getStore()?.assertAvailable();
}
