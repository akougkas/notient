import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { VaultAdapter } from "../../../../src/adapters/vaultAdapter";
import { defaultPipelinePolicy } from "../../../../src/api/background";
import { contentRevision, sourceRange } from "../../../../src/api/notes";
import type { PipelinePlan } from "../../../../src/api/pipelines";
import type { RetrievalResult } from "../../../../src/api/retrieval";
import { estimateInputTokens } from "../../../../src/core/llm/executionBudget";
import type { ChatMessage, LLMProvider } from "../../../../src/core/llm/provider";
import { PipelineContext } from "../../../../src/core/pipelines/context";
import { referenceOnly, relateNotes } from "../../../../src/core/pipelines/relate";
import type { SearchPipeline } from "../../../../src/core/search/searchPipeline";

const schema = z.object({ answer: z.string() }).strict();
function fixture(files: Record<string, string>, selected = ["Selected.md"], contextTokens = 32768) {
  const requests: ChatMessage[][] = [];
  const hits: RetrievalResult["hits"] = Object.entries(files).map(([path, body]) => {
    const start = body.indexOf("RELEVANT");
    const quote = start < 0 ? body.slice(0, 50) : body.slice(start, start + 55);
    const offset = Math.max(0, start);
    const note = { path, revision: contentRevision(body) };
    return {
      note,
      score: 1,
      scoreKind: "bm25",
      freshness: { indexedRevision: note.revision, state: "current", reason: null },
      evidence: { ...note, quote, range: sourceRange(body, offset, offset + quote.length) },
    };
  });
  const context = new PipelineContext({
    vault: { read: async (path: string) => files[path] } as VaultAdapter,
    search: {
      retrieve: async () => ({ hits, coverage: { state: "current", message: null } }),
    } as unknown as SearchPipeline,
    provider: {
      chatJson: async (messages: ChatMessage[]) => {
        requests.push(structuredClone(messages));
        return { answer: "ok" };
      },
    } as unknown as LLMProvider,
    model: "test",
    modelContextTokens: contextTokens,
    // These cases measure context fitting against a fixed 8,192-token ceiling.
    policy: {
      ...defaultPipelinePolicy("relate"),
      budget: { ...defaultPipelinePolicy("relate").budget, generationTokens: 8192 },
    },
    sources: selected.map((path) => ({ path, revision: contentRevision(files[path]) })),
    signal: new AbortController().signal,
    stage: async () => {},
  });
  return { context, requests };
}

