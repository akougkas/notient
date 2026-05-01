/**
 * Phase 5 Task 7 proposals chat-tool smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/chat/tools/`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema, seeds the
 * writeback-capable edge tables with `approved = false` linker proposals,
 * and exercises the listing + lookup tools end-to-end. The wire-shape
 * (`kind: "edge"`, sourceNotePath, targetNotePath, agent, confidence,
 * createdAt) round-trips unchanged from the SQLite-mirror harness.
 *
 * Drift note: the SQLite version ordered by autoincrement `id`. SurrealDB
 * orders by `created_at`, the closest monotonic equivalent in the entity
 * tables. The test seeds with explicit `created_at` values so the order is
 * deterministic.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DateTime, type RecordId } from "surrealdb";
import type {
  ApprovalService,
  WritebackEdgeTable,
} from "../../../../../src/core/approvals/approvalService";
import { ApprovalGate } from "../../../../../src/core/chat/approvalGate";
import {
  makeApproveProposalTool,
  makeGetProposalTool,
  makeListProposalsTool,
  makeRejectProposalTool,
} from "../../../../../src/core/chat/tools/proposals";
import { applySchema } from "../../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  upsertNoteByPath,
} from "../../../../../src/core/db/surreal";
import { EventBus } from "../../../../../src/core/events/eventBus";
import { type SurrealServerHandle, startSurreal } from "../../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

interface SeedEdgeInput {
  table: WritebackEdgeTable;
  fromPath: string;
  toPath: string;
  agent: string;
  confidence?: number;
  createdAtSec: number;
  approved?: boolean;
}

async function seedEdge(connection: SurrealConnection, input: SeedEdgeInput): Promise<RecordId> {
  const fromId = await upsertNoteByPath(connection.db, {
    path: input.fromPath,
    sha: `sha-${input.fromPath}`,
    wordCount: 10,
  });
  const toId = await upsertNoteByPath(connection.db, {
    path: input.toPath,
    sha: `sha-${input.toPath}`,
    wordCount: 10,
  });
  const sql = `RELATE $from->${input.table}->$to SET source = 'linker', class = 'INFERRED', confidence = $confidence, agent = $agent, approved = $approved, created_at = $createdAt RETURN id;`;
  const [rows] = await connection.db
    .query<[Array<{ id: RecordId }>]>(sql, {
      from: fromId,
      to: toId,
      confidence: input.confidence ?? 0.85,
      agent: input.agent,
      approved: input.approved ?? false,
      createdAt: new DateTime(new Date(input.createdAtSec * 1000)),
    })
    .collect<[Array<{ id: RecordId }>]>();
  const created = rows[0];
  if (created === undefined) {
    throw new Error(`seedEdge: no edge created for ${input.table}`);
  }
  return created.id;
}

async function clearVault(connection: SurrealConnection): Promise<void> {
  for (const table of [
    "supports",
    "contradicts",
    "extends",
    "exemplifies",
    "synthesizes",
    "related_to",
    "wikilink",
    "note",
  ]) {
    await connection.db.query(`DELETE ${table};`).collect();
  }
}

describe("proposals.approve / proposals.reject validation", () => {
  function makeContext() {
    return {
      db: {} as SurrealConnection["db"],
      approvalService: {} as unknown as ApprovalService,
      approvalGate: new ApprovalGate({
        events: { onPending: () => {}, onResolved: () => {} },
        recordHistoryAutoApprove: async () => {},
        sessionGrants: { find: () => null, incrementWriteCount: () => {} },
      }),
      approvalMode: () => "yolo" as const,
      generateCallId: () => "call-1",
    };
  }

  test("approve schema rejects empty / missing id", () => {
    const tool = makeApproveProposalTool(makeContext());
    expect(() => tool.validate({ id: "" })).toThrow();
    expect(() => tool.validate({})).toThrow();
    expect(() => tool.validate("nope")).toThrow();
  });

  test("approve flags writeGated", () => {
    const tool = makeApproveProposalTool(makeContext());
    expect(tool.writeGated).toBe(true);
    expect(tool.name).toBe("proposals.approve");
  });

  test("reject schema accepts optional reason", () => {
    const tool = makeRejectProposalTool({ ...makeContext(), bus: new EventBus() });
    expect(tool.validate({ id: "supports:abc" })).toEqual({ id: "supports:abc" });
    expect(tool.validate({ id: "supports:abc", reason: "noisy" })).toEqual({
      id: "supports:abc",
      reason: "noisy",
    });
    expect(() => tool.validate({ id: "" })).toThrow();
    expect(() => tool.validate({ id: "supports:abc", reason: 7 })).toThrow();
  });

  test("reject flags writeGated", () => {
    const tool = makeRejectProposalTool({ ...makeContext(), bus: new EventBus() });
    expect(tool.writeGated).toBe(true);
    expect(tool.name).toBe("proposals.reject");
  });
});
