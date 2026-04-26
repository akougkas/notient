import { type EditorState, RangeSet, StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { InsightDot } from "./InsightDot";
import { type ParagraphSpan, findChunkParagraphs } from "./paragraphMap";

export interface InsightProposal {
  id: string;
  agent: string;
  rationale: string;
  score: number;
  chunkText: string;
}

export interface BuildOptions {
  state: EditorState;
  proposals: InsightProposal[];
  maxPerViewport: number;
  onClick: (proposalId: string) => void;
}

interface GroupedProposal {
  paragraph: ParagraphSpan;
  primary: InsightProposal;
  count: number;
}

export function buildDecorationSet(options: BuildOptions): DecorationSet {
  const doc = options.state.doc.toString();
  const ranked = [...options.proposals].sort((left, right) => right.score - left.score);
  const matches = findChunkParagraphs(
    doc,
    ranked.map((proposal) => ({ id: proposal.id, text: proposal.chunkText })),
  );
  const grouped = new Map<string, GroupedProposal>();
  for (const proposal of ranked) {
    const paragraph = matches.get(proposal.id);
    if (!paragraph) continue;
    const key = `${paragraph.from}-${paragraph.to}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    if (grouped.size >= options.maxPerViewport) continue;
    grouped.set(key, { paragraph, primary: proposal, count: 1 });
  }
  const decorations = Array.from(grouped.values()).map(({ paragraph, primary, count }) =>
    Decoration.widget({
      widget: new InsightDot(
        {
          agent: primary.agent,
          proposalCount: count,
          rationale: primary.rationale,
          primaryProposalId: primary.id,
        },
        options.onClick,
      ),
      side: 1,
    }).range(paragraph.to),
  );
  decorations.sort((left, right) => left.from - right.from);
  return RangeSet.of(decorations, true);
}

/**
 * External invalidation signal. Task 16 wires the EventBus subscriptions
 * (`agent:run-finished`, `approval:decided`) to dispatch a transaction
 * carrying this effect on every active EditorView, which forces the plugin
 * to rebuild its decorations.
 */
export const rebuildEffect = StateEffect.define<null>();

export interface InsightsPluginOptions {
  getProposals: (notePath: string) => InsightProposal[];
  getActivePath: () => string | null;
  getMaxPerViewport: () => number;
  getDebounceMs: () => number;
  onClick: (proposalId: string) => void;
  isModeAllowed: () => boolean;
}

export function makeInsightsPlugin(options: InsightsPluginOptions) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private timer: ReturnType<typeof setTimeout> | null = null;

      constructor(public readonly view: EditorView) {
        this.schedule();
      }

      update(update: ViewUpdate): void {
        const requestedRebuild = update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(rebuildEffect)),
        );
        if (update.docChanged || requestedRebuild) this.schedule();
      }

      destroy(): void {
        if (this.timer !== null) clearTimeout(this.timer);
      }

      private schedule(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.rebuild(), options.getDebounceMs());
      }

      private rebuild(): void {
        if (!options.isModeAllowed()) {
          this.decorations = Decoration.none;
          return;
        }
        const path = options.getActivePath();
        if (path === null) {
          this.decorations = Decoration.none;
          return;
        }
        this.decorations = buildDecorationSet({
          state: this.view.state,
          proposals: options.getProposals(path),
          maxPerViewport: options.getMaxPerViewport(),
          onClick: options.onClick,
        });
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
