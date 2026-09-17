import { describe, expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsVault } from "../../../../src/adapters/fsVault";
import { ApprovalGate } from "../../../../src/core/chat/approvalGate";
import { serializeConversation } from "../../../../src/core/chat/conversationParser";
import type { NotesHistoryRecord } from "../../../../src/core/chat/tools/notes";
import type {
  Candidate,
  TranscriptDistiller,
} from "../../../../src/core/distill/transcriptDistiller";
import type { TranscriptMessage } from "../../../../src/core/distill/transcriptParser";
import type {
  SessionGrant,
  SessionGrantClaimQuery,
} from "../../../../src/core/services/sessionGrants";
import { vaultStateDir } from "../../../../src/core/vault/identity";
import {
  AGENT_DISTILL_MAX_TRANSCRIPT_BYTES,
  type AgentDistillHandler,
  makeAgentDistillHandler as makeProductionAgentDistillHandler,
} from "../../../../src/daemon/handlers/agentDistill";
import type { RpcRequestContext } from "../../../../src/daemon/rpc";
import { agentPrincipal, humanPrincipal, rpcRequest } from "../../../rpcRequest";

function agentRequest(
  params: Record<string, unknown>,
  overrides: Partial<Omit<RpcRequestContext, "params" | "principal">> = {},
): RpcRequestContext {
  return rpcRequest(params, { principal: agentPrincipal(), ...overrides });
}

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

function historyRecordId(value: number): string {
  return `history:u"00000000-0000-4000-8000-${value.toString().padStart(12, "0")}"`;
}

interface TestHandlerOptions {
  vaultRoot: string;
  distiller: TranscriptDistiller;
  vault?: FsVault;
}

/** Existing behavior tests run live through the same auto-approved path. */
function makeAgentDistillHandler(options: TestHandlerOptions): AgentDistillHandler {
  const gate = new ApprovalGate({
    recordHistoryAutoApprove: async () => {},
    perToolPolicy: () => ({}),
    sessionGrants: {
      claim: async () => null,
    },
  });
  let historySequence = 0;
  const vault = options.vault ?? new FsVault(options.vaultRoot);
  return makeProductionAgentDistillHandler({
    distiller: options.distiller,
    vault,
    approvalGate: gate,
    approvalMode: () => "yolo",
    applyWrite: async (record) => {
      const applied = await vault.createIfAbsent(record.target, record.after);
      return applied
        ? { applied: true, historyId: historyRecordId(++historySequence) }
        : { applied: false, reason: "conflict" };
    },
    hash: async (body) => `sha:${body.length}`,
  });
}

interface PausedParentAnchor {
  reached: Promise<void>;
  release: () => void;
  restore: () => void;
}

function pauseNextParentAnchor(vault: FsVault): PausedParentAnchor {
  const target = vault as unknown as {
    openParent: (path: string, create: boolean) => Promise<unknown>;
  };
  const original = target.openParent.bind(vault);
  let announce = (): void => {};
  let resume = (): void => {};
  const reached = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const anchorSpy = spyOn(target, "openParent").mockImplementation(async (path, create) => {
    const anchored = await original(path, create);
    announce();
    await gate;
    return anchored;
  });
  return {
    reached,
    release: resume,
    restore: () => anchorSpy.mockRestore(),
  };
}

interface ControlledHandlerOptions {
  approvalMode?: "safe" | "yolo";
  grant?: SessionGrant | null;
  gate?: ApprovalGate;
  now?: number;
  callId?: string;
  initialFiles?: Record<string, string>;
  beforeCreate?: (path: string, files: Map<string, string>) => void;
}

interface ControlledHandlerHarness {
  handler: AgentDistillHandler;
  gate: ApprovalGate;
  files: Map<string, string>;
  writes: Array<{ path: string; body: string }>;
  history: NotesHistoryRecord[];
  existsCalls: string[];
  grantQueries: SessionGrantClaimQuery[];
  claimedGrantIds: string[];
  autoApprovals: string[];
}

