import { randomUUID } from "node:crypto";

/**
 * SurrealDB reports optimistic-concurrency failures as errors whose message
 * says the transaction can be retried. A transport can also disappear after
 * the server committed but before the client received its response. Under a
 * concurrent awaken, both outcomes are common enough that a single attempt
 * is not acceptable.
 */
const RETRYABLE =
  /transaction conflict|resource busy|can be retried|try again|connection (?:was )?(?:closed|lost|reset)|unexpected connection error|socket (?:closed|hang up)|network error|fetch failed|response lost/i;
const RETRYABLE_ERROR_NAMES = new Set([
  "CallTerminatedError",
  "ConnectionUnavailableError",
  "ReconnectExhaustionError",
  "ReconnectIterationError",
  "UnexpectedConnectionError",
]);

export function isRetryableSurrealError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    (error instanceof Error && RETRYABLE_ERROR_NAMES.has(error.name)) || RETRYABLE.test(message)
  );
}

export interface SurrealRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  /**
   * Stable identity for one logical operation. Callers normally let the
   * helper create this; tests and upstream request handlers may supply one
   * when they already own the operation identity.
   */
  idempotencyKey?: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface SurrealRetryContext {
  /** One-based attempt number. */
  readonly attempt: number;
  /** The same value for every attempt made by this helper invocation. */
  readonly idempotencyKey: string;
}

/**
 * Retry one logical SurrealDB operation. Mutating callbacks must use the
 * supplied idempotency key as part of the database write so the same key can
 * recognize a commit whose response was lost.
 */
export async function withSurrealRetry<T>(
  operation: (context: SurrealRetryContext) => Promise<T>,
  options: SurrealRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 5);
  const baseDelayMs = options.baseDelayMs ?? 25;
  const idempotencyKey = options.idempotencyKey ?? randomUUID();
  if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
    throw new Error("withSurrealRetry: idempotencyKey must not be empty");
  }
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation({ attempt, idempotencyKey });
    } catch (error) {
      lastError = error;
      if (!isRetryableSurrealError(error) || attempt === attempts) throw error;
      const jitter = Math.floor(Math.random() * baseDelayMs);
      await sleep(baseDelayMs * 2 ** (attempt - 1) + jitter);
    }
  }
  throw lastError;
}
