import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { type Socket, connect as connectSocket, createServer } from "node:net";
import { dirname, join } from "node:path";
import { NoteCatalogService } from "../api/catalog";
import { NoteReadService } from "../api/notes";
import { operationInputs } from "../api/operations";
import { operationOutputs } from "../api/results";
import { NoteApiError } from "../api/schema";
import { EffectAuthorityRevoked } from "../core/history/effectAuthority";
import { EventCursorExpiredError, parseAgentEventRecordId } from "../core/services/agentEventStore";
import type { HumanActivitySource } from "../core/services/sentienceActivity";
import { DatabaseSettingsJournal } from "../core/settings/changeJournal";
import { sha256Hex } from "../core/utils/sha256";
import {
  vaultAdminTokenPath,
  vaultDaemonPidPath,
  vaultId,
  vaultLockPath,
  vaultStateDir,
} from "../core/vault/identity";
import { normalizeVaultPath } from "../core/vault/paths";
import { assertRestoreQuarantineClear } from "../core/vault/restoreQuarantine";
import { VERSION } from "../version";
import { makeHelloAuthenticator } from "./auth";
import { awaitBackgroundWorkers } from "./awaitBackgroundWorkers";
import { bootstrap } from "./bootstrap";
import { MAX_FRAME_BYTES, consumeChunk } from "./framing";
import { makeAgentAskHandler } from "./handlers/agentAsk";
import { makeAgentDistillHandler } from "./handlers/agentDistill";
import { createAgentEventsHandler } from "./handlers/agentEvents";
import { makeApprovalsPendingHandler } from "./handlers/approvalsPending";
import {
  makeAwakenCancelHandler,
  makeAwakenHandler,
  makeAwakenPauseHandler,
  makeAwakenResumeHandler,
  makeAwakenStatusHandler,
  makeReindexHandler,
} from "./handlers/awaken";
import { makeChatHandlers } from "./handlers/chat";
import { makeChatSettingsHandlers } from "./handlers/chatSettings";
import { makeHealthHandler } from "./handlers/health";
import { makeJobHandlers } from "./handlers/jobs";
import { makeLinksSyncHandler } from "./handlers/links";
import {
  NonBlockingApprovalTracker,
  shutdownNonBlockingApprovals,
} from "./handlers/nonBlockingApproval";
import { makeNotesHandlers } from "./handlers/notes";
import { makeNotesWriteHandler } from "./handlers/notesWrite";
import { makePipelineHandlers } from "./handlers/pipelines";
import { makeProposalNoteHandler } from "./handlers/proposalNote";
import { makeProposalsHandlers } from "./handlers/proposals";
import { makeReviewHandlers } from "./handlers/reviews";
import { makeSearchHandler } from "./handlers/search";
import { makeSentientHandlers } from "./handlers/sentient";
import { makeSessionGrantHandler } from "./handlers/sessionGrant";
import { makeSessionListHandler } from "./handlers/sessionList";
import { makeSessionRevokeHandler } from "./handlers/sessionRevoke";
import { makeVaultHandlers } from "./handlers/vault";
import { makeVaultExtractionHandler } from "./handlers/vaultExtraction";
import { makeVaultResolveLinkHandler } from "./handlers/vaultResolveLink";
import { makeVaultStatsHandler } from "./handlers/vaultStats";
import { makeVitalsHandler } from "./handlers/vitals";
import { HostBridge } from "./hostBridge";
import { startHttpApi } from "./http";
import {
  readPrivateJson,
  secureDaemonSocket,
  secureDaemonStateTree,
  writePrivateJson,
} from "./ipcSecurity";
import {
  IdleExitTimer,
  type PidRecord,
  removeAdminToken,
  removeOwnedPidFile,
  updateOwnedPidFile,
  writeAdminToken,
} from "./lifecycle";
import {
  DaemonMaintenanceController,
  MaintenanceBusyError,
  type MaintenanceOperation,
  canRunMaintenanceOwnerMethod,
} from "./maintenance";
import { probeDaemonModel } from "./modelProbe";
import { acquireDaemonOwnership } from "./ownership";
import { PairingStore } from "./pairing";
import {
  type ConnectionSession,
  HELLO_METHOD,
  MethodDispatcher,
  type MethodHandler,
  RpcConnectionRegistry,
  RpcDispatchFence,
  type RpcEnvelope,
  RpcError,
  type RpcErrorCode,
  type RpcRequestContext,
  encodeAck,
  encodeError,
  parseEnvelope,
} from "./rpc";
import { currentPlatform, resolveSocketPath, writeFrame } from "./socket";
import { VaultWatcher } from "./watcher";

const SHUTDOWN_HARD_DEADLINE_MS = 60_000;
const SOCKET_CLOSE_GRACE_MS = 2_000;
const STATUS_PROBE_TIMEOUT_MS = 2_000;
/** Window allowed for the boot-time liveness probe against an existing socket. */
const SOCKET_PROBE_TIMEOUT_MS = 1_500;
/**
 * Maximum time the shutdown sequence waits for in-flight `awaken
 * --background` workers to settle. Workers that exceed the window are
 * flipped from `running` to `failed` with `failure_reason='daemon_shutdown'`
 * so the next boot does not need an operator-driven `awaken --resume`.
 * Not configurable yet; the spec pins the default at 30s.
 */
const BACKGROUND_WORKER_GRACE_MS = 30_000;
const MAINTENANCE_BEGIN_METHOD = "maintenance.begin";
const MAINTENANCE_END_METHOD = "maintenance.end";
const MAINTENANCE_POISON_METHOD = "maintenance.poison";

/**
 * Bus events that count as daemon activity for the idle-exit deadline.
 * Only indexer traffic qualifies: it is the one signal emitted steadily by
 * a detached awaken run that has no client socket attached.
 */
const INDEXER_ACTIVITY_EVENTS = [
  "indexer:progress",
  "indexer:complete",
  "indexer:note-indexed",
  "indexer:tier1-done",
  "indexer:tier2-done",
  "indexer:tier3-done",
] as const;

interface DaemonArgs {
  vaultPath: string;
}

