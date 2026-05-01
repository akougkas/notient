import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectClient } from "../src/cli/client";
import { makeEmitter } from "../src/cli/output";
import { currentPlatform, resolveSocketPath } from "../src/daemon/socket";
import {
  buildSmokeEnv,
  captureNotientEnv,
  stripNotientEnvFromProcess,
  writeVaultEnvFile,
} from "./lib/spawnEnv";

const emitter = makeEmitter({ mode: "ndjson" });
const SMOKE_TIMEOUT_MS = 240_000;

async function main(): Promise<void> {
  // Capture the substrate identity from the project-root .env BEFORE
  // stripping; the snapshot becomes the tmp vault's .notient/.env, and the
  // chat model identifier drives both the tool-mode pin and any
  // model-specific assertion later in the suite.
  const envSnapshot = captureNotientEnv();
  stripNotientEnvFromProcess();
  const fixtureRoot = join(process.cwd(), "tests", "fixtures", "sentient-vault");
  const tmpRoot = await mkdtemp(join(tmpdir(), "notient-smoke-C-"));
  try {
    await cp(fixtureRoot, tmpRoot, { recursive: true });
    emitter.emit({ type: "smoke:setup", tmpRoot });

    await runOneShot(["init", tmpRoot]);
    await writeVaultEnvFile(tmpRoot, envSnapshot);
    emitter.emit({ type: "smoke:init_done" });

    // Pin the tool mode for the primary model so chat.send skips the
    // auto-probe (which the substrate flakes on for some models). Phase C's
    // smoke goal is to assert the wire bridge round-trips a real vault.*
    // tool call; the probe robustness is a separate substrate concern.
    await pinToolMode(tmpRoot, envSnapshot.chatModel, "native");
    emitter.emit({ type: "smoke:tool_mode_pinned", model: envSnapshot.chatModel });

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

    await runMultiTurnPass(tmpRoot);
    emitter.emit({ type: "smoke:multiturn_validated" });

    await writeFile(join(tmpRoot, "tiny.png"), Buffer.from(makeTinyPng()));
    const visionFrames = await runOneShotCollect([
      "chat",
      "describe @tiny.png briefly",
      "--vault",
      tmpRoot,
      "--approve",
      "auto",
    ]);
    assertVisionPath(visionFrames);
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

function assertVisionPath(frames: CapturedFrames): void {
  // Two valid outcomes for a Phase C image attachment turn:
  //   (a) the primary model is multi-modal and accepts the @tiny.png
  //       attachment; the chat completes (turn:complete or rpc:result).
  //   (b) the primary lacks vision and chat.vision is unconfigured; the
  //       handler refuses with VISION_UNAVAILABLE in an rpc:error frame.
  // The smoke asserts one of these holds. The CLI prints the rpc:error
  // frame and exits 0, so we drive on frame contents rather than exit code.
  const events = parseLines(frames);
  const errorFrame = events.find((event) => event.type === "rpc:error");
  if (errorFrame) {
    const message = (errorFrame as { message?: string }).message ?? "";
    if (message.includes("VISION_UNAVAILABLE")) return;
    throw new Error(
      `vision smoke: rpc:error frame did not mention VISION_UNAVAILABLE: ${message}`,
    );
  }
  const hasComplete = events.some(
    (event) =>
      event.event === "turn:complete" ||
      (event.type === "rpc:result" && event.ok === true),
  );
  if (hasComplete) return;
  const summary = events
    .map((event) => `${event.type ?? "?"}:${event.event ?? ""}`)
    .join(" | ");
  throw new Error(
    `vision smoke: neither VISION_UNAVAILABLE error nor turn:complete observed (frames: ${summary})`,
  );
}

async function runMultiTurnPass(vaultPath: string): Promise<void> {
  // Drive two consecutive chat.send calls against a single conversationId
  // through the daemon RPC. This guards the regression where ChatService
  // blocked turn:complete on the post-turn summary refresh and the TUI's
  // busy flag stayed true through the second prompt's keystrokes.
  const socketPath = resolveSocketPath(vaultPath, currentPlatform());
  const client = await connectClient({ socketPath, vaultPath, spawnTimeoutMs: 60_000 });
  try {
    const conversationId = await startMultiTurnConversation(client);
    const turnOne = await drainChatSend(
      client,
      conversationId,
      "use vault.search_notes to find any notes that mention TDD",
    );
    if (!turnOne.reachedTurnComplete) {
      throw new Error(`multiturn: turn 1 did not reach turn:complete (${turnOne.failure})`);
    }
    const turnTwo = await drainChatSend(
      client,
      conversationId,
      "name the first hit's path",
    );
    if (!turnTwo.reachedTurnComplete) {
      throw new Error(`multiturn: turn 2 did not reach turn:complete (${turnTwo.failure})`);
    }
    if (turnTwo.assistantChars === 0) {
      throw new Error("multiturn: turn 2 produced no assistant content");
    }
  } finally {
    await client.close();
  }
}

async function startMultiTurnConversation(
  client: Awaited<ReturnType<typeof connectClient>>,
): Promise<string> {
  for await (const frame of client.call("chat.start", { topic: "smoke multi-turn" })) {
    if (frame.type === "result") {
      const detail = frame as unknown as { conversation?: { id?: string } };
      if (typeof detail.conversation?.id === "string") return detail.conversation.id;
      throw new Error("multiturn: chat.start missing conversation.id");
    }
    if (frame.type === "error") {
      throw new Error(
        `multiturn: chat.start failed (${(frame as { message?: string }).message ?? "unknown"})`,
      );
    }
  }
  throw new Error("multiturn: chat.start stream ended without result");
}

interface ChatTurnSummary {
  reachedTurnComplete: boolean;
  assistantChars: number;
  failure?: string;
}

async function drainChatSend(
  client: Awaited<ReturnType<typeof connectClient>>,
  conversationId: string,
  userMessage: string,
): Promise<ChatTurnSummary> {
  const summary: ChatTurnSummary = { reachedTurnComplete: false, assistantChars: 0 };
  for await (const frame of client.call("chat.send", { conversationId, userMessage })) {
    if (frame.type === "event") {
      const detail = frame as unknown as { event: string; [key: string]: unknown };
      if (detail.event === "turn:complete") summary.reachedTurnComplete = true;
      if (detail.event === "loop:assistant_delta") {
        const delta = detail.contentDelta;
        if (typeof delta === "string") summary.assistantChars += delta.length;
      }
      if (detail.event === "loop:error" && summary.failure === undefined) {
        const message = (detail as { message?: unknown }).message;
        summary.failure = typeof message === "string" ? message : "loop:error";
      }
      if (detail.event === "turn:aborted" && summary.failure === undefined) {
        const reason = (detail as { reason?: unknown }).reason;
        summary.failure = typeof reason === "string" ? reason : "turn:aborted";
      }
      continue;
    }
    if (frame.type === "result") return summary;
    if (frame.type === "error") {
      const message = (frame as { message?: unknown }).message;
      summary.failure =
        typeof message === "string" ? message : "rpc error without message";
      return summary;
    }
  }
  return summary;
}

async function pinToolMode(
  vaultPath: string,
  model: string,
  mode: "native" | "json-fallback" | "disabled",
): Promise<void> {
  const configPath = join(vaultPath, ".notient", "config.json");
  await mkdir(join(vaultPath, ".notient"), { recursive: true });
  const raw = await readFile(configPath, "utf-8").catch(() => "{}");
  const config = JSON.parse(raw) as Record<string, unknown>;
  const chat = (config.chat as Record<string, unknown> | undefined) ?? {};
  const toolModeByModel =
    (chat.toolModeByModel as Record<string, string> | undefined) ?? {};
  toolModeByModel[model] = mode;
  config.chat = { ...chat, toolModeByModel };
  await writeFile(configPath, JSON.stringify(config, null, 2));
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
