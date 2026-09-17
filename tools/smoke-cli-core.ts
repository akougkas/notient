/**
 * Core end-to-end CLI smoke harness.
 *
 * Drives the daemon RPC against a fixture-vault copy and whatever
 * OpenAI-compatible substrate the operator configured. The endpoint and the
 * model ids come from `NOTIENT_LLM_BASE_URL`, `NOTIENT_LLM_MODEL`, and
 * `NOTIENT_EMBED_MODEL` (see `tools/lib/spawnEnv.ts`). The harness mkdtemps the
 * fixture, inits, writes one complete canonical product config, awakens, then
 * runs four passes. Each pass connects via `connectClient`, drives current
 * RPCs, asserts the expected outcome, and emits a
 * `smoke:<pass>_validated` line on success.
 *
 * Pass 1: daemon.status reflects the immutable deployment snapshot and the
 *         daemon leaves the strict product config byte-identical.
 * Pass 2: a cold chat emits loop:tool_mode_probed for the configured model.
 * Pass 3: history+undo round-trip via notes.create.
 * Pass 4: vault.list folder enumeration excludes Notient-internal folders.
 *
 * The history pass is the load-bearing model/tool assertion and must run
 * end-to-end. Product configuration is never read or patched through RPC;
 * changing the boot snapshot requires editing the scratch vault and restarting
 * its daemon, just as it does in production.
 */

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RpcResponseFrame, connectClient } from "../src/cli/client";
import { makeEmitter } from "../src/cli/output";
import { parseNotientConfig } from "../src/core/settings/configSchema";
import { resolveSettings } from "../src/core/settings/envOverrides";
import {
  DEFAULT_NOTIENT_CONFIG,
  type NotientConfig,
  type NotientSettings,
} from "../src/core/settings/types";
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
  // Capture project-root NOTIENT_* env before stripping it. The snapshot is
  // written only to the scratch vault's deployment file before daemon boot.
  const envSnapshot = captureNotientEnv();
  stripNotientEnvFromProcess();
  const fixtureRoot = join(process.cwd(), "testing", "fixtures", "sentient-vault");
  const tmpRoot = await mkdtemp(join(tmpdir(), "notient-smoke-core-"));
  try {
    await cp(fixtureRoot, tmpRoot, { recursive: true });
    emitter.emit({ type: "smoke:setup", tmpRoot });

    await runOneShot(["init", tmpRoot]);
    await writeVaultEnvFile(tmpRoot, envSnapshot);
    emitter.emit({ type: "smoke:init_done" });

    const seeded = await preSeedConfig(tmpRoot);
    const expectedSettings = resolveSettings(seeded.config, {
      NOTIENT_LLM_BASE_URL: envSnapshot.baseUrl,
      NOTIENT_EMBED_BASE_URL: envSnapshot.embedBaseUrl,
      NOTIENT_LLM_MODEL: envSnapshot.chatModel,
      NOTIENT_EMBED_MODEL: envSnapshot.embedModel,
      NOTIENT_CONTEXT_TOKENS: envSnapshot.contextTokens,
      NOTIENT_REASONING_SLOTS: envSnapshot.reasoningSlots,
    });
    emitter.emit({ type: "smoke:config_seeded" });

    await runOneShot(["awaken", "--vault", tmpRoot]);
    emitter.emit({ type: "smoke:awaken_done" });

    await runBootConfigPass(tmpRoot, seeded.raw, expectedSettings);

    await runToolModeProbePass(tmpRoot, expectedSettings.primary.reasoningModel);

    await runHistoryUndoPass(tmpRoot);
    emitter.emit({ type: "smoke:history_undo_validated" });

    await runVaultListPass(tmpRoot);

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

interface SeededConfig {
  config: NotientConfig;
  raw: string;
}

/**
 * Write the exact current persisted shape before daemon spawn. The smoke
 * deliberately constructs the whole config from the canonical default rather
 * than accepting partial input or preserving retired keys. Only notes.create
 * differs so the live tool round trip can complete without human interaction.
 */
async function preSeedConfig(vaultPath: string): Promise<SeededConfig> {
  const configPath = join(vaultPath, ".notient", "config.json");
  await mkdir(join(vaultPath, ".notient"), { recursive: true });
  const candidate = structuredClone(DEFAULT_NOTIENT_CONFIG);
  candidate.chat.perTool["notes.create"] = "auto";
  const raw = `${JSON.stringify(candidate, null, 2)}\n`;
  const config = parseNotientConfig(raw, configPath);
  await writeFile(configPath, raw);
  return { config, raw };
}

type ClientHandle = Awaited<ReturnType<typeof connectClient>>;

async function withClient<T>(
  vaultPath: string,
  body: (client: ClientHandle) => Promise<T>,
): Promise<T> {
  const socketPath = resolveSocketPath(vaultPath, currentPlatform());
  const client = await connectClient({ socketPath, vaultPath, spawnTimeoutMs: 60_000 });
  try {
    return await body(client);
  } finally {
    await client.close();
  }
}

async function readResult(stream: AsyncIterable<RpcResponseFrame>): Promise<RpcResponseFrame> {
  for await (const frame of stream) {
    if (frame.type === "result") return frame;
    if (frame.type === "error") {
      throw new Error(`rpc error: ${(frame as { message?: unknown }).message ?? "unknown"}`);
    }
  }
  throw new Error("rpc stream ended without result");
}

async function runBootConfigPass(
  vaultPath: string,
  expectedRaw: string,
  expectedSettings: NotientSettings,
): Promise<void> {
  await withClient(vaultPath, async (client) => {
    const result = await readResult(client.call("daemon.status", {}));
    const detail = result as unknown as {
      sealed?: boolean;
      probe?: {
        configuredModel?: unknown;
        configuredContextTokens?: unknown;
        parallelSlots?: unknown;
      };
    };
    if (detail.sealed !== true) {
      throw new Error("boot config: daemon.status did not report sealed=true");
    }
    if (detail.probe?.configuredModel !== expectedSettings.primary.reasoningModel) {
      throw new Error(
        `boot config: configured model=${String(detail.probe?.configuredModel)} (expected ${expectedSettings.primary.reasoningModel})`,
      );
    }
    if (detail.probe.configuredContextTokens !== expectedSettings.chat.modelContextTokens) {
      throw new Error(
        `boot config: context tokens=${String(detail.probe.configuredContextTokens)} (expected ${expectedSettings.chat.modelContextTokens})`,
      );
    }
    if (detail.probe.parallelSlots !== expectedSettings.chat.reasoningSlots) {
      throw new Error(
        `boot config: reasoning slots=${String(detail.probe.parallelSlots)} (expected ${expectedSettings.chat.reasoningSlots})`,
      );
    }
  });

  const configPath = join(vaultPath, ".notient", "config.json");
  const observedRaw = await readFile(configPath, "utf-8");
  if (observedRaw !== expectedRaw) {
    throw new Error("boot config: daemon rewrote the persisted product config");
  }
  const observed = parseNotientConfig(observedRaw, configPath);
  if (observed.chat.perTool["notes.create"] !== "auto") {
    throw new Error("boot config: seeded notes.create policy was not preserved");
  }
  emitter.emit({
    type: "smoke:boot_config_validated",
    model: expectedSettings.primary.reasoningModel,
    contextTokens: expectedSettings.chat.modelContextTokens,
    reasoningSlots: expectedSettings.chat.reasoningSlots,
  });
}

async function startConversation(client: ClientHandle, topic: string): Promise<string> {
  const result = await readResult(client.call("chat.start", { topic }));
  const detail = result as unknown as { conversation?: { id?: string } };
  if (typeof detail.conversation?.id !== "string") {
    throw new Error(`chat.start: missing conversation.id (topic=${topic})`);
  }
  return detail.conversation.id;
}

interface DrainedTurn {
  reachedTurnComplete: boolean;
  toolCalls: string[];
  events: Array<{ event: string; payload: Record<string, unknown> }>;
  failure?: string;
}

interface ChatEventFrame {
  event: string;
  [key: string]: unknown;
}

function recordChatEvent(summary: DrainedTurn, detail: ChatEventFrame): void {
  summary.events.push({ event: detail.event, payload: detail });
  switch (detail.event) {
    case "loop:tool_call_started":
      if (typeof detail.tool === "string") summary.toolCalls.push(detail.tool);
      break;
    case "turn:complete":
      summary.reachedTurnComplete = true;
      break;
    case "loop:error":
      summary.failure ??= typeof detail.message === "string" ? detail.message : "loop:error";
      break;
    case "turn:aborted":
      summary.failure ??= typeof detail.reason === "string" ? detail.reason : "turn:aborted";
      break;
  }
}

async function drainChatSend(
  client: ClientHandle,
  conversationId: string,
  userMessage: string,
): Promise<DrainedTurn> {
  const summary: DrainedTurn = {
    reachedTurnComplete: false,
    toolCalls: [],
    events: [],
  };
  for await (const frame of client.call("chat.send", { conversationId, userMessage })) {
    if (frame.type === "event") {
      recordChatEvent(summary, frame as unknown as ChatEventFrame);
      continue;
    }
    if (frame.type === "result") return summary;
    if (frame.type === "error") {
      const message = (frame as { message?: unknown }).message;
      summary.failure = typeof message === "string" ? message : "rpc error";
      return summary;
    }
  }
  return summary;
}

interface HistoryRowLike {
  id: string;
  kind: string;
  target: string;
}

function assertNotesCreateTurn(turn: DrainedTurn): void {
  if (turn.failure !== undefined) {
    throw new Error(`history+undo: chat.send failed (${turn.failure})`);
  }
  if (!turn.reachedTurnComplete) {
    throw new Error("history+undo: chat.send did not reach turn:complete");
  }
  if (!turn.toolCalls.includes("notes.create")) {
    throw new Error(
      `history+undo: notes.create was not invoked (tools=${turn.toolCalls.join(",") || "none"})`,
    );
  }
}

function requireCreatedHistoryEntry(entries: HistoryRowLike[]): HistoryRowLike {
  const top = entries[0];
  if (top === undefined) {
    throw new Error("history+undo: notes.history returned no entries after notes.create");
  }
  if (top.kind !== "notes.create") {
    throw new Error(`history+undo: latest entry kind=${top.kind} (expected notes.create)`);
  }
  if (!top.target.includes("smoke-history")) {
    throw new Error(`history+undo: latest entry target=${top.target} (expected smoke-history*)`);
  }
  return top;
}

function assertUndoResult(frame: RpcResponseFrame): void {
  const detail = frame as unknown as {
    ok?: boolean;
    reversed?: HistoryRowLike;
  };
  if (detail.ok !== true) {
    throw new Error("history+undo: notes.undo failed");
  }
  if (detail.reversed?.kind !== "notes.create") {
    throw new Error(`history+undo: reversed.kind=${detail.reversed?.kind} (expected notes.create)`);
  }
}

function assertHistoryEntryRemoved(entries: HistoryRowLike[], removed: HistoryRowLike): void {
  const stillThere = entries.some(
    (entry) =>
      entry.id === removed.id || (entry.kind === "notes.create" && entry.target === removed.target),
  );
  if (stillThere) {
    throw new Error("history+undo: undone notes.create row still appears in notes.history");
  }
}

async function fetchHistory(client: ClientHandle, limit: number): Promise<HistoryRowLike[]> {
  const result = await readResult(client.call("notes.history", { limit }));
  const detail = result as unknown as { entries?: HistoryRowLike[] };
  if (!Array.isArray(detail.entries)) {
    throw new Error("notes.history: result missing entries[]");
  }
  return detail.entries;
}

async function runHistoryUndoPass(vaultPath: string): Promise<void> {
  await withClient(vaultPath, async (client) => {
    const conversationId = await startConversation(client, "smoke history");
    const turn = await drainChatSend(
      client,
      conversationId,
      "Use the notes.create tool to create a file at smoke-history-test.md whose body is exactly the word hi. Do not call any other tool.",
    );
    assertNotesCreateTurn(turn);

    const created = requireCreatedHistoryEntry(await fetchHistory(client, 5));
    const undoFrame = await readResult(client.call("notes.undo", { historyId: created.id }));
    assertUndoResult(undoFrame);

    assertHistoryEntryRemoved(await fetchHistory(client, 5), created);
  });
}

async function runVaultListPass(vaultPath: string): Promise<void> {
  try {
    await withClient(vaultPath, async (client) => {
      const result = await readResult(client.call("vault.list", { folder: "" }));
      const detail = result as unknown as { paths?: string[] };
      const paths = Array.isArray(detail.paths) ? detail.paths : [];

      const forbiddenPrefixes = [".notient", "Notient/conversations", "Notient/proposals"];
      for (const path of paths) {
        for (const forbidden of forbiddenPrefixes) {
          if (path === `${forbidden}/` || path === forbidden || path.startsWith(`${forbidden}/`)) {
            throw new Error(`vault.list: root listing contains forbidden path ${path}`);
          }
        }
      }

      // The fixture seeds a top-level `notes/` folder under sentient-vault.
      // Assert the folder enumeration surfaces it so the smoke proves the
      // listing actually saw the seeded vault content.
      const hasNotesFolder = paths.some((path) => path === "notes/" || path.startsWith("notes/"));
      if (!hasNotesFolder) {
        throw new Error(
          `vault.list: expected fixture 'notes/' folder in root listing (got ${paths.length} paths)`,
        );
      }
    });
    emitter.emit({ type: "smoke:vault_list_validated" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitter.emit({ type: "smoke:vault_list_failed", message });
    throw error;
  }
}

async function runToolModeProbePass(vaultPath: string, expectedModel: string): Promise<void> {
  await withClient(vaultPath, async (client) => {
    // This is the daemon's first chat turn. Tool capability is a process-local
    // cold-start probe, never a persisted setting or a runtime config patch.
    const probe = await detectProbedEvent(client);
    if (!probe.observed) {
      throw new Error("tool_mode_probed: cold chat did not emit loop:tool_mode_probed");
    }
    if (probe.model !== expectedModel) {
      throw new Error(
        `tool_mode_probed: model=${probe.model ?? "unknown"} (expected ${expectedModel})`,
      );
    }
    if (probe.mode !== "native") {
      throw new Error(
        `tool_mode_probed: expected mode=native, got mode=${probe.mode ?? "unknown"}`,
      );
    }
    if (probe.attempts !== 1 && probe.attempts !== 2) {
      throw new Error(
        `tool_mode_probed: expected attempts=1 or 2, got attempts=${probe.attempts ?? "unknown"}`,
      );
    }
    emitter.emit({
      type: "smoke:tool_mode_probe_validated",
      model: probe.model,
      mode: probe.mode,
      attempts: probe.attempts,
    });
  });
}

interface ProbeObservation {
  observed: boolean;
  model?: string;
  mode?: string;
  attempts?: number;
}

async function detectProbedEvent(client: ClientHandle): Promise<ProbeObservation> {
  const conversationId = await startConversation(client, "smoke probe");
  const turn = await drainChatSend(
    client,
    conversationId,
    "Reply with the single word ok and stop.",
  );
  if (turn.failure !== undefined) {
    throw new Error(`tool_mode_probed: chat.send failed (${turn.failure})`);
  }
  if (!turn.reachedTurnComplete) {
    throw new Error("tool_mode_probed: chat.send did not reach turn:complete");
  }
  for (const entry of turn.events) {
    if (entry.event !== "loop:tool_mode_probed") continue;
    const model = entry.payload.model;
    const mode = entry.payload.mode;
    const attempts = entry.payload.attempts;
    return {
      observed: true,
      model: typeof model === "string" ? model : undefined,
      mode: typeof mode === "string" ? mode : undefined,
      attempts: typeof attempts === "number" ? attempts : undefined,
    };
  }
  return { observed: false };
}

void main().catch((error) => {
  emitter.emit({
    type: "smoke:fatal",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
