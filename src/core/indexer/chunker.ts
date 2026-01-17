/**
 * Hierarchical Semantic Chunker for Notient
 * Splits notes into semantic chunks: full → sections → paragraphs
 * Source of truth: .planning/PHASE-GALAXY.md
 */

import type { ChunkType } from "../../types";
import type { Chunk } from "./types";

/**
 * Generate a simple hash for content change detection.
 * Uses string hashing algorithm (djb2).
 */
function hashContent(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = (hash * 33) ^ content.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Generate a unique chunk ID.
 */
function generateChunkId(notePath: string, type: ChunkType, index: number): string {
  const pathHash = hashContent(notePath).slice(0, 6);
  return `${pathHash}-${type[0]}-${index}`;
}

/**
 * Parse heading level from a markdown line.
 * Returns 0 if not a heading.
 */
function getHeadingLevel(line: string): number {
  const match = line.match(/^(#{1,6})\s/);
  return match ? match[1].length : 0;
}

/**
 * Check if a line is a paragraph separator (blank or only whitespace).
 */
function isBlankLine(line: string): boolean {
  return line.trim() === "";
}

/**
 * Check if content contains only frontmatter.
 */
function isFrontmatterOnly(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) return false;
  const endMatch = trimmed.slice(3).indexOf("---");
  if (endMatch === -1) return false;
  const afterFrontmatter = trimmed.slice(3 + endMatch + 3).trim();
  return afterFrontmatter === "";
}

interface Section {
  startLine: number;
  endLine: number;
  content: string;
}

/**
 * Find the line index where content starts (after frontmatter if present).
 */
function findContentStart(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return i + 1;
  }
  return 0;
}

/**
 * Extract sections from content based on headings.
 */
function extractSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let currentStart = findContentStart(lines);

  for (let i = currentStart; i < lines.length; i++) {
    const level = getHeadingLevel(lines[i]);
    if (level > 0 && i > currentStart) {
      const content = lines.slice(currentStart, i).join("\n").trim();
      if (content) {
        sections.push({
          startLine: currentStart + 1,
          endLine: i,
          content,
        });
      }
      currentStart = i;
    }
  }

  const content = lines.slice(currentStart).join("\n").trim();
  if (content) {
    sections.push({
      startLine: currentStart + 1,
      endLine: lines.length,
      content,
    });
  }

  return sections;
}

/**
 * Extract paragraphs from a section.
 */
function extractParagraphs(
  sectionContent: string,
  sectionStartLine: number,
): { startLine: number; endLine: number; content: string }[] {
  const lines = sectionContent.split("\n");
  const paragraphs: { startLine: number; endLine: number; content: string }[] = [];

  let paragraphStart = 0;
  let paragraphLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (isBlankLine(lines[i])) {
      if (paragraphLines.length > 0) {
        const content = paragraphLines.join("\n").trim();
        if (content) {
          paragraphs.push({
            startLine: sectionStartLine + paragraphStart,
            endLine: sectionStartLine + i - 1,
            content,
          });
        }
        paragraphLines = [];
      }
      paragraphStart = i + 1;
    } else {
      paragraphLines.push(lines[i]);
    }
  }

  // Add final paragraph
  if (paragraphLines.length > 0) {
    const content = paragraphLines.join("\n").trim();
    if (content) {
      paragraphs.push({
        startLine: sectionStartLine + paragraphStart,
        endLine: sectionStartLine + lines.length - 1,
        content,
      });
    }
  }

  return paragraphs;
}

/**
 * Chunk a note into hierarchical semantic chunks.
 *
 * Creates three levels:
 * 1. Full note content (single chunk)
 * 2. Sections (by heading)
 * 3. Paragraphs (within sections)
 *
 * @param notePath - Path to the note
 * @param content - Note content (markdown)
 * @returns Array of chunks
 */
export function chunkNote(notePath: string, content: string): Chunk[] {
  const chunks: Chunk[] = [];
  const lines = content.split("\n");

  // Skip frontmatter-only notes
  if (isFrontmatterOnly(content)) {
    return [];
  }

  // Strip frontmatter for full content
  let contentStart = 0;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        contentStart = i + 1;
        break;
      }
    }
  }

  const bodyContent = lines.slice(contentStart).join("\n").trim();
  if (!bodyContent) {
    return [];
  }

  // Level 1: Full note
  chunks.push({
    id: generateChunkId(notePath, "full", 0),
    notePath,
    content: bodyContent,
    type: "full",
    startLine: contentStart + 1,
    endLine: lines.length,
    hash: hashContent(bodyContent),
  });

  // Level 2: Sections
  const sections = extractSections(lines);
  sections.forEach((section, index) => {
    chunks.push({
      id: generateChunkId(notePath, "section", index),
      notePath,
      content: section.content,
      type: "section",
      startLine: section.startLine,
      endLine: section.endLine,
      hash: hashContent(section.content),
    });

    // Level 3: Paragraphs within sections
    const paragraphs = extractParagraphs(section.content, section.startLine);
    paragraphs.forEach((para, paraIndex) => {
      // Only create paragraph chunks for substantial content
      if (para.content.length > 50) {
        chunks.push({
          id: generateChunkId(notePath, "paragraph", index * 100 + paraIndex),
          notePath,
          content: para.content,
          type: "paragraph",
          startLine: para.startLine,
          endLine: para.endLine,
          hash: hashContent(para.content),
        });
      }
    });
  });

  return chunks;
}

/**
 * Compute hash for an entire note (for change detection).
 */
export function computeNoteHash(content: string): string {
  return hashContent(content);
}
