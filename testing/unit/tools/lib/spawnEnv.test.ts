import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
      embedBaseUrl: undefined,
      chatModel: "test-model",
      embedModel: "test-embed",
      contextTokens: undefined,
      reasoningSlots: undefined,
    });
  });

  test("trims whitespace from each value", () => {
    const snapshot = captureNotientEnv({
      NOTIENT_LLM_BASE_URL: "  http://example:1234/v1  ",
      NOTIENT_EMBED_BASE_URL: "  http://embed.example:11434/v1  ",
      NOTIENT_LLM_MODEL: "\ttest-model\n",
      NOTIENT_EMBED_MODEL: " test-embed ",
      NOTIENT_CONTEXT_TOKENS: " 200000 ",
      NOTIENT_REASONING_SLOTS: " 4 ",
    });
    expect(snapshot.baseUrl).toBe("http://example:1234/v1");
    expect(snapshot.embedBaseUrl).toBe("http://embed.example:11434/v1");
    expect(snapshot.chatModel).toBe("test-model");
    expect(snapshot.embedModel).toBe("test-embed");
    expect(snapshot.contextTokens).toBe("200000");
    expect(snapshot.reasoningSlots).toBe("4");
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

  test("captures optional reasoning slots when present", () => {
    const snapshot = captureNotientEnv({
      NOTIENT_LLM_BASE_URL: "http://x/v1",
      NOTIENT_LLM_MODEL: "m",
      NOTIENT_EMBED_MODEL: "e",
      NOTIENT_REASONING_SLOTS: "4",
    });
    expect(snapshot.reasoningSlots).toBe("4");
  });

  test("captures endpoint bearer tokens exactly and preserves an empty embedding override", () => {
    const snapshot = captureNotientEnv({
      NOTIENT_LLM_BASE_URL: "http://x/v1",
      NOTIENT_LLM_MODEL: "m",
      NOTIENT_EMBED_MODEL: "e",
      NOTIENT_LLM_API_KEY: "chat-token_123",
      NOTIENT_EMBED_API_KEY: "",
    });
    expect(snapshot.chatApiKey).toBe("chat-token_123");
    expect(snapshot.embedApiKey).toBeNull();
  });

  test("rejects malformed endpoint bearer tokens without exposing them", () => {
    const malformed = "secret with spaces";
    let thrown: unknown;
    try {
      captureNotientEnv({
        NOTIENT_LLM_BASE_URL: "http://x/v1",
        NOTIENT_LLM_MODEL: "m",
        NOTIENT_EMBED_MODEL: "e",
        NOTIENT_LLM_API_KEY: malformed,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(malformed);
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
  test("writes .notient/.env with optional deployment keys when supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "spawn-env-test-"));
    try {
      await writeVaultEnvFile(root, {
        baseUrl: "http://x/v1",
        embedBaseUrl: "http://embed.example/v1",
        chatModel: "test-chat",
        embedModel: "test-embed",
        chatApiKey: "chat-token_123",
        embedApiKey: null,
        contextTokens: "200000",
        reasoningSlots: "4",
      });
      const text = await readFile(join(root, ".notient", ".env"), "utf-8");
      expect(text).toBe(
        [
          "NOTIENT_LLM_BASE_URL=http://x/v1",
          "NOTIENT_EMBED_BASE_URL=http://embed.example/v1",
          "NOTIENT_LLM_API_KEY=chat-token_123",
          "NOTIENT_EMBED_API_KEY=",
          "NOTIENT_LLM_MODEL=test-chat",
          "NOTIENT_EMBED_MODEL=test-embed",
          "NOTIENT_CONTEXT_TOKENS=200000",
          "NOTIENT_REASONING_SLOTS=4",
          "",
        ].join("\n"),
      );
      expect((await stat(join(root, ".notient", ".env"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("omits optional deployment keys when undefined", async () => {
    const root = await mkdtemp(join(tmpdir(), "spawn-env-test-"));
    try {
      await writeVaultEnvFile(root, {
        baseUrl: "http://x/v1",
        embedBaseUrl: undefined,
        chatModel: "m",
        embedModel: "e",
        contextTokens: undefined,
        reasoningSlots: undefined,
      });
      const text = await readFile(join(root, ".notient", ".env"), "utf-8");
      expect(text).toBe(
        [
          "NOTIENT_LLM_BASE_URL=http://x/v1",
          "NOTIENT_LLM_MODEL=m",
          "NOTIENT_EMBED_MODEL=e",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("creates .notient/ if it does not yet exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "spawn-env-test-"));
    try {
      await writeVaultEnvFile(root, {
        baseUrl: "u",
        embedBaseUrl: undefined,
        chatModel: "m",
        embedModel: "e",
        contextTokens: undefined,
        reasoningSlots: undefined,
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
