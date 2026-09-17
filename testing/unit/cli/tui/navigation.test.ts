import { expect, test } from "bun:test";
import { navigationMatches } from "../../../../src/cli/tui/navigation";

const labels = (query: string) => navigationMatches(query).map((action) => action.label);

test("an empty query keeps the authored menu order", () => {
  expect(labels("")[0]).toStartWith("Capture a thought");
  expect(labels("").length).toBeGreaterThan(10);
});

test("an action's name outranks another action's description", () => {
  expect(labels("review")[0]).toStartWith("Review changes");
  expect(labels("review")).toContain("Save this answer — review it as a note");
  expect(labels("note")[0]).toStartWith("Edit the open note");
  expect(labels("conv")[0]).toStartWith("Conversations");
});

test("every term must match and order is otherwise stable", () => {
  expect(labels("review xyz")).toEqual([]);
  expect(labels("change")).toEqual([
    "Change history — inspect earlier versions and undo",
    "Review changes — proposals and approvals",
  ]);
});
