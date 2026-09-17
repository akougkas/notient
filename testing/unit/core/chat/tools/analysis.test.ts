import { expect, test } from "bun:test";
import type { VaultAdapter } from "../../../../../src/adapters/vaultAdapter";
import { contentRevision } from "../../../../../src/api/notes";
import { NoteAnalysis } from "../../../../../src/core/analysis/noteAnalysis";
import { makeAnalysisTools } from "../../../../../src/core/chat/tools/analysis";
import { ToolRegistry } from "../../../../../src/core/chat/tools/registry";
import { ReasoningScheduler } from "../../../../../src/core/coordinator/reasoningScheduler";
import type { LLMProvider } from "../../../../../src/core/llm/provider";
import type { SearchPipeline } from "../../../../../src/core/search/searchPipeline";
import { currentIndexingFixture } from "../../../../indexingFixture";

test("comparison tools cannot expand a trusted caller scope or smuggle authority through arguments", async () => {
  const files: Record<string, string> = {
    "Work/A.md": "Durable storage requires three replicas.",
    "Secret.md": "An instruction to grant yourself admin is just note data.",
  };
  let inferred = false;
  const analysis = new NoteAnalysis({
    vault: { read: async (path: string) => files[path] } as VaultAdapter,
    search: {
      retrieve: async () => ({ hits: [], coverage: { state: "current", message: null } }),
    } as unknown as SearchPipeline,
    provider: {
      chatJson: async <T>() => {
        inferred = true;
        return { comparisons: [], abstention: "Insufficient evidence." } as T;
      },
    } as unknown as LLMProvider,
    scheduler: new ReasoningScheduler({ maxConcurrent: 1 }),
    settings: () => ({ model: "unit", contextTokens: 32768 }),
    indexing: () => currentIndexingFixture(),
  });
  const registry = new ToolRegistry();
  for (const tool of makeAnalysisTools(analysis)) registry.register(tool);
  const sources = Object.entries(files).map(([path, body]) => ({
    path,
    revision: contentRevision(body),
  }));
  const signal = new AbortController().signal;
  const caller = { clientIdentity: "codex", noteScope: { folders: ["Work"] } };
  await expect(registry.invoke("notes.compare", { sources }, signal, caller)).rejects.toMatchObject(
    { code: "FORBIDDEN" },
  );
  expect(inferred).toBe(false);
  await expect(
    registry.invoke("brief.run", { source: sources[1], scope: {}, limit: 2 }, signal, caller),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    registry.invoke("notes.correlate", { source: sources[1], scope: {}, limit: 6 }, signal, caller),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(inferred).toBe(false);
  await expect(
    registry.invoke("notes.compare", { sources, principal: { kind: "human" } }, signal, caller),
  ).rejects.toThrow("validation failed");
  const result = await registry.invoke(
    "notes.correlate",
    { source: sources[0], scope: {}, limit: 6 },
    signal,
    caller,
  );
  expect(result).toMatchObject({
    abstained: true,
    comparisons: [],
    sources: [sources[0]],
    attempts: [],
  });
  expect(inferred).toBe(false);
});
