import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../../../src/version";

const CLI_ENTRY = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  "src/cli/index.ts",
);

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("per-verb help", () => {
  test("awaken --help prints awaken-specific flags without requiring a vault", async () => {
    const result = await runCli(["awaken", "--help", "--ndjson"]);
    expect(result.exitCode).toBe(0);
    const event = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(event.type).toBe("help");
    expect(event.command).toBe("awaken");
    expect(event.usage).toBe("notient awaken --vault <path> [--since ISO] [--tier 1,2,3]");
    expect(event.flags).not.toContain("--batch <number>");
    expect(event.flags).toContain("--status");
  });

  test("awaken rejects the deleted batch flag before resolving or starting a daemon", async () => {
    const result = await runCli(["awaken", "--batch", "10", "--ndjson"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      type: "error",
      message: "INVALID_PARAMS: awaken does not support --batch",
    });
  });

  test("awaken rejects ambiguous control flags instead of choosing the first", async () => {
    const result = await runCli(["awaken", "--pause", "--status", "--ndjson"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      type: "error",
      message: "INVALID_PARAMS: awaken control flags are mutually exclusive",
    });
  });

  test("awaken does not coerce valued booleans or mix control and run options", async () => {
    const valuedBoolean = await runCli(["awaken", "--background", "false", "--ndjson"]);
    const mixedModes = await runCli(["awaken", "--pause", "--since", "2026-08-01", "--ndjson"]);

    expect(valuedBoolean.exitCode).toBe(1);
    expect(JSON.parse(valuedBoolean.stdout.trim())).toMatchObject({
      type: "error",
      message: "INVALID_PARAMS: --background does not accept a value",
    });
    expect(mixedModes.exitCode).toBe(1);
    expect(JSON.parse(mixedModes.stdout.trim())).toMatchObject({
      type: "error",
      message: "INVALID_PARAMS: awaken control flags cannot be combined with run options",
    });
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

  test("mcp startup errors never write to the protocol channel", async () => {
    const result = await runCli([
      "mcp",
      "--vault",
      "/tmp/notient-mcp-error-probe",
      "--as",
      "../invalid-agent",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      type: "error",
      code: "INTERNAL",
    });
  });

  test("top-level help and unknown-command routing stay exact", async () => {
    const help = await runCli(["help", "--ndjson"]);
    const barePipe = await runCli([]);
    const unknown = await runCli(["sentinel", "--ndjson"]);

    expect(help.exitCode).toBe(0);
    expect(JSON.parse(help.stdout.trim())).toMatchObject({
      type: "help",
      commands: [
        "api",
        "jobs",
        "pipelines",
        "pair",
        "init",
        "setup",
        "daemon",
        "db sql",
        "awaken",
        "reindex",
        "search",
        "vitals",
        "health",
        "doctor",
        "history",
        "undo",
        "chat",
        "ask",
        "brief",
        "compare",
        "correlate",
        "distill",
        "events",
        "session",
        "mcp",
        "graph",
        "links",
        "proposals",
        "backup",
        "restore",
        "nuke",
      ],
    });
    expect(barePipe.exitCode).toBe(0);
    expect(JSON.parse(barePipe.stdout.trim())).toMatchObject({ type: "help" });
    expect(unknown.exitCode).toBe(2);
    expect(JSON.parse(unknown.stdout.trim())).toMatchObject({
      type: "error",
      code: "INVALID_PARAMS",
      message: "Unknown command: sentinel",
    });
  });

  test("--version reports the shared release version without requiring a vault", async () => {
    const result = await runCli(["--version", "--ndjson"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      type: "version",
      version: VERSION,
    });
  });

  test("output mode routing rejects valued or competing flags", async () => {
    const valued = await runCli(["help", "--ndjson", "false"]);
    const competing = await runCli(["help", "--json", "--ndjson"]);

    expect(valued.exitCode).toBe(1);
    expect(JSON.parse(valued.stdout.trim())).toMatchObject({
      type: "error",
      message: "INVALID_PARAMS: --ndjson does not accept a value",
    });
    expect(competing.exitCode).toBe(1);
    expect(JSON.parse(competing.stdout.trim())).toMatchObject({
      type: "error",
      message: "INVALID_PARAMS: output mode flags are mutually exclusive",
    });
  });
});
