import { describe, expect, test } from "bun:test";
import { Database } from "../../db/database";
import { MemoryAdapter, loadWasm } from "../../db/database.test";
import { makeGetProposalTool, makeListProposalsTool } from "./proposals";

async function newDb(): Promise<Database> {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await db.init();
  return db;
}

function insertEdge(
  db: Database,
  fields: {
    id: string;
    type: string;
    source: string;
    target: string;
    agent: string;
    evidence?: string;
    decision?: string;
    rationale?: string | null;
    createdAt?: number;
  },
): void {
  if (fields.decision) {
    db.run(
      `INSERT INTO staging_edges (id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at, decided_at, decision)
       VALUES (?,?,?,?,?,?,?,?,?,?,?);`,
      [
        fields.id,
        fields.type,
        fields.source,
        fields.target,
        0.85,
        fields.agent,
        fields.evidence ?? JSON.stringify(["chunk-x"]),
        fields.rationale ?? null,
        fields.createdAt ?? 1,
        2,
        fields.decision,
      ],
    );
    return;
  }
  db.run(
    `INSERT INTO staging_edges (id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at)
     VALUES (?,?,?,?,?,?,?,?,?);`,
    [
      fields.id,
      fields.type,
      fields.source,
      fields.target,
      0.85,
      fields.agent,
      fields.evidence ?? JSON.stringify(["chunk-x"]),
      fields.rationale ?? null,
      fields.createdAt ?? 1,
    ],
  );
}

function insertNode(
  db: Database,
  fields: {
    id: string;
    type: string;
    label: string;
    agent: string;
    payload?: string | null;
    notePath?: string | null;
    createdAt?: number;
  },
): void {
  db.run(
    `INSERT INTO staging_nodes (id, type, label, note_path, payload, agent, confidence, created_at)
     VALUES (?,?,?,?,?,?,?,?);`,
    [
      fields.id,
      fields.type,
      fields.label,
      fields.notePath ?? null,
      fields.payload ?? null,
      fields.agent,
      0.7,
      fields.createdAt ?? 1,
    ],
  );
}

