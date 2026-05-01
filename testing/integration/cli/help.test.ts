import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  "src/cli/index.ts",
);

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout };
}

describe("per-verb help", () => {
  test("awaken --help prints awaken-specific flags without requiring a vault", async () => {
    const result = await runCli(["awaken", "--help", "--ndjson"]);
    expect(result.exitCode).toBe(0);
    const event = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(event.type).toBe("help");
    expect(event.command).toBe("awaken");
    expect(event.usage).toBe(
      "notient awaken --vault <path> [--batch N] [--since ISO] [--tier 1,2,3]",
    );
    expect(event.flags).toContain("--status");
  });

  test("ask --help and distill --help print their own flag sets", async () => {
    const ask = await runCli(["ask", "--help", "--ndjson"]);
    const distill = await runCli(["distill", "--help", "--ndjson"]);

    const askEvent = JSON.parse(ask.stdout.trim()) as Record<string, unknown>;
    const distillEvent = JSON.parse(distill.stdout.trim()) as Record<string, unknown>;

    expect(ask.exitCode).toBe(0);
    expect(askEvent.command).toBe("ask");
    expect(askEvent.flags).toContain("--max-rounds <number>");
    expect(distill.exitCode).toBe(0);
    expect(distillEvent.command).toBe("distill");
    expect(distillEvent.flags).toContain("--from <path>");
  });
});
