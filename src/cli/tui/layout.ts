/**
 * Responsive geometry for the entire TUI.
 *
 * `runtime.tsx` feeds this module the value of `useTerminalDimensions()` once
 * per render. Views receive only the resulting immutable slice, so content or
 * asynchronous state changes can never make a pane drift sideways.
 */

export const PANEL_FRAME_WIDTH = 4;
export const PANEL_FRAME_HEIGHT = 3;
export const SCROLLBAR_GUTTER_WIDTH = 1;

export type TuiLayoutMode = "compact" | "standard" | "wide";

export interface ChromeLayout {
  readonly width: number;
  readonly innerWidth: number;
  readonly topBarMode: TuiLayoutMode;
  readonly topBarRightBudget: number;
  readonly vaultLabelWidth: number;
  readonly modelLabelWidth: number;
  readonly messageWidth: number;
}

export interface HomeLayout {
  readonly indexingHeight: number;
  readonly width: number;
  readonly vitalsWidth: number;
  readonly vitalsHeight: number;
  readonly cardWidth: number;
  readonly awakenWidth: number;
  readonly endpointsWidth: number;
  readonly statusHeight: number;
  readonly bottomHeight: number;
  readonly bottomScrollHeight: number;
  readonly awakenBarWidth: number;
  readonly endpointLabelWidth: number;
  readonly typedEdgesWidth: number;
  readonly discoveriesWidth: number;
  readonly edgeScrollWidth: number;
  readonly edgeTableWidth: number;
  readonly edgeRowsWidth: number;
  readonly discoveryScrollWidth: number;
  readonly discoveryRowsWidth: number;
  readonly discoveryTypeWidth: number;
  readonly discoverySummaryWidth: number;
  readonly discoveryPathWidth: number;
}

export interface InboxLayout {
  readonly width: number;
  readonly height: number;
  readonly queueWidth: number;
  readonly detailWidth: number;
  readonly queueScrollWidth: number;
  readonly queueRowsWidth: number;
  readonly detailScrollWidth: number;
  readonly detailRowsWidth: number;
  readonly scrollHeight: number;
  readonly proposalTableWidth: number;
  readonly proposalSourceWidth: number;
  readonly approvalToolWidth: number;
  readonly approvalRequesterWidth: number;
  readonly detailLabelWidth: number;
  readonly detailValueWidth: number;
}

export interface AskLayout {
  readonly width: number;
  readonly height: number;
  readonly inset: number;
  readonly conversationWidth: number;
  readonly conversationScrollWidth: number;
  readonly conversationRowsWidth: number;
  readonly inputTextWidth: number;
  readonly citationPathWidth: number;
}

export interface ExploreLayout {
  readonly width: number;
  readonly height: number;
  readonly inset: number;
  readonly contentWidth: number;
  readonly bodyTextWidth: number;
  readonly readingScrollWidth: number;
  readonly readingRowsWidth: number;
  readonly neighborsScrollWidth: number;
  readonly neighborsRowsWidth: number;
  readonly scrollHeight: number;
  readonly evidenceWidth: number;
  readonly neighborTableWidth: number;
  readonly neighborPathWidth: number;
}

export interface StreamLayout {
  readonly width: number;
  readonly height: number;
  readonly scrollWidth: number;
  readonly rowsWidth: number;
  readonly scrollHeight: number;
  readonly timestampWidth: number;
  readonly typeWidth: number;
  readonly summaryWidth: number;
}

export interface TuiLayout {
  readonly terminal: { readonly width: number; readonly height: number };
  readonly mode: TuiLayoutMode;
  readonly contentHeight: number;
  readonly chrome: ChromeLayout;
  readonly home: HomeLayout;
  readonly inbox: InboxLayout;
  readonly ask: AskLayout;
  readonly explore: ExploreLayout;
  readonly stream: StreamLayout;
}

export function panelInnerWidth(width: number): number {
  return Math.max(1, width - PANEL_FRAME_WIDTH);
}

