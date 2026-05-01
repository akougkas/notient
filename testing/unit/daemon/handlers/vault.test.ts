import { describe, expect, test } from "bun:test";
import { makeVaultHandlers } from "../../../../src/daemon/handlers/vault";

const fakeVault = {
  list: async (folder: string) => {
    if (folder === "") {
      return {
        files: ["root.md"],
        folders: ["inbox", "Notient", ".notient"],
      };
    }
    if (folder === "inbox") {
      return {
        files: ["inbox/alpha.md", "inbox/beta.md", "inbox/alphabet.md"],
        folders: ["inbox/nested"],
      };
    }
    return { files: [], folders: [] };
  },
};

describe("vault.list", () => {
  test("returns folder children with trailing slash for folders", async () => {
    const handlers = makeVaultHandlers({ vault: fakeVault });
    const result = await handlers.list({ folder: "inbox" }, () => undefined, "envelope-1");
    expect(result.paths).toEqual(["alpha.md", "alphabet.md", "beta.md", "nested/"]);
  });

  test("filter narrows by filename prefix inside a non-root folder", async () => {
    const handlers = makeVaultHandlers({ vault: fakeVault });
    const result = await handlers.list(
      { folder: "inbox", filter: "alpha" },
      () => undefined,
      "envelope-2",
    );
    expect(result.paths).toEqual(["alpha.md", "alphabet.md"]);
  });

  test("excludes .notient and Notient at the root", async () => {
    const handlers = makeVaultHandlers({ vault: fakeVault });
    const result = await handlers.list({ folder: "" }, () => undefined, "envelope-3");
    expect(result.paths).toEqual(["inbox/", "root.md"]);
  });

  test("caps at 200 even when limit is unset", async () => {
    const big = Array.from({ length: 500 }, (_, index) => `n${index}.md`);
    const handlers = makeVaultHandlers({
      vault: { list: async () => ({ files: big, folders: [] }) },
    });
    const result = await handlers.list({}, () => undefined, "envelope-4");
    expect(result.paths.length).toBe(200);
  });
});
