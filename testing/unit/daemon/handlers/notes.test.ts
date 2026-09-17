import { describe, expect, test } from "bun:test";
import { VaultPathError } from "../../../../src/adapters/vaultAdapter";
import { makeNotesHandlers } from "../../../../src/daemon/handlers/notes";
import { RpcError } from "../../../../src/daemon/rpc";
import { rpcRequest } from "../../../rpcRequest";
function makeHandlers() {
  return makeNotesHandlers({ vault: { read: async (path: string) => `# ${path}\n\nbody` } });
}
describe("notes.read", () => {
  test("read returns the file body from vault.read", async () => {
    const handlers = makeHandlers();
    const result = await handlers.read(rpcRequest({ path: "notes/x.md" }));
    expect(result.ok).toBe(true);
    expect(result.body).toBe("# notes/x.md\n\nbody");
  });

  test("read rejects without a path", async () => {
    const handlers = makeHandlers();
    await expect(handlers.read(rpcRequest())).rejects.toThrow(
      "exact ordinary public vault-relative Markdown note path",
    );
  });

  test("read refuses Notient-owned artifacts before touching the vault", async () => {
    let reads = 0;
    const handlers = makeNotesHandlers({
      vault: {
        read: async () => {
          reads++;
          return "private transcript";
        },
      },
    });

    for (const path of ["Notient/conversations/private.md", "notient/PROPOSALS/private.md"]) {
      await expect(handlers.read(rpcRequest({ path }))).rejects.toThrow("ordinary public");
    }
    expect(reads).toBe(0);
  });

  test("read maps a typed vault path refusal to INVALID_PARAMS", async () => {
    const handlers = makeNotesHandlers({
      vault: {
        read: async () => {
          throw new VaultPathError("hidden");
        },
      },
    });

    try {
      await handlers.read(rpcRequest({ path: "escape/secret.md" }));
      throw new Error("expected read refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe("INVALID_PARAMS");
      expect((error as Error).message).toBe("hidden path");
    }
  });
});
