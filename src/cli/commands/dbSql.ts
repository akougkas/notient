import { readFile } from "node:fs/promises";
import { vaultPortPath, vaultSecretPath } from "../../core/vault/identity";
import { readOrGenerateSecret } from "../../core/vault/secret";

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
  const port = Number(portText.trim());
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(
      `notient db sql: daemon is not running (no port file at ${portFile}). Run 'notient daemon start' first.`,
    );
  }
  const secret = await readOrGenerateSecret(vaultSecretPath(options.vaultPath));
  const child = Bun.spawn(
    [
      "surreal",
      "sql",
      "--endpoint",
      `ws://127.0.0.1:${port}/rpc`,
      "--username",
      "root",
      "--password",
      secret,
      "--namespace",
      "notient",
      "--database",
      "vault",
      "--pretty",
    ],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await child.exited;
  return exitCode ?? 0;
}
