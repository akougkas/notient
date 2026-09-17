import { createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BACKUP_FILE_HEADER = "-- NOTIENT RECORD BACKUP v2\n";
const AUTH_DOMAIN = "notient-record-backup-v2\0";
const EMBEDDING_MANIFEST_PREFIX = "-- NOTIENT EMBEDDING ";
const MAX_EMBEDDING_MANIFEST_BYTES = 4_096;
const AUTH_TRAILER_PREFIX = "\n-- NOTIENT AUTH HMAC-SHA256 ";
const AUTH_HEX_LENGTH = 64;
const AUTH_TRAILER_LENGTH = AUTH_TRAILER_PREFIX.length + AUTH_HEX_LENGTH + 1;

export interface StagedBackup {
  path: string;
  embedding: BackupEmbeddingManifest;
  cleanup(): Promise<void>;
}

export interface BackupEmbeddingManifest {
  model: string;
  dimension: number;
}

/**
 * Authenticate the exact bytes Notient writes before the trailer. The domain
 * separator prevents the per-vault database credential from becoming a
 * general-purpose MAC key.
 */
export function createBackupAuthenticator(secret: string): ReturnType<typeof createHmac> {
  if (secret.length === 0) throw new Error("backup authentication secret must not be empty");
  return createHmac("sha256", secret).update(AUTH_DOMAIN);
}

export function formatBackupAuthTrailer(digestHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(digestHex)) {
    throw new Error("backup authentication digest must be lowercase SHA-256 hex");
  }
  return `${AUTH_TRAILER_PREFIX}${digestHex}\n`;
}

export function formatBackupEmbeddingManifest(manifest: BackupEmbeddingManifest): string {
  validateEmbeddingManifest(manifest);
  const line = `${EMBEDDING_MANIFEST_PREFIX}${JSON.stringify({
    model: manifest.model,
    dimension: manifest.dimension,
  })}\n`;
  if (Buffer.byteLength(line) > MAX_EMBEDDING_MANIFEST_BYTES) {
    throw new Error("backup embedding model id is too long");
  }
  return line;
}

/**
 * Copy an operator-selected backup into a private immutable-for-this-run
 * staging location, then authenticate that staged inode before it can reach
 * the privileged SurrealDB importer. Old, edited, truncated, and arbitrary
 * SurrealQL files are rejected without executing a byte of their contents.
 */
export async function stageVerifiedBackup(
  inputPath: string,
  secret: string,
): Promise<StagedBackup> {
  const inputStat = await stat(inputPath);
  if (!inputStat.isFile()) throw new Error("restore input must be a regular file");

  const directory = await mkdtemp(join(tmpdir(), "notient-restore-"));
  await chmod(directory, 0o700);
  const stagedPath = join(directory, "records-v2.surql");
  try {
    await copyFile(inputPath, stagedPath, constants.COPYFILE_EXCL);
    await chmod(stagedPath, 0o600);
    const embedding = await verifyBackupAuthentication(stagedPath, secret);
    return {
      path: stagedPath,
      embedding,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function verifyBackupAuthentication(
  filePath: string,
  secret: string,
): Promise<BackupEmbeddingManifest> {
  const handle = await open(filePath, "r");
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error("restore input must be a regular file");
    const minimumLength = BACKUP_FILE_HEADER.length + AUTH_TRAILER_LENGTH;
    if (fileStat.size < minimumLength) throw invalidBackup();

    const trailer = Buffer.alloc(AUTH_TRAILER_LENGTH);
    const trailerOffset = fileStat.size - AUTH_TRAILER_LENGTH;
    const trailerRead = await handle.read(trailer, 0, trailer.length, trailerOffset);
    if (trailerRead.bytesRead !== trailer.length) throw invalidBackup();
    const trailerText = trailer.toString("utf8");
    if (!trailerText.startsWith(AUTH_TRAILER_PREFIX) || !trailerText.endsWith("\n")) {
      throw invalidBackup();
    }
    const expectedHex = trailerText.slice(AUTH_TRAILER_PREFIX.length, -1);
    if (!/^[0-9a-f]{64}$/.test(expectedHex)) throw invalidBackup();

    const header = Buffer.alloc(BACKUP_FILE_HEADER.length);
    const headerRead = await handle.read(header, 0, header.length, 0);
    if (headerRead.bytesRead !== header.length || header.toString("utf8") !== BACKUP_FILE_HEADER) {
      throw invalidBackup();
    }

    const authenticator = createBackupAuthenticator(secret);
    const stream = handle.createReadStream({
      start: 0,
      end: trailerOffset - 1,
      autoClose: false,
    });
    for await (const chunk of stream) authenticator.update(chunk);
    const actual = authenticator.digest();
    const expected = Buffer.from(expectedHex, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw invalidBackup();
    }
    return await readEmbeddingManifest(handle);
  } finally {
    await handle.close();
  }
}

function invalidBackup(): Error {
  return new Error("restore input is not an authentic Notient records backup v2");
}

async function readEmbeddingManifest(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<BackupEmbeddingManifest> {
  const buffer = Buffer.alloc(BACKUP_FILE_HEADER.length + MAX_EMBEDDING_MANIFEST_BYTES);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  const prefix = buffer.subarray(0, bytesRead).toString("utf8");
  if (!prefix.startsWith(BACKUP_FILE_HEADER)) throw invalidBackup();
  const lineEnd = prefix.indexOf("\n", BACKUP_FILE_HEADER.length);
  if (lineEnd < 0) throw invalidBackup();
  const line = prefix.slice(BACKUP_FILE_HEADER.length, lineEnd);
  if (!line.startsWith(EMBEDDING_MANIFEST_PREFIX)) throw invalidBackup();

  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(EMBEDDING_MANIFEST_PREFIX.length));
  } catch {
    throw invalidBackup();
  }
  try {
    validateEmbeddingManifest(parsed);
  } catch {
    throw invalidBackup();
  }
  return parsed as BackupEmbeddingManifest;
}

function validateEmbeddingManifest(value: unknown): asserts value is BackupEmbeddingManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("backup embedding manifest must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.length !== 2 || keys[0] !== "dimension" || keys[1] !== "model") {
    throw new Error("backup embedding manifest fields are invalid");
  }
  if (
    typeof candidate.model !== "string" ||
    candidate.model.length === 0 ||
    candidate.model.trim() !== candidate.model ||
    [...candidate.model].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error("backup embedding model id is invalid");
  }
  if (
    typeof candidate.dimension !== "number" ||
    !Number.isSafeInteger(candidate.dimension) ||
    candidate.dimension <= 0
  ) {
    throw new Error("backup embedding dimension must be a positive integer");
  }
}
