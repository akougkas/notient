import { expect, test } from "bun:test";
import type { VaultAdapter } from "../../../../src/adapters/vaultAdapter";
import { defaultPipelinePolicy } from "../../../../src/api/background";
import { contentRevision } from "../../../../src/api/notes";
import type { PipelinePlan } from "../../../../src/api/pipelines";
import type { LLMProvider } from "../../../../src/core/llm/provider";
import { PipelineContext } from "../../../../src/core/pipelines/context";
import { enrichNotes } from "../../../../src/core/pipelines/enrich";
import type { SearchPipeline } from "../../../../src/core/search/searchPipeline";

async function enrich(body: string, suggestion: { tags: string[]; aliases: string[] }) {
  const policy = defaultPipelinePolicy("enrich");
  policy.allowedProperties = ["tags", "tag", "aliases", "alias"];
  policy.allowedSections = [];
  const context = new PipelineContext({
    vault: {
      read: async () => body,
      listMarkdown: async () => [{ path: "Rust.md", mtime: 0 }],
    } as unknown as VaultAdapter,
    search: {
      retrieve: async () => ({ hits: [], coverage: { state: "current", message: null } }),
    } as unknown as SearchPipeline,
    provider: {
      chatJson: async () => ({
        suggestions: [
          {
            note: 0,
            summary: "",
            ...suggestion,
            reason: "The note is about ownership in Rust.",
            evidence: [{ note: 0, quote: "Ownership rules prevent data races." }],
          },
        ],
        abstention: null,
      }),
    } as unknown as LLMProvider,
    model: "fixture",
    policy,
    sources: [{ path: "Rust.md", revision: contentRevision(body) }],
    signal: new AbortController().signal,
    stage: async () => {},
  });
  const plan: PipelinePlan = {
    pipeline: "enrich",
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
  await enrichNotes(context, plan);
  return plan.changes;
}

test("tag suggestions extend authored properties without copying inline tags or case duplicates", async () => {
  const body =
    "---\ntags: [Systems]\n---\n# Rust\n\nOwnership rules prevent data races. #borrowing\n";
  expect(
    await enrich(body, { tags: ["Rust", "rust", "BORROWING", "systems", "café"], aliases: [] }),
  ).toEqual([
    {
      kind: "properties",
      source: { path: "Rust.md", revision: contentRevision(body) },
      patch: { tags: ["Systems", "Rust", "café"] },
    },
  ]);
});

test("a singular authored property is extended in place and known values are not repeated", async () => {
  const body = '---\ntag: "#Lang"\nalias: Rustlang\n---\nOwnership rules prevent data races.\n';
  expect(
    await enrich(body, { tags: ["lang", "Memory"], aliases: ["rustlang", "Rust language"] }),
  ).toEqual([
    {
      kind: "properties",
      source: { path: "Rust.md", revision: contentRevision(body) },
      patch: { tag: ["#Lang", "Memory"], alias: ["Rustlang", "Rust language"] },
    },
  ]);
});

test("suggestions already represented produce no change", async () => {
  const body =
    "---\ntags: [rust]\naliases: [Rust language]\n---\nOwnership rules prevent data races.\n";
  expect(await enrich(body, { tags: ["Rust"], aliases: ["rust LANGUAGE"] })).toEqual([]);
});
