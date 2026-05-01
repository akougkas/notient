import { mkdir, rm } from "node:fs/promises";
import { type Socket, createServer } from "node:net";
import { dirname } from "node:path";
import { awaitBackgroundWorkers } from "./awaitBackgroundWorkers";
import { bootstrap } from "./bootstrap";
import { CoordinatorRunner } from "./coordinatorRunner";
import { makeAgentAskHandler } from "./handlers/agentAsk";
import { makeAgentBriefHandler } from "./handlers/agentBrief";
import { makeAgentDistillHandler } from "./handlers/agentDistill";
import { createAgentEventsHandler } from "./handlers/agentEvents";
import { makeAwakenHandler, makeAwakenResumeHandler, makeReindexHandler } from "./handlers/awaken";
import { makeChatHandlers } from "./handlers/chat";
import { makeHealthHandler } from "./handlers/health";
import { makeNotesHandlers } from "./handlers/notes";
import { makeSearchHandler } from "./handlers/search";
import { makeSessionGrantHandler } from "./handlers/sessionGrant";
import { makeSessionListHandler } from "./handlers/sessionList";
import { makeSessionRevokeHandler } from "./handlers/sessionRevoke";
import { makeVaultHandlers } from "./handlers/vault";
import { makeVitalsHandler } from "./handlers/vitals";
import { IdleExitTimer, removePidFile, writePidFile } from "./lifecycle";
import { MethodDispatcher, parseEnvelope } from "./rpc";
import { currentPlatform, resolveSocketPath } from "./socket";
import { VaultWatcher } from "./watcher";

const VERSION = "0.1.0-phaseA";
const DEFAULT_IDLE_HOURS = 4;
const STATUS_PROBE_TIMEOUT_MS = 2_000;
/**
 * Maximum time the shutdown sequence waits for in-flight `awaken
 * --background` workers to settle. Workers that exceed the window are
 * flipped from `running` to `failed` with `failure_reason='daemon_shutdown'`
 * so the next boot does not need an operator-driven `awaken --resume`.
 * Not configurable yet; the spec pins the default at 30s.
 */
const BACKGROUND_WORKER_GRACE_MS = 30_000;

interface DaemonArgs {
  vaultPath: string;
}

interface DaemonModelProbeInput {
  endpoint: string;
  configuredModel: string;
  configuredContextTokens: number;
  parallelSlots: number;
}

interface DaemonModelProbe {
  endpoint: string;
  configuredModel: string;
  loadedModel: string | null;
  configuredContextTokens: number;
  parallelSlots: number;
  requestedTotalContextTokens: number;
  loadedContextLength: number | null;
  status: "ok" | "mismatch";
  message: string;
}

interface RawLmStudioModel {
  id?: unknown;
  state?: unknown;
  loaded_context_length?: unknown;
}

function parseArgs(argv: string[]): DaemonArgs {
  const flagIndex = argv.indexOf("--vault");
  if (flagIndex === -1 || flagIndex === argv.length - 1) {
    throw new Error("Daemon entry requires --vault <absolute-path>.");
  }
  const vaultPath = argv[flagIndex + 1];
  return { vaultPath };
}

async function probeDaemonModel(input: DaemonModelProbeInput): Promise<DaemonModelProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(lmStudioModelsUrl(input.endpoint), {
      signal: controller.signal,
    });
    if (!response.ok) {
      return buildModelProbe(input, null, null, `HTTP ${response.status}`);
    }
    const body = (await response.json()) as { data?: ReadonlyArray<RawLmStudioModel> };
    const loaded = selectLoadedModel(body.data ?? [], input.configuredModel);
    return buildModelProbe(input, loaded?.id ?? null, loaded?.loadedContextLength ?? null, null);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return buildModelProbe(input, null, null, reason);
  } finally {
    clearTimeout(timer);
  }
}

function lmStudioModelsUrl(endpoint: string): string {
  const baseUrl = endpoint.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  return `${baseUrl}/api/v0/models`;
}

