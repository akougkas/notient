/**
 * Notient Prompt Builder
 *
 * Builds Notient-specific prompts with vault context.
 * THIS is where the Notient personality and RAG formatting lives.
 *
 * Moved from lmstudio.ts to centralize agent logic.
 */

import type { NoteContext, PromptParams, TaskType } from "./types";
import { getTaskInstructions } from "./taskInference";

const BASE_SYSTEM_PROMPT = `You are Notient, an AI assistant for an Obsidian vault. You help users understand, navigate, and improve their notes.

CRITICAL RULES:
- Always ground your responses in the actual note content provided
- Cite specific notes using [[Note Title]] format (wiki-links)
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
      (n) => !params.currentNote || n.path !== params.currentNote.path
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
        ? note.content.slice(0, 3000) + "\n\n[... content truncated ...]"
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
  private formatRelatedNotes(
    notes: Array<{ title: string; path: string; text: string }>
  ): string {
    const noteSummaries = notes
      .slice(0, 5)
      .map((n) => {
        const preview = n.text.length > 400 ? n.text.slice(0, 400) + "..." : n.text;
        return `### [[${n.title}]] (${n.path})
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
${note.content.length > 400 ? note.content.slice(0, 400) + "..." : note.content}`;
  }
}
