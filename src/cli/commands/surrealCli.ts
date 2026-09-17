/**
 * Canonical boundary for state written by Notient's SurrealDB supervisor and
 * exit statuses returned by the SurrealDB CLI. These values control operator
 * data commands, so malformed state must never be interpreted as a usable
 * endpoint or a successful process.
 */

import { BACKUP_TABLES } from "../../core/db/backupTables";

const DAEMON_PORT_FILE = /^([1-9][0-9]{0,4})\n$/;

export interface SurrealCliInvocation {
  argv: string[];
  env: Record<string, string>;
}

interface SurrealCliInvocationBase {
  port: number;
  secret: string;
  /** Executable lookup only. No unrelated parent-process state reaches the child. */
  path?: string;
}

export interface SurrealExportInvocationOptions extends SurrealCliInvocationBase {
  operation: "export";
}

export interface SurrealImportInvocationOptions extends SurrealCliInvocationBase {
  operation: "import";
  filePath: string;
}

export type SurrealDataInvocationOptions =
  | SurrealExportInvocationOptions
  | SurrealImportInvocationOptions;

export interface SurrealSqlInvocationOptions extends SurrealCliInvocationBase {}

/**
 * Build the exact child-process boundary used by graph backup and restore.
 *
 * The root password is deliberately absent from argv, where process listings
 * expose it to other local users. It is the only credential inherited by the
 * child. `PATH` is copied solely so the operating system can resolve the
 * `surreal` executable; API keys, vault settings, and the rest of Notient's
 * parent environment are not forwarded.
 *
 * Export is records-only. In particular, database access definitions and the
 * JWT signing key embedded in the installed schema can never enter a backup.
 */
export function buildSurrealDataInvocation(
  options: SurrealDataInvocationOptions,
): SurrealCliInvocation {
  assertInvocationValue(
    options.port,
    options.secret,
    options.operation === "import" ? options.filePath : undefined,
  );
  const common = [
    "--endpoint",
    `http://127.0.0.1:${options.port}`,
    "--username",
    "root",
    "--namespace",
    "notient",
    "--database",
    "vault",
  ];
  const argv =
    options.operation === "export"
      ? [
          "surreal",
          "export",
          ...common,
          "--log",
          "none",
          "--only",
          "--tables",
          BACKUP_TABLES.join(","),
          "--records",
          "true",
          "-",
        ]
      : ["surreal", "import", ...common, "--log", "none", options.filePath];
  const env: Record<string, string> = { SURREAL_PASS: options.secret };
  if (options.path !== undefined) {
    env.PATH = options.path;
  }
  return { argv, env };
}

/** Build the credential-isolated invocation for the interactive SQL shell. */
export function buildSurrealSqlInvocation(
  options: SurrealSqlInvocationOptions,
): SurrealCliInvocation {
  assertInvocationValue(options.port, options.secret, undefined);
  const argv = [
    "surreal",
    "sql",
    "--endpoint",
    `ws://127.0.0.1:${options.port}/rpc`,
    "--username",
    "root",
    "--namespace",
    "notient",
    "--database",
    "vault",
    "--pretty",
  ];
  const env: Record<string, string> = { SURREAL_PASS: options.secret };
  if (options.path !== undefined) env.PATH = options.path;
  return { argv, env };
}

function assertInvocationValue(port: number, secret: string, filePath: string | undefined): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SurrealDB CLI port must be an integer between 1 and 65535");
  }
  if (secret.length === 0) {
    throw new Error("SurrealDB CLI password must not be empty");
  }
  if (filePath !== undefined && filePath.length === 0) {
    throw new Error("SurrealDB CLI file path must not be empty");
  }
}

export function parseDaemonPortFile(raw: unknown): number {
  if (typeof raw !== "string") {
    throw new Error("daemon port file must contain the canonical decimal port and one newline");
  }
  const match = DAEMON_PORT_FILE.exec(raw);
  if (match === null) {
    throw new Error("daemon port file must contain the canonical decimal port and one newline");
  }
  const port = Number(match[1]);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("daemon port file must contain a port between 1 and 65535");
  }
  return port;
}

export function parseSurrealCliExitCode(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new Error("SurrealDB CLI returned an invalid process exit status");
  }
  return raw;
}
