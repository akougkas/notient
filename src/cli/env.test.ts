import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVault } from "./env";

describe("resolveVault", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-env-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("--vault wins over env and cwd", async () => {
    const flagPath = join(root, "from-flag");
    await mkdir(flagPath, { recursive: true });
    const result = await resolveVault({
      flagVault: flagPath,
      env: { NOTIENT_VAULT: join(root, "from-env") },
      cwd: join(root, "from-cwd"),
      stateLoader: async () => null,
    });
    expect(result).toBe(flagPath);
  });

  test("env var fires when no flag", async () => {
    const envPath = join(root, "from-env");
    await mkdir(envPath, { recursive: true });
    const result = await resolveVault({
      flagVault: null,
      env: { NOTIENT_VAULT: envPath },
      cwd: join(root, "from-cwd"),
      stateLoader: async () => null,
    });
    expect(result).toBe(envPath);
  });

  test("cwd with .notient/ wins over state", async () => {
    const cwd = join(root, "vault-cwd");
    await mkdir(join(cwd, ".notient"), { recursive: true });
    const result = await resolveVault({
      flagVault: null,
      env: {},
      cwd,
      stateLoader: async () => "/some/other",
    });
    expect(result).toBe(cwd);
  });

  test("walks up parents to find .obsidian/", async () => {
    const parent = join(root, "parent");
    const child = join(parent, "child");
    await mkdir(join(parent, ".obsidian"), { recursive: true });
    await mkdir(child, { recursive: true });
    const result = await resolveVault({
      flagVault: null,
      env: {},
      cwd: child,
      stateLoader: async () => null,
    });
    expect(result).toBe(parent);
  });

  test("falls back to last vault from state", async () => {
    const lastVault = join(root, "last");
    await mkdir(lastVault, { recursive: true });
    const result = await resolveVault({
      flagVault: null,
      env: {},
      cwd: join(root, "stranger"),
      stateLoader: async () => lastVault,
    });
    expect(result).toBe(lastVault);
  });

  test("throws helpful error when nothing matches", async () => {
    await expect(
      resolveVault({
        flagVault: null,
        env: {},
        cwd: join(root, "stranger"),
        stateLoader: async () => null,
      }),
    ).rejects.toThrow("No vault");
  });
});
