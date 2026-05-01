import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordId } from "surrealdb";
import { applySchema } from "../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  relateEdge,
  replaceChunks,
  upsertClaim,
  upsertConcept,
  upsertNoteByPath,
  upsertQuestion,
} from "../../../src/core/db/surreal";
import { EventBus } from "../../../src/core/events/eventBus";
import { type SurrealServerHandle, startSurreal } from "../../../src/daemon/surrealServer";
import { VaultWatcher, isWslPath } from "../../../src/daemon/watcher";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";
const VECTOR_DIM = 768;

async function waitFor<T>(
  predicate: () => Promise<T | null>,
  timeoutMs: number,
  pollMs = 25,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result !== null) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

describe("isWslPath", () => {
  test("matches /mnt/<letter>/ paths", () => {
    expect(isWslPath("/mnt/c/Users/x")).toBe(true);
    expect(isWslPath("/mnt/d/projects")).toBe(true);
  });

  test("rejects native paths", () => {
    expect(isWslPath("/home/user/notes")).toBe(false);
    expect(isWslPath("/tmp/v")).toBe(false);
  });
});
