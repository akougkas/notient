import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candidate, TranscriptDistiller } from "../../core/distill/transcriptDistiller";
import type { TranscriptMessage } from "../../core/distill/transcriptParser";
import { makeAgentDistillHandler } from "./agentDistill";

function stubDistiller(reply: Candidate[] | ((messages: TranscriptMessage[]) => Candidate[])): {
  distiller: TranscriptDistiller;
  invocations: TranscriptMessage[][];
} {
  const invocations: TranscriptMessage[][] = [];
  const distiller: TranscriptDistiller = {
    distill: async (messages) => {
      invocations.push(messages);
      return typeof reply === "function" ? reply(messages) : reply;
    },
  };
  return { distiller, invocations };
}

async function withTempVault<T>(fn: (vaultRoot: string) => Promise<T>): Promise<T> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "notient-distill-"));
  try {
    return await fn(vaultRoot);
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
}

const MARKDOWN_TRANSCRIPT = [
  "User: Should we use OAuth2 with PKCE?",
  "",
  "Assistant: Yes. Going with OAuth2+PKCE for the SPA.",
  "",
  "User: How do we handle token rotation?",
].join("\n");

describe("agent.distill handler", () => {
  test("rejects '..' traversal in transcriptPath", async () => {
    await withTempVault(async (vaultRoot) => {
      const { distiller } = stubDistiller([]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      let thrown: unknown = null;
      try {
        await handler({ transcriptPath: "../etc/passwd" }, () => {}, "req-1", "claude-code");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("'..'");
    });
  });

  test("rejects '..' traversal in absolute path", async () => {
    await withTempVault(async (vaultRoot) => {
      const { distiller } = stubDistiller([]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      let thrown: unknown = null;
      try {
        await handler(
          { transcriptPath: "/var/data/../../etc/passwd" },
          () => {},
          "req-2",
          "claude-code",
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("'..'");
    });
  });

  test("file-not-found names the path in the error", async () => {
    await withTempVault(async (vaultRoot) => {
      const { distiller } = stubDistiller([]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      let thrown: unknown = null;
      try {
        await handler({ transcriptPath: "missing.md" }, () => {}, "req-3", "claude-code");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("missing.md");
    });
  });

  test("markdown transcript: writes proposals and returns candidates", async () => {
    await withTempVault(async (vaultRoot) => {
      const transcriptPath = join(vaultRoot, "transcript.md");
      await writeFile(transcriptPath, MARKDOWN_TRANSCRIPT, "utf-8");
      const { distiller } = stubDistiller((messages) => [
        {
          kind: "decision",
          text: "Use OAuth2 with PKCE for the SPA.",
          sourceMessageIds: [messages[1]?.sourceMessageId ?? ""],
        },
        {
          kind: "question",
          text: "How do we handle token rotation?",
          sourceMessageIds: [messages[2]?.sourceMessageId ?? ""],
        },
      ]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      const result = await handler(
        { transcriptPath: "transcript.md" },
        () => {},
        "req-4",
        "claude-code",
      );
      expect(result.ok).toBe(true);
      expect(result.proposalsCreated).toBe(2);
      const candidates = result.candidates as Candidate[];
      expect(candidates).toHaveLength(2);
      expect(result.byKind).toEqual({ decision: 1, question: 1 });
      const proposalsDir = join(vaultRoot, "Notient", "proposals");
      const entries = await readdir(proposalsDir);
      expect(entries).toHaveLength(2);
      const fileBody = await readFile(join(proposalsDir, entries[0]), "utf-8");
      expect(fileBody).toContain("---");
      expect(fileBody).toContain("kind:");
      expect(fileBody).toContain("sourceTranscript:");
      expect(fileBody).toContain("clientIdentity: claude-code");
      expect(fileBody).toContain("sourceMessageIds:");
    });
  });

  test("absolute path transcript outside vault works", async () => {
    await withTempVault(async (vaultRoot) => {
      const externalDir = await mkdtemp(join(tmpdir(), "notient-distill-ext-"));
      try {
        const externalPath = join(externalDir, "session.md");
        await writeFile(externalPath, MARKDOWN_TRANSCRIPT, "utf-8");
        const { distiller } = stubDistiller([
          { kind: "note", text: "External transcript note.", sourceMessageIds: [] },
        ]);
        const handler = makeAgentDistillHandler({ vaultRoot, distiller });
        const result = await handler(
          { transcriptPath: externalPath },
          () => {},
          "req-5",
          "claude-code",
        );
        expect(result.proposalsCreated).toBe(1);
      } finally {
        await rm(externalDir, { recursive: true, force: true });
      }
    });
  });

  test("JSONL transcript end-to-end check", async () => {
    await withTempVault(async (vaultRoot) => {
      const transcriptPath = join(vaultRoot, "session.jsonl");
      const content = [
        JSON.stringify({ type: "user", message: { content: "Refactor auth.ts" } }),
        JSON.stringify({ type: "assistant", message: { content: "Will read the file first." } }),
      ].join("\n");
      await writeFile(transcriptPath, content, "utf-8");
      const { distiller, invocations } = stubDistiller([
        { kind: "claim", text: "Auth file refactor pending.", sourceMessageIds: [] },
      ]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      const result = await handler(
        { transcriptPath: "session.jsonl" },
        () => {},
        "req-6",
        "claude-code",
      );
      expect(result.proposalsCreated).toBe(1);
      expect(invocations[0]).toHaveLength(2);
      expect(invocations[0][0].role).toBe("user");
    });
  });

  test("JSON transcript {messages: [...]} shape", async () => {
    await withTempVault(async (vaultRoot) => {
      const transcriptPath = join(vaultRoot, "exchange.json");
      await writeFile(
        transcriptPath,
        JSON.stringify({
          messages: [
            { role: "user", content: "u1" },
            { role: "assistant", content: "a1" },
          ],
        }),
        "utf-8",
      );
      const { distiller, invocations } = stubDistiller([
        { kind: "note", text: "JSON shape note.", sourceMessageIds: [] },
      ]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      const result = await handler(
        { transcriptPath: "exchange.json" },
        () => {},
        "req-7",
        "claude-code",
      );
      expect(result.proposalsCreated).toBe(1);
      expect(invocations[0]).toHaveLength(2);
    });
  });

  test("dryRun: true returns candidates without writing files", async () => {
    await withTempVault(async (vaultRoot) => {
      const transcriptPath = join(vaultRoot, "transcript.md");
      await writeFile(transcriptPath, MARKDOWN_TRANSCRIPT, "utf-8");
      const { distiller } = stubDistiller([
        { kind: "claim", text: "OAuth2 needs PKCE for SPA clients.", sourceMessageIds: [] },
      ]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      const result = await handler(
        { transcriptPath: "transcript.md", dryRun: true },
        () => {},
        "req-8",
        "claude-code",
      );
      expect(result.proposalsCreated).toBe(0);
      const candidates = result.candidates as Candidate[];
      expect(candidates).toHaveLength(1);
      const proposalsDir = join(vaultRoot, "Notient", "proposals");
      const entries = await readdir(proposalsDir).catch(() => [] as string[]);
      expect(entries).toHaveLength(0);
    });
  });

  test("byKind tally aggregates correctly", async () => {
    await withTempVault(async (vaultRoot) => {
      const transcriptPath = join(vaultRoot, "transcript.md");
      await writeFile(transcriptPath, MARKDOWN_TRANSCRIPT, "utf-8");
      const { distiller } = stubDistiller([
        { kind: "claim", text: "A.", sourceMessageIds: [] },
        { kind: "claim", text: "B.", sourceMessageIds: [] },
        { kind: "decision", text: "C.", sourceMessageIds: [] },
        { kind: "note", text: "D.", sourceMessageIds: [] },
      ]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      const result = await handler(
        { transcriptPath: "transcript.md", dryRun: true },
        () => {},
        "req-9",
        "claude-code",
      );
      expect(result.byKind).toEqual({ claim: 2, decision: 1, note: 1 });
    });
  });

  test("non-transcript vault note: falls back to single synthetic user message and emits distill:fallback", async () => {
    await withTempVault(async (vaultRoot) => {
      const transcriptPath = join(vaultRoot, "01-introduction.md");
      const noteBody = [
        "# Introduction",
        "",
        "This vault note has no transcript markers. It is a plain markdown body.",
        "We expect the handler to fall back to a synthetic user message.",
      ].join("\n");
      await writeFile(transcriptPath, noteBody, "utf-8");
      const { distiller, invocations } = stubDistiller((messages) => [
        {
          kind: "note",
          text: "Plain vault note distilled.",
          sourceMessageIds: [messages[0]?.sourceMessageId ?? ""],
        },
      ]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      const emitted: string[] = [];
      const result = await handler(
        { transcriptPath: "01-introduction.md" },
        (line) => {
          emitted.push(line);
        },
        "req-fallback",
        "claude-code",
      );
      const candidates = result.candidates as Candidate[];
      expect(candidates.length).toBeGreaterThan(0);
      expect(typeof result.proposalsCreated).toBe("number");
      expect(result.proposalsCreated as number).toBeGreaterThan(0);
      // Distiller saw the synthetic user message, not an empty list.
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toHaveLength(1);
      expect(invocations[0][0].role).toBe("user");
      expect(invocations[0][0].content).toBe(noteBody);
      expect(invocations[0][0].sourceMessageId).toBe("vault-note:01-introduction.md");
      // A `distill:fallback` event was streamed before the result frame.
      const fallbackLine = emitted.find((line) => line.includes('"event":"distill:fallback"'));
      expect(fallbackLine).toBeDefined();
      const parsedEvent = JSON.parse(fallbackLine ?? "{}") as Record<string, unknown>;
      expect(parsedEvent.id).toBe("req-fallback");
      expect(parsedEvent.type).toBe("event");
      expect(parsedEvent.event).toBe("distill:fallback");
      expect(parsedEvent.reason).toBe("non-transcript");
      expect(parsedEvent.transcriptPath).toBe("01-introduction.md");
    });
  });

  test("non-transcript vault note with dryRun: true skips proposal write but still distills", async () => {
    await withTempVault(async (vaultRoot) => {
      const transcriptPath = join(vaultRoot, "plain.md");
      await writeFile(transcriptPath, "# Plain note\n\nNo markers here.\n", "utf-8");
      const { distiller, invocations } = stubDistiller([
        { kind: "note", text: "Synthetic distillation result.", sourceMessageIds: [] },
      ]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      const emitted: string[] = [];
      const result = await handler(
        { transcriptPath: "plain.md", dryRun: true },
        (line) => {
          emitted.push(line);
        },
        "req-fallback-dry",
        "claude-code",
      );
      expect(result.proposalsCreated).toBe(0);
      const candidates = result.candidates as Candidate[];
      expect(candidates).toHaveLength(1);
      expect(invocations[0]).toHaveLength(1);
      expect(emitted.some((line) => line.includes('"event":"distill:fallback"'))).toBe(true);
    });
  });

  test("frontmatter includes kind, sourceTranscript, sourceMessageIds, createdAt", async () => {
    await withTempVault(async (vaultRoot) => {
      const transcriptPath = join(vaultRoot, "transcript.md");
      await writeFile(transcriptPath, MARKDOWN_TRANSCRIPT, "utf-8");
      const { distiller } = stubDistiller([
        {
          kind: "decision",
          text: "Adopt PostgreSQL.",
          sourceMessageIds: ["msg-0-aaaaa", "msg-1-bbbbb"],
        },
      ]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      const result = await handler(
        { transcriptPath: "transcript.md" },
        () => {},
        "req-10",
        "claude-code",
      );
      expect(result.proposalsCreated).toBe(1);
      const proposalsDir = join(vaultRoot, "Notient", "proposals");
      const entries = await readdir(proposalsDir);
      const body = await readFile(join(proposalsDir, entries[0]), "utf-8");
      expect(body).toMatch(/^---\n/);
      expect(body).toContain("kind: decision");
      expect(body).toContain("sourceTranscript:");
      expect(body).toContain("clientIdentity: claude-code");
      expect(body).toContain("sourceMessageIds:");
      expect(body).toContain("createdAt:");
      expect(body).toContain("# Adopt PostgreSQL");
    });
  });
});
