/**
 * Phase 5 Task 11 reindex CLI module-shape tests.
 *
 * The end-to-end timestamp-clearing assertions live alongside the
 * daemon handler in `src/daemon/handlers/awaken.test.ts` (the daemon
 * handler is the layer that actually issues the `UPDATE note SET
 * tier{N}_at = NONE` query). These tests pin the CLI module's public
 * surface so accidental rewires of `runReindexCommand` show up as a
 * failing import at type-check time.
 */

import { describe, expect, test } from "bun:test";
import { runReindexCommand } from "./reindex";

describe("reindex CLI module shape", () => {
  test("module exports the runReindexCommand entrypoint", () => {
    expect(typeof runReindexCommand).toBe("function");
  });
});
