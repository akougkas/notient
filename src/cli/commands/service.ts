import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { vaultDaemonPidPath, vaultId } from "../../core/vault/identity";
import { inspectPidFile, isProcessAlive } from "../../daemon/lifecycle";
import type { Emitter } from "../output";
import { resolveDaemonEntry } from "./daemon";

export type ServiceAction = "install" | "status" | "uninstall";
export interface ServiceDefinitionInput {
  vaultPath: string;
  bunPath: string;
  daemonEntry: string;
  executablePath: string;
}
function canonical(value: string): string {
  if (!value || /[\r\n\0]/.test(value))
    throw new Error("service paths must be nonempty and contain no control lines");
  return value;
}
function unitQuote(value: string, escapeDollars = true): string {
  return `"${canonical(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/\$/g, () => (escapeDollars ? "$$" : "$"))}"`;
}
function xml(value: string): string {
  return canonical(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
export function systemdUnit(input: ServiceDefinitionInput): string {
  const args = [
    input.bunPath,
    "--env-file=/dev/null",
    input.daemonEntry,
    "--vault",
    input.vaultPath,
  ]
    .map((value) => unitQuote(value))
    .join(" ");
  return `[Unit]\nDescription=Notient vault ${vaultId(input.vaultPath)}\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=/\nExecStart=${args}\nEnvironment=${unitQuote(`PATH=${input.executablePath}`, false)}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=90\nKillMode=mixed\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}
export function launchdPlist(input: ServiceDefinitionInput): string {
  const args = [
    input.bunPath,
    "--env-file=/dev/null",
    input.daemonEntry,
    "--vault",
    input.vaultPath,
  ]
    .map((value) => `<string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>org.notient.vault.${vaultId(input.vaultPath)}</string>\n<key>ProgramArguments</key><array>${args}</array>\n<key>WorkingDirectory</key><string>/</string>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(input.executablePath)}</string></dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>5</integer>\n<key>ExitTimeOut</key><integer>90</integer>\n</dict></plist>\n`;
}
async function command(args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { ok: code === 0, output: `${stdout}${stderr}`.trim().slice(0, 2048) };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}
async function installFile(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    if ((await readFile(path, "utf8")) === body) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staged = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(staged, body, { mode: 0o600, flag: "wx" });
    await rename(staged, path);
  } finally {
    await rm(staged, { force: true });
  }
}
export async function runServiceCommand(options: {
  action: ServiceAction;
  vaultPath: string;
  emitter: Emitter;
  clientIdentity?: string;
}): Promise<void> {
  if (options.clientIdentity && options.clientIdentity !== "human")
    throw new Error("FORBIDDEN: service administration requires the human operator");
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin")
    throw new Error(
      "services support Linux/WSL systemd and macOS launchd; use notient daemon start --vault <path>",
    );
  const id = vaultId(options.vaultPath);
  const name = platform === "linux" ? `notient-${id}.service` : `org.notient.vault.${id}`;
  const path =
    platform === "linux"
      ? join(homedir(), ".config/systemd/user", name)
      : join(homedir(), "Library/LaunchAgents", `${name}.plist`);
  const domain = `gui/${process.getuid?.()}`;
  const status = () =>
    command(
      platform === "linux"
        ? ["systemctl", "--user", "is-active", name]
        : ["launchctl", "print", `${domain}/${name}`],
    );
  if (options.action === "status") {
    const state = await status();
    options.emitter.emit({
      type: "service:status",
      name,
      path,
      active: state.ok,
      detail: state.ok ? "active" : state.output,
    });
    return;
  }
  if (options.action === "uninstall") {
    const stopped = await command(
      platform === "linux"
        ? ["systemctl", "--user", "disable", "--now", name]
        : ["launchctl", "bootout", `${domain}/${name}`],
    );
    await rm(path, { force: true });
    if (platform === "linux") await command(["systemctl", "--user", "daemon-reload"]);
    options.emitter.emit({
      type: "service:uninstalled",
      name,
      path,
      managerConfirmed: stopped.ok,
      detail: stopped.output,
    });
    return;
  }
  await installService(options, { platform, name, path, domain, status });
}

async function installService(
  options: Parameters<typeof runServiceCommand>[0],
  plan: {
    platform: "linux" | "darwin";
    name: string;
    path: string;
    domain: string;
    status: () => Promise<{ ok: boolean; output: string }>;
  },
): Promise<void> {
  const { platform, name, path, domain, status } = plan;
  const input: ServiceDefinitionInput = {
    vaultPath: options.vaultPath,
    bunPath: process.execPath,
    daemonEntry: resolveDaemonEntry(),
    executablePath: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };
  await installFile(path, platform === "linux" ? systemdUnit(input) : launchdPlist(input));
  const owner = await inspectPidFile(vaultDaemonPidPath(options.vaultPath));
  const owned = owner.kind === "record" && isProcessAlive(owner.record.pid);
  const alreadyActive = (await status()).ok;
  let configured = { ok: true, output: "" };
  if (platform === "linux") {
    configured = await command(["systemctl", "--user", "daemon-reload"]);
    if (configured.ok) configured = await command(["systemctl", "--user", "enable", name]);
  }
  if (configured.ok && !owned && !alreadyActive)
    configured = await command(
      platform === "linux"
        ? ["systemctl", "--user", "start", name]
        : ["launchctl", "bootstrap", domain, path],
    );
  options.emitter.emit({
    type: "service:installed",
    name,
    path,
    managerConfirmed: configured.ok,
    preservedRunningOwner: owned,
    active: alreadyActive || (configured.ok && !owned),
    detail: configured.output,
    nextAction: serviceNextAction(configured.ok, owned && !alreadyActive),
  });
}

function serviceNextAction(configured: boolean, owned: boolean): string {
  if (!configured)
    return "Service definition prepared; no service manager is available. Use notient daemon start --vault <path>.";
  return owned
    ? "An existing daemon retains ownership. Service takes over on the next login/start after that owner exits."
    : "Use daemon service status to inspect the service.";
}
