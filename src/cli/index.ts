import { createInterface } from "node:readline/promises";
import { normalizeAgentId } from "../core/auth/agentIdentity";
import { VERSION } from "../version";
import { runAnalysisCommand } from "./commands/analysis";
import { runApiCommand } from "./commands/api";
import { parseAskFormat, parseAskMaxRounds, parseAskScope, runAskCommand } from "./commands/ask";
import {
  type AwakenControlMode,
  parseAwakenSince,
  parseTierCsv,
  runAwakenCommand,
} from "./commands/awaken";
import { runBackupCommand } from "./commands/backup";
import { parseBriefMaxField, runBriefCommand } from "./commands/brief";
import { runChatSingleShot, runChatTui } from "./commands/chat";
import { runDaemonCommand } from "./commands/daemon";
import { runDbSqlCommand } from "./commands/dbSql";
import { parseDistillFormat, runDistillCommand } from "./commands/distill";
import { runDoctorCommand } from "./commands/doctor";
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
import { parseHistoryLimit, runHistoryCommand } from "./commands/history";
import { runInit } from "./commands/init";
import { type LinksAuditMode, runLinksAuditCommand } from "./commands/linksAudit";
import { runLinksSyncCommand } from "./commands/linksSync";
import { MCP_DEFAULT_AGENT_ID, runMcpCommand } from "./commands/mcp";
import { runNukeCommand } from "./commands/nuke";
import {
  runProposalsApproveCommand,
  runProposalsListCommand,
  runProposalsRejectCommand,
} from "./commands/proposalsCli";
import { ReindexPatternError, resolveReindexPattern, runReindexCommand } from "./commands/reindex";
import { runRestoreCommand } from "./commands/restore";
import { parseSearchMode, runSearchCommand } from "./commands/search";
import { runServiceCommand } from "./commands/service";
import {
  type SessionSubcommand,
  parseSessionFolders,
  parseSessionId,
  parseSessionOptionalPositiveInt,
  parseSessionPositiveInt,
  parseSessionTools,
  runSessionCommand,
} from "./commands/session";
import { runSetupCommand } from "./commands/setup";
import { runVitalsCommand } from "./commands/vitals";
import { defaultStateLoader, resolveVault } from "./env";
import { type Emitter, type EmitterMode, defaultMode, makeEmitter } from "./output";
import { selectRootEntry } from "./rootEntry";

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
  const selected: EmitterMode[] = [];
  for (const mode of ["json", "ndjson", "pretty"] as const) {
    const value = parsed.flags[mode];
    if (value === undefined) continue;
    if (value !== true) throw new Error(`INVALID_PARAMS: --${mode} does not accept a value`);
    selected.push(mode);
  }
  if (selected.length > 1) {
    throw new Error("INVALID_PARAMS: output mode flags are mutually exclusive");
  }
  return selected[0] ?? defaultMode(process.stdout.isTTY === true);
}

const COMMAND_NAMES = [
  "api",
  "jobs",
  "pipelines",
  "pair",
  "init",
  "setup",
  "daemon",
  "db",
  "awaken",
  "reindex",
  "search",
  "vitals",
  "health",
  "doctor",
  "history",
  "undo",
  "chat",
  "ask",
  "brief",
  "compare",
  "correlate",
  "distill",
  "events",
  "session",
  "mcp",
  "graph",
  "links",
  "proposals",
  "backup",
  "restore",
  "nuke",
] as const;

type CommandName = (typeof COMMAND_NAMES)[number];

interface DispatchContext {
  parsed: ParsedArgs;
  emitter: Emitter;
  clientIdentity: string | undefined;
}

type CommandDispatcher = (context: DispatchContext) => Promise<number>;

