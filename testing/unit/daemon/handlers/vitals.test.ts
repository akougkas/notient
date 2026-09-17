import { describe, expect, test } from "bun:test";
import { VaultPathError } from "../../../../src/adapters/vaultAdapter";
import type { VitalsSnapshot } from "../../../../src/core/vitals/types";
import type { VitalsService } from "../../../../src/core/vitals/vitalsService";
import { makeVitalsHandler } from "../../../../src/daemon/handlers/vitals";
import { RpcError } from "../../../../src/daemon/rpc";
import { rpcRequest } from "../../../rpcRequest";

const FIXTURE_SNAPSHOT: VitalsSnapshot = {
  path: "note.md",
  health: 0.78,
  freshness: 0.6,
  connectivity: "warm",
  maturity: "mature",
} as unknown as VitalsSnapshot;

const accessibleVault = { exists: async () => true };

describe("vitals handler", () => {
  test("returns the snapshot and emits an event", async () => {
    const service = {
      computeSnapshot: async () => FIXTURE_SNAPSHOT,
    } as unknown as VitalsService;
    const checked: string[] = [];
    const handler = makeVitalsHandler({
      vitalsService: service,
      vault: {
        exists: async (path) => {
          checked.push(path);
          return true;
        },
      },
    });
    const lines: string[] = [];
    const result = await handler(
      rpcRequest({ path: "note.md" }, { emit: (line) => lines.push(line) }),
    );
    expect(result.snapshot).toEqual(FIXTURE_SNAPSHOT);
    expect(checked).toEqual(["note.md"]);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).event).toBe("vitals:snapshot");
  });

  test("rejects empty path", async () => {
    const service = { computeSnapshot: async () => FIXTURE_SNAPSHOT } as unknown as VitalsService;
    const handler = makeVitalsHandler({ vitalsService: service, vault: accessibleVault });
    let thrown: unknown = null;
    try {
      await handler(rpcRequest());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  test("returns INVALID_PARAMS when the note is not indexed", async () => {
    const service = { computeSnapshot: async () => null } as unknown as VitalsService;
    const handler = makeVitalsHandler({ vitalsService: service, vault: accessibleVault });
    let thrown: unknown = null;
    try {
      await handler(rpcRequest({ path: "missing.md" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("not indexed");
  });

  test("rejects a nonpublic path before filesystem or vitals access", async () => {
    let touched = false;
    const service = {
      computeSnapshot: async () => {
        touched = true;
        return FIXTURE_SNAPSHOT;
      },
    } as unknown as VitalsService;
    const handler = makeVitalsHandler({
      vitalsService: service,
      vault: {
        exists: async () => {
          touched = true;
          return true;
        },
      },
    });

    const error = await handler(rpcRequest({ path: "../outside.md" })).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe("INVALID_PARAMS");
    expect(touched).toBe(false);
  });

  test("rejects missing and symlink-escaping notes before vitals computation", async () => {
    for (const vault of [
      { exists: async () => false },
      {
        exists: async () => {
          throw new VaultPathError("escape");
        },
      },
    ]) {
      let computed = false;
      const service = {
        computeSnapshot: async () => {
          computed = true;
          return FIXTURE_SNAPSHOT;
        },
      } as unknown as VitalsService;
      const handler = makeVitalsHandler({ vitalsService: service, vault });

      const error = await handler(rpcRequest({ path: "escape/secret.md" })).catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe("INVALID_PARAMS");
      expect(computed).toBe(false);
    }
  });
});
