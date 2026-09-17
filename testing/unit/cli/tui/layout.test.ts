import { describe, expect, test } from "bun:test";
import {
  PANEL_FRAME_HEIGHT,
  PANEL_FRAME_WIDTH,
  SCROLLBAR_GUTTER_WIDTH,
  deriveTuiLayout,
  panelInnerWidth,
} from "../../../../src/cli/tui/layout";
import type { TopBarModel } from "../../../../src/cli/tui/viewModels";
import { citationBarRows } from "../../../../src/cli/tui/views/AskView";
import { buildTopBarDisplay } from "../../../../src/cli/tui/views/Chrome";
import { truncateMiddle, truncatePath } from "../../../../src/cli/tui/views/theme";

const DIMENSIONS = [
  [80, 24, "compact"],
  [120, 40, "standard"],
  [200, 60, "wide"],
] as const;

const TOP_BAR: TopBarModel = {
  vault: "research/very-long-vault-name-that-must-remain-identifiable.md",
  daemon: "ready",
  model: "qwen3.5-long-context-reasoner:latest",
  awaken: "awaken running 412/1200 34%",
  pending: 13,
  pendingStale: false,
  tabs: [
    { key: "1", title: "Home", active: true },
    { key: "2", title: "Inbox", active: false },
    { key: "3", title: "Ask", active: false },
    { key: "4", title: "Explore", active: false },
    { key: "5", title: "Stream", active: false },
  ],
};

describe("deriveTuiLayout", () => {
  for (const [width, height, mode] of DIMENSIONS) {
    test(`builds stable, bounded ${width}x${height} geometry`, () => {
      const layout = deriveTuiLayout(width, height);
      expect(layout).toEqual(deriveTuiLayout(width, height));
      expect(layout.terminal).toEqual({ width, height });
      expect(layout.mode).toBe(mode);
      expect(layout.contentHeight).toBe(height - 2);
      expect(
        layout.home.indexingHeight +
          layout.home.vitalsHeight +
          layout.home.statusHeight +
          layout.home.bottomHeight,
      ).toBe(layout.contentHeight);

      expect(layout.home.awakenWidth + layout.home.endpointsWidth).toBe(width);
      expect(layout.home.typedEdgesWidth + layout.home.discoveriesWidth).toBe(width);
      expect(layout.inbox.queueWidth + layout.inbox.detailWidth).toBe(width);
      expect(layout.explore.contentWidth + 2 * layout.explore.inset).toBeLessThanOrEqual(width);
      expect(layout.explore.contentWidth).toBeLessThanOrEqual(96);
    });
  }

  test("gives all three endpoint roles distinct rows in compact Home", () => {
    const { home } = deriveTuiLayout(80, 24);
    expect(home.statusHeight - PANEL_FRAME_HEIGHT).toBe(3);
    expect(home.bottomHeight).toBeGreaterThanOrEqual(7);
  });

  test("reserves a scrollbar gutter inside every bordered scrolling panel", () => {
    for (const [width, height] of DIMENSIONS) {
      const layout = deriveTuiLayout(width, height);
      expect(layout.home.edgeScrollWidth).toBe(panelInnerWidth(layout.home.typedEdgesWidth));
      expect(layout.home.edgeRowsWidth).toBe(layout.home.edgeScrollWidth - SCROLLBAR_GUTTER_WIDTH);
      expect(layout.home.discoveryScrollWidth).toBe(panelInnerWidth(layout.home.discoveriesWidth));
      expect(layout.home.discoveryRowsWidth).toBe(
        layout.home.discoveryScrollWidth - SCROLLBAR_GUTTER_WIDTH,
      );
      expect(layout.inbox.queueScrollWidth).toBe(panelInnerWidth(layout.inbox.queueWidth));
      expect(layout.inbox.queueRowsWidth).toBe(
        layout.inbox.queueScrollWidth - SCROLLBAR_GUTTER_WIDTH,
      );
      expect(layout.inbox.detailScrollWidth).toBe(panelInnerWidth(layout.inbox.detailWidth));
      expect(layout.inbox.detailRowsWidth).toBe(
        layout.inbox.detailScrollWidth - SCROLLBAR_GUTTER_WIDTH,
      );
      expect(layout.stream.scrollWidth).toBe(layout.stream.width - PANEL_FRAME_WIDTH);
      expect(layout.stream.rowsWidth).toBe(layout.stream.scrollWidth - SCROLLBAR_GUTTER_WIDTH);
      expect(layout.ask.conversationScrollWidth).toBe(layout.ask.conversationWidth);
      expect(layout.ask.conversationRowsWidth).toBe(
        layout.ask.conversationScrollWidth - SCROLLBAR_GUTTER_WIDTH,
      );
      expect(layout.explore.readingRowsWidth).toBe(
        layout.explore.readingScrollWidth - SCROLLBAR_GUTTER_WIDTH,
      );
      expect(layout.explore.neighborsRowsWidth).toBe(
        layout.explore.neighborsScrollWidth - SCROLLBAR_GUTTER_WIDTH,
      );
      expect(layout.home.bottomScrollHeight).toBe(layout.home.bottomHeight - 3);
      expect(layout.inbox.scrollHeight).toBe(layout.contentHeight - 3);
      expect(layout.explore.scrollHeight).toBe(layout.contentHeight - 4);
      expect(layout.stream.scrollHeight).toBe(layout.contentHeight - 4);
    }
  });

  test("keeps fixed columns inside their text budgets at every acceptance width", () => {
    for (const [width, height] of DIMENSIONS) {
      const layout = deriveTuiLayout(width, height);
      expect(
        layout.home.discoveryTypeWidth +
          layout.home.discoverySummaryWidth +
          layout.home.discoveryPathWidth,
      ).toBe(layout.home.discoveryRowsWidth);
      expect(layout.home.edgeRowsWidth - layout.home.edgeTableWidth).toBeGreaterThanOrEqual(14);

      expect(
        2 + layout.inbox.proposalTableWidth + 1 + layout.inbox.proposalSourceWidth + 1 + 4 + 1,
      ).toBe(layout.inbox.queueRowsWidth);
      expect(2 + layout.inbox.approvalToolWidth + 1 + layout.inbox.approvalRequesterWidth + 1).toBe(
        layout.inbox.queueRowsWidth,
      );
      expect(layout.inbox.detailLabelWidth + 1 + layout.inbox.detailValueWidth + 1).toBe(
        layout.inbox.detailRowsWidth,
      );

      expect(
        3 + layout.explore.neighborTableWidth + 1 + layout.explore.neighborPathWidth + 4 + 1,
      ).toBe(layout.explore.neighborsRowsWidth);
      expect(
        layout.stream.timestampWidth + layout.stream.typeWidth + layout.stream.summaryWidth + 1,
      ).toBe(layout.stream.rowsWidth);
      expect(layout.inbox.proposalSourceWidth).toBeGreaterThanOrEqual(8);
      expect(layout.explore.neighborPathWidth).toBeGreaterThanOrEqual(8);
      expect(layout.stream.summaryWidth).toBeGreaterThanOrEqual(12);
    }
  });
});