function makeControlledHandler(
  vaultRoot: string,
  distiller: TranscriptDistiller,
  options: ControlledHandlerOptions = {},
): ControlledHandlerHarness {
  const transcriptVault = new FsVault(vaultRoot);
  const files = new Map(Object.entries(options.initialFiles ?? {}));
  const writes: Array<{ path: string; body: string }> = [];
  const history: NotesHistoryRecord[] = [];
  const existsCalls: string[] = [];
  const grantQueries: SessionGrantClaimQuery[] = [];
  const claimedGrantIds: string[] = [];
  const autoApprovals: string[] = [];
  const gate =
    options.gate ??
    new ApprovalGate({
      recordHistoryAutoApprove: async (call) => {
        autoApprovals.push(call.name);
      },
      perToolPolicy: () => ({}),
      sessionGrants: {
        claim: async (query) => {
          grantQueries.push(query);
          const grant = options.grant ?? null;
          if (grant === null) return null;
          if (grant.client !== query.client) return null;
          if (!grant.allowedTools.includes("*") && !grant.allowedTools.includes(query.tool))
            return null;
          if (!grant.allowedFolders.some((folder) => query.folder.startsWith(folder))) return null;
          claimedGrantIds.push(grant.id);
          return grant;
        },
      },
      now: () => options.now ?? 1_788_000_000_000,
    });

  const handler = makeProductionAgentDistillHandler({
    distiller,
    vault: {
      exists: async (path) => {
        existsCalls.push(path);
        return files.has(path);
      },
      readBounded: (path, maxBytes) => transcriptVault.readBounded(path, maxBytes),
    },
    approvalGate: gate,
    approvalMode: () => options.approvalMode ?? "safe",
    applyWrite: async (record) => {
      options.beforeCreate?.(record.target, files);
      if (files.has(record.target)) return { applied: false, reason: "conflict" };
      writes.push({ path: record.target, body: record.after });
      files.set(record.target, record.after);
      history.push(record);
      return { applied: true, historyId: historyRecordId(history.length) };
    },
    hash: async (body) => `sha:${body.length}`,
    now: () => options.now ?? 1_788_000_000_000,
    generateCallId: () => options.callId ?? "batch1",
  });

  return {
    handler,
    gate,
    files,
    writes,
    history,
    existsCalls,
    grantQueries,
    claimedGrantIds,
    autoApprovals,
  };
}

function proposalPath(kind: Candidate["kind"], sequence: number): string {
  return `Notient/proposals/distilled-1788000000000-${kind}-${sequence}-batch1.md`;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for distill invocation to settle");
}

