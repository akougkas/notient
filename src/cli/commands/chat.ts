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

  let conversationId = options.conversationId;
  if (conversationId === undefined) {
    let started: Record<string, unknown> | null = null;
    for await (const frame of client.call("chat.start", { topic: "single-shot" })) {
      if (frame.type === "result") {
        started = frame as unknown as Record<string, unknown>;
        break;
      }
      if (frame.type === "error") {
        options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
        await client.close();
        return;
      }
    }
    if (started === null) {
      throw new Error("chat.start returned no result frame");
    }
    const conversation = started.conversation as { id: string } | undefined;
    if (conversation === undefined) {
      throw new Error("chat.start result missing conversation");
    }
    conversationId = conversation.id;
  }

  let approvalClient: ClientHandle | null = null;
  if (options.approve === "ask") {
    approvalClient = await connectClient({
      socketPath,
      vaultPath: options.vaultPath,
    });
  }

  try {
    for await (const frame of client.call("chat.send", {
      conversationId,
      userMessage: options.prompt,
    })) {
      options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
      if (
        frame.type === "event" &&
        (frame as { event?: string }).event === "loop:approval_pending"
      ) {
        await handleApproval(
          frame as unknown as Record<string, unknown>,
          approvalClient,
          options,
        );
      }
      if (frame.type === "result" || frame.type === "error") break;
    }
  } finally {
    if (approvalClient !== null) await approvalClient.close();
    await client.close();
  }
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
