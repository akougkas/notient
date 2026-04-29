export interface SurrealVersion {
  major: number;
  minor: number;
  patch: number;
}

const INSTALL_HINT =
  "SurrealDB 3.x is required. Install: curl -sSf https://install.surrealdb.com | sh";

/**
 * Parse the stdout of `surreal --version`. Returns the version tuple, or
 * `null` if the input is unparseable or the major version is below 3.
 */
export function parseSurrealVersion(stdout: string): SurrealVersion | null {
  const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (major < 3) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * Extract the integer port from a stdout line of the form
 * `Started server at 127.0.0.1:NNNNN`. Returns null if not present.
 */
export function parseBoundPort(stdout: string): number | null {
  const match = stdout.match(/Started server at 127\.0\.0\.1:(\d+)/);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

/**
 * Spawns `surreal --version`, parses the output, and returns the parsed
 * version on success. Throws if the binary is missing or pre-3.x.
 */
export async function checkSurrealBinary(): Promise<SurrealVersion> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["surreal", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new Error(INSTALL_HINT);
  }

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(INSTALL_HINT);
  }

  const version = parseSurrealVersion(stdout);
  if (!version) {
    throw new Error(INSTALL_HINT);
  }
  return version;
}
