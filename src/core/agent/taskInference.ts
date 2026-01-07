/**
 * Task Inference
 *
 * Infer the type of task from a user query.
 * This is moved from lmstudio.ts to centralize agent logic.
 */

import type { TaskType } from "./types";

/**
 * Infer the task type from a query string
 * @param query - The user's query
 * @returns The inferred task type
 */
export function inferTaskType(query: string): TaskType {
  const q = query.toLowerCase();

  // Enrich/Expand action
  if (
    q.includes("enrich") ||
    q.includes("expand") ||
    q.includes("additional context") ||
    q.includes("more details") ||
    q.includes("elaborate")
  ) {
    return "enrich";
  }

  // Link action
  if (
    q.includes("link") ||
    q.includes("linked") ||
    q.includes("connections") ||
    q.includes("connect") ||
    q.includes("related notes")
  ) {
    return "link";
  }

  // Move/Classify action
  if (
    q.includes("move") ||
    q.includes("folder") ||
    q.includes("category") ||
    q.includes("para") ||
    q.includes("classify") ||
    q.includes("organize")
  ) {
    return "classify";
  }

  // Analyze/Health action
  if (
    q.includes("analyze") ||
    q.includes("health") ||
    q.includes("improve") ||
    q.includes("review") ||
    q.includes("assess")
  ) {
    return "analyze";
  }

  // Default to general chat
  return "chat";
}

/**
 * Get task-specific instructions for the LLM based on task type
 * @param taskType - The type of task
 * @returns Task instructions or null for general chat
 */
export function getTaskInstructions(taskType: TaskType): string | null {
  switch (taskType) {
    case "enrich":
      return `The user wants to ENRICH/EXPAND the current note.
- Analyze the note's content thoroughly
- Suggest additional sections, details, or context that would improve it
- Reference related notes from the vault that could provide insights
- Be specific and provide actionable additions
- Format suggestions as clear bullet points or sections`;

    case "link":
      return `The user wants to find LINKING opportunities for this note.
- Identify concepts, topics, or entities that could connect to other notes
- Look at the related notes and suggest specific wiki-links to add
- Explain WHY each link would be valuable (shared concepts, related projects, etc.)
- Suggest both outgoing links (from this note) and potential backlinks`;

    case "classify":
      return `The user wants to CLASSIFY/ORGANIZE this note.
- Analyze the note's content to understand its purpose
- Suggest the best folder/category based on PARA methodology:
  * Projects: Active efforts with clear outcomes
  * Areas: Ongoing responsibilities  
  * Resources: Reference material
  * Archives: Inactive/completed items
- Provide clear reasoning for your recommendation
- Consider the note's relationships to other vault content`;

    case "analyze":
      return `The user wants to ANALYZE and improve this note.
- Assess the note's completeness, clarity, and structure
- Identify gaps, unclear sections, or areas needing expansion
- Check for broken links or missing connections
- Suggest specific improvements with priorities
- Rate the note's overall "health" if applicable`;

    case "chat":
      // No specific instructions for general chat
      return null;
  }
}
