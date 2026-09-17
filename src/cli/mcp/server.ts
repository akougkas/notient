/**
 * Notient MCP server assembly.
 *
 * Builds an `McpServer` named `notient` over a `RpcCaller`. Nothing here
 * touches a socket or a process: the caller is injected, so unit tests can
 * drive the whole surface against a fake daemon handle.
 *
 * Error contract: a daemon `error` frame becomes an MCP result with
 * `isError: true` whose first content block is `<CODE>: <message>` and whose
 * second block is the same pair as JSON. A thrown exception inside a handler
 * is converted the same way with code `INTERNAL`. No tool path is allowed to
 * reject, because a rejection out of the stdio server would tear down the
 * session for the client.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type CallToolResult,
  ErrorCode,
  McpError,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { NOTIENT_IDENTITY } from "../../agent/identity";
import { isCanonicalPublicNotePath } from "../../core/vault/publicPath";
import { VERSION } from "../../version";
import type { RpcCaller, RpcFailure } from "./rpcBridge";
import { NOTIENT_MCP_TOOLS, isFailure } from "./tools";

export const MCP_SERVER_NAME = "notient";

export interface McpServerOptions {
  caller: RpcCaller;
  vaultPath: string;
}

function errorResult(failure: RpcFailure): CallToolResult {
  return {
    isError: true,
    structuredContent: { error: { code: failure.code, message: failure.message } },
    content: [
      { type: "text", text: `${failure.code}: ${failure.message}` },
      {
        type: "text",
        text: JSON.stringify({ ok: false, code: failure.code, message: failure.message }, null, 2),
      },
    ],
  };
}

function toFailure(error: unknown): RpcFailure {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^([A-Z_]{3,40}):\s([\s\S]*)$/.exec(message);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return { ok: false, code: match[1], message: match[2] };
  }
  return { ok: false, code: "INTERNAL", message };
}

export function createNotientMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: VERSION },
    {
      instructions: `${NOTIENT_IDENTITY}\n\nYou are a visiting MCP host. Prefer notient_ask for questions, notient_brief for topic or file context, and notient_search when you need raw ranked hits. Ordinary note writes and proposal-note writes are gated: a pending receipt returns a callId and has changed no note bytes. Edits to an existing note require the note.revision from notient_read_note; a note changed since that read, or while approval is pending, is refused rather than rewritten. A successful notient_propose_link call has already staged a pending typed edge and returns its proposalId for a human decision.`,
      capabilities: { tools: {}, resources: {}, prompts: {} },
    },
  );

  for (const tool of NOTIENT_MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // Unexpected arguments fail instead of being silently stripped.
        inputSchema: z.object(tool.inputShape).strict(),
        annotations: tool.annotations,
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          const outcome = await tool.run(options.caller, (args ?? {}) as Record<string, unknown>);
          if (isFailure(outcome)) return errorResult(outcome);
          return {
            structuredContent: outcome.payload,
            content: [
              { type: "text", text: outcome.summary },
              { type: "text", text: JSON.stringify(outcome.payload, null, 2) },
            ],
          };
        } catch (error) {
          return errorResult(toFailure(error));
        }
      },
    );
  }

  registerResources(server, options);
  registerRecallPrompt(server);
  return server;
}

function registerResources(server: McpServer, options: McpServerOptions): void {
  server.registerResource(
    "status",
    "notient://status",
    {
      title: "Notient daemon status",
      description: "Vault path, pid, version, seal state, and the probed primary model.",
      mimeType: "application/json",
    },
    async (uri: URL): Promise<ReadResourceResult> => {
      const outcome = await options.caller.call("daemon.status", {});
      const body = outcome.ok
        ? outcome.result
        : { ok: false, code: outcome.code, message: outcome.message };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(body, null, 2),
          },
        ],
      };
    },
  );

  // `{+path}` is RFC 6570 reserved expansion, so vault-relative paths keep
  // their slashes instead of being percent-encoded into one segment.
  const template = new ResourceTemplate("notient://vault/{+path}", {
    list: async () => {
      const outcome = await options.caller.call("vault.list", {});
      if (!outcome.ok) return { resources: [] };
      const paths = Array.isArray(outcome.result.paths) ? outcome.result.paths : [];
      return {
        resources: paths.flatMap((entry) => {
          if (!isCanonicalPublicNotePath(entry)) return [];
          return [
            {
              uri: `notient://vault/${encodeVaultResourcePath(entry)}`,
              name: entry,
              mimeType: "text/markdown",
            },
          ];
        }),
      };
    },
  });

  server.registerResource(
    "vault-note",
    template,
    {
      title: "Vault note",
      description: `Read-only note body from ${options.vaultPath}, addressed by vault-relative path.`,
      mimeType: "text/markdown",
    },
    async (uri: URL, variables: Record<string, unknown>): Promise<ReadResourceResult> => {
      const path = decodeVaultResourcePath(variables.path);
      const outcome = await options.caller.call("notes.read", { path });
      if (!outcome.ok) {
        throw new Error(`${outcome.code}: ${outcome.message}`);
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: typeof outcome.result.body === "string" ? outcome.result.body : "",
          },
        ],
      };
    },
  );
}

/** Encode each note-name segment while retaining `/` as the vault hierarchy delimiter. */
function encodeVaultResourcePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Recover exactly one canonical public note path from an RFC 6570 reserved
 * expansion. The SDK matches against `URL.toString()`, so spaces, Unicode,
 * and literal percent signs arrive percent-encoded. Re-encoding the decoded
 * path refuses encoded delimiters and every alternate URI spelling.
 */
