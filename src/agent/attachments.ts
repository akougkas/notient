import type { VaultAdapter } from "../adapters/vaultAdapter";

const MENTION_PATTERN = /(?<![\w@.])@(?:"([^"]+)"|(\S+))/g;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const PDF_EXT = ".pdf";
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
  resolveImage: (path: string, bytes: ArrayBuffer, mediaType: string) => Promise<string>;
}

export interface ResolvedAttachments {
  pinnedContext: string[];
  visionImages: VisionAttachment[];
}

export function extractMentions(message: string): string[] {
  const out: string[] = [];
  for (const match of message.matchAll(MENTION_PATTERN)) {
    const captured = match[1] ?? match[2];
    if (!captured) continue;
    if (captured.includes("@")) continue;
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
    const exists = await options.vault.exists(path).catch(() => false);
    if (!exists) {
      pinnedContext.push(`[attachment: ${path}] (not found)`);
      continue;
    }
    const resolved = await resolveOne(path, options);
    pinnedContext.push(resolved.line);
    if (resolved.image) visionImages.push(resolved.image);
  }
  return { pinnedContext, visionImages };
}

interface ResolvedOne {
  line: string;
  image: VisionAttachment | null;
}

async function resolveOne(path: string, options: ResolveAttachmentsOptions): Promise<ResolvedOne> {
  const extension = pathExtension(path);
  if (IMAGE_EXT.has(extension)) return resolveImage(path, extension, options);
  if (extension === PDF_EXT) return resolvePdf(path, options);
  if (TEXT_EXT.has(extension) || extension === "") return resolveText(path, options);
  return {
    line: `[attachment: ${path}] (unsupported extension ${extension})`,
    image: null,
  };
}

async function resolveImage(
  path: string,
  extension: string,
  options: ResolveAttachmentsOptions,
): Promise<ResolvedOne> {
  const bytes = await options.vault.readBinary(path);
  if (!bytes) return { line: `[attachment: ${path}] (empty binary)`, image: null };
  const mediaType = imageMediaType(extension);
  const description = await options.resolveImage(path, bytes, mediaType);
  return {
    line: `[image: ${path}] ${truncateForBudget(description, options.maxTokens)}`,
    image: { path, bytes, mediaType },
  };
}

async function resolvePdf(path: string, options: ResolveAttachmentsOptions): Promise<ResolvedOne> {
  const bytes = await options.vault.readBinary(path);
  if (!bytes) return { line: `[attachment: ${path}] (empty binary)`, image: null };
  const text = await extractPdfText(bytes);
  return {
    line: `[attachment: ${path}]\n${truncateForBudget(text, options.maxTokens)}`,
    image: null,
  };
}

async function resolveText(path: string, options: ResolveAttachmentsOptions): Promise<ResolvedOne> {
  const raw = await options.vault.read(path);
  return {
    line: `[attachment: ${path}]\n${truncateForBudget(raw, options.maxTokens)}`,
    image: null,
  };
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
