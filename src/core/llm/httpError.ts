/** HTTP rejections are distinct from ambiguous disconnects and incomplete generations. */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
  get retryable(): boolean {
    return [408, 409, 429].includes(this.status) || this.status >= 500;
  }
}

export async function providerHttpError(response: Response): Promise<ProviderHttpError> {
  const reader = response.body?.getReader();
  let detail = "";
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (bytes < 4096) {
        const next = await reader.read();
        if (next.done) break;
        const part = next.value.subarray(0, 4096 - bytes);
        detail += decoder.decode(part, { stream: true });
        bytes += part.length;
      }
      detail += decoder.decode();
    } catch {
      /* Keep a received rejection even when its optional body disconnects. */
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  try {
    const parsed = JSON.parse(detail);
    detail =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.error?.message === "string"
          ? parsed.error.message
          : typeof parsed.message === "string"
            ? parsed.message
            : "";
  } catch {
    /* Some local servers return a plain-text diagnostic. */
  }
  return new ProviderHttpError(
    response.status,
    `LLM ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 1600)}` : ""}`,
  );
}
