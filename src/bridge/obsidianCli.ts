import { spawn } from "node:child_process";

export interface ExecOptions {
  command: string;
  args: string[];
  timeoutMs: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function execObsidian(options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let finished = false;

    const timeoutHandle = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGKILL");
      resolve({
        ok: false,
        exitCode: -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        error: `timeout after ${options.timeoutMs}ms`,
      });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      resolve({
        ok: false,
        exitCode: -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        error: error.message,
      });
    });

    child.on("close", (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      const code = exitCode ?? -1;
      resolve({
        ok: code === 0,
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      });
    });
  });
}

/**
 * Convenience wrapper for the eventual `obsidian` CLI binary. Phase B uses
 * this only via `obsidianStatusProbe()` (in the daemon) and the search
 * handler's quick-mode path. The binary may not exist on the user's PATH;
 * callers must handle ok=false gracefully.
 */
export function obsidianStatusProbe(timeoutMs = 2000): Promise<ExecResult> {
  return execObsidian({
    command: "obsidian",
    args: ["status", "--json"],
    timeoutMs,
  });
}
