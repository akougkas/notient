import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { FsVault } from "../../adapters/fsVault";
import { describeIndexing } from "../../api/indexing";
import { DEFAULT_AGENT_ID } from "../../core/auth/agentIdentity";
import { redactBearerToken } from "../../core/llm/bearerAuth";
import {
  type EndpointModelCatalog,
  fetchEndpointModelCatalog,
} from "../../core/llm/modelSelection";
import { loadNotientConfig } from "../../core/settings/configSchema";
import { readEnvSource, readOptionalVaultFile } from "../../core/settings/envFile";
import {
  type EnvSource,
  type ProviderCredentials,
  resolveProviderCredentials,
  resolveSettings,
} from "../../core/settings/envOverrides";
import type { NotientSettings } from "../../core/settings/types";
import { vaultId } from "../../core/vault/identity";
import { normalizeVaultPath } from "../../core/vault/paths";
import { probeDaemonModel } from "../../daemon/modelProbe";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { checkSurrealBinary } from "../../daemon/surrealServer";
import { type DaemonStatusResult, daemonStatusSchema } from "../../daemon/wire";
import { connectClient } from "../client";
import type { Emitter, StructuredEvent } from "../output";

export interface DoctorCheck {
  name: string;
  status: "pass" | "attention" | "fail";
  message: string;
  action?: string;
}

export interface DoctorReport extends StructuredEvent {
  type: "doctor";
  vault: string;
  status: "ready" | "attention" | "blocked";
  checks: DoctorCheck[];
  note: string;
}

/** Inspection only: no bootstrap, migrations, model generation, or repair. */
export async function runDoctorCommand(options: {
  vaultPath: string;
  emitter: Emitter;
  clientIdentity?: string;
}): Promise<number> {
  if (options.clientIdentity !== undefined && options.clientIdentity !== DEFAULT_AGENT_ID)
    throw new Error(
      "PERMISSION_DENIED: doctor inspects private deployment configuration; run it as the local operator without --as",
    );
  const report = await inspectInstallation(options.vaultPath);
  options.emitter.emit(report);
  return report.status === "blocked" ? 1 : 0;
}

