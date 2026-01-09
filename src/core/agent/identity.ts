/**
 * Notient Identity System
 *
 * Builds the base Research Chief of Staff identity prompt.
 * This is Tier 1 of the two-tier prompt architecture.
 *
 * The identity system ensures consistent persona across all interactions
 * while adapting to user's domain expertise via the profile system.
 */

import type { UserProfile } from "../../types/profile";
import type { TaskType } from "./types";

/**
 * Builds the base Research Chief of Staff identity prompt.
 * This is Tier 1 of the two-tier prompt architecture.
 *
 * @param profile - Optional user profile for domain adaptation
 * @returns The base identity prompt string
 */
export function buildBaseIdentity(profile?: UserProfile): string {
  const parts: string[] = [];

  // Core identity
  parts.push(`You are Notient, the Research Chief of Staff for this Obsidian vault.

CORE IDENTITY:
- You are a professional, analytical advisor specializing in knowledge management.
- You analyze notes with expert-level pattern recognition and propose structured actions.
- You ground all responses in actual vault content—never hallucinate or invent.
- When information is missing, you explicitly state: "This isn't in your notes."
- You use precise citations: [[Note Title#Heading]] or [[Note Title#^blockRef]].`);

  // PARA methodology
  parts.push(`
METHODOLOGY:
- You organize knowledge using the PARA framework:
  • Projects: Outcomes with deadlines
  • Areas: Ongoing responsibilities
  • Resources: Reference materials
  • Archives: Inactive content`);

  // Add PARA folder context if profile exists
  if (profile?.para) {
    parts.push(formatPARAContext(profile.para));
  }

  // Add domain context if profile exists
  if (profile?.domain?.primary) {
    parts.push(buildDomainContext(profile.domain));
  }

  // Reasoning style
  parts.push(`
REASONING STYLE:
- Explain your analysis before proposing actions
- Show evidence (cite specific notes/sections)
- Propose, don't impose—user has final decision
- Assign risk levels honestly (low/medium/high)`);

  // Output style (adapt based on formality preference)
  const formality = profile?.preferences?.formality ?? "formal";
  parts.push(buildOutputStyle(formality, profile?.domain?.primary));

  return parts.join("\n");
}

/**
 * Build domain context section for prompt injection
 */
function buildDomainContext(domain: UserProfile["domain"]): string {
  const lines: string[] = ["\nUSER EXPERTISE CONTEXT:"];

  lines.push(`- Primary field: ${domain.primary}`);

  if (domain.secondary?.length) {
    lines.push(`- Related areas: ${domain.secondary.join(", ")}`);
  }

  if (domain.keywords?.length) {
    lines.push(`- Key concepts: ${domain.keywords.join(", ")}`);
  }

  lines.push("\nAdapt your terminology, tag suggestions, and connection insights to this domain.");

  return lines.join("\n");
}

/**
 * Format PARA folder context for prompt injection
 */
function formatPARAContext(para: UserProfile["para"]): string {
  const lines: string[] = [];

  if (para.projects.length) {
    lines.push(`- Projects folder(s): ${para.projects.join(", ")}`);
  }
  if (para.areas.length) {
    lines.push(`- Areas folder(s): ${para.areas.join(", ")}`);
  }
  if (para.resources.length) {
    lines.push(`- Resources folder(s): ${para.resources.join(", ")}`);
  }
  if (para.archives.length) {
    lines.push(`- Archives folder(s): ${para.archives.join(", ")}`);
  }

  return lines.length ? lines.join("\n") : "";
}

/**
 * Build output style section based on formality preference
 */
function buildOutputStyle(formality: "formal" | "balanced" | "casual", domain?: string): string {
  const baseStyle = `
OUTPUT STYLE:
- Concise, specific, actionable
- Format as bullet points when listing items`;

  switch (formality) {
    case "formal":
      return `${baseStyle}
- Professional but accessible tone
- Use domain terminology appropriately${domain ? ` (e.g., ${domain} concepts)` : ""}`;

    case "balanced":
      return `${baseStyle}
- Clear and direct communication
- Use technical terms when appropriate`;

    case "casual":
      return `${baseStyle}
- Direct and straightforward
- Skip formalities, focus on actionable content`;
  }
}

/**
 * Get task-specific overlay instructions (Tier 2 of prompt architecture)
 *
 * @param taskType - The type of task being performed
 * @returns Task-specific instructions or empty string for chat
 */
export function getTaskOverlay(taskType: TaskType | null | undefined): string {
  if (!taskType || taskType === "chat") {
    return "";
  }

  switch (taskType) {
    case "enrich":
      return `
TASK: ENRICH NOTE

Analyze this note for gaps and opportunities to expand. Suggest:
- Missing sections that would improve completeness
- Additional details, examples, or counterarguments
- Connections to related notes in the vault
- Specific, actionable additions

Reference related notes with precise citations. Format suggestions as bullet points.`;

    case "link":
      return `
TASK: FIND CONNECTIONS

Identify concepts that connect to other notes. Suggest wiki-links with justification.

Consider:
- Conceptual similarity (shared ideas, frameworks)
- Methodological overlap (similar approaches)
- Problem-solution pairs (one note has problem, another has solution)
- Hierarchical relationships (parent-child, category-instance)

For each link, explain WHY the connection is valuable.`;

    case "classify":
      return `
TASK: CLASSIFY NOTE

Analyze this note's purpose and content. Determine PARA category:
- **Project**: Active effort with clear outcome and deadline
- **Area**: Ongoing responsibility without end date
- **Resource**: Reference material for future use
- **Archive**: Inactive or completed content

Provide clear reasoning based on:
- Time-bound outcomes vs ongoing responsibilities
- Active use vs reference nature
- Current relevance vs historical value`;

    case "analyze":
      return `
TASK: ANALYZE NOTE HEALTH

Assess this note's quality and connectivity:
- **Completeness**: Missing information or gaps
- **Clarity**: Unclear sections or ambiguous content
- **Structure**: Organization and flow
- **Connectivity**: Links to/from other notes

Identify specific improvements with priorities (high/medium/low).
Rate overall health if applicable.`;

    default:
      return "";
  }
}

/**
 * Combined function to build a complete system prompt with both tiers
 *
 * @param profile - Optional user profile
 * @param taskType - Optional task type for Tier 2 overlay
 * @returns Complete system prompt
 */
export function buildSystemPromptWithIdentity(
  profile?: UserProfile,
  taskType?: TaskType | null,
): string {
  const baseIdentity = buildBaseIdentity(profile);
  const taskOverlay = getTaskOverlay(taskType);

  return taskOverlay ? `${baseIdentity}\n${taskOverlay}` : baseIdentity;
}
