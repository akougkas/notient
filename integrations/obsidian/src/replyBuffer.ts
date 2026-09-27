export class ReplyBuffer {
  private target = "";
  private visible = "";
  private frame: number | null = null;
  private previousTime = 0;
  private previousPaint = 0;
  private allowance = 0;
  private finishing = false;
  private disposed = false;
  private settled: (() => void) | null = null;
  private completion: Promise<void> | null = null;
  private finishDeadline = 0;
  private readonly reducedMotion: MediaQueryList;
  private readonly frameWindow: Window;

  constructor(private readonly paint: (text: string) => void, private readonly document: Document = globalThis.document) {
    this.frameWindow = document.defaultView ?? window;
    this.reducedMotion = this.frameWindow.matchMedia("(prefers-reduced-motion: reduce)");
    document.addEventListener("visibilitychange", this.visibilityChanged);
  }

  push(text: string): void {
    this.target = text;
    if (this.disposed || this.reducedMotion.matches || this.document.visibilityState === "hidden") {
      this.flush();
      return;
    }
    if (this.frame === null) this.frame = this.frameWindow.requestAnimationFrame(this.tick);
  }

  finish(): Promise<void> {
    this.finishing = true;
    this.finishDeadline = this.frameWindow.performance.now() + 900;
    if (this.visible === this.target || this.disposed || this.document.visibilityState === "hidden") {
      this.flush();
      return Promise.resolve();
    }
    this.completion ??= new Promise<void>((resolve) => { this.settled = resolve; });
    if (this.frame === null) this.frame = this.frameWindow.requestAnimationFrame(this.tick);
    return this.completion;
  }

  flush(): void {
    if (this.frame !== null) this.frameWindow.cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.visible !== this.target) {
      this.visible = this.target;
      this.paint(this.visible);
    }
    this.settled?.();
    this.settled = null;
  }

  reset(): void {
    if (this.frame !== null) this.frameWindow.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.settled?.();
    this.settled = null;
    this.target = "";
    this.visible = "";
    this.previousTime = 0;
    this.previousPaint = 0;
    this.allowance = 0;
    this.finishing = false;
    this.completion = null;
    this.finishDeadline = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.document.removeEventListener("visibilitychange", this.visibilityChanged);
    this.flush();
  }

  private readonly visibilityChanged = (): void => {
    if (this.document.visibilityState === "hidden") this.flush();
  };

  private readonly tick = (time: number): void => {
    this.frame = null;
    if (this.document.visibilityState === "hidden" || this.reducedMotion.matches) {
      this.flush();
      return;
    }
    const elapsed = this.previousTime ? Math.min(100, time - this.previousTime) : 1000 / 60;
    this.previousTime = time;
    const pending = this.target.length - this.visible.length;
    const rate = this.finishing
      ? pending * 1000 / Math.max(16, this.finishDeadline - time)
      : Math.min(2400, Math.max(260, pending / 0.9));
    this.allowance += elapsed * rate / 1000;
    if (time - this.previousPaint >= 1000 / 60 - 1 && pending > 0) {
      let end = Math.min(this.target.length, this.visible.length + Math.floor(this.allowance));
      if (end > 0 && /[\uD800-\uDBFF]/.test(this.target[end - 1] ?? "")) end -= 1;
      if (end > this.visible.length) {
        this.allowance -= end - this.visible.length;
        this.visible = this.target.slice(0, end);
        this.paint(this.visible);
        this.previousPaint = time;
      }
    }
    if (this.visible !== this.target) this.frame = this.frameWindow.requestAnimationFrame(this.tick);
    else {
      this.allowance = 0;
      this.previousTime = 0;
      if (this.finishing) {
        this.settled?.();
        this.settled = null;
      }
    }
  };
}
