import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureNotientEnv,
  stripNotientEnvFromProcess,
  writeVaultEnvFile,
} from "../../../../tools/lib/spawnEnv";

describe("captureNotientEnv", () => {
  test("returns trimmed snapshot when all three required vars are present", () => {
    const snapshot = captureNotientEnv({
      NOTIENT_LLM_BASE_URL: "http://example:1234/v1",
      NOTIENT_LLM_MODEL: "test-model",
      NOTIENT_EMBED_MODEL: "test-embed",
    });
    expect(snapshot).toEqual({
      baseUrl: "http://example:1234/v1",
      chatModel: "test-model",
      embedModel: "test-embed",
      contextTokens: undefined,
    });
  });

  test("trims whitespace from each value", () => {
    const snapshot = captureNotientEnv({
      NOTIENT_LLM_BASE_URL: "  http://example:1234/v1  ",
      NOTIENT_LLM_MODEL: "\ttest-model\n",
      NOTIENT_EMBED_MODEL: " test-embed ",
      NOTIENT_CONTEXT_TOKENS: " 200000 ",
    });
    expect(snapshot.baseUrl).toBe("http://example:1234/v1");
    expect(snapshot.chatModel).toBe("test-model");
    expect(snapshot.embedModel).toBe("test-embed");
    expect(snapshot.contextTokens).toBe("200000");
  });

  test("captures optional context tokens when present", () => {
    const snapshot = captureNotientEnv({
      NOTIENT_LLM_BASE_URL: "http://x/v1",
      NOTIENT_LLM_MODEL: "m",
      NOTIENT_EMBED_MODEL: "e",
      NOTIENT_CONTEXT_TOKENS: "200000",
    });
    expect(snapshot.contextTokens).toBe("200000");
  });

  test("throws listing every missing required var", () => {
    expect(() =>
      captureNotientEnv({
        NOTIENT_LLM_BASE_URL: "http://x/v1",
      }),
    ).toThrow(/NOTIENT_LLM_MODEL.*NOTIENT_EMBED_MODEL/);
  });

  test("treats empty-string values as missing", () => {
    expect(() =>
      captureNotientEnv({
        NOTIENT_LLM_BASE_URL: "",
        NOTIENT_LLM_MODEL: "m",
        NOTIENT_EMBED_MODEL: "e",
      }),
    ).toThrow(/NOTIENT_LLM_BASE_URL/);
  });

  test("treats whitespace-only values as missing", () => {
    expect(() =>
      captureNotientEnv({
        NOTIENT_LLM_BASE_URL: "http://x/v1",
        NOTIENT_LLM_MODEL: "   ",
        NOTIENT_EMBED_MODEL: "e",
      }),
    ).toThrow(/NOTIENT_LLM_MODEL/);
  });

  test("error mentions the .env source so the operator knows where to set", () => {
    expect(() => captureNotientEnv({})).toThrow(/\.env/);
  });
});

describe("writeVaultEnvFile", () => {
  test("writes .notient/.env with all four keys when context tokens supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "spawn-env-test-"));
    try {
      await writeVaultEnvFile(root, {
        baseUrl: "http://x/v1",
        chatModel: "test-chat",
        embedModel: "test-embed",
        contextTokens: "200000",
      });
      const text = await readFile(join(root, ".notient", ".env"), "utf-8");
      expect(text).toContain("NOTIENT_LLM_BASE_URL=http://x/v1");
      expect(text).toContain("NOTIENT_LLM_MODEL=test-chat");
      expect(text).toContain("NOTIENT_EMBED_MODEL=test-embed");
      expect(text).toContain("NOTIENT_CONTEXT_TOKENS=200000");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("omits NOTIENT_CONTEXT_TOKENS when undefined", async () => {
    const root = await mkdtemp(join(tmpdir(), "spawn-env-test-"));
    try {
      await writeVaultEnvFile(root, {
        baseUrl: "http://x/v1",
        chatModel: "m",
        embedModel: "e",
        contextTokens: undefined,
      });
      const text = await readFile(join(root, ".notient", ".env"), "utf-8");
      expect(text).not.toContain("NOTIENT_CONTEXT_TOKENS");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("creates .notient/ if it does not yet exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "spawn-env-test-"));
    try {
      await writeVaultEnvFile(root, {
        baseUrl: "u",
        chatModel: "m",
        embedModel: "e",
        contextTokens: undefined,
      });
      const text = await readFile(join(root, ".notient", ".env"), "utf-8");
      expect(text.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("stripNotientEnvFromProcess", () => {
  test("removes every NOTIENT_-prefixed key and sets BUN_ENV_FILE", () => {
    const env: NodeJS.ProcessEnv = {
      NOTIENT_LLM_MODEL: "x",
      NOTIENT_LLM_BASE_URL: "y",
      OTHER_VAR: "keep",
    };
    stripNotientEnvFromProcess(env);
    expect(env.NOTIENT_LLM_MODEL).toBeUndefined();
    expect(env.NOTIENT_LLM_BASE_URL).toBeUndefined();
    expect(env.OTHER_VAR).toBe("keep");
    expect(env.BUN_ENV_FILE).toBe("/dev/null");
  });
});
