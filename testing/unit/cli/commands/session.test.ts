import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSessionFolders,
  parseSessionId,
  parseSessionOptionalPositiveInt,
  parseSessionPositiveInt,
  parseSessionTools,
  runSessionCommand,
} from "../../../../src/cli/commands/session";
import { makeEmitter } from "../../../../src/cli/output";
import { currentPlatform, resolveSocketPath } from "../../../../src/daemon/socket";

interface FakeDaemon {
  server: Server;
  framesReceived: Record<string, unknown>[];
  setReply: (reply: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

async function startFakeDaemon(rootDir: string): Promise<FakeDaemon> {
  const socketPath = resolveSocketPath(rootDir, currentPlatform());
  await mkdir(join(rootDir, ".notient"), { recursive: true });
  const sockets = new Set<Socket>();
  const framesReceived: Record<string, unknown>[] = [];
  let pendingReply: Record<string, unknown> = {
    type: "result",
    ok: true,
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          const frame = JSON.parse(line) as Record<string, unknown>;
          framesReceived.push(frame);
          const id = typeof frame.id === "string" ? frame.id : "unknown";
          socket.write(`${JSON.stringify({ id, ...pendingReply })}\n`);
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    server,
    framesReceived,
    setReply: (reply) => {
      pendingReply = reply;
    },
    close: async () => {
      for (const socket of sockets) socket.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("notient session CLI", () => {
  let rootDir: string;
  let daemon: FakeDaemon;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "notient-session-cli-"));
    daemon = await startFakeDaemon(rootDir);
  });
  afterEach(async () => {
    await daemon.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  test("grant forwards client + folders + ttl + tools + maxWrites and prints JSON", async () => {
    daemon.setReply({
      type: "result",
      ok: true,
      sessionId: 1,
      client: "claude-code",
      expiresAt: 1_700_000_000,
      allowedFolders: ["Inbox/"],
      allowedTools: ["notes.create"],
      maxWrites: 20,
    });
    const stdoutLines: string[] = [];
    const exitCode = await runSessionCommand({
      vaultPath: rootDir,
      subcommand: "grant",
      client: "claude-code",
      folders: ["Inbox/"],
      tools: ["notes.create"],
      maxWrites: 20,
      ttlMinutes: 60,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: (line) => stdoutLines.push(line),
      writeStderr: () => {},
    });
    expect(exitCode).toBe(0);
    const sent = daemon.framesReceived[0];
    expect(sent.method).toBe("session.grant");
    const params = sent.params as Record<string, unknown>;
    expect(params.client).toBe("claude-code");
    expect(params.allowedFolders).toEqual(["Inbox/"]);
    expect(params.allowedTools).toEqual(["notes.create"]);
    expect(params.maxWrites).toBe(20);
    expect(params.ttlMinutes).toBe(60);
    const printed = JSON.parse(stdoutLines.join("\n")) as Record<string, unknown>;
    expect(printed.sessionId).toBe(1);
    expect(printed.client).toBe("claude-code");
  });

  test("grant omits allowedTools and maxWrites when not supplied", async () => {
    daemon.setReply({
      type: "result",
      ok: true,
      sessionId: 2,
      client: "claude-code",
      expiresAt: 1_700_000_000,
      allowedFolders: ["Inbox/"],
      allowedTools: [],
      maxWrites: null,
    });
    await runSessionCommand({
      vaultPath: rootDir,
      subcommand: "grant",
      client: "claude-code",
      folders: ["Inbox/"],
      ttlMinutes: 30,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const sent = daemon.framesReceived[0];
    const params = sent.params as Record<string, unknown>;
    expect(params.allowedTools).toBeUndefined();
    expect(params.maxWrites).toBeUndefined();
  });

  test("grant requires --client", async () => {
    let thrown: unknown = null;
    try {
      await runSessionCommand({
        vaultPath: rootDir,
        subcommand: "grant",
        folders: ["Inbox/"],
        ttlMinutes: 30,
        emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
        writeStdout: () => {},
        writeStderr: () => {},
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("--client");
  });

  test("grant requires --folders", async () => {
    let thrown: unknown = null;
    try {
      await runSessionCommand({
        vaultPath: rootDir,
        subcommand: "grant",
        client: "claude-code",
        ttlMinutes: 30,
        emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
        writeStdout: () => {},
        writeStderr: () => {},
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("--folders");
  });

  test("grant requires --ttl", async () => {
    let thrown: unknown = null;
    try {
      await runSessionCommand({
        vaultPath: rootDir,
        subcommand: "grant",
        client: "claude-code",
        folders: ["Inbox/"],
        emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
        writeStdout: () => {},
        writeStderr: () => {},
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("--ttl");
  });

  test("revoke forwards sessionId and prints JSON", async () => {
    daemon.setReply({
      type: "result",
      ok: true,
      sessionId: 5,
      revokedAt: 1_700_000_500,
    });
    const stdoutLines: string[] = [];
    const exitCode = await runSessionCommand({
      vaultPath: rootDir,
      subcommand: "revoke",
      sessionId: 5,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: (line) => stdoutLines.push(line),
      writeStderr: () => {},
    });
    expect(exitCode).toBe(0);
    const sent = daemon.framesReceived[0];
    expect(sent.method).toBe("session.revoke");
    const params = sent.params as Record<string, unknown>;
    expect(params.sessionId).toBe(5);
    const printed = JSON.parse(stdoutLines.join("\n")) as Record<string, unknown>;
    expect(printed.sessionId).toBe(5);
    expect(printed.revokedAt).toBe(1_700_000_500);
  });

  test("revoke surfaces SESSION_NOT_FOUND with non-zero exit", async () => {
    daemon.setReply({
      type: "error",
      code: "INTERNAL",
      message: "SESSION_NOT_FOUND: no session with id 9999",
    });
    const stderrLines: string[] = [];
    const exitCode = await runSessionCommand({
      vaultPath: rootDir,
      subcommand: "revoke",
      sessionId: 9999,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: () => {},
      writeStderr: (line) => stderrLines.push(line),
    });
    expect(exitCode).toBe(1);
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain("SESSION_NOT_FOUND");
  });

  test("list forwards an empty params object by default", async () => {
    daemon.setReply({ type: "result", ok: true, sessions: [] });
    await runSessionCommand({
      vaultPath: rootDir,
      subcommand: "list",
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const sent = daemon.framesReceived[0];
    expect(sent.method).toBe("session.list");
    const params = sent.params as Record<string, unknown>;
    expect(params.activeOnly).toBeUndefined();
    expect(params.client).toBeUndefined();
  });

  test("list --include-expired sets activeOnly:false", async () => {
    daemon.setReply({ type: "result", ok: true, sessions: [] });
    await runSessionCommand({
      vaultPath: rootDir,
      subcommand: "list",
      includeExpired: true,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const sent = daemon.framesReceived[0];
    const params = sent.params as Record<string, unknown>;
    expect(params.activeOnly).toBe(false);
  });

  test("list --client scopes the result", async () => {
    daemon.setReply({ type: "result", ok: true, sessions: [] });
    await runSessionCommand({
      vaultPath: rootDir,
      subcommand: "list",
      client: "claude-code",
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const sent = daemon.framesReceived[0];
    const params = sent.params as Record<string, unknown>;
    expect(params.client).toBe("claude-code");
  });
});

describe("session flag parsing", () => {
  test("parseSessionFolders splits a comma-separated list", () => {
    expect(parseSessionFolders("Inbox/")).toEqual(["Inbox/"]);
    expect(parseSessionFolders("Inbox/,Notient/agent-asks/")).toEqual([
      "Inbox/",
      "Notient/agent-asks/",
    ]);
    expect(parseSessionFolders(" A , B , C ")).toEqual(["A", "B", "C"]);
    expect(() => parseSessionFolders("")).toThrow();
    expect(() => parseSessionFolders(undefined)).toThrow();
    expect(() => parseSessionFolders(",, ,")).toThrow();
  });

  test("parseSessionTools returns an empty array when omitted", () => {
    expect(parseSessionTools(undefined)).toEqual([]);
    expect(parseSessionTools("notes.create")).toEqual(["notes.create"]);
    expect(parseSessionTools("notes.create,notes.append")).toEqual([
      "notes.create",
      "notes.append",
    ]);
    expect(() => parseSessionTools(7 as unknown as string)).toThrow();
  });

  test("parseSessionPositiveInt enforces positive integers", () => {
    expect(parseSessionPositiveInt("60", "ttl")).toBe(60);
    expect(parseSessionPositiveInt(60, "ttl")).toBe(60);
    expect(parseSessionPositiveInt(60.7, "ttl")).toBe(60);
    expect(() => parseSessionPositiveInt("0", "ttl")).toThrow();
    expect(() => parseSessionPositiveInt("abc", "ttl")).toThrow();
    expect(() => parseSessionPositiveInt(-1, "ttl")).toThrow();
  });

  test("parseSessionOptionalPositiveInt returns undefined for missing values", () => {
    expect(parseSessionOptionalPositiveInt(undefined, "max-writes")).toBeUndefined();
    expect(parseSessionOptionalPositiveInt("20", "max-writes")).toBe(20);
    expect(() => parseSessionOptionalPositiveInt("0", "max-writes")).toThrow();
  });

  test("parseSessionId requires a positive integer", () => {
    expect(parseSessionId("5")).toBe(5);
    expect(parseSessionId(5)).toBe(5);
    expect(() => parseSessionId(undefined)).toThrow();
    expect(() => parseSessionId("abc")).toThrow();
    expect(() => parseSessionId(-1)).toThrow();
    expect(() => parseSessionId(3.5)).toThrow();
  });
});
