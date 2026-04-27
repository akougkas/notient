import { type App, Modal } from "obsidian";

export interface AwakenVaultModalDeps {
  start: () => Promise<void>;
  stop: () => void;
  isRunning: () => boolean;
  totalNotes: () => number;
  onAttachCanvas: (canvas: HTMLCanvasElement) => void;
  onAttachCounters: (el: HTMLElement) => void;
}

export class AwakenVaultModal extends Modal {
  private startButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private doneButton!: HTMLButtonElement;

  constructor(
    app: App,
    private readonly deps: AwakenVaultModalDeps,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("notient-awaken-modal");
    contentEl.addClass("notient-modal");

    const header = contentEl.createDiv({ cls: "notient-awaken-header" });
    header.createEl("h2", { text: "Awaken Vault" });
    header.createEl("p", {
      text: `Notient is going to read every note in your vault, embed it, and grow your knowledge graph in real time. ${this.deps.totalNotes()} notes detected.`,
    });

    const counters = contentEl.createDiv({
      cls: "notient-awaken-counters notient-modal__counters",
    });
    this.deps.onAttachCounters(counters);

    const canvasWrap = contentEl.createDiv({
      cls: "notient-awaken-canvas-wrap notient-modal__canvas",
    });
    const canvas = canvasWrap.createEl("canvas", {
      attr: { width: "720", height: "420" },
    });
    this.deps.onAttachCanvas(canvas);

    const buttons = contentEl.createDiv({ cls: "notient-awaken-buttons notient-modal__buttons" });
    this.startButton = buttons.createEl("button", { cls: "notient-button", text: "Begin" });
    this.startButton.dataset.emphasis = "primary";
    this.stopButton = buttons.createEl("button", { cls: "notient-button", text: "Stop" });
    this.stopButton.dataset.emphasis = "ghost";
    this.stopButton.dataset.tone = "danger";
    this.stopButton.disabled = true;
    this.doneButton = buttons.createEl("button", { cls: "notient-button", text: "Enter" });
    this.doneButton.disabled = true;

    this.startButton.addEventListener("click", () => {
      void this.run();
    });
    this.stopButton.addEventListener("click", () => {
      this.deps.stop();
      this.stopButton.disabled = true;
      this.startButton.disabled = false;
      this.doneButton.disabled = false;
    });
    this.doneButton.addEventListener("click", () => this.close());
  }

  private async run(): Promise<void> {
    this.startButton.disabled = true;
    this.stopButton.disabled = false;
    try {
      await this.deps.start();
    } finally {
      this.stopButton.disabled = true;
      this.startButton.disabled = false;
      this.doneButton.disabled = false;
    }
  }

  onClose(): void {
    this.deps.stop();
    this.contentEl.empty();
  }
}
