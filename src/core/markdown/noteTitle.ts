import type { NoteReadResult } from "../../api/schema";

export function noteTitle(note: Pick<NoteReadResult, "note" | "structure">): string {
  const declared = note.structure.frontmatter.properties?.title;
  const heading = note.structure.headings.find(
    (candidate) => candidate.level === 1 && candidate.text.trim(),
  )?.text;
  const filename = note.note.path.split("/").at(-1)?.replace(/\.md$/iu, "") ?? note.note.path;
  const title = typeof declared === "string" && declared.trim() ? declared : (heading ?? filename);
  return title.replace(/\s+/gu, " ").trim().slice(0, 300);
}
