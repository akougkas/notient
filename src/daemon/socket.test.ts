import { describe, expect, test } from "bun:test";
import { resolveSocketPath } from "./socket";

describe("resolveSocketPath", () => {
  test("Linux/macOS/WSL2 returns <vault>/.notient/notient.sock", () => {
    const result = resolveSocketPath("/home/user/notes", "linux");
    expect(result).toBe("/home/user/notes/.notient/notient.sock");
  });

  test("Windows native returns named pipe with sha8 hash", () => {
    const result = resolveSocketPath("C:\\Users\\user\\notes", "win32");
    expect(result.startsWith("\\\\.\\pipe\\notient-")).toBe(true);
    expect(result.length).toBe("\\\\.\\pipe\\notient-".length + 8);
  });

  test("hash is stable across calls", () => {
    const a = resolveSocketPath("C:\\Users\\user\\notes", "win32");
    const b = resolveSocketPath("C:\\Users\\user\\notes", "win32");
    expect(a).toBe(b);
  });
});