describe("agent.distill handler", () => {
  test("conversation transcripts are exact-owner for agents, human-readable, and authenticated", async () => {
    await withTempVault(async (vaultRoot) => {
      const conversationPath = join(vaultRoot, "Notient", "conversations", "owned.md");
      await mkdir(join(vaultRoot, "Notient", "conversations"), { recursive: true });
      await writeFile(
        conversationPath,
        serializeConversation({
          id: "owned-conversation",
          notePath: "Notient/conversations/owned.md",
          model: "fixture",
          pinnedContext: [],
          approvalMode: "safe",
          topic: "Owned",
          summary: "",
          clientIdentity: "agent-a",
          messageCount: 1,
          createdAt: 1_000,
          updatedAt: 1_000,
          messages: [{ id: "m1", role: "user", content: "Private turn", createdAt: 1_000 }],
        }),
        "utf8",
      );
      const { distiller, invocations } = stubDistiller([]);
      const h = makeControlledHandler(vaultRoot, distiller, { approvalMode: "yolo" });

      await h.handler(
        rpcRequest(
          { transcriptPath: "Notient/conversations/owned.md", dryRun: true },
          { principal: agentPrincipal("agent-a") },
        ),
      );
      expect(invocations).toHaveLength(1);

      await expect(
        h.handler(
          rpcRequest(
            { transcriptPath: "Notient/conversations/owned.md", dryRun: true },
            { principal: agentPrincipal("agent-b") },
          ),
        ),
      ).rejects.toThrow("only its own canonical conversation");
      expect(invocations).toHaveLength(1);

      await h.handler(
        rpcRequest(
          { transcriptPath: "Notient/conversations/owned.md", dryRun: true },
          { principal: humanPrincipal("operator") },
        ),
      );
      expect(invocations).toHaveLength(2);

      await writeFile(conversationPath, "---\nnotient: conversation\n---\nforged\n", "utf8");
      await expect(
        h.handler(
          rpcRequest(
            { transcriptPath: "Notient/conversations/owned.md", dryRun: true },
            { principal: agentPrincipal("agent-a") },
          ),
        ),
      ).rejects.toThrow("canonical conversation transcript is malformed");
      await expect(
        h.handler(
          rpcRequest(
            { transcriptPath: "Notient/conversations/owned.md", dryRun: true },
            { principal: humanPrincipal("operator") },
          ),
        ),
      ).rejects.toThrow("canonical conversation transcript is malformed");
      expect(invocations).toHaveLength(2);
    });
  });

  test("rejects '..' traversal in transcriptPath", async () => {
    await withTempVault(async (vaultRoot) => {
      const { distiller, invocations } = stubDistiller([]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      let thrown: unknown = null;
      try {
        await handler(agentRequest({ transcriptPath: "../etc/passwd" }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("'..'");
      expect(invocations).toEqual([]);
    });
  });

  test("rejects '..' traversal in absolute path", async () => {
    await withTempVault(async (vaultRoot) => {
      const { distiller, invocations } = stubDistiller([]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      let thrown: unknown = null;
      try {
        await handler(agentRequest({ transcriptPath: "/var/data/../../etc/passwd" }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("'..'");
      expect(invocations).toEqual([]);
    });
  });

  test("file-not-found names the path in the error", async () => {
    await withTempVault(async (vaultRoot) => {
      const { distiller, invocations } = stubDistiller([]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      let thrown: unknown = null;
      try {
        await handler(agentRequest({ transcriptPath: "missing.md" }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("missing.md");
      expect(invocations).toEqual([]);
    });
  });

  test("rejects hidden, non-Markdown, and Notient-owned artifact aliases before distilling", async () => {
    await withTempVault(async (vaultRoot) => {
      const paths = [
        ".hidden.md",
        "private/.nested.md",
        "session.json",
        "Notient/proposals/forged.md",
        "Notient/conversations/nested/forged.md",
        "notient/conversations/case-alias.md",
        "Notient/Conversations/case-alias.md",
      ];
      await mkdir(join(vaultRoot, "private"), { recursive: true });
      await mkdir(join(vaultRoot, "Notient", "proposals"), { recursive: true });
      await mkdir(join(vaultRoot, "Notient", "conversations", "nested"), { recursive: true });
      await mkdir(join(vaultRoot, "notient", "conversations"), { recursive: true });
      await mkdir(join(vaultRoot, "Notient", "Conversations"), { recursive: true });
      for (const path of paths) {
        await writeFile(join(vaultRoot, ...path.split("/")), MARKDOWN_TRANSCRIPT, "utf8");
      }
      const { distiller, invocations } = stubDistiller([]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });

      for (const transcriptPath of paths) {
        await expect(handler(agentRequest({ transcriptPath, dryRun: true }))).rejects.toThrow(
          "canonical public Markdown or an exact conversation",
        );
      }
      expect(invocations).toEqual([]);
    });
  });

  test("rejects directories and FIFOs before distilling", async () => {
    await withTempVault(async (vaultRoot) => {
      await mkdir(join(vaultRoot, "directory.md"));
      const { distiller, invocations } = stubDistiller([]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });

      await expect(
        handler(agentRequest({ transcriptPath: "directory.md", dryRun: true })),
      ).rejects.toThrow("regular file");
      expect(invocations).toEqual([]);

      if (process.platform !== "win32") {
        const fifoPath = join(vaultRoot, "stream.md");
        const mkfifo = Bun.spawn(["mkfifo", fifoPath], { stdout: "ignore", stderr: "pipe" });
        expect(await mkfifo.exited).toBe(0);
        await expect(
          handler(agentRequest({ transcriptPath: "stream.md", dryRun: true })),
        ).rejects.toThrow("regular file");
        expect(invocations).toEqual([]);
      }
    });
  });

  test("rejects transcripts above the one-megabyte read ceiling before distilling", async () => {
    await withTempVault(async (vaultRoot) => {
      await writeFile(
        join(vaultRoot, "oversized.md"),
        Buffer.alloc(AGENT_DISTILL_MAX_TRANSCRIPT_BYTES + 1, 0x61),
      );
      const { distiller, invocations } = stubDistiller([]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });

      await expect(
        handler(agentRequest({ transcriptPath: "oversized.md", dryRun: true })),
      ).rejects.toThrow(`${AGENT_DISTILL_MAX_TRANSCRIPT_BYTES} byte limit`);
      expect(invocations).toEqual([]);
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
      const result = await handler(agentRequest({ transcriptPath: "transcript.md" }));
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

  test("absolute paths are rejected instead of becoming a second spelling", async () => {
    await withTempVault(async (vaultRoot) => {
      const externalDir = await mkdtemp(join(tmpdir(), "notient-distill-ext-"));
      try {
        const externalPath = join(externalDir, "session.md");
        await writeFile(externalPath, MARKDOWN_TRANSCRIPT, "utf-8");
        const { distiller, invocations } = stubDistiller([
          { kind: "note", text: "External transcript note.", sourceMessageIds: [] },
        ]);
        const handler = makeAgentDistillHandler({ vaultRoot, distiller });
        await expect(handler(agentRequest({ transcriptPath: externalPath }))).rejects.toThrow(
          "canonical public Markdown",
        );
        expect(invocations).toEqual([]);
      } finally {
        await rm(externalDir, { recursive: true, force: true });
      }
    });
  });

  test("an absolute path inside the vault is still noncanonical", async () => {
    await withTempVault(async (vaultRoot) => {
      const transcriptDir = await mkdtemp(join(vaultRoot, "transcripts-"));
      const transcriptPath = join(transcriptDir, "session.md");
      await writeFile(transcriptPath, MARKDOWN_TRANSCRIPT, "utf-8");
      const { distiller, invocations } = stubDistiller([
        { kind: "note", text: "Vault transcript note.", sourceMessageIds: [] },
      ]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      await expect(handler(agentRequest({ transcriptPath }))).rejects.toThrow(
        "canonical public Markdown",
      );
      expect(invocations).toEqual([]);
    });
  });

  test("the per-vault state dir is not reachable by default", async () => {
    await withTempVault(async (vaultRoot) => {
      const { distiller, invocations } = stubDistiller([
        { kind: "note", text: "Should never be reached.", sourceMessageIds: [] },
      ]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      const tokenPath = join(vaultStateDir(vaultRoot), "admin.token");
      await expect(handler(agentRequest({ transcriptPath: tokenPath }))).rejects.toThrow(
        "canonical public Markdown",
      );
      expect(invocations).toEqual([]);
    });
  });

  test.each([
    [{ transcriptPath: "transcript.md", legacy: true }, "accepts only"],
    [{ transcriptPath: " transcript.md" }, "exact non-empty"],
    [{ transcriptPath: "transcript.md", dryRun: "true" }, "dryRun must"],
    [{ transcriptPath: "transcript.md", format: "md" }, "format must"],
  ])("rejects noncanonical request shape %#", async (params, message) => {
    await withTempVault(async (vaultRoot) => {
      await writeFile(join(vaultRoot, "transcript.md"), MARKDOWN_TRANSCRIPT, "utf8");
      const { distiller, invocations } = stubDistiller([]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      await expect(handler(agentRequest(params))).rejects.toThrow(message);
      expect(invocations).toEqual([]);
    });
  });

  test("a symlink inside the vault pointing outside it is rejected", async () => {
    await withTempVault(async (vaultRoot) => {
      const externalDir = await mkdtemp(join(tmpdir(), "notient-distill-link-"));
      try {
        const externalPath = join(externalDir, "outside.md");
        await writeFile(externalPath, MARKDOWN_TRANSCRIPT, "utf-8");
        await symlink(externalPath, join(vaultRoot, "linked.md"));
        const { distiller, invocations } = stubDistiller([
          { kind: "note", text: "Should never be reached.", sourceMessageIds: [] },
        ]);
        const handler = makeAgentDistillHandler({ vaultRoot, distiller });
        await expect(handler(agentRequest({ transcriptPath: "linked.md" }))).rejects.toThrow(
          /symbolic link|readable regular file/,
        );
        expect(invocations).toEqual([]);
      } finally {
        await rm(externalDir, { recursive: true, force: true });
      }
    });
  });

  test("rejects final and ancestor symlinks even when their targets remain inside the vault", async () => {
    await withTempVault(async (vaultRoot) => {
      await mkdir(join(vaultRoot, "real"));
      await writeFile(join(vaultRoot, "real.md"), MARKDOWN_TRANSCRIPT, "utf8");
      await writeFile(join(vaultRoot, "real", "session.md"), MARKDOWN_TRANSCRIPT, "utf8");
      await symlink(join(vaultRoot, "real.md"), join(vaultRoot, "linked-file.md"));
      await symlink(join(vaultRoot, "real"), join(vaultRoot, "linked-directory"));
      const { distiller, invocations } = stubDistiller([]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });

      await expect(
        handler(agentRequest({ transcriptPath: "linked-file.md", dryRun: true })),
      ).rejects.toThrow(/symbolic link|readable regular file/);
      await expect(
        handler(agentRequest({ transcriptPath: "linked-directory/session.md", dryRun: true })),
      ).rejects.toThrow(/symbolic link|readable regular file/);
      expect(invocations).toEqual([]);
    });
  });

  test("never distills an outside transcript after an anchored parent is swapped", async () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    await withTempVault(async (vaultRoot) => {
      const outsideDir = await mkdtemp(join(tmpdir(), "notient-distill-race-out-"));
      try {
        await mkdir(join(vaultRoot, "inbox"));
        await writeFile(join(vaultRoot, "inbox", "session.md"), "", "utf8");
        await writeFile(join(outsideDir, "session.md"), MARKDOWN_TRANSCRIPT, "utf8");
        const { distiller, invocations } = stubDistiller([]);
        const vault = new FsVault(vaultRoot);
        const paused = pauseNextParentAnchor(vault);
        const handler = makeAgentDistillHandler({ vaultRoot, distiller, vault });
        const distillation = handler(
          agentRequest({ transcriptPath: "inbox/session.md", dryRun: true }),
        );
        try {
          await paused.reached;
          await rename(join(vaultRoot, "inbox"), join(vaultRoot, "anchored-inbox"));
          await symlink(outsideDir, join(vaultRoot, "inbox"));
          paused.release();

          await expect(distillation).rejects.toThrow("contains no markdown messages");
          expect(invocations).toEqual([]);
        } finally {
          paused.release();
          paused.restore();
        }
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  test("JSONL transcript content in an ordinary Markdown file", async () => {
    await withTempVault(async (vaultRoot) => {
      const transcriptPath = join(vaultRoot, "session-jsonl.md");
      const content = [
        JSON.stringify({ type: "user", message: { content: "Refactor auth.ts" } }),
        JSON.stringify({ type: "assistant", message: { content: "Will read the file first." } }),
      ].join("\n");
      await writeFile(transcriptPath, content, "utf-8");
      const { distiller, invocations } = stubDistiller([
        { kind: "claim", text: "Auth file refactor pending.", sourceMessageIds: [] },
      ]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      const result = await handler(agentRequest({ transcriptPath: "session-jsonl.md" }));
      expect(result.proposalsCreated).toBe(1);
      expect(invocations[0]).toHaveLength(2);
      expect(invocations[0][0].role).toBe("user");
    });
  });

  test("JSON transcript content in an ordinary Markdown file", async () => {
    await withTempVault(async (vaultRoot) => {
      const transcriptPath = join(vaultRoot, "exchange-json.md");
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
      const result = await handler(agentRequest({ transcriptPath: "exchange-json.md" }));
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
      const result = await handler(agentRequest({ transcriptPath: "transcript.md", dryRun: true }));
      expect(result.proposalsCreated).toBe(0);
      const candidates = result.candidates as Candidate[];
      expect(candidates).toHaveLength(1);
      const proposalsDir = join(vaultRoot, "Notient", "proposals");
      const entries = await readdir(proposalsDir).catch(() => [] as string[]);
      expect(entries).toHaveLength(0);
    });
  });

  test("dry run never consults approval policy or touches the vault adapter", async () => {
    await withTempVault(async (vaultRoot) => {
      await writeFile(join(vaultRoot, "transcript.md"), MARKDOWN_TRANSCRIPT, "utf-8");
      const { distiller } = stubDistiller([
        { kind: "claim", text: "PKCE protects public clients.", sourceMessageIds: ["msg-1"] },
      ]);
      const h = makeControlledHandler(vaultRoot, distiller);

      const result = await h.handler(
        agentRequest(
          { transcriptPath: "transcript.md", dryRun: true },
          { requestId: "req-dry-authority" },
        ),
      );

      expect(result).toMatchObject({
        dryRun: true,
        applied: false,
        pending: false,
        denied: false,
        proposalsCreated: 0,
        proposalPaths: [proposalPath("claim", 1)],
      });
      expect(h.grantQueries).toHaveLength(0);
      expect(h.existsCalls).toHaveLength(0);
      expect(h.writes).toHaveLength(0);
      expect(h.history).toHaveLength(0);
      expect(h.gate.hasPending()).toBe(false);
    });
  });

  test("safe live batch parks one agent.distill approval before any write", async () => {
    await withTempVault(async (vaultRoot) => {
      await writeFile(join(vaultRoot, "transcript.md"), MARKDOWN_TRANSCRIPT, "utf-8");
      const { distiller } = stubDistiller([
        { kind: "decision", text: "Use OAuth2 with PKCE.", sourceMessageIds: ["msg-1"] },
        { kind: "question", text: "How should tokens rotate?", sourceMessageIds: ["msg-2"] },
      ]);
      const h = makeControlledHandler(vaultRoot, distiller);

      const result = await h.handler(
        agentRequest({ transcriptPath: "transcript.md" }, { requestId: "req-pending" }),
      );

      expect(result).toMatchObject({
        applied: false,
        pending: true,
        denied: false,
        proposalsCreated: 0,
        callId: "batch1",
        proposalPaths: [proposalPath("decision", 1), proposalPath("question", 2)],
      });
      expect(h.writes).toHaveLength(0);
      expect(h.history).toHaveLength(0);
      expect(h.gate.pendingCount()).toBe(1);
      expect(h.gate.listPending()[0]).toMatchObject({
        callId: "batch1",
        toolName: "agent.distill",
        path: proposalPath("decision", 1),
        requestedBy: "claude-code",
      });
      expect(String(result.preview)).toContain(proposalPath("decision", 1));
      expect(String(result.preview)).toContain("Use OAuth2 with PKCE.");
    });
  });

  test("approving a parked batch writes exact approved bytes and guarded create history", async () => {
    await withTempVault(async (vaultRoot) => {
      await writeFile(join(vaultRoot, "transcript.md"), MARKDOWN_TRANSCRIPT, "utf-8");
      const { distiller } = stubDistiller([
        { kind: "decision", text: "Use OAuth2 with PKCE.", sourceMessageIds: ["msg-1"] },
        { kind: "question", text: "How should tokens rotate?", sourceMessageIds: ["msg-2"] },
      ]);
      const h = makeControlledHandler(vaultRoot, distiller);
      const pending = await h.handler(
        agentRequest({ transcriptPath: "transcript.md" }, { requestId: "req-approve" }),
      );

      expect(
        h.gate.resolve(
          String(pending.callId),
          { approved: true },
          { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
        ),
      ).toBe(true);
      await waitFor(() => h.history.length === 2);

      expect(h.writes.map((write) => write.path)).toEqual([
        proposalPath("decision", 1),
        proposalPath("question", 2),
      ]);
      expect(h.history).toHaveLength(2);
      for (let index = 0; index < h.writes.length; index++) {
        const write = h.writes[index];
        const history = h.history[index];
        expect(history).toEqual({
          kind: "notes.create",
          target: write.path,
          before: null,
          after: write.body,
          clientIdentity: "claude-code",
          authorize: expect.any(Function),
          toolApproval: {
            clientIdentity: "claude-code",
            tool: "agent.distill",
            paths: h.writes.map((entry) => entry.path),
            edgeId: null,
            permission: {
              kind: "human",
              operator: { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
            },
          },
        });
        expect(h.files.get(write.path)).toBe(write.body);
      }
    });
  });

  test("rejecting a parked batch leaves every proposal and history row absent", async () => {
    await withTempVault(async (vaultRoot) => {
      await writeFile(join(vaultRoot, "transcript.md"), MARKDOWN_TRANSCRIPT, "utf-8");
      const { distiller } = stubDistiller([
        { kind: "note", text: "A rejected proposal.", sourceMessageIds: [] },
      ]);
      const h = makeControlledHandler(vaultRoot, distiller);
      const pending = await h.handler(
        agentRequest({ transcriptPath: "transcript.md" }, { requestId: "req-reject" }),
      );

      expect(
        h.gate.resolve(String(pending.callId), { approved: false, reason: "operator rejected" }),
      ).toBe(true);
      await waitFor(() => !h.gate.hasPending());
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(h.writes).toHaveLength(0);
      expect(h.history).toHaveLength(0);
      expect(h.files.has(proposalPath("note", 1))).toBe(false);
    });
  });

  test("an immediate rejection is an explicit denied, not-applied result", async () => {
    await withTempVault(async (vaultRoot) => {
      await writeFile(join(vaultRoot, "transcript.md"), MARKDOWN_TRANSCRIPT, "utf-8");
      const { distiller } = stubDistiller([
        { kind: "note", text: "A denied proposal.", sourceMessageIds: [] },
      ]);
      const gate = new ApprovalGate({
        recordHistoryAutoApprove: async () => {},
        perToolPolicy: () => ({}),
        sessionGrants: { claim: async () => null },
      });
      gate.request = async () => ({ approved: false, reason: "operator rejected" });
      const h = makeControlledHandler(vaultRoot, distiller, { gate });

      const result = await h.handler(
        agentRequest({ transcriptPath: "transcript.md" }, { requestId: "req-denied" }),
      );

      expect(result).toMatchObject({
        applied: false,
        pending: false,
        denied: true,
        proposalsCreated: 0,
        writes: [],
        reason: "operator rejected",
      });
      expect(h.writes).toHaveLength(0);
      expect(h.history).toHaveLength(0);
    });
  });

  test("a scoped proposal-folder grant applies inline once and returns exact receipts", async () => {
    await withTempVault(async (vaultRoot) => {
      await writeFile(join(vaultRoot, "transcript.md"), MARKDOWN_TRANSCRIPT, "utf-8");
      const { distiller } = stubDistiller([
        { kind: "claim", text: "PKCE protects public clients.", sourceMessageIds: ["msg-1"] },
        { kind: "note", text: "Rotate refresh tokens.", sourceMessageIds: ["msg-2"] },
      ]);
      const grant: SessionGrant = {
        id: 'agent_session:u"00000000-0000-4000-8000-000000000041"',
        client: "claude-code",
        grantedAt: 0,
        expiresAt: Number.MAX_SAFE_INTEGER,
        allowedFolders: ["Notient/proposals/"],
        allowedTools: ["agent.distill"],
        maxWrites: 3,
        usedWrites: 2,
        revokedAt: null,
      };
      const h = makeControlledHandler(vaultRoot, distiller, { grant });

      const result = await h.handler(
        agentRequest({ transcriptPath: "transcript.md" }, { requestId: "req-granted" }),
      );

      const expectedPaths = [proposalPath("claim", 1), proposalPath("note", 2)];
      expect(result).toMatchObject({
        applied: true,
        pending: false,
        denied: false,
        proposalsCreated: 2,
        proposalPaths: expectedPaths,
      });
      expect(h.grantQueries).toEqual([
        {
          client: "claude-code",
          tool: "agent.distill",
          folder: "Notient/proposals/",
          now: 1_788_000_000_000,
          writeCount: 2,
        },
      ]);
      expect(h.claimedGrantIds).toEqual(['agent_session:u"00000000-0000-4000-8000-000000000041"']);
      expect(h.autoApprovals).toHaveLength(0);
      expect(h.history).toHaveLength(2);
      expect(result.writes).toEqual(
        expectedPaths.map((path, index) => {
          const body = h.files.get(path) ?? "";
          return { path, sha: `sha:${body.length}`, historyId: historyRecordId(index + 1) };
        }),
      );
    });
  });

  test("configured auto policy applies inline through the same batch path", async () => {
    await withTempVault(async (vaultRoot) => {
      await writeFile(join(vaultRoot, "transcript.md"), MARKDOWN_TRANSCRIPT, "utf-8");
      const { distiller } = stubDistiller([
        { kind: "note", text: "Auto-approved proposal.", sourceMessageIds: [] },
      ]);
      const h = makeControlledHandler(vaultRoot, distiller, { approvalMode: "yolo" });

      const result = await h.handler(
        agentRequest({ transcriptPath: "transcript.md" }, { requestId: "req-auto" }),
      );

      expect(result).toMatchObject({ applied: true, pending: false, proposalsCreated: 1 });
      expect(h.autoApprovals).toEqual(["agent.distill"]);
      expect(h.history).toHaveLength(1);
      expect(h.gate.hasPending()).toBe(false);
    });
  });

  test("a collision created while approval is pending is never overwritten", async () => {
    await withTempVault(async (vaultRoot) => {
      await writeFile(join(vaultRoot, "transcript.md"), MARKDOWN_TRANSCRIPT, "utf-8");
      const { distiller } = stubDistiller([
        { kind: "note", text: "Would collide.", sourceMessageIds: [] },
      ]);
      const h = makeControlledHandler(vaultRoot, distiller);
      const pending = await h.handler(
        agentRequest({ transcriptPath: "transcript.md" }, { requestId: "req-collision" }),
      );
      const path = proposalPath("note", 1);
      h.files.set(path, "human-authored bytes\n");

      expect(
        h.gate.resolve(
          String(pending.callId),
          { approved: true },
          { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
        ),
      ).toBe(true);
      await waitFor(() => !h.gate.hasPending());
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(h.files.get(path)).toBe("human-authored bytes\n");
      expect(h.writes).toHaveLength(0);
      expect(h.history).toHaveLength(0);
    });
  });

  test("a collision at the exclusive create point is preserved without history", async () => {
    await withTempVault(async (vaultRoot) => {
      await writeFile(join(vaultRoot, "transcript.md"), MARKDOWN_TRANSCRIPT, "utf-8");
      const { distiller } = stubDistiller([
        { kind: "note", text: "Would collide at commit.", sourceMessageIds: [] },
      ]);
      const h = makeControlledHandler(vaultRoot, distiller, {
        approvalMode: "yolo",
        beforeCreate: (path, files) => files.set(path, "human-at-exclusive-create\n"),
      });

      const result = await h.handler(
        agentRequest({ transcriptPath: "transcript.md" }, { requestId: "req-exact-collision" }),
      );
      const path = proposalPath("note", 1);

      expect(result).toMatchObject({ applied: false, proposalsCreated: 0 });
      expect(h.files.get(path)).toBe("human-at-exclusive-create\n");
      expect(h.writes).toEqual([]);
      expect(h.history).toEqual([]);
    });
  });

  test("a later batch collision reports the exact durable prefix instead of false rollback", async () => {
    await withTempVault(async (vaultRoot) => {
      await writeFile(join(vaultRoot, "transcript.md"), MARKDOWN_TRANSCRIPT, "utf-8");
      const { distiller } = stubDistiller([
        { kind: "claim", text: "Committed first.", sourceMessageIds: [] },
        { kind: "question", text: "Collides second?", sourceMessageIds: [] },
      ]);
      const secondPath = proposalPath("question", 2);
      const h = makeControlledHandler(vaultRoot, distiller, {
        approvalMode: "yolo",
        beforeCreate: (path, files) => {
          if (path === secondPath) files.set(path, "human second proposal\n");
        },
      });

      const result = await h.handler(
        agentRequest({ transcriptPath: "transcript.md" }, { requestId: "req-partial" }),
      );

      expect(result).toMatchObject({
        applied: false,
        partial: true,
        proposalsCreated: 1,
      });
      expect(result.writes).toHaveLength(1);
      expect(h.history).toHaveLength(1);
      expect(h.files.get(proposalPath("claim", 1))).toContain("Committed first.");
      expect(h.files.get(secondPath)).toBe("human second proposal\n");
    });
  });

  test("proposal mutation code has no direct filesystem write or mkdir call", async () => {
    const source = await readFile(
      join(process.cwd(), "src", "daemon", "handlers", "agentDistill.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/\bwriteFile\s*\(/u);
    expect(source).not.toMatch(/\bmkdir\s*\(/u);
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
      const result = await handler(agentRequest({ transcriptPath: "transcript.md", dryRun: true }));
      expect(result.byKind).toEqual({ claim: 2, decision: 1, note: 1 });
    });
  });

  test("plain markdown is rejected instead of being relabeled as a transcript", async () => {
    await withTempVault(async (vaultRoot) => {
      const transcriptPath = join(vaultRoot, "01-introduction.md");
      const noteBody = [
        "# Introduction",
        "",
        "This vault note has no transcript markers. It is a plain markdown body.",
        "It must not be relabeled as a synthetic user message.",
      ].join("\n");
      await writeFile(transcriptPath, noteBody, "utf-8");
      const { distiller, invocations } = stubDistiller([]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      const emitted: string[] = [];
      await expect(
        handler(
          agentRequest(
            { transcriptPath: "01-introduction.md" },
            { emit: (line) => emitted.push(line), requestId: "req-plain-note" },
          ),
        ),
      ).rejects.toThrow(/contains no markdown messages/);
      expect(invocations).toEqual([]);
      expect(emitted).toEqual([]);
      expect(await readdir(join(vaultRoot, "Notient")).catch(() => [])).toEqual([]);
    });
  });

  test("dryRun does not bypass transcript validation", async () => {
    await withTempVault(async (vaultRoot) => {
      const transcriptPath = join(vaultRoot, "plain.md");
      await writeFile(transcriptPath, "# Plain note\n\nNo markers here.\n", "utf-8");
      const { distiller, invocations } = stubDistiller([]);
      const handler = makeAgentDistillHandler({ vaultRoot, distiller });
      await expect(
        handler(agentRequest({ transcriptPath: "plain.md", dryRun: true })),
      ).rejects.toThrow(/contains no markdown messages/);
      expect(invocations).toEqual([]);
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
      const result = await handler(agentRequest({ transcriptPath: "transcript.md" }));
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
