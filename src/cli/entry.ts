import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeVaultPath, resolveVault } from "./env";
import type { Emitter } from "./output";

export type EntryResult = { kind: "open"; vaultPath: string } | { kind: "exit"; code: number };

export interface EntryOptions {
  flagVault: string | null;
  env: Record<string, string | undefined>;
  cwd: string;
  stateLoader: () => Promise<string | null>;
  emitter: Emitter;
  ask: ((question: string) => Promise<string>) | undefined;
  setup: (vaultPath: string) => Promise<number>;
  say: (line: string) => void;
}

type FolderState = "missing" | "file" | "plain" | "vault";

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

async function folderState(path: string): Promise<FolderState> {
  const info = await stat(path).catch(() => null);
  if (info === null) return "missing";
  if (!info.isDirectory()) return "file";
  return (await exists(join(path, ".notient"))) || (await exists(join(path, ".obsidian")))
    ? "vault"
    : "plain";
}

function expandHome(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  return trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
}

const isYes = (answer: string, fallback: boolean): boolean => {
  const text = answer.trim().toLowerCase();
  return text === "" ? fallback : text === "y" || text === "yes";
};

function fail(options: EntryOptions, message: string): EntryResult {
  options.emitter.emit({ type: "error", code: "NO_VAULT", message });
  return { kind: "exit", code: 1 };
}

async function setUp(options: EntryOptions, vaultPath: string): Promise<EntryResult> {
  const code = await options.setup(vaultPath);
  if (code !== 0) return { kind: "exit", code };
  await options.ask?.("\nPress Enter to open your workspace. ");
  return { kind: "open", vaultPath };
}

async function chooseVault(options: EntryOptions): Promise<EntryResult> {
  const ask = options.ask;
  if (ask === undefined)
    return fail(
      options,
      "No vault is set up. Run notient setup <folder>, or pass --vault <folder> of Markdown notes.",
    );
  const here = options.cwd;
  const offerHere = here !== homedir() && here !== "/";
  options.say("Notient opens your Markdown vault as a conversation. No vault is set up yet.\n");
  if (offerHere) options.say(`  1  Use this folder    ${here}`);
  options.say(`  ${offerHere ? 2 : 1}  Choose another folder`);
  options.say(`  ${offerHere ? 3 : 2}  Quit\n`);
  const answer = (await ask(`Choice [${offerHere ? 1 : 2}]: `)).trim();
  const number = answer === "" ? (offerHere ? 1 : 2) : Number(answer);
  const pick = offerHere ? number : number + 1;
  if (pick === 1) return await setUp(options, here);
  if (pick === 2) {
    const typed = expandHome(await ask("Folder of Markdown notes: "));
    if (typed === "") return { kind: "exit", code: 1 };
    const vaultPath = normalizeVaultPath(typed, options.cwd);
    const state = await folderState(vaultPath);
    if (state === "file")
      return fail(options, `${vaultPath} is a file. Choose the folder that holds your notes.`);
    if (state === "missing") {
      if (!isYes(await ask(`${vaultPath} does not exist. Create it as a new vault? [y/N] `), false))
        return fail(
          options,
          `Nothing was changed. Create ${vaultPath} or choose an existing notes folder, then run notient again.`,
        );
      await mkdir(vaultPath, { recursive: true });
    }
    return await setUp(options, vaultPath);
  }
  return { kind: "exit", code: 0 };
}

export async function prepareRootEntry(options: EntryOptions): Promise<EntryResult> {
  const explicit = options.flagVault ?? options.env.NOTIENT_VAULT ?? null;
  const resolved = await resolveVault({
    flagVault: options.flagVault,
    env: options.env,
    cwd: options.cwd,
    stateLoader: options.stateLoader,
  }).catch(() => null);
  if (resolved === null) return await chooseVault(options);
  const vaultPath = resolved;
  const state = await folderState(vaultPath);
  if (state === "vault") return { kind: "open", vaultPath };
  if (state === "file")
    return fail(options, `${vaultPath} is a file. Choose the folder that holds your notes.`);
  if (explicit === null) {
    options.say(
      state === "missing"
        ? `Your last vault, ${vaultPath}, is not available now.\n`
        : `Your last vault, ${vaultPath}, has no Notient settings yet.\n`,
    );
    return await chooseVault(options);
  }
  if (state === "missing")
    return fail(
      options,
      `${vaultPath} does not exist. Create the folder and run notient setup "${vaultPath}", or open an existing notes folder with notient --vault <folder>.`,
    );
  if (options.ask === undefined)
    return fail(
      options,
      `${vaultPath} is not a Notient vault yet. Run notient setup "${vaultPath}".`,
    );
  if (
    !isYes(
      await options.ask(`${vaultPath} is not a Notient vault yet. Set it up here? [Y/n] `),
      true,
    )
  )
    return fail(
      options,
      `Nothing was changed. Run notient setup "${vaultPath}" when you are ready.`,
    );
  return await setUp(options, vaultPath);
}
