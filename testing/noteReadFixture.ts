import { contentRevision, inspectMarkdown } from "../src/api/notes";
import type { NoteReadResult } from "../src/api/schema";
/** Canonical daemon fixture for client rendering/protocol tests. */
export function noteReadFixture(body: string, path = "a.md"): NoteReadResult {
  return {
    ok: true,
    body,
    note: { path, revision: contentRevision(body) },
    structure: inspectMarkdown(body),
    selected: null,
    freshness: { source: "file", indexedRevision: null, state: "unknown" },
  };
}
