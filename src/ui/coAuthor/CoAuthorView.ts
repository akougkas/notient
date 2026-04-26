import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { EventBus } from "../../core/events/eventBus";
import { CoAuthorPanelModel, renderCoAuthorPanel } from "./coAuthorRender";

export const VIEW_TYPE_NOTIENT_CO_AUTHOR = "notient-co-author";

export interface CoAuthorViewDeps {
  bus: EventBus;
  onCancel: () => void;
}

export class CoAuthorView extends ItemView {
  private model = new CoAuthorPanelModel();
  private offs: Array<() => void> = [];

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: CoAuthorViewDeps,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_NOTIENT_CO_AUTHOR;
  }

  getDisplayText(): string {
    return "Notient Co-author";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    const draw = () =>
      renderCoAuthorPanel(root, this.model, {
        onCancel: () => this.deps.onCancel(),
      });
    draw();
    this.offs.push(this.model.subscribe(draw));
    this.offs.push(
      this.deps.bus.on("coAuthor:section", (e) => this.model.appendSection(e.section, e.delta)),
    );
    this.offs.push(this.deps.bus.on("coAuthor:done", (e) => this.model.finish(e.ok, e.error)));
    this.offs.push(this.deps.bus.on("coAuthor:cancelled", () => this.model.cancel()));
    this.offs.push(
      this.deps.bus.on("active-leaf-change", (e) => {
        if (e.notePath) this.model.startStream(e.notePath);
        else this.model.reset();
      }),
    );
  }

  async onClose(): Promise<void> {
    for (const off of this.offs) off();
    this.offs = [];
  }
}