type DispatchAdmission =
  | { kind: "started"; work: Promise<void> }
  | { kind: "rejected"; code: RpcErrorCode; message: string };

function parseMaintenanceOperation(params: Record<string, unknown>): MaintenanceOperation {
  const keys = Object.keys(params);
  if (
    keys.length !== 1 ||
    keys[0] !== "operation" ||
    (params.operation !== "backup" && params.operation !== "restore")
  ) {
    throw new RpcError(
      "INVALID_PARAMS",
      "maintenance.begin requires exactly operation='backup' or operation='restore'",
    );
  }
  return params.operation;
}

function parseMaintenanceEndOptions(params: Record<string, unknown>): {
  rebuildAllMarkdown: boolean;
} {
  const keys = Object.keys(params);
  if (keys.length === 0) return { rebuildAllMarkdown: false };
  if (keys.length === 1 && keys[0] === "rebuildAllMarkdown" && params.rebuildAllMarkdown === true) {
    return { rebuildAllMarkdown: true };
  }
  throw new RpcError(
    "INVALID_PARAMS",
    "maintenance.end accepts only rebuildAllMarkdown=true after a rolled-back restore",
  );
}

function parseArgs(argv: string[]): DaemonArgs {
  const flagIndex = argv.indexOf("--vault");
  if (flagIndex === -1 || flagIndex === argv.length - 1) {
    throw new Error("Daemon entry requires --vault <absolute-path>.");
  }
  const vaultPath = normalizeVaultPath(argv[flagIndex + 1]);
  return { vaultPath };
}

