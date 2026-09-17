import { expect, test } from "bun:test";
import { briefResultFor, briefResultSchema } from "../../../../src/api/brief";
import { briefNotes, parseBriefMaxField } from "../../../../src/cli/commands/brief";
import { makeEmitter } from "../../../../src/cli/output";
import { currentCoverageFixture } from "../../../indexingFixture";

const source = { path: "Notes/Storage café.md", revision: "a".repeat(64) };
const result = {
  ok: true as const,
  topic: "Storage",
  summary: {
    text: "A **durable** service.",
    evidence: [
      {
        ...source,
        quote: "Three replicas.",
        range: { start: 0, end: 15, startLine: 1, endLine: 1 },
      },
    ],
  },
  findings: [],
  sources: [source],
  abstained: false,
  reason: null,
  coverage: currentCoverageFixture(),
  limitations: [],
  attempts: [],
  durationMs: 10,
};
test("brief renders readable Markdown or exact structured JSON through the ordinary emitter", () => {
  const pretty: string[] = [];
  const json: string[] = [];
  const event = { type: "brief:done", ...result };
  makeEmitter({ mode: "pretty", write: (line) => pretty.push(line) }).emit(event);
  expect(pretty.join("\n")).toContain("A **durable** service.");
  expect(pretty.join("\n")).toContain("Storage%20caf%C3%A9.md");
  expect(pretty.join("\n")).toContain("> Three replicas.");
  makeEmitter({ mode: "json", write: (line) => json.push(line) }).emit(event);
  expect(briefResultSchema.parse(JSON.parse(json[0]))).toEqual(result);
});
test("brief outcomes cannot detach evidence from revisions or pretend an abstention is a finding", () => {
  expect(briefResultSchema.safeParse({ ...result, sources: [] }).success).toBe(false);
  expect(briefResultSchema.safeParse({ ...result, abstained: true }).success).toBe(false);
  expect(briefResultSchema.safeParse({ ...result, summary: null }).success).toBe(false);
  expect(
    briefResultSchema.safeParse({
      ...result,
      summary: null,
      abstained: true,
      reason: "No current evidence.",
    }).success,
  ).toBe(true);
  expect(
    briefResultSchema.safeParse({ ...result, findings: [{ ...result.summary, kind: "tension" }] })
      .success,
  ).toBe(false);
});
test("brief validates mode, paths, limits and scope before connecting", async () => {
  for (const input of [
    {},
    { topic: "storage", filePath: "A.md" },
    { topic: " " },
    { filePath: "../escape.md" },
    { filePath: ".notient/.env" },
    { topic: "storage", maxNotes: 9 },
    { topic: "storage", folder: "../private" },
  ])
    await expect(
      briefNotes({ vaultPath: "/no-daemon-should-start", ...input }),
    ).rejects.toBeDefined();
  expect(parseBriefMaxField(undefined)).toBeUndefined();
  expect(parseBriefMaxField("8")).toBe(8);
  for (const value of ["0", "9", "1.5", "1e0", true, ""])
    expect(() => parseBriefMaxField(value)).toThrow("between 1 and 8");
});

test("brief responses are bound to the topic, saved revision and note cap", () => {
  expect(briefResultFor({ query: "another topic" }).safeParse(result).success).toBe(false);
  expect(
    briefResultFor({ source: { ...source, revision: "b".repeat(64) } }).safeParse(result).success,
  ).toBe(false);
  expect(briefResultFor({ source, limit: 1 }).safeParse(result).success).toBe(true);
  expect(
    briefResultFor({ query: "Storage", limit: 1 }).safeParse({
      ...result,
      sources: [source, { ...source, path: "Another.md" }],
    }).success,
  ).toBe(false);
});
