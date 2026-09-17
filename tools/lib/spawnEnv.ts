import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateBearerToken } from "../../src/core/llm/bearerAuth";

/**
 * Hermetic env helpers for smoke spawns. Bun auto-loads `.env` from the
 * project root cwd into process.env. The harness captures the supported
 * deployment values once and writes them into the scratch vault; ambient
 * NOTIENT_* values must not leak independently into child processes.
 *
 * Two-layer defense:
 *   1. stripNotientEnvFromProcess() at the top of main() removes the
 *      NOTIENT_* variables Bun copied into THIS process at startup.
 *   2. buildSmokeEnv() is the env passed to child_process.spawn. It
 *      strips NOTIENT_* AND sets BUN_ENV_FILE=/dev/null so the spawned
 *      bun runtime does not re-read .env from the project root cwd.
 *
 * The smoke captures the project-root NOTIENT_* vars before stripping
 * (captureNotientEnv) and writes them into the tmp vault's
 * <vault>/.notient/.env (writeVaultEnvFile). The daemon's bootstrap reads
 * that file via readEnvSource so the operator's substrate identity flows
 * through the env overlay rather than through hardcoded source defaults.
 */
export function buildSmokeEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (key.startsWith("NOTIENT_")) continue;
    if (value !== undefined) result[key] = value;
  }
  // Disable Bun's auto-load of .env in the spawned child so a developer
  // .env at the project root cannot bleed into hermetic test vaults.
  result.BUN_ENV_FILE = "/dev/null";
  return result;
}

/**
 * Mutate the running process's env in place, removing every NOTIENT_*
 * variable Bun's .env auto-loader copied in AND setting BUN_ENV_FILE so
 * any subsequent child_process.spawn that inherits this env (notably the
 * one in src/cli/client.ts) tells the spawned bun runtime to skip .env
 * auto-loading. Idempotent.
 */
export function stripNotientEnvFromProcess(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith("NOTIENT_")) {
      delete env[key];
    }
  }
  env.BUN_ENV_FILE = "/dev/null";
}

export interface NotientEnvSnapshot {
  baseUrl: string;
  embedBaseUrl: string | undefined;
  chatModel: string;
  embedModel: string;
  /** Optional chat bearer token; null preserves an explicit empty value. */
  chatApiKey?: string | null;
  /** Optional embedding bearer token; null disables chat-token inheritance. */
  embedApiKey?: string | null;
  /** Optional resolved chat context budget; undefined uses the daemon default. */
  contextTokens: string | undefined;
  /** Optional resolved reasoning capacity; undefined uses the daemon default. */
  reasoningSlots: string | undefined;
}

/**
 * Capture the supported NOTIENT_-prefixed vars from the supplied env (defaults to
 * process.env). The caller MUST invoke this before stripNotientEnvFromProcess
 * because the strip wipes the values. Throws a clear, operator-actionable
 * error listing every missing required var so the failure mode is "set the
 * env" rather than "daemon refuses to seal with empty stderr".
 */
export function captureNotientEnv(env: NodeJS.ProcessEnv = process.env): NotientEnvSnapshot {
  const baseUrl = (env.NOTIENT_LLM_BASE_URL ?? "").trim();
  const embedBaseUrlRaw = env.NOTIENT_EMBED_BASE_URL?.trim();
  const embedBaseUrl =
    embedBaseUrlRaw !== undefined && embedBaseUrlRaw.length > 0 ? embedBaseUrlRaw : undefined;
  const chatModel = (env.NOTIENT_LLM_MODEL ?? "").trim();
  const embedModel = (env.NOTIENT_EMBED_MODEL ?? "").trim();
  const chatApiKey = captureApiKey("NOTIENT_LLM_API_KEY", env.NOTIENT_LLM_API_KEY);
  const embedApiKey = captureApiKey("NOTIENT_EMBED_API_KEY", env.NOTIENT_EMBED_API_KEY);
  const contextTokensRaw = env.NOTIENT_CONTEXT_TOKENS?.trim();
  const contextTokens =
    contextTokensRaw !== undefined && contextTokensRaw.length > 0 ? contextTokensRaw : undefined;
  const reasoningSlotsRaw = env.NOTIENT_REASONING_SLOTS?.trim();
  const reasoningSlots =
    reasoningSlotsRaw !== undefined && reasoningSlotsRaw.length > 0 ? reasoningSlotsRaw : undefined;

  const missing: string[] = [];
  if (baseUrl.length === 0) missing.push("NOTIENT_LLM_BASE_URL");
  if (chatModel.length === 0) missing.push("NOTIENT_LLM_MODEL");
  if (embedModel.length === 0) missing.push("NOTIENT_EMBED_MODEL");
  if (missing.length > 0) {
    throw new Error(
      `notient smoke: missing required env vars: ${missing.join(", ")}. Set them in <project-root>/.env or the calling process env before running smokes.`,
    );
  }
  return {
    baseUrl,
    embedBaseUrl,
    chatModel,
    embedModel,
    ...(chatApiKey === undefined ? {} : { chatApiKey }),
    ...(embedApiKey === undefined ? {} : { embedApiKey }),
    contextTokens,
    reasoningSlots,
  };
}

function captureApiKey(
  key: "NOTIENT_LLM_API_KEY" | "NOTIENT_EMBED_API_KEY",
  value: string | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0) return null;
  return validateBearerToken(value, key);
}

/**
 * Write the supported NOTIENT_-prefixed vars into <vault>/.notient/.env. The
 * daemon's readEnvSource overlays this file on top of process env at seal,
 * so smokes use this to inject the substrate identity into a freshly init'd
 * tmp vault without leaking the developer's project-root .env into the
 * spawned daemon.
 */
export async function writeVaultEnvFile(
  vaultPath: string,
  snapshot: NotientEnvSnapshot,
): Promise<void> {
  const notientDir = join(vaultPath, ".notient");
  await mkdir(notientDir, { recursive: true });
  const lines = [`NOTIENT_LLM_BASE_URL=${snapshot.baseUrl}`];
  if (snapshot.embedBaseUrl !== undefined) {
    lines.push(`NOTIENT_EMBED_BASE_URL=${snapshot.embedBaseUrl}`);
  }
  if (snapshot.chatApiKey !== undefined) {
    lines.push(`NOTIENT_LLM_API_KEY=${snapshot.chatApiKey ?? ""}`);
  }
  if (snapshot.embedApiKey !== undefined) {
    lines.push(`NOTIENT_EMBED_API_KEY=${snapshot.embedApiKey ?? ""}`);
  }
  lines.push(
    `NOTIENT_LLM_MODEL=${snapshot.chatModel}`,
    `NOTIENT_EMBED_MODEL=${snapshot.embedModel}`,
  );
  if (snapshot.contextTokens !== undefined) {
    lines.push(`NOTIENT_CONTEXT_TOKENS=${snapshot.contextTokens}`);
  }
  if (snapshot.reasoningSlots !== undefined) {
    lines.push(`NOTIENT_REASONING_SLOTS=${snapshot.reasoningSlots}`);
  }
  await writeFile(join(notientDir, ".env"), `${lines.join("\n")}\n`, { mode: 0o600 });
}
