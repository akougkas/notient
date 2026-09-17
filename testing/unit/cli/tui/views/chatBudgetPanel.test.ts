import { expect, test } from "bun:test";
import {
  CHAT_BUDGET_FIELDS,
  budgetText,
  editBudget,
} from "../../../../../src/cli/tui/views/ChatBudgetPanel";

const budget = { modelCalls: 12, tokens: 160000, durationMs: 180000, generationTokens: 16384 };
const field = (key: string) => {
  const found = CHAT_BUDGET_FIELDS.find((item) => item.key === key);
  if (!found) throw new Error(`unknown budget field ${key}`);
  return found;
};

test("a time limit is edited in seconds and stored in milliseconds", () => {
  expect(budgetText(budget, field("durationMs"))).toBe("180");
  expect(editBudget(budget, field("durationMs"), " 240 ").durationMs).toBe(240000);
});

test("an out-of-range value names the allowed range in the unit the person typed", () => {
  expect(() => editBudget(budget, field("durationMs"), "240180")).toThrow(
    "Time per turn: enter a whole number from 1 to 3600 seconds.",
  );
  expect(() => editBudget(budget, field("modelCalls"), "0")).toThrow(
    "Model calls per turn: enter a whole number from 1 to 128 calls.",
  );
  expect(() => editBudget(budget, field("tokens"), "many")).toThrow("Enter a finite number.");
});
