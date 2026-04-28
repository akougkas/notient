import { describe, expect, test } from "bun:test";
import { buildStatusBar, estimateTokens } from "./statusBar";

describe("buildStatusBar", () => {
  test("idle vault with no extra fields", () => {
    const segs = buildStatusBar({
      vaultPath: "/x/y/vault",
      topic: "",
      model: null,
      busy: false,
      pendingCount: 0,
      lastTurnTokens: null,
    });
    expect(segs.left).toBe("notient · vault:vault");
    expect(segs.right).toBe("idle");
  });

  test("includes topic on the left when present", () => {
    const segs = buildStatusBar({
      vaultPath: "/v",
      topic: "TUI session",
      model: null,
      busy: false,
      pendingCount: 0,
      lastTurnTokens: null,
    });
    expect(segs.left).toBe("notient · vault:v · topic:TUI session");
  });

  test("right segment shows thinking with model and tokens", () => {
    const segs = buildStatusBar({
      vaultPath: "/v",
      topic: "",
      model: "nemotron",
      busy: true,
      pendingCount: 0,
      lastTurnTokens: 320,
    });
    expect(segs.right).toBe("thinking… · ~320 tok · nemotron");
  });

  test("hides pending segment when zero", () => {
    const segs = buildStatusBar({
      vaultPath: "/v",
      topic: "",
      model: null,
      busy: false,
      pendingCount: 0,
      lastTurnTokens: null,
    });
    expect(segs.right).not.toContain("pending");
  });

  test("hides token segment when null", () => {
    const segs = buildStatusBar({
      vaultPath: "/v",
      topic: "",
      model: null,
      busy: false,
      pendingCount: 0,
      lastTurnTokens: null,
    });
    expect(segs.right).not.toContain("tok");
  });

  test("hides model segment when null", () => {
    const segs = buildStatusBar({
      vaultPath: "/v",
      topic: "",
      model: null,
      busy: true,
      pendingCount: 1,
      lastTurnTokens: 50,
    });
    expect(segs.right.split(" · ")).toEqual(["thinking…", "pending:1", "~50 tok"]);
  });

  test("orders right-side counters: state, pending, tokens, model", () => {
    const segs = buildStatusBar({
      vaultPath: "/v",
      topic: "",
      model: "model-x",
      busy: false,
      pendingCount: 2,
      lastTurnTokens: 100,
    });
    expect(segs.right).toBe("idle · pending:2 · ~100 tok · model-x");
  });
});

describe("estimateTokens", () => {
  test("empty text is zero tokens", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("very short text rounds up to at least one token", () => {
    expect(estimateTokens("a")).toBe(1);
  });

  test("scales roughly to characters / 4", () => {
    expect(estimateTokens("x".repeat(40))).toBe(10);
  });
});
