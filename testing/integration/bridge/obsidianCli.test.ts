import { describe, expect, test } from "bun:test";
import { execObsidian } from "../../../src/bridge/obsidianCli";

describe("execObsidian", () => {
  test("returns ok=false when the binary is missing", async () => {
    const result = await execObsidian({
      command: "definitely-not-a-real-binary-xyz",
      args: ["--version"],
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("returns ok=true with stdout when the command succeeds", async () => {
    const result = await execObsidian({
      command: "/bin/sh",
      args: ["-c", "printf 'hello\\n'"],
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  test("returns ok=false on non-zero exit", async () => {
    const result = await execObsidian({
      command: "/bin/sh",
      args: ["-c", "exit 7"],
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
  });

  test("times out long-running commands", async () => {
    const result = await execObsidian({
      command: "/bin/sh",
      args: ["-c", "sleep 5"],
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timeout");
  });
});