function selectLoadedModel(
  models: ReadonlyArray<RawLmStudioModel>,
  configuredModel: string,
): { id: string; loadedContextLength: number | null } | null {
  const loaded = models.flatMap((model) => {
    if (typeof model.id !== "string" || model.state !== "loaded") return [];
    return [
      {
        id: model.id,
        loadedContextLength:
          typeof model.loaded_context_length === "number" ? model.loaded_context_length : null,
      },
    ];
  });
  return loaded.find((model) => model.id === configuredModel) ?? loaded[0] ?? null;
}

function buildModelProbe(
  input: DaemonModelProbeInput,
  loadedModel: string | null,
  loadedContextLength: number | null,
  error: string | null,
): DaemonModelProbe {
  const requestedTotalContextTokens = input.configuredContextTokens * input.parallelSlots;
  const modelMatches = loadedModel === input.configuredModel;
  const contextFits =
    loadedContextLength === null || requestedTotalContextTokens <= loadedContextLength;
  const status = modelMatches && contextFits ? "ok" : "mismatch";
  const modelText =
    loadedModel === null ? "no loaded model reported" : `loaded model ${loadedModel}`;
  let message: string;
  if (!modelMatches) {
    message = `model mismatch: configured ${input.configuredModel}; ${modelText}${
      error === null ? "" : `; probe error ${error}`
    }`;
  } else if (!contextFits) {
    message = `context mismatch: configured ${input.configuredContextTokens.toLocaleString()} x ${input.parallelSlots.toLocaleString()} slots = ${requestedTotalContextTokens.toLocaleString()}; loaded ${loadedContextLength?.toLocaleString() ?? "unknown"}`;
  } else {
    message = `configured model ${input.configuredModel} is loaded; context ${input.configuredContextTokens.toLocaleString()} x ${input.parallelSlots.toLocaleString()} slots = ${requestedTotalContextTokens.toLocaleString()}`;
  }
  return {
    endpoint: input.endpoint,
    configuredModel: input.configuredModel,
    loadedModel,
    configuredContextTokens: input.configuredContextTokens,
    parallelSlots: input.parallelSlots,
    requestedTotalContextTokens,
    loadedContextLength,
    status,
    message,
  };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const platform = currentPlatform();
  const socketPath = resolveSocketPath(args.vaultPath, platform);

  const { kernel, close: closeBootstrap } = await bootstrap({ vaultPath: args.vaultPath });
  const startedAt = Date.now();
  const instanceId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const pidPath = `${args.vaultPath}/.notient/notient.lock.daemon`;

  await mkdir(`${args.vaultPath}/.notient`, { recursive: true });
  await rm(socketPath, { force: true });

  const dispatcher = new MethodDispatcher();
  const idleTimer = new IdleExitTimer({
    idleMs: DEFAULT_IDLE_HOURS * 60 * 60 * 1000,
    onIdleExit: () => {
      void shutdown("idle-exit");
    },
  });

  let shuttingDown = false;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      idleTimer.markActive();
      buffer += chunk.toString("utf-8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) handleLine(socket, line);
        newlineIndex = buffer.indexOf("\n");
      }
    });
  });

  function handleLine(socket: Socket, line: string): void {
    const parsed = parseEnvelope(line);
    if (!parsed.ok) {
      socket.write(
        `${JSON.stringify({
          id: "unknown",
          type: "error",
          code: "INVALID_PARAMS",
          message: parsed.reason,
          detail: {},
        })}\n`,
      );
      return;
    }
    void dispatcher.dispatch(parsed.envelope, (frame) => {
      socket.write(`${frame}\n`);
    });
  }

  dispatcher.register("daemon.status", async () => {
    const current = kernel.get("settings").get();
    const probe = await probeDaemonModel({
      endpoint: current.primary.baseUrl,
      configuredModel: current.primary.reasoningModel,
      configuredContextTokens: current.chat.modelContextTokens,
      parallelSlots: current.chat.reasoningSlots,
    });
    return {
      ok: true,
      vault: args.vaultPath,
      pid: process.pid,
      socketPath,
      startedAt,
      version: VERSION,
      sealed: kernel.isSealed(),
      probe,
    };
  });

  dispatcher.register("daemon.shutdown", async () => {
    setImmediate(() => {
      void shutdown("client-request");
    });
    return { ok: true };
  });

  const settings = kernel.get("settings");
  dispatcher.register("daemon.config_get", async () => {
    return { ok: true, config: settings.get() };
  });

  dispatcher.register("daemon.config_set", async (params) => {
    const patch = params as Record<string, unknown>;
    await settings.update(patch);
    return { ok: true, config: settings.get() };
  });

  const indexer = kernel.get("indexer");
  const searchPipeline = kernel.get("searchPipeline");
  const vitalsService = kernel.get("vitalsService");
  let bridgeUp = false;

  const surrealForHandlers = kernel.has("surrealDb") ? kernel.get("surrealDb") : undefined;
  const awakenBackgroundRegistry = kernel.get("awakenBackgroundRegistry");
  dispatcher.register(
    "awaken.run",
    makeAwakenHandler({
      bus: kernel.get("bus"),
      indexer,
      vault: kernel.get("vault"),
      awakenBackgroundRegistry,
      ...(surrealForHandlers !== undefined ? { surreal: surrealForHandlers } : {}),
    }),
  );
  dispatcher.register(
    "awaken.resume",
    makeAwakenResumeHandler({
      bus: kernel.get("bus"),
      indexer,
      vault: kernel.get("vault"),
      awakenBackgroundRegistry,
      ...(surrealForHandlers !== undefined ? { surreal: surrealForHandlers } : {}),
    }),
  );
  dispatcher.register(
    "reindex.glob",
    makeReindexHandler({
      bus: kernel.get("bus"),
      indexer,
      vault: kernel.get("vault"),
      awakenBackgroundRegistry,
      ...(surrealForHandlers !== undefined ? { surreal: surrealForHandlers } : {}),
    }),
  );
  dispatcher.register(
    "search.run",
    makeSearchHandler({ pipeline: searchPipeline, bridgeUp: () => bridgeUp }),
  );
  dispatcher.register("vitals.get", makeVitalsHandler({ vitalsService }));
  dispatcher.register(
    "health.probe",
    makeHealthHandler({ health: kernel.get("health"), bridgeUp: () => bridgeUp }),
  );

  const chatHandlers = makeChatHandlers({
    chatService: kernel.get("chatService"),
    approvalGate: kernel.get("approvalGate"),
    vault: kernel.get("vault"),
    visionRouter: kernel.has("visionLLM") ? kernel.get("visionLLM") : null,
    pinnedNoteMaxTokens: settings.get().chat.context.pinnedNoteMaxTokens,
    bus: kernel.get("bus"),
  });
  dispatcher.register("chat.start", chatHandlers.start);
  dispatcher.register("chat.send", chatHandlers.send);
  dispatcher.register("chat.abort", chatHandlers.abort);
  dispatcher.register("chat.list", chatHandlers.list);
  dispatcher.register("chat.load", chatHandlers.load);
  dispatcher.register("chat.approve", chatHandlers.approve);

  const agentAskHandler = makeAgentAskHandler({
    provider: kernel.get("primaryLLM"),
    toolRegistry: kernel.get("toolRegistry"),
    approvalGate: kernel.get("approvalGate"),
    toolModeCache: kernel.get("toolModeCache"),
    bus: kernel.get("bus"),
    settings: () => {
      const live = settings.get();
      return {
        model: live.primary.reasoningModel,
        defaultMaxRoundsPerTurn: live.chat.maxRoundsPerTurn,
      };
    },
  });
  dispatcher.register("agent.ask", agentAskHandler);

  const agentBriefHandler = makeAgentBriefHandler({
    surrealDb: kernel.get("surrealDb").db,
    searchPipeline,
    vault: kernel.get("vault"),
    provider: kernel.get("primaryLLM"),
    settings: () => {
      const live = settings.get();
      return { model: live.primary.reasoningModel };
    },
  });
  dispatcher.register("agent.brief", agentBriefHandler);

  const agentDistillHandler = makeAgentDistillHandler({
    vaultRoot: args.vaultPath,
    distiller: kernel.get("transcriptDistiller"),
  });
  dispatcher.register("agent.distill", agentDistillHandler);

  const agentEventsHandler = createAgentEventsHandler({
    agentEventStore: kernel.get("agentEventStore"),
    bus: kernel.get("bus"),
  });
  dispatcher.register("agent.events", agentEventsHandler);

  const sessionGrants = kernel.get("sessionGrants");
  dispatcher.register("session.grant", makeSessionGrantHandler({ sessionGrants }));
  dispatcher.register("session.revoke", makeSessionRevokeHandler({ sessionGrants }));
  dispatcher.register("session.list", makeSessionListHandler({ sessionGrants }));

  const vaultHandlers = makeVaultHandlers({ vault: kernel.get("vault") });
  const notesHandlers = makeNotesHandlers({
    historyService: kernel.get("historyService"),
    vault: kernel.get("vault"),
  });

  dispatcher.register("vault.list", vaultHandlers.list);
  dispatcher.register("notes.history", notesHandlers.history);
  dispatcher.register("notes.undo", notesHandlers.undo);
  dispatcher.register("notes.read", notesHandlers.read);

  kernel.get("bus").on("bridge:up", () => {
    bridgeUp = true;
  });
  kernel.get("bus").on("bridge:down", () => {
    bridgeUp = false;
  });

  const watcher = new VaultWatcher({
    root: args.vaultPath,
    enqueue: (path) => {
      indexer.enqueue(path);
    },
    ...(surrealForHandlers !== undefined ? { surrealDb: surrealForHandlers } : {}),
    bus: kernel.get("bus"),
  });
  await watcher.start();

  const coordinatorRunner = new CoordinatorRunner({
    bus: kernel.get("bus"),
    coordinator: kernel.get("coordinator"),
  });
  coordinatorRunner.arm();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  await writePidFile(pidPath, {
    pid: process.pid,
    instanceId,
    socketPath,
    startedAt,
    version: VERSION,
  });

  idleTimer.start();

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    idleTimer.stop();
    for (const socket of sockets) socket.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(socketPath, { force: true }).catch(() => {});
    // Await any in-flight `awaken --background` workers within a bounded
    // grace window. Workers that exceed the window are flipped from
    // `running` to `failed` with `failure_reason='daemon_shutdown'` so
    // the next boot does not need an operator-driven `awaken --resume`.
    // The step runs after the socket file is removed (no new clients) but
    // before `closeBootstrap()` (which closes the SurrealDB SDK
    // connection) so the orphan-flip UPDATE has a live transport. The
    // try/catch keeps any registry/transport failure from preventing
    // exit.
    if (kernel.has("surrealDb")) {
      try {
        const summary = await awaitBackgroundWorkers({
          registry: awakenBackgroundRegistry,
          db: kernel.get("surrealDb").db,
          graceMs: BACKGROUND_WORKER_GRACE_MS,
        });
        process.stderr.write(
          `${JSON.stringify({
            type: "daemon:awaken_workers_drained",
            completed: summary.completed,
            orphaned: summary.orphaned,
          })}\n`,
        );
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({
            type: "daemon:awaken_workers_drain_failed",
            message: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
      }
    }
    coordinatorRunner.disarm();
    await watcher.stop();
    await closeBootstrap();
    await removePidFile(pidPath).catch(() => {});
    process.stdout.write(
      `${JSON.stringify({ type: "daemon:shutting_down", reason, vault: args.vaultPath })}\n`,
    );
    process.exit(0);
  }

  process.stdout.write(
    `${JSON.stringify({
      type: "daemon:ready",
      vault: args.vaultPath,
      version: VERSION,
      socketPath,
      pid: process.pid,
    })}\n`,
  );
}

void dirname; // keep import; bun --compile is finicky with unused identifiers in some bundles
void main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      type: "daemon:error",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