describe("Ask geometry", () => {
  const citations = [
    "research/long-source-one.md",
    "research/long-source-two.md",
    "research/long-source-three.md",
    "research/long-source-four.md",
  ];

  test("reserves exactly the rows used by responsive citation chips", () => {
    expect(citationBarRows([], deriveTuiLayout(80, 24).ask)).toBe(0);
    expect(citationBarRows(citations, deriveTuiLayout(80, 24).ask)).toBe(2);
    expect(citationBarRows(citations, deriveTuiLayout(120, 40).ask)).toBe(2);
  });
});

describe("responsive chrome", () => {
  test("fits vault identity, exact pending count, current view and daemon state", () => {
    for (const [width, height] of DIMENSIONS) {
      const layout = deriveTuiLayout(width, height);
      const display = buildTopBarDisplay(TOP_BAR, layout.chrome);
      const rendered = [...display.left, ...display.right].map((segment) => segment.text).join("");
      expect(display.leftWidth + display.rightWidth + 1).toBeLessThanOrEqual(
        layout.chrome.innerWidth,
      );
      expect(rendered).toContain("Review 13");
      expect(rendered).toContain("ready");
      expect(rendered).toContain("Home");
      expect(rendered).toContain(".md");
    }
  });

  test("marks unknown and stale pending totals instead of drawing an authoritative zero", () => {
    const compact = deriveTuiLayout(80, 24).chrome;
    const unknown = buildTopBarDisplay({ ...TOP_BAR, pending: null, pendingStale: false }, compact);
    const stale = buildTopBarDisplay({ ...TOP_BAR, pending: 13, pendingStale: true }, compact);
    expect(unknown.right.map((segment) => segment.text).join("")).toContain("Review ?");
    expect(stale.right.map((segment) => segment.text).join("")).toContain("Review ~13");
  });

  test("path truncation preserves useful identity rather than stray prefixes", () => {
    expect(truncatePath("research/multithreaded-hdf5.md", 12)).toBe("…ded-hdf5.md");
    const middle = truncateMiddle("research/multithreaded-hdf5.md", 18);
    expect(middle).toStartWith("research/");
    expect(middle).toEndWith("hdf5.md");
    expect(middle).toHaveLength(18);
  });
});
