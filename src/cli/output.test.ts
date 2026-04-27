import { describe, expect, test } from "bun:test";
import { type EmitterMode, type StructuredEvent, makeEmitter } from "./output";

function captureMode(mode: EmitterMode): { lines: string[]; emit: (event: StructuredEvent) => void } {
  const lines: string[] = [];
  const emitter = makeEmitter({
    mode,
    write: (line) => {
      lines.push(line);
    },
  });
  return { lines, emit: emitter.emit };
}

describe("makeEmitter", () => {
  test("ndjson mode emits one JSON object per event", () => {
    const { lines, emit } = captureMode("ndjson");
    emit({ type: "indexer:queued", path: "a.md" });
    emit({ type: "indexer:queued", path: "b.md" });
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toEqual({ type: "indexer:queued", path: "a.md" });
    expect(JSON.parse(lines[1])).toEqual({ type: "indexer:queued", path: "b.md" });
  });

  test("json mode emits a single object on flush", () => {
    const { lines, emit } = captureMode("json");
    emit({ type: "result", data: { foo: 1 } });
    expect(lines).toEqual([JSON.stringify({ type: "result", data: { foo: 1 } })]);
  });

  test("pretty mode renders type prefix", () => {
    const { lines, emit } = captureMode("pretty");
    emit({ type: "daemon:ready", vault: "/tmp/v" });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("daemon:ready");
    expect(lines[0]).toContain("/tmp/v");
  });
});
