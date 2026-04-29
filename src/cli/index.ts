import { parseAskFormat, parseAskMaxRounds, runAskCommand } from "./commands/ask";
import { type AwakenControlMode, runAwakenCommand } from "./commands/awaken";
import { runBackupCommand } from "./commands/backup";
import { parseBriefMaxField, runBriefCommand } from "./commands/brief";
import { runChatSingleShot, runChatTui } from "./commands/chat";
import { runDaemonCommand } from "./commands/daemon";
import { runDbSqlCommand } from "./commands/dbSql";
import { parseDistillFormat, runDistillCommand } from "./commands/distill";
import {
  parseEventsLongPollMs,
  parseEventsPositiveInt,
  parseEventsSince,
  runEventsCommand,
} from "./commands/events";
import {
  type DumpFormat,
  parseDumpFormat,
  parseDumpTier,
  runGraphDumpCommand,
} from "./commands/graphDump";
import { runGraphStatsCommand } from "./commands/graphStats";
import { runHealthCommand } from "./commands/health";
import { runInit } from "./commands/init";
import { type LinksAuditMode, runLinksAuditCommand } from "./commands/linksAudit";
import { runLinksSyncCommand } from "./commands/linksSync";
import { runMigrateVaultCommand } from "./commands/migrateVault";
import { runNukeCommand } from "./commands/nuke";
import { runReindexCommand } from "./commands/reindex";
import { runRestoreCommand } from "./commands/restore";
import { runSearchCommand } from "./commands/search";
import {
  type SessionSubcommand,
  parseSessionFolders,
  parseSessionId,
  parseSessionOptionalPositiveInt,
  parseSessionPositiveInt,
  parseSessionTools,
  runSessionCommand,
} from "./commands/session";
import { runVitalsCommand } from "./commands/vitals";
import { defaultStateLoader, resolveVault } from "./env";
import { normalizeAgentId } from "./identity";
import { type Emitter, type EmitterMode, defaultMode, makeEmitter } from "./output";

interface ParsedArgs {
  command: string | null;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { command: null, positional: [], flags: {} };
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (!out.command && !token.startsWith("-")) {
      out.command = token;
      index++;
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        out.flags[key] = next;
        index += 2;
      } else {
        out.flags[key] = true;
        index += 1;
      }
      continue;
    }
    out.positional.push(token);
    index += 1;
  }
  return out;
}

