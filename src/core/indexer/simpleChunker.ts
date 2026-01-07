/**
 * Simple Note Chunker
 *
 * Splits markdown notes into chunks for embedding.
 * Prioritizes simplicity and reliability over complex heuristics.
 *
 * Chunking rules:
 * 1. Small notes (<500 chars after frontmatter) → single chunk
 * 2. Each H1/H2 section → separate chunk (if section is reasonable size)
 * 3. Large sections (>1500 chars) → split at paragraph boundaries
 * 4. Frontmatter is stored as metadata, not embedded
 * 5. No overlap - not needed for semantic search on notes
 */

import { createHash } from "node:crypto";
import type { NoteChunk } from "../../types/indexer";

/** Default maximum chunk size */
const MAX_CHUNK_SIZE = 1500;

/** Minimum content to create a chunk */
const MIN_CHUNK_SIZE = 50;

/** Small note threshold - single chunk */
const SMALL_NOTE_THRESHOLD = 500;

/** Deterministic token estimate proxy */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Parsed note structure */
interface ParsedNote {
  title: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  sections: Section[];
}

interface Section {
  heading: string;
  level: number; // 0 = no heading (preamble), 1-6 = h1-h6
  content: string;
}

/**
 * Chunk a markdown note into pieces for embedding
 */
export function chunkNote(filePath: string, content: string, mtimeMs: number): NoteChunk[] {
  const noteId = generateNoteId(filePath);
  const parsed = parseMarkdown(filePath, content);

  // Calculate total content size (excluding frontmatter)
  const totalContent = parsed.sections.map((s) => s.content).join("\n");

  // Small notes → single chunk
  if (totalContent.length < SMALL_NOTE_THRESHOLD) {
    const text = buildChunkText(parsed.title, [], totalContent);
    if (text.length < MIN_CHUNK_SIZE) {
      // Too small, just use title
      return [createChunk(noteId, filePath, parsed, 0, [], "note", "note", parsed.title, mtimeMs)];
    }
    return [createChunk(noteId, filePath, parsed, 0, [], "note", "note", text, mtimeMs)];
  }

  // Process sections
  const chunks: NoteChunk[] = [];
  let chunkIndex = 0;

  for (const section of parsed.sections) {
    const sectionChunks = chunkSection(section, MAX_CHUNK_SIZE);
    const headingPath = section.heading ? [section.heading] : [];

    for (const text of sectionChunks) {
      if (text.length >= MIN_CHUNK_SIZE) {
        chunks.push(
          createChunk(
            noteId,
            filePath,
            parsed,
            chunkIndex++,
            headingPath,
            "section",
            "section",
            text,
            mtimeMs,
          ),
        );
      }
    }
  }

  // Fallback if no chunks created
  if (chunks.length === 0) {
    return [
      createChunk(
        noteId,
        filePath,
        parsed,
        0,
        [],
        "note",
        "note",
        parsed.title || filePath,
        mtimeMs,
      ),
    ];
  }

  return chunks;
}

/**
 * Parse markdown into structured sections
 */
function parseMarkdown(filePath: string, content: string): ParsedNote {
  const lines = content.split("\n");

  // Extract frontmatter
  const { frontmatter, contentStartLine } = extractFrontmatter(lines);

  // Extract title
  const title = extractTitle(filePath, lines, contentStartLine);

  // Extract tags
  const tags = extractTags(frontmatter, lines);

  // Extract sections
  const sections = extractSections(lines, contentStartLine);

  return { title, frontmatter, tags, sections };
}

/**
 * Extract YAML frontmatter
 */
function extractFrontmatter(lines: string[]): {
  frontmatter: Record<string, unknown>;
  contentStartLine: number;
} {
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, contentStartLine: 0 };
  }

  let endLine = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endLine = i;
      break;
    }
  }

  if (endLine === -1) {
    return { frontmatter: {}, contentStartLine: 0 };
  }

  // Simple YAML parsing (key: value)
  const frontmatter: Record<string, unknown> = {};
  for (let i = 1; i < endLine; i++) {
    const line = lines[i];
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let value: unknown = line.slice(colonIdx + 1).trim();

      // Try to parse arrays
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

  return { frontmatter, contentStartLine: endLine + 1 };
}

/**
 * Extract title from H1 or filename
 */
function extractTitle(filePath: string, lines: string[], startLine: number): string {
  // Look for first H1
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("# ")) {
      return line.slice(2).trim();
    }
    // Stop if we hit other heading levels
    if (/^#{2,6}\s/.test(line)) break;
  }

  // Fall back to filename
  const parts = filePath.split("/");
  return parts[parts.length - 1].replace(/\.md$/, "");
}

