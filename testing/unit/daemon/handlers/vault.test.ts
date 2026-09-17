import { describe, expect, test } from "bun:test";
import { VaultPathError } from "../../../../src/adapters/vaultAdapter";
import { makeVaultHandlers } from "../../../../src/daemon/handlers/vault";
import { RpcError } from "../../../../src/daemon/rpc";
import { rpcRequest } from "../../../rpcRequest";

const fakeVault = {
  exists: async () => true,
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
    const result = await handlers.list(rpcRequest({ folder: "inbox" }));
    expect(result.paths).toEqual(["alpha.md", "alphabet.md", "beta.md", "nested/"]);
  });

  test("filter narrows by filename prefix inside a non-root folder", async () => {
    const handlers = makeVaultHandlers({ vault: fakeVault });
    const result = await handlers.list(rpcRequest({ folder: "inbox", filter: "alpha" }));
    expect(result.paths).toEqual(["alpha.md", "alphabet.md"]);
  });

  test("excludes .notient and Notient at the root", async () => {
    const handlers = makeVaultHandlers({ vault: fakeVault });
    const result = await handlers.list(rpcRequest({ folder: "" }));
    expect(result.paths).toEqual(["inbox/", "root.md"]);
  });

  test("refuses direct traversal into Notient-owned artifact folders before listing", async () => {
    let lists = 0;
    const handlers = makeVaultHandlers({
      vault: {
        exists: async () => true,
        list: async () => {
          lists++;
          return { files: ["Notient/conversations/private.md"], folders: [] };
        },
      },
    });

    for (const folder of ["Notient/conversations", "notient/PROPOSALS"]) {
      try {
        await handlers.list(rpcRequest({ folder }));
        throw new Error("expected internal folder refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(RpcError);
        expect((error as RpcError).code).toBe("INVALID_PARAMS");
      }
    }
    expect(lists).toBe(0);
  });

  test("drops Notient-owned artifact candidates from a parent listing", async () => {
    const handlers = makeVaultHandlers({
      vault: {
        exists: async () => true,
        list: async () => ({
          folders: ["Notient/conversations", "Notient/inbox"],
          files: ["Notient/proposals/private.md", "Notient/public.md"],
        }),
      },
    });

    expect((await handlers.list(rpcRequest({ folder: "Notient" }))).paths).toEqual([
      "inbox/",
      "public.md",
    ]);
  });

  test("defaults an omitted limit to 200", async () => {
    const big = Array.from({ length: 500 }, (_, index) => `n${index}.md`);
    const handlers = makeVaultHandlers({
      vault: {
        exists: async () => true,
        list: async () => ({ files: big, folders: [] }),
      },
    });
    const result = await handlers.list(rpcRequest());
    expect(result.paths.length).toBe(200);
  });

  test("honors a positive integer limit at or below 200", async () => {
    const handlers = makeVaultHandlers({ vault: fakeVault });
    const result = await handlers.list(rpcRequest({ folder: "inbox", limit: 2 }));
    expect(result.paths).toEqual(["alpha.md", "alphabet.md"]);
  });

  test("rejects a limit above 200", async () => {
    const handlers = makeVaultHandlers({ vault: fakeVault });
    let caught: unknown;
    try {
      await handlers.list(rpcRequest({ limit: 201 }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RpcError);
    expect((caught as RpcError).code).toBe("INVALID_PARAMS");
    expect((caught as Error).message).toContain("must not exceed 200");
  });

  test("requires limit to be a positive safe integer", async () => {
    const handlers = makeVaultHandlers({ vault: fakeVault });
    for (const limit of [
      null,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "2",
    ]) {
      let caught: unknown;
      try {
        await handlers.list(rpcRequest({ limit }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RpcError);
      expect((caught as RpcError).code).toBe("INVALID_PARAMS");
      expect((caught as Error).message).toContain("positive safe integer");
    }
  });

  test("maps a typed vault path refusal to INVALID_PARAMS", async () => {
    const handlers = makeVaultHandlers({
      vault: {
        exists: async () => true,
        list: async () => {
          throw new VaultPathError("escape");
        },
      },
    });
    try {
      await handlers.list(rpcRequest({ folder: "escape" }));
      throw new Error("expected list refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe("INVALID_PARAMS");
      expect((error as Error).message).toBe("path escapes vault");
    }
  });

  test("returns only accessible canonical direct Markdown children", async () => {
    const checked: string[] = [];
    const handlers = makeVaultHandlers({
      vault: {
        list: async () => ({
          folders: [
            "inbox/nested",
            "outside",
            "inbox/deep/child",
            "inbox/.hidden",
            "inbox/link-out",
            "inbox/missing",
            "inbox/nested",
          ],
          files: [
            "inbox/good.md",
            "inbox/good.txt",
            "outside.md",
            "inbox/deep/nested.md",
            "inbox/.hidden.md",
            "inbox/link.md",
            "inbox/missing.md",
            "../outside.md",
            "inbox/good.md",
          ],
        }),
        exists: async (path) => {
          checked.push(path);
          if (path.includes("link")) throw new VaultPathError("escape");
          return !path.includes("missing");
        },
      },
    });

    const result = await handlers.list(rpcRequest({ folder: "inbox" }));

    expect(result.paths).toEqual(["good.md", "nested/"]);
    expect(checked.sort()).toEqual([
      "inbox/good.md",
      "inbox/link-out",
      "inbox/link.md",
      "inbox/missing",
      "inbox/missing.md",
      "inbox/nested",
    ]);
  });

  test("propagates unexpected entry accessibility failures", async () => {
    const handlers = makeVaultHandlers({
      vault: {
        list: async () => ({ folders: [], files: ["note.md"] }),
        exists: async () => {
          throw new Error("storage unavailable");
        },
      },
    });

    await expect(handlers.list(rpcRequest())).rejects.toThrow("storage unavailable");
  });
});
