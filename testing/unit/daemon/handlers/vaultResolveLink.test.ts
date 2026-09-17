import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import { makeVaultResolveLinkHandler } from "../../../../src/daemon/handlers/vaultResolveLink";
import { rpcRequest } from "../../../rpcRequest";

function fakeDb(paths: string[]): Surreal {
  return {
    query: () => ({
      collect: async () => [paths.map((path) => ({ path }))],
    }),
  } as unknown as Surreal;
}

describe("vault.resolve_link", () => {
  test("preserves block selectors and refuses ambiguous basename guesses", async () => {
    const handler = makeVaultResolveLinkHandler({ db: fakeDb(["A/Shared.md", "B/Shared.md"]) });
    await expect(handler(rpcRequest({ target: "[[Shared#Results]]" }))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(handler(rpcRequest({ target: "[[A/Shared#^proof|Evidence]]" }))).resolves.toEqual({
      ok: true,
      resolved: true,
      path: "A/Shared.md",
      selector: { kind: "block", id: "proof" },
    });
  });
  test("resolves a wikilink through the indexed vault path universe", async () => {
    const handler = makeVaultResolveLinkHandler({
      db: fakeDb(["notes/Elsewhere.md", "projects/Quincey Note.md"]),
    });

    await expect(
      handler(rpcRequest({ target: "[[Quincey Note#Results|the Quincey work]]" })),
    ).resolves.toEqual({
      ok: true,
      resolved: true,
      path: "projects/Quincey Note.md",
      selector: { kind: "heading", text: "Results" },
    });
  });

  test("returns the canonical vault-relative path for a bare Markdown citation", async () => {
    const handler = makeVaultResolveLinkHandler({
      db: fakeDb(["foo.md", "notes/other.md"]),
    });

    await expect(handler(rpcRequest({ target: " foo.md " }))).resolves.toEqual({
      ok: true,
      resolved: true,
      path: "foo.md",
      selector: null,
    });
  });

  test("returns an explicit unresolved result instead of inventing a path", async () => {
    const handler = makeVaultResolveLinkHandler({ db: fakeDb(["notes/present.md"]) });

    await expect(handler(rpcRequest({ target: "[[Missing Note]]" }))).resolves.toEqual({
      ok: true,
      resolved: false,
      path: null,
    });
  });

  test("internal Notient artifacts never enter the resolver universe", async () => {
    const handler = makeVaultResolveLinkHandler({
      db: fakeDb([
        "Notient/conversations/private.md",
        "NOTIENT/PROPOSALS/forged.md",
        "notes/present.md",
      ]),
    });

    await expect(handler(rpcRequest({ target: "[[private]]" }))).resolves.toEqual({
      ok: true,
      resolved: false,
      path: null,
    });
    await expect(handler(rpcRequest({ target: "NOTIENT/PROPOSALS/forged.md" }))).resolves.toEqual({
      ok: true,
      resolved: false,
      path: null,
    });
  });

  test("requires exactly the canonical target parameter", async () => {
    const handler = makeVaultResolveLinkHandler({ db: fakeDb([]) });
    await expect(handler(rpcRequest())).rejects.toThrow("exactly one string target");
    await expect(handler(rpcRequest({ link: "[[legacy alias]]" }))).rejects.toThrow(
      "exactly one string target",
    );
    await expect(handler(rpcRequest({ target: "[[present]]", legacy: true }))).rejects.toThrow(
      "exactly one string target",
    );
    await expect(handler(rpcRequest({ target: "a\u0000.md" }))).rejects.toThrow("without controls");
  });
});
