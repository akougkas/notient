/**
 * Hermetic env helpers for smoke spawns. Bun auto-loads `.env` from the
 * project root cwd into process.env, which means a developer-local
 * NOTIENT_LLM_MODEL=... pin would leak into every smoke daemon spawn and
 * break tests that pre-seed a different model into the tmp vault config.
 *
 * Two-layer defense:
 *   1. stripNotientEnvFromProcess() at the top of main() removes the
 *      NOTIENT_* variables Bun copied into THIS process at startup.
 *   2. buildSmokeEnv() is the env passed to child_process.spawn. It
 *      strips NOTIENT_* AND sets BUN_ENV_FILE=/dev/null so the spawned
 *      bun runtime does not re-read .env from the project root cwd.
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
