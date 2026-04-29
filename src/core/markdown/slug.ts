/**
 * Obsidian-compatible heading slugifier.
 *
 *   "Heading One"      → "heading-one"
 *   "What's New?"      → "whats-new"
 *   "Café"             → "café"
 *   "  spaced   out  " → "spaced-out"
 *
 * Rules: lowercase (case-folded for non-ASCII letters), whitespace runs
 * collapse to single dashes, punctuation stripped except hyphens, and
 * leading/trailing dashes trimmed. Non-ASCII letters and digits are
 * preserved (Unicode property classes \p{L} and \p{N}).
 *
 * Spec: §8.3, Phase 2 plan §Task 8.
 */
export function headingSlug(text: string): string {
  if (text.length === 0) {
    return "";
  }
  let result = text.toLowerCase();
  result = result.replace(/[^\p{L}\p{N}\s-]/gu, "");
  result = result.replace(/\s+/g, "-");
  result = result.replace(/-+/g, "-");
  result = result.replace(/^-+|-+$/g, "");
  return result;
}
