import { expect, test } from "bun:test";
import { rewriteMovedReferences } from "../../../../src/core/markdown/referenceMove";

test("reference-style destinations are edited once, with labels, titles, fragments and CRLF retained", () => {
  const body =
    '\ufeff# Sources\r\n[First][proof] and [Second][proof].\r\n\r\n[proof]: <Projects/Source.md#^fact> "Keep this title"\r\n\r\n```md\r\n[[Projects/Source]]\r\n```\r\n';
  const result = rewriteMovedReferences(
    body,
    "Index.md",
    "Projects/Source.md",
    "Archive/New source.md",
    ["Projects/Source.md", "Index.md"],
  );
  expect(result.ambiguous).toEqual([]);
  expect(result.count).toBe(1);
  expect(result.body).toBe(
    body.replace("Projects/Source.md#^fact", "Archive/New%20source.md#^fact"),
  );
});

test("an inline link's display text is never mistaken for its identical destination", () => {
  const result = rewriteMovedReferences(
    '[Source.md](Source.md#Result "Source.md")',
    "Index.md",
    "Source.md",
    "Archive/New.md",
    ["Source.md"],
  );
  expect(result.body).toBe('[Source.md](Archive/New.md#Result "Source.md")');
  expect(result.ambiguous).toEqual([]);
});

test("Obsidian property links retain scalar quoting, aliases, comments and untouched bytes", () => {
  const body =
    "\ufeff---\r\nrelated:\r\n  - \"[[Projects/Source#^fact|Proof]]\" # preserve\r\n  - '[[Projects/Source]]'\r\ncustom: untouched\r\n# [[Projects/Source]] is only a comment\r\n---\r\nBody stays byte-identical.\r\n";
  const result = rewriteMovedReferences(
    body,
    "Index.md",
    "Projects/Source.md",
    "Archive/Owner's source.md",
    ["Projects/Source.md"],
  );
  expect(result.ambiguous).toEqual([]);
  expect(result.body).toBe(
    body
      .replace("[[Projects/Source#^fact|Proof]]", "[[Archive/Owner's source#^fact|Proof]]")
      .replace("'[[Projects/Source]]'", "'[[Archive/Owner''s source]]'"),
  );
  expect(result.count).toBe(2);
});

test("moving a note rebases outgoing relative Markdown, extensionless links, attachments and local wikilinks", () => {
  const body =
    "[[Sibling#Section|Keep alias]]\n[Read](Sibling#Section)\n![Diagram](../assets/diagram.png)\n[PDF](../assets/report.pdf#page=2)\n[[#Local]]\n";
  const result = rewriteMovedReferences(
    body,
    "Projects/Source.md",
    "Projects/Source.md",
    "Archive/Deep/Source.md",
    ["Projects/Source.md", "Projects/Sibling.md"],
    "Archive/Deep/Source.md",
  );
  expect(result.ambiguous).toEqual([]);
  expect(result.body).toBe(
    "[[Projects/Sibling#Section|Keep alias]]\n[Read](../../Projects/Sibling#Section)\n![Diagram](../../assets/diagram.png)\n[PDF](../../assets/report.pdf#page=2)\n[[#Local]]\n",
  );
});

test("ambiguous property links refuse a guessed move", () => {
  const body = '---\nrelated: "[[Source]]"\n---\n';
  const result = rewriteMovedReferences(body, "Index.md", "A/Source.md", "Archive/Source.md", [
    "A/Source.md",
    "B/Source.md",
  ]);
  expect(result.body).toBe(body);
  expect(result.ambiguous).toEqual(["[[Source]]"]);
});

test("spaced wikilinks preserve spacing, aliases, anchors and embed spelling", () => {
  const body = "![[ Source #^fact | Alias ]] and [[ Source ]]";
  expect(
    rewriteMovedReferences(body, "Index.md", "Source.md", "Archive/New.md", ["Source.md"]).body,
  ).toBe("![[ Archive/New #^fact | Alias ]] and [[ Archive/New ]]");
});

test("duplicate reference definitions use the first definition, including nested definitions", () => {
  const body = "[Read][ref]\n\n> [ref]: Source.md\n\n[ref]: Other.md\n";
  expect(
    rewriteMovedReferences(body, "Index.md", "Source.md", "Archive/New.md", [
      "Source.md",
      "Other.md",
    ]).body,
  ).toBe(body.replace("Source.md", "Archive/New.md"));
});

test("encoded property links fail explicitly, while unrelated malformed properties do not block a move", () => {
  const encoded = '---\nrelated: "\\u005b\\u005bSource\\u005d\\u005d"\n---\n';
  expect(
    rewriteMovedReferences(encoded, "Index.md", "Source.md", "Archive/New.md", ["Source.md"])
      .ambiguous,
  ).toHaveLength(1);
  const unrelated = '---\ninvalid: ["[[Other]]"\n---\n';
  expect(
    rewriteMovedReferences(unrelated, "Index.md", "Source.md", "Archive/New.md", [
      "Source.md",
      "Other.md",
    ]).ambiguous,
  ).toEqual([]);
});
