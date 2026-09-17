import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DateTime, RecordId, type Surreal } from "surrealdb";
import { FsVault } from "../../../src/adapters/fsVault";
import type { SurrealConnection } from "../../../src/core/db/surreal";
import type { HistoryKind, HistoryRow } from "../../../src/core/history/types";
import { readEnvSource } from "../../../src/core/settings/envFile";
import {
  assertMutationReconciliationSucceeded,
  buildHistoryInverters,
  validateProposalHistoryTarget,
} from "../../../src/daemon/bootstrap";

describe("bootstrap mutation reconciliation fence", () => {
  test("refuses startup when either durable mutation authority reports a failure", () => {
    expect(() => assertMutationReconciliationSucceeded("ordinary note write", 1)).toThrow(
      "mutation admission remains closed",
    );
    expect(() => assertMutationReconciliationSucceeded("approved proposal", 1)).toThrow(
      "mutation admission remains closed",
    );
    expect(() => assertMutationReconciliationSucceeded("ordinary note write", 0)).not.toThrow();
    expect(() => assertMutationReconciliationSucceeded("approved proposal", 0)).not.toThrow();
  });
});

describe("bootstrap buildHistoryInverters", () => {
  test("registers an inverter for every body-edit HistoryKind", async () => {
    const inverters = buildHistoryInverters({
      readNote: async () => "",
      writeNoteIfUnchanged: async () => true,
      removeNoteIfUnchanged: async () => true,
      noteExists: async () => false,
      hash: async () => "sha",
      updateNoteSha: async () => {},
      validateTargetIdentity: async () => true,
    });
    const expected: HistoryKind[] = [
      "note.append_section",
      "note.frontmatter",
      "notes.create",
      "notes.append",
      "notes.replace_section",
      "notes.update_frontmatter",
    ];
    for (const kind of expected) {
      expect(typeof inverters[kind]).toBe("function");
    }
  });

  test("validates an accepted proposal against its exact nanosecond revision", async () => {
    const edge = new RecordId("related_to", "abcdefghijklmnopqrst");
    const calls: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
    const connection = {
      db: {
        query: (sql: string, bindings?: Record<string, unknown>) => {
          calls.push({ sql, bindings });
          return { collect: async () => [[{ id: edge }]] };
        },
      } as unknown as Surreal,
      close: async () => {},
    } satisfies SurrealConnection;
    const row: HistoryRow = {
      id: 'history:u"01900000-0000-7000-8000-000000000001"',
      kind: "note.append_section",
      target: "0-inbox/probe.md",
      before: "before",
      after: "after",
      createdAt: 1,
      clientIdentity: "human",
      proposalEdge: edge.toString(),
      proposalCreatedAt: new DateTime("2026-08-30T17:25:24.236542578Z").toString(),
      undo: null,
    };

    await expect(validateProposalHistoryTarget(connection, row)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("FROM $edge WHERE");
    expect(calls[0]?.sql).not.toContain("FROM ONLY");
    expect(calls[0]?.bindings?.createdAt).toBe("2026-08-30T17:25:24.236542578Z");
  });
});

describe("bootstrap readEnvSource", () => {
  /**
   * Phase 4 Task M4: vault `.env` wins over process env. Notient is a
   * per-vault local tool, so an operator who pins a model in the vault
   * file expects the file to bind the daemon. Process env stays as the
   * fallback so operators with no vault `.env` still work.
   */
  let tempDir: string;
  let vaultRoot: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-bootstrap-readenv-"));
    vaultRoot = path.join(tempDir, "vault");
    await mkdir(path.join(vaultRoot, ".notient"), { recursive: true });
  });

  afterAll(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    await unlink(path.join(vaultRoot, ".notient", ".env")).catch(() => {
      // missing-file is not an error for cleanup
    });
  });

  test("vault .env wins when both vault file and process env define the same key", async () => {
    await writeFile(
      path.join(vaultRoot, ".notient", ".env"),
      "NOTIENT_LLM_MODEL=from-vault-file\n",
    );
    const vault = new FsVault(vaultRoot, { allowHiddenPaths: true });
    const result = await readEnvSource(vault, { NOTIENT_LLM_MODEL: "from-process-env" });
    expect(result.NOTIENT_LLM_MODEL).toBe("from-vault-file");
  });

  test("process env is the fallback when only process env defines the key", async () => {
    const vault = new FsVault(vaultRoot, { allowHiddenPaths: true });
    const result = await readEnvSource(vault, { NOTIENT_LLM_MODEL: "from-process-env" });
    expect(result.NOTIENT_LLM_MODEL).toBe("from-process-env");
  });

  test("an explicit empty vault key masks the same ambient process key", async () => {
    await writeFile(path.join(vaultRoot, ".notient", ".env"), "NOTIENT_LLM_MODEL=\n");
    const vault = new FsVault(vaultRoot, { allowHiddenPaths: true });
    const result = await readEnvSource(vault, { NOTIENT_LLM_MODEL: "from-process-env" });
    expect(result.NOTIENT_LLM_MODEL).toBeUndefined();
  });

  test("vault .env value is used when only the vault file defines the key", async () => {
    await writeFile(
      path.join(vaultRoot, ".notient", ".env"),
      "NOTIENT_LLM_MODEL=from-vault-file\n",
    );
    const vault = new FsVault(vaultRoot, { allowHiddenPaths: true });
    const result = await readEnvSource(vault, {});
    expect(result.NOTIENT_LLM_MODEL).toBe("from-vault-file");
  });

  test("merges keys from both sources with vault winning per-key", async () => {
    await writeFile(
      path.join(vaultRoot, ".notient", ".env"),
      "NOTIENT_LLM_MODEL=vault-model\nNOTIENT_LLM_BASE_URL=http://vault:1234/v1\n",
    );
    const vault = new FsVault(vaultRoot, { allowHiddenPaths: true });
    const result = await readEnvSource(vault, {
      NOTIENT_LLM_MODEL: "process-model",
      NOTIENT_EMBED_MODEL: "process-embed",
    });
    expect(result.NOTIENT_LLM_MODEL).toBe("vault-model");
    expect(result.NOTIENT_LLM_BASE_URL).toBe("http://vault:1234/v1");
    expect(result.NOTIENT_EMBED_MODEL).toBe("process-embed");
  });

  test("carries endpoint credentials through the recognized private env allowlist", async () => {
    await writeFile(
      path.join(vaultRoot, ".notient", ".env"),
      "NOTIENT_LLM_API_KEY=vault-chat-token\nNOTIENT_EMBED_API_KEY=\n",
    );
    const vault = new FsVault(vaultRoot, { allowHiddenPaths: true });
    const result = await readEnvSource(vault, {
      NOTIENT_LLM_API_KEY: "ambient-chat-token",
      NOTIENT_EMBED_API_KEY: "ambient-embed-token",
    });
    expect(result.NOTIENT_LLM_API_KEY).toBe("vault-chat-token");
    expect(result.NOTIENT_EMBED_API_KEY).toBe("");
  });

  test("ignores keys outside the recognized NOTIENT_ allowlist", async () => {
    await writeFile(
      path.join(vaultRoot, ".notient", ".env"),
      "NOTIENT_LLM_MODEL=vault-model\nUNRELATED_KEY=should-be-dropped\n",
    );
    const vault = new FsVault(vaultRoot, { allowHiddenPaths: true });
    const result = await readEnvSource(vault, { ANOTHER_UNRELATED: "also-dropped" });
    expect(result.NOTIENT_LLM_MODEL).toBe("vault-model");
    expect((result as Record<string, string>).UNRELATED_KEY).toBeUndefined();
    expect((result as Record<string, string>).ANOTHER_UNRELATED).toBeUndefined();
  });
});
