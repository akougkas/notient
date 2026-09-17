import { describe, expect, test } from "bun:test";
import {
  buildSurrealDataInvocation,
  buildSurrealSqlInvocation,
  parseDaemonPortFile,
  parseSurrealCliExitCode,
} from "../../../../src/cli/commands/surrealCli";
import { BACKUP_TABLES } from "../../../../src/core/db/backupTables";

describe("buildSurrealDataInvocation", () => {
  const secret = "unit-secret-that-must-never-enter-argv";

  test("builds a records-only export with the password isolated in a minimal environment", () => {
    const invocation = buildSurrealDataInvocation({
      operation: "export",
      port: 8_000,
      secret,
      path: "/test/bin",
    });

    expect(invocation.argv).toEqual([
      "surreal",
      "export",
      "--endpoint",
      "http://127.0.0.1:8000",
      "--username",
      "root",
      "--namespace",
      "notient",
      "--database",
      "vault",
      "--log",
      "none",
      "--only",
      "--tables",
      BACKUP_TABLES.join(","),
      "--records",
      "true",
      "-",
    ]);
    expect(invocation.argv).not.toContain("--password");
    expect(invocation.argv).not.toContain(secret);
    expect(invocation.env).toEqual({ SURREAL_PASS: secret, PATH: "/test/bin" });
  });

  test("builds an import with no credential argument or inherited parent environment", () => {
    const invocation = buildSurrealDataInvocation({
      operation: "import",
      port: 9_001,
      secret,
      filePath: "/tmp/graph.surql",
    });

    expect(invocation.argv).toEqual([
      "surreal",
      "import",
      "--endpoint",
      "http://127.0.0.1:9001",
      "--username",
      "root",
      "--namespace",
      "notient",
      "--database",
      "vault",
      "--log",
      "none",
      "/tmp/graph.surql",
    ]);
    expect(invocation.argv).not.toContain("--password");
    expect(invocation.argv).not.toContain(secret);
    expect(invocation.env).toEqual({ SURREAL_PASS: secret });
  });
});

describe("buildSurrealSqlInvocation", () => {
  test("keeps the interactive root password out of argv and the inherited environment", () => {
    const secret = "interactive-secret-that-must-never-enter-argv";
    const invocation = buildSurrealSqlInvocation({
      port: 7_777,
      secret,
      path: "/test/bin",
    });

    expect(invocation.argv).toEqual([
      "surreal",
      "sql",
      "--endpoint",
      "ws://127.0.0.1:7777/rpc",
      "--username",
      "root",
      "--namespace",
      "notient",
      "--database",
      "vault",
      "--pretty",
    ]);
    expect(invocation.argv).not.toContain("--password");
    expect(invocation.argv).not.toContain(secret);
    expect(invocation.env).toEqual({ SURREAL_PASS: secret, PATH: "/test/bin" });
  });
});

describe("parseDaemonPortFile", () => {
  test("accepts the exact supervisor-owned port-file shape", () => {
    expect(parseDaemonPortFile("1\n")).toBe(1);
    expect(parseDaemonPortFile("65535\n")).toBe(65_535);
  });

  test.each([
    [undefined],
    [null],
    [""],
    ["8080"],
    [" 8080\n"],
    ["8080 \n"],
    ["08080\n"],
    ["0\n"],
    ["65536\n"],
    ["1.5\n"],
    ["NaN\n"],
    ["8080\nextra"],
  ])("rejects non-canonical port-file value %p", (raw) => {
    expect(() => parseDaemonPortFile(raw)).toThrow(/daemon port file/);
  });
});

describe("parseSurrealCliExitCode", () => {
  test("accepts explicit nonnegative integer statuses", () => {
    expect(parseSurrealCliExitCode(0)).toBe(0);
    expect(parseSurrealCliExitCode(1)).toBe(1);
    expect(parseSurrealCliExitCode(143)).toBe(143);
  });

  test.each([undefined, null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "0"])(
    "rejects indeterminate process status %p",
    (raw) => {
      expect(() => parseSurrealCliExitCode(raw)).toThrow(/invalid process exit status/);
    },
  );
});
