import type { MethodologySettings } from "../../api/background";

export type NoteRole =
  | "project"
  | "area"
  | "reference"
  | "capture"
  | "synthesis"
  | "decision"
  | "question"
  | "archive";

export interface MethodologyTemplate {
  id: "ai-managed" | "para" | "flap" | "custom";
  name: string;
  purpose: string;
  roles: Partial<Record<NoteRole, string>>;
  stages: {
    capture: string;
    process: string;
    review: string;
    retain: string;
    use: string;
  };
}

export const METHODOLOGY_TEMPLATES: Record<MethodologyTemplate["id"], MethodologyTemplate> = {
  "ai-managed": {
    id: "ai-managed",
    name: "AI-managed",
    purpose:
      "Infer overlapping roles from the current vault's content and conventions, explain the fit, and keep organizational changes as reviewed suggestions.",
    roles: {
      project: "Time-bounded work with an outcome, current state, and next steps.",
      area: "An ongoing responsibility, standard, or practice that needs continued care.",
      reference: "Source material or reusable information kept for future consultation.",
      capture: "An unprocessed contribution whose origin and intent should remain visible.",
      synthesis: "A navigational or explanatory note that connects supporting material.",
      decision: "A choice with its context, rationale, and continuing consequences.",
      question: "An unresolved question with its current evidence and dependencies.",
      archive: "Material retained for history or reference after active use has ended.",
    },
    stages: {
      capture: "Preserve the contribution and its source before interpreting it.",
      process: "Separate source assertions, observations, interpretations, decisions, and questions.",
      review: "Revisit changed evidence, active work, and unresolved questions when relevant.",
      retain: "Keep reusable, attributable understanding with the notes that need it.",
      use: "Connect retained understanding to a concrete project, decision, or next question.",
    },
  },
  para: {
    id: "para",
    name: "PARA",
    purpose:
      "Use Projects, Areas, Resources, and Archives as overlapping retrieval roles, not required folders.",
    roles: {
      project: "An active effort with a defined result and useful next action.",
      area: "An ongoing responsibility without a fixed end date.",
      reference: "A resource that may support future work or learning.",
      archive: "A completed or inactive project, area, or resource worth retaining.",
      synthesis: "A note that links useful material across projects, areas, or resources.",
      decision: "A choice that can guide work across one or more PARA roles.",
      question: "An open question that belongs with the work or resource it affects.",
      capture: "A new input awaiting enough context to place it usefully.",
    },
    stages: {
      capture: "Keep the original contribution and source together.",
      process: "Identify the outcome, ongoing responsibility, future reference value, or inactive status.",
      review: "Review active projects by their next action and areas by continuing responsibility.",
      retain: "Preserve sources and reusable knowledge when a project becomes inactive.",
      use: "Bring the note back through its active work, responsibility, or future reference value.",
    },
  },
  flap: {
    id: "flap",
    name: "FLAP",
    purpose:
      "Use FLAP as an operator-defined, editable convention. Do not infer or claim a canonical expansion, role set, or folder structure from the name alone.",
    roles: {},
    stages: {
      capture: "Retain the original contribution before processing it.",
      process: "Follow the configured FLAP conventions and explain uncertain role assignments; leave undefined terms unexpanded.",
      review: "Return to unfinished or newly relevant material without repeated unchanged suggestions.",
      retain: "Keep supported understanding, attribution, and source references on the relevant notes.",
      use: "Connect the processed note to work, decisions, or questions that can benefit from it.",
    },
  },
  custom: {
    id: "custom",
    name: "Custom",
    purpose:
      "Follow the operator's named conventions as guidance while retaining evidence, authorship, and review boundaries.",
    roles: {},
    stages: {
      capture: "Preserve the original contribution and its origin.",
      process: "Use the configured conventions to assess what the contribution means and where it helps.",
      review: "Revisit relevant evidence and unresolved questions without repeating unchanged proposals.",
      retain: "Keep useful, attributable understanding on the notes that need it.",
      use: "Connect the retained understanding with decisions and active work.",
    },
  },
};

export function buildMethodologyGuidance(
  settings: MethodologySettings,
  inferredRoles: readonly { role: NoteRole; confidence: number; evidence: string[] }[] = [],
): string {
  const template = METHODOLOGY_TEMPLATES[settings.mode];
  const roleGuidance = Object.entries(template.roles)
    .map(([role, description]) => `- ${role}: ${description}`)
    .join("\n");
  const evidenceRoles = inferredRoles
    .map(
      (item) =>
        `- ${item.role} (${Math.round(item.confidence * 100)}%): ${item.evidence.join("; ")}`,
    )
    .join("\n");
  const conventions = settings.conventions.trim();
  return [
    `Methodology: ${settings.mode === "custom" ? settings.name : template.name}`,
    template.purpose,
    "Treat roles as overlapping retrieval and processing hints. Roles do not grant write permission or establish a folder destination.",
    roleGuidance ? `Role guide:\n${roleGuidance}` : "",
    evidenceRoles ? `Observed role signals:\n${evidenceRoles}` : "",
    `Capture: ${template.stages.capture}`,
    `Process: ${template.stages.process}`,
    `Review: ${template.stages.review}`,
    `Retain: ${template.stages.retain}`,
    `Use: ${template.stages.use}`,
    conventions ? `Additional configured conventions:\n${conventions}` : "",
    "Suggest a split, merge, rename, or move only when evidence supports it. Explain the benefit and preserve source attribution, corrections, authorship, and retained understanding. Keep structural changes subject to existing write authority and review.",
  ]
    .filter(Boolean)
    .join("\n");
}
