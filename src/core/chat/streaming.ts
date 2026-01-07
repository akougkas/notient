/**
 * Streaming Utilities
 *
 * Utilities for handling streaming responses.
 */

/**
 * Controller for a stream that can be pushed to externally
 */
export interface StreamController<T> {
  /** The async iterable stream */
  stream: AsyncIterable<T>;
  /** Push a value to the stream */
  push: (value: T) => void;
  /** Close the stream normally */
  close: () => void;
  /** Abort the stream with an error */
  abort: (reason?: Error) => void;
  /** Whether the stream is still open */
  isOpen: boolean;
}

/**
 * Create a controllable stream
 * @returns A stream controller
 */
export function createStreamController<T>(): StreamController<T> {
  const queue: T[] = [];
  let resolveNext: ((result: IteratorResult<T>) => void) | null = null;
  let closed = false;
  let error: Error | null = null;

  const stream: AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        async next(): Promise<IteratorResult<T>> {
          // Return queued values first
          if (queue.length > 0) {
            return { value: queue.shift()!, done: false };
          }

          // Check if closed or errored
          if (closed) {
            return { value: undefined as unknown as T, done: true };
          }
          if (error) {
            throw error;
          }

          // Wait for next value
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
      };
    },
  };

  return {
    stream,

    push(value: T): void {
      if (closed || error) return;

      if (resolveNext) {
        resolveNext({ value, done: false });
        resolveNext = null;
      } else {
        queue.push(value);
      }
    },

    close(): void {
      if (closed) return;
      closed = true;

      if (resolveNext) {
        resolveNext({ value: undefined as unknown as T, done: true });
        resolveNext = null;
      }
    },

    abort(reason?: Error): void {
      if (closed) return;
      error = reason ?? new Error("Stream aborted");
      closed = true;

      if (resolveNext) {
        // The next() call will throw when it checks error
        resolveNext({ value: undefined as unknown as T, done: true });
        resolveNext = null;
      }
    },

    get isOpen(): boolean {
      return !closed && !error;
    },
  };
}

/**
 * Merge multiple async iterables into one
 * @param streams - The streams to merge
 * @yields Values from all streams as they arrive
 */
export async function* mergeStreams<T>(
  streams: AsyncIterable<T>[]
): AsyncIterable<T> {
  // Create iterators
  const iterators = streams.map((s) => s[Symbol.asyncIterator]());

  // Track active iterators
  const active = new Set(iterators);

  // Create promises for each iterator
  const promises = new Map<
    AsyncIterator<T>,
    Promise<{ iterator: AsyncIterator<T>; result: IteratorResult<T> }>
  >();

  const getNextPromise = (iterator: AsyncIterator<T>) => {
    const promise = iterator.next().then((result) => ({ iterator, result }));
    promises.set(iterator, promise);
    return promise;
  };

  // Initialize promises
  for (const iterator of iterators) {
    getNextPromise(iterator);
  }

  // Process until all iterators are done
  while (active.size > 0) {
    const { iterator, result } = await Promise.race(
      Array.from(promises.values())
    );

    if (result.done) {
      active.delete(iterator);
      promises.delete(iterator);
    } else {
      yield result.value;
      getNextPromise(iterator);
    }
  }
}

/**
 * Collect all values from an async iterable into an array
 * @param stream - The stream to collect
 * @returns Array of all values
 */
export async function collectStream<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const value of stream) {
    results.push(value);
  }
  return results;
}

/**
 * Collect a string stream into a single string
 * @param stream - The string stream
 * @returns The concatenated string
 */
export async function collectStringStream(
  stream: AsyncIterable<string>
): Promise<string> {
  let result = "";
  for await (const chunk of stream) {
    result += chunk;
  }
  return result;
}