/** Can we complete a connection to `socketPath` within the probe window? */
function socketAccepts(socketPath: string, timeoutMs = SOCKET_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectSocket(socketPath);
    const settle = (alive: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const platform = currentPlatform();
  const stateDir = vaultStateDir(args.vaultPath);
  const socketPath = resolveSocketPath(args.vaultPath, platform);
  // The state directory is the security boundary for the token, pid/port
  // handoffs, lock, database, and Unix socket. Establish it before reading or
  // minting any per-vault state, independent of the caller's umask.
  await secureDaemonStateTree(stateDir);
  await assertRestoreQuarantineClear(args.vaultPath);
  const pidPath = vaultDaemonPidPath(args.vaultPath);
  const startedAt = Date.now();
  const instanceId = randomUUID();
  const bootRecord: PidRecord = {
    pid: process.pid,
    socketPath,
    vault: args.vaultPath,
    startedAt,
    instanceId,
    version: VERSION,
    booting: true,
  };

  // Publish boot ownership and acquire the matching vault lock before any
  // database process, watcher, or network listener starts.
  const { lockHandle } = await acquireDaemonOwnership({
    record: bootRecord,
    pidPath,
    lockPath: vaultLockPath(args.vaultPath),
    socketAccepts: () => socketAccepts(socketPath),
  });

  // A fresh mode-0600 token distinguishes the local operator from agent
  // clients for this daemon instance only.
  const adminTokenPath = vaultAdminTokenPath(args.vaultPath);
  let adminToken: string;
  let bootstrapResult: Awaited<ReturnType<typeof bootstrap>>;
  const pairing = new PairingStore(join(stateDir, "pairings.json"), vaultId(args.vaultPath));
  const hostBridge = new HostBridge(join(stateDir, "hosts.json"), pairing);
  try {
    adminToken = await writeAdminToken(adminTokenPath);
    await pairing.load();
    await hostBridge.load();
    bootstrapResult = await bootstrap({
      vaultPath: args.vaultPath,
      lockHandle,
      beforeVaultMutation: (paths) => hostBridge.beforeMutation(paths),
      deferMutationRecovery: hostBridge.hasAttachedHosts(),
      authorizeIdentity: (id, scope) => {
        if (id.startsWith("paired-") && !pairing.hasActiveScope(id, scope))
          throw new EffectAuthorityRevoked(
            "tool caller or approving operator credential was revoked",
          );
      },
      authorizeCaller: (caller) => {
        if (caller.id.startsWith("paired-") && !pairing.isActivePrincipal(caller))
          throw new NoteApiError(
            "FORBIDDEN",
            "caller credential is missing, revoked or has insufficient scope",
          );
      },
    });
  } catch (error) {
    await lockHandle.release().catch(() => {});
    await removeAdminToken(adminTokenPath).catch(() => {});
    await removeOwnedPidFile(pidPath, instanceId).catch(() => {});
    throw error;
  }
  const {
    kernel,
    fetchPrimaryModelCatalog,
    settleMaintenanceBackground,
    close: closeBootstrap,
  } = bootstrapResult;
  const sentienceActivity = kernel.get("sentienceActivity");
  const stopRevocationListener = pairing.onRevoked((id) => kernel.get("jobs").revokeCaller(id));

  /**
   * Marks deliberate operator actions without letting background agents or
   * TUI polling impersonate human attention. Recording before the handler
   * runs cancels stale idle cognition as soon as the operator acts, even when
   * validation later rejects the request.
   */
  function withHumanActivity(
    source: HumanActivitySource,
    handler: MethodHandler,
    notePath?: (request: RpcRequestContext) => string | null | undefined,
  ): MethodHandler {
    return async (request) => {
      if (request.principal.kind === "human") {
        const selectedPath = notePath?.(request);
        sentienceActivity.recordHumanActivity({
          source,
          ...(selectedPath === undefined ? {} : { notePath: selectedPath }),
        });
      }
      return handler(request);
    };
  }

  const dispatcher = new MethodDispatcher({
    authenticate: makeHelloAuthenticator({ adminToken }),
    beforeInvoke: (method, kind) => {
      if (
        !bootstrapResult.mutationsReady() &&
        (kind === "write" || kind === "admin") &&
        !["pairing.create", "pairing.list", "pairing.revoke", "daemon.shutdown"].includes(method)
      )
        throw new RpcError(
          "CONFLICT",
          "Mutation recovery is waiting for the paired Obsidian editor. Reads remain available; reconnect the host or explicitly revoke its pairing.",
        );
    },
  });
  hostBridge.register(dispatcher);
  const awakenBackgroundRegistry = kernel.get("awakenBackgroundRegistry");
  const idleTimer = new IdleExitTimer({
    // Persistent vault ownership: exit only on explicit shutdown or process signal.
    idleMs: null,
    onIdleExit: () => {
      void shutdown("idle-exit");
    },
    // Socket data alone is not a liveness signal: a detached
    // `awaken --background` run has no client attached, so the timer used
    // to fire mid-run and kill the daemon. Indexer progress refreshes the
    // deadline, and a non-empty background-worker registry vetoes the
    // exit outright.
    isBusy: () => awakenBackgroundRegistry.size() > 0,
  });

  const busForIdle = kernel.get("bus");
  for (const event of INDEXER_ACTIVITY_EVENTS) {
    busForIdle.on(event, () => {
      idleTimer.markActive();
    });
  }

  let shuttingDown = false;
  const connections = new RpcConnectionRegistry<Socket>();
  const dispatches = new RpcDispatchFence();
  let maintenance: DaemonMaintenanceController | null = null;
  let http: ReturnType<typeof startHttpApi> | null = null;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;
  let recoveryRunning = false;
  let nextConnectionId = 1;
  const server = createServer((socket) => {
    if (!connections.accept(socket)) return;
    const lifetime = new AbortController();
    // One session per connection. It starts with no principal, so the
    // dispatcher answers anything but `session.hello` with UNAUTHENTICATED
    // until the client identifies itself.
    const session: ConnectionSession = {
      id: `conn-${nextConnectionId++}`,
      principal: null,
      signal: lifetime.signal,
    };
    socket.once("end", () => lifetime.abort());
    socket.on("close", () => {
      lifetime.abort();
      connections.release(socket);
      if (dispatches.maintenanceConnectionId === session.id) {
        if (shuttingDown) {
          dispatches.releaseMaintenance(session.id);
        } else {
          void releaseAbandonedMaintenance(session.id);
        }
      }
    });
    // A client that vanishes mid-stream (Ctrl-C on the CLI) surfaces as
    // ECONNRESET/EPIPE on the server socket. Without a listener node
    // rethrows it as an uncaught exception and takes the daemon down with
    // the client, so log it and drop just that connection.
    socket.on("error", (error: Error) => {
      lifetime.abort();
      process.stderr.write(
        `${JSON.stringify({ type: "daemon:socket_error", message: error.message })}\n`,
      );
      connections.release(socket);
      socket.destroy();
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      idleTimer.markActive();
      const framed = consumeChunk(buffer, chunk.toString("utf-8"));
      buffer = framed.buffer;
      if (framed.overflow) {
        // The client is streaming an unbounded frame. Answering once and
        // dropping the connection is what keeps the buffer from growing
        // with it.
        writeFrame(
          socket,
          JSON.stringify({
            id: "unknown",
            type: "error",
            code: "INVALID_PARAMS",
            message: `frame exceeds the ${MAX_FRAME_BYTES}-byte limit`,
            detail: {},
          }),
        );
        connections.release(socket);
        socket.destroy();
        return;
      }
      for (const line of framed.lines) handleLine(socket, session, line);
    });
  });

  function handleLine(socket: Socket, session: ConnectionSession, line: string): void {
    const parsed = parseEnvelope(line);
    if (!parsed.ok) {
      writeInvalidEnvelope(socket, parsed.reason);
      return;
    }
    const dispatch = (): Promise<void> =>
      dispatcher.dispatch(
        parsed.envelope,
        (frame) => {
          writeFrame(socket, frame);
        },
        session,
      );
    const admission = admitRpcDispatch(session, parsed.envelope, dispatch);
    if (admission.kind === "rejected") {
      writeDispatchRejection(socket, parsed.envelope, admission);
      return;
    }
    if (parsed.envelope.method === HELLO_METHOD) {
      void admission.work.then(() => {
        if (session.principal !== null) connections.markAuthenticated(socket);
      });
    }
  }

  function writeInvalidEnvelope(socket: Socket, reason: string): void {
    writeFrame(
      socket,
      JSON.stringify({
        id: "unknown",
        type: "error",
        code: "INVALID_PARAMS",
        message: reason,
        detail: {},
      }),
    );
  }

  function admitRpcDispatch(
    session: ConnectionSession,
    envelope: RpcEnvelope,
    dispatch: () => Promise<void>,
  ): DispatchAdmission {
    if (envelope.method === MAINTENANCE_BEGIN_METHOD && isHumanAdmin(session)) {
      return admitMaintenanceBegin(session.id, dispatch);
    }
    if (dispatches.maintenanceConnectionId !== null) {
      return admitDispatchDuringMaintenance(session, envelope.method, dispatch);
    }
    return startTrackedDispatch(dispatch);
  }

  function admitMaintenanceBegin(
    connectionId: string,
    dispatch: () => Promise<void>,
  ): DispatchAdmission {
    if (dispatches.size > 0 || kernel.get("approvalGate").pendingCount() > 0) {
      return {
        kind: "rejected",
        code: "DAEMON_MAINTENANCE",
        message: "exclusive graph maintenance requires active RPC and approval work to settle",
      };
    }
    return admissionForWork(dispatches.enterMaintenance(connectionId, dispatch));
  }

  function admitDispatchDuringMaintenance(
    session: ConnectionSession,
    method: string,
    dispatch: () => Promise<void>,
  ): DispatchAdmission {
    const owner = dispatches.maintenanceConnectionId === session.id;
    const ownerMethodAllowed =
      maintenance !== null && canRunMaintenanceOwnerMethod(method, maintenance);
    if (!isPoisonedRecoveryAllowed(session, method) && (!owner || !ownerMethodAllowed)) {
      return maintenanceRejection();
    }
    return startTrackedDispatch(dispatch);
  }

  function isPoisonedRecoveryAllowed(session: ConnectionSession, method: string): boolean {
    if (!dispatches.maintenancePoisoned) return false;
    return method === HELLO_METHOD || (method === "daemon.shutdown" && isHumanAdmin(session));
  }

  function isHumanAdmin(session: ConnectionSession): boolean {
    return (
      session.principal?.kind === "human" && session.principal.scopes.includes("admin") === true
    );
  }

  function startTrackedDispatch(dispatch: () => Promise<void>): DispatchAdmission {
    return admissionForWork(dispatches.start(dispatch));
  }

  function admissionForWork(work: Promise<void> | null): DispatchAdmission {
    if (work !== null) return { kind: "started", work };
    if (shuttingDown) {
      return {
        kind: "rejected",
        code: "DAEMON_SHUTTING_DOWN",
        message: "daemon is shutting down",
      };
    }
    return maintenanceRejection();
  }

  function maintenanceRejection(): DispatchAdmission {
    return {
      kind: "rejected",
      code: "DAEMON_MAINTENANCE",
      message: "daemon graph maintenance is in progress",
    };
  }

  function writeDispatchRejection(
    socket: Socket,
    envelope: RpcEnvelope,
    rejection: Extract<DispatchAdmission, { kind: "rejected" }>,
  ): void {
    writeFrame(socket, encodeAck(envelope.id, envelope.method));
    writeFrame(socket, encodeError(envelope.id, rejection.code, rejection.message, {}));
  }

  dispatcher.register(
    "daemon.status",
    async (_request) => {
      const current = kernel.get("settings").get();
      const probe = await probeDaemonModel({
        endpoint: current.primary.baseUrl,
        fetchCatalog: () => fetchPrimaryModelCatalog(STATUS_PROBE_TIMEOUT_MS),
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
        indexing: kernel.get("indexer").readiness.snapshot(),
        httpEndpoint: http?.endpoint ?? null,
        vaultId: pairing.vaultId,
        sealed: kernel.isSealed(),
        // The vision route is probed once at seal; the kernel only holds a
        // `visionLLM` when that probe found a multimodal model on the endpoint.
        visionReady: kernel.has("visionLLM"),
        probe,
      };
    },
    { kind: "read" },
  );

  dispatcher.register(
    "daemon.shutdown",
    async (_request) => {
      setImmediate(() => {
        void shutdown("client-request");
      });
      return { ok: true };
    },
    { kind: "admin" },
  );

  const settings = kernel.get("settings");
  dispatcher.register(
    "daemon.config_get",
    async (_request) => {
      return { ok: true, config: settings.get() };
    },
    { kind: "read" },
  );

  dispatcher.register(
    "daemon.model_catalog",
    async (_request) => {
      const catalog = await fetchPrimaryModelCatalog();
      return { ok: true, source: catalog.source, models: catalog.models };
    },
    { kind: "read" },
  );

  const indexer = kernel.get("indexer");
  const searchPipeline = kernel.get("searchPipeline");
  const vitalsService = kernel.get("vitalsService");

  const surreal = kernel.get("surrealDb");
  const approvalIntents = kernel.get("approvalService");
  // Compiled in bootstrap from `settings.indexer.excludePaths` /
  // `excludeGlobs`; shared by the awaken/reindex handlers and the watcher.
  const indexExclusion = kernel.get("indexExclusion");
  dispatcher.register(
    "awaken.run",
    makeAwakenHandler({
      bus: kernel.get("bus"),
      indexer,
      vault: kernel.get("vault"),
      awakenBackgroundRegistry,
      isExcluded: indexExclusion,
      approvalIntents,
      surreal,
    }),
    { kind: "admin" },
  );
  dispatcher.register(
    "awaken.resume",
    makeAwakenResumeHandler({
      bus: kernel.get("bus"),
      indexer,
      vault: kernel.get("vault"),
      awakenBackgroundRegistry,
      isExcluded: indexExclusion,
      approvalIntents,
      surreal,
    }),
    { kind: "admin" },
  );
  dispatcher.register(
    "awaken.pause",
    makeAwakenPauseHandler({
      bus: kernel.get("bus"),
      indexer,
      vault: kernel.get("vault"),
      awakenBackgroundRegistry,
      isExcluded: indexExclusion,
      approvalIntents,
      surreal,
    }),
    { kind: "admin" },
  );
  dispatcher.register(
    "awaken.cancel",
    makeAwakenCancelHandler({
      bus: kernel.get("bus"),
      indexer,
      vault: kernel.get("vault"),
      awakenBackgroundRegistry,
      isExcluded: indexExclusion,
      approvalIntents,
      surreal,
    }),
    { kind: "admin" },
  );
  dispatcher.register("awaken.status", makeAwakenStatusHandler({ surreal }), {
    kind: "read",
  });
  dispatcher.register(
    "reindex.glob",
    makeReindexHandler({
      bus: kernel.get("bus"),
      indexer,
      vault: kernel.get("vault"),
      awakenBackgroundRegistry,
      isExcluded: indexExclusion,
      approvalIntents,
      surreal,
    }),
    { kind: "admin" },
  );
  dispatcher.register(
    "search.run",
    withHumanActivity(
      "search",
      makeSearchHandler({
        pipeline: searchPipeline,
        defaultMode: () => settings.get().search.defaultMode,
      }),
    ),
    {
      kind: "read",
    },
  );
  dispatcher.register(
    "vitals.get",
    makeVitalsHandler({ vitalsService, vault: kernel.get("vault") }),
    { kind: "read" },
  );
  dispatcher.register("health.probe", makeHealthHandler({ health: kernel.get("health") }), {
    kind: "read",
  });
  dispatcher.register(
    "context.get",
    async ({ params }) => {
      try {
        return await searchPipeline.context(params, AbortSignal.timeout(120000));
      } catch (error) {
        if (error instanceof NoteApiError) throw new RpcError(error.code, error.message);
        throw error;
      }
    },
    { kind: "read" },
  );

  const chatHandlers = makeChatHandlers({
    chatService: kernel.get("chatService"),
    approvalGate: kernel.get("approvalGate"),
    vault: kernel.get("vault"),
    visionRouter: kernel.has("visionLLM") ? kernel.get("visionLLM") : null,
    pinnedNoteMaxTokens: settings.get().chat.context.pinnedNoteMaxTokens,
    bus: kernel.get("bus"),
  });
  dispatcher.register("chat.start", chatHandlers.start, { kind: "write" });
  dispatcher.register("chat.send", withHumanActivity("chat", chatHandlers.send), {
    kind: "write",
  });
  dispatcher.register("chat.abort", chatHandlers.abort, { kind: "write" });
  dispatcher.register("chat.list", chatHandlers.list, { kind: "read" });
  dispatcher.register("chat.load", chatHandlers.load, { kind: "read" });
  dispatcher.register("chat.approve", withHumanActivity("approval", chatHandlers.approve), {
    kind: "admin",
  });

  // What the approval gate is blocking on right now, for any human client —
  // not just the connection whose turn parked the call.
  dispatcher.register(
    "approvals.pending",
    makeApprovalsPendingHandler({ approvalGate: kernel.get("approvalGate") }),
    { kind: "read" },
  );

  const agentAskHandler = makeAgentAskHandler({
    notes: new NoteReadService(kernel.get("vault")),
    provider: kernel.get("primaryLLM"),
    toolRegistry: kernel.get("toolRegistry"),
    toolModeCache: kernel.get("toolModeCache"),
    bus: kernel.get("bus"),
    scheduler: kernel.get("reasoningScheduler"),
    settings: () => {
      const live = settings.get();
      return {
        model: live.primary.reasoningModel,
        defaultMaxRoundsPerTurn: Math.min(8, live.chat.maxRoundsPerTurn),
        contextBudgetTokens: Math.max(
          1024,
          Math.min(
            Math.floor(live.chat.modelContextTokens * live.chat.contextBudgetFraction),
            live.chat.modelContextTokens - 9216,
          ),
        ),
      };
    },
  });
  dispatcher.register("ask.run", withHumanActivity("search", agentAskHandler), {
    kind: "read",
  });

  dispatcher.register(
    "notes.compare",
    withHumanActivity("search", ({ params, signal }) =>
      kernel.get("analysis").compare(params, signal),
    ),
    { kind: "read" },
  );
  dispatcher.register(
    "notes.correlate",
    withHumanActivity("search", ({ params, signal }) =>
      kernel.get("analysis").correlate(params, signal),
    ),
    { kind: "read" },
  );

  dispatcher.register(
    "brief.run",
    withHumanActivity("search", ({ params, signal }) =>
      kernel.get("analysis").brief(params, signal),
    ),
    { kind: "read" },
  );

  const nonBlockingApprovals = new NonBlockingApprovalTracker();
  const agentDistillHandler = makeAgentDistillHandler({
    distiller: kernel.get("transcriptDistiller"),
    vault: kernel.get("vault"),
    approvalGate: kernel.get("approvalGate"),
    approvalTracker: nonBlockingApprovals,
    approvalMode: () => settings.get().chat.approvalMode,
    applyWrite: (record) => kernel.get("durableNoteWriter").apply(record),
    hash: sha256Hex,
  });
  dispatcher.register("agent.distill", agentDistillHandler, { kind: "write" });

  const agentEventsHandler = createAgentEventsHandler({
    agentEventStore: kernel.get("agentEventStore"),
    bus: kernel.get("bus"),
  });
  dispatcher.register("agent.events", agentEventsHandler, { kind: "read" });

  const sessionGrants = kernel.get("sessionGrants");
  dispatcher.register("session.grant", makeSessionGrantHandler({ sessionGrants }), {
    kind: "admin",
  });
  dispatcher.register("session.revoke", makeSessionRevokeHandler({ sessionGrants }), {
    kind: "admin",
  });
  dispatcher.register("session.list", makeSessionListHandler({ sessionGrants }), { kind: "read" });

  const vaultHandlers = makeVaultHandlers({ vault: kernel.get("vault") });
  const notesHandlers = makeNotesHandlers({
    indexedRevision: async (path) => {
      const [rows] = await surreal.db
        .query<[Array<{ sha: string }>]>(
          "SELECT sha FROM note WHERE path = $path AND tombstoned_at = NONE LIMIT 1;",
          { path },
        )
        .collect<[Array<{ sha: string }>]>();
      return rows[0]?.sha ?? null;
    },
    vault: kernel.get("vault"),
  });

  const noteCatalog = new NoteCatalogService(kernel.get("vault"));
  const history = kernel.get("historyService");
  dispatcher.register("history.list", ({ params, principal }) => history.list(params, principal), {
    kind: "read",
  });
  dispatcher.register("history.get", ({ params, principal }) => history.detail(params, principal), {
    kind: "read",
  });
  dispatcher.register(
    "history.undo",
    withHumanActivity("approval", ({ params, principal, signal }) =>
      history.undoRequest(params, principal, signal),
    ),
    { kind: "admin" },
  );
  const changes = kernel.get("changes");
  const reviewHandlers = makeReviewHandlers(kernel.get("approvalService"), changes);
  dispatcher.register("proposals.list", reviewHandlers.list, { kind: "read" });
  dispatcher.register("proposals.get", reviewHandlers.get, { kind: "read" });
  dispatcher.register("proposals.approve", withHumanActivity("approval", reviewHandlers.approve), {
    kind: "write",
  });
  dispatcher.register("proposals.reject", withHumanActivity("approval", reviewHandlers.reject), {
    kind: "write",
  });
  dispatcher.register("proposals.submit", reviewHandlers.submit, { kind: "write" });
  const jobHandlers = makeJobHandlers(kernel.get("jobs"));
  dispatcher.register("jobs.list", jobHandlers.list, { kind: "read" });
  dispatcher.register("jobs.get", jobHandlers.get, { kind: "read" });
  dispatcher.register("jobs.control", jobHandlers.control, { kind: "write" });
  const pipelineHandlers = makePipelineHandlers({
    jobs: kernel.get("jobs"),
    settings: kernel.get("settings"),
    coordinator: kernel.get("coordinator"),
    journal: new DatabaseSettingsJournal(surreal.db),
    authorize: ({ principal }) => {
      if (principal.id.startsWith("paired-") && !pairing.isActivePrincipal(principal))
        throw new NoteApiError("FORBIDDEN", "Configuration credential was revoked.");
    },
  });
  dispatcher.register("pipelines.list", pipelineHandlers.list, { kind: "read" });
  dispatcher.register("pipelines.run", pipelineHandlers.run, { kind: "write" });
  dispatcher.register("pipelines.validate", pipelineHandlers.validate, { kind: "read" });
  dispatcher.register("pipelines.configure", pipelineHandlers.configure, { kind: "admin" });
  dispatcher.register("background.pause", pipelineHandlers.pause, { kind: "admin" });
  const chatSettingsHandlers = makeChatSettingsHandlers({
    settings: kernel.get("settings"),
    journal: new DatabaseSettingsJournal(surreal.db),
    authorize: ({ principal }) => {
      if (principal.id.startsWith("paired-") && !pairing.isActivePrincipal(principal))
        throw new NoteApiError("FORBIDDEN", "Configuration credential was revoked.");
    },
  });
  dispatcher.register("chat.settings", chatSettingsHandlers.get, { kind: "read" });
  dispatcher.register("chat.configure", chatSettingsHandlers.configure, { kind: "admin" });
  dispatcher.register(
    "changes.get",
    async ({ params, principal }) => {
      const parsed = operationInputs["changes.get"].safeParse(params);
      if (!parsed.success) throw new RpcError("INVALID_PARAMS", parsed.error.message);
      try {
        return await changes.get(parsed.data.previewId, principal);
      } catch (error) {
        if (error instanceof NoteApiError) throw new RpcError(error.code, error.message);
        throw error;
      }
    },
    { kind: "read" },
  );
  dispatcher.register(
    "changes.preview",
    async ({ params, principal }) => {
      try {
        return await changes.preview(params, principal);
      } catch (error) {
        if (error instanceof NoteApiError) throw new RpcError(error.code, error.message);
        throw error;
      }
    },
    { kind: "read" },
  );
  dispatcher.register(
    "changes.apply",
    async ({ params, principal, signal }) => {
      try {
        return await changes.apply(params, principal, signal ?? AbortSignal.timeout(120000));
      } catch (error) {
        if (error instanceof NoteApiError) throw new RpcError(error.code, error.message);
        throw error;
      }
    },
    { kind: "write" },
  );
  dispatcher.register(
    "notes.list",
    async ({ params }) => {
      try {
        return await noteCatalog.list(params);
      } catch (error) {
        if (error instanceof NoteApiError) throw new RpcError(error.code, error.message);
        throw error;
      }
    },
    { kind: "read" },
  );
  dispatcher.register("vault.list", vaultHandlers.list, { kind: "read" });
  for (const method of ["graph.neighbors", "graph.path"] as const) {
    dispatcher.register(
      method,
      async ({ params, signal }) => {
        const graph = kernel.get("graph");
        return method === "graph.neighbors"
          ? graph.neighbors(params, signal)
          : graph.path(params, signal);
      },
      { kind: "read" },
    );
  }
  const sentientHandlers = makeSentientHandlers({
    graph: kernel.get("graph"),
    db: surreal.db,
    vault: kernel.get("vault"),
  });
  dispatcher.register("vault.neighbors", sentientHandlers.neighbors, {
    kind: "read",
  });
  dispatcher.register("vault.active_note", sentientHandlers.activeNote, {
    kind: "read",
  });
  dispatcher.register("graph.find_path", sentientHandlers.findPath, {
    kind: "read",
  });
  dispatcher.register(
    "vault.extraction",
    makeVaultExtractionHandler({ db: surreal.db, vault: kernel.get("vault") }),
    { kind: "read" },
  );
  dispatcher.register("vault.resolve_link", makeVaultResolveLinkHandler({ db: surreal.db }), {
    kind: "read",
  });
  dispatcher.register(
    "vault.stats",
    makeVaultStatsHandler({
      db: surreal.db,
      pendingApprovals: () => kernel.get("approvalGate").pendingCount(),
    }),
    { kind: "read" },
  );
  const proposalsHandlers = makeProposalsHandlers({
    db: surreal.db,
    approvalService: kernel.get("approvalService"),
    vault: kernel.get("vault"),
  });
  dispatcher.register("links.proposals", proposalsHandlers.list, {
    kind: "read",
  });
  dispatcher.register(
    "proposals.propose_note",
    makeProposalNoteHandler({
      approvalGate: kernel.get("approvalGate"),
      approvalTracker: nonBlockingApprovals,
      approvalMode: () => settings.get().chat.approvalMode,
      vault: kernel.get("vault"),
      applyWrite: (record) => kernel.get("durableNoteWriter").apply(record),
      hash: sha256Hex,
    }),
    { kind: "write" },
  );
  dispatcher.register("proposals.propose_link", proposalsHandlers.proposeLink, {
    kind: "write",
  });
  // Approving an edge rewrites a note body, so both decisions are admin:
  // an agent principal must never be able to merge its own proposal.
  dispatcher.register("links.approve", withHumanActivity("approval", proposalsHandlers.approve), {
    kind: "admin",
  });
  dispatcher.register("links.reject", withHumanActivity("approval", proposalsHandlers.reject), {
    kind: "admin",
  });
  dispatcher.register(
    "links.sync",
    withHumanActivity(
      "approval",
      makeLinksSyncHandler({ approvalService: kernel.get("approvalService") }),
    ),
    { kind: "admin" },
  );
  dispatcher.register(
    "notes.read",
    withHumanActivity("note-focus", notesHandlers.read, ({ params }) =>
      typeof params.path === "string" ? params.path : undefined,
    ),
    { kind: "read" },
  );

  dispatcher.register(
    "notes.write",
    withHumanActivity(
      "approval",
      makeNotesWriteHandler({
        toolRegistry: kernel.get("toolRegistry"),
        approvalGate: kernel.get("approvalGate"),
        approvalTracker: nonBlockingApprovals,
      }),
      ({ params }) => (typeof params.path === "string" ? params.path : undefined),
    ),
    { kind: "write" },
  );

  const watcher = new VaultWatcher({
    readiness: indexer.readiness,
    root: args.vaultPath,
    enqueue: (path) => {
      indexer.enqueue(path);
    },
    surrealDb: surreal,
    bus: kernel.get("bus"),
    activity: sentienceActivity,
    mutationJournal: kernel.get("daemonMutationJournal"),
    approvalIntents,
    isExcluded: indexExclusion,
  });
  const coordinator = kernel.get("coordinator");
  maintenance = new DaemonMaintenanceController({
    watcher,
    activity: sentienceActivity,
    coordinator,
    indexer,
    chatService: kernel.get("chatService"),
    agentEventStore: kernel.get("agentEventStore"),
    awakenWorkers: awakenBackgroundRegistry,
    nonBlockingApprovals,
    settleBootstrapWork: settleMaintenanceBackground,
  });
  dispatcher.register(
    MAINTENANCE_BEGIN_METHOD,
    async (request) => {
      try {
        const operation = parseMaintenanceOperation(request.params);
        const controller = maintenance;
        if (controller === null) {
          throw new RpcError("INTERNAL", "daemon maintenance controller is unavailable");
        }
        await controller.begin(operation);
        return { ok: true, operation };
      } catch (error) {
        dispatches.releaseMaintenance(request.connectionId);
        if (error instanceof MaintenanceBusyError) {
          throw new RpcError("DAEMON_MAINTENANCE", error.message);
        }
        throw error;
      }
    },
    { kind: "admin" },
  );
  dispatcher.register(
    MAINTENANCE_END_METHOD,
    async (request) => {
      if (dispatches.maintenanceConnectionId !== request.connectionId) {
        throw new RpcError("DAEMON_MAINTENANCE", "maintenance lease belongs to another connection");
      }
      const controller = maintenance;
      if (controller === null)
        throw new RpcError("INTERNAL", "maintenance controller is unavailable");
      const endOptions = parseMaintenanceEndOptions(request.params);
      const result = await controller.end(endOptions);
      dispatches.releaseMaintenance(request.connectionId);
      return { ok: true, vaultChanged: result.vaultChanged };
    },
    { kind: "admin" },
  );
  dispatcher.register(
    MAINTENANCE_POISON_METHOD,
    async (request) => {
      if (dispatches.maintenanceConnectionId !== request.connectionId) {
        throw new RpcError("DAEMON_MAINTENANCE", "maintenance lease belongs to another connection");
      }
      const controller = maintenance;
      if (controller === null) {
        throw new RpcError("INTERNAL", "maintenance controller is unavailable");
      }
      await controller.poison();
      if (!dispatches.poisonMaintenance(request.connectionId)) {
        throw new RpcError("DAEMON_MAINTENANCE", "maintenance ownership was lost");
      }
      return { ok: true, poisoned: true };
    },
    { kind: "admin" },
  );
  dispatcher.register(
    "capabilities.get",
    async () => ({
      ok: true,
      apiVersion: "v1",
      version: VERSION,
      vaultId: pairing.vaultId,
      operations: Object.keys(operationOutputs).filter(
        (method) => dispatcher.kindOf(method) !== undefined,
      ),
      limits: {
        requestBytes: 8 * 1024 * 1024,
        concurrentRequests: 32,
        eventPage: 100,
        requestDurationMs: 180000,
      },
    }),
    { kind: "read" },
  );
  dispatcher.register(
    "pairing.create",
    async ({ params, principal }) => ({
      ok: true,
      endpoint: http?.endpoint,
      ...pairing.create(params, principal),
    }),
    { kind: "admin" },
  );
  dispatcher.register(
    "pairing.list",
    async ({ principal }) => ({
      ok: true,
      credentials: pairing.list(principal),
      endpoint: http?.endpoint,
      vaultId: pairing.vaultId,
    }),
    { kind: "admin" },
  );
  dispatcher.register(
    "pairing.revoke",
    async ({ params, principal }) => {
      if (typeof params.id !== "string" || Object.keys(params).length !== 1)
        throw new RpcError("INVALID_PARAMS", "credential id required");
      if (!http) throw new RpcError("INTERNAL", "HTTP transport is unavailable");
      await http.revoke(params.id, principal);
      return { ok: true };
    },
    { kind: "admin" },
  );
  dispatcher.register(
    "events.subscribe",
    async ({ params }) => {
      const parsed = operationInputs["events.subscribe"].safeParse(params);
      if (!parsed.success) throw new RpcError("INVALID_PARAMS", parsed.error.message);
      let cursor: string | null = null;
      try {
        cursor = parsed.data.cursor ? parseAgentEventRecordId(parsed.data.cursor).toString() : null;
      } catch {
        throw new RpcError("INVALID_PARAMS", "invalid event cursor");
      }
      try {
        const events = await kernel.get("agentEventStore").resume(cursor, 100);
        return { ok: true, events, cursor: events.at(-1)?.id ?? cursor };
      } catch (error) {
        if (error instanceof EventCursorExpiredError) throw new RpcError("CONFLICT", error.message);
        throw error;
      }
    },
    { kind: "read" },
  );
  try {
    let preferredPort = 0;
    try {
      const saved = await readPrivateJson(join(stateDir, "http.json"));
      if (
        typeof saved !== "object" ||
        saved === null ||
        !("port" in saved) ||
        typeof saved.port !== "number" ||
        !Number.isInteger(saved.port) ||
        saved.port < 1 ||
        saved.port > 65535
      )
        throw new Error("invalid saved HTTP port");
      preferredPort = saved.port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    http = startHttpApi({
      pairing,
      port: preferredPort,
      admission: () => !shuttingDown && dispatches.maintenanceConnectionId === null,
      invoke: (method, context) => {
        if (dispatches.maintenanceConnectionId !== null)
          return Promise.reject(
            new RpcError("DAEMON_MAINTENANCE", "graph maintenance is in progress"),
          );
        return (
          dispatches.start(() => dispatcher.invoke(method, context)) ??
          Promise.reject(new RpcError("DAEMON_SHUTTING_DOWN", "daemon is stopping"))
        );
      },
    });
    await writePrivateJson(join(stateDir, "http.json"), {
      port: http.port,
      endpoint: http.endpoint,
      vaultId: pairing.vaultId,
    });
    if (bootstrapResult.mutationsReady()) {
      coordinator.start();
      await sentienceActivity.start();
    } else {
      recoveryTimer = setInterval(() => {
        if (recoveryRunning || !hostBridge.allConnected() || shuttingDown) return;
        recoveryRunning = true;
        void bootstrapResult
          .resumeMutationRecovery()
          .then(async (ready) => {
            if (!ready || shuttingDown) return;
            if (recoveryTimer) clearInterval(recoveryTimer);
            recoveryTimer = null;
            coordinator.start();
            await sentienceActivity.start();
          })
          .catch((error) => {
            process.stderr.write(
              `${JSON.stringify({ type: "daemon:host_recovery_failed", message: String(error) })}\n`,
            );
          })
          .finally(() => {
            recoveryRunning = false;
          });
      }, 2000);
      recoveryTimer.unref();
    }
    await watcher.start();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await secureDaemonSocket(socketPath);
    await updateOwnedPidFile(pidPath, { ...bootRecord, booting: false });
  } catch (error) {
    await http?.stop().catch(() => {});
    await watcher.stop().catch(() => {});
    await closeBootstrap().catch(() => {});
    await removeAdminToken(adminTokenPath).catch(() => {});
    await rm(socketPath, { force: true }).catch(() => {});
    await removeOwnedPidFile(pidPath, instanceId).catch(() => {});
    throw error;
  }

  idleTimer.start();

  process.on("unhandledRejection", (reason: unknown) => {
    const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(`${JSON.stringify({ type: "daemon:unhandled_rejection", message })}\n`);
  });
  process.on("uncaughtException", (error: Error) => {
    process.stderr.write(
      `${JSON.stringify({ type: "daemon:uncaught_exception", message: error.stack ?? error.message })}\n`,
    );
    void shutdown("uncaught-exception");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    if (recoveryTimer) clearInterval(recoveryTimer);
    recoveryTimer = null;
    dispatches.stopAccepting();
    const httpShutdown = http?.stop();
    // This call closes delayed-write admission synchronously before its first
    // await. Parked decisions are cancelled and approved continuations drain
    // while SurrealDB and the vault adapter are still alive.
    const approvalShutdown = shutdownNonBlockingApprovals(
      nonBlockingApprovals,
      kernel.get("approvalGate"),
    );
    connections.shutdown();
    idleTimer.stop();
    // A client that never closes its half of the socket would otherwise
    // hold server.close() open forever, and a paused background worker
    // would hold the drain. Neither may keep a stopping daemon alive.
    const deadline = setTimeout(() => {
      process.stderr.write(`${JSON.stringify({ type: "daemon:shutdown_forced", reason })}\n`);
      process.exit(2);
    }, SHUTDOWN_HARD_DEADLINE_MS);
    deadline.unref();
    for (const socket of connections.connections()) socket.end();
    await new Promise<void>((resolve) => {
      const closeTimer = setTimeout(() => {
        for (const socket of connections.connections()) socket.destroy();
        resolve();
      }, SOCKET_CLOSE_GRACE_MS);
      server.close(() => {
        clearTimeout(closeTimer);
        resolve();
      });
    });
    await rm(socketPath, { force: true }).catch(() => {});
    await removeAdminToken(adminTokenPath).catch(() => {});
    // Existing sockets can close while their async handlers are still
    // running. Fence those canonical dispatch Promises before stopping any
    // downstream producer or closing SurrealDB.
    await dispatches.drain();
    await httpShutdown;
    await approvalShutdown;
    // Give in-flight `awaken --background` workers a bounded natural
    // completion grace. Workers that exceed it are cancelled, fully drained,
    // and flipped from `running` to `failed` with
    // `failure_reason='daemon_shutdown'` so the next boot does not need an
    // operator-driven `awaken --resume`.
    // The step runs after the socket file is removed (no new clients) but
    // before `closeBootstrap()` (which closes the SurrealDB SDK
    // connection) so the orphan-flip UPDATE has a live transport. The
    // try/catch keeps any registry/transport failure from preventing
    // exit.
    try {
      const summary = await awaitBackgroundWorkers({
        registry: awakenBackgroundRegistry,
        db: surreal.db,
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
    await watcher.stop();
    stopRevocationListener();
    await closeBootstrap();
    await removeOwnedPidFile(pidPath, instanceId).catch(() => {});
    process.stdout.write(
      `${JSON.stringify({ type: "daemon:shutting_down", reason, vault: args.vaultPath })}\n`,
    );
    process.exit(0);
  }

  async function releaseAbandonedMaintenance(connectionId: string): Promise<void> {
    if (dispatches.maintenancePoisoned) return;
    if (await quarantineAbandonedRestore(connectionId)) return;
    if (maintenance?.operation === null) {
      // Cancel an enterMaintenance call that is still waiting to dispatch its
      // begin handler.
      dispatches.releaseMaintenance(connectionId);
      return;
    }
    // If begin reached the controller, its serialized transition queue places
    // this end strictly after it. Keep the RPC admission fence closed through
    // that complete resumption; otherwise a dropped backup owner can admit a
    // mutation while watcher and indexer producers are still restarting.
    await resumeAbandonedMaintenance(connectionId);
  }

  async function quarantineAbandonedRestore(connectionId: string): Promise<boolean> {
    const controller = maintenance;
    if (controller?.operation !== "restore" || !controller.ready) return false;
    try {
      await controller.poison();
      if (!dispatches.poisonMaintenance(connectionId)) {
        throw new Error("restore maintenance ownership was lost during quarantine");
      }
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          type: "daemon:restore_quarantine_failed",
          message: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
      void shutdown("restore-quarantine-failed");
    }
    return true;
  }

  async function resumeAbandonedMaintenance(connectionId: string): Promise<void> {
    try {
      const released = await dispatches.finishMaintenance(connectionId, async () => {
        await maintenance?.end();
      });
      if (!released) throw new Error("maintenance ownership was lost during resumption");
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          type: "daemon:maintenance_resume_failed",
          message: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
      void shutdown("maintenance-resume-failed");
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      type: "daemon:ready",
      httpEndpoint: http?.endpoint,
      vault: args.vaultPath,
      version: VERSION,
      socketPath,
      pid: process.pid,
      instanceId,
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