function selectMode(parsed: ParsedArgs): EmitterMode {
  const modeFlag =
    (parsed.flags.json && "json") ||
    (parsed.flags.ndjson && "ndjson") ||
    (parsed.flags.pretty && "pretty");
  return (modeFlag as EmitterMode) ?? defaultMode(process.stdout.isTTY === true);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: flat command routing table is clearer than indirection
async function dispatch(parsed: ParsedArgs, emitter: Emitter): Promise<number> {
  if (!parsed.command || parsed.command === "help" || parsed.flags.help) {
    emitter.emit({
      type: "help",
      commands: [
        "init",
        "daemon",
        "db sql",
        "awaken",
        "reindex",
        "search",
        "vitals",
        "health",
        "chat",
        "ask",
        "brief",
        "distill",
        "events",
        "session",
        "graph",
        "links",
        "backup",
        "restore",
        "nuke",
        "migrate-vault",
      ],
      note: "Phase C surface plus Phase D1 agent.ask + agent.brief + agent.distill + agent.events + session grants and Phase 5 graph/links/backup/restore/nuke/migrate-vault operator verbs; richer surface lands in Phases D-E.",
    });
    return 0;
  }

  const clientIdentity = resolveClientIdentity(parsed);

  if (parsed.command === "init") return await dispatchInit(parsed, emitter);
  if (parsed.command === "daemon") return await dispatchDaemon(parsed, emitter, clientIdentity);
  if (parsed.command === "db") return await dispatchDbSql(parsed, emitter);
  if (parsed.command === "awaken") return await dispatchAwaken(parsed, emitter, clientIdentity);
  if (parsed.command === "reindex") return await dispatchReindex(parsed, emitter, clientIdentity);
  if (parsed.command === "search") return await dispatchSearch(parsed, emitter, clientIdentity);
  if (parsed.command === "vitals") return await dispatchVitals(parsed, emitter, clientIdentity);
  if (parsed.command === "health") return await dispatchHealth(parsed, emitter, clientIdentity);
  if (parsed.command === "chat") return await dispatchChat(parsed, emitter, clientIdentity);
  if (parsed.command === "ask") return await dispatchAsk(parsed, emitter, clientIdentity);
  if (parsed.command === "brief") return await dispatchBrief(parsed, emitter, clientIdentity);
  if (parsed.command === "distill") return await dispatchDistill(parsed, emitter, clientIdentity);
  if (parsed.command === "events") return await dispatchEvents(parsed, emitter, clientIdentity);
  if (parsed.command === "session") return await dispatchSession(parsed, emitter, clientIdentity);
  if (parsed.command === "graph") return await dispatchGraph(parsed, emitter, clientIdentity);
  if (parsed.command === "links") return await dispatchLinks(parsed, emitter, clientIdentity);
  if (parsed.command === "backup") return await dispatchBackup(parsed, emitter, clientIdentity);
  if (parsed.command === "restore") return await dispatchRestore(parsed, emitter, clientIdentity);
  if (parsed.command === "nuke") return await dispatchNuke(parsed, emitter, clientIdentity);
  if (parsed.command === "migrate-vault") {
    return await dispatchMigrateVault(parsed, emitter, clientIdentity);
  }

  emitter.emit({
    type: "error",
    code: "INVALID_PARAMS",
    message: `Unknown command: ${parsed.command}`,
  });
  return 2;
}

/**
 * Resolves the per-invocation client identity from the global `--as` flag.
 * Returns undefined when the flag is absent so the client omits the field
 * on the wire and the daemon applies its own `human` default.
 */
function resolveClientIdentity(parsed: ParsedArgs): string | undefined {
  const raw = parsed.flags.as;
  if (typeof raw !== "string") return undefined;
  return normalizeAgentId(raw);
}

async function dispatchInit(parsed: ParsedArgs, emitter: Emitter): Promise<number> {
  const vaultPathArg = parsed.positional[0];
  if (!vaultPathArg) throw new Error("init requires a vault path argument");
  const sqlWasmSource = await resolveSqlWasmSource();
  await runInit({ vaultPathArg, cwd: process.cwd(), emitter, sqlWasmSource });
  return 0;
}

async function dispatchDaemon(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const verb = parsed.positional[0] as "start" | "stop" | "status" | "list" | undefined;
  if (!verb) throw new Error("daemon requires a verb: start | stop | status | list");
  const vaultPath = await resolveVaultForDaemon(parsed);
  await runDaemonCommand({ verb, vaultPath, emitter, clientIdentity });
  return 0;
}

async function dispatchDbSql(parsed: ParsedArgs, emitter: Emitter): Promise<number> {
  const sub = parsed.positional[0];
  if (sub !== "sql") {
    emitter.emit({
      type: "error",
      code: "INVALID_PARAMS",
      message: "usage: notient db sql",
    });
    return 2;
  }
  const vaultPath = await requireVault(parsed);
  return await runDbSqlCommand({ vaultPath });
}

async function dispatchAwaken(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const mode = selectAwakenMode(parsed);
  if (mode !== undefined) {
    return await runAwakenCommand({ vaultPath, mode, emitter, clientIdentity });
  }
  const batch = typeof parsed.flags.batch === "string" ? Number(parsed.flags.batch) : undefined;
  const since = typeof parsed.flags.since === "string" ? Date.parse(parsed.flags.since) : undefined;
  return await runAwakenCommand({ vaultPath, batch, since, emitter, clientIdentity });
}

function selectAwakenMode(parsed: ParsedArgs): AwakenControlMode | undefined {
  // Mutually exclusive control flags. When more than one is set the first
  // match in this priority order wins; the alternatives are silently
  // ignored. The CLI does not validate combinations because control flags
  // and the default fresh-run flags (`--batch`, `--since`) are themselves
  // disjoint and the daemon would reject an unknown combination upstream.
  if (parsed.flags.pause === true) return "pause";
  if (parsed.flags.resume === true) return "resume";
  if (parsed.flags.cancel === true) return "cancel";
  if (parsed.flags.status === true) return "status";
  return undefined;
}

async function dispatchReindex(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const pattern = parsed.positional[0] ?? "**/*.md";
  await runReindexCommand({ vaultPath, pattern, emitter, clientIdentity });
  return 0;
}

async function dispatchSearch(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const query =
    parsed.positional[0] ?? (typeof parsed.flags.query === "string" ? parsed.flags.query : "");
  if (!query) throw new Error("search requires a query positional or --query flag");
  const mode = (parsed.flags.mode as "quick" | "balanced" | "deep") ?? "balanced";
  const limit = typeof parsed.flags.limit === "string" ? Number(parsed.flags.limit) : undefined;
  await runSearchCommand({ vaultPath, query, mode, limit, emitter, clientIdentity });
  return 0;
}

async function dispatchVitals(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const notePath = parsed.positional[0];
  if (!notePath) throw new Error("vitals requires a note path positional");
  await runVitalsCommand({ vaultPath, notePath, emitter, clientIdentity });
  return 0;
}

async function dispatchHealth(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  await runHealthCommand({ vaultPath, emitter, clientIdentity });
  return 0;
}

async function dispatchChat(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const prompt =
    parsed.positional[0] ?? (typeof parsed.flags.prompt === "string" ? parsed.flags.prompt : "");
  const approveFlag = parsed.flags.approve;
  const approve: "auto" | "ask" = approveFlag === "ask" ? "ask" : "auto";
  if (prompt.length === 0) {
    if (!process.stdout.isTTY) {
      throw new Error(
        "INVALID_PARAMS: chat without a prompt requires a TTY (or pass a positional prompt)",
      );
    }
    await runChatTui({ vaultPath, emitter, clientIdentity });
    return 0;
  }
  await runChatSingleShot({ vaultPath, prompt, approve, emitter, clientIdentity });
  return 0;
}

async function dispatchAsk(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const intent = parsed.positional.join(" ").trim();
  if (intent.length === 0) {
    throw new Error('INVALID_PARAMS: ask requires a positional intent (e.g. notient ask "...")');
  }
  const format = parseAskFormat(parsed.flags.format);
  const maxRoundsPerTurn = parseAskMaxRounds(parsed.flags["max-rounds"]);
  return await runAskCommand({
    vaultPath,
    intent,
    format,
    maxRoundsPerTurn,
    emitter,
    clientIdentity,
  });
}

async function dispatchBrief(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const fileFlag = parsed.flags.file;
  const filePath = typeof fileFlag === "string" ? fileFlag : undefined;
  const positionalTopic = parsed.positional.join(" ").trim();
  const topic = positionalTopic.length > 0 ? positionalTopic : undefined;
  if (topic !== undefined && filePath !== undefined) {
    throw new Error("INVALID_PARAMS: brief accepts a topic OR --file, not both");
  }
  if (topic === undefined && filePath === undefined) {
    throw new Error('INVALID_PARAMS: brief requires a topic or --file (e.g. notient brief "auth")');
  }
  const maxNotes = parseBriefMaxField(parsed.flags["max-notes"], "max-notes");
  const maxQuestions = parseBriefMaxField(parsed.flags["max-questions"], "max-questions");
  const maxDecisions = parseBriefMaxField(parsed.flags["max-decisions"], "max-decisions");
  return await runBriefCommand({
    vaultPath,
    topic,
    filePath,
    maxNotes,
    maxQuestions,
    maxDecisions,
    emitter,
    clientIdentity,
  });
}

async function dispatchDistill(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const fromFlag = parsed.flags.from;
  if (typeof fromFlag !== "string" || fromFlag.length === 0) {
    throw new Error(
      "INVALID_PARAMS: distill requires --from <path> (e.g. notient distill --from session.md)",
    );
  }
  const format = parseDistillFormat(parsed.flags.format);
  const dryRun = parsed.flags["dry-run"] === true;
  return await runDistillCommand({
    vaultPath,
    transcriptPath: fromFlag,
    format,
    dryRun,
    emitter,
    clientIdentity,
  });
}

async function dispatchEvents(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const since = parseEventsSince(parsed.flags.since);
  const limit = parseEventsPositiveInt(parsed.flags.limit, "limit");
  const longPollMs = parseEventsLongPollMs(parsed.flags["long-poll-ms"]);
  const noPoll = parsed.flags["no-poll"] === true;
  return await runEventsCommand({
    vaultPath,
    since,
    limit,
    longPollMs,
    noPoll,
    emitter,
    clientIdentity,
  });
}

async function dispatchSession(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const subcommand = parseSessionSubcommand(parsed.positional[0]);
  if (subcommand === "grant") {
    const client = typeof parsed.flags.client === "string" ? parsed.flags.client : undefined;
    const folders = parseSessionFolders(parsed.flags.folders);
    const tools = parseSessionTools(parsed.flags.tools);
    const ttlMinutes = parseSessionPositiveInt(parsed.flags.ttl, "ttl");
    const maxWrites = parseSessionOptionalPositiveInt(parsed.flags["max-writes"], "max-writes");
    return await runSessionCommand({
      vaultPath,
      subcommand: "grant",
      client,
      folders,
      tools,
      maxWrites,
      ttlMinutes,
      emitter,
      clientIdentity,
    });
  }
  if (subcommand === "revoke") {
    const sessionIdRaw = parsed.positional[1] ?? parsed.flags["session-id"];
    const sessionId = parseSessionId(sessionIdRaw);
    return await runSessionCommand({
      vaultPath,
      subcommand: "revoke",
      sessionId,
      emitter,
      clientIdentity,
    });
  }
  const client = typeof parsed.flags.client === "string" ? parsed.flags.client : undefined;
  const includeExpired = parsed.flags["include-expired"] === true;
  return await runSessionCommand({
    vaultPath,
    subcommand: "list",
    client,
    includeExpired,
    emitter,
    clientIdentity,
  });
}

function parseSessionSubcommand(raw: string | undefined): SessionSubcommand {
  if (raw === "grant" || raw === "list" || raw === "revoke") return raw;
  throw new Error("INVALID_PARAMS: session requires a subcommand: grant | list | revoke");
}

async function dispatchGraph(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const subcommand = parsed.positional[0];
  if (subcommand === "dump") {
    const vaultPath = await requireVault(parsed);
    const tier = parseDumpTier(parsed.flags.tier);
    const format: DumpFormat = parseDumpFormat(parsed.flags.format);
    const outFlag = parsed.flags.out;
    const outPath = typeof outFlag === "string" && outFlag.length > 0 ? outFlag : undefined;
    return await runGraphDumpCommand({
      vaultPath,
      tier,
      format,
      outPath,
      emitter,
      clientIdentity,
    });
  }
  if (subcommand === "stats") {
    const vaultPath = await requireVault(parsed);
    const asJson = parsed.flags.json === true;
    return await runGraphStatsCommand({ vaultPath, asJson, emitter, clientIdentity });
  }
  emitter.emit({
    type: "error",
    code: "INVALID_PARAMS",
    message: "usage: notient graph dump|stats",
  });
  return 2;
}

async function dispatchLinks(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const subcommand = parsed.positional[0];
  if (subcommand === "sync") {
    const vaultPath = await requireVault(parsed);
    return await runLinksSyncCommand({
      vaultPath,
      vaultRoot: vaultPath,
      emitter,
      clientIdentity,
    });
  }
  if (subcommand === "audit") {
    const vaultPath = await requireVault(parsed);
    const mode = selectLinksAuditMode(parsed);
    return await runLinksAuditCommand({ vaultPath, mode, emitter, clientIdentity });
  }
  emitter.emit({
    type: "error",
    code: "INVALID_PARAMS",
    message: "usage: notient links sync|audit",
  });
  return 2;
}

function selectLinksAuditMode(parsed: ParsedArgs): LinksAuditMode {
  if (parsed.flags.json === true) return "json";
  if (parsed.flags.pretty === true) return "pretty";
  if (parsed.flags.ndjson === true) return "ndjson";
  return process.stdout.isTTY === true ? "pretty" : "ndjson";
}

async function dispatchBackup(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const outFlag = parsed.flags.out;
  const outPath = typeof outFlag === "string" && outFlag.length > 0 ? outFlag : undefined;
  return await runBackupCommand({ vaultPath, outPath, emitter, clientIdentity });
}

async function dispatchRestore(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const inputPath = parsed.positional[0];
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new Error("INVALID_PARAMS: restore requires a positional path to a .surql file");
  }
  return await runRestoreCommand({ vaultPath, inputPath, emitter, clientIdentity });
}

