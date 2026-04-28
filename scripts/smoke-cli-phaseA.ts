import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEmitter } from "../src/cli/output";
import { buildSmokeEnv, stripNotientEnvFromProcess } from "./lib/spawnEnv";

const emitter = makeEmitter({ mode: "ndjson" });

async function main(): Promise<void> {
  stripNotientEnvFromProcess();
  const fixtureRoot = join(process.cwd(), "tests", "fixtures", "sentient-vault");
  const tmpRoot = await mkdtemp(join(tmpdir(), "notient-smoke-A-"));
  try {
    await cp(fixtureRoot, tmpRoot, { recursive: true });
    emitter.emit({ type: "smoke:setup", tmpRoot });

    await runOneShot(["init", tmpRoot]);
    emitter.emit({ type: "smoke:init_done" });

    const statusFrames = await runOneShotCollect(["daemon", "status", "--vault", tmpRoot]);
    assertStatusFrames(statusFrames, tmpRoot);
    emitter.emit({ type: "smoke:status_validated" });

    await runOneShot(["daemon", "stop", "--vault", tmpRoot]);
    emitter.emit({ type: "smoke:stop_done" });

    const socketPath = join(tmpRoot, ".notient", "notient.sock");
    let socketExists = true;
    try {
      await stat(socketPath);
    } catch {
      socketExists = false;
    }
    if (socketExists) {
      throw new Error(`socket survived shutdown: ${socketPath}`);
    }
    emitter.emit({ type: "smoke:complete" });
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

interface CapturedFrames {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

async function runOneShot(argv: string[]): Promise<void> {
  const captured = await runOneShotCollect(argv);
  if (captured.exitCode !== 0) {
    emitter.emit({
      type: "smoke:error",
      argv,
      exitCode: captured.exitCode,
      stderr: captured.stderr.join("\n"),
    });
    throw new Error(`Command failed: notient ${argv.join(" ")}`);
  }
}

async function runOneShotCollect(argv: string[]): Promise<CapturedFrames> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--env-file=/dev/null", "run", "src/cli/index.ts", ...argv, "--ndjson"],
      { stdio: ["ignore", "pipe", "pipe"], env: buildSmokeEnv() },
    );
    const stdoutBuffer: string[] = [];
    const stderrBuffer: string[] = [];
    child.stdout.on("data", (data: Buffer) => {
      stdoutBuffer.push(data.toString("utf-8"));
    });
    child.stderr.on("data", (data: Buffer) => {
      stderrBuffer.push(data.toString("utf-8"));
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? -1,
        stdout: stdoutBuffer.join("").split("\n").filter(Boolean),
        stderr: stderrBuffer.join("").split("\n").filter(Boolean),
      });
    });
  });
}

function assertStatusFrames(frames: CapturedFrames, tmpRoot: string): void {
  if (frames.exitCode !== 0) {
    throw new Error(`status exit ${frames.exitCode}: ${frames.stderr.join(" ")}`);
  }
  const parsed = frames.stdout.map((line) => JSON.parse(line) as Record<string, unknown>);
  const ack = parsed.find((event) => event.type === "rpc:ack");
  const result = parsed.find((event) => event.type === "rpc:result");
  if (!ack || !result) {
    throw new Error(`status missing ack/result: ${JSON.stringify(parsed)}`);
  }
  if (typeof result.id !== "string") throw new Error("result envelope missing id");
  if (typeof result.pid !== "number") throw new Error("result envelope missing pid");
  if (result.vault !== tmpRoot) throw new Error(`result.vault mismatch: ${String(result.vault)}`);
  if (result.sealed !== true) throw new Error("kernel not sealed");
}

void main().catch((error) => {
  emitter.emit({
    type: "smoke:fatal",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
