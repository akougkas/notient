/**
 * Authentication boundary for operator-configured OpenAI-compatible endpoints.
 *
 * Credentials are deployment secrets, never product configuration. Callers
 * resolve them from the deployment environment and pass them directly to the
 * HTTP boundary; no wire result or persisted settings object contains them.
 */

const RFC_6750_BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+={0,}$/u;

/**
 * Validate one canonical RFC 6750 bearer token without ever including its
 * value in an error. Whitespace and header-control characters are therefore
 * rejected before a credential can reach `fetch`.
 */
export function validateBearerToken(value: string, label: string): string {
  if (!RFC_6750_BEARER_TOKEN.test(value)) {
    throw new Error(
      `notient: ${label}: expected a non-empty RFC 6750 bearer token without whitespace`,
    );
  }
  return value;
}

/** Build request headers without mutating or exposing the supplied token. */
export function endpointRequestHeaders(
  apiKey: string | undefined,
  contentType: "json" | "none",
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType === "json") headers["Content-Type"] = "application/json";
  if (apiKey !== undefined) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/**
 * Defensive redaction for untrusted endpoint error bodies. Compatible servers
 * should never echo Authorization, but their text is still safe to surface if
 * an implementation does so accidentally.
 */
export function redactBearerToken(text: string, apiKey: string | undefined): string {
  if (apiKey === undefined || !text.includes(apiKey)) return text;
  return text.split(apiKey).join("[redacted]");
}

/**
 * Refuse an authenticated endpoint response that contains its request
 * credential. Successful response data is untrusted too: allowing an echoed
 * bearer token through assistant text, tool arguments, or a model id would
 * move a deployment secret into chat history, logs, or the RPC wire.
 */
export function assertBearerTokenAbsent(
  value: unknown,
  apiKey: string | undefined,
  label: string,
): void {
  if (apiKey === undefined) return;
  const seen = new WeakSet<object>();
  const visit = (entry: unknown): void => {
    if (typeof entry === "string") {
      if (entry.includes(apiKey)) {
        throw new Error(`${label} contained the configured provider credential`);
      }
      return;
    }
    if (typeof entry !== "object" || entry === null || seen.has(entry)) return;
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    for (const [key, item] of Object.entries(entry)) {
      visit(key);
      visit(item);
    }
  };
  visit(value);
}

/**
 * Detect a bearer token split across logical stream deltas. The completing
 * delta is rejected before it is yielded, so a consumer can never reassemble
 * the full credential from successful stream output.
 */
export function createBearerTokenStreamGuard(
  apiKey: string | undefined,
  label: string,
): (chunk: string) => void {
  if (apiKey === undefined) return () => {};
  let tail = "";
  return (chunk: string): void => {
    const combined = tail + chunk;
    if (combined.includes(apiKey)) {
      throw new Error(`${label} contained the configured provider credential`);
    }
    const tailLength = apiKey.length - 1;
    tail = tailLength === 0 ? "" : combined.slice(-tailLength);
  };
}
