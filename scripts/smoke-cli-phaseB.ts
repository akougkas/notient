import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEmitter } from "../src/cli/output";
import {
  buildSmokeEnv,
  captureNotientEnv,
  stripNotientEnvFromProcess,
  writeVaultEnvFile,
} from "./lib/spawnEnv";

const emitter = makeEmitter({ mode: "ndjson" });
const SMOKE_TIMEOUT_MS = 120_000;

async function main(): Promise<void> {
  // Capture project-root NOTIENT_* before stripping so the snapshot can seed
  // the tmp vault's .notient/.env. See smoke-cli-phaseA.ts for the rationale.
  const envSnapshot = captureNotientEnv();
  stripNotientEnvFromProcess();
  const fixtureRoot = join(process.cwd(), "tests", "fixtures", "sentient-vault");
  const tmpRoot = await mkdtemp(join(tmpdir(), "notient-smoke-B-"));
  try {
    await cp(fixtureRoot, tmpRoot, { recursive: true });
    emitter.emit({ type: "smoke:setup", tmpRoot });

    await runOneShot(["init", tmpRoot]);
    await writeVaultEnvFile(tmpRoot, envSnapshot);
    emitter.emit({ type: "smoke:init_done" });

    const awakenFrames = await runOneShotCollect(["awaken", "--vault", tmpRoot]);
    assertAwakenFrames(awakenFrames);
    emitter.emit({ type: "smoke:awaken_validated" });

    const searchFrames = await runOneShotCollect([
      "search",
      "TDD",
      "--vault",
      tmpRoot,
      "--mode",
      "balanced",
    ]);
    assertSearchFrames(searchFrames);
    emitter.emit({ type: "smoke:search_validated" });

    const vitalsFrames = await runOneShotCollect([
      "vitals",
      "notes/Vault as kernel.md",
      "--vault",
      tmpRoot,
    ]);
    assertVitalsFrames(vitalsFrames);
    emitter.emit({ type: "smoke:vitals_validated" });

    const healthFrames = await runOneShotCollect(["health", "--vault", tmpRoot]);
    assertHealthFrames(healthFrames);
    emitter.emit({ type: "smoke:health_validated" });

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
      ["--env-file=/dev/null", "run", "src/cli/index.ts", ...argv, "--ndjson"],
      { stdio: ["ignore", "pipe", "pipe"], env: buildSmokeEnv() },
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

function assertAwakenFrames(frames: CapturedFrames): void {
  if (frames.exitCode !== 0)
    throw new Error(`awaken exit ${frames.exitCode}: ${frames.stderr.join(" ")}`);
  const events = parseLines(frames);
  const ack = events.find((event) => event.type === "rpc:ack");
  const result = events.find((event) => event.type === "rpc:result");
  if (!ack || !result) throw new Error("awaken missing ack/result");
  if (typeof result.queued !== "number" || result.queued < 5) {
    throw new Error(`awaken queued ${result.queued}; expected at least 5`);
  }
  const indexedEvents = events.filter((event) => event.event === "indexer:note-indexed");
  if (indexedEvents.length === 0) throw new Error("no indexer:note-indexed events");
}

function assertSearchFrames(frames: CapturedFrames): void {
  if (frames.exitCode !== 0)
    throw new Error(`search exit ${frames.exitCode}: ${frames.stderr.join(" ")}`);
  const events = parseLines(frames);
  const result = events.find((event) => event.type === "rpc:result");
  if (!result) throw new Error("search missing result");
  const searchResult = result.result as { hits?: { path: string }[] } | null;
  if (!searchResult || !searchResult.hits || searchResult.hits.length === 0) {
    throw new Error(`search returned no hits: ${JSON.stringify(searchResult)}`);
  }
}

function assertVitalsFrames(frames: CapturedFrames): void {
  if (frames.exitCode !== 0)
    throw new Error(`vitals exit ${frames.exitCode}: ${frames.stderr.join(" ")}`);
  const events = parseLines(frames);
  const snapshot = events.find((event) => event.event === "vitals:snapshot");
  if (!snapshot) throw new Error("missing vitals:snapshot event");
}

function assertHealthFrames(frames: CapturedFrames): void {
  if (frames.exitCode !== 0)
    throw new Error(`health exit ${frames.exitCode}: ${frames.stderr.join(" ")}`);
  const events = parseLines(frames);
  const tick = events.find((event) => event.event === "health:tick");
  if (!tick) throw new Error("missing health:tick event");
}

void main().catch((error) => {
  emitter.emit({
    type: "smoke:fatal",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
