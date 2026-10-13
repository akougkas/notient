import { briefResultSchema } from "../api/brief";
import { briefMarkdown } from "../api/briefMarkdown";
import { comparisonResultSchema } from "../api/comparison";
import { comparisonMarkdown } from "../api/comparisonMarkdown";
import { cultivationDigestSchema, cultivationSettingsResultSchema } from "../api/cultivation";
import { cultivationDigestMarkdown, cultivationSettingsMarkdown } from "../api/cultivationMarkdown";
import { graphNeighborsSchema } from "../api/graph";
import { isWritebackEdgeTable } from "../core/db/edgeTables";
import { historyEntrySchema } from "../api/history";
import { methodologySuggestionResultSchema } from "../api/methodology";
import { relationshipRetentionResultSchema } from "../api/relationshipRetention";
import { type DoctorReport, formatDoctorReport } from "./commands/doctor";
import { type SetupReport, formatSetupReport } from "./commands/setup";

export type EmitterMode = "json" | "ndjson" | "pretty";

export interface StructuredEvent {
  type: string;
  [key: string]: unknown;
}

export interface EmitterOptions {
  mode: EmitterMode;
  write?: (line: string) => void;
}

export interface Emitter {
  emit: (event: StructuredEvent) => void;
}

export function makeEmitter(options: EmitterOptions): Emitter {
  const write =
    options.write ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });

  if (options.mode === "ndjson") {
    return {
      emit: (event) => {
        write(JSON.stringify(event));
      },
    };
  }

  if (options.mode === "json") {
    return {
      emit: (event) => {
        write(JSON.stringify(event));
      },
    };
  }

  let chat = false;
  let answering = false;
  const writeChunk =
    options.write ??
    ((chunk: string) => {
      process.stdout.write(chunk);
    });
  return {
    emit: (event) => {
      if (event.type === "rpc:ack" && event.method === "chat.send") {
        chat = true;
        return;
      }
      if (event.type === "help") {
        if (typeof event.usage === "string") {
          write(event.usage);
          if (Array.isArray(event.flags)) write(`\nOptions: ${event.flags.join("  ")}`);
        } else {
          const primary = new Set([
            "chat",
            "search",
            "brief",
            "history",
            "undo",
            "setup",
            "doctor",
            "mcp",
          ]);
          write(
            [
              "Notient, a terminal home for your Markdown vault",
              "",
              "  notient                        Open your workspace (offers setup the first time)",
              "  notient --vault <path>         Open a specific vault",
              "",
              "In the workspace",
              "  Ask       Type a question and press Enter",
              "  Capture   Ctrl+B or Alt+C saves a thought in your own words",
              "  Find      Alt+O or /find <words>; /search <words> lists saved-text matches",
              "  Save      Ctrl+S or Alt+S saves an answer as a new note in your Inbox; Ctrl+O previews it first",
              "  Keep      With a note open, /keep adds an answer to it after you review the addition",
              "  Review    /review opens proposed changes to approve or reject",
              "  All       Ctrl+P opens every action; /help lists them with their keys",
              "",
              "From scripts, agents and operators",
              '  notient chat "question"        One question, answered in the terminal',
              '  notient search "topic"         Saved-text and semantic search',
              '  notient brief "project"        Pick up where you left off',
              "  notient history | undo <id>    Inspect and reverse recorded changes",
              "  notient setup <vault>          Choose a vault and connect a model",
              "  notient doctor                 Check the current setup without changing it",
              "  notient mcp --vault <path>     Serve the vault to MCP clients",
              "",
              "Use --vault <path> outside your vault.",
              "",
              "More commands (notient <command> --help):",
            ].join("\n"),
          );
          if (Array.isArray(event.commands))
            write(`  ${event.commands.filter((name) => !primary.has(String(name))).join(" · ")}`);
        }
        return;
      }
      if (chat && event.type === "rpc:event") {
        if (event.event === "loop:assistant_delta" && typeof event.contentDelta === "string") {
          writeChunk(event.contentDelta);
          answering = true;
        } else if (event.event === "loop:tool_call_started") {
          if (answering) {
            write("");
            answering = false;
          }
          write(`Using ${event.tool ?? "notes"}`);
        } else if (event.event === "loop:tool_call_error")
          write(`Tool failed: ${event.error ?? event.message ?? "unknown error"}`);
        return;
      }
      if (chat && event.type === "rpc:result") {
        if (answering) write("");
        answering = false;
        chat = false;
        return;
      }
      if (event.type === "rpc:error") {
        write(`Could not complete: ${event.message}`);
        return;
      }
      if (event.type === "doctor") {
        write(formatDoctorReport(event as DoctorReport));
        return;
      }
      if (event.type === "setup") {
        write(formatSetupReport(event as SetupReport, formatDoctorReport));
        return;
      }
      if (event.type === "brief:done") {
        write(briefMarkdown(briefResultSchema.parse(event)));
        return;
      }
      if (event.type === "analysis:done") {
        write(comparisonMarkdown(comparisonResultSchema.parse(event)));
        return;
      }
      if (event.type === "api:result" && event.operation === "cultivation.digest") {
        const { type: _type, operation: _operation, ...payload } = event;
        write(cultivationDigestMarkdown(cultivationDigestSchema.parse(payload)));
        return;
      }
      if (event.type === "api:result" && event.operation === "cultivation.settings") {
        const { type: _type, operation: _operation, ...payload } = event;
        const result = cultivationSettingsResultSchema.parse(payload);
        write(cultivationSettingsMarkdown(result));
        return;
      }
      if (event.type === "api:result" && event.operation === "methodology.suggest") {
        const { type: _type, operation: _operation, ...payload } = event;
        const result = methodologySuggestionResultSchema.parse(payload);
        const headline =
          result.status === "proposal-created"
            ? `Move suggestion: ${result.source.path} → ${result.destination}. Proposal ${result.proposal.state}; source note remains unchanged until review.`
            : result.status === "convention-suggestion"
              ? `Convention suggestion for ${result.source.path}. Proposal ${result.proposal.state}; settings remain unchanged until explicit configuration.`
              : `No methodology suggestion for ${result.source.path}: ${result.reason}`;
        const explanation =
          result.status === "no-suggestion"
            ? ""
            : result.status === "proposal-created"
              ? result.rationale
              : `${result.rationale}\n\nSuggested convention: ${result.conventionSuggestion.text}\n${result.conventionSuggestion.rationale}`;
        const evidence = result.evidence
          .map(
            (source, index) =>
              `${index + 1}. ${source.path}:${source.range.startLine}\n${source.quote
                .split(/\r?\n/u)
                .map((line) => `   > ${line}`)
                .join("\n")}`,
          )
          .join("\n");
        const examined = result.examinedSources
          .map((source) => `- ${source.path} · ${source.revision}`)
          .join("\n");
        write(
          [
            headline,
            explanation,
            examined ? `Notes read for this study:\n${examined}` : "",
            evidence ? `Evidence:\n${evidence}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        return;
      }
      if (event.type === "api:result" && event.operation === "relationships.retain") {
        const { type: _type, operation: _operation, ...payload } = event;
        const result = relationshipRetentionResultSchema.parse(payload);
        write(
          result.status === "already-retained"
            ? `${result.relation} edge ${result.edgeId} is already retained in ${result.sourcePath}.`
            : `Retention proposal ${result.proposal.id} is ${result.proposal.state}. Inspect preview ${result.previewId} before approving the append to ${result.sourcePath}.`,
        );
        return;
      }
      if (event.type === "api:result" && event.operation === "graph.neighbors") {
        const { type: _type, operation: _operation, ...payload } = event;
        const result = graphNeighborsSchema.parse(payload);
        const connections = result.connections.map((connection) => {
          const semantic = isWritebackEdgeTable(connection.relation);
          const direction = connection.direction === "outgoing" ? "→" : "←";
          const sourceLabel =
            connection.meaningSource === "note"
              ? "Meaning read from the note"
              : connection.meaningSource === "private-record"
                ? "Meaning read from the private relationship record"
                : null;
          return [
            `${direction} ${connection.relation} ${connection.note.path} · ${semantic ? (connection.state === "retained" ? "retained provisional relationship" : `${connection.state} relationship`) : connection.state === "retained" ? "retained reference" : "saved reference"} · ${connection.author}`,
            sourceLabel && connection.rationale ? `  ${sourceLabel}: ${connection.rationale}` : "",
            !semantic
              ? ""
              : connection.evidenceState === "stale"
                ? "  Evidence has changed since this relationship was assessed."
                : connection.evidenceState === "unavailable"
                  ? "  Revision-bound evidence is unavailable for this relationship."
                  : `  ${connection.evidence.length} current evidence passage(s)`,
          ]
            .filter(Boolean)
            .join("\n");
        });
        write([`Connections for ${result.note.path}:`, ...connections].join("\n"));
        return;
      }
      if (event.type === "history:entry") {
        const { type: _type, ...data } = event;
        const entry = historyEntrySchema.parse(data);
        const state =
          entry.undo?.completedAt != null
            ? "undone"
            : entry.undo
              ? "undo interrupted"
              : entry.kind.replace(/^notes?\./, "").replaceAll("_", " ");
        write(
          `${new Date(entry.createdAt).toLocaleString()}  ${entry.target}  · ${state}\n  ${entry.id} · ${entry.clientIdentity}`,
        );
        return;
      }
      if (event.type === "contributions:empty") {
        write("No contributions or feedback match.");
        return;
      }
      if (event.type === "contributions:more") {
        write(
          `More items are available. Repeat the command with the same filters and --cursor ${formatValue(event.cursor)}`,
        );
        return;
      }
      if (event.type === "contributions:entry") {
        const meaning: Record<string, string> = {
          pending: "private and not yet staged for review",
          "awaiting-review": "staged; a human or vault owner has not decided",
          retained:
            "approved and applied to the note when decided; later edits or an undo are not tracked here",
          rejected: "review rejected; the note was not changed",
          stale: "its evidence changed before a decision; nothing was applied",
          dismissed: "dismissed before review",
        };
        const status = String(event.status);
        const statement = String(event.statement).replace(/\s+/g, " ");
        const lines = [
          `${status}  ${String(event.kind)}${event.contributionKind ? ` (${String(event.contributionKind)})` : ""}  ${String(event.note)}  · ${String(event.contributor)}`,
          `  ${meaning[status] ?? status}${event.reason ? ` · ${String(event.reason)}` : ""}`,
          `  ${statement.length > 200 ? `${statement.slice(0, 199)}…` : statement}`,
          `  ${String(event.id)}`,
        ];
        if (typeof event.reviewId === "string")
          lines.push(
            `  Review ${event.reviewId}: read it with notient api proposals.get --input '{"id":"${event.reviewId}"}', or open /review in the workspace.`,
          );
        write(lines.join("\n"));
        return;
      }
      if (event.type === "history:undone") {
        const entry = historyEntrySchema.parse(event.entry);
        write(`Restored ${entry.target}. The original change remains in history.`);
        return;
      }
      const detail = Object.entries(event)
        .filter(([key]) => key !== "type")
        .map(([key, value]) => `${key}=${formatValue(value)}`)
        .join(" ");
      write(detail.length > 0 ? `${event.type} ${detail}` : event.type);
    },
  };
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function defaultMode(isTty: boolean): EmitterMode {
  return isTty ? "pretty" : "json";
}
