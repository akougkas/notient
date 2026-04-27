import { rm, writeFile } from "node:fs/promises";

export interface IdleExitTimerOptions {
  idleMs: number;
  onIdleExit: () => void;
}

export class IdleExitTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: IdleExitTimerOptions) {}

  start(): void {
    this.markActive();
  }

  markActive(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.options.onIdleExit(), this.options.idleMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export interface PidRecord {
  pid: number;
  instanceId: string;
  socketPath: string;
  startedAt: number;
  version: string;
}

export async function writePidFile(path: string, record: PidRecord): Promise<void> {
  await writeFile(path, JSON.stringify(record), "utf-8");
}

export async function removePidFile(path: string): Promise<void> {
  await rm(path, { force: true });
}
