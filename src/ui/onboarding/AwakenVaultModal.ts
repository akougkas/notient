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

    const header = contentEl.createDiv({ cls: "notient-awaken-header" });
    header.createEl("h2", { text: "Awaken Vault" });
    header.createEl("p", {
      text: `Notient is going to read every note in your vault, embed it, and grow your knowledge graph in real time. ${this.deps.totalNotes()} notes detected.`,
    });

    const counters = contentEl.createDiv({ cls: "notient-awaken-counters" });
    this.deps.onAttachCounters(counters);

    const canvasWrap = contentEl.createDiv({ cls: "notient-awaken-canvas-wrap" });
    const canvas = canvasWrap.createEl("canvas", {
      attr: { width: "720", height: "420" },
    });
    this.deps.onAttachCanvas(canvas);

    const buttons = contentEl.createDiv({ cls: "notient-awaken-buttons" });
    this.startButton = buttons.createEl("button", { text: "Begin" });
    this.stopButton = buttons.createEl("button", { text: "Stop" });
    this.stopButton.disabled = true;
    this.doneButton = buttons.createEl("button", { text: "Enter" });
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
