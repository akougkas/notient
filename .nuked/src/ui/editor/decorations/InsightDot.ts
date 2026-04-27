import { WidgetType } from "@codemirror/view";

export interface InsightDotPayload {
  agent: string;
  proposalCount: number;
  rationale: string;
  primaryProposalId: string;
}

export class InsightDot extends WidgetType {
  constructor(
    private readonly payload: InsightDotPayload,
    private readonly onClick: (proposalId: string) => void,
  ) {
    super();
  }

  eq(other: InsightDot): boolean {
    return (
      other.payload.primaryProposalId === this.payload.primaryProposalId &&
      other.payload.proposalCount === this.payload.proposalCount &&
      other.payload.agent === this.payload.agent
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `notient-insight-dot notient-insight-dot--${this.payload.agent}`;
    span.setAttribute(
      "aria-label",
      `${this.payload.proposalCount} ${this.payload.agent} insight(s)`,
    );
    span.setAttribute("title", this.payload.rationale);
    span.dataset.proposalId = this.payload.primaryProposalId;
    span.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onClick(this.payload.primaryProposalId);
    });
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}