const COMMAND_DISPATCHERS = {
  compare: ({ parsed, emitter, clientIdentity }) =>
    dispatchAnalysis(parsed, emitter, clientIdentity, "compare"),
  correlate: ({ parsed, emitter, clientIdentity }) =>
    dispatchAnalysis(parsed, emitter, clientIdentity, "correlate"),
  init: ({ parsed, emitter }) => dispatchInit(parsed, emitter),
  setup: ({ parsed, emitter }) => dispatchSetup(parsed, emitter),
  daemon: ({ parsed, emitter, clientIdentity }) => dispatchDaemon(parsed, emitter, clientIdentity),
  api: ({ parsed, emitter, clientIdentity }) => dispatchApi(parsed, emitter, clientIdentity),
  jobs: ({ parsed, emitter, clientIdentity }) => dispatchJobs(parsed, emitter, clientIdentity),
  pipelines: ({ parsed, emitter, clientIdentity }) =>
    dispatchPipelines(parsed, emitter, clientIdentity),
  pair: ({ parsed, emitter, clientIdentity }) => dispatchPair(parsed, emitter, clientIdentity),
  db: ({ parsed, emitter }) => dispatchDbSql(parsed, emitter),
  awaken: ({ parsed, emitter, clientIdentity }) => dispatchAwaken(parsed, emitter, clientIdentity),
  reindex: ({ parsed, emitter, clientIdentity }) =>
    dispatchReindex(parsed, emitter, clientIdentity),
  search: ({ parsed, emitter, clientIdentity }) => dispatchSearch(parsed, emitter, clientIdentity),
  vitals: ({ parsed, emitter, clientIdentity }) => dispatchVitals(parsed, emitter, clientIdentity),
  health: ({ parsed, emitter, clientIdentity }) => dispatchHealth(parsed, emitter, clientIdentity),
  doctor: ({ parsed, emitter, clientIdentity }) => dispatchDoctor(parsed, emitter, clientIdentity),
  history: ({ parsed, emitter, clientIdentity }) =>
    dispatchHistory(parsed, emitter, clientIdentity),
  undo: ({ parsed, emitter, clientIdentity }) => dispatchUndo(parsed, emitter, clientIdentity),
  chat: ({ parsed, emitter, clientIdentity }) => dispatchChat(parsed, emitter, clientIdentity),
  ask: ({ parsed, emitter, clientIdentity }) => dispatchAsk(parsed, emitter, clientIdentity),
  brief: ({ parsed, emitter, clientIdentity }) => dispatchBrief(parsed, emitter, clientIdentity),
  distill: ({ parsed, emitter, clientIdentity }) =>
    dispatchDistill(parsed, emitter, clientIdentity),
  events: ({ parsed, emitter, clientIdentity }) => dispatchEvents(parsed, emitter, clientIdentity),
  session: ({ parsed, emitter, clientIdentity }) =>
    dispatchSession(parsed, emitter, clientIdentity),
  mcp: ({ parsed }) => dispatchMcp(parsed),
  graph: ({ parsed, emitter, clientIdentity }) => dispatchGraph(parsed, emitter, clientIdentity),
  links: ({ parsed, emitter, clientIdentity }) => dispatchLinks(parsed, emitter, clientIdentity),
  proposals: ({ parsed, emitter, clientIdentity }) =>
    dispatchProposals(parsed, emitter, clientIdentity),
  backup: ({ parsed, emitter, clientIdentity }) => dispatchBackup(parsed, emitter, clientIdentity),
  restore: ({ parsed, emitter, clientIdentity }) =>
    dispatchRestore(parsed, emitter, clientIdentity),
  nuke: ({ parsed, emitter, clientIdentity }) => dispatchNuke(parsed, emitter, clientIdentity),
} satisfies Record<CommandName, CommandDispatcher>;

const COMMAND_NAME_SET: ReadonlySet<string> = new Set(COMMAND_NAMES);

function isCommandName(command: string): command is CommandName {
  return COMMAND_NAME_SET.has(command);
}