function decodeVaultResourcePath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) throw invalidVaultResourcePath();
  let path: string;
  try {
    path = raw
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    throw invalidVaultResourcePath();
  }
  if (!isCanonicalPublicNotePath(path) || encodeVaultResourcePath(path) !== raw) {
    throw invalidVaultResourcePath();
  }
  return path;
}

function invalidVaultResourcePath(): McpError {
  return new McpError(
    ErrorCode.InvalidParams,
    "vault resource URI must encode one exact public vault-relative Markdown note path",
  );
}

const RECALL_PROMPT = [
  NOTIENT_IDENTITY,
  "You are a visiting host using Notient's tools; do not substitute your own memory for the notes' evidence.",
  "",
  "Pick the tool by the shape of what you need:",
  '- notient_ask — a specific question that wants a cited prose answer ("what did I decide about X?", "what is my position on Y?"). It runs the grounded reasoning loop and is the slowest tool; use it once, not in a loop.',
  "- notient_brief — a topic or file you want oriented around. Returns relevant notes, recent approved claims, extracted questions, and contradiction discoveries. Prefer this over several searches when you are building context.",
  "- notient_search — raw ranked hits when you need paths and snippets to read yourself. Use mode=quick for a fast lexical pass, deep only when quick and balanced came back thin.",
  "- notient_read_note — fetch a note body once search or brief gave you a path. Slice with startLine/endLine for long notes.",
  "- notient_neighbors — approved and applied wikilinks and typed relations touching one public, contained, live indexed note.",
  "- notient_vitals — freshness, health, maturity, word count, and approved/applied wikilink-only connectivity for one public, contained, live indexed note.",
  "- notient_list_notes — browse folder structure when you do not have a query yet.",
  "- notient_events — swarm and indexer activity since a cursor; drain once at the start of a session, keep the returned cursor.",
  "- notient_create_note, notient_append_note, notient_replace_section, notient_update_frontmatter — gated vault writes. Prefer append over replace_section; replace_section overwrites prose.",
  "- notient_propose_note — file a suggestion under Notient/proposals/ for the human to review instead of writing into their notes directly.",
  "- notient_propose_link — stage one deterministic typed note-to-note edge in the Inbox for human approval. Exact replay returns the same pending proposal; a terminally rejected or differently owned identity is refused. It creates no Markdown proposal note and cannot approve itself.",
  "",
  "Rules:",
  "1. Cite the vault by path. Never present a vault claim without the note path it came from.",
  "2. Do not paraphrase away disagreement. Surface brief contradiction discoveries and extracted questions with their exact non-authoritative status; surface ask's open questions as reported.",
  "3. The four ordinary note tools and notient_propose_note are approval gated. An applied result is done. A pending note write has changed no note bytes; the same is true of a pending proposal note. Always report its callId, tell the user they can decide it with /approve <callId> or /deny <callId> in the Notient TUI, and do not retry it.",
  "4. A successful notient_propose_link call has already staged a pending typed edge. Report its proposalId and pending state; it is not an approved or applied relationship until a human decides it in the Inbox or proposal CLI. Do not call it an unchanged write and do not retry it.",
  "5. If a tool returns DAEMON_DISCONNECTED or the daemon is not running, stop using Notient for the rest of the session instead of retrying.",
].join("\n");

function registerRecallPrompt(server: McpServer): void {
  // Registered with no argsSchema: an empty shape would still make the SDK
  // demand an `arguments` object on every prompts/get, which clients that
  // send a bare name would fail.
  server.prompt(
    "notient_recall",
    "Instructions for using the Notient tools well: which verb answers which shape of question, and how to cite.",
    () => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: RECALL_PROMPT },
        },
      ],
    }),
  );
}
