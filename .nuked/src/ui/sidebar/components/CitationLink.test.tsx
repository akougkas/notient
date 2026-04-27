import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { CitationLink, renderWithCitations } from "./CitationLink";

describe("CitationLink", () => {
  test("renders the wikilink target wrapped in brackets", () => {
    const html = render(<CitationLink target="notes/a" />);
    expect(html).toContain("notient-chat-citation");
    expect(html).toContain('data-target="notes/a"');
    expect(html).toContain("[[notes/a]]");
  });

  test("renders the optional label instead of the target", () => {
    const html = render(<CitationLink target="notes/a" label="alpha" />);
    expect(html).toContain("[[alpha]]");
  });
});

describe("renderWithCitations", () => {
  test("returns the original text when there are no wikilinks", () => {
    const segments = renderWithCitations("plain text only");
    expect(segments).toEqual(["plain text only"]);
  });

  test("splits text around wikilinks and inlines a CitationLink", () => {
    const segments = renderWithCitations("see [[notes/a]] for details");
    expect(segments.length).toBe(3);
    expect(segments[0]).toBe("see ");
    expect(segments[2]).toBe(" for details");
  });

  test("supports piped wikilinks with display labels", () => {
    const segments = renderWithCitations("[[notes/a|alpha]]");
    const wrapper = render(<div>{segments}</div>);
    expect(wrapper).toContain('data-target="notes/a"');
    expect(wrapper).toContain("[[alpha]]");
  });
});
