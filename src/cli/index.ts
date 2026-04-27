import { runAwakenCommand } from "./commands/awaken";
import { runDaemonCommand } from "./commands/daemon";
import { runHealthCommand } from "./commands/health";
import { runInit } from "./commands/init";
import { runReindexCommand } from "./commands/reindex";
import { runSearchCommand } from "./commands/search";
import { runVitalsCommand } from "./commands/vitals";
import { defaultStateLoader, resolveVault } from "./env";
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

async function dispatch(parsed: ParsedArgs, emitter: Emitter): Promise<number> {
  if (!parsed.command || parsed.command === "help" || parsed.flags.help) {
    emitter.emit({
      type: "help",
      commands: ["init", "daemon", "awaken", "reindex", "search", "vitals", "health"],
      note: "Phase B surface; richer surface lands in Phases C-E.",
    });
    return 0;
  }

  if (parsed.command === "init") return await dispatchInit(parsed, emitter);
  if (parsed.command === "daemon") return await dispatchDaemon(parsed, emitter);
  if (parsed.command === "awaken") return await dispatchAwaken(parsed, emitter);
  if (parsed.command === "reindex") return await dispatchReindex(parsed, emitter);
  if (parsed.command === "search") return await dispatchSearch(parsed, emitter);
  if (parsed.command === "vitals") return await dispatchVitals(parsed, emitter);
  if (parsed.command === "health") return await dispatchHealth(parsed, emitter);

  emitter.emit({
    type: "error",
    code: "INVALID_PARAMS",
    message: `Unknown command: ${parsed.command}`,
  });
  return 2;
}

async function dispatchInit(parsed: ParsedArgs, emitter: Emitter): Promise<number> {
  const vaultPathArg = parsed.positional[0];
  if (!vaultPathArg) throw new Error("init requires a vault path argument");
  const sqlWasmSource = await resolveSqlWasmSource();
  await runInit({ vaultPathArg, cwd: process.cwd(), emitter, sqlWasmSource });
  return 0;
}

async function dispatchDaemon(parsed: ParsedArgs, emitter: Emitter): Promise<number> {
  const verb = parsed.positional[0] as "start" | "stop" | "status" | "list" | undefined;
  if (!verb) throw new Error("daemon requires a verb: start | stop | status | list");
  const vaultPath = await resolveVaultForDaemon(parsed);
  await runDaemonCommand({ verb, vaultPath, emitter });
  return 0;
}

async function dispatchAwaken(parsed: ParsedArgs, emitter: Emitter): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const batch = typeof parsed.flags.batch === "string" ? Number(parsed.flags.batch) : undefined;
  const since = typeof parsed.flags.since === "string" ? Date.parse(parsed.flags.since) : undefined;
  await runAwakenCommand({ vaultPath, batch, since, emitter });
  return 0;
}

async function dispatchReindex(parsed: ParsedArgs, emitter: Emitter): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const pattern = parsed.positional[0] ?? "**/*.md";
  await runReindexCommand({ vaultPath, pattern, emitter });
  return 0;
}

async function dispatchSearch(parsed: ParsedArgs, emitter: Emitter): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const query =
    parsed.positional[0] ?? (typeof parsed.flags.query === "string" ? parsed.flags.query : "");
  if (!query) throw new Error("search requires a query positional or --query flag");
  const mode = (parsed.flags.mode as "quick" | "balanced" | "deep") ?? "balanced";
  const limit = typeof parsed.flags.limit === "string" ? Number(parsed.flags.limit) : undefined;
  await runSearchCommand({ vaultPath, query, mode, limit, emitter });
  return 0;
}

async function dispatchVitals(parsed: ParsedArgs, emitter: Emitter): Promise<number> {
  const vaultPath = await requireVault(parsed);
  const notePath = parsed.positional[0];
  if (!notePath) throw new Error("vitals requires a note path positional");
  await runVitalsCommand({ vaultPath, notePath, emitter });
  return 0;
}

async function dispatchHealth(parsed: ParsedArgs, emitter: Emitter): Promise<number> {
  const vaultPath = await requireVault(parsed);
  await runHealthCommand({ vaultPath, emitter });
  return 0;
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
