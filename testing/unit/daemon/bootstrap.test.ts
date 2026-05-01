/**
 * Phase 4 Task 4 bootstrap-wiring smoke harness for HistoryService.
 *
 * The substrate test proves the closure contract Task 9 introduced: the
 * `recordHistory` closure that bootstrap installs into the chat tool
 * registry must call HistoryService.record so that
 * `historyService.getRecent(1)` returns the row a chat write produced.
 * The full bootstrap path requires LM Studio plus the live FsVault, so
 * these tests reproduce just the closure shape against a real SurrealDB
 * fixture (Task 4 migrated HistoryService off the in-memory SQLite
 * mirror to SurrealDB).
 *
 * Skipped by default; run with `bun run test:smoke` (sets
 * NOTIENT_SMOKE=1) or `NOTIENT_SMOKE=1 bun test src/daemon/`.
 *
 * The third describe block (`buildHistoryInverters`) does not touch
 * SurrealDB and runs unconditionally.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FsVault } from "../../../src/adapters/fsVault";
import { ApprovalService } from "../../../src/core/approvals/approvalService";
import type { NotesHistoryRecord } from "../../../src/core/chat/tools/notes";
import type { ToolCall } from "../../../src/core/chat/types";
import { Coordinator } from "../../../src/core/coordinator/coordinator";
import { ReasoningMutex } from "../../../src/core/coordinator/reasoningMutex";
import type { Agent, AgentRunResult } from "../../../src/core/coordinator/types";
import { applySchema } from "../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../src/core/db/surreal";
import { EventBus } from "../../../src/core/events/eventBus";
import { HistoryService } from "../../../src/core/history/historyService";
import type { HistoryKind } from "../../../src/core/history/types";
import { Kernel } from "../../../src/core/kernel";
import {
  buildHistoryInverters,
  buildRecordHistoryAutoApprove,
  readEnvSource,
} from "../../../src/daemon/bootstrap";
import { type SurrealServerHandle, startSurreal } from "../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

describe("bootstrap buildHistoryInverters", () => {
  test("registers an inverter for every body-edit HistoryKind", async () => {
    const inverters = buildHistoryInverters({
      writeNote: async () => {},
      removeNote: async () => {},
      noteExists: async () => false,
      hash: async () => "sha",
      updateNoteSha: async () => {},
    });
    // Phase 4 Task 3 retired edge.* and node.* inverters; rejections under
    // the SurrealDB approval flow are total deletes that record no history
    // row, and approvals route through ApprovalService directly. The
    // body-edit kinds remain because /undo of a body mutation is still a
    // file-restore operation against the vault.
    const expected: HistoryKind[] = [
      "note.append_section",
      "note.frontmatter",
      "note.maturity",
      "notes.create",
      "notes.append",
      "notes.replace_section",
      "notes.update_frontmatter",
    ];
    for (const kind of expected) {
      expect(typeof inverters[kind]).toBe("function");
    }
    expect(inverters["edge.approve"]).toBeUndefined();
    expect(inverters["edge.reject"]).toBeUndefined();
    expect(inverters["node.approve"]).toBeUndefined();
    expect(inverters["node.reject"]).toBeUndefined();
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
    const vault = new FsVault(vaultRoot);
    const result = await readEnvSource(vault, { NOTIENT_LLM_MODEL: "from-process-env" });
    expect(result.NOTIENT_LLM_MODEL).toBe("from-vault-file");
  });

  test("process env is the fallback when only process env defines the key", async () => {
    const vault = new FsVault(vaultRoot);
    const result = await readEnvSource(vault, { NOTIENT_LLM_MODEL: "from-process-env" });
    expect(result.NOTIENT_LLM_MODEL).toBe("from-process-env");
  });

  test("vault .env value is used when only the vault file defines the key", async () => {
    await writeFile(
      path.join(vaultRoot, ".notient", ".env"),
      "NOTIENT_LLM_MODEL=from-vault-file\n",
    );
    const vault = new FsVault(vaultRoot);
    const result = await readEnvSource(vault, {});
    expect(result.NOTIENT_LLM_MODEL).toBe("from-vault-file");
  });

  test("merges keys from both sources with vault winning per-key", async () => {
    await writeFile(
      path.join(vaultRoot, ".notient", ".env"),
      "NOTIENT_LLM_MODEL=vault-model\nNOTIENT_LLM_BASE_URL=http://vault:1234/v1\n",
    );
    const vault = new FsVault(vaultRoot);
    const result = await readEnvSource(vault, {
      NOTIENT_LLM_MODEL: "process-model",
      NOTIENT_EMBED_MODEL: "process-embed",
    });
    expect(result.NOTIENT_LLM_MODEL).toBe("vault-model");
    expect(result.NOTIENT_LLM_BASE_URL).toBe("http://vault:1234/v1");
    expect(result.NOTIENT_EMBED_MODEL).toBe("process-embed");
  });

  test("ignores keys outside the recognized NOTIENT_ allowlist", async () => {
    await writeFile(
      path.join(vaultRoot, ".notient", ".env"),
      "NOTIENT_LLM_MODEL=vault-model\nUNRELATED_KEY=should-be-dropped\n",
    );
    const vault = new FsVault(vaultRoot);
    const result = await readEnvSource(vault, { ANOTHER_UNRELATED: "also-dropped" });
    expect(result.NOTIENT_LLM_MODEL).toBe("vault-model");
    expect((result as Record<string, string>).UNRELATED_KEY).toBeUndefined();
    expect((result as Record<string, string>).ANOTHER_UNRELATED).toBeUndefined();
  });
});
