import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import { ReasoningScheduler } from "../../../../src/core/coordinator/reasoningScheduler";
import type {
  ChatMessage,
  ChatOptions,
  JsonSchema,
  LLMProvider,
} from "../../../../src/core/llm/provider";
import type { Reranker } from "../../../../src/core/search/reranker";
import {
  SearchPipeline,
  type SearchPipelineSettings,
} from "../../../../src/core/search/searchPipeline";
import type { SearchEvent, SearchQuery } from "../../../../src/core/search/types";

const VALID_SETTINGS: SearchPipelineSettings = {
  balanced: { topK: 20, rerankTopN: 5 },
  deep: { synthesisEnabled: true },
};
const REASONING_SCHEDULER = new ReasoningScheduler({ maxConcurrent: 1 });

const PROVIDER: LLMProvider = {
  isAvailable: async () => true,
  chat: async () => "",
  chatStream: async function* () {
    yield "";
  },
  chatJson: async <T>(
    _messages: ChatMessage[],
    _options: ChatOptions,
    _schema: JsonSchema,
  ): Promise<T> => ({}) as T,
  embed: async () => [],
};

function makePipeline(settings: () => SearchPipelineSettings): SearchPipeline {
  return new SearchPipeline({
    db: {} as Surreal,
    reranker: {} as Reranker,
    embed: async () => null,
    provider: PROVIDER,
    reasoningModel: "reasoning",
    scheduler: REASONING_SCHEDULER,
    settings,
    now: () => 1,
  });
}

async function collect(iterable: AsyncIterable<SearchEvent>): Promise<SearchEvent[]> {
  const events: SearchEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("SearchPipeline numeric boundaries", () => {
  test.each([0, -1, 1.5, 51, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects an invalid query limit %p instead of clamping it",
    async (limit) => {
      const pipeline = makePipeline(() => VALID_SETTINGS);
      const query = { query: "notes", mode: "quick", limit } as SearchQuery;
      await expect(collect(pipeline.run(query, new AbortController().signal))).rejects.toThrow(
        "safe integer from 1 through 50",
      );
    },
  );

  test.each([
    { balanced: { topK: 0, rerankTopN: 1 }, deep: { synthesisEnabled: true } },
    { balanced: { topK: 10.5, rerankTopN: 1 }, deep: { synthesisEnabled: true } },
    { balanced: { topK: 10, rerankTopN: 11 }, deep: { synthesisEnabled: true } },
    { balanced: { topK: 10, rerankTopN: 1.5 }, deep: { synthesisEnabled: true } },
    { balanced: { topK: 10, rerankTopN: 1 }, deep: { synthesisEnabled: "yes" } },
  ])("rejects corrupt settings at construction", (settings) => {
    expect(() => makePipeline(() => settings as unknown as SearchPipelineSettings)).toThrow(
      "settings are invalid",
    );
  });

  test("fails a request when live settings become corrupt", async () => {
    let settings: SearchPipelineSettings = VALID_SETTINGS;
    const pipeline = makePipeline(() => settings);
    settings = {
      balanced: { topK: 20, rerankTopN: Number.NaN },
      deep: { synthesisEnabled: true },
    };

    const events = await collect(
      pipeline.run({ query: "notes", mode: "balanced", limit: 5 }, new AbortController().signal),
    );
    expect(events).toEqual([
      { type: "search:retrieving", mode: "balanced" },
      { type: "search:error", message: "SearchPipeline settings are invalid" },
    ]);
  });
});