function scrollRowsWidth(width: number): number {
  return Math.max(1, panelInnerWidth(width) - SCROLLBAR_GUTTER_WIDTH);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function splitWidth(
  total: number,
  desiredRight: number,
  minimumLeft: number,
  minimumRight: number,
) {
  const largestRight = Math.max(minimumRight, total - minimumLeft);
  const right = clamp(desiredRight, minimumRight, largestRight);
  return { left: Math.max(1, total - right), right };
}

function layoutMode(width: number): TuiLayoutMode {
  if (width < 110) return "compact";
  if (width < 170) return "standard";
  return "wide";
}

interface ModeGeometry {
  readonly topBarRightRatio: number;
  readonly vaultLabelWidth: number;
  readonly modelLabelWidth: number;
  readonly endpointRatio: number;
  readonly discoveryRatio: number;
  readonly cardWidth: number;
  readonly inboxDetailRatio: number;
  readonly detailLabelWidth: number;
  readonly citationPathWidth: number;
  readonly streamTypeWidth: number;
}

const MODE_GEOMETRY: Record<TuiLayoutMode, ModeGeometry> = {
  compact: {
    topBarRightRatio: 0.31,
    vaultLabelWidth: 14,
    modelLabelWidth: 0,
    endpointRatio: 0.28,
    discoveryRatio: 0.575,
    cardWidth: 12,
    inboxDetailRatio: 0.5,
    detailLabelWidth: 12,
    citationPathWidth: 30,
    streamTypeWidth: 20,
  },
  standard: {
    topBarRightRatio: 0.34,
    vaultLabelWidth: 20,
    modelLabelWidth: 0,
    endpointRatio: 0.24,
    discoveryRatio: 0.7,
    cardWidth: 14,
    inboxDetailRatio: 0.58,
    detailLabelWidth: 14,
    citationPathWidth: 36,
    streamTypeWidth: 28,
  },
  wide: {
    topBarRightRatio: 0.42,
    vaultLabelWidth: 32,
    modelLabelWidth: 28,
    endpointRatio: 0.24,
    discoveryRatio: 0.79,
    cardWidth: 16,
    inboxDetailRatio: 0.62,
    detailLabelWidth: 14,
    citationPathWidth: 30,
    streamTypeWidth: 34,
  },
};

function deriveChrome(width: number, mode: TuiLayoutMode, metrics: ModeGeometry): ChromeLayout {
  const innerWidth = Math.max(1, width - 2);
  return {
    width,
    innerWidth,
    topBarMode: mode,
    topBarRightBudget: Math.max(12, Math.floor(innerWidth * metrics.topBarRightRatio)),
    vaultLabelWidth: metrics.vaultLabelWidth,
    modelLabelWidth: metrics.modelLabelWidth,
    messageWidth: innerWidth,
  };
}

function deriveHome(width: number, contentHeight: number, metrics: ModeGeometry): HomeLayout {
  const status = splitWidth(
    width,
    clamp(Math.floor(width * metrics.endpointRatio), 22, 36),
    40,
    22,
  );
  const bottom = splitWidth(width, Math.floor(width * metrics.discoveryRatio), 34, 38);
  const vitalColumns = clamp(Math.floor(panelInnerWidth(width) / metrics.cardWidth), 1, 10);
  const cardWidth = Math.max(8, Math.floor(panelInnerWidth(width) / vitalColumns));
  const edgeScrollWidth = panelInnerWidth(bottom.left);
  const edgeRowsWidth = scrollRowsWidth(bottom.left);
  const discoveryScrollWidth = panelInnerWidth(bottom.right);
  const discoveryRowsWidth = scrollRowsWidth(bottom.right);
  const discoveryTypeWidth = clamp(Math.floor(discoveryRowsWidth * 0.27), 10, 24);
  const discoveryPathWidth = clamp(Math.floor(discoveryRowsWidth * 0.22), 9, 28);
  const vitalsHeight = 3 + Math.ceil(10 / vitalColumns) * 2;
  // HealthMonitor owns three canonical roles: primary, deep, and embedding.
  // A bordered panel also spends one interior row on its title, so six rows
  // are the minimum geometry that keeps every endpoint on its own line.
  const statusHeight = PANEL_FRAME_HEIGHT + 3;
  const bottomHeight = Math.max(4, contentHeight - vitalsHeight - statusHeight - 2);
  return {
    indexingHeight: 2,
    width,
    vitalsWidth: width,
    vitalsHeight,
    cardWidth,
    awakenWidth: status.left,
    endpointsWidth: status.right,
    statusHeight,
    bottomHeight,
    bottomScrollHeight: Math.max(1, bottomHeight - 3),
    awakenBarWidth: clamp(panelInnerWidth(status.left) - 29, 8, 38),
    endpointLabelWidth: Math.max(8, panelInnerWidth(status.right) - 2),
    typedEdgesWidth: bottom.left,
    discoveriesWidth: bottom.right,
    edgeScrollWidth,
    edgeTableWidth: clamp(Math.floor(edgeRowsWidth * 0.43), 9, 16),
    edgeRowsWidth,
    discoveryScrollWidth,
    discoveryRowsWidth,
    discoveryTypeWidth,
    discoverySummaryWidth: Math.max(
      8,
      discoveryRowsWidth - discoveryTypeWidth - discoveryPathWidth,
    ),
    discoveryPathWidth,
  };
}

function deriveInbox(width: number, contentHeight: number, metrics: ModeGeometry): InboxLayout {
  const split = splitWidth(width, Math.floor(width * metrics.inboxDetailRatio), 34, 40);
  const queueScrollWidth = panelInnerWidth(split.left);
  const queueRowsWidth = scrollRowsWidth(split.left);
  const detailScrollWidth = panelInnerWidth(split.right);
  const detailRowsWidth = scrollRowsWidth(split.right);
  const proposalTableWidth = clamp(
    Math.floor(queueRowsWidth * 0.3),
    11,
    Math.max(8, queueRowsWidth - 16),
  );
  const approvalToolWidth = clamp(
    Math.floor(queueRowsWidth * 0.56),
    12,
    Math.max(12, queueRowsWidth - 8),
  );
  return {
    width,
    height: contentHeight,
    queueWidth: split.left,
    detailWidth: split.right,
    queueScrollWidth,
    queueRowsWidth,
    detailScrollWidth,
    detailRowsWidth,
    scrollHeight: Math.max(1, contentHeight - 3),
    proposalTableWidth,
    proposalSourceWidth: Math.max(8, queueRowsWidth - proposalTableWidth - 9),
    approvalToolWidth,
    approvalRequesterWidth: Math.max(6, queueRowsWidth - approvalToolWidth - 4),
    detailLabelWidth: metrics.detailLabelWidth,
    detailValueWidth: Math.max(8, detailRowsWidth - metrics.detailLabelWidth - 2),
  };
}

function deriveAsk(width: number, contentHeight: number, metrics: ModeGeometry): AskLayout {
  const { width: column, inset } = readingColumn(width);
  return {
    width,
    height: contentHeight,
    inset,
    conversationWidth: column,
    conversationScrollWidth: column,
    conversationRowsWidth: Math.max(1, column - 1),
    inputTextWidth: Math.max(1, column - 4),
    citationPathWidth: metrics.citationPathWidth,
  };
}

function deriveExplore(width: number, contentHeight: number): ExploreLayout {
  const { width: contentWidth, inset } = readingColumn(width);
  const rowsWidth = Math.max(1, contentWidth - 1);
  const neighborTableWidth = clamp(Math.floor(rowsWidth * 0.3), 8, 14);
  return {
    width,
    height: contentHeight,
    inset,
    contentWidth,
    bodyTextWidth: contentWidth,
    readingScrollWidth: contentWidth,
    readingRowsWidth: rowsWidth,
    neighborsScrollWidth: contentWidth,
    neighborsRowsWidth: rowsWidth,
    scrollHeight: Math.max(1, contentHeight - 4),
    evidenceWidth: Math.max(8, rowsWidth - 7),
    neighborTableWidth,
    neighborPathWidth: Math.max(8, rowsWidth - neighborTableWidth - 9),
  };
}

/** Keep prose readable and its controls in the same column at any terminal width. */
export function readingColumn(terminalWidth: number): { width: number; inset: number } {
  const width = Math.max(1, Math.min(96, terminalWidth - 6));
  return { width, inset: Math.max(0, Math.floor((terminalWidth - width) / 2)) };
}

function deriveStream(width: number, contentHeight: number, metrics: ModeGeometry): StreamLayout {
  const scrollWidth = panelInnerWidth(width);
  const rowsWidth = scrollRowsWidth(width);
  const timestampWidth = 9;
  const typeWidth = clamp(
    metrics.streamTypeWidth + 1,
    13,
    Math.max(13, rowsWidth - timestampWidth - 12),
  );
  return {
    width,
    height: contentHeight,
    scrollWidth,
    rowsWidth,
    scrollHeight: Math.max(1, contentHeight - 4),
    timestampWidth,
    typeWidth,
    summaryWidth: Math.max(8, rowsWidth - timestampWidth - typeWidth - 1),
  };
}

/** Derive all pane and content widths from one terminal measurement. */
export function deriveTuiLayout(rawWidth: number, rawHeight: number): TuiLayout {
  const width = Math.max(1, Math.floor(rawWidth));
  const height = Math.max(1, Math.floor(rawHeight));
  const mode = layoutMode(width);
  const contentHeight = Math.max(1, height - 2);
  const metrics = MODE_GEOMETRY[mode];

  return {
    terminal: { width, height },
    mode,
    contentHeight,
    chrome: deriveChrome(width, mode, metrics),
    home: deriveHome(width, contentHeight, metrics),
    inbox: deriveInbox(width, contentHeight, metrics),
    ask: deriveAsk(width, contentHeight, metrics),
    explore: deriveExplore(width, contentHeight),
    stream: deriveStream(width, contentHeight, metrics),
  };
}
