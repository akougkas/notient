/**
 * Text Chunker
 * 
 * Splits markdown content into chunks for embedding.
 * Preserves markdown structure and heading hierarchy.
 */

import { createHash } from "crypto";
import type { NoteChunk, ChunkingOptions } from "../../types/indexer";

const DEFAULT_OPTIONS: ChunkingOptions = {
  chunkSize: 1000,
  chunkOverlap: 200,
  preserveStructure: true,
};

/**
 * Result of parsing a markdown file
 */
interface ParsedNote {
  title: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  sections: Section[];
}

interface Section {
  level: number;
  heading: string;
  content: string;
  startLine: number;
}

/**
 * Split markdown content into chunks
 */
export function chunkNote(
  path: string,
  content: string,
  mtimeMs: number,
  options: Partial<ChunkingOptions> = {}
): NoteChunk[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const noteId = generateNoteId(path);
  
  // Parse the markdown
  const parsed = parseMarkdown(path, content);
  
  // Create chunks from sections
  const chunks: NoteChunk[] = [];
  let chunkIndex = 0;

  if (opts.preserveStructure) {
    // Chunk by sections, respecting structure
    for (const section of parsed.sections) {
      const sectionChunks = chunkText(section.content, opts);
      const headingPath = buildHeadingPath(parsed.sections, section);
      
      for (const text of sectionChunks) {
        const chunk = createChunk({
          noteId,
          path,
          title: parsed.title,
          headingPath,
          chunkIndex: chunkIndex++,
          text,
          mtimeMs,
          tags: parsed.tags,
          frontmatter: parsed.frontmatter,
        });
        chunks.push(chunk);
      }
    }
  } else {
    // Simple chunking without structure preservation
    const textChunks = chunkText(content, opts);
    for (const text of textChunks) {
      const chunk = createChunk({
        noteId,
        path,
        title: parsed.title,
        headingPath: [],
        chunkIndex: chunkIndex++,
        text,
        mtimeMs,
        tags: parsed.tags,
        frontmatter: parsed.frontmatter,
      });
      chunks.push(chunk);
    }
  }

  // If no chunks created (empty file), create one with title only
  if (chunks.length === 0) {
    chunks.push(
      createChunk({
        noteId,
        path,
        title: parsed.title,
        headingPath: [],
        chunkIndex: 0,
        text: parsed.title,
        mtimeMs,
        tags: parsed.tags,
        frontmatter: parsed.frontmatter,
      })
    );
  }

  return chunks;
}

/**
 * Parse markdown into structured sections
 */
function parseMarkdown(path: string, content: string): ParsedNote {
  const lines = content.split("\n");
  
  // Extract title from first heading or filename
  let title = extractTitle(path, lines);
  
  // Extract frontmatter
  const { frontmatter, contentStart } = extractFrontmatter(lines);
  
  // Extract tags
  const tags = extractTags(frontmatter, lines);
  
  // Extract sections
  const sections = extractSections(lines, contentStart);

  return { title, frontmatter, tags, sections };
}

/**
 * Extract title from content or filename
 */
function extractTitle(path: string, lines: string[]): string {
  // Try to find first h1
  for (const line of lines) {
    if (line.startsWith("# ")) {
      return line.slice(2).trim();
    }
  }
  
  // Fall back to filename
  const parts = path.split("/");
  const filename = parts[parts.length - 1];
  return filename.replace(/\.md$/, "");
}

/**
 * Extract frontmatter from lines
 */
function extractFrontmatter(
  lines: string[]
): { frontmatter: Record<string, unknown>; contentStart: number } {
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, contentStart: 0 };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { frontmatter: {}, contentStart: 0 };
  }

  const frontmatterLines = lines.slice(1, endIndex);
  const frontmatter: Record<string, unknown> = {};

  for (const line of frontmatterLines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      let value: unknown = line.slice(colonIndex + 1).trim();
      
      // Try to parse as JSON array
      if (typeof value === "string" && value.startsWith("[")) {
        try {
          value = JSON.parse(value);
        } catch {
          // Keep as string
        }
      }
      
      frontmatter[key] = value;
    }
  }

  return { frontmatter, contentStart: endIndex + 1 };
}

/**
 * Extract tags from frontmatter and inline
 */
