import { describe, expect, test } from "bun:test";
import { buildTextareaKeyBindings, computeInputHeight } from "../../../../src/cli/tui/inputBindings";

describe("buildTextareaKeyBindings", () => {
  test("Enter alone submits the buffer", () => {
    const bindings = buildTextareaKeyBindings();
    const enter = bindings.find((b) => b.name === "return" && !b.shift && !b.meta && !b.ctrl);
    expect(enter?.action).toBe("submit");
  });

  test("Shift+Enter inserts a newline", () => {
    const bindings = buildTextareaKeyBindings();
    const shiftEnter = bindings.find((b) => b.name === "return" && b.shift === true);
    expect(shiftEnter?.action).toBe("newline");
  });

  test("Alt+Enter (meta+Enter) inserts a newline", () => {
    const bindings = buildTextareaKeyBindings();
    const altEnter = bindings.find((b) => b.name === "return" && b.meta === true);
    expect(altEnter?.action).toBe("newline");
  });

  test("returns at least these three Enter bindings", () => {
    const bindings = buildTextareaKeyBindings();
    const enterBindings = bindings.filter((b) => b.name === "return");
    expect(enterBindings.length).toBeGreaterThanOrEqual(3);
  });
});

describe("computeInputHeight", () => {
  test("empty buffer renders one row", () => {
    expect(computeInputHeight("", 80, 6)).toBe(1);
  });

  test("single short line renders one row", () => {
    expect(computeInputHeight("hello", 80, 6)).toBe(1);
  });

  test("two logical lines render two rows", () => {
    expect(computeInputHeight("a\nb", 80, 6)).toBe(2);
  });

  test("trailing newline reserves a row for the cursor", () => {
    expect(computeInputHeight("a\n", 80, 6)).toBe(2);
  });

  test("five logical lines render five rows", () => {
    expect(computeInputHeight("a\nb\nc\nd\ne", 80, 6)).toBe(5);
  });

  test("clamps to cap when more logical lines than cap", () => {
    expect(computeInputHeight("1\n2\n3\n4\n5\n6\n7\n8", 80, 6)).toBe(6);
  });

  test("respects custom cap", () => {
    expect(computeInputHeight("1\n2\n3\n4\n5", 80, 4)).toBe(4);
  });

  test("wraps a long single line by terminal width", () => {
    const longLine = "x".repeat(85);
    expect(computeInputHeight(longLine, 40, 6)).toBe(3);
  });

  test("wraps each logical line independently", () => {
    const value = `${"a".repeat(45)}\nb`;
    expect(computeInputHeight(value, 40, 6)).toBe(3);
  });

  test("never returns less than one row", () => {
    expect(computeInputHeight("", 80, 6)).toBeGreaterThanOrEqual(1);
  });

  test("does not divide by zero on width 1", () => {
    const longLine = "x".repeat(10);
    expect(computeInputHeight(longLine, 1, 6)).toBe(6);
  });

  test("treats width <= 0 as width 1", () => {
    expect(computeInputHeight("hello", 0, 6)).toBe(5);
  });
});
