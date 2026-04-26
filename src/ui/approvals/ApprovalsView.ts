import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { ApprovalService } from "../../core/approvals/approvalService";
import type { EventBus } from "../../core/events/eventBus";

export const VIEW_TYPE_NOTIENT_APPROVALS = "notient-approvals";

export interface ApprovalsViewDeps {
  service: ApprovalService;
  bus: EventBus;
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
    const pending = this.deps.service.listPendingEdges();
    if (pending.length === 0) {
      const empty = root.createDiv({ cls: "notient-approvals__empty" });
      empty.setText("No pending proposals.");
      return;
    }
    for (const item of pending) {
      const card = root.createDiv({ cls: "notient-approvals__card" });
      const head = card.createDiv({ cls: "notient-approvals__head" });
      head.createSpan({
        text: `${item.agent} | ${item.type} | ${(item.confidence * 100).toFixed(0)}%`,
      });
      const body = card.createDiv({ cls: "notient-approvals__body" });
      body.createDiv({ text: `${item.sourceId} -> ${item.targetId}` });
      if (item.rationale) body.createDiv({ text: item.rationale });
      const actions = card.createDiv({ cls: "notient-approvals__actions" });
      const accept = actions.createEl("button", { text: "Accept" });
      accept.addEventListener("click", () => void this.deps.service.acceptEdge(item.id));
      const reject = actions.createEl("button", { text: "Reject" });
      reject.addEventListener("click", () => void this.deps.service.rejectEdge(item.id));
    }
  }
}
