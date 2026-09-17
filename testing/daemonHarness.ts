import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type ClientHandle, connectClient } from "../src/cli/client";
import { currentPlatform, resolveSocketPath } from "../src/daemon/socket";

/** Real subprocess/socket fixture; no inference deployment inherited from the checkout. */
export async function startTestDaemon(vaultPath: string, startupTimeoutMs = 20000) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        !entry[0].startsWith("NOTIENT_") && entry[1] !== undefined,
    ),
  );
  const child = Bun.spawn(
    [process.execPath, resolve("src/daemon/index.ts"), "--vault", vaultPath],
    { cwd: tmpdir(), env, stdout: "pipe", stderr: "pipe" },
  );
  let output = "";
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        output += new TextDecoder().decode(item.value);
      }
    } finally {
      reader.releaseLock();
    }
  };
  const readers = [consume(child.stdout), consume(child.stderr)];
  const stopChild = async () => {
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
    try {
      await child.exited;
      await Promise.all(readers);
    } finally {
      clearTimeout(timeout);
    }
  };
  try {
    const deadline = performance.now() + startupTimeoutMs;
    while (
      !output.includes('"type":"daemon:ready"') &&
      child.exitCode === null &&
      performance.now() < deadline
    )
      await Bun.sleep(25);
    if (!output.includes('"type":"daemon:ready"'))
      throw new Error(`daemon failed to start: ${output}`);
    const client = await connectClient({
      vaultPath,
      socketPath: resolveSocketPath(vaultPath, currentPlatform()),
      autoSpawn: false,
    });
    return {
      client,
      env,
      stop: async () => {
        await client.close();
        await stopChild();
        if (child.exitCode !== 0) throw new Error(`daemon exited ${child.exitCode}: ${output}`);
      },
    };
  } catch (error) {
    await stopChild();
    throw error;
  }
}

export async function daemonResult(
  client: ClientHandle,
  method: string,
  params: Record<string, unknown> = {},
) {
  for await (const frame of client.call(method, params)) {
    if (frame.type === "error") throw new Error(`${frame.code}: ${frame.message}`);
    if (frame.type === "result") return frame;
  }
  throw new Error(`missing ${method} terminal result`);
}
