import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { type ClientHandle, connectClient } from "../client";
import type { Emitter } from "../output";

export interface ChatCommandOptions {
  vaultPath: string;
  prompt: string;
  conversationId?: string;
  approve: "auto" | "ask";
  emitter: Emitter;
  clientIdentity?: string;
}

export async function runChatSingleShot(options: ChatCommandOptions): Promise<number> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });

  const conversationId = options.conversationId ?? (await ensureConversation(client, options));
  if (conversationId === null) {
    await client.close();
    return 1;
  }

  const approvalClient = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });

  try {
    return await streamChatSend(client, approvalClient, conversationId, options);
  } finally {
    if (approvalClient !== null) await approvalClient.close();
    await client.close();
  }
}

async function ensureConversation(
  client: ClientHandle,
  options: ChatCommandOptions,
): Promise<string | null> {
  for await (const frame of client.call("chat.start", {
    topic: options.prompt.trim().replace(/\s+/g, " ").slice(0, 80).trimEnd(),
  })) {
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
): Promise<number> {
  for await (const frame of client.call("chat.send", {
    conversationId,
    userMessage: options.prompt,
  })) {
    options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
    if (isApprovalPending(frame)) {
      await handleApproval(frame as unknown as Record<string, unknown>, approvalClient, options);
    }
    if (frame.type === "result") return 0;
    if (frame.type === "error") return 1;
  }
  throw new Error("Conversation disconnected before the turn completed.");
}

function isApprovalPending(frame: { type: string; event?: string }): boolean {
  return frame.type === "event" && frame.event === "loop:approval_pending";
}

export async function runChatTui(options: {
  vaultPath: string;
  emitter: Emitter;
  clientIdentity?: string;
}): Promise<void> {
  // Lazy-loaded so the OpenTUI + React reconciler chunk only spins up when
  // the TUI is actually launched (single-shot CLI sessions skip it). The
  // static import lets Bun's bundler discover and emit the chunk.
  const { startTuiRuntime } = await import("../tui/runtime");
  await startTuiRuntime({
    vaultPath: options.vaultPath,
    emitter: options.emitter,
    clientIdentity: options.clientIdentity,
  });
}

async function handleApproval(
  frame: Record<string, unknown>,
  approvalClient: ClientHandle | null,
  options: ChatCommandOptions,
): Promise<void> {
  if (approvalClient === null) throw new Error("Approval connection unavailable");
  const callId = (frame as { callId: string }).callId;
  const tool = (frame as { tool: string }).tool;
  let approved = options.approve === "auto";
  if (!approved) {
    if (typeof frame.preview === "string") process.stderr.write(`${frame.preview}\n`);
    process.stderr.write(`Approve ${tool}? [y/N] `);
    approved = (await readLineFromStdin()).trim().toLowerCase() === "y";
  }
  for await (const _frame of approvalClient.call("chat.approve", {
    callId,
    approved,
  })) {
    if (_frame.type === "error") throw new Error(`Approval failed: ${_frame.message}`);
    if (_frame.type === "result") break;
  }
}

function readLineFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.readableEnded || process.stdin.destroyed) {
      resolve("");
      return;
    }
    const finish = (value: string) => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onEnd);
      process.stdin.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      finish(chunk.toString("utf-8").split(/\r?\n/, 1)[0] ?? "");
    };
    const onEnd = () => finish("");
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onEnd);
    process.stdin.resume();
  });
}
