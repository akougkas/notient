export type ExcludePattern = { kind: "folder"; segments: string[] };

export function normalizeExcludePatterns(input: string[]): ExcludePattern[] {
  return input
    .map((raw) => raw.replace(/^\.\//, "").replace(/\/+$/, ""))
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
