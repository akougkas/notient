import { runDaemonCommand } from "./commands/daemon";
import { runInit } from "./commands/init";
import { defaultStateLoader, resolveVault } from "./env";
import { type EmitterMode, defaultMode, makeEmitter } from "./output";

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

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const modeFlag =
    (parsed.flags.json && "json") ||
    (parsed.flags.ndjson && "ndjson") ||
    (parsed.flags.pretty && "pretty");
  const mode: EmitterMode = (modeFlag as EmitterMode) ?? defaultMode(process.stdout.isTTY === true);
  const emitter = makeEmitter({ mode });

  try {
    if (!parsed.command || parsed.command === "help" || parsed.flags.help) {
      emitter.emit({
        type: "help",
        commands: ["init", "daemon"],
        note: "Phase A surface; richer surface lands in Phases B-E.",
      });
      return 0;
    }

    if (parsed.command === "init") {
      const vaultPathArg = parsed.positional[0];
      if (!vaultPathArg) throw new Error("init requires a vault path argument");
      const sqlWasmSource = await resolveSqlWasmSource();
      await runInit({
        vaultPathArg,
        cwd: process.cwd(),
        emitter,
        sqlWasmSource,
      });
      return 0;
    }

    if (parsed.command === "daemon") {
      const verb = parsed.positional[0] as "start" | "stop" | "status" | "list" | undefined;
      if (!verb) throw new Error("daemon requires a verb: start | stop | status | list");
      const vaultPath = await resolveVaultForDaemon(parsed);
      await runDaemonCommand({
        verb,
        vaultPath,
        emitter,
      });
      return 0;
    }

    emitter.emit({
      type: "error",
      code: "INVALID_PARAMS",
      message: `Unknown command: ${parsed.command}`,
    });
    return 2;
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
