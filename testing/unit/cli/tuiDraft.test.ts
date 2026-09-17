import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangePreview } from "../../../src/api/changes";
import { draftChangeSet, newDraft } from "../../../src/api/drafts";
import { contentRevision } from "../../../src/api/notes";
import { DraftStore, previewDiff } from "../../../src/cli/tui/draft";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { secureDaemonStateTree } from "../../../src/daemon/ipcSecurity";

test("writing preserves Markdown, frontmatter, BOM and CRLF behind the source revision", () => {
  const original = "\ufeff---\r\naliases: [Thought]\r\n---\r\n# Original\r\n";
  const draft = newDraft("Inbox", "---\naliases: [Thought]\n---\n# Revised\n");
  draft.path = "Research/Thought.md";
  draft.base = { path: draft.path, revision: contentRevision(original), body: original };
  expect(draftChangeSet(draft).changes).toEqual([
    {
      kind: "edit",
      source: { path: draft.path, revision: contentRevision(original) },
      selector: { kind: "range", start: 0, end: original.length },
      replacement: "\ufeff---\r\naliases: [Thought]\r\n---\r\n# Revised\r\n",
    },
  ]);
  draft.path = "Elsewhere.md";
  expect(() => draftChangeSet(draft)).toThrow("moving a note requires reference-aware move");
});

test("new capture has an absent-file precondition and requires content", () => {
  const draft = newDraft("0-inbox", "My own thought");
  expect(draftChangeSet(draft)).toEqual({
    idempotencyKey: draft.id,
    changes: [{ kind: "create", path: draft.path, body: "My own thought", expected: null }],
  });
  draft.body = "  ";
  expect(() => draftChangeSet(draft)).toThrow("Write a thought");
});

test("draft recovery is private, scoped to the client, and cannot resurrect a cleared draft", async () => {
  const vault = await mkdtemp(join(tmpdir(), "notient-draft-"));
  try {
    await secureDaemonStateTree(vaultStateDir(vault));
    const store = new DraftStore(vault, "human");
    expect(await store.load()).toBeNull();
    const draft = newDraft("Inbox", "Recover me");
    await store.save(draft);
    expect(await new DraftStore(vault, "human").load()).toEqual(draft);
    expect(await new DraftStore(vault, "codex").load()).toBeNull();
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    await Promise.all([
      store.save({ ...draft, body: "first" }),
      store.save({ ...draft, body: "second" }),
      store.save(null),
    ]);
    expect(await store.load()).toBeNull();
    await expect(store.save({ ...draft, body: "long".repeat(300000) })).rejects.toThrow(
      "too large",
    );
  } finally {
    await rm(vault, { recursive: true, force: true });
    await rm(vaultStateDir(vault), { recursive: true, force: true });
  }
});

test("a creation preview shows only inserted lines; replacement keeps useful context", () => {
  const render = (before: string | null, after: string) =>
    previewDiff({ effects: [{ path: "Inbox/Thought.md", before, after }] } as ChangePreview);
  expect(render(null, "# Thought\n\nKeep this.\n")).toBe(
    "--- /dev/null\n+++ b/Inbox/Thought.md\n@@ -0,0 +1,3 @@\n+# Thought\n+\n+Keep this.\n",
  );
  expect(render("# Thought\n\nOld\n", "# Thought\n\nNew\n")).toContain(
    "@@ -1,3 +1,3 @@\n # Thought\n \n-Old\n+New\n",
  );
  expect(render("Thought\n", "Thought")).toContain(
    "-Thought\n+Thought\n\\ No newline at end of file",
  );
});