async function dispatch(parsed: ParsedArgs, emitter: Emitter): Promise<number> {
  const rootEntry = selectRootEntry({
    command: parsed.command,
    helpRequested: parsed.flags.help === true,
    versionRequested: parsed.flags.version === true,
    outputModeRequested: ["json", "ndjson", "pretty"].some(
      (mode) => parsed.flags[mode] !== undefined,
    ),
    stdinIsTty: process.stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
  });
  if (rootEntry === "help") return emitRootHelp(emitter);
  if (rootEntry === "version") return emitVersion(emitter);
  if (rootEntry === "tui") {
    return await dispatchChat({ ...parsed, command: "chat" }, emitter, undefined);
  }
  const command = parsed.command;
  if (command === null) throw new Error("INTERNAL: command root entry did not select a command");
  if (parsed.flags.help === true) return printVerbHelp(command, emitter);

  // Preserve identity validation before command lookup: an invalid global
  // principal is invalid even when the command token is unknown.
  const clientIdentity = resolveClientIdentity(parsed);
  if (!isCommandName(command)) return emitUnknownCommand(command, emitter);

  return await COMMAND_DISPATCHERS[command]({ parsed, emitter, clientIdentity });
}

function emitVersion(emitter: Emitter): number {
  emitter.emit({ type: "version", version: VERSION });
  return 0;
}

function emitRootHelp(emitter: Emitter): number {
  emitter.emit({
    type: "help",
    commands: COMMAND_NAMES.map((command) => (command === "db" ? "db sql" : command)),
    note: "Local-first CLI where the notes become sentient: search, converse, awaken, and inspect their graph over one vault daemon.",
  });
  return 0;
}

function emitUnknownCommand(command: string, emitter: Emitter): number {
  emitter.emit({
    type: "error",
    code: "INVALID_PARAMS",
    message: `Unknown command: ${command}`,
  });
  return 2;
}

interface VerbHelp {
  usage: string;
  flags: string[];
}

