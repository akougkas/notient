import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { type ClientHandle, connectClient } from "../client";
import type { Emitter } from "../output";

export interface ChatCommandOptions {
  vaultPath: string;
  prompt: string;
  conversationId?: string;
  approve: "auto" | "ask";
  emitter: Emitter;
}

export async function runChatSingleShot(options: ChatCommandOptions): Promise<void> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
  });

  const conversationId = options.conversationId ?? (await ensureConversation(client, options));
  if (conversationId === null) {
    await client.close();
    return;
  }

  const approvalClient =
    options.approve === "ask"
      ? await connectClient({ socketPath, vaultPath: options.vaultPath })
      : null;

  try {
    await streamChatSend(client, approvalClient, conversationId, options);
  } finally {
    if (approvalClient !== null) await approvalClient.close();
    await client.close();
  }
}

async function ensureConversation(
  client: ClientHandle,
  options: ChatCommandOptions,
): Promise<string | null> {
  for await (const frame of client.call("chat.start", { topic: "single-shot" })) {
    if (frame.type === "result") {
      const started = frame as unknown as { conversation?: { id?: string } };
      const id = started.conversation?.id;
      if (typeof id !== "string") {
        throw new Error("chat.start result missing conversation id");
      }
      return id;
    }
    if (frame.type === "error") {
      options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
      return null;
    }
  }
  throw new Error("chat.start returned no result frame");
}

async function streamChatSend(
  client: ClientHandle,
  approvalClient: ClientHandle | null,
  conversationId: string,
  options: ChatCommandOptions,
): Promise<void> {
  for await (const frame of client.call("chat.send", {
    conversationId,
    userMessage: options.prompt,
  })) {
    options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
    if (isApprovalPending(frame)) {
      await handleApproval(frame as unknown as Record<string, unknown>, approvalClient, options);
    }
    if (frame.type === "result" || frame.type === "error") break;
  }
}

function isApprovalPending(frame: { type: string; event?: string }): boolean {
  return frame.type === "event" && frame.event === "loop:approval_pending";
}

export async function runChatTui(options: {
  vaultPath: string;
  emitter: Emitter;
}): Promise<void> {
  // Dynamic import resolved at runtime once the TUI runtime ships in
  // Task 16. The string-literal-as-template-tag form prevents tsc from
  // statically resolving the module ahead of time.
  const path = "../tui/runtime";
  type TuiModule = {
    startTuiRuntime: (opts: {
      vaultPath: string;
      emitter: Emitter;
    }) => Promise<void>;
  };
  const tui = (await import(path)) as TuiModule;
  await tui.startTuiRuntime({
    vaultPath: options.vaultPath,
    emitter: options.emitter,
  });
}

async function handleApproval(
  frame: Record<string, unknown>,
  approvalClient: ClientHandle | null,
  options: ChatCommandOptions,
): Promise<void> {
  if (options.approve === "auto" || approvalClient === null) return;
  const callId = (frame as { callId: string }).callId;
  const tool = (frame as { tool: string }).tool;
  process.stderr.write(`approve ${tool} (${callId})? [y/N] `);
  const answer = await readLineFromStdin();
  const approved = answer.trim().toLowerCase() === "y";
  for await (const _frame of approvalClient.call("chat.approve", {
    callId,
    approved,
  })) {
    if (_frame.type === "result" || _frame.type === "error") break;
  }
}

function readLineFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer): void => {
      process.stdin.off("data", onData);
      resolve(chunk.toString("utf-8"));
    };
    process.stdin.on("data", onData);
  });
}
