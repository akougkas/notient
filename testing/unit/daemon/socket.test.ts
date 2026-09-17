import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { type WritableSocket, resolveSocketPath, writeFrame } from "../../../src/daemon/socket";

describe("resolveSocketPath", () => {
  test("Linux/macOS/WSL2 returns ~/.notient/<vault-id>/notient.sock", () => {
    const result = resolveSocketPath("/home/user/notes", "linux");
    expect(result).toBe(join(vaultStateDir("/home/user/notes"), "notient.sock"));
  });

  test("the socket never lives inside the vault", () => {
    const vault = "/mnt/c/Users/user/notes";
    expect(resolveSocketPath(vault, "linux").startsWith(vault)).toBe(false);
  });

  test("distinct vaults get distinct sockets", () => {
    expect(resolveSocketPath("/a/notes", "linux")).not.toBe(resolveSocketPath("/b/notes", "linux"));
  });

  test("Windows native fails closed without a verifiable user-only pipe ACL", () => {
    expect(() => resolveSocketPath("C:\\Users\\user\\notes", "win32")).toThrow(
      "current-user-only named-pipe ACL",
    );
  });
});

function fakeSocket(overrides: Partial<WritableSocket> = {}): {
  socket: WritableSocket;
  written: string[];
} {
  const written: string[] = [];
  const socket: WritableSocket = {
    destroyed: false,
    writable: true,
    write: (data: string) => {
      written.push(data);
      return true;
    },
    ...overrides,
  };
  return { socket, written };
}

describe("writeFrame", () => {
  test("appends a newline and reports success on a live socket", () => {
    const { socket, written } = fakeSocket();
    expect(writeFrame(socket, '{"id":"r"}')).toBe(true);
    expect(written).toEqual(['{"id":"r"}\n']);
  });

  test("skips a destroyed socket without writing", () => {
    const { socket, written } = fakeSocket({ destroyed: true });
    expect(writeFrame(socket, "frame")).toBe(false);
    expect(written).toEqual([]);
  });

  test("skips a non-writable socket without writing", () => {
    const { socket, written } = fakeSocket({ writable: false });
    expect(writeFrame(socket, "frame")).toBe(false);
    expect(written).toEqual([]);
  });

  test("swallows a throwing write so it never escapes into the handler", () => {
    const socket: WritableSocket = {
      destroyed: false,
      writable: true,
      write: () => {
        throw new Error("ERR_STREAM_DESTROYED");
      },
    };
    expect(() => writeFrame(socket, "frame")).not.toThrow();
    expect(writeFrame(socket, "frame")).toBe(false);
  });
});
