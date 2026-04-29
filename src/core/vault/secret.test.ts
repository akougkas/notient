import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOrGenerateSecret } from "./secret";

describe("readOrGenerateSecret", () => {
  let tempDir: string;
  let secretPath: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `notient-secret-${randomBytes(8).toString("hex")}`);
    secretPath = join(tempDir, "nested", "secret.key");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("generates secret on first read with correct mode and length", async () => {
    const secret = await readOrGenerateSecret(secretPath);

    expect(typeof secret).toBe("string");
    const decoded = Buffer.from(secret, "base64");
    expect(decoded.byteLength).toBe(64);

    const fileStat = await stat(secretPath);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const onDisk = await readFile(secretPath, "utf8");
    expect(onDisk).toBe(secret);
  });

  test("returns same secret on subsequent reads without modifying file", async () => {
    const first = await readOrGenerateSecret(secretPath);
    const firstStat = await stat(secretPath);

    const second = await readOrGenerateSecret(secretPath);
    const secondStat = await stat(secretPath);

    expect(second).toBe(first);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
    expect(secondStat.size).toBe(firstStat.size);
  });

  test("throws when existing file has permissive mode", async () => {
    await mkdir(join(tempDir, "nested"), { recursive: true, mode: 0o700 });
    await writeFile(secretPath, "preexisting", { mode: 0o600 });
    await chmod(secretPath, 0o644);

    await expect(readOrGenerateSecret(secretPath)).rejects.toThrow(/permissions/);
  });
});
