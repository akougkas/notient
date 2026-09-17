import { expect, test } from "bun:test";
import type { VaultAdapter } from "../../../../src/adapters/vaultAdapter";
import { defaultPipelinePolicy } from "../../../../src/api/background";
import { contentRevision } from "../../../../src/api/notes";
import type { PipelinePlan } from "../../../../src/api/pipelines";
import type { LLMProvider } from "../../../../src/core/llm/provider";
import { reviewArchive } from "../../../../src/core/pipelines/archive";
import { PipelineContext } from "../../../../src/core/pipelines/context";
import type { SearchPipeline } from "../../../../src/core/search/searchPipeline";

test("archive protection covers case variants and descendants before retrieval or inference", async () => {
  for (const tags of [
    "#KEEP",
    "#Keep/Personal",
    "---\ntags: [KEEP]\n---",
    "---\ntags: [keep/Personal]\n---",
    "#keeper",
  ]) {
    const body = `${tags}\n\nAll work completed.\n`;
    let calls = 0;
    let retrievals = 0;
    const policy = defaultPipelinePolicy("archive");
    policy.parameters.archive.minimumAgeDays = 0;
    policy.parameters.archive.protectedTags = ["#keep"];
    const context = new PipelineContext({
      vault: {
        read: async () => body,
        listMarkdown: async () => [{ path: "Finished.md", mtime: 0 }],
      } as unknown as VaultAdapter,
      search: {
        retrieve: async () => {
          retrievals++;
          return { hits: [], coverage: { state: "current", message: null } };
        },
      } as unknown as SearchPipeline,
      provider: {
        chatJson: async () => {
          calls++;
          return { reviews: [], abstention: "Retain this reference." };
        },
      } as unknown as LLMProvider,
      model: "fixture",
      policy,
      sources: [{ path: "Finished.md", revision: contentRevision(body) }],
      signal: new AbortController().signal,
      stage: async () => {},
    });
    const plan: PipelinePlan = {
      pipeline: "archive",
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
    await reviewArchive(context, plan);
    expect(calls).toBe(tags === "#keeper" ? 1 : 0);
    expect(retrievals).toBe(tags === "#keeper" ? 1 : 0);
    expect(plan.changes).toEqual([]);
  }
});
