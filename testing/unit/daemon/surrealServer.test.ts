import { describe, expect, test } from "bun:test";
import {
  buildSurrealStartInvocation,
  captureFreshSurrealProof,
  parseBoundPort,
  parseSurrealVersion,
  startSurreal,
} from "../../../src/daemon/surrealServer";

describe("parseSurrealVersion", () => {
  test("parses a full version banner", () => {
    expect(
      parseSurrealVersion("SurrealDB command-line interface and server 3.0.5 for linux on x86_64"),
    ).toEqual({ major: 3, minor: 0, patch: 5 });
  });

  test("parses a short version line with trailing newline", () => {
    expect(parseSurrealVersion("surrealdb 3.2.10\n")).toEqual({
      major: 3,
      minor: 2,
      patch: 10,
    });
  });

  test("returns null for pre-3.x versions", () => {
    expect(parseSurrealVersion("surreal 2.4.7")).toBeNull();
  });

  test("returns null for unparseable input", () => {
    expect(parseSurrealVersion("hello world")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(parseSurrealVersion("")).toBeNull();
  });
});

describe("parseBoundPort", () => {
  test("extracts the port from a bare line", () => {
    expect(parseBoundPort("Started server at 127.0.0.1:8123\n")).toBe(8123);
  });

  test("extracts the port from a prefixed log line", () => {
    expect(
      parseBoundPort(
        "INFO surrealdb::net 2026-04-29T12:00:00Z Started server at 127.0.0.1:54321\n",
      ),
    ).toBe(54321);
  });

  test("extracts the port when followed by additional log lines", () => {
    expect(parseBoundPort("...Started server at 127.0.0.1:9999\nINFO ready\n")).toBe(9999);
  });

  test("returns null when the marker is absent", () => {
    expect(parseBoundPort("INFO surrealdb starting up\n")).toBeNull();
  });
});

describe("startSurreal runtime configuration", () => {
  const baseOptions = {
    dataDir: "/tmp/notient-invalid-surreal/data",
    secret: "invalid-options-never-spawn",
    portFile: "/tmp/notient-invalid-surreal/port",
    pidFile: "/tmp/notient-invalid-surreal/pid",
    logLevel: "none" as const,
    hnswCacheMib: 64,
  };

  test("rejects invalid HNSW cache sizes before touching the runtime", async () => {
    await expect(startSurreal({ ...baseOptions, hnswCacheMib: 0 })).rejects.toThrow(
      "hnswCacheMib must be an integer between 1 and 1048576",
    );
  });

  test("rejects invalid log levels before touching the runtime", async () => {
    await expect(startSurreal({ ...baseOptions, logLevel: "verbose" as never })).rejects.toThrow(
      "logLevel must be a supported SurrealDB log level",
    );
  });
});

describe("buildSurrealStartInvocation", () => {
  test("keeps the root password out of argv and inherits only required child state", () => {
    const secret = "server-secret-that-must-not-enter-argv";
    const invocation = buildSurrealStartInvocation(
      {
        dataDir: "/tmp/notient-surreal-data",
        secret,
        portFile: "/tmp/notient-surreal.port",
        pidFile: "/tmp/notient-surreal.pid",
        logLevel: "warn",
        hnswCacheMib: 768,
      },
      8_765,
      "11111111-1111-4111-8111-111111111111",
      "/test/bin",
    );

    expect(invocation.argv).toEqual([
      "surreal",
      "start",
      "--bind",
      "127.0.0.1:8765",
      "--user",
      "root",
      "--log",
      "warn",
      "rocksdb:///tmp/notient-surreal-data",
    ]);
    expect(invocation.argv).not.toContain("--pass");
    expect(invocation.argv).not.toContain("--password");
    expect(invocation.argv).not.toContain(secret);
    expect(invocation.env).toEqual({
      NOTIENT_SURREAL_INSTANCE_ID: "11111111-1111-4111-8111-111111111111",
      SURREAL_PASS: secret,
      SURREAL_HNSW_CACHE_SIZE: "768",
      PATH: "/test/bin",
    });
  });
});

describe("portable fresh-child ownership", () => {
  test.skipIf(process.platform !== "linux")(
    "waits for a spawned child to exec the expected Linux executable",
    async () => {
      const child = Bun.spawn(["/bin/sh", "-c", "sleep 0.05; exec /usr/bin/sleep 5"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        await expect(captureFreshSurrealProof(child.pid, "/usr/bin/sleep")).resolves.toEqual(
          expect.objectContaining({
            kind: "linux-procfs",
            executable: "/usr/bin/sleep",
          }),
        );
      } finally {
        child.kill("SIGTERM");
        await child.exited;
      }
    },
  );

  test("records unavailable stale-process proof without touching procfs off Linux", async () => {
    await expect(captureFreshSurrealProof(99_999_999, "/opt/surreal", "darwin")).resolves.toEqual({
      kind: "unavailable",
      executable: "/opt/surreal",
    });
  });
});
