import { describe, expect, test } from "bun:test";
import { addRelatedLink, removeRelatedLink } from "./relatedSection";

describe("relatedSection", () => {
  test("appends a Related section when none exists", () => {
    const before = "# Note\n\nBody paragraph.\n";
    const after = addRelatedLink(before, "Related", "[[Other]]");
    expect(after).toContain("## Related");
    expect(after).toContain("- [[Other]]");
  });

  test("appends to an existing Related section without duplicating", () => {
    const before = "# Note\n\nBody.\n\n## Related\n- [[Existing]]\n";
    const after = addRelatedLink(before, "Related", "[[Existing]]");
    const occurrences = (after.match(/\[\[Existing\]\]/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  test("preserves existing entries when adding a new one", () => {
    const before = "# Note\n\nBody.\n\n## Related\n- [[A]]\n- [[B]]\n";
    const after = addRelatedLink(before, "Related", "[[C]]");
    expect(after).toContain("- [[A]]");
    expect(after).toContain("- [[B]]");
    expect(after).toContain("- [[C]]");
  });

  test("removeRelatedLink removes one entry without breaking the section", () => {
    const before = "# Note\n\n## Related\n- [[A]]\n- [[B]]\n";
    const after = removeRelatedLink(before, "Related", "[[A]]");
    expect(after).toContain("- [[B]]");
    expect(after).not.toContain("- [[A]]");
    expect(after).toContain("## Related");
  });

  test("removeRelatedLink drops the heading when its last entry is removed", () => {
    const before = "# Note\n\nBody.\n\n## Related\n- [[Only]]\n";
    const after = removeRelatedLink(before, "Related", "[[Only]]");
    expect(after).not.toContain("## Related");
    expect(after).not.toContain("[[Only]]");
  });

  test("custom heading override works for both add and remove", () => {
    const before = "# Note\n\nBody.\n";
    const added = addRelatedLink(before, "References", "[[X]]");
    expect(added).toContain("## References");
    const removed = removeRelatedLink(added, "References", "[[X]]");
    expect(removed).not.toContain("## References");
  });
});
