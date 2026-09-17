import { expect, test } from "bun:test";
import type { VaultAdapter } from "../../../../src/adapters/vaultAdapter";
import { defaultPipelinePolicy } from "../../../../src/api/background";
import { contentRevision } from "../../../../src/api/notes";
import type { PipelinePlan } from "../../../../src/api/pipelines";
import type { LLMProvider } from "../../../../src/core/llm/provider";
import { hasInternalSourceMarkers } from "../../../../src/core/markdown/sourceMarkers";
import { PipelineContext } from "../../../../src/core/pipelines/context";
import { synthesizeNotes } from "../../../../src/core/pipelines/synthesize";
import type { SearchPipeline } from "../../../../src/core/search/searchPipeline";

const files = {
  "Storage.md": "# Storage\nKeep authored Markdown and preserve approval decisions.",
  "Recovery.md": "# Recovery\nReconcile files before serving indexed citations.",
};
const evidence = [
  { note: 0, quote: "Keep authored Markdown and preserve approval decisions." },
  { note: 1, quote: "Reconcile files before serving indexed citations." },
];
const plain =
  "Durable authored notes and retained decisions establish what recovery must preserve. Reconciliation then ensures that indexed citations describe the restored files.";
const response = (text: string) => ({
  title: "Durable recovery",
  sections: [
    {
      heading: "Preserve meaning before rebuilding search",
      paragraphs: [{ text, evidence: structuredClone(evidence) }],
    },
  ],
  abstention: null,
});
async function fixture(
  outputs: unknown[],
  repairs = 1,
  sourceFiles: Record<string, string> = files,
) {
  let calls = 0;
  const stages: string[] = [];
  const policy = defaultPipelinePolicy("synthesize");
  policy.budget.retries = repairs;
  const context = new PipelineContext({
    vault: { read: async (path: string) => sourceFiles[path] } as VaultAdapter,
    search: {} as SearchPipeline,
    provider: {
      isAvailable: async () => true,
      chat: async () => {
        throw new Error("Synthesis must use structured output");
      },
      chatStream: () => {
        throw new Error("Synthesis must use structured output");
      },
      embed: async () => {
        throw new Error("This synthesis already has selected sources");
      },
      chatJson: async <T>() => {
        calls++;
        return outputs.shift() as T;
      },
    } satisfies LLMProvider,
    model: "fixture",
    policy,
    sources: Object.entries(sourceFiles).map(([path, body]) => ({
      path,
      revision: contentRevision(body),
    })),
    signal: new AbortController().signal,
    stage: async (stage) => {
      stages.push(stage);
    },
  });
  await context.load();
  const plan: PipelinePlan = {
    pipeline: "synthesize",
    summary: "",
    abstained: false,
    reason: null,
    findings: [],
    changes: [],
    relationships: [],
    sources: [],
    extractions: [],
  };
  return { context, plan, stages, calls: () => calls };
}

test("synthesis repairs the observed internal citation markers before preparing a clean draft", async () => {
  const run = await fixture([
    response("The notes preserve decisions [0] and reconcile citations [1]."),
    response(plain),
  ]);
  await synthesizeNotes(run.context, run.plan);
  expect(run.calls()).toBe(2);
  expect(run.stages).toContain("synthesize_notes:correct-schema");
  expect(run.plan.changes).toHaveLength(1);
  expect(run.plan.changes[0]).toMatchObject({
    kind: "create",
    path: "Notient/notes/Durable recovery.md",
    expected: null,
  });
  const change = run.plan.changes[0];
  if (change?.kind !== "create") throw new Error("Expected a new draft");
  expect(change.body).toContain(plain);
  expect(change.body).toContain("Sources: [[Storage]]; [[Recovery]]");
  expect(change.body).not.toContain("[0]");
  expect(run.plan.findings[0].evidence.map((source) => source.path)).toEqual([
    "Storage.md",
    "Recovery.md",
  ]);
});

test("synthesis never grants itself an extra correction or stores an unsupported paragraph", async () => {
  const noRepair = await fixture([response("Evidence [0].")], 0);
  await expect(synthesizeNotes(noRepair.context, noRepair.plan)).rejects.toThrow(
    "numeric source markers",
  );
  expect(noRepair.calls()).toBe(1);
  expect(noRepair.plan.changes).toEqual([]);
  const invented = response(plain);
  invented.sections[0].paragraphs[0].evidence[1] = {
    note: 1,
    quote: "An experiment proved recovery always succeeds.",
  };
  const unsupported = await fixture([invented]);
  await expect(synthesizeNotes(unsupported.context, unsupported.plan)).rejects.toThrow(
    "exact supplied source passage",
  );
  expect(unsupported.plan.changes).toEqual([]);
});

test("synthesis preserves abstention and literal source code without mistaking array access for citations", async () => {
  const run = await fixture([
    { title: "", sections: [], abstention: "The notes do not establish a useful connection." },
  ]);
  await synthesizeNotes(run.context, run.plan);
  expect(run.plan.changes).toEqual([]);
  expect(run.plan.reason).toBe("The notes do not establish a useful connection.");
  expect(
    hasInternalSourceMarkers(
      "Inspect `values[0]` and `[1]` in code.\n\n```ts\nconst a = [0];\n```\n[Storage](Storage.md)",
    ),
  ).toBe(false);
  expect(hasInternalSourceMarkers("This follows from the evidence [1].")).toBe(true);
});

test("a long synthesis keeps review evidence for every cited source without repeated quotations", async () => {
  const sourceFiles = {
    ...files,
    "Backups.md": "# Backups\nVerify restores against a disposable copy before trusting them.",
  };
  const repeated = Array.from({ length: 8 }, (_, index) => evidence[index % 2]);
  const draft = {
    title: "Durable recovery",
    sections: [
      {
        heading: "Preserve meaning",
        paragraphs: Array.from({ length: 4 }, () => ({
          text: plain,
          evidence: structuredClone(repeated),
        })),
      },
      {
        heading: "Prove restores",
        paragraphs: [
          {
            text: "Restores deserve the same scrutiny as the notes they recover.",
            evidence: [
              { note: 2, quote: "Verify restores against a disposable copy before trusting them." },
              evidence[0],
            ],
          },
        ],
      },
    ],
    abstention: null,
  };
  const run = await fixture([draft], 1, sourceFiles);
  await synthesizeNotes(run.context, run.plan);
  const cited = run.plan.findings[0].evidence;
  expect(new Set(cited.map((source) => source.path))).toEqual(
    new Set(["Storage.md", "Recovery.md", "Backups.md"]),
  );
  expect(new Set(cited.map((source) => `${source.path}:${source.range.start}`)).size).toBe(
    cited.length,
  );
  expect(run.plan.findings[0].explanation).toContain("3 sources");
});
