/**
 * Phase 5 Task 9 graph dump CLI smoke harness.
 *
 * Skipped by default. Run with `NOTIENT_SMOKE=1 bun test src/cli/commands/graphDump.test.ts`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema, hand-writes a per-vault
 * state directory under a tempdir-rooted `HOME`, seeds a fixture graph
 * (two notes, a wikilink, a linker proposal), and exercises the three
 * tier filters and three output formats end-to-end.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import {
  type DumpedGraph,
  parseDumpFormat,
  parseDumpTier,
  runGraphDumpCommand,
} from "../../../../src/cli/commands/graphDump";
import { makeEmitter } from "../../../../src/cli/output";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect, upsertNoteByPath } from "../../../../src/core/db/surreal";
import { vaultPortPath, vaultSecretPath, vaultStateDir } from "../../../../src/core/vault/identity";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

describe("graph dump argument parsers", () => {
  test("parseDumpTier accepts 1, 2, 3", () => {
    expect(parseDumpTier("1")).toBe(1);
    expect(parseDumpTier("2")).toBe(2);
    expect(parseDumpTier("3")).toBe(3);
    expect(parseDumpTier(undefined)).toBeUndefined();
  });

  test("parseDumpTier rejects out-of-range and non-numeric", () => {
    expect(() => parseDumpTier("0")).toThrow();
    expect(() => parseDumpTier("4")).toThrow();
    expect(() => parseDumpTier("abc")).toThrow();
  });

  test("parseDumpFormat defaults to json and accepts the three supported formats", () => {
    expect(parseDumpFormat(undefined)).toBe("json");
    expect(parseDumpFormat("json")).toBe("json");
    expect(parseDumpFormat("graphml")).toBe("graphml");
    expect(parseDumpFormat("cypher")).toBe("cypher");
  });

  test("parseDumpFormat rejects unknown formats", () => {
    expect(() => parseDumpFormat("dot")).toThrow();
  });
});
