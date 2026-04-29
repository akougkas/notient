import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AGENT_ID,
  RESERVED_AGENT_IDS,
  normalizeAgentId,
  validateAgentId,
} from "./identity";

describe("validateAgentId", () => {
  test("every reserved id passes validation", () => {
    for (const reserved of RESERVED_AGENT_IDS) {
      const result = validateAgentId(reserved);
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.id).toBe(reserved);
    }
  });

  test("custom ids matching the regex pass", () => {
    const samples = [
      "my-agent",
      "bot-1",
      "agent-name-with-many-segments",
      "a",
      "z9",
      // 32 characters exactly: leading letter + 31 more.
      `a${"b".repeat(31)}`,
    ];
    for (const sample of samples) {
      const result = validateAgentId(sample);
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.id).toBe(sample);
    }
  });

  test("empty and whitespace-only inputs default to human", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      const result = validateAgentId(blank);
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.id).toBe(DEFAULT_AGENT_ID);
    }
  });

  test("rejects malformed ids with a descriptive reason", () => {
    const rejections = [
      "Bad ID",
      "agent.with.dots",
      "AGENT",
      "1leading-digit",
      "-leading-hyphen",
      "spaces inside",
      // 33 characters: leading letter + 32 more.
      `a${"b".repeat(32)}`,
    ];
    for (const candidate of rejections) {
      const result = validateAgentId(candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.length).toBeGreaterThan(0);
        expect(result.reason).toContain(candidate);
      }
    }
  });
});

describe("normalizeAgentId", () => {
  test("undefined, empty, and whitespace return DEFAULT_AGENT_ID", () => {
    expect(normalizeAgentId(undefined)).toBe(DEFAULT_AGENT_ID);
    expect(normalizeAgentId("")).toBe(DEFAULT_AGENT_ID);
    expect(normalizeAgentId("   ")).toBe(DEFAULT_AGENT_ID);
  });

  test("returns reserved ids verbatim", () => {
    expect(normalizeAgentId("claude-code")).toBe("claude-code");
    expect(normalizeAgentId("human")).toBe("human");
  });

  test("trims surrounding whitespace before validating", () => {
    expect(normalizeAgentId("  my-agent  ")).toBe("my-agent");
  });

  test("throws an Error naming the offending input on malformed non-empty values", () => {
    expect(() => normalizeAgentId("Bad ID")).toThrow(/Bad ID/);
    expect(() => normalizeAgentId("AGENT")).toThrow(/AGENT/);
    expect(() => normalizeAgentId("1leading")).toThrow(/1leading/);
  });
});
