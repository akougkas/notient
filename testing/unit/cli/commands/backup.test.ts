import { describe, expect, test } from "bun:test";
import { writeAll } from "../../../../src/cli/commands/backup";

describe("backup output persistence", () => {
  test("retries short writes until every byte is persisted", async () => {
    const persisted: number[] = [];
    const writer = {
      async write(buffer: Uint8Array, offset: number, length: number, position: null) {
        expect(position).toBeNull();
        const bytesWritten = Math.min(length, 3);
        persisted.push(...buffer.subarray(offset, offset + bytesWritten));
        return { bytesWritten };
      },
    };
    const expected = Buffer.from("authenticated backup bytes that exceed one short write");

    await writeAll(writer, expected);

    expect(Buffer.from(persisted).equals(expected)).toBe(true);
  });

  test("fails instead of accepting a zero-byte write", async () => {
    const writer = {
      async write(_buffer: Uint8Array, _offset: number, _length: number, _position: null) {
        return { bytesWritten: 0 };
      },
    };

    await expect(writeAll(writer, Buffer.from("must persist"))).rejects.toThrow(
      "made no forward progress",
    );
  });
});
