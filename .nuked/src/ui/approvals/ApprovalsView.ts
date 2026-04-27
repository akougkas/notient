import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type { ApprovalService } from "../../core/approvals/approvalService";
import type { EventBus } from "../../core/events/eventBus";

export const VIEW_TYPE_NOTIENT_APPROVALS = "notient-approvals";

export interface ApprovalsViewDeps {
  service: ApprovalService;
  bus: EventBus;
}

const AGENT_LABELS: Record<string, string> = {
  linker: "Linker",
  synthesizer: "Synthesizer",
  contradictionHunter: "Contradiction Hunter",
  "contradiction-hunter": "Contradiction Hunter",
  maturityAdvancer: "Maturity Advancer",
  "maturity-advancer": "Maturity Advancer",
  coauthor: "Co-author",
  "co-author": "Co-author",
};

function normalizeAgent(agent: string): string {
  if (agent === "contradictionHunter") return "contradiction-hunter";
  if (agent === "maturityAdvancer") return "maturity-advancer";
  if (agent === "coauthor") return "co-author";
  return agent;
}

function prettyAgent(agent: string): string {
  return AGENT_LABELS[agent] ?? agent;
}

interface PendingEdge {
  id: string;
  agent: string;
  type: string;
  confidence: number;
  rationale?: string | null;
  sourceId: string;
  targetId: string;
}

export class ApprovalsView extends ItemView {
  private offs: Array<() => void> = [];
  private root: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: ApprovalsViewDeps,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_NOTIENT_APPROVALS;
  }

  getDisplayText(): string {
    return "Notient Approvals";
  }

  async onOpen(): Promise<void> {
    this.root = this.containerEl.children[1] as HTMLElement;
    this.draw();
    this.offs.push(this.deps.bus.on("approval:decided", () => this.draw()));
    this.offs.push(this.deps.bus.on("agent:run-finished", () => this.draw()));
  }

  async onClose(): Promise<void> {
    for (const off of this.offs) off();
    this.offs = [];
  }

  private draw(): void {
    if (!this.root) return;
    const root = this.root;
    root.empty();
    root.classList.add("notient-approvals");
    const pending = this.deps.service.listPendingEdges() as PendingEdge[];

    const head = root.createDiv({ cls: "notient-approvals__head" });
    const title = head.createEl("h2", { cls: "notient-approvals__title" });
    title.setText("Pending approvals");
    const counter = head.createDiv();
    counter.setText(`${pending.length} waiting`);

    if (pending.length === 0) {
      const empty = root.createDiv({ cls: "notient-empty" });
      empty.createSpan({ cls: "notient-empty__dot" });
      const headingEl = empty.createEl("h3", { cls: "notient-empty__title" });
      headingEl.setText("Nothing waiting.");
      const hintEl = empty.createEl("p", { cls: "notient-empty__hint" });
      hintEl.setText("Save a note. The swarm will surface proposals as they arrive.");
      return;
    }

    const groups = new Map<string, PendingEdge[]>();
    for (const item of pending) {
      const key = item.type;
      const bucket = groups.get(key);
      if (bucket) bucket.push(item);
      else groups.set(key, [item]);
    }

    for (const [edgeType, items] of groups) {
      const section = root.createEl("section", { cls: "notient-approvals__group" });
      const groupHead = section.createDiv({ cls: "notient-approvals__group-head" });
      const label = groupHead.createEl("h3", { cls: "notient-approvals__group-label" });
      label.setText(edgeType);
      if (items.length >= 2) {
        const bulk = groupHead.createEl("button", { cls: "notient-button" });
        bulk.dataset.emphasis = "ghost";
        bulk.setText(`Approve all in this group (${items.length})`);
        bulk.addEventListener("click", () => {
          void this.bulkApprove(edgeType, items);
        });
      }
      for (const item of items) {
        const card = section.createEl("article", { cls: "notient-card" });
        card.dataset.agent = normalizeAgent(item.agent);
        const titleEl = card.createEl("h3", { cls: "notient-card__title" });
        titleEl.setText(`${item.sourceId} → ${item.targetId}`);
        const meta = card.createDiv({ cls: "notient-card__meta" });
        const agentPip = meta.createSpan({ cls: "notient-pip" });
        agentPip.dataset.agent = normalizeAgent(item.agent);
        agentPip.setText(prettyAgent(item.agent));
        meta.createSpan({ text: edgeType });
        const confidence = meta.createSpan({ cls: "notient-pip notient-pip--num" });
        confidence.setText(`${Math.round(item.confidence * 100)}%`);
        if (item.rationale) {
          const rationale = card.createEl("p", { cls: "notient-card__rationale" });
          rationale.setText(item.rationale);
        }
        const actions = card.createEl("footer", { cls: "notient-card__actions" });
        const accept = actions.createEl("button", { cls: "notient-button" });
        accept.setText("Approve");
        accept.addEventListener("click", () => void this.deps.service.acceptEdge(item.id));
        const reject = actions.createEl("button", { cls: "notient-button" });
        reject.dataset.emphasis = "ghost";
        reject.dataset.tone = "danger";
        reject.setText("Reject");
        reject.addEventListener("click", () => void this.deps.service.rejectEdge(item.id));
      }
    }
  }

  private async bulkApprove(edgeType: string, items: PendingEdge[]): Promise<void> {
    let accepted = 0;
    let failed = 0;
    for (const item of items) {
      try {
        await this.deps.service.acceptEdge(item.id);
        accepted += 1;
      } catch {
        failed += 1;
      }
    }
    new Notice(
      `Notient: ${accepted} ${edgeType} accepted${failed > 0 ? `, ${failed} failed` : ""}`,
    );
  }
}
