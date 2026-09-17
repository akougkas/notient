import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type EndpointModel, fetchEndpointModelCatalog } from "../../core/llm/modelSelection";
import { parseEnvFile } from "../../core/settings/envFile";
import { DEFAULT_REASONING_SLOTS } from "../../core/settings/types";
import { normalizeVaultPath } from "../env";
import type { Emitter, StructuredEvent } from "../output";
import { type DoctorReport, inspectInstallation } from "./doctor";
import { runInit } from "./init";

export interface SetupOptions {
  vaultPathArg?: string;
  cwd: string;
  emitter: Emitter;
  endpoint?: string;
  model?: string;
  embedEndpoint?: string;
  embedModel?: string;
  /** Asks one question; absent when stdin is not a terminal or `--yes` was given. */
  ask?: (question: string) => Promise<string>;
  fetchCatalog?: typeof fetchEndpointModelCatalog;
  inspect?: typeof inspectInstallation;
  stateFilePath?: string;
}

export interface SetupReport extends StructuredEvent {
  type: "setup";
  vault: string;
  steps: string[];
  doctor: DoctorReport;
  next: string[];
}

/**
 * Guided first run: choose the vault, write default settings, record one
 * reasoning deployment and verify it with the same read-only checks as
 * `notient doctor`. Existing private values are never replaced unless the
 * matching flag names a new one, credentials are never accepted as arguments,
 * no generation request is sent, and background work stays off.
 */
export async function runSetupCommand(options: SetupOptions): Promise<number> {
  const steps: string[] = [];
  const chosen =
    options.vaultPathArg ?? (await options.ask?.(`Vault folder [${options.cwd}]: `))?.trim();
  if (chosen === undefined)
    throw new Error("INVALID_PARAMS: name the vault folder: notient setup /path/to/vault");
  const vault = normalizeVaultPath(chosen || options.cwd, options.cwd);
  if (!(await stat(vault).catch(() => null))?.isDirectory())
    throw new Error(
      `INVALID_PARAMS: ${vault} is not a folder. Point setup at an existing Markdown or Obsidian vault.`,
    );
  const quiet: Emitter = { emit: () => {} };
  await runInit({
    vaultPathArg: vault,
    cwd: options.cwd,
    emitter: quiet,
    stateFilePath: options.stateFilePath,
  });
  steps.push("Settings are in .notient/config.json. Reading and lexical search need nothing else.");

  const envPath = join(vault, ".notient/.env");
  const saved = await readFile(envPath, "utf8").catch(() => "");
  const current = parseEnvFile(saved);
  const updates = await chooseDeployment(options, current, steps);
  if (Object.keys(updates).length) {
    await writePrivateEnv(envPath, saved, updates);
    steps.push(`Saved ${Object.keys(updates).join(", ")} to .notient/.env (owner-only).`);
  }

  const doctor = await (options.inspect ?? inspectInstallation)(vault);
  const report: SetupReport = {
    type: "setup",
    vault,
    steps,
    doctor,
    next: [
      `Open your workspace: notient --vault "${vault}"`,
      `Pair Obsidian: notient pair create --vault "${vault}" --label "Obsidian desktop" --kind human --scopes read,write,host`,
      "Background work is off. Enable a workflow in the workspace with Ctrl+P → Preferences.",
      "An endpoint credential belongs in .notient/.env as NOTIENT_LLM_API_KEY; never pass it on a command line.",
    ],
  };
  options.emitter.emit(report);
  return doctor.status === "blocked" ? 1 : 0;
}

async function chooseDeployment(
  options: SetupOptions,
  current: Record<string, string>,
  steps: string[],
): Promise<Record<string, string>> {
  const updates: Record<string, string> = {};
  const kept = current.NOTIENT_LLM_BASE_URL;
  if (kept && options.endpoint === undefined && options.model === undefined) {
    steps.push(`Kept the saved reasoning deployment at ${kept}.`);
    return updates;
  }
  const endpoint = (
    options.endpoint ??
    kept ??
    (await options.ask?.(
      "OpenAI-compatible endpoint for answers, e.g. http://127.0.0.1:1234/v1 (blank to skip): ",
    )) ??
    ""
  ).trim();
  if (!endpoint) {
    steps.push("No model endpoint yet. Add one later by running notient setup again.");
    return updates;
  }
  const catalog = await (options.fetchCatalog ?? fetchEndpointModelCatalog)({
    baseUrl: endpoint,
    apiKey: current.NOTIENT_LLM_API_KEY || undefined,
  });
  const chat = catalog.models.filter((entry) => entry.type !== "embedding");
  const model = await chooseModel(options, chat, options.model, "answers");
  if (endpoint !== kept) updates.NOTIENT_LLM_BASE_URL = endpoint;
  if (model.id !== current.NOTIENT_LLM_MODEL) updates.NOTIENT_LLM_MODEL = model.id;
  // The loaded context is shared by every reasoning slot, so each slot gets its
  // share; otherwise the first doctor run reports the deployment as oversubscribed.
  if (model.loadedContextLength && !current.NOTIENT_CONTEXT_TOKENS) {
    const slots = Number(current.NOTIENT_REASONING_SLOTS) || DEFAULT_REASONING_SLOTS;
    updates.NOTIENT_CONTEXT_TOKENS = String(Math.floor(model.loadedContextLength / slots));
  }
  steps.push(
    `Answers use ${model.id}${model.state === "loaded" ? "" : " (not reported as loaded)"}. No generation request was sent.`,
  );

  await chooseEmbedding(options, current, endpoint, catalog.models, updates, steps);
  return updates;
}

