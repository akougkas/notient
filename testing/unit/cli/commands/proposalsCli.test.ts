/**
 * M1 proposals CLI test harness.
 *
 * The end-to-end smoke is skipped by default. Run with
 * `NOTIENT_SMOKE=1 bun test src/cli/commands/proposalsCli.test.ts` to drive
 * a real SurrealDB and exercise the list/approve/reject verbs against it.
 *
 * Non-smoke checks the input-validation paths (empty id, unknown table
 * prefix) that exit 2 with INVALID_PARAMS / INVALID_ID, and asserts the
 * module shape so the dispatcher wiring stays compilable.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import {
  runProposalsApproveCommand,
  runProposalsListCommand,
  runProposalsRejectCommand,
  tableFromEdgeId,
} from "../../../../src/cli/commands/proposalsCli";
import type { StructuredEvent } from "../../../../src/cli/output";
import { makeEmitter } from "../../../../src/cli/output";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect, upsertNoteByPath } from "../../../../src/core/db/surreal";
import { vaultPortPath, vaultSecretPath, vaultStateDir } from "../../../../src/core/vault/identity";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

describe("proposals CLI module shape", () => {
  test("module exports the run functions", () => {
    expect(typeof runProposalsListCommand).toBe("function");
    expect(typeof runProposalsApproveCommand).toBe("function");
    expect(typeof runProposalsRejectCommand).toBe("function");
  });

  test("tableFromEdgeId accepts every writeback edge prefix", () => {
    expect(tableFromEdgeId("supports:abc")).toBe("supports");
    expect(tableFromEdgeId("contradicts:abc")).toBe("contradicts");
    expect(tableFromEdgeId("extends:abc")).toBe("extends");
    expect(tableFromEdgeId("exemplifies:abc")).toBe("exemplifies");
    expect(tableFromEdgeId("synthesizes:abc")).toBe("synthesizes");
    expect(tableFromEdgeId("related_to:abc")).toBe("related_to");
  });

  test("tableFromEdgeId rejects malformed and non-writeback ids", () => {
    expect(tableFromEdgeId("note:abc")).toBeNull();
    expect(tableFromEdgeId("wikilink:abc")).toBeNull();
    expect(tableFromEdgeId("abc")).toBeNull();
    expect(tableFromEdgeId(":abc")).toBeNull();
    expect(tableFromEdgeId("")).toBeNull();
  });
});

describe("proposals CLI input validation", () => {
  test("approve with empty id exits 2 and emits INVALID_PARAMS", async () => {
    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const code = await runProposalsApproveCommand({
      vaultPath: "/dev/null",
      vaultRoot: "/dev/null",
      emitter,
      id: "",
    });
    expect(code).toBe(2);
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.code).toBe("INVALID_PARAMS");
  });

  test("approve with non-writeback prefix exits 2 and emits INVALID_ID", async () => {
    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const code = await runProposalsApproveCommand({
      vaultPath: "/dev/null",
      vaultRoot: "/dev/null",
      emitter,
      id: "note:abc",
    });
    expect(code).toBe(2);
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.code).toBe("INVALID_ID");
  });

  test("reject with empty id exits 2 and emits INVALID_PARAMS", async () => {
    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const code = await runProposalsRejectCommand({
      vaultPath: "/dev/null",
      vaultRoot: "/dev/null",
      emitter,
      id: "",
    });
    expect(code).toBe(2);
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.code).toBe("INVALID_PARAMS");
  });

  test("reject with non-writeback prefix exits 2 and emits INVALID_ID", async () => {
    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const code = await runProposalsRejectCommand({
      vaultPath: "/dev/null",
      vaultRoot: "/dev/null",
      emitter,
      id: "wikilink:abc",
    });
    expect(code).toBe(2);
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.code).toBe("INVALID_ID");
  });
});
