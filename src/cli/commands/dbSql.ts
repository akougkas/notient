import { readFile } from "node:fs/promises";
import { vaultPortPath, vaultSecretPath } from "../../core/vault/identity";
import { readOrGenerateSecret } from "../../core/vault/secret";
import {
  buildSurrealSqlInvocation,
  parseDaemonPortFile,
  parseSurrealCliExitCode,
} from "./surrealCli";

export interface DbSqlOptions {
  vaultPath: string;
}

export async function runDbSqlCommand(options: DbSqlOptions): Promise<number> {
  const portFile = vaultPortPath(options.vaultPath);
  let portText: string;
  try {
    portText = await readFile(portFile, "utf8");
  } catch {
    throw new Error(
      `notient db sql: daemon is not running (no port file at ${portFile}). Run 'notient daemon start' first.`,
    );
  }
  let port: number;
  try {
    port = parseDaemonPortFile(portText);
  } catch {
    throw new Error(
      `notient db sql: daemon is not running (invalid port file at ${portFile}). Run 'notient daemon start' first.`,
    );
  }
  const secret = await readOrGenerateSecret(vaultSecretPath(options.vaultPath));
  const invocation = buildSurrealSqlInvocation({
    port,
    secret,
    ...(process.env.PATH === undefined ? {} : { path: process.env.PATH }),
  });
  const child = Bun.spawn(invocation.argv, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: invocation.env,
  });
  return parseSurrealCliExitCode(await child.exited);
}
