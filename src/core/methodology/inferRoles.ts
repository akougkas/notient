import type { NoteReadResult } from "../../api/schema";
import type { NoteRole } from "./templates";
import { parseAllIntelligenceRecords } from "../intelligence";

export interface InferredNoteRole {
  role: NoteRole;
  confidence: number;
  evidence: string[];
}

type NoteInput = Pick<NoteReadResult, "note" | "body" | "structure">;

export function inferNoteRoles(note: NoteInput): InferredNoteRole[] {
  const found = new Map<NoteRole, Set<string>>();
  const add = (role: NoteRole, evidence: string): void => {
    const signals = found.get(role) ?? new Set<string>();
    signals.add(evidence.slice(0, 180));
    found.set(role, signals);
  };
  const tags = new Set(note.structure.tags.map((tag) => tag.toLowerCase()));
  const properties = note.structure.frontmatter.properties ?? {};
  const bodyLines = note.body.split(/\r\n|\n|\r/).map((line) => line.trim());
  const headings = note.structure.headings.map((heading) => heading.text.toLowerCase());
  const path = note.note.path.toLowerCase();
  const body = note.body.toLowerCase();
  const openTasks = note.structure.tasks.filter((task) => !task.checked);
  const status = typeof properties.status === "string" ? properties.status.toLowerCase() : "";

  for (const tag of tags) {
    if (["project", "projects"].includes(tag)) add("project", `tag #${tag}`);
    if (["area", "areas"].includes(tag)) add("area", `tag #${tag}`);
    if (["reference", "resource", "resources", "literature"].includes(tag))
      add("reference", `tag #${tag}`);
    if (["inbox", "capture", "fleeting"].includes(tag)) add("capture", `tag #${tag}`);
    if (["moc", "index", "synthesis", "overview"].includes(tag))
      add("synthesis", `tag #${tag}`);
    if (["decision", "decisions"].includes(tag)) add("decision", `tag #${tag}`);
    if (["question", "questions", "unresolved"].includes(tag))
      add("question", `tag #${tag}`);
    if (["archive", "archived", "inactive"].includes(tag)) add("archive", `tag #${tag}`);
  }

  for (const heading of headings) {
    if (/^(goal|outcome|milestone|next steps?|project plan)$/.test(heading))
      add("project", `heading “${heading}”`);
    if (/^(responsibilities|standards|maintenance|ongoing|principles)$/.test(heading))
      add("area", `heading “${heading}”`);
    if (/^(sources?|references?|bibliography|citations?)$/.test(heading))
      add("reference", `heading “${heading}”`);
    if (/^(questions?|open questions|unresolved)$/.test(heading))
      add("question", `heading “${heading}”`);
    if (/^(decisions?|rationale|decision log)$/.test(heading))
      add("decision", `heading “${heading}”`);
    if (/^(overview|map of content|related notes|index)$/.test(heading))
      add("synthesis", `heading “${heading}”`);
  }

  if (openTasks.length > 0) {
    add("project", `${openTasks.length} open task${openTasks.length === 1 ? "" : "s"}`);
    add("question", "unfinished work remains to be resolved");
  }
  if (["active", "in progress", "started"].includes(status))
    add("project", `status is ${status}`);
  if (["complete", "completed", "archived", "inactive", "done"].includes(status))
    add("archive", `status is ${status}`);
  if (/(^|\/)inbox(\/|$)/.test(path) || typeof properties.source === "string")
    add("capture", "capture location or source metadata is present");
  if (/(^|\/)(archive|archives)(\/|$)/.test(path)) add("archive", "note is under an archive path");
  if (
    Object.keys(properties).some((key) => ["url", "source", "author", "published"].includes(key)) ||
    /https?:\/\//.test(body)
  )
    add("reference", "source or publication metadata is present");
  if (/\bdecision\b|\bwe decided\b|\bchosen because\b/.test(body))
    add("decision", "decision language appears in the note");
  if (bodyLines.some((line) => /^\s*(?:[-*+]\s*)?[^#\n].{0,180}\?\s*$/.test(line)))
    add("question", "an open question appears in the note");
  if (note.structure.links.length >= 3 || note.structure.headings.length >= 3)
    add("synthesis", "multiple sections or links support navigation across material");
  let openQuestions = 0;
  try {
    openQuestions = parseAllIntelligenceRecords(note.body)
      .filter((record) => record.kind === "question" && record.status === "open").length;
  } catch {}
  if (openQuestions > 0)
    add("question", `${openQuestions} open note-resident question${openQuestions === 1 ? "" : "s"}`);

  return [...found]
    .map(([role, signals]) => {
      const evidence = [...signals];
      const explicit = evidence.some((item) => item.startsWith("tag #"));
      return {
        role,
        confidence: Math.min(0.96, explicit ? 0.84 + (evidence.length - 1) * 0.04 : 0.52 + (evidence.length - 1) * 0.12),
        evidence: evidence.slice(0, 4),
      };
    })
    .filter((item) => item.confidence >= 0.52)
    .sort((a, b) => b.confidence - a.confidence || a.role.localeCompare(b.role));
}
