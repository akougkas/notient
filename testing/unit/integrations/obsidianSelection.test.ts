import { describe, expect, test } from "bun:test";
import {
  askQuery,
  editChangeSet,
  gateSelection,
  replacementFor,
  savedOffset,
} from "../../../integrations/obsidian/src/selection";
import { contentRevision } from "../../../src/api/notes";

const editor = (saved: string) => saved.replace(/^\ufeff/, "").replaceAll("\r\n", "\n");
const revision = async (saved: string) => contentRevision(saved);
const SAVED =
  "\ufeff---\r\ntitle: Café 😀\r\ntags: [a]\r\n---\r\n# Heading\r\n\r\nFirst line 😀 café.\r\nSecond line.\r\n";
async function gate(saved: string, selected: string, overrides = {}) {
  const buffer = editor(saved);
  const from = buffer.indexOf(selected);
  return gateSelection({
    connected: true,
    path: "Work/Note.md",
    saved,
    buffer,
    from,
    to: from + selected.length,
    revision,
    ...overrides,
  });
}

describe("Obsidian selection mapping", () => {
  test("maps editor offsets past a BOM, CRLF, frontmatter and surrogate pairs exactly", async () => {
    expect(savedOffset(SAVED, 0)).toBe(1);
    expect(savedOffset("plain\ntext", 7)).toBe(7);
    expect(savedOffset("a\r\nb", 2)).toBe(3);
    expect(savedOffset("a\rb\r\nc", 4)).toBe(5);
    expect(() => savedOffset("ab", 3)).toThrow(RangeError);
    expect(() => savedOffset("ab", -1)).toThrow(RangeError);
    for (const selected of [
      "---\ntitle: Café 😀",
      "😀 café.\nSecond",
      "First line 😀 café.\nSecond line.\n",
      "Second line.",
    ]) {
      const result = await gate(SAVED, selected);
      if (!result.ok) throw new Error(result.notice);
      const { start, end, text } = result.target;
      expect(text).toBe(selected);
      expect(editor(SAVED.slice(start, end))).toBe(selected);
      expect(SAVED.slice(start, end)).toBe(selected.replaceAll("\n", "\r\n"));
      expect(result.target.revision).toBe(contentRevision(SAVED));
    }
    const whole = await gate(SAVED, editor(SAVED));
    expect(whole.ok && [whole.target.start, whole.target.end]).toEqual([1, SAVED.length]);
  });
  test("a reversed selection maps like a forward one", async () => {
    const buffer = editor(SAVED);
    const from = buffer.indexOf("Second");
    const result = await gateSelection({
      connected: true,
      path: "Note.md",
      saved: SAVED,
      buffer,
      from: from + 6,
      to: from,
      revision,
    });
    expect(result.ok && result.target.text).toBe("Second");
  });
  test("every refusal explains itself and binds nothing", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ connected: false }, "Reconnect"],
      [{ path: null }, "saved Markdown note"],
      [{ path: ".obsidian/workspace.md" }, "saved Markdown note"],
      [{ saved: null }, "saved Markdown note"],
      [{ from: 3, to: 3 }, "Select a passage"],
      [{ buffer: `${editor(SAVED)}typed`, from: 0, to: 5 }, "Save this note first"],
    ];
    for (const [overrides, expected] of cases) {
      const result = await gate(SAVED, "Second line.", overrides);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.notice).toContain(expected);
    }
    const blank = await gate("a\n   \nb\n", "\n   \n");
    expect(!blank.ok && blank.notice).toContain("Select a passage");
    const long = "x".repeat(16001);
    const tooLong = await gate(long, long);
    expect(!tooLong.ok && tooLong.notice).toContain("16,000");
  });
  test("requests carry the bound revision and the file's own line endings", async () => {
    const result = await gate(SAVED, "Second line.");
    if (!result.ok) throw new Error(result.notice);
    expect(replacementFor(SAVED, "Second\nline, revised.")).toBe("Second\r\nline, revised.");
    expect(replacementFor("a\nb", "c\r\nd")).toBe("c\nd");
    expect(editChangeSet(result.target, "New", "key")).toEqual({
      idempotencyKey: "key",
      changes: [
        {
          kind: "edit",
          source: { path: "Work/Note.md", revision: contentRevision(SAVED) },
          selector: { kind: "range", start: result.target.start, end: result.target.end },
          replacement: "New",
        },
      ],
    });
    const query = askQuery("  ", { path: "Work/Note.md", text: "y".repeat(9000) });
    expect(query.length).toBeLessThanOrEqual(8192);
    expect(query).toStartWith("Explain this passage");
    expect(askQuery("Why?", result.target)).toContain('"""\nSecond line.\n"""');
    expect(() => askQuery("q".repeat(8100), result.target)).toThrow("Shorten");
  });
});
