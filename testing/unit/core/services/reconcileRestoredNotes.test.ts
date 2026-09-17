import { describe, expect, test } from "bun:test";
import { DateTime, type Surreal } from "surrealdb";
import type { VaultAdapter } from "../../../../src/adapters/vaultAdapter";
import {
  RestoreSnapshotMismatchError,
  reconcileRestoredNotes,
} from "../../../../src/core/services/reconcileRestoredNotes";
import { sha256Hex } from "../../../../src/core/utils/sha256";

type RestoreVault = Pick<VaultAdapter, "listMarkdown" | "read">;

function fakeDb(rows: unknown[]): Surreal {
  return {
    query: (sql: string) => {
      expect(sql).toContain("tier1_at, tier2_at, tier3_at");
      return { collect: async () => [rows] };
    },
  } as unknown as Surreal;
}

function identity(path: string, sha: string): Record<string, unknown> {
  return {
    path,
    sha,
    tier1_at: new DateTime("2026-08-30T01:00:00Z"),
    tier2_at: new DateTime("2026-08-30T01:00:01Z"),
    tier3_at: new DateTime("2026-08-30T01:00:02Z"),
    linker_refresh_pending: false,
  };
}

function fakeVault(files: Readonly<Record<string, string>>): RestoreVault {
  return {
    listMarkdown: async () => Object.keys(files).map((path, index) => ({ path, mtime: index + 1 })),
    read: async (path) => {
      const value = files[path];
      if (value === undefined) throw new Error(`missing fixture ${path}`);
      return value;
    },
  };
}

describe("reconcileRestoredNotes", () => {
  test("accepts only exact path and SHA equality", async () => {
    const alpha = "# Alpha\n";
    const beta = "# Beta\n";
    const db = fakeDb([
      identity("alpha.md", await sha256Hex(alpha)),
      identity("folder/beta.md", await sha256Hex(beta)),
    ]);

    await expect(
      reconcileRestoredNotes(db, fakeVault({ "folder/beta.md": beta, "alpha.md": alpha })),
    ).resolves.toEqual({ notes: 2 });
  });

  test("refuses backup-only and vault-only paths", async () => {
    const body = "# Note\n";
    const db = fakeDb([identity("deleted.md", await sha256Hex(body))]);

    await expect(reconcileRestoredNotes(db, fakeVault({ "new.md": body }))).rejects.toEqual(
      new RestoreSnapshotMismatchError("backup-only 'deleted.md'; vault-only 'new.md'"),
    );
  });

  test("refuses edited Markdown without exposing its content", async () => {
    const db = fakeDb([identity("private.md", await sha256Hex("before-secret"))]);

    let error: unknown;
    try {
      await reconcileRestoredNotes(db, fakeVault({ "private.md": "after-secret" }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RestoreSnapshotMismatchError);
    expect(String(error)).toContain("private.md");
    expect(String(error)).not.toContain("before-secret");
    expect(String(error)).not.toContain("after-secret");
  });

  test("refuses malformed restored note identities", async () => {
    const db = fakeDb([identity("bad.md", "not-a-sha")]);

    await expect(reconcileRestoredNotes(db, fakeVault({ "bad.md": "body" }))).rejects.toThrow(
      "not a complete, non-tombstoned",
    );
  });

  test("refuses an exact SHA whose indexing generation is incomplete", async () => {
    const body = "# Mid-index\n";
    const row = identity("mid-index.md", await sha256Hex(body));
    row.tier2_at = undefined;

    await expect(
      reconcileRestoredNotes(fakeDb([row]), fakeVault({ "mid-index.md": body })),
    ).rejects.toThrow("not a complete, non-tombstoned Tier 1/2/3 generation");
  });
});