const VERB_HELP: Record<string, VerbHelp> = {
  compare: {
    usage:
      'notient compare "First note.md" "Second note.md" --question "What differs?" --vault <path>',
    flags: ["--question <focus>", "--vault <path>", "--as <agent>", "--pretty|--json"],
  },
  correlate: {
    usage: 'notient correlate "Source note.md" --vault <path>',
    flags: [
      "--folder <scope including the source>",
      "--vault <path>",
      "--as <agent>",
      "--pretty|--json",
    ],
  },
  api: {
    usage: "notient api <operation> --input <JSON> --vault <path>",
    flags: ["--input <JSON>", "--vault <path>", "--as <agent>"],
  },
  pair: {
    usage: "notient pair create|list|revoke --vault <path>",
    flags: [
      "--label <client name>",
      "--kind human|agent",
      "--scopes read,write,host",
      "--id <credential id>",
      "--vault <path>",
    ],
  },
  init: {
    usage: "notient init <vault>",
    flags: [],
  },
  setup: {
    usage:
      "notient setup [vault] [--endpoint <url>] [--model <id>] [--embed-endpoint <url>] [--embed-model <id>] [--yes]",
    flags: [
      "--endpoint <OpenAI-compatible base URL>",
      "--model <id>",
      "--embed-endpoint <url>",
      "--embed-model <id>",
      "--yes (never prompt)",
      "--json",
      "--pretty",
    ],
  },
  daemon: {
    usage:
      "notient daemon start|stop|status|list --vault <path>; notient daemon service install|status|uninstall --vault <path>",
    flags: ["--vault <path>", "--as <agent>"],
  },
  db: {
    usage: "notient db sql --vault <path>",
    flags: ["--vault <path>"],
  },
  awaken: {
    usage: "notient awaken --vault <path> [--since ISO] [--tier 1,2,3]",
    flags: [
      "--vault <path>",
      "--since <datetime>",
      "--tier <csv>",
      "--background",
      "--pause",
      "--resume",
      "--cancel",
      "--status",
    ],
  },
  reindex: {
    usage: "notient reindex [<glob>] --vault <path> [--pattern <glob>] [--tier 1,2,3]",
    flags: ["--vault <path>", "--pattern <glob>", "--tier <csv>"],
  },
  search: {
    usage: "notient search <query> --vault <path> [--mode quick|balanced|deep] [--limit N]",
    flags: ["--vault <path>", "--query <text>", "--mode <mode>", "--limit <number>"],
  },
  vitals: {
    usage: "notient vitals <note-path> --vault <path>",
    flags: ["--vault <path>"],
  },
  health: {
    usage: "notient health --vault <path>",
    flags: ["--vault <path>"],
  },
  doctor: {
    usage: "notient doctor --vault <path> [--json]",
    flags: ["--vault <path>", "--json", "--pretty"],
  },
  history: {
    usage: "notient history --vault <path> [--limit N]",
    flags: ["--vault <path>", "--limit <number>"],
  },
  undo: {
    usage: "notient undo [historyId] --vault <path>",
    flags: ["--vault <path>"],
  },
  chat: {
    usage: "notient chat [prompt] --vault <path> [--approve auto|ask]",
    flags: ["--vault <path>", "--prompt <text>", "--approve <mode>"],
  },
  ask: {
    usage:
      "notient ask <intent> --vault <path> [--format structured|text] [--max-rounds N] [--folder path] [--note path.md]",
    flags: [
      "--vault <path>",
      "--format <format>",
      "--max-rounds <number>",
      "--folder <path>",
      "--note <path>",
    ],
  },
  brief: {
    usage: "notient brief <topic> | --file <path> --vault <path>",
    flags: ["--vault <path>", "--file <path>", "--max-notes <number>", "--folder <path>"],
  },
  distill: {
    usage: "notient distill --from <transcript.md> --vault <path> [--dry-run]",
    flags: ["--vault <path>", "--from <path>", "--format <format>", "--dry-run"],
  },
  events: {
    usage: 'notient events --vault <path> [--since <agent_event:u"uuid">] [--no-poll]',
    flags: [
      "--vault <path>",
      '--since <agent_event:u"uuid">',
      "--limit <number>",
      "--long-poll-ms <ms>",
      "--no-poll",
    ],
  },
  session: {
    usage: "notient session list|grant|revoke --vault <path>",
    flags: [
      "--vault <path>",
      "--client <id>",
      "--folders <csv>",
      "--tools <csv>",
      "--ttl <minutes>",
      "--max-writes <number>",
      "--session-id <id>",
    ],
  },
  jobs: {
    usage:
      "notient jobs list|get|pause|resume|cancel|retry [id] [--revision <sha256> --idempotency-key <key>] --vault <path>",
    flags: [
      "--vault <path>",
      "--pipeline <name>",
      "--state <state>",
      "--limit <number>",
      "--cursor <cursor>",
      "--revision <sha256>",
      "--idempotency-key <key>",
      "--as <agent-id>",
      "--json",
      "--ndjson",
    ],
  },
  pipelines: {
    usage:
      "notient pipelines list | run <pipeline> --sources <json-array> --idempotency-key <key> [--preview] --vault <path>",
    flags: [
      "--vault <path>",
      "--sources <json-array>",
      "--idempotency-key <key>",
      "--preview",
      "--as <agent-id>",
      "--ndjson",
    ],
  },
  mcp: {
    usage: "notient mcp --vault <path> [--as <agent-id>]",
    flags: ["--vault <path>", "--as <agent-id>"],
  },
  graph: {
    usage: "notient graph dump|stats --vault <path>",
    flags: ["--vault <path>", "--tier <number>", "--format <format>", "--out <path>", "--json"],
  },
  links: {
    usage: "notient links sync|audit --vault <path>",
    flags: ["--vault <path>", "--json", "--pretty", "--ndjson"],
  },
  proposals: {
    usage: "notient proposals list|approve|reject --vault <path>",
    flags: [
      "--vault <path>",
      "--note <path>",
      "--agent <id>",
      "--limit <number>",
      "--reason <text>",
      "--json",
    ],
  },
  backup: {
    usage: "notient backup --vault <path> [--out <file.surql>]",
    flags: ["--vault <path>", "--out <path>"],
  },
  restore: {
    usage: "notient restore <file.surql> --vault <path>",
    flags: ["--vault <path>"],
  },
  nuke: {
    usage: "notient nuke --vault <path> --yes",
    flags: ["--vault <path>", "--yes"],
  },
};