describe("bounded pipeline evidence", () => {
  test("repeated code lines must cite enough context to identify the intended occurrence", async () => {
    const body =
      "# Writer\n\nInitial signal:\nself._event.set()\n\nAfter appending:\ndset.flush()\nself._event.set()\n";
    const { context } = fixture({ "Selected.md": body });
    await context.load();
    await context.model("inspect", "Read", schema);
    expect(() => context.evidence({ note: 0, quote: "self._event.set()" })).toThrow("ambiguous");
    const quote = "dset.flush()\nself._event.set()";
    const evidence = context.evidence({ note: 0, quote });
    expect(evidence.range.start).toBe(body.indexOf(quote));
    expect(evidence.range.startLine).toBe(7);
    expect(body.slice(evidence.range.start, evidence.range.end)).toBe(quote);
  });

  test("comparison repairs internal citation markers through the bounded structured-output path", async () => {
    const old = "The old policy keeps one replica.";
    const current = "The new policy replaces it with three replicas.";
    const { context } = fixture({ "Selected.md": current, "History.md": old });
    let calls = 0;
    context.options.provider.chatJson = async <T>() =>
      ({
        comparisons: [
          {
            source: 0,
            target: 1,
            judgment: "temporal-change",
            assessment: 1,
            explanation:
              ++calls === 1
                ? "The new policy [0] replaces the old policy [1]."
                : "Selected replaces the one-replica policy in History with three replicas.",
            evidence: [
              { note: 0, quote: current },
              { note: 1, quote: old },
            ],
          },
        ],
        abstention: null,
      }) as T;
    const plan: PipelinePlan = {
      pipeline: "contradictions",
      summary: "",
      abstained: false,
      reason: null,
      findings: [],
      changes: [],
      relationships: [],
      sources: [],
      extractions: [],
    };
    await context.load();
    await relateNotes(context, plan, true);
    expect(calls).toBe(2);
    expect(plan.findings[0].explanation).toBe(
      "Selected replaces the one-replica policy in History with three replicas.",
    );
    expect(plan.findings[0].evidence.map((entry) => entry.path)).toEqual([
      "Selected.md",
      "History.md",
    ]);
    expect(plan.relationships).toEqual([]);
  });
  test("zero-support temporal speculation is retained as abstention rather than a knowledge finding", async () => {
    const { context } = fixture({
      "Selected.md": "For the September cluster, acknowledged writes survive replica loss.",
      "History.md": "As of August, the storage service had one replica.",
    });
    context.options.provider.chatJson = async <T>() =>
      ({
        comparisons: [
          {
            source: 0,
            target: 1,
            judgment: "temporal-change",
            assessment: 0,
            explanation: "Different dates alone do not establish whether the guarantee changed.",
            evidence: [
              { note: 0, quote: "acknowledged writes survive replica loss." },
              { note: 1, quote: "the storage service had one replica." },
            ],
          },
        ],
        abstention: null,
      }) as T;
    const plan: PipelinePlan = {
      pipeline: "contradictions",
      summary: "",
      abstained: false,
      reason: null,
      findings: [],
      changes: [],
      relationships: [],
      sources: [],
      extractions: [],
    };
    await context.load();
    await relateNotes(context, plan, true);
    expect(plan.findings).toEqual([]);
    expect(plan.relationships).toEqual([]);
    expect(plan.reason).toContain("Different dates alone");
  });
  test("the real-model bibliography-only suggestion is downgraded to an abstention", async () => {
    const claim = "Starting with version 2.5.0, h5py includes support for the HDF5 SWMR features.";
    const reference = "- **SWMR**: https://docs.h5py.org/en/stable/swmr.html";
    const { context } = fixture({ "Selected.md": claim, "References.md": reference });
    context.options.provider.chatJson = async <T>() =>
      ({
        comparisons: [
          {
            source: 0,
            target: 1,
            judgment: "supports",
            assessment: 0.78,
            explanation: "The page appears in the reference list.",
            evidence: [
              { note: 0, quote: claim },
              { note: 1, quote: reference },
            ],
          },
        ],
        abstention: null,
      }) as T;
    const plan: PipelinePlan = {
      pipeline: "relate",
      summary: "",
      abstained: false,
      reason: null,
      findings: [],
      changes: [],
      relationships: [],
      sources: [],
      extractions: [],
    };
    await context.load();
    await relateNotes(context, plan);
    expect(plan.relationships).toEqual([]);
    expect(plan.findings).toEqual([]);
    expect(plan.reason).toContain("bibliographic pointer");
  });
  test("bibliographic pointers are not substantive corroboration", () => {
    expect(referenceOnly("- **SWMR**: https://docs.h5py.org/en/stable/swmr.html")).toBe(true);
    expect(referenceOnly("[[Storage#Recovery]]")).toBe(true);
    expect(referenceOnly("Readers refresh after the writer flushes committed data.")).toBe(false);
    expect(referenceOnly("Use a durable journal. See [[Storage#Recovery]].")).toBe(false);
  });

  test("mirrored Markdown with different frontmatter is not independent corroborating evidence", async () => {
    const { context } = fixture({
      "Selected.md": "---\nsource: original\n---\n# SWMR\nReaders refresh.",
      "Mirror.md": "---\nsource: copy\n---\n# SWMR\nReaders refresh.",
      "Other.md": "# Experiment\nReaders can observe intermediate states.",
    });
    await context.load();
    await context.retrieve();
    expect(context.documents.map((note) => note.note.path)).toEqual(["Selected.md", "Other.md"]);
  });
  test("retrieves a small ranked set and quotes a match deep inside a long Obsidian note at its original offset", async () => {
    const quote = "RELEVANT café 😀: readers observe flushed committed data.";
    const files: Record<string, string> = {
      "Selected.md": "# SWMR\nReaders observe committed data.",
    };
    for (let n = 0; n < 20; n++)
      files[`Import ${n}.md`] =
        `${"Unrelated boilerplate.\n".repeat(1500)}${quote}\n${"Tail.\n".repeat(2000)}\nUnique note ${n}`;
    const { context, requests } = fixture(files);
    await context.load();
    await context.retrieve();
    expect(context.documents).toHaveLength(7);
    await context.model("comparison", "Compare concrete claims.", schema);
    const sent = JSON.parse(String(requests[0][1].content)).documents;
    expect(sent[1].content).toContain(quote);
    expect(sent[1].truncated).toBe(true);
    expect(sent[1].range.start).toBeGreaterThan(16000);
    const evidence = context.evidence({ note: 1, quote });
    expect(files["Import 0.md"].slice(evidence.range.start, evidence.range.end)).toBe(quote);
    expect(evidence.range.start).toBe(files["Import 0.md"].indexOf(quote));
    expect(() => context.evidence({ note: 1, quote: "Tail.\n".repeat(1000) })).toThrow(
      "exact supplied",
    );
    expect(
      estimateInputTokens(requests[0], { name: "comparison", schema: z.toJSONSchema(schema) }) +
        8192,
    ).toBeLessThanOrEqual(32768);
  });

  test("focused selected notes retain their framing without permitting a quote across omitted text", async () => {
    const framing = "The guarantee applies only to the production system.";
    const relevant = "RELEVANT: append requires an existing resizable dataset.";
    const body = `# Scope\n${framing}\n${"Historical background.\n".repeat(1000)}${relevant}\n`;
    const { context, requests } = fixture({ "Selected.md": body });
    await context.load();
    await context.focus("append resizable");
    await context.model("comparison", "Inspect both framing and the relevant passage.", schema);
    const document = JSON.parse(String(requests[0][1].content)).documents[0];
    expect(document.content).toContain(relevant);
    expect(document.overview.content).toContain(framing);
    expect(context.evidence({ note: 0, quote: framing }).range.start).toBe(body.indexOf(framing));
    expect(context.evidence({ note: 0, quote: relevant }).range.start).toBe(body.indexOf(relevant));
    expect(() => context.evidence({ note: 0, quote: `${framing}\n${relevant}` })).toThrow(
      "exact supplied",
    );
    expect(
      Buffer.byteLength(document.content) + Buffer.byteLength(document.overview.content),
    ).toBeLessThanOrEqual(6000);
    expect(context.isComplete(context.documents[0])).toBe(false);
  });

  test("UTF-8 evidence shrinks to leave the entire reasoning and answer ceiling available", async () => {
    const { context, requests } = fixture(
      { "Selected.md": `# Evidence\n${"日本語😀 reasoning evidence\n".repeat(900)}` },
      undefined,
      12000,
    );
    await context.load();
    await context.model("small", "Use only exact quotations.", schema);
    const sent = JSON.parse(String(requests[0][1].content)).documents[0];
    expect(sent.content).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(context.isComplete(context.selected[0])).toBe(false);
    expect(
      estimateInputTokens(requests[0], { name: "small", schema: z.toJSONSchema(schema) }) + 8192,
    ).toBeLessThanOrEqual(12000);
  });

  test("refuses a context smaller than its generation ceiling without dispatching inference", async () => {
    const { context, requests } = fixture({ "Selected.md": "# Evidence" }, undefined, 4096);
    await context.load();
    await expect(context.model("no_room", "Analyze.", schema)).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
    expect(requests).toHaveLength(0);
    expect(() => context.evidence({ note: 9, quote: "invented" })).toThrow("did not receive");
  });
});
