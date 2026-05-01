import { describe, expect, test } from "bun:test";
import { detectFormat, parseTranscript } from "../../../../src/core/distill/transcriptParser";

describe("detectFormat", () => {
  test("uses filename hint extensions first", () => {
    expect(detectFormat("anything", "session.md")).toBe("markdown");
    expect(detectFormat("anything", "session.markdown")).toBe("markdown");
    expect(detectFormat("anything", "session.jsonl")).toBe("jsonl");
    expect(detectFormat("anything", "session.ndjson")).toBe("jsonl");
    expect(detectFormat('{"messages":[]}', "session.json")).toBe("json");
  });

  test("sniffs JSON object root from content", () => {
    const content = '{"messages":[{"role":"user","content":"hi"}]}';
    expect(detectFormat(content)).toBe("json");
  });

  test("sniffs JSONL when each non-empty line parses as JSON", () => {
    const content =
      '{"type":"user","message":{"content":"a"}}\n{"type":"assistant","message":{"content":"b"}}';
    expect(detectFormat(content)).toBe("jsonl");
  });

  test("falls back to markdown for unstructured content", () => {
    const content = "User: hi there\n\nAssistant: hello back";
    expect(detectFormat(content)).toBe("markdown");
  });
});

describe("parseTranscript markdown", () => {
  test("parses two user/assistant blocks into four messages", () => {
    const content = [
      "User: first question",
      "",
      "Assistant: first answer",
      "",
      "User: follow-up",
      "",
      "Assistant: final answer",
    ].join("\n");
    const messages = parseTranscript(content, "markdown");
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("first question");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("first answer");
    expect(messages[2].role).toBe("user");
    expect(messages[3].role).toBe("assistant");
    expect(messages[3].content).toBe("final answer");
  });

  test("multi-line content stays inside a single message", () => {
    const content = ["User: line one", "line two", "line three", "", "Assistant: short"].join("\n");
    const messages = parseTranscript(content, "markdown");
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("line one\nline two\nline three");
  });

  test("trims surrounding whitespace from message content", () => {
    const content = "User:   spaced out content   \n\nAssistant:  trailing  ";
    const messages = parseTranscript(content, "markdown");
    expect(messages[0].content).toBe("spaced out content");
    expect(messages[1].content).toBe("trailing");
  });

  test("recognizes system and tool block headers", () => {
    const content = [
      "System: be concise",
      "",
      "User: hi",
      "",
      "Tool: result data",
      "",
      "Assistant: ok",
    ].join("\n");
    const messages = parseTranscript(content, "markdown");
    expect(messages.map((entry) => entry.role)).toEqual(["system", "user", "tool", "assistant"]);
  });
});

describe("parseTranscript jsonl", () => {
  test("parses a Claude Code session sample with tool_use and tool_result", () => {
    const content = [
      JSON.stringify({ type: "user", message: { content: "Refactor auth.ts" } }),
      JSON.stringify({ type: "assistant", message: { content: "I will read the file first." } }),
      JSON.stringify({ type: "tool_use", name: "Read", input: { file_path: "auth.ts" } }),
      JSON.stringify({ type: "tool_result", content: "export function authorize() { ... }" }),
      JSON.stringify({ type: "assistant", message: { content: "Now I will refactor it." } }),
    ].join("\n");
    const messages = parseTranscript(content, "jsonl");
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toContain("I will read the file first.");
    expect(messages[1].content).toContain("[tool_use: Read]");
    expect(messages[2].role).toBe("assistant");
    expect(messages[2].content).toContain("[tool_result:");
    expect(messages[2].content).toContain("Now I will refactor it.");
  });

  test("flattens array content blocks into a single string", () => {
    const content = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Block one." },
          { type: "text", text: "Block two." },
        ],
      },
    });
    const messages = parseTranscript(content, "jsonl");
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Block one.\n\nBlock two.");
  });

  test("falls back to generic role/content shape", () => {
    const content = [
      JSON.stringify({ role: "user", content: "hello" }),
      JSON.stringify({ role: "assistant", content: "hi" }),
    ].join("\n");
    const messages = parseTranscript(content, "jsonl");
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].content).toBe("hi");
  });
});

describe("parseTranscript json", () => {
  test("parses {messages: [...]} OpenAI shape", () => {
    const content = JSON.stringify({
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
      ],
    });
    const messages = parseTranscript(content, "json");
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("u1");
  });

  test("parses {transcript: [...]} alias", () => {
    const content = JSON.stringify({
      transcript: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
      ],
    });
    const messages = parseTranscript(content, "json");
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
  });

  test("throws clear error on unknown root shape", () => {
    expect(() => parseTranscript('{"foo":"bar"}', "json")).toThrow(/unrecognized JSON shape/);
  });
});

describe("sourceMessageId stability", () => {
  test("identical content yields identical ids across re-parses", () => {
    const content = ["User: stable input", "", "Assistant: stable output"].join("\n");
    const first = parseTranscript(content, "markdown");
    const second = parseTranscript(content, "markdown");
    expect(first.map((entry) => entry.sourceMessageId)).toEqual(
      second.map((entry) => entry.sourceMessageId),
    );
  });

  test("different content yields different ids", () => {
    const a = parseTranscript("User: a", "markdown");
    const b = parseTranscript("User: b", "markdown");
    expect(a[0].sourceMessageId).not.toBe(b[0].sourceMessageId);
  });
});
