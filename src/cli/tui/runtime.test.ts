import { describe, expect, test } from "bun:test";
import { buildStatusLabel, frameToErrorLine } from "./runtime";

describe("buildStatusLabel", () => {
  test("renders idle status with vault basename", () => {
    expect(buildStatusLabel("/mnt/c/Users/me/vault", false, 0)).toBe(
      "notient · vault:vault · idle",
    );
  });

  test("shows thinking… when busy", () => {
    expect(buildStatusLabel("/x/y/vault", true, 0)).toBe("notient · vault:vault · thinking…");
  });

  test("appends pending count when > 0", () => {
    expect(buildStatusLabel("/x/vault", false, 2)).toBe(
      "notient · vault:vault · idle · pending:2",
    );
  });

  test("does not show pending segment when count is zero", () => {
    expect(buildStatusLabel("/x/vault", false, 0)).not.toContain("pending");
  });
});

describe("frameToErrorLine", () => {
  test("extracts message from rpc error frame", () => {
    const line = frameToErrorLine({
      type: "error",
      message: "stream closed",
    } as { type: "error"; message: string });
    expect(line).toEqual({ kind: "error", text: "rpc error: stream closed" });
  });

  test("falls back to default when message is absent", () => {
    const line = frameToErrorLine({ type: "error" } as { type: "error" });
    expect(line).toEqual({ kind: "error", text: "rpc error: unknown" });
  });
});
