/**
 * Writer Agent for Notient Pipeline
 * Applies selected suggestions to notes.
 * Source of truth: .planning/PHASE-GALAXY.md (Phase G2)
 *
 * Per spec decisions:
 * - Uses processFrontMatter for frontmatter changes
 * - Uses Vault API for content modifications
 * - Records action in SQLite (for undo)
 * - Checks note hash before apply (abort if changed)
 */

import type { EnhancementSuggestion } from "../../types";
import type {
  AgentConfig,
  AgentResult,
  WriteRequest,
  WriteResult,
} from "./types";

// =============================================================================
// Content Modification Helpers
// =============================================================================

/**
 * Extract frontmatter from note content.
 * Returns the frontmatter object and the content without frontmatter.
 */
function extractFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
} {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);

  if (!frontmatterMatch) {
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }

  const frontmatterStr = frontmatterMatch[1];
  const body = content.slice(frontmatterMatch[0].length);
  const frontmatter: Record<string, unknown> = {};

  // Simple YAML parsing (key: value)
  for (const line of frontmatterStr.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      let value: unknown = line.slice(colonIndex + 1).trim();

      // Try to parse arrays [a, b, c]
      if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
        value = value.slice(1, -1).split(",").map((s) => s.trim());
      }
      // Try to parse numbers
      else if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
        value = Number.parseFloat(value);
      }
      // Try to parse booleans
      else if (value === "true") {
        value = true;
      } else if (value === "false") {
        value = false;
      }

      frontmatter[key] = value;
    }
  }

  return { frontmatter, body, hasFrontmatter: true };
}

/**
 * Serialize frontmatter object back to YAML string.
 */
function serializeFrontmatter(frontmatter: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(", ")}]`);
    } else if (typeof value === "object" && value !== null) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }

  return lines.join("\n");
}

/**
 * Rebuild note content with modified frontmatter.
 */
function rebuildContent(
  frontmatter: Record<string, unknown>,
  body: string,
  hadFrontmatter: boolean,
): string {
  if (Object.keys(frontmatter).length === 0) {
    return body;
  }

  const frontmatterStr = serializeFrontmatter(frontmatter);
  return `---\n${frontmatterStr}\n---\n${hadFrontmatter ? "" : "\n"}${body}`;
}

/**
 * Calculate a simple hash of content (for change detection).
 */
function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

// =============================================================================
// Suggestion Application
// =============================================================================

/**
 * Apply a single suggestion to note content.
 * Returns modified content or null if suggestion type not supported.
 */
function applySuggestion(
  content: string,
  suggestion: EnhancementSuggestion,
): string | null {
  const { frontmatter, body, hasFrontmatter } = extractFrontmatter(content);

  switch (suggestion.type) {
    case "tag": {
      const newTags = suggestion.metadata.tags || [];
      const existingTags = (frontmatter.tags as string[]) || [];
      const mergedTags = [...new Set([...existingTags, ...newTags])];
      frontmatter.tags = mergedTags;
      return rebuildContent(frontmatter, body, hasFrontmatter);
    }

    case "frontmatter": {
      const key = suggestion.metadata.frontmatterKey;
      const value = suggestion.metadata.frontmatterValue;
      if (key) {
        frontmatter[key] = value;
      }
      return rebuildContent(frontmatter, body, hasFrontmatter);
    }

    case "link": {
      // Add link at the end of the note
      const linkTarget = suggestion.metadata.linkTarget;
      if (!linkTarget) return null;
      const newContent = body.trimEnd() + `\n\n[[${linkTarget}]]`;
      return rebuildContent(frontmatter, newContent, hasFrontmatter);
    }

    case "section": {
      // Add section at the end of the note
      const sectionTitle = suggestion.metadata.sectionTitle;
      if (!sectionTitle) return null;
      const newContent = body.trimEnd() + `\n\n## ${sectionTitle}\n\n`;
      return rebuildContent(frontmatter, newContent, hasFrontmatter);
    }

    default:
      return null;
  }
}

// =============================================================================
// Functional Core
// =============================================================================

/**
 * Apply selected suggestions to note content.
 * Validates hash before applying to detect concurrent edits.
 *
 * @param request - Write request with note path, content, and suggestions
 * @param config - Optional abort signal
 * @returns Modified content and application results
 */
export async function write(
  request: WriteRequest,
  config?: AgentConfig,
): Promise<AgentResult<WriteResult>> {
  // Check for abort
  if (config?.abortSignal?.aborted) {
    return { success: false, error: "Aborted" };
  }

  // Verify hash (abort if note changed during enhance)
  const currentHash = hashContent(request.currentContent);
  if (currentHash !== request.expectedHash) {
    return {
      success: false,
      error: "Note changed during enhancement. Aborting to prevent data loss.",
    };
  }

  // Apply suggestions one by one
  let content = request.currentContent;
  const appliedSuggestionIds: string[] = [];
  const failedSuggestionIds: string[] = [];

  for (const suggestion of request.suggestions) {
    if (config?.abortSignal?.aborted) {
      return { success: false, error: "Aborted" };
    }

    const modified = applySuggestion(content, suggestion);
    if (modified !== null) {
      content = modified;
      appliedSuggestionIds.push(suggestion.id);
    } else {
      failedSuggestionIds.push(suggestion.id);
    }
  }

  return {
    success: true,
    data: {
      newContent: content,
      newHash: hashContent(content),
      appliedSuggestionIds,
      failedSuggestionIds,
    },
  };
}

/**
 * Process frontmatter changes on note content.
 * Exported for use by ObsidianFacade with Obsidian's processFrontMatter.
 */
export function processFrontMatter(
  content: string,
  processor: (frontmatter: Record<string, unknown>) => void,
): string {
  const { frontmatter, body, hasFrontmatter } = extractFrontmatter(content);
  processor(frontmatter);
  return rebuildContent(frontmatter, body, hasFrontmatter);
}

/**
 * Calculate content hash.
 * Exported for use by pipeline to capture initial hash.
 */
export function calculateHash(content: string): string {
  return hashContent(content);
}

// =============================================================================
// Class Wrapper (for lifecycle management)
// =============================================================================

/**
 * WriterAgent class wrapper.
 * Provides lifecycle management around the functional core.
 */
export class WriterAgent {
  /**
   * Apply selected suggestions to note content.
   *
   * @param request - Write request with note path, content, and suggestions
   * @param config - Optional abort signal
   * @returns Modified content and application results
   */
  async run(
    request: WriteRequest,
    config?: AgentConfig,
  ): Promise<AgentResult<WriteResult>> {
    return write(request, config);
  }

  /**
   * Process frontmatter with a custom processor function.
   */
  processFrontMatter(
    content: string,
    processor: (frontmatter: Record<string, unknown>) => void,
  ): string {
    return processFrontMatter(content, processor);
  }

  /**
   * Calculate content hash for change detection.
   */
  calculateHash(content: string): string {
    return calculateHash(content);
  }
}
