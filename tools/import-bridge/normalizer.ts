/**
 * Link Normalizer
 *
 * Converts markdown links to Obsidian wikilinks.
 * Shared between CLI and plugin.
 */

import type { DetectedLink, NormalizationResult } from "./types";

/**
 * Regex patterns for link detection
 */
const PATTERNS = {
  // Standard markdown links: [text](url)
  // Captures: [1] = text, [2] = url
  markdown: /\[([^\]]+)\]\(([^)]+)\)/g,

  // Wikilinks: [[target]] or [[target|alias]]
  wikilink: /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,

  // External URL detection (http, https, ftp, mailto)
  external: /^(https?|ftp|mailto):/i,
};

/**
 * Check if a URL is external (should not be converted)
 */
export function isExternalLink(url: string): boolean {
  return PATTERNS.external.test(url.trim());
}

/**
 * Extract the note name from a path
 * - Removes .md extension
 * - Takes only the filename (not full path)
 *
 * @example
 * extractNoteName("path/to/note.md") => "note"
 * extractNoteName("./relative.md") => "relative"
 * extractNoteName("note") => "note"
 */
export function extractNoteName(path: string): string {
  // Remove leading ./ or ../
  let cleaned = path.replace(/^\.\.?\//, "");

  // Get just the filename
  const parts = cleaned.split("/");
  let filename = parts[parts.length - 1];

  // Remove .md extension (case insensitive)
  filename = filename.replace(/\.md$/i, "");

  // Remove any URL fragments or query params
  filename = filename.split("#")[0].split("?")[0];

  return filename;
}

/**
 * Convert a markdown link to a wikilink
 *
 * @example
 * toWikilink("note", "Click here") => "[[note|Click here]]"
 * toWikilink("note", "note") => "[[note]]"
 */
export function toWikilink(noteName: string, displayText: string): string {
  // If display text matches note name, use simple wikilink
  if (displayText.toLowerCase() === noteName.toLowerCase()) {
    return `[[${noteName}]]`;
  }
  return `[[${noteName}|${displayText}]]`;
}

/**
 * Find all links in markdown content
 */
export function findLinks(content: string): DetectedLink[] {
  const links: DetectedLink[] = [];

  // Find markdown links
  const mdRegex = new RegExp(PATTERNS.markdown.source, "g");
  let match: RegExpExecArray | null;

  while ((match = mdRegex.exec(content)) !== null) {
    const [fullMatch, text, target] = match;
    links.push({
      fullMatch,
      text,
      target,
      start: match.index,
      end: match.index + fullMatch.length,
      type: isExternalLink(target) ? "external" : "markdown",
    });
  }

  // Find existing wikilinks (to preserve them)
  const wikiRegex = new RegExp(PATTERNS.wikilink.source, "g");
  while ((match = wikiRegex.exec(content)) !== null) {
    const [fullMatch, target, alias] = match;
    links.push({
      fullMatch,
      text: alias || target,
      target,
      start: match.index,
      end: match.index + fullMatch.length,
      type: "wikilink",
    });
  }

  // Sort by position (for replacement)
  return links.sort((a, b) => a.start - b.start);
}

/**
 * Normalize markdown content by converting links to wikilinks
 *
 * @param content - Raw markdown content
 * @returns Normalization result with converted content
 */
export function normalizeContent(content: string): NormalizationResult {
  const links = findLinks(content);
  const conversions: Array<{ from: string; to: string }> = [];
  const preserved: string[] = [];

  // Process links in reverse order to preserve positions
  let normalized = content;
  const markdownLinks = links
    .filter((l) => l.type === "markdown")
    .sort((a, b) => b.start - a.start);

  for (const link of markdownLinks) {
    const noteName = extractNoteName(link.target);
    const wikilink = toWikilink(noteName, link.text);

    // Replace in content
    normalized =
      normalized.slice(0, link.start) + wikilink + normalized.slice(link.end);

    conversions.push({
      from: link.fullMatch,
      to: wikilink,
    });
  }

  // Track preserved links
  for (const link of links) {
    if (link.type === "external" || link.type === "wikilink") {
      preserved.push(link.fullMatch);
    }
  }

  return {
    original: content,
    normalized,
    conversions,
    preserved,
  };
}

/**
 * Extract frontmatter from markdown content
 * Returns the frontmatter string (including delimiters) and the rest of the content
 */
export function extractFrontmatter(content: string): {
  frontmatter: string | null;
  body: string;
} {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);

  if (frontmatterMatch) {
    return {
      frontmatter: frontmatterMatch[0],
      body: content.slice(frontmatterMatch[0].length),
    };
  }

  return {
    frontmatter: null,
    body: content,
  };
}

/**
 * Normalize a full markdown file, preserving frontmatter
 */
export function normalizeMarkdownFile(content: string): NormalizationResult {
  const { frontmatter, body } = extractFrontmatter(content);
  const bodyResult = normalizeContent(body);

  return {
    original: content,
    normalized: frontmatter ? frontmatter + bodyResult.normalized : bodyResult.normalized,
    conversions: bodyResult.conversions,
    preserved: bodyResult.preserved,
  };
}
