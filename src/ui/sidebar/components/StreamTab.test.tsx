import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { StreamItem } from "../../../core/stream/types";
import { StreamTab, focusedProposalIdState, streamActions, streamItemsState } from "./StreamTab";

function item(id: string): StreamItem {
  return {
    id,
    kind: "edge",
    agent: "linker",
    type: "supports",
    confidence: 0.82,
    rationale: "related evidence",
    createdAt: 1,
    notePaths: ["notes/a.md"],
    evidenceChunkIds: [],
    score: 0.82,
  };
}

function resetStreamState(): void {
  streamItemsState.value = [];
  focusedProposalIdState.value = null;
  streamActions.value = null;
}

describe("StreamTab", () => {
  test("renders a focused proposal card from focusedProposalIdState", () => {
    resetStreamState();
    streamItemsState.value = [item("edge-1"), item("edge-2")];
    focusedProposalIdState.value = "edge-2";

    const html = render(<StreamTab />);

    expect(html).toContain('data-proposal-id="edge-2"');
    expect(html).toContain("notient-stream-item--focused");
    expect(html).toContain('aria-current="true"');
  });

  test("does not mark cards focused when no focused proposal is set", () => {
    resetStreamState();
    streamItemsState.value = [item("edge-1")];

    const html = render(<StreamTab />);

    expect(html).toContain('data-proposal-id="edge-1"');
    expect(html).not.toContain("notient-stream-item--focused");
    expect(html).not.toContain('aria-current="true"');
  });
});