function printVerbHelp(command: string, emitter: Emitter): number {
  const help = VERB_HELP[command];
  if (help === undefined) {
    emitter.emit({
      type: "error",
      code: "INVALID_PARAMS",
      message: `Unknown command: ${command}`,
    });
    return 2;
  }
  emitter.emit({
    type: "help",
    command,
    usage: help.usage,
    flags: help.flags,
  });
  return 0;
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
  await runInit({ vaultPathArg, cwd: process.cwd(), emitter });
  return 0;
}

async function dispatchSetup(parsed: ParsedArgs, emitter: Emitter): Promise<number> {
  const text = (name: string) =>
    typeof parsed.flags[name] === "string" ? (parsed.flags[name] as string) : undefined;
  // `--yes <vault>` parses the folder as the flag's value; accept it as the vault.
  const vaultPathArg = parsed.positional[0] ?? text("vault") ?? text("yes");
  const prompts = process.stdin.isTTY === true && parsed.flags.yes === undefined;
  const terminal = prompts
    ? createInterface({ input: process.stdin, output: process.stderr })
    : null;
  try {
    return await runSetupCommand({
      vaultPathArg,
      cwd: process.cwd(),
      emitter,
      endpoint: text("endpoint"),
      model: text("model"),
      embedEndpoint: text("embed-endpoint"),
      embedModel: text("embed-model"),
      ask: terminal ? (question) => terminal.question(question) : undefined,
    });
  } finally {
    terminal?.close();
  }
}

async function dispatchJobs(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity?: string,
): Promise<number> {
  const verb = parsed.positional[0] ?? "list";
  const control = ["pause", "resume", "cancel", "retry"].includes(verb);
  if (!["list", "get", "pause", "resume", "cancel", "retry"].includes(verb))
    throw new Error("INVALID_PARAMS: jobs expects list, get, pause, resume, cancel or retry");
  const input: Record<string, unknown> = verb === "list" ? {} : { id: parsed.positional[1] };
  if (control)
    Object.assign(input, {
      action: verb,
      revision: parsed.flags.revision,
      idempotencyKey: parsed.flags["idempotency-key"],
    });
  if (parsed.positional.length > (verb === "list" ? 1 : 2))
    throw new Error("INVALID_PARAMS: unexpected jobs argument");
  for (const key of ["pipeline", "state", "limit", "cursor"] as const) {
    const value = parsed.flags[key];
    if (value === undefined) continue;
    if (verb !== "list" || typeof value !== "string")
      throw new Error(`INVALID_PARAMS: --${key} requires a value for jobs list`);
    input[key] = key === "limit" ? Number(value) : value;
  }
  return runApiCommand({
    method: control ? "jobs.control" : `jobs.${verb}`,
    input,
    emitter,
    clientIdentity,
    vaultPath: await requireVault(parsed),
  });
}

