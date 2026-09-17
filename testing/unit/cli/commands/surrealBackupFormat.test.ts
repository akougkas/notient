import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_FILE_HEADER,
  createBackupAuthenticator,
  formatBackupAuthTrailer,
  formatBackupEmbeddingManifest,
  stageVerifiedBackup,
  verifyBackupAuthentication,
} from "../../../../src/cli/commands/surrealBackupFormat";

describe("authenticated records backup format", () => {
  const secret = "unit-vault-secret";
  const embedding = { model: "local/embed-model", dimension: 768 };
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function writeBackup(body: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "notient-backup-format-test-"));
    roots.push(root);
    const path = join(root, "backup.surql");
    const authenticated = `${BACKUP_FILE_HEADER}${formatBackupEmbeddingManifest(embedding)}${body}`;
    const digest = createBackupAuthenticator(secret).update(authenticated).digest("hex");
    await writeFile(path, `${authenticated}${formatBackupAuthTrailer(digest)}`);
    return path;
  }

  test("stages an authentic backup privately before import", async () => {
    const source = await writeBackup("OPTION IMPORT;\nBEGIN TRANSACTION;\nCOMMIT TRANSACTION;\n");

    await expect(verifyBackupAuthentication(source, secret)).resolves.toEqual(embedding);
    const staged = await stageVerifiedBackup(source, secret);
    try {
      expect(staged.path).not.toBe(source);
      expect((await stat(staged.path)).mode & 0o777).toBe(0o600);
      expect(await Bun.file(staged.path).text()).toBe(await Bun.file(source).text());
      expect(staged.embedding).toEqual(embedding);
    } finally {
      await staged.cleanup();
    }
  });

  test("rejects tampering, a wrong vault secret, and arbitrary SurrealQL", async () => {
    const source = await writeBackup("OPTION IMPORT;\n");
    const authenticated = await Bun.file(source).text();
    await writeFile(source, authenticated.replace("OPTION IMPORT", "DEFINE ACCESS root"));

    await expect(verifyBackupAuthentication(source, secret)).rejects.toThrow("authentic Notient");

    const valid = await writeBackup("OPTION IMPORT;\n");
    await expect(verifyBackupAuthentication(valid, "wrong-secret")).rejects.toThrow(
      "authentic Notient",
    );

    const root = await mkdtemp(join(tmpdir(), "notient-arbitrary-surql-test-"));
    roots.push(root);
    const arbitrary = join(root, "arbitrary.surql");
    await writeFile(arbitrary, "DEFINE ACCESS dangerous ON DATABASE TYPE JWT;\n");
    await expect(stageVerifiedBackup(arbitrary, secret)).rejects.toThrow("authentic Notient");
  });
});