async function chooseEmbedding(
  options: SetupOptions,
  current: Record<string, string>,
  endpoint: string,
  advertised: EndpointModel[],
  updates: Record<string, string>,
  steps: string[],
): Promise<void> {
  if (current.NOTIENT_EMBED_MODEL && options.embedModel === undefined) return;
  const embedEndpoint = (options.embedEndpoint ?? endpoint).trim();
  const embeddings =
    embedEndpoint === endpoint
      ? advertised.filter((entry) => entry.type === "embedding")
      : (
          await (options.fetchCatalog ?? fetchEndpointModelCatalog)({
            baseUrl: embedEndpoint,
            apiKey: current.NOTIENT_EMBED_API_KEY || undefined,
          })
        ).models.filter((entry) => entry.type !== "chat");
  const loaded = embeddings.filter((entry) => entry.state === "loaded");
  const embedding =
    options.embedModel !== undefined
      ? await chooseModel(options, embeddings, options.embedModel, "semantic search")
      : loaded.length === 1
        ? loaded[0]
        : undefined;
  if (!embedding) {
    steps.push(
      "No embedding model was selected. Lexical search and grounded answers work without one.",
    );
    return;
  }
  updates.NOTIENT_EMBED_BASE_URL = embedEndpoint;
  updates.NOTIENT_EMBED_MODEL = embedding.id;
  steps.push(`Semantic search uses ${embedding.id}.`);
}

async function chooseModel(
  options: SetupOptions,
  models: EndpointModel[],
  requested: string | undefined,
  purpose: string,
): Promise<EndpointModel> {
  if (requested !== undefined) {
    const named = models.find((entry) => entry.id === requested);
    // A router alias may be valid without being advertised; doctor reports it.
    return named ?? { id: requested, type: "unknown", state: "unknown", loadedContextLength: null };
  }
  const loaded = models.filter((entry) => entry.state === "loaded");
  if (loaded.length === 1) return loaded[0];
  const candidates = loaded.length ? loaded : models;
  if (!candidates.length) throw new Error(`The endpoint advertises no model for ${purpose}.`);
  const listing = candidates
    .slice(0, 30)
    .map((entry, index) => `  ${index + 1}. ${entry.id}`)
    .join("\n");
  if (!options.ask)
    throw new Error(
      `INVALID_PARAMS: choose the model for ${purpose} with --model. Advertised:\n${listing}`,
    );
  const answer = (await options.ask(`Model for ${purpose}:\n${listing}\nNumber or id: `)).trim();
  const picked = /^\d+$/.test(answer)
    ? candidates[Number(answer) - 1]
    : candidates.find((entry) => entry.id === answer);
  if (!picked) throw new Error(`INVALID_PARAMS: "${answer}" is not one of the listed models.`);
  return picked;
}

/** Replace named keys in place, append new ones and keep every other line and comment. */
export function mergeEnvText(saved: string, updates: Record<string, string>): string {
  const pending = new Map(Object.entries(updates));
  const lines = saved.split(/\r?\n/).map((line) => {
    const key = line.slice(0, Math.max(0, line.indexOf("="))).trim();
    if (line.trimStart().startsWith("#") || !pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return `${key}=${value}`;
  });
  while (lines.at(-1) === "") lines.pop();
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  return `${lines.join("\n")}\n`;
}

async function writePrivateEnv(
  path: string,
  saved: string,
  updates: Record<string, string>,
): Promise<void> {
  for (const value of Object.values(updates))
    if (/[\r\n]/.test(value)) throw new Error("INVALID_PARAMS: deployment values are single-line");
  const prepared = `${path}.setup-${process.pid}`;
  await writeFile(prepared, mergeEnvText(saved, updates), { mode: 0o600, flag: "wx" });
  await chmod(prepared, 0o600);
  await rename(prepared, path);
}

export function formatSetupReport(report: SetupReport, formatDoctor: (r: DoctorReport) => string) {
  return (
    [
      `Notient setup · ${report.vault}`,
      "",
      ...report.steps.map((step) => `✓ ${step}`),
      "",
      formatDoctor(report.doctor),
      "",
      "Next",
      ...report.next.map((line) => `  ${line}`),
    ]
      .join("\n")
      // Endpoint and model strings are untrusted terminal content.
      .replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" ? char : ""))
  );
}
