import { describe, expect, test } from "bun:test";
import {
  applyPrintableInput,
  buildStatusLabel,
  frameToErrorLine,
  killLine,
  killWord,
} from "./runtime";

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
    expect(buildStatusLabel("/x/vault", false, 2)).toBe("notient · vault:vault · idle · pending:2");
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

describe("applyPrintableInput", () => {
  test("appends a single printable character", () => {
    expect(applyPrintableInput("hel", "p")).toBe("help");
  });

  test("appends a multi-character pasted string", () => {
    expect(applyPrintableInput("note: ", "hello world")).toBe("note: hello world");
  });

  test("strips embedded control characters from a paste", () => {
    expect(applyPrintableInput("a", "b\x00c\x1bd\x7fe")).toBe("abcde");
  });

  test("returns the buffer unchanged when sequence is only control characters", () => {
    expect(applyPrintableInput("buffer", "\x1b\x00\x7f")).toBe("buffer");
  });
});

describe("killLine", () => {
  test("returns empty string regardless of buffer contents", () => {
    expect(killLine("hello world")).toBe("");
    expect(killLine("")).toBe("");
  });
});

describe("killWord", () => {
  test("returns empty string when the buffer is empty", () => {
    expect(killWord("")).toBe("");
  });

  test("drops the final whitespace-then-word run", () => {
    expect(killWord("hello world")).toBe("hello");
  });

  test("drops trailing whitespace before the last word", () => {
    expect(killWord("foo bar   ")).toBe("foo");
  });

  test("clears a single trailing word with no whitespace", () => {
    expect(killWord("solo")).toBe("");
  });
});