async function dispatchPipelines(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity?: string,
): Promise<number> {
  const verb = parsed.positional[0] ?? "list";
  if (!["list", "run"].includes(verb))
    throw new Error("INVALID_PARAMS: pipelines expects list or run");
  if (parsed.positional.length > (verb === "list" ? 1 : 2))
    throw new Error("INVALID_PARAMS: unexpected pipelines argument");
  let input: Record<string, unknown> = {};
  if (verb === "run") {
    if (typeof parsed.flags.sources !== "string")
      throw new Error("INVALID_PARAMS: --sources requires a JSON array of {path, revision}");
    if (parsed.flags.preview !== undefined && parsed.flags.preview !== true)
      throw new Error("INVALID_PARAMS: --preview does not accept a value");
    input = {
      pipeline: parsed.positional[1],
      sources: JSON.parse(parsed.flags.sources),
      idempotencyKey: parsed.flags["idempotency-key"],
      preview: parsed.flags.preview === true,
    };
  }
  return runApiCommand({
    method: `pipelines.${verb}`,
    input,
    emitter,
    clientIdentity,
    vaultPath: await requireVault(parsed),
  });
}

async function dispatchApi(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity?: string,
): Promise<number> {
  const method = parsed.positional[0];
  if (!method) throw new Error("INVALID_PARAMS: API operation required");
  const input = typeof parsed.flags.input === "string" ? JSON.parse(parsed.flags.input) : {};
  return runApiCommand({
    method,
    input,
    emitter,
    clientIdentity,
    vaultPath: await requireVault(parsed),
  });
}
async function dispatchPair(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity?: string,
): Promise<number> {
  const action = parsed.positional[0];
  if (action !== "create" && action !== "list" && action !== "revoke")
    throw new Error("INVALID_PARAMS: pair requires create | list | revoke");
  const kind = parsed.flags.kind ?? "human";
  const scopes =
    typeof parsed.flags.scopes === "string"
      ? parsed.flags.scopes.split(",")
      : kind === "human"
        ? ["read", "write", "host"]
        : ["read", "write"];
  const input =
    action === "create"
      ? { label: parsed.flags.label ?? "Obsidian desktop", kind, scopes }
      : action === "revoke"
        ? { id: parsed.flags.id }
        : {};
  return runApiCommand({
    method: `pairing.${action}`,
    input,
    emitter,
    clientIdentity,
    vaultPath: await requireVault(parsed),
    pairing: true,
  });
}

async function dispatchDaemon(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  if (parsed.positional[0] === "service") {
    const action = parsed.positional[1];
    if (action !== "install" && action !== "status" && action !== "uninstall")
      throw new Error("daemon service requires install | status | uninstall");
    const vaultPath = await resolveVaultForDaemon(parsed);
    if (!vaultPath) throw new Error("daemon service requires --vault");
    await runServiceCommand({ action, vaultPath, emitter, clientIdentity });
    return 0;
  }
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
  assertAwakenInvocation(parsed);
  const vaultPath = await requireVault(parsed);
  const mode = selectAwakenMode(parsed);
  if (mode !== undefined) {
    return await runAwakenCommand({ vaultPath, mode, emitter, clientIdentity });
  }
  const since = parseAwakenSince(parsed.flags.since);
  const tier = parsed.flags.tier === undefined ? undefined : parseTierCsv(parsed.flags.tier);
  const background = parsed.flags.background === true ? true : undefined;
  return await runAwakenCommand({
    vaultPath,
    since,
    tier,
    background,
    emitter,
    clientIdentity,
  });
}

function selectAwakenMode(parsed: ParsedArgs): AwakenControlMode | undefined {
  const selected = (["pause", "resume", "cancel", "status"] as const).filter(
    (mode) => parsed.flags[mode] === true,
  );
  if (selected.length > 1) {
    throw new Error("INVALID_PARAMS: awaken control flags are mutually exclusive");
  }
  return selected[0];
}

const AWAKEN_ALLOWED_FLAGS = new Set([
  "vault",
  "as",
  "json",
  "ndjson",
  "pretty",
  "help",
  "since",
  "tier",
  "background",
  "pause",
  "resume",
  "cancel",
  "status",
]);