/**
 * Extract tags from frontmatter and inline #tags
 */
function extractTags(frontmatter: Record<string, unknown>, lines: string[]): string[] {
  const tags = new Set<string>();

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

  // Inline #tags
  const tagRegex = /#([a-zA-Z][a-zA-Z0-9_-]*)/g;
  for (const line of lines) {
    for (const match of line.matchAll(tagRegex)) {
      tags.add(match[1]);
    }
  }

  return Array.from(tags);
}

/**
 * Extract sections from content (split by H1/H2 headings)
 */
function extractSections(lines: string[], startLine: number): Section[] {
  const sections: Section[] = [];
  let currentSection: Section = { heading: "", level: 0, content: "" };
  const buffer: string[] = [];

  const flushSection = () => {
    currentSection.content = buffer.join("\n").trim();
    if (currentSection.content || currentSection.heading) {
      sections.push(currentSection);
    }
    buffer.length = 0;
  };

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];

    // Check for H1 or H2 heading
    const headingMatch = line.match(/^(#{1,2})\s+(.+)$/);
    if (headingMatch) {
      flushSection();
      currentSection = {
        heading: headingMatch[2],
        level: headingMatch[1].length,
        content: "",
      };
    } else {
      buffer.push(line);
    }
  }

  flushSection();
  return sections;
}

/**
 * Split a section into chunks if it's too large
 */
function chunkSection(section: Section, maxSize: number): string[] {
  const content = section.content;

  // Include heading in first chunk
  const prefix = section.heading ? `## ${section.heading}\n\n` : "";

  if (prefix.length + content.length <= maxSize) {
    return [prefix + content];
  }

  // Split at paragraph boundaries
  const paragraphs = content.split(/\n\n+/);
  const chunks: string[] = [];
  let current = prefix;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // Check if adding this paragraph exceeds limit
    if (current.length + trimmed.length + 2 > maxSize && current.length > prefix.length) {
      chunks.push(current.trim());
      current = "";
    }

    current += (current ? "\n\n" : "") + trimmed;
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Build chunk text with context
 */
function buildChunkText(title: string, headingPath: string[], content: string): string {
  const parts: string[] = [];

  if (title) {
    parts.push(`# ${title}`);
  }

  if (headingPath.length > 0) {
    parts.push(`## ${headingPath.join(" > ")}`);
  }

  if (content) {
    parts.push(content);
  }

  return parts.join("\n\n");
}

/**
 * Generate stable note ID from path
 */
export function generateNoteId(filePath: string): string {
  const normalized = filePath.toLowerCase().replace(/\\/g, "/");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Generate content hash for change detection.
 * Uses normalized content (collapsed whitespace, trimmed) for more stable hashing.
 */
export function generateContentHash(content: string): string {
  // Normalize content: collapse multiple whitespace, trim, lowercase for stability
  const normalized = content
    .replace(/\r\n/g, "\n") // Normalize line endings
    .replace(/[\t ]+/g, " ") // Collapse horizontal whitespace
    .replace(/\n{3,}/g, "\n\n") // Collapse excessive blank lines
    .trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Generate chunk ID.
 * Uses full text hash to avoid collisions on short content.
 */
function generateChunkId(noteId: string, chunkIndex: number, text: string): string {
  // Use full text for hashing to avoid collisions on short content
  const hash = createHash("sha256")
    .update(`${noteId}:${chunkIndex}:${text}`)
    .digest("hex")
    .slice(0, 12); // Increased from 8 to 12 for lower collision probability
  return `${noteId}-${chunkIndex}-${hash}`;
}

/**
 * Create a NoteChunk object
 */
function createChunk(
  noteId: string,
  filePath: string,
  parsed: ParsedNote,
  chunkIndex: number,
  headingPath: string[],
  tier: NoteChunk["tier"],
  kind: NoteChunk["kind"],
  text: string,
  mtimeMs: number,
): NoteChunk {
  return {
    chunkId: generateChunkId(noteId, chunkIndex, text),
    noteId,
    path: filePath,
    title: parsed.title,
    headingPath,
    tier,
    kind,
    parentChunkId: null,
    blockRef: null,
    startLine: null,
    endLine: null,
    tokenEstimate: estimateTokens(text),
    chunkIndex,
    text,
    mtimeMs,
    contentHash: generateContentHash(text),
    tags: parsed.tags,
    frontmatter: parsed.frontmatter,
  };
}
