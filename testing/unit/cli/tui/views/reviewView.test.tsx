import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { NotientRpc } from "../../../../../src/cli/tui/rpc";
import { ReviewView } from "../../../../../src/cli/tui/views/ReviewView";

const revision = "a".repeat(64);
const proposal = {
  id: "b".repeat(64),
  revision,
  state: "pending",
  previewId: "c".repeat(64),
  previewRevision: revision,
  edgeIds: [],
  provenance: {
    requestedBy: { id: "codex", kind: "agent" },
    sources: [{ path: "Garden.md", revision }],
    evidence: [],
    rationale: "Seasonal reminder.",
    score: null,
  },
  createdAt: 1,
  decidedAt: null,
  decidedBy: null,
  appliedHistory: [],
};

const preview = {
  ok: true,
  previewId: proposal.previewId,
  revision,
  owner: "codex",
  changeSet: {
    idempotencyKey: "k",
    changes: [{ kind: "append", source: { path: "Garden.md", revision }, text: "\nMulch.\n" }],
  },
  effects: [
    {
      kind: "write",
      category: "body",
      relationship: null,
      path: "Garden.md",
      destination: null,
      before: "# Garden\n",
      after: "# Garden\n\nMulch.\n",
      beforeRevision: revision,
      afterRevision: "d".repeat(64),
      reason: "Append",
    },
  ],
  conflicts: [],
  createdAt: 1,
};

for (const height of [16, 24]) {
  test(`the key hints stay on the last row of a ${height}-row review pane`, async () => {
    const rpc = {
      reviews: async () => ({
        ok: true,
        proposals: [proposal],
        snapshot: revision,
        nextCursor: null,
      }),
      review: async () => ({ ok: true, proposal }),
      changePreview: async () => preview,
    } as unknown as NotientRpc;
    let screen: Awaited<ReturnType<typeof testRender>> | undefined;
    await act(async () => {
      screen = await testRender(
        <ReviewView
          rpc={() => rpc}
          width={120}
          height={height}
          active
          onRequests={() => {}}
          onOpen={() => {}}
          onClose={() => {}}
        />,
        { width: 120, height },
      );
    });
    if (!screen) throw new Error("Review did not mount");
    const mounted = screen;
    const lastRow = async (text: string) => {
      let rows: string[] = [];
      for (let attempt = 0; attempt < 60; attempt++) {
        await act(async () => {
          await Bun.sleep(20);
        });
        await mounted.renderOnce();
        rows = mounted.captureCharFrame().split("\n").slice(0, height);
        if (rows.join("\n").includes(text)) break;
      }
      return rows[height - 1];
    };
    try {
      expect(await lastRow("Enter inspect")).toContain("↑↓ choose · Enter inspect");
      await act(async () => {
        mounted.mockInput.pressEnter();
      });
      expect(await lastRow("a approve")).toContain("a approve · r reject");
    } finally {
      await act(async () => {
        mounted.renderer.destroy();
      });
    }
  });
}
