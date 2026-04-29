import { describe, expect, test } from "bun:test";
import { makeNoteAppendSectionInverter } from "./inverters/noteAppendSection";
import { makeNoteCreateInverter } from "./inverters/noteCreate";
import { makeNoteFrontmatterInverter } from "./inverters/noteFrontmatter";
import { makeNoteMaturityInverter } from "./inverters/noteMaturity";

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

class FakeEchoGuard {
  marks: Array<{ path: string; sha: string }> = [];
  mark(path: string, sha: string): void {
    this.marks.push({ path, sha });
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
  test("noteAppendSection writes prior body, marks EchoGuard, and refreshes sha", async () => {
    const facade = new FakeFacade();
    facade.files.set("/note.md", "# After\nappended line\n");
    const echoGuard = new FakeEchoGuard();
    const sha = fakeShaUpdater();
    const inverter = makeNoteAppendSectionInverter({
      facade,
      echoGuard,
      hash: fakeHash,
      updateNoteSha: sha.updateNoteSha,
    });
    await inverter("/note.md", "# Before\n", "# After\nappended line\n");
    expect(facade.files.get("/note.md")).toBe("# Before\n");
    expect(echoGuard.marks).toEqual([{ path: "/note.md", sha: "sha-9" }]);
    expect(sha.calls).toEqual([{ path: "/note.md", sha: "sha-9" }]);
  });

  test("noteFrontmatter restores the prior body verbatim and refreshes sha", async () => {
    const facade = new FakeFacade();
    facade.files.set("/n.md", "---\nfoo: bar\n---\nbody\n");
    const echoGuard = new FakeEchoGuard();
    const sha = fakeShaUpdater();
    const inverter = makeNoteFrontmatterInverter({
      facade,
      echoGuard,
      hash: fakeHash,
      updateNoteSha: sha.updateNoteSha,
    });
    const priorBody = "---\n---\nbody\n";
    await inverter("/n.md", priorBody, "---\nfoo: bar\n---\nbody\n");
    expect(facade.files.get("/n.md")).toBe(priorBody);
    expect(echoGuard.marks).toHaveLength(1);
    expect(echoGuard.marks[0].path).toBe("/n.md");
    expect(sha.calls).toHaveLength(1);
    expect(sha.calls[0].path).toBe("/n.md");
  });

  test("noteCreate deletes the created note and marks EchoGuard", async () => {
    const facade = new FakeFacade();
    facade.files.set("/created.md", "# Created\n");
    const echoGuard = new FakeEchoGuard();
    const inverter = makeNoteCreateInverter({
      facade,
      echoGuard,
      hash: fakeHash,
    });
    await inverter("/created.md", null, "# Created\n");
    expect(facade.files.has("/created.md")).toBe(false);
    expect(facade.removed).toEqual(["/created.md"]);
    expect(echoGuard.marks).toHaveLength(1);
    expect(echoGuard.marks[0].path).toBe("/created.md");
  });

  test("noteCreate is a no-op when the note no longer exists", async () => {
    const facade = new FakeFacade();
    const echoGuard = new FakeEchoGuard();
    const inverter = makeNoteCreateInverter({
      facade,
      echoGuard,
      hash: fakeHash,
    });
    await inverter("/missing.md", null, "body");
    expect(facade.removed).toEqual([]);
    expect(echoGuard.marks).toEqual([]);
  });

  test("noteMaturity restores the prior body and refreshes the SurrealDB sha", async () => {
    const facade = new FakeFacade();
    facade.files.set("/n.md", "after-body");
    const echoGuard = new FakeEchoGuard();
    const sha = fakeShaUpdater();
    const inverter = makeNoteMaturityInverter({
      facade,
      echoGuard,
      hash: fakeHash,
      updateNoteSha: sha.updateNoteSha,
    });
    await inverter(
      "/n.md",
      { maturity: "adolescent", body: "before-body" },
      { maturity: "mature", body: "after-body" },
    );
    expect(facade.files.get("/n.md")).toBe("before-body");
    expect(echoGuard.marks).toHaveLength(1);
    expect(echoGuard.marks[0].path).toBe("/n.md");
    expect(sha.calls).toEqual([{ path: "/n.md", sha: "sha-11" }]);
  });

  test("inverters validate payload shape and throw on garbage", async () => {
    const facade = new FakeFacade();
    const echoGuard = new FakeEchoGuard();
    const sha = fakeShaUpdater();
    const noteAppend = makeNoteAppendSectionInverter({
      facade,
      echoGuard,
      hash: fakeHash,
      updateNoteSha: sha.updateNoteSha,
    });
    await expect(noteAppend("/n.md", 42, null)).rejects.toThrow();
    const noteMaturity = makeNoteMaturityInverter({
      facade,
      echoGuard,
      hash: fakeHash,
      updateNoteSha: sha.updateNoteSha,
    });
    await expect(noteMaturity("/n.md", "wrong-shape", null)).rejects.toThrow();
  });
});
