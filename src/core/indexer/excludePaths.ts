import { isNotientOwnedArtifactPath } from "../vault/publicPath";

export type ExcludePattern = { kind: "folder"; segments: string[] };

export function normalizeExcludePatterns(input: string[]): ExcludePattern[] {
  return input
    .map((raw) => raw.replace(/^\.?\/+/, "").replace(/\/+$/, ""))
    .filter((raw) => raw.length > 0)
    .map((raw) => ({ kind: "folder", segments: raw.split("/") }));
}

export function isExcluded(path: string, patterns: ExcludePattern[]): boolean {
  const parts = path.split("/");
  for (const pattern of patterns) {
    if (parts.length <= pattern.segments.length) continue;
    let matches = true;
    for (let index = 0; index < pattern.segments.length; index++) {
      if (parts[index] !== pattern.segments[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

/**
 * Compile a `settings.indexer.excludeGlobs` entry into a regex matched
 * against the posix vault-relative path.
 *
 * Semantics (deliberately minimal, matching the defaults we ship):
 *   - a leading double-star segment matches any number of path segments,
 *     including zero, so the shipped excalidraw glob matches both
 *     `b.excalidraw.md` and `a/b.excalidraw.md`.
 *   - `**` matches anything, slashes included.
 *   - `*` matches anything within a single segment.
 *   - `?` matches exactly one non-slash character.
 *   - every other character is escaped and matched literally.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          // Double-star segment: any depth, including zero segments.
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  source += "$";
  return new RegExp(source);
}

/**
 * Build the single predicate every indexing entry point consults.
 *
 * Notient-owned conversation and proposal artifacts are mandatory exclusions,
 * case-insensitively, regardless of user settings. Configured folder prefixes
 * and globs are unioned on top. The predicate is threaded through `FsVault`
 * (listing), `IndexerQueue` (enqueue), `VaultWatcher` (fs events), and
 * `purgeExcludedNotes` (retroactive cleanup), so no indexing entry point can
 * make the private stores searchable by weakening configuration.
 */
export function makeExclusionPredicate(input: {
  excludePaths: string[];
  excludeGlobs: string[];
}): (vaultPath: string) => boolean {
  const folders = normalizeExcludePatterns(input.excludePaths);
  const globs = input.excludeGlobs
    .filter((raw) => raw.length > 0)
    // A leading `/` is the Obsidian-style root anchor. Vault paths are
    // relative, so left in place it compiled to a regex that matched nothing
    // and the pattern was silently ignored.
    .map((raw) => globToRegExp(raw.replace(/^\.?\/+/, "")));
  return (vaultPath: string): boolean => {
    const normalized = vaultPath.replace(/^\.\//, "").replace(/\\/g, "/");
    if (isNotientOwnedArtifactPath(normalized)) return true;
    if (isExcluded(normalized, folders)) return true;
    for (const regex of globs) {
      if (regex.test(normalized)) return true;
    }
    return false;
  };
}
