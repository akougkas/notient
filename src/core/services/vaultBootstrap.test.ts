import { describe, expect, test } from "bun:test";
import { VaultBootstrap } from "./vaultBootstrap";

interface FakeFacade {
  exists: (path: string) => Promise<boolean>;
  createFolder: (path: string) => Promise<void>;
  created: string[];
  existing: Set<string>;
}

function makeFacade(existing: string[] = []): FakeFacade {
  const facade: FakeFacade = {
    existing: new Set(existing),
    created: [],
    exists: async (path) => facade.existing.has(path),
    createFolder: async (path) => {
      facade.created.push(path);
      facade.existing.add(path);
    },
  };
  return facade;
}

describe("VaultBootstrap", () => {
  test("creates the three Notient folders on first run", async () => {
    const facade = makeFacade();
    const bootstrap = new VaultBootstrap({ facade });
    await bootstrap.run({
      conversationsFolder: "Notient/conversations",
      proposalsFolder: "Notient/proposals",
      savedQueriesFolder: "Notient/searches",
    });
    expect(facade.created).toEqual([
      "Notient",
      "Notient/conversations",
      "Notient/proposals",
      "Notient/searches",
    ]);
  });

  test("skips folders that already exist", async () => {
    const facade = makeFacade(["Notient", "Notient/conversations"]);
    const bootstrap = new VaultBootstrap({ facade });
    await bootstrap.run({
      conversationsFolder: "Notient/conversations",
      proposalsFolder: "Notient/proposals",
      savedQueriesFolder: "Notient/searches",
    });
    expect(facade.created).toEqual(["Notient/proposals", "Notient/searches"]);
  });

  test("creates parent before child even when configured paths share a prefix", async () => {
    const facade = makeFacade();
    const bootstrap = new VaultBootstrap({ facade });
    await bootstrap.run({
      conversationsFolder: "Notient/sub/conversations",
      proposalsFolder: "Notient/sub/proposals",
      savedQueriesFolder: "Notient/sub/searches",
    });
    expect(facade.created[0]).toBe("Notient");
    expect(facade.created[1]).toBe("Notient/sub");
  });
});