function extractTags(
  frontmatter: Record<string, unknown>,
  lines: string[]
): string[] {
  const tags: Set<string> = new Set();
  
  // From frontmatter
  if (Array.isArray(frontmatter.tags)) {
    for (const tag of frontmatter.tags) {
      if (typeof tag === "string") {
        tags.add(tag.replace(/^#/, ""));
      }
    }
  } else if (typeof frontmatter.tags === "string") {
    tags.add(frontmatter.tags.replace(/^#/, ""));
  }
  
  // Inline tags (#tag)
  const tagRegex = /#([a-zA-Z][a-zA-Z0-9_-]*)/g;
  for (const line of lines) {
    let match;
    while ((match = tagRegex.exec(line)) !== null) {
      tags.add(match[1]);
    }
  }

  return Array.from(tags);
}

/**
 * Extract sections from content
 */
function extractSections(lines: string[], startLine: number): Section[] {
  const sections: Section[] = [];
  let currentSection: Section | null = null;
  let contentBuffer: string[] = [];

  const flushContent = () => {
    if (currentSection) {
      currentSection.content = contentBuffer.join("\n").trim();
      if (currentSection.content || currentSection.heading) {
        sections.push(currentSection);
      }
    }
    contentBuffer = [];
  };

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    
    if (headingMatch) {
      flushContent();
      currentSection = {
        level: headingMatch[1].length,
        heading: headingMatch[2],
        content: "",
        startLine: i,
      };
    } else {
      contentBuffer.push(line);
    }
  }

  // Flush remaining content
  if (!currentSection && contentBuffer.length > 0) {
    // Content before any heading
    sections.push({
      level: 0,
      heading: "",
      content: contentBuffer.join("\n").trim(),
      startLine,
    });
  } else {
    flushContent();
  }

  return sections;
}

/**
 * Build heading path for a section
 */
function buildHeadingPath(sections: Section[], current: Section): string[] {
  const path: string[] = [];
  const currentIndex = sections.indexOf(current);
  
  // Walk backwards to find parent headings
  for (let i = currentIndex - 1; i >= 0; i--) {
    const section = sections[i];
    if (section.level < current.level && section.heading) {
      path.unshift(section.heading);
    }
  }
  
  if (current.heading) {
    path.push(current.heading);
  }

  return path;
}

/**
 * Split text into chunks with overlap
 */
function chunkText(text: string, options: ChunkingOptions): string[] {
  if (text.length <= options.chunkSize) {
    return text.trim() ? [text.trim()] : [];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + options.chunkSize;
    
    if (end < text.length) {
      // Try to break at sentence or paragraph boundary
      const breakPoint = findBreakPoint(text, start, end);
      if (breakPoint > start) {
        end = breakPoint;
      }
    }

    const chunk = text.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    start = end - options.chunkOverlap;
    if (start <= 0 || start >= text.length - options.chunkOverlap) {
      start = end;
    }
  }

  return chunks;
}

/**
 * Find a good break point (sentence/paragraph end)
 */
function findBreakPoint(text: string, start: number, end: number): number {
  // Look for paragraph break
  const paragraphBreak = text.lastIndexOf("\n\n", end);
  if (paragraphBreak > start + 100) {
    return paragraphBreak + 2;
  }
  
  // Look for sentence break
  const sentenceBreaks = [". ", "! ", "? "];
  for (const brk of sentenceBreaks) {
    const idx = text.lastIndexOf(brk, end);
    if (idx > start + 100) {
      return idx + brk.length;
    }
  }
  
  // Look for newline
  const newlineBreak = text.lastIndexOf("\n", end);
  if (newlineBreak > start + 50) {
    return newlineBreak + 1;
  }
  
  // Fall back to word boundary
  const spaceBreak = text.lastIndexOf(" ", end);
  if (spaceBreak > start) {
    return spaceBreak + 1;
  }

  return end;
}

/**
 * Generate stable note ID from path
 */
export function generateNoteId(path: string): string {
  const normalized = path.toLowerCase().replace(/\\/g, "/");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Generate stable chunk ID
 */
function generateChunkId(noteId: string, chunkIndex: number, text: string): string {
  const hash = createHash("sha256")
    .update(`${noteId}:${chunkIndex}:${text}`)
    .digest("hex")
    .slice(0, 12);
  return `${noteId}-${chunkIndex}-${hash}`;
}

/**
 * Generate content hash for change detection
 */
export function generateContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Create a chunk object
 */
function createChunk(params: {
  noteId: string;
  path: string;
  title: string;
  headingPath: string[];
  chunkIndex: number;
  text: string;
  mtimeMs: number;
  tags: string[];
  frontmatter: Record<string, unknown>;
}): NoteChunk {
  return {
    chunkId: generateChunkId(params.noteId, params.chunkIndex, params.text),
    noteId: params.noteId,
    path: params.path,
    title: params.title,
    headingPath: params.headingPath,
    chunkIndex: params.chunkIndex,
    text: params.text,
    mtimeMs: params.mtimeMs,
    contentHash: generateContentHash(params.text),
    tags: params.tags,
    frontmatter: params.frontmatter,
  };
}
