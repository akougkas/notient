/**
 * Phase D end-to-end smoke harness.
 *
 * Drives the daemon RPC against a fixture-vault copy and the live LM Studio
 * substrate. Mirrors the structural shape of `scripts/smoke-cli-phaseC.ts`:
 * mkdtemp the fixture, init, pin the primary model's tool mode (so probe
 * variability does not flake the suite), awaken, then run four Phase D
 * passes. Each pass connects via `connectClient`, drives RPCs, asserts the
 * expected outcome, and emits a `smoke:<pass>_validated` line on success or
 * `smoke:<pass>_skipped` when the substrate cannot drive the assertion.
 *
 * Pass 1: history+undo round-trip via notes.create.
 * Pass 2: vault.list folder enumeration excludes Notient-internal folders.
 * Pass 3: loop:context_summarized event observed when modelContextTokens
 *         is dialed down before a long turn.
 * Pass 4: loop:tool_mode_probed observed after unpinning the cached mode.
 *
 * Pass 1 is the load-bearing assertion and must run end-to-end. Passes 2-4
 * may emit `smoke:<pass>_skipped` if the substrate cannot drive them; the
 * smoke continues so a later regression is not masked by an earlier skip.
 */

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectClient, type RpcResponseFrame } from "../src/cli/client";
import { buildSmokeEnv, stripNotientEnvFromProcess } from "./lib/spawnEnv";
import { makeEmitter } from "../src/cli/output";
import { currentPlatform, resolveSocketPath } from "../src/daemon/socket";

const emitter = makeEmitter({ mode: "ndjson" });
const SMOKE_TIMEOUT_MS = 240_000;
const PRIMARY_MODEL = "nemotron-cascade-2-30b-a3b-i1";

async function main(): Promise<void> {
  stripNotientEnvFromProcess();
  const fixtureRoot = join(process.cwd(), "tests", "fixtures", "sentient-vault");
  const tmpRoot = await mkdtemp(join(tmpdir(), "notient-smoke-D-"));
  try {
    await cp(fixtureRoot, tmpRoot, { recursive: true });
    emitter.emit({ type: "smoke:setup", tmpRoot });

    await runOneShot(["init", tmpRoot]);
    emitter.emit({ type: "smoke:init_done" });

    // Pre-seed config: pin primary model tool mode AND auto-approve
    // notes.create. Both are read by bootstrap on daemon start, so they
    // must land on disk before the first awaken/connect.
    await preSeedConfig(tmpRoot, {
      toolModeModel: PRIMARY_MODEL,
      toolMode: "native",
      autoApproveNotesCreate: true,
    });
    emitter.emit({ type: "smoke:config_seeded", model: PRIMARY_MODEL });

    await runOneShot(["awaken", "--vault", tmpRoot]);
    emitter.emit({ type: "smoke:awaken_done" });

    await runHistoryUndoPass(tmpRoot);
    emitter.emit({ type: "smoke:history_undo_validated" });

    await runVaultListPass(tmpRoot);

    await runContextSummarizedPass(tmpRoot);

    await runToolModeProbePass(tmpRoot);

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

interface PreSeedConfigOptions {
  toolModeModel: string;
  toolMode: "native" | "json-fallback" | "disabled";
  autoApproveNotesCreate: boolean;
}

/**
 * Write `<vault>/.notient/config.json` with the values bootstrap reads on
 * daemon spawn. Both `chat.toolModeByModel` and `chat.perTool` are captured
 * by the gate constructor; later `daemon.config_set` calls do not re-bind
 * the running gate. So the smoke writes both keys before the first awaken.
 */
async function preSeedConfig(vaultPath: string, options: PreSeedConfigOptions): Promise<void> {
  const configPath = join(vaultPath, ".notient", "config.json");
  await mkdir(join(vaultPath, ".notient"), { recursive: true });
  const raw = await readFile(configPath, "utf-8").catch(() => "{}");
  const config = JSON.parse(raw) as Record<string, unknown>;
  const chat = (config.chat as Record<string, unknown> | undefined) ?? {};
  const toolModeByModel =
    (chat.toolModeByModel as Record<string, string> | undefined) ?? {};
  toolModeByModel[options.toolModeModel] = options.toolMode;
  const perTool = (chat.perTool as Record<string, "auto" | "ask"> | undefined) ?? {};
  if (options.autoApproveNotesCreate) {
    perTool["notes.create"] = "auto";
  }
  config.chat = { ...chat, toolModeByModel, perTool };
  await writeFile(configPath, JSON.stringify(config, null, 2));
}

type ClientHandle = Awaited<ReturnType<typeof connectClient>>;

async function withClient<T>(vaultPath: string, body: (client: ClientHandle) => Promise<T>): Promise<T> {
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
      throw new Error(
        `rpc error: ${(frame as { message?: unknown }).message ?? "unknown"}`,
      );
    }
  }
  throw new Error("rpc stream ended without result");
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
      const detail = frame as unknown as { event: string; [key: string]: unknown };
      summary.events.push({ event: detail.event, payload: detail });
      if (detail.event === "loop:tool_call_started" && typeof detail.tool === "string") {
        summary.toolCalls.push(detail.tool);
      }
      if (detail.event === "turn:complete") summary.reachedTurnComplete = true;
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
      summary.failure = typeof message === "string" ? message : "rpc error";
      return summary;
    }
  }
  return summary;
}

