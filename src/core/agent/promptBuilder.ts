/**
 * Notient Prompt Builder
 *
 * Builds Notient-specific prompts with vault context.
 * THIS is where the Notient personality and RAG formatting lives.
 *
 * Moved from lmstudio.ts to centralize agent logic.
 */

import { getTaskInstructions } from "./taskInference";
import type { NoteContext, PromptParams, TaskType } from "./types";

/**
 * Action plan prompt template (JSON-only mode)
 * Used after streaming explanation to get structured proposed actions
 */
const ACTION_PLAN_PROMPT = `You are an AI assistant analyzing an Obsidian note. Based on the user's request and note content, output ONLY a valid JSON object with proposed actions.

Output format:
{
  "actions": [
    {
      "type": "frontmatter_set" | "frontmatter_add_tags" | "append_section" | "append_related_links" | "move_note",
      "risk": "low" | "medium" | "high",
      "title": "Short description (max 50 chars)",
      "reason": "Why this action helps the user",
      "target": "path/to/note.md",
      "payload": { /* type-specific, see below */ }
    }
  ]
}

Payload formats by type:
- frontmatter_set: { "key": "string", "value": "any" }
- frontmatter_add_tags: { "tags": ["tag1", "tag2"] }
- append_section: { "heading": "Optional Heading", "content": "markdown content" }
- append_related_links: { "links": ["Note Name", "Other Note"] }
- move_note: { "from": "current/path.md", "to": "new/folder/path.md" }

Risk levels (enforced):
- low: frontmatter changes, appending content
- medium: moving notes, appending links
- high: reserved for future (merge, trash)

Rules:
- Output ONLY valid JSON, no explanation or markdown code fences
- Maximum 10 actions per response
- Use note names (not paths) in append_related_links payload
- Paths must be relative to vault root
- If no actions are appropriate, return { "actions": [] }`;

const BASE_SYSTEM_PROMPT = `You are Notient, an AI assistant for an Obsidian vault. You help users understand, navigate, and improve their notes.

CRITICAL RULES:
- Always ground your responses in the actual note content provided
- Cite notes using Obsidian wiki-links. Prefer precise citations when available: [[Note Title#Heading]] and [[Note Title#^blockRef]].
- Be concise, specific, and actionable
- If information isn't in the notes, explicitly say so
- Never invent or hallucinate content that isn't in the provided context`;

/**
 * Builds Notient-specific prompts with vault context
 */
export class NotientPromptBuilder {
  /**
   * Build a complete system prompt for the LLM
   * @param params - Parameters for building the prompt
   * @returns The complete system prompt
   */
  buildSystemPrompt(params: PromptParams): string {
    const parts: string[] = [BASE_SYSTEM_PROMPT];

    // Add the CURRENT NOTE prominently if this is a note-specific task
    if (params.currentNote?.content) {
      parts.push(this.formatCurrentNote(params.currentNote));
    }

    // Add task-specific instructions based on task type
    const taskType = params.taskType ?? this.inferTaskTypeFromQuery(params.query);
    if (taskType) {
      const instructions = getTaskInstructions(taskType);
      if (instructions) {
        parts.push(`
TASK INSTRUCTIONS:
${instructions}`);
      }
    }

    // Add vault context summary
    if (params.contextSummary && params.contextSummary !== "No vault context available.") {
      parts.push(`
VAULT CONTEXT:
${params.contextSummary}`);
    }

    // Add related notes from RAG (exclude current note to avoid duplication)
    const filteredNotes = params.relatedNotes.filter(
      (n) => !params.currentNote || n.path !== params.currentNote.path,
    );

    if (filteredNotes.length > 0) {
      parts.push(this.formatRelatedNotes(filteredNotes));
    }

    return parts.join("\n");
  }

  /**
   * Format the current note for the prompt
   */
  private formatCurrentNote(note: NoteContext): string {
    const truncatedContent =
      note.content.length > 3000
        ? `${note.content.slice(0, 3000)}\n\n[... content truncated ...]`
        : note.content;

    return `
=== CURRENT NOTE (FOCUS) ===
Title: ${note.title}
Path: ${note.path}

${truncatedContent}
=== END CURRENT NOTE ===`;
  }

  /**
   * Format related notes for the prompt
   */
  private formatRelatedNotes(notes: Array<{ title: string; path: string; text: string }>): string {
    const noteSummaries = notes
      .slice(0, 5)
      .map((n) => {
        const extracted = this.extractCitationFromText(n.title, n.text);
        const preview =
          extracted.body.length > 400 ? `${extracted.body.slice(0, 400)}...` : extracted.body;
        return `### ${extracted.citation} (${n.path})
${preview}`;
      })
      .join("\n\n");

    return `
RELATED NOTES FROM VAULT:
${noteSummaries}`;
  }

  /**
   * Simple task type inference from query (fallback)
   */
  private inferTaskTypeFromQuery(query?: string): TaskType | null {
    if (!query) return null;

    const q = query.toLowerCase();

    if (q.includes("enrich") || q.includes("expand")) return "enrich";
    if (q.includes("link") || q.includes("connections")) return "link";
    if (q.includes("move") || q.includes("classify") || q.includes("organize")) return "classify";
    if (q.includes("analyze") || q.includes("health") || q.includes("improve")) return "analyze";

    return null;
  }

  /**
   * Format a single note for the prompt (utility method)
   */
  formatNoteForPrompt(note: NoteContext): string {
    return `### [[${note.title}]] (${note.path})
${note.content.length > 400 ? `${note.content.slice(0, 400)}...` : note.content}`;
  }

  /**
   * Build a JSON-only prompt for generating action plans
   * Called after streaming explanation to get structured proposed actions
   *
   * @param params - Parameters including current note and context
   * @returns The action plan system prompt
   */
  buildActionPlanPrompt(params: PromptParams): string {
    const parts: string[] = [ACTION_PLAN_PROMPT];

    // Add current note context for accurate targeting
    if (params.currentNote?.content) {
      const truncatedContent =
        params.currentNote.content.length > 2000
          ? `${params.currentNote.content.slice(0, 2000)}\n[... truncated ...]`
          : params.currentNote.content;

      parts.push(`
=== CURRENT NOTE ===
Title: ${params.currentNote.title}
Path: ${params.currentNote.path}

${truncatedContent}
=== END CURRENT NOTE ===`);
    }

    // Add task type hint for action selection
    if (params.taskType) {
      parts.push(`
Task context: User requested "${params.taskType}" operation.`);
    }

    // Add related notes for link suggestions
    if (params.relatedNotes.length > 0) {
      const noteList = params.relatedNotes
        .slice(0, 5)
        .map((n) => {
          const extracted = this.extractCitationFromText(n.title, n.text);
          return `- ${extracted.citation} (${n.path})`;
        })
        .join("\n");

      parts.push(`
Related notes that could be linked:
${noteList}`);
    }

    return parts.join("\n");
  }

  private extractCitationFromText(
    title: string,
    text: string,
  ): { citation: string; body: string } {
    const fallback = `[[${title}]]`;
    const trimmed = (text ?? "").trim();
    if (!trimmed) return { citation: fallback, body: "" };

    const lines = trimmed.split("\n");
    const first = (lines[0] ?? "").trim();

    // If the first line is a wiki-link (possibly with #heading or #^blockRef), treat it as citation.
    if (/^\[\[[^\]]+\]\]$/.test(first)) {
      return {
        citation: first,
        body: lines.slice(1).join("\n").trim(),
      };
    }

    return { citation: fallback, body: trimmed };
  }
}
