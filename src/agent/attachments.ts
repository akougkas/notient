import type { VaultAdapter } from "../adapters/vaultAdapter";

const MENTION_PATTERN = /(?<![\w@.])@(?:"([^"]+)"|(\S+))/g;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const PDF_EXT = ".pdf";
const CANVAS_EXT = ".canvas";
const TEXT_EXT = new Set([
  ".md",
  ".txt",
  ".json",
  ".csv",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".rs",
]);

export interface VisionAttachment {
  path: string;
  bytes: ArrayBuffer;
  mediaType: string;
}

export interface ResolveAttachmentsOptions {
  vault: VaultAdapter;
  message: string;
  maxTokens: number;
  resolveImage: (
    path: string,
    bytes: ArrayBuffer,
    mediaType: string,
  ) => Promise<string>;
}

export interface ResolvedAttachments {
  pinnedContext: string[];
  visionImages: VisionAttachment[];
}

export function extractMentions(message: string): string[] {
  const out: string[] = [];
  let match: RegExpExecArray | null;
  MENTION_PATTERN.lastIndex = 0;
  while ((match = MENTION_PATTERN.exec(message)) !== null) {
    const captured = match[1] ?? match[2];
    if (!captured) continue;
    if (captured.includes("@")) continue;
    if (captured.length === 0) continue;
    out.push(captured);
  }
  return out;
}

export async function resolveAttachments(
  options: ResolveAttachmentsOptions,
): Promise<ResolvedAttachments> {
  const mentions = extractMentions(options.message);
  const pinnedContext: string[] = [];
  const visionImages: VisionAttachment[] = [];

  for (const path of mentions) {
    const extension = pathExtension(path);
    const exists = await options.vault.exists(path).catch(() => false);
    if (!exists) {
      pinnedContext.push(`[attachment: ${path}] (not found)`);
      continue;
    }
    if (IMAGE_EXT.has(extension)) {
      const bytes = await options.vault.readBinary(path);
      if (!bytes) {
        pinnedContext.push(`[attachment: ${path}] (empty binary)`);
        continue;
      }
      const mediaType = imageMediaType(extension);
      const description = await options.resolveImage(path, bytes, mediaType);
      pinnedContext.push(
        `[image: ${path}] ${truncateForBudget(description, options.maxTokens)}`,
      );
      visionImages.push({ path, bytes, mediaType });
      continue;
    }
    if (extension === PDF_EXT) {
      const bytes = await options.vault.readBinary(path);
      if (!bytes) {
        pinnedContext.push(`[attachment: ${path}] (empty binary)`);
        continue;
      }
      const text = await extractPdfText(bytes);
      pinnedContext.push(
        `[attachment: ${path}]\n${truncateForBudget(text, options.maxTokens)}`,
      );
      continue;
    }
    if (extension === CANVAS_EXT) {
      const raw = await options.vault.read(path);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      const summary = JSON.stringify(parsed, null, 2);
      pinnedContext.push(
        `[attachment: ${path}]\n${truncateForBudget(summary, options.maxTokens)}`,
      );
      continue;
    }
    if (TEXT_EXT.has(extension) || extension === "") {
      const raw = await options.vault.read(path);
      pinnedContext.push(
        `[attachment: ${path}]\n${truncateForBudget(raw, options.maxTokens)}`,
      );
      continue;
    }
    pinnedContext.push(`[attachment: ${path}] (unsupported extension ${extension})`);
  }
  return { pinnedContext, visionImages };
}

async function extractPdfText(bytes: ArrayBuffer): Promise<string> {
  const { extractText } = await import("unpdf");
  const result = await extractText(new Uint8Array(bytes));
  return result.text.join("\n\n");
}

function pathExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "";
  return path.slice(dot).toLowerCase();
}

function imageMediaType(extension: string): string {
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".bmp") return "image/bmp";
  return "application/octet-stream";
}

function truncateForBudget(text: string, maxTokens: number): string {
  // Conservative chars-per-token estimate for code/markdown; keeps the
  // pinned-context layer under the configured budget without invoking a
  // tokenizer. ContextManager applies the real token count downstream.
  const charBudget = maxTokens * 4;
  if (text.length <= charBudget) return text;
  return `${text.slice(0, charBudget)}\n[truncated]`;
}
