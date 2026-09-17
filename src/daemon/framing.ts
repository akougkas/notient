/**
 * Newline framing for the daemon's Unix socket.
 *
 * The socket protocol is one JSON envelope per line. Accumulating bytes
 * until a newline arrives is unbounded on its own: a client that writes
 * megabytes with no newline grows the daemon's buffer by exactly that much
 * (16 MiB of input drove RSS to 160 MB). `consumeChunk` caps a single frame
 * and reports the breach so the caller can answer once and drop the
 * connection instead of accumulating forever.
 *
 * The function is pure so the framing rules are testable without a socket.
 */

/** Largest single frame the daemon accepts, in bytes. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export interface FramingResult {
  /** Complete frames, trimmed, with blank lines dropped. */
  lines: string[];
  /** Bytes left over for the next chunk. Empty after an overflow. */
  buffer: string;
  /**
   * A frame exceeded the cap. The caller answers with one error frame and
   * destroys the socket; nothing in this result is worth dispatching.
   */
  overflow: boolean;
}

const RESET: FramingResult = { lines: [], buffer: "", overflow: true };

/**
 * Append `chunk` to the carried-over `buffer` and split off whole frames.
 * Returns `overflow` when any frame, complete or still unterminated,
 * exceeds `maxBytes`.
 */
export function consumeChunk(
  buffer: string,
  chunk: string,
  maxBytes: number = MAX_FRAME_BYTES,
): FramingResult {
  let rest = buffer + chunk;
  const lines: string[] = [];
  let newlineIndex = rest.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = rest.slice(0, newlineIndex);
    if (Buffer.byteLength(line, "utf-8") > maxBytes) return RESET;
    rest = rest.slice(newlineIndex + 1);
    const trimmed = line.trim();
    if (trimmed.length > 0) lines.push(trimmed);
    newlineIndex = rest.indexOf("\n");
  }
  if (Buffer.byteLength(rest, "utf-8") > maxBytes) return RESET;
  return { lines, buffer: rest, overflow: false };
}
