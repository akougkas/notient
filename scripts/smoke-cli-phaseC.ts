import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEmitter } from "../src/cli/output";

const emitter = makeEmitter({ mode: "ndjson" });
const SMOKE_TIMEOUT_MS = 240_000;

async function main(): Promise<void> {
  const fixtureRoot = join(process.cwd(), "tests", "fixtures", "sentient-vault");
  const tmpRoot = await mkdtemp(join(tmpdir(), "notient-smoke-C-"));
  try {
    await cp(fixtureRoot, tmpRoot, { recursive: true });
    emitter.emit({ type: "smoke:setup", tmpRoot });

    await runOneShot(["init", tmpRoot]);
    emitter.emit({ type: "smoke:init_done" });

    await runOneShot(["awaken", "--vault", tmpRoot]);
    emitter.emit({ type: "smoke:awaken_done" });

    const chatFrames = await runOneShotCollect([
      "chat",
      "use the vault.search_notes tool to find any notes that mention TDD",
      "--vault",
      tmpRoot,
      "--approve",
      "auto",
    ]);
    assertChatFrames(chatFrames);
    emitter.emit({ type: "smoke:chat_validated" });

    await writeFile(join(tmpRoot, "tiny.png"), Buffer.from(makeTinyPng()));
    const visionFrames = await runOneShotCollect([
      "chat",
      "describe @tiny.png briefly",
      "--vault",
      tmpRoot,
      "--approve",
      "auto",
    ]);
    assertVisionUnavailable(visionFrames);
    emitter.emit({ type: "smoke:vision_validated" });

    await runOneShot(["daemon", "stop", "--vault", tmpRoot]);
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
      ["run", "src/cli/index.ts", ...argv, "--ndjson"],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
    );
    const stdoutBuffer: string[] = [];
    const stderrBuffer: string[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`smoke timeout after ${SMOKE_TIMEOUT_MS}ms running ${argv.join(" ")}`));
    }, SMOKE_TIMEOUT_MS);
    child.stdout.on("data", (data: Buffer) => {
      stdoutBuffer.push(data.toString("utf-8"));
    });
    child.stderr.on("data", (data: Buffer) => {
      stderrBuffer.push(data.toString("utf-8"));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode: exitCode ?? -1,
        stdout: stdoutBuffer.join("").split("\n").filter(Boolean),
        stderr: stderrBuffer.join("").split("\n").filter(Boolean),
      });
    });
  });
}

function parseLines(frames: CapturedFrames): Record<string, unknown>[] {
  return frames.stdout.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assertChatFrames(frames: CapturedFrames): void {
  if (frames.exitCode !== 0) {
    throw new Error(`chat exit ${frames.exitCode}: ${frames.stderr.join(" ")}`);
  }
  const events = parseLines(frames);
  const hasToolStart = events.some(
    (event) =>
      event.event === "loop:tool_call_started" &&
      typeof event.tool === "string" &&
      (event.tool as string).startsWith("vault."),
  );
  if (!hasToolStart) {
    throw new Error("chat: no loop:tool_call_started for a vault.* tool");
  }
  const hasDelta = events.some((event) => event.event === "loop:assistant_delta");
  if (!hasDelta) throw new Error("chat: no loop:assistant_delta frames");
  const hasComplete = events.some((event) => event.event === "turn:complete");
  if (!hasComplete) throw new Error("chat: no turn:complete frame");
}

function assertVisionUnavailable(frames: CapturedFrames): void {
  if (frames.exitCode === 0) {
    throw new Error("vision smoke: expected non-zero exit when vision is unavailable");
  }
  const events = parseLines(frames);
  const errorFrame = events.find(
    (event) => event.type === "rpc:error" || event.type === "error",
  );
  if (!errorFrame) throw new Error("vision smoke: no error frame");
  const message = (errorFrame as { message?: string }).message ?? "";
  if (!message.includes("VISION_UNAVAILABLE")) {
    throw new Error(`vision smoke: error message did not mention VISION_UNAVAILABLE: ${message}`);
  }
}

function makeTinyPng(): Uint8Array {
  // 1x1 transparent PNG. Same bytes as the visionProbe seed.
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
  return new Uint8Array(Buffer.from(base64, "base64"));
}

void main().catch((error) => {
  emitter.emit({
    type: "smoke:fatal",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