export async function inspectInstallation(
  inputPath: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<DoctorReport> {
  const vaultPath = normalizeVaultPath(inputPath);
  const checks: DoctorCheck[] = [];
  const timeoutMs = options.timeoutMs ?? 4000;
  await inspectRuntime(checks);
  const directoryReady = await inspectVault(vaultPath, checks);
  if (directoryReady) {
    const deployment = await inspectConfiguration(vaultPath, options.env ?? process.env, checks);
    if (process.platform !== "win32")
      await inspectDaemon(vaultPath, timeoutMs, checks, deployment?.settings);
    if (deployment !== null) {
      await inspectModels(deployment, timeoutMs, checks);
      redactChecks(checks, deployment.credentials);
    }
  }
  return {
    type: "doctor",
    vault: vaultPath,
    status: checks.some((check) => check.status === "fail")
      ? "blocked"
      : checks.some((check) => check.status === "attention")
        ? "attention"
        : "ready",
    checks,
    note: "Read-only checks. Saved model catalogs establish advertised availability, not answer quality or tool support. No generation requests, file changes, or service changes were made.",
  };
}

async function inspectRuntime(checks: DoctorCheck[]): Promise<void> {
  checks.push({
    name: "Bun",
    status: Bun.semver.satisfies(Bun.version, ">=1.4.2") ? "pass" : "fail",
    message: `Running ${Bun.version}; requires 1.4.2 or newer.`,
    ...(Bun.semver.satisfies(Bun.version, ">=1.4.2")
      ? {}
      : { action: "Install Bun 1.4.2 or newer, then run doctor again." }),
  });
  checks.push({
    name: "Platform",
    status: process.platform === "win32" ? "fail" : "pass",
    message:
      process.platform === "win32"
        ? "The local daemon requires Linux, WSL2 or macOS."
        : `${process.platform} supports local daemon IPC.`,
    ...(process.platform === "win32"
      ? { action: "Run Notient in WSL2; Windows Obsidian connects through paired localhost HTTP." }
      : {}),
  });
  try {
    const version = await checkSurrealBinary();
    checks.push({
      name: "SurrealDB",
      status: "pass",
      message: `${version.major}.${version.minor}.${version.patch} is available on PATH.`,
    });
  } catch (error) {
    checks.push({ name: "SurrealDB", status: "fail", message: messageOf(error) });
  }
}

async function inspectVault(vaultPath: string, checks: DoctorCheck[]): Promise<boolean> {
  try {
    if (!(await stat(vaultPath)).isDirectory())
      throw new Error("The selected vault is not a directory.");
    await access(vaultPath, constants.R_OK | constants.X_OK);
    checks.push({
      name: "Vault",
      status: "pass",
      message: "Directory is accessible; no Markdown was read or changed.",
    });
    return true;
  } catch (error) {
    checks.push({
      name: "Vault",
      status: "fail",
      message: messageOf(error),
      action: "Select an existing readable vault with --vault <path>.",
    });
  }
  return false;
}

function redactChecks(checks: DoctorCheck[], credentials: ProviderCredentials): void {
  for (const check of checks) {
    for (const credential of Object.values(credentials)) {
      if (!credential) continue;
      check.message = redactBearerToken(check.message, credential);
      if (check.action) check.action = redactBearerToken(check.action, credential);
    }
  }
}

interface Deployment {
  settings: NotientSettings;
  credentials: ProviderCredentials;
}

async function inspectConfiguration(
  vaultPath: string,
  env: NodeJS.ProcessEnv,
  checks: DoctorCheck[],
): Promise<Deployment | null> {
  const vault = new FsVault(vaultPath, { allowHiddenPaths: true });
  let source: EnvSource = {};
  try {
    source = await readEnvSource(vault, env);
    const credentials = resolveProviderCredentials(source);
    const raw = await readOptionalVaultFile(vault, ".notient/config.json");
    const config = await loadNotientConfig({ path: ".notient/config.json", load: async () => raw });
    const settings = resolveSettings(config, source);
    checks.push({
      name: "Configuration",
      status: raw === null ? "attention" : "pass",
      message:
        raw === null
          ? "No saved config.json; canonical defaults apply, with AI background work disabled."
          : "Saved product configuration is valid. Vault deployment values take precedence over shell values.",
      ...(raw === null
        ? { action: "Run notient init <vault-path> to save the default configuration." }
        : {}),
    });
    return { settings, credentials };
  } catch (error) {
    // Errors can include malformed JSON or an invalid numeric value. Never echo
    // an operator's deployment credentials, even when copied into another field.
    let message = messageOf(error);
    for (const key of [source.NOTIENT_LLM_API_KEY, source.NOTIENT_EMBED_API_KEY])
      if (key) message = redactBearerToken(message, key);
    checks.push({
      name: "Configuration",
      status: "fail",
      message,
      action: "Correct .notient/config.json or .notient/.env. Doctor leaves both files untouched.",
    });
    return null;
  }
}

async function inspectDaemon(
  vaultPath: string,
  timeoutMs: number,
  checks: DoctorCheck[],
  saved?: NotientSettings,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const client = await connectClient({
      vaultPath,
      socketPath: resolveSocketPath(vaultPath, currentPlatform()),
      autoSpawn: false,
      signal: controller.signal,
    });
    try {
      for await (const frame of client.call("daemon.status", {})) {
        if (frame.type === "error") throw new Error(`${frame.code}: ${frame.message}`);
        if (frame.type !== "result") continue;
        const { id: _id, type: _type, ...fields } = frame;
        const status = daemonStatusSchema.parse(fields);
        if (status.vaultId !== vaultId(vaultPath) || status.sealed !== true)
          throw new Error("Daemon status did not confirm a ready process for this vault.");
        recordDaemonStatus(status, checks, saved);
        return;
      }
      throw new Error("Daemon returned no status result.");
    } finally {
      await client.close();
    }
  } catch (error) {
    checks.push({
      name: "Daemon",
      status: "attention",
      message: daemonFailureMessage(error, controller.signal.aborted, timeoutMs),
      action:
        "Use notient daemon list to inspect ownership, or launch notient --vault <path>. Doctor does not start or stop services.",
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function daemonFailureMessage(error: unknown, timedOut: boolean, timeoutMs: number): string {
  if (timedOut)
    return `No authenticated status within ${timeoutMs}ms; the process may be starting or unresponsive.`;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ECONNREFUSED") return "No daemon is listening for this vault.";
  return messageOf(error);
}

function recordDaemonStatus(
  status: DaemonStatusResult,
  checks: DoctorCheck[],
  saved?: NotientSettings,
): void {
  const indexing = status.indexing;
  checks.push({
    name: "Daemon",
    status: "pass",
    message: `Connected to this vault's authenticated daemon (pid ${status.pid}, version ${status.version}).`,
  });
  checks.push({
    name: "Search",
    status: indexing.state === "current" ? "pass" : "attention",
    message: describeIndexing(indexing),
    ...(indexing.state === "current"
      ? {}
      : {
          action:
            "Direct note reads remain available. Check indexing progress in the TUI before relying on complete search results.",
        }),
  });
  if (
    saved &&
    (saved.primary.baseUrl !== status.probe.endpoint ||
      saved.primary.reasoningModel !== status.probe.configuredModel ||
      saved.chat.modelContextTokens !== status.probe.configuredContextTokens ||
      saved.chat.reasoningSlots !== status.probe.parallelSlots)
  ) {
    checks.push({
      name: "Running deployment",
      status: "attention",
      message:
        "The daemon's reasoning deployment differs from the saved configuration being checked.",
      action:
        "Finish active work, then deliberately stop and start this vault's daemon to use the saved endpoint, model and resource limits.",
    });
  }
}

async function inspectModels(
  deployment: Deployment,
  timeoutMs: number,
  checks: DoctorCheck[],
): Promise<void> {
  const { settings, credentials } = deployment;
  // One request pair per endpoint/credential, including when both roles share it.
  const catalogs = new Map<string, Promise<EndpointModelCatalog>>();
  const catalog = (baseUrl: string, apiKey: string | undefined) => {
    const key = JSON.stringify([baseUrl, apiKey]);
    let pending = catalogs.get(key);
    if (pending === undefined) {
      pending = fetchEndpointModelCatalog({ baseUrl, apiKey, timeoutMs });
      catalogs.set(key, pending);
    }
    return pending;
  };
  const chat = await probeDaemonModel({
    endpoint: settings.primary.baseUrl,
    configuredModel: settings.primary.reasoningModel,
    configuredContextTokens: settings.chat.modelContextTokens,
    parallelSlots: settings.chat.reasoningSlots,
    fetchCatalog: () => catalog(settings.primary.baseUrl, credentials.chatApiKey),
  });
  checks.push({
    name: "Answers",
    status: chat.status === "ok" || chat.status === "available" ? "pass" : "attention",
    message: chat.message,
    ...(chat.status === "ok" || chat.status === "available"
      ? {}
      : {
          action:
            "Check NOTIENT_LLM_BASE_URL, NOTIENT_LLM_MODEL and context/slot settings in .notient/.env. Saved deployment changes take effect after a deliberate daemon restart.",
        }),
  });
  if (!settings.embedding.model) {
    checks.push({
      name: "Semantic search",
      status: "attention",
      message:
        "No embedding model is configured. Lexical search and grounded answers can still use the structural index.",
      action:
        "For semantic retrieval, configure NOTIENT_EMBED_BASE_URL and NOTIENT_EMBED_MODEL in .notient/.env.",
    });
    return;
  }
  try {
    const models = await catalog(settings.embedding.baseUrl, credentials.embeddingApiKey);
    const model = models.models.find(
      (entry) => entry.id === settings.embedding.model && entry.type !== "chat",
    );
    checks.push({
      name: "Semantic search",
      status: !model || model.state === "not-loaded" ? "attention" : "pass",
      message: !model
        ? `${settings.embedding.model} is configured but not advertised as an embedding model; a router alias may still resolve it.`
        : `${model.id} is advertised (${model.state === "unknown" ? "load state unavailable" : model.state}). Embedding generation was not tested.`,
      ...(!model || model.state === "not-loaded"
        ? {
            action:
              "Check the embedding endpoint and configured model. Lexical retrieval remains available.",
          }
        : {}),
    });
  } catch (error) {
    checks.push({
      name: "Semantic search",
      status: "attention",
      message: messageOf(error),
      action:
        "Restore the embedding endpoint or correct its saved deployment values. Lexical retrieval remains available.",
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `Notient · ${report.status === "blocked" ? "Setup needs a fix" : report.status === "attention" ? "Some features need attention" : "Local checks passed"}`,
    report.vault,
    "",
  ];
  for (const check of report.checks) {
    lines.push(
      `${check.status === "pass" ? "✓" : check.status === "fail" ? "×" : "·"} ${check.name} — ${check.message}`,
    );
    if (check.action) lines.push(`  ${check.action}`);
  }
  lines.push("", report.note);
  // Endpoint/model strings are untrusted terminal content.
  return lines.join("\n").replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" ? char : ""));
}
