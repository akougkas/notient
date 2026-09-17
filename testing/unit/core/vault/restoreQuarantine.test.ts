import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vaultRestoreQuarantinePath } from "../../../../src/core/vault/identity";
import {
  armRestoreQuarantine,
  assertRestoreQuarantineClear,
  clearRestoreQuarantine,
} from "../../../../src/core/vault/restoreQuarantine";

describe("restore quarantine", () => {
  let root: string;
  let originalHome: string | undefined;
  const vaultPath = "/vault";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-restore-quarantine-"));
    originalHome = process.env.HOME;
    process.env.HOME = root;
  });

  afterEach(async () => {
    if (originalHome === undefined) process.env.HOME = undefined;
    else process.env.HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  });

  test("blocks restart until an explicit safe clear", async () => {
    await expect(assertRestoreQuarantineClear(vaultPath)).resolves.toBeUndefined();
    await armRestoreQuarantine(vaultPath);
    expect((await stat(vaultRestoreQuarantinePath(vaultPath))).mode & 0o777).toBe(0o600);
    await expect(assertRestoreQuarantineClear(vaultPath)).rejects.toThrow("notient nuke --yes");
    await expect(armRestoreQuarantine(vaultPath)).rejects.toThrow("remains quarantined");

    await clearRestoreQuarantine(vaultPath);

    await expect(assertRestoreQuarantineClear(vaultPath)).resolves.toBeUndefined();
  });
});
