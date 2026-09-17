import { describe, expect, test } from "bun:test";
import { collectSurrealImportResult } from "../../../../src/cli/commands/restore";

describe("Surreal import process drainage", () => {
  test("drains stdout beyond pipe capacity while retaining bounded stderr", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        "process.stdout.write('x'.repeat(2 * 1024 * 1024)); process.stderr.write('import-note');",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const result = await collectSurrealImportResult({
      stdout: child.stdout as ReadableStream<Uint8Array>,
      stderr: child.stderr as ReadableStream<Uint8Array>,
      exited: child.exited,
    });

    expect(result).toEqual({ exitCode: 0, stderr: "import-note" });
  });
});