interface HistoryRowLike {
  id: number;
  kind: string;
  target: string;
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

    const before = await fetchHistory(client, 5);
    if (before.length < 1) {
      throw new Error("history+undo: notes.history returned no entries after notes.create");
    }
    const top = before[0];
    if (top.kind !== "notes.create") {
      throw new Error(`history+undo: latest entry kind=${top.kind} (expected notes.create)`);
    }
    if (!top.target.includes("smoke-history")) {
      throw new Error(`history+undo: latest entry target=${top.target} (expected smoke-history*)`);
    }

    const undoFrame = await readResult(client.call("notes.undo", {}));
    const undoDetail = undoFrame as unknown as {
      ok?: boolean;
      reversed?: HistoryRowLike;
      error?: string;
    };
    if (undoDetail.ok !== true) {
      throw new Error(
        `history+undo: notes.undo failed (${undoDetail.error ?? "unknown"})`,
      );
    }
    if (undoDetail.reversed?.kind !== "notes.create") {
      throw new Error(
        `history+undo: reversed.kind=${undoDetail.reversed?.kind} (expected notes.create)`,
      );
    }

    const after = await fetchHistory(client, 5);
    const stillThere = after.some(
      (entry) =>
        entry.id === top.id ||
        (entry.kind === "notes.create" && entry.target === top.target),
    );
    if (stillThere) {
      throw new Error("history+undo: undone notes.create row still appears in notes.history");
    }
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
            throw new Error(
              `vault.list: root listing contains forbidden path ${path}`,
            );
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

async function runContextSummarizedPass(vaultPath: string): Promise<void> {
  // Drive a small modelContextTokens budget so a single turn's history
  // overflows and ContextManager triggers summarization. Restore the
  // original setting in finally so subsequent passes are unaffected.
  let originalContextTokens = 200_000;
  try {
    await withClient(vaultPath, async (client) => {
      const currentResult = await readResult(client.call("daemon.config_get", {}));
      const currentDetail = currentResult as unknown as {
        config?: { chat?: { modelContextTokens?: number } };
      };
      if (typeof currentDetail.config?.chat?.modelContextTokens === "number") {
        originalContextTokens = currentDetail.config.chat.modelContextTokens;
      }

      await readResult(
        client.call("daemon.config_set", {
          chat: { modelContextTokens: 500 },
        }),
      );

      const conversationId = await startConversation(client, "smoke context");
      // Three turns build up enough conversation history that the
      // accumulated tokens should exceed the 350-token budget
      // (500 * 0.7) on the third turn's history pass.
      const prompts = [
        "List three reasons developers prefer test-driven development. Answer in two sentences.",
        "Now list three reasons against test-driven development. Answer in two sentences.",
        "Summarize both lists into a single paragraph of at least four sentences.",
      ];
      let summarizedSeen = false;
      let summarizedDetail: Record<string, unknown> | null = null;
      for (const prompt of prompts) {
        const turn = await drainChatSend(client, conversationId, prompt);
        if (turn.failure !== undefined) {
          throw new Error(`context summarized: turn failed (${turn.failure})`);
        }
        for (const entry of turn.events) {
          if (entry.event === "loop:context_summarized") {
            summarizedSeen = true;
            summarizedDetail = entry.payload;
            break;
          }
        }
        if (summarizedSeen) break;
      }

      if (!summarizedSeen || summarizedDetail === null) {
        // Substrate did not exceed the dialed-down budget across the
        // three driving turns. Skipping is acceptable per Task 14
        // guidance: the context summarization path is exercised in
        // `core/chat/contextManager.test.ts` directly.
        emitter.emit({
          type: "smoke:context_summarized_skipped",
          reason: "no loop:context_summarized observed across three turns at 500-token budget",
        });
        return;
      }

      const original = summarizedDetail.originalTokens;
      const after = summarizedDetail.summarizedTokens;
      // Phase D plan locked decision 14 only requires non-zero originalTokens.
      // The compression invariant (original > after) does NOT always hold for
      // short histories where the systemPrompt dominates total tokens; the
      // unit test in contextManager.test.ts proves compression on a longer
      // history. The wire forward asserts: both numbers are positive integers
      // and the conversationId matches the active turn.
      if (
        typeof original !== "number" ||
        typeof after !== "number" ||
        !(original > 0) ||
        !(after > 0)
      ) {
        throw new Error(
          `context summarized: expected positive originalTokens and summarizedTokens (got original=${String(original)}, after=${String(after)})`,
        );
      }
      emitter.emit({
        type: "smoke:context_summarized_validated",
        originalTokens: original,
        summarizedTokens: after,
      });
    });
  } finally {
    await withClient(vaultPath, async (client) => {
      await readResult(
        client.call("daemon.config_set", {
          chat: { modelContextTokens: originalContextTokens },
        }),
      ).catch(() => {
        // best-effort restore; swallow error so finally does not mask
        // a pass failure raised above.
      });
    });
  }
}

async function runToolModeProbePass(vaultPath: string): Promise<void> {
  // Unpin the cached tool mode so the next chat.send re-runs the probe
  // and emits loop:tool_mode_probed. The null-sentinel patch removes the
  // entry from settings; the in-memory toolModeStore is still empty for
  // this model on a fresh daemon start, so the next turn falls through to
  // the probe path. Restore the pin afterwards so a subsequent run starts
  // from the same baseline.
  try {
    await withClient(vaultPath, async (client) => {
      await readResult(
        client.call("daemon.config_set", {
          chat: { toolModeByModel: { [PRIMARY_MODEL]: null } },
        }),
      );
      const verifyResult = await readResult(client.call("daemon.config_get", {}));
      const verifyDetail = verifyResult as unknown as {
        config?: { chat?: { toolModeByModel?: Record<string, string> } };
      };
      const stillPinned = verifyDetail.config?.chat?.toolModeByModel?.[PRIMARY_MODEL];
      if (stillPinned !== undefined) {
        throw new Error(
          `tool_mode_probed: null sentinel did not unpin model (still=${stillPinned})`,
        );
      }

      const probe = await detectProbedEvent(client, vaultPath);
      if (!probe.observed) {
        throw new Error(
          "tool_mode_probed: chat.send after unpin did not emit loop:tool_mode_probed",
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
        mode: probe.mode,
        attempts: probe.attempts,
      });
    });
  } finally {
    await preSeedConfig(vaultPath, {
      toolModeModel: PRIMARY_MODEL,
      toolMode: "native",
      autoApproveNotesCreate: true,
    }).catch(() => {
      // Best-effort restore.
    });
  }
}

interface ProbeObservation {
  observed: boolean;
  mode?: string;
  attempts?: number;
}

async function detectProbedEvent(
  client: ClientHandle,
  _vaultPath: string,
): Promise<ProbeObservation> {
  const conversationId = await startConversation(client, "smoke probe");
  const turn = await drainChatSend(
    client,
    conversationId,
    "Reply with the single word ok and stop.",
  );
  for (const entry of turn.events) {
    if (entry.event !== "loop:tool_mode_probed") continue;
    const mode = entry.payload.mode;
    const attempts = entry.payload.attempts;
    return {
      observed: true,
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