function assertAwakenInvocation(parsed: ParsedArgs): void {
  if (parsed.positional.length > 0) {
    throw new Error("INVALID_PARAMS: awaken does not accept positional arguments");
  }
  const unsupported = Object.keys(parsed.flags).find((key) => !AWAKEN_ALLOWED_FLAGS.has(key));
  if (unsupported !== undefined) {
    throw new Error(`INVALID_PARAMS: awaken does not support --${unsupported}`);
  }
  for (const flag of ["background", "pause", "resume", "cancel", "status"] as const) {
    const value = parsed.flags[flag];
    if (value !== undefined && value !== true) {
      throw new Error(`INVALID_PARAMS: --${flag} does not accept a value`);
    }
  }
  const mode = selectAwakenMode(parsed);
  if (
    mode !== undefined &&
    (parsed.flags.since !== undefined ||
      parsed.flags.tier !== undefined ||
      parsed.flags.background !== undefined)
  ) {
    throw new Error("INVALID_PARAMS: awaken control flags cannot be combined with run options");
  }
}

async function dispatchReindex(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  let pattern: string;
  try {
    pattern = resolveReindexPattern({
      positionalPattern: parsed.positional[0],
      flagPattern: parsed.flags.pattern,
    });
  } catch (error) {
    if (error instanceof ReindexPatternError) {
      emitter.emit({
        type: "error",
        code: "INVALID_PARAMS",
        message: error.message,
      });
      return 2;
    }
    throw error;
  }
  const tier = parsed.flags.tier === undefined ? undefined : parseTierCsv(parsed.flags.tier);
  await runReindexCommand({ vaultPath, pattern, tier, emitter, clientIdentity });
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
  const mode = parseSearchMode(parsed.flags.mode);
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

async function dispatchDoctor(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  return runDoctorCommand({ vaultPath: await requireVault(parsed), emitter, clientIdentity });
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

async function dispatchHistory(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  return await runHistoryCommand({
    action: "list",
    vaultPath,
    limit: parseHistoryLimit(parsed.flags.limit),
    emitter,
    clientIdentity,
  });
}

async function dispatchUndo(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const historyId = parsed.positional[0];
  return await runHistoryCommand({
    action: "undo",
    vaultPath,
    historyId,
    emitter,
    clientIdentity,
  });
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

async function dispatchAnalysis(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
  kind: "compare" | "correlate",
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  if (
    (parsed.flags.question !== undefined && typeof parsed.flags.question !== "string") ||
    (parsed.flags.folder !== undefined && typeof parsed.flags.folder !== "string")
  )
    throw new Error("INVALID_PARAMS: question and folder require values");
  return runAnalysisCommand({
    vaultPath,
    paths: parsed.positional,
    kind,
    question: parsed.flags.question as string | undefined,
    folder: parsed.flags.folder as string | undefined,
    clientIdentity,
    emitter,
  });
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
    scope: parseAskScope(parsed.flags.folder, parsed.flags.note),
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
  if (fileFlag !== undefined && typeof fileFlag !== "string")
    throw new Error("INVALID_PARAMS: --file requires a saved note path");
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
  for (const flag of ["max-questions", "max-claims"])
    if (parsed.flags[flag] !== undefined)
      throw new Error(
        `INVALID_PARAMS: --${flag} is no longer supported; brief findings are selected by evidence.`,
      );
  if (parsed.flags.folder !== undefined && typeof parsed.flags.folder !== "string")
    throw new Error("INVALID_PARAMS: --folder requires a path");
  const folder = typeof parsed.flags.folder === "string" ? parsed.flags.folder : undefined;
  return await runBriefCommand({
    vaultPath,
    topic,
    filePath,
    maxNotes,
    folder,
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
  const noPoll = parsed.flags["no-poll"] === true;
  const since = parseEventsSince(parsed.flags.since);
  const limit = parseEventsPositiveInt(parsed.flags.limit, "limit");
  const longPollMs = parseEventsLongPollMs(parsed.flags["long-poll-ms"]);
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

async function dispatchProposals(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const subcommand = parsed.positional[0];
  if (subcommand === "list") return await dispatchProposalsList(parsed, emitter, clientIdentity);
  if (subcommand === "approve") {
    return await dispatchProposalsApprove(parsed, emitter, clientIdentity);
  }
  if (subcommand === "reject")
    return await dispatchProposalsReject(parsed, emitter, clientIdentity);
  emitter.emit({
    type: "error",
    code: "INVALID_PARAMS",
    message: "usage: notient proposals list|approve|reject",
  });
  return 2;
}

async function dispatchProposalsList(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const notePath =
    typeof parsed.flags.note === "string" && parsed.flags.note.length > 0
      ? parsed.flags.note
      : undefined;
  const agent =
    typeof parsed.flags.agent === "string" && parsed.flags.agent.length > 0
      ? parsed.flags.agent
      : undefined;
  let limit: number | undefined;
  if (typeof parsed.flags.limit === "string") {
    const parsedLimit = Number(parsed.flags.limit);
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      emitter.emit({
        type: "error",
        code: "INVALID_PARAMS",
        message: "proposals list: --limit must be a positive number",
      });
      return 2;
    }
    limit = Math.floor(parsedLimit);
  }
  return await runProposalsListCommand({
    vaultPath,
    emitter,
    asJson: parsed.flags.json === true,
    notePath,
    agent,
    limit,
    clientIdentity,
  });
}

async function dispatchProposalsApprove(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const id = parsed.positional[1];
  if (typeof id !== "string" || id.length === 0) {
    emitter.emit({
      type: "error",
      code: "INVALID_PARAMS",
      message: "proposals approve requires a positional id (e.g. supports:abc...)",
    });
    return 2;
  }
  const vaultPath = await requireVault(parsed);
  return await runProposalsApproveCommand({
    vaultPath,
    emitter,
    id,
    clientIdentity,
  });
}

async function dispatchProposalsReject(
  parsed: ParsedArgs,
  emitter: Emitter,
  clientIdentity: string | undefined,
): Promise<number> {
  const id = parsed.positional[1];
  if (typeof id !== "string" || id.length === 0) {
    emitter.emit({
      type: "error",
      code: "INVALID_PARAMS",
      message: "proposals reject requires a positional id (e.g. supports:abc...)",
    });
    return 2;
  }
  const vaultPath = await requireVault(parsed);
  const reason =
    typeof parsed.flags.reason === "string" && parsed.flags.reason.length > 0
      ? parsed.flags.reason
      : undefined;
  return await runProposalsRejectCommand({
    vaultPath,
    emitter,
    id,
    reason,
    clientIdentity,
  });
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

/**
 * `notient mcp` runs the MCP stdio server. stdout is the JSON-RPC channel,
 * so this dispatch deliberately bypasses the emitter and never prints there.
 * Identity defaults to `mcp-client` rather than `human`: the adapter is an
 * agent principal, so an absent `--as` must not fall through to the daemon's
 * human default.
 */
async function dispatchMcp(parsed: ParsedArgs): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const raw = parsed.flags.as;
  const clientIdentity = typeof raw === "string" ? normalizeAgentId(raw) : MCP_DEFAULT_AGENT_ID;
  return await runMcpCommand({ vaultPath, clientIdentity });
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
  let emitter = makeEmitter({ mode: defaultMode(process.stdout.isTTY === true) });
  try {
    emitter = makeEmitter({ mode: selectMode(parsed) });
    return await dispatch(parsed, emitter);
  } catch (error) {
    const event = {
      type: "error",
      code: "INTERNAL",
      message: error instanceof Error ? error.message : String(error),
    };
    if (parsed.command === "mcp") {
      process.stderr.write(`${JSON.stringify(event)}\n`);
    } else {
      emitter.emit(event);
    }
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

void main(process.argv.slice(2)).then((code) => {
  process.exit(code);
});
