import { describe, expect, test } from "bun:test";
import { makeNoteAppendSectionInverter } from "../../../../src/core/history/inverters/noteAppendSection";
import { makeNoteCreateInverter } from "../../../../src/core/history/inverters/noteCreate";
import { makeNoteFrontmatterInverter } from "../../../../src/core/history/inverters/noteFrontmatter";
import { makeNoteMaturityInverter } from "../../../../src/core/history/inverters/noteMaturity";

class FakeFacade {
  files = new Map<string, string>();
  removed: string[] = [];
  async writeNote(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.removed.push(path);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}

interface FakeShaUpdate {
  path: string;
  sha: string;
}

function fakeShaUpdater(): {
  calls: FakeShaUpdate[];
  updateNoteSha: (path: string, sha: string) => Promise<void>;
} {
  const calls: FakeShaUpdate[] = [];
  return {
    calls,
    updateNoteSha: async (path, sha) => {
      calls.push({ path, sha });
    },
  };
}

async function fakeHash(input: string): Promise<string> {
  return `sha-${input.length}`;
}

describe("inverters", () => {
  test("noteAppendSection writes prior body and refreshes sha", async () => {
    const facade = new FakeFacade();
    facade.files.set("/note.md", "# After\nappended line\n");
    const sha = fakeShaUpdater();
    const inverter = makeNoteAppendSectionInverter({
      facade,
      hash: fakeHash,
      updateNoteSha: sha.updateNoteSha,
    });
    await inverter("/note.md", "# Before\n", "# After\nappended line\n");
    expect(facade.files.get("/note.md")).toBe("# Before\n");
    expect(sha.calls).toEqual([{ path: "/note.md", sha: "sha-9" }]);
  });

  test("noteFrontmatter restores the prior body verbatim and refreshes sha", async () => {
    const facade = new FakeFacade();
    facade.files.set("/n.md", "---\nfoo: bar\n---\nbody\n");
    const sha = fakeShaUpdater();
    const inverter = makeNoteFrontmatterInverter({
      facade,
      hash: fakeHash,
      updateNoteSha: sha.updateNoteSha,
    });
    const priorBody = "---\n---\nbody\n";
    await inverter("/n.md", priorBody, "---\nfoo: bar\n---\nbody\n");
    expect(facade.files.get("/n.md")).toBe(priorBody);
    expect(sha.calls).toHaveLength(1);
    expect(sha.calls[0].path).toBe("/n.md");
  });

  test("noteCreate deletes the created note", async () => {
    const facade = new FakeFacade();
    facade.files.set("/created.md", "# Created\n");
    const inverter = makeNoteCreateInverter({ facade });
    await inverter("/created.md", null, "# Created\n");
    expect(facade.files.has("/created.md")).toBe(false);
    expect(facade.removed).toEqual(["/created.md"]);
  });

  test("noteCreate is a no-op when the note no longer exists", async () => {
    const facade = new FakeFacade();
    const inverter = makeNoteCreateInverter({ facade });
    await inverter("/missing.md", null, "body");
    expect(facade.removed).toEqual([]);
  });

  test("noteMaturity restores the prior body and refreshes the SurrealDB sha", async () => {
    const facade = new FakeFacade();
    facade.files.set("/n.md", "after-body");
    const sha = fakeShaUpdater();
    const inverter = makeNoteMaturityInverter({
      facade,
      hash: fakeHash,
      updateNoteSha: sha.updateNoteSha,
    });
    await inverter(
      "/n.md",
      { maturity: "adolescent", body: "before-body" },
      { maturity: "mature", body: "after-body" },
    );
    expect(facade.files.get("/n.md")).toBe("before-body");
    expect(sha.calls).toEqual([{ path: "/n.md", sha: "sha-11" }]);
  });

  test("inverters validate payload shape and throw on garbage", async () => {
    const facade = new FakeFacade();
    const sha = fakeShaUpdater();
    const noteAppend = makeNoteAppendSectionInverter({
      facade,
      hash: fakeHash,
      updateNoteSha: sha.updateNoteSha,
    });
    await expect(noteAppend("/n.md", 42, null)).rejects.toThrow();
    const noteMaturity = makeNoteMaturityInverter({
      facade,
      hash: fakeHash,
      updateNoteSha: sha.updateNoteSha,
    });
    await expect(noteMaturity("/n.md", "wrong-shape", null)).rejects.toThrow();
  });
});
