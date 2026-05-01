import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseBoundPort,
  parseSurrealVersion,
  stopStaleSurrealProcess,
} from "../../../src/daemon/surrealServer";

const spawnedPids = new Set<number>();

afterEach(async () => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  spawnedPids.clear();
});

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
