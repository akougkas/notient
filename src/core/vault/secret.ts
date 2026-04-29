import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const SECRET_BYTE_LENGTH = 64;
const REQUIRED_MODE = 0o600;
const PARENT_DIR_MODE = 0o700;

export async function readOrGenerateSecret(secretPath: string): Promise<string> {
  try {
    const fileStat = await stat(secretPath);
    const mode = fileStat.mode & 0o777;
    if (mode !== REQUIRED_MODE) {
      throw new Error(
        `Secret file at ${secretPath} has insecure permissions ${mode.toString(8)}; expected 600`,
      );
    }
    const contents = await readFile(secretPath, "utf8");
    return contents;
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === "ENOENT") {
      const secret = randomBytes(SECRET_BYTE_LENGTH).toString("base64");
      await mkdir(dirname(secretPath), { recursive: true, mode: PARENT_DIR_MODE });
      await writeFile(secretPath, secret, { mode: REQUIRED_MODE });
      return secret;
    }
    throw error;
  }
}

function isNodeErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string";
}