describe("proposals.list_pending", () => {
  test("returns pending edges and nodes ordered by createdAt desc", async () => {
    const db = await newDb();
    insertEdge(db, {
      id: "e1",
      type: "supports",
      source: "note:/a.md",
      target: "note:/b.md",
      agent: "linker",
      createdAt: 10,
    });
    insertEdge(db, {
      id: "e2",
      type: "supports",
      source: "note:/x.md",
      target: "note:/y.md",
      agent: "linker",
      createdAt: 5,
      decision: "accepted",
    });
    insertNode(db, {
      id: "n1",
      type: "synthesis",
      label: "POSIX",
      agent: "synthesizer",
      payload: JSON.stringify({
        body: "## Themes",
        memberPaths: ["/a.md", "/c.md"],
        targetPath: "0-inbox/synth.md",
      }),
      createdAt: 20,
    });
    const tool = makeListProposalsTool(db);
    const result = await tool.invoke({}, new AbortController().signal);
    expect(result.proposals.map((p) => p.id)).toEqual(["n1", "e1"]);
    const node = result.proposals[0];
    expect(node.kind).toBe("node");
    if (node.kind === "node") {
      expect(node.memberPaths).toEqual(["/a.md", "/c.md"]);
      expect(node.body).toBe("## Themes");
      expect(node.targetPath).toBe("0-inbox/synth.md");
    }
    const edge = result.proposals[1];
    expect(edge.kind).toBe("edge");
    if (edge.kind === "edge") {
      expect(edge.sourceNotePath).toBe("/a.md");
      expect(edge.targetNotePath).toBe("/b.md");
      expect(edge.evidence).toEqual(["chunk-x"]);
    }
  });

  test("filters by notePath across edges and node memberPaths", async () => {
    const db = await newDb();
    insertEdge(db, {
      id: "e1",
      type: "supports",
      source: "note:/a.md",
      target: "note:/b.md",
      agent: "linker",
      createdAt: 1,
    });
    insertEdge(db, {
      id: "e2",
      type: "supports",
      source: "note:/c.md",
      target: "note:/d.md",
      agent: "linker",
      createdAt: 2,
    });
    insertNode(db, {
      id: "n1",
      type: "synthesis",
      label: "Match",
      agent: "synthesizer",
      payload: JSON.stringify({ body: "x", memberPaths: ["/a.md"], targetPath: "p" }),
      createdAt: 3,
    });
    insertNode(db, {
      id: "n2",
      type: "synthesis",
      label: "Other",
      agent: "synthesizer",
      payload: JSON.stringify({ body: "y", memberPaths: ["/z.md"], targetPath: "q" }),
      createdAt: 4,
    });
    const tool = makeListProposalsTool(db);
    const result = await tool.invoke({ notePath: "/a.md" }, new AbortController().signal);
    expect(result.proposals.map((p) => p.id).sort()).toEqual(["e1", "n1"]);
  });

  test("filters by agent name", async () => {
    const db = await newDb();
    insertEdge(db, {
      id: "e1",
      type: "supports",
      source: "note:/a.md",
      target: "note:/b.md",
      agent: "linker",
    });
    insertEdge(db, {
      id: "e2",
      type: "contradicts",
      source: "note:/c.md",
      target: "note:/d.md",
      agent: "contradictionHunter",
    });
    const tool = makeListProposalsTool(db);
    const result = await tool.invoke(
      { agent: "contradictionHunter" },
      new AbortController().signal,
    );
    expect(result.proposals.map((p) => p.id)).toEqual(["e2"]);
  });

  test("resolves note_path for non-note source ids via graph_nodes", async () => {
    const db = await newDb();
    db.run(
      "INSERT INTO graph_nodes (id, type, label, note_path, payload, created_at) VALUES (?,?,?,?,?,?);",
      ["claim:abc", "claim", "claim a", "/a.md", null, 1],
    );
    insertEdge(db, {
      id: "e1",
      type: "contradicts",
      source: "claim:abc",
      target: "note:/b.md",
      agent: "contradictionHunter",
    });
    const tool = makeListProposalsTool(db);
    const result = await tool.invoke({}, new AbortController().signal);
    expect(result.proposals).toHaveLength(1);
    if (result.proposals[0].kind === "edge") {
      expect(result.proposals[0].sourceNotePath).toBe("/a.md");
      expect(result.proposals[0].targetNotePath).toBe("/b.md");
    }
  });

  test("tolerates malformed evidence and payload JSON", async () => {
    const db = await newDb();
    insertEdge(db, {
      id: "e1",
      type: "supports",
      source: "note:/a.md",
      target: "note:/b.md",
      agent: "linker",
      evidence: "{not json",
    });
    insertNode(db, {
      id: "n1",
      type: "synthesis",
      label: "broken",
      agent: "synthesizer",
      payload: "[not valid",
    });
    const tool = makeListProposalsTool(db);
    const result = await tool.invoke({}, new AbortController().signal);
    expect(result.proposals).toHaveLength(2);
    for (const proposal of result.proposals) {
      if (proposal.kind === "edge") {
        expect(proposal.evidence).toEqual([]);
      } else {
        expect(proposal.memberPaths).toEqual([]);
        expect(proposal.body).toBeNull();
      }
    }
  });

  test("excludes already-decided rows", async () => {
    const db = await newDb();
    insertEdge(db, {
      id: "e1",
      type: "supports",
      source: "note:/a.md",
      target: "note:/b.md",
      agent: "linker",
      decision: "rejected",
    });
    const tool = makeListProposalsTool(db);
    const result = await tool.invoke({}, new AbortController().signal);
    expect(result.proposals).toEqual([]);
  });

  test("validates argument shape", async () => {
    const db = await newDb();
    const tool = makeListProposalsTool(db);
    expect(() => tool.validate("nope")).toThrow();
    expect(() => tool.validate({ limit: 0 })).toThrow();
    expect(tool.validate(undefined)).toEqual({});
  });
});

describe("proposals.get", () => {
  test("returns a pending edge by id", async () => {
    const db = await newDb();
    insertEdge(db, {
      id: "e1",
      type: "supports",
      source: "note:/a.md",
      target: "note:/b.md",
      agent: "linker",
    });
    const tool = makeGetProposalTool(db);
    const result = await tool.invoke({ id: "e1" }, new AbortController().signal);
    expect(result.proposal?.kind).toBe("edge");
    expect(result.proposal?.id).toBe("e1");
  });

  test("returns a pending node by id", async () => {
    const db = await newDb();
    insertNode(db, {
      id: "n1",
      type: "synthesis",
      label: "x",
      agent: "synthesizer",
      payload: JSON.stringify({ body: "b", memberPaths: ["/a.md"], targetPath: "p" }),
    });
    const tool = makeGetProposalTool(db);
    const result = await tool.invoke({ id: "n1" }, new AbortController().signal);
    expect(result.proposal?.kind).toBe("node");
    expect(result.proposal?.id).toBe("n1");
  });

  test("returns null when missing or decided", async () => {
    const db = await newDb();
    insertEdge(db, {
      id: "e1",
      type: "supports",
      source: "note:/a.md",
      target: "note:/b.md",
      agent: "linker",
      decision: "accepted",
    });
    const tool = makeGetProposalTool(db);
    const missing = await tool.invoke({ id: "nope" }, new AbortController().signal);
    const decided = await tool.invoke({ id: "e1" }, new AbortController().signal);
    expect(missing.proposal).toBeNull();
    expect(decided.proposal).toBeNull();
  });

  test("rejects empty id", async () => {
    const db = await newDb();
    const tool = makeGetProposalTool(db);
    expect(() => tool.validate({ id: "" })).toThrow();
    expect(() => tool.validate({})).toThrow();
  });
});
