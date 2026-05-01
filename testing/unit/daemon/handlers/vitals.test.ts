import { describe, expect, test } from "bun:test";
import type { VitalsSnapshot } from "../../../../src/core/vitals/types";
import type { VitalsService } from "../../../../src/core/vitals/vitalsService";
import { makeVitalsHandler } from "../../../../src/daemon/handlers/vitals";

const FIXTURE_SNAPSHOT: VitalsSnapshot = {
  path: "note.md",
  health: 0.78,
  freshness: 0.6,
  connectivity: "warm",
  maturity: "mature",
} as unknown as VitalsSnapshot;

describe("vitals handler", () => {
  test("returns the snapshot and emits an event", async () => {
    const service = {
      computeSnapshot: async () => FIXTURE_SNAPSHOT,
    } as unknown as VitalsService;
    const handler = makeVitalsHandler({ vitalsService: service });
    const lines: string[] = [];
    const result = await handler({ path: "note.md" }, (line) => lines.push(line), "req-1");
    expect(result.snapshot).toEqual(FIXTURE_SNAPSHOT);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).event).toBe("vitals:snapshot");
  });

  test("rejects empty path", async () => {
    const service = { computeSnapshot: async () => FIXTURE_SNAPSHOT } as unknown as VitalsService;
    const handler = makeVitalsHandler({ vitalsService: service });
    let thrown: unknown = null;
    try {
      await handler({}, () => {}, "req-1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  test("returns INVALID_PARAMS when the note is not indexed", async () => {
    const service = { computeSnapshot: async () => null } as unknown as VitalsService;
    const handler = makeVitalsHandler({ vitalsService: service });
    let thrown: unknown = null;
    try {
      await handler({ path: "missing.md" }, () => {}, "req-1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("not indexed");
  });
});
