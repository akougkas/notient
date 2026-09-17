/**
 * Canonical note path accepted at every public content boundary.
 *
 * The filesystem adapter remains the final containment authority because it
 * resolves symlinks. This lexical predicate keeps hidden paths, traversal,
 * absolute paths, controls, and alternate spellings away from database-only
 * handlers before they query indexed note state.
 */
export function isCanonicalPublicNotePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const segments = value.split("/");
  const basename = segments.at(-1);
  return (
    isCanonicalPublicSegments(value, segments) &&
    value.endsWith(".md") &&
    basename !== ".md" &&
    !value.endsWith("/")
  );
}

export const NOTIENT_CONVERSATIONS_FOLDER = "Notient/conversations";
export const NOTIENT_PROPOSALS_FOLDER = "Notient/proposals";

const NOTIENT_OWNED_NOTE_ROOTS = [
  NOTIENT_CONVERSATIONS_FOLDER.toLowerCase(),
  NOTIENT_PROPOSALS_FOLDER.toLowerCase(),
] as const;

/** Canonical non-hidden vault file path, regardless of extension. */
export function isCanonicalPublicVaultFilePath(value: unknown): value is string {
  if (typeof value !== "string" || value.endsWith("/")) return false;
  return isCanonicalPublicSegments(value, value.split("/"));
}

/** True for Notient's conversation/proposal artifact roots and descendants. */
export function isNotientOwnedArtifactPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const folded = value.toLowerCase();
  return NOTIENT_OWNED_NOTE_ROOTS.some((root) => folded === root || folded.startsWith(`${root}/`));
}

/** One direct Markdown child of the canonical conversation store. */
export function isCanonicalConversationPath(value: unknown): value is string {
  if (!isCanonicalPublicNotePath(value)) return false;
  const prefix = `${NOTIENT_CONVERSATIONS_FOLDER}/`;
  if (!value.startsWith(prefix)) return false;
  return !value.slice(prefix.length).includes("/");
}

/**
 * Public Markdown path writable by the ordinary notes.* product surface.
 * Notient-owned conversation and proposal artifacts have dedicated writers
 * and formats; allowing a model to forge them would cross those authorities.
 */
export function isCanonicalOrdinaryNotePath(value: unknown): value is string {
  if (!isCanonicalPublicNotePath(value)) return false;
  return !isNotientOwnedArtifactPath(value);
}

/** Empty string is the vault root; every non-empty value is one exact public folder path. */
export function isCanonicalPublicFolderPath(value: unknown): value is string {
  if (value === "") return true;
  if (typeof value !== "string" || value.endsWith("/")) return false;
  return isCanonicalPublicSegments(value, value.split("/"));
}

function isCanonicalPublicSegments(raw: string, segments: readonly string[]): boolean {
  return (
    raw.length > 0 &&
    raw.trim() === raw &&
    !raw.startsWith("/") &&
    !/^[a-zA-Z]:/.test(raw) &&
    !raw.includes("\\") &&
    !containsControlCharacter(raw) &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        segment.trim() === segment &&
        !segment.startsWith("."),
    )
  );
}

function containsControlCharacter(raw: string): boolean {
  for (const character of raw) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return true;
  }
  return false;
}
