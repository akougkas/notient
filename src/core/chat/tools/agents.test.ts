/**
 * Phase 5 Locked Decision 11 chat-tool no-op coverage.
 *
 * Task 6 stripped Synthesizer and ContradictionHunter from production
 * wiring. Task 7 mirrored that decision on the chat-tool surface: the
 * `agents.contradiction_check` and `agents.synthesize` tools now return
 * an empty result shape and ignore their `Agent` placeholder dependency.
 * The unit tests pin that contract so a future re-introduction of the
 * SurrealDB-backed implementations is an additive change rather than a
 * silent surface break.
 */

import { describe, expect, test } from "bun:test";
import type { Agent, AgentRunResult } from "../../coordinator/types";
import { EventBus } from "../../events/eventBus";
import { makeContradictionCheckTool, makeSynthesizeTool } from "./agents";

function noopAgent(name: Agent["name"]): Agent {
  return {
    name,
    usesReasoningModel: false,
    run: async (): Promise<AgentRunResult> => ({ proposals: 0 }),
  };
}

describe("agents.contradiction_check", () => {
  test("returns the Locked Decision 11 no-op result shape", async () => {
    const tool = makeContradictionCheckTool({
      hunter: noopAgent("contradictionHunter"),
      bus: new EventBus(),
    });
    const result = await tool.invoke({ notePath: "/a.md" }, new AbortController().signal);
    expect(result).toEqual({ proposalsCount: 0, newProposals: [] });
  });

  test("rejects an empty notePath", () => {
    const tool = makeContradictionCheckTool({
      hunter: noopAgent("contradictionHunter"),
      bus: new EventBus(),
    });
    expect(() => tool.validate({ notePath: "" })).toThrow();
  });
});

describe("agents.synthesize", () => {
  test("returns the Locked Decision 11 no-op result shape", async () => {
    const tool = makeSynthesizeTool({
      synthesizer: noopAgent("synthesizer"),
      bus: new EventBus(),
    });
    const result = await tool.invoke({}, new AbortController().signal);
    expect(result).toEqual({ proposalsCount: 0, newProposals: [] });
  });

  test("accepts an optional notePaths list", () => {
    const tool = makeSynthesizeTool({
      synthesizer: noopAgent("synthesizer"),
      bus: new EventBus(),
    });
    const validated = tool.validate({ notePaths: ["/a.md", "/b.md"] });
    expect(validated).toEqual({ notePaths: ["/a.md", "/b.md"] });
  });

  test("rejects malformed notePaths", () => {
    const tool = makeSynthesizeTool({
      synthesizer: noopAgent("synthesizer"),
      bus: new EventBus(),
    });
    expect(() => tool.validate({ notePaths: [1, 2] })).toThrow();
  });
});