async function dispatchNuke(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const yes = parsed.flags.yes === true;
  return await runNukeCommand({ vaultPath, yes, emitter, clientIdentity });
}

async function dispatchMigrateVault(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const sourceVaultPath = await requireVault(parsed);
  const targetVaultPath = parsed.positional[0];
  if (typeof targetVaultPath !== "string" || targetVaultPath.length === 0) {
    throw new Error(
      "INVALID_PARAMS: migrate-vault requires a positional new-absolute-path argument",
    );
  }
  return await runMigrateVaultCommand({
    sourceVaultPath,
    targetVaultPath,
    emitter,
    clientIdentity,
  });
}

async function requireVault(parsed: ParsedArgs): Promise<string> {
  const vaultPath = await resolveVaultForDaemon(parsed);
  if (!vaultPath) {
    throw new Error(
      "No vault. Pass --vault, set NOTIENT_VAULT, or run 'notient init <path>' first.",
    );
  }
  return vaultPath;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const emitter = makeEmitter({ mode: selectMode(parsed) });
  try {
    return await dispatch(parsed, emitter);
  } catch (error) {
    emitter.emit({
      type: "error",
      code: "INTERNAL",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

async function resolveVaultForDaemon(parsed: ParsedArgs): Promise<string | null> {
  const flagVault = typeof parsed.flags.vault === "string" ? parsed.flags.vault : null;
  try {
    return await resolveVault({
      flagVault,
      env: process.env as Record<string, string | undefined>,
      cwd: process.cwd(),
      stateLoader: defaultStateLoader(),
    });
  } catch {
    return null;
  }
}

async function resolveSqlWasmSource(): Promise<string> {
  const candidate = new URL("../../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url);
  return candidate.pathname;
}

void main(process.argv.slice(2)).then((code) => {
  process.exit(code);
});
