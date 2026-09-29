import { execFile } from "node:child_process";

export function parseWakeCommand(value: unknown): string[] | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim()))
    return null;
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (
    !Array.isArray(parsed) ||
    parsed.length < 2 ||
    parsed.length > 32 ||
    parsed.some((arg) => typeof arg !== "string" || !arg.length || arg.includes("\0"))
  )
    throw new Error("Enter a JSON array containing the executable and its arguments.");
  return parsed as string[];
}

export function wakeDaemon(
  command: string[],
  vaultId: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command[0],
      command.slice(1),
      {
        shell: false,
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 256 * 1024,
        encoding: "utf8",
        signal,
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              signal.aborted
                ? "Notient wakeup cancelled"
                : "Notient could not wake. Check the local launch command and CLI installation.",
            ),
          );
          return;
        }
        try {
          const ready = stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .find((frame) => frame.type === "daemon:ready");
          if (!ready || ready.vaultId !== vaultId)
            throw new Error("The launch command did not return this paired vault's identity.");
          const endpoint = new URL(ready.httpEndpoint);
          if (
            endpoint.protocol !== "http:" ||
            endpoint.hostname !== "127.0.0.1" ||
            !endpoint.port ||
            endpoint.username ||
            endpoint.password ||
            endpoint.pathname !== "/" ||
            endpoint.search ||
            endpoint.hash
          )
            throw new Error("The daemon did not return a valid local endpoint.");
          resolve(endpoint.origin);
        } catch (error) {
          reject(error);
        }
      },
    );
  });
}
