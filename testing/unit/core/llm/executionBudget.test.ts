import { expect, test } from "bun:test";
import { InferenceBudget } from "../../../../src/core/llm/executionBudget";
import { parseNotientConfig } from "../../../../src/core/settings/configSchema";
import { DEFAULT_CHAT_BUDGET, DEFAULT_NOTIENT_CONFIG } from "../../../../src/core/settings/types";

test("budget deadlines carry the same limit failure as synchronous resource checks", async () => {
  const budget = new InferenceBudget({ modelCalls: 2, tokens: 100, durationMs: 20 });
  await budget.reserve(10, 30).ready;
  await Bun.sleep(30);
  expect(budget.signal.aborted).toBe(true);
  expect(budget.signal.reason).toMatchObject({
    code: "LIMIT_EXCEEDED",
    message: "inference duration budget exhausted",
  });
  expect(() => budget.assertAvailable()).toThrow(budget.signal.reason);
  expect(budget.chargedTokens).toBe(40);
  expect(budget.attempts[0].accounting).toBe("reserved-estimate");
  for (const limits of [
    { modelCalls: 0, tokens: 100, durationMs: 1000 },
    { modelCalls: 1, tokens: 0, durationMs: 1000 },
  ]) {
    let error: unknown;
    try {
      new InferenceBudget(limits).reserve(10, 30);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "LIMIT_EXCEEDED" });
  }
});

test("caller cancellation retains its own reason rather than becoming a resource failure", () => {
  const controller = new AbortController();
  const budget = new InferenceBudget(
    { modelCalls: 1, tokens: 100, durationMs: 1000 },
    [],
    undefined,
    controller.signal,
  );
  const reason = new DOMException("Stopped by caller", "AbortError");
  controller.abort(reason);
  expect(budget.signal.reason).toBe(reason);
  expect(() => budget.assertAvailable()).toThrow(reason);
});

test("nested analysis spends the same parent budget, shares provider usage and cannot multiply its allowance", async () => {
  const parent = new InferenceBudget({
    modelCalls: 2,
    tokens: 1000,
    durationMs: 1000,
    generationTokens: 500,
  });
  await parent.run(async () => {
    const child = new InferenceBudget({
      modelCalls: 4,
      tokens: 9000,
      durationMs: 5000,
      generationTokens: 800,
    });
    await child.run(async () => {
      const reservation = child.reserve(100, 800);
      await reservation.ready;
      expect(reservation.maxTokens).toBe(500);
      expect(child.chargedTokens).toBe(600);
      expect(parent.chargedTokens).toBe(600);
      reservation.settle({
        finishReason: "stop",
        state: "complete",
        usage: {
          source: "provider",
          promptTokens: 100,
          completionTokens: 200,
          totalTokens: 300,
          reasoningTokens: 150,
          visibleAnswerTokens: null,
          nonReasoningCompletionTokens: 50,
        },
      });
      await child.flush();
      expect(parent.chargedTokens).toBe(300);
      expect(child.chargedTokens).toBe(300);
      const second = child.reserve(100, 800);
      await second.ready;
      expect(second.maxTokens).toBe(500);
      expect(() => child.reserve(0, 1)).toThrow("model-call budget exhausted");
      expect(parent.attempts).toHaveLength(2);
      expect(child.attempts).toHaveLength(2);
    });
    const sibling = new InferenceBudget({ modelCalls: 4, tokens: 9000, durationMs: 5000 });
    await sibling.run(async () => {
      expect(() => sibling.reserve(0, 1)).toThrow("model-call budget exhausted");
      expect(sibling.attempts).toHaveLength(0);
    });
  });
});

test("child deadlines and token caps cannot broaden a parent, and failed admission leaves no phantom attempt", async () => {
  const parent = new InferenceBudget({ modelCalls: 4, tokens: 100, durationMs: 25 });
  await parent.run(async () => {
    const child = new InferenceBudget({ modelCalls: 4, tokens: 1000, durationMs: 5000 });
    await child.run(async () => {
      await child.reserve(60, 30).ready;
      expect(() => child.reserve(20, 1)).toThrow("token budget");
      expect(child.attempts).toHaveLength(1);
      expect(parent.attempts).toHaveLength(1);
      await Bun.sleep(35);
      expect(child.signal.aborted).toBe(true);
      expect(() => child.assertAvailable()).toThrow("duration budget");
    });
  });
  const unrelated = new InferenceBudget({ modelCalls: 1, tokens: 100, durationMs: 5000 });
  const owner = new InferenceBudget({ modelCalls: 1, tokens: 100, durationMs: 5000 });
  await owner.run(async () => {
    expect(() => unrelated.run(async () => {})).toThrow("cannot replace");
  });
});

test("saved chat budgets validate strictly and existing configurations acquire bounded defaults without rewriting", () => {
  const config = structuredClone(DEFAULT_NOTIENT_CONFIG);
  const old = JSON.parse(JSON.stringify(config));
  old.chat.budget = undefined;
  const raw = JSON.stringify(old);
  expect(parseNotientConfig(raw, "config.json").chat.budget).toEqual(DEFAULT_CHAT_BUDGET);
  expect(JSON.stringify(old)).toBe(raw);
  for (const patch of [
    { modelCalls: 0 },
    { tokens: 1000001 },
    { durationMs: -1 },
    { generationTokens: 1.5 },
    { admin: true },
  ]) {
    const changed = {
      ...config,
      chat: { ...config.chat, budget: { ...config.chat.budget, ...patch } },
    };
    expect(() => parseNotientConfig(JSON.stringify(changed), "config.json")).toThrow(
      "invalid configuration",
    );
  }
});
