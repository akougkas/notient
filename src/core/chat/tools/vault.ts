import { z } from "zod";
import type { VaultAdapter } from "../../../adapters/vaultAdapter";
import { matchesNoteScope, matchesScopePath } from "../../../api/catalog";
import type { GraphNeighbors } from "../../../api/graph";
import { NoteReadService, sourceRange } from "../../../api/notes";
import { operationInputs } from "../../../api/operations";
import type { RetrievalResult } from "../../../api/retrieval";
import {
  NoteApiError,
  type NoteReadResult,
  type SourceReference,
  notePathSchema,
  revisionSchema,
} from "../../../api/schema";
import type { GraphService } from "../../graph/graphService";
import { intelligenceRecordId, parseIntelligenceRecordSpans } from "../../intelligence";
import type { ToolJsonSchema } from "./registry";

import type { SearchPipeline } from "../../search/searchPipeline";

import { isCanonicalOrdinaryNotePath } from "../../vault/publicPath";
import type { VitalsSnapshot } from "../../vitals/types";
import type { VitalsService } from "../../vitals/vitalsService";
import { type ToolDefinition, isObject, requireString } from "./registry";

export type VaultFacade = Pick<VaultAdapter, "read" | "readBounded" | "isIndexablePath">;
const searchArgs = operationInputs["search.run"]
  .omit({ scope: true })
  .extend({
    limit: z.number().int().min(1).max(20).default(8),
  })
  .strict();
export type VaultSearchArgs = z.input<typeof searchArgs>;
export type VaultSearchResult = RetrievalResult;

/** The agent and external clients retrieve through the same revision-bound authority. */
export function makeVaultSearchTool(
  pipeline: Pick<SearchPipeline, "retrieve">,
): ToolDefinition<VaultSearchArgs, VaultSearchResult> {
  return {
    name: "vault.search_notes",
    description:
      "Find evidence in notes. Use lexical for exact terms or hybrid for meaning plus keywords. Scope is enforced by the caller; stale hits have no evidence and must not be cited.",
    schema: z.toJSONSchema(searchArgs, { io: "input" }) as ToolJsonSchema,
    validate: (raw) => searchArgs.parse(raw),
    invoke: (args, signal, context) =>
      pipeline.retrieve({ ...searchArgs.parse(args), scope: context.noteScope ?? {} }, signal),
    writeGated: false,
  };
}

const readArgs = z
  .object({
    notePath: notePathSchema,
    revision: revisionSchema.optional(),
    startOffset: z.number().int().nonnegative().optional(),
    lineRange: z
      .object({ start: z.number().int().positive(), end: z.number().int().positive() })
      .strict()
      .refine((value) => value.end >= value.start)
      .optional(),
  })
  .strict()
  .refine((args) => args.startOffset === undefined || args.lineRange === undefined, {
    message: "choose startOffset or lineRange, not both",
  });
export type VaultReadArgs = z.infer<typeof readArgs>;
export interface VaultReadResult {
  notePath: string;
  body: string;
  totalLines: number;
  totalCharacters: number;
  retainedUnderstanding?: {
    records: Array<{ recordId: string; source: SourceReference }>;
    omitted: number;
  };
  lineRange: { start: number; end: number };
  evidence: SourceReference;
  truncated: boolean;
  structure: NoteReadResult["structure"] | null;
  structureOmitted: boolean;
}

/** Bounded, exact-byte reads; offsets always refer to the complete saved source. */
export function makeReadNoteTool(
  facade: VaultFacade,
): ToolDefinition<VaultReadArgs, VaultReadResult> {
  const reader = new NoteReadService(facade);
  return {
    name: "vault.read_note",
    description:
      "Read a saved note with headings, properties, links, tasks and exact source evidence. Body reads return at most 12,000 characters; structure is omitted if it exceeds another 12,000 characters. A default whole-note request also supplies up to four complete recent readable retainedUnderstanding records within 8,000 serialized bytes, with current exact source quotations and an omitted count. They evidence what the note retains, never independent verification or permission. Body truncation is separate from these complete records. If needed content is still omitted, continue with startOffset equal to evidence.range.end and the returned evidence.revision; offsets are UTF-16 characters and can continue within a long line. Alternatively select a 1-based inclusive lineRange, without startOffset. Read the complete needed finding and qualifications; encoded metadata or earlier prose is not a substitute.",
    schema: z.toJSONSchema(readArgs, { io: "input" }) as ToolJsonSchema,
    validate: (raw) => readArgs.parse(raw),
    invoke: async (args, signal, context) => {
      const request = readArgs.parse(args);
      signal.throwIfAborted();
      if (
        !facade.isIndexablePath(request.notePath) ||
        !matchesScopePath(request.notePath, context.noteScope)
      )
        throw new NoteApiError("FORBIDDEN", "note is outside the allowed read scope");
      const note = await reader.read({ path: request.notePath, revision: request.revision });
      if (!matchesNoteScope(note, context.noteScope))
        throw new NoteApiError("FORBIDDEN", "note is outside the allowed read scope");
      signal.throwIfAborted();
      const lines = [...note.body.matchAll(/.*(?:\r\n|\n|\r|$)/g)].filter(
        (match) => match[0].length,
      );
      const totalLines = note.body.split(/\r\n|\n|\r/).length;
      const startLine = request.lineRange?.start ?? 1;
      if (startLine > totalLines)
        throw new Error(`lineRange exceeds the note's ${totalLines} lines`);
      const start = request.startOffset ?? lines[startLine - 1]?.index ?? note.body.length;
      if (start > note.body.length)
        throw new NoteApiError("INVALID_PARAMS", "startOffset exceeds the saved note length");
      const requestedEnd = request.lineRange
        ? Math.min(request.lineRange.end, totalLines)
        : totalLines;
      const fullEnd = lines[requestedEnd]?.index ?? note.body.length;
      // Keep exact CRLF bytes; a selected line's trailing separator is omitted.
      const selectedEnd = request.lineRange
        ? note.body.slice(0, fullEnd).replace(/(?:\r\n|\n|\r)$/, "").length
        : fullEnd;
      const end = Math.min(selectedEnd, start + 12000);
      const range = sourceRange(note.body, start, Math.max(start, end));
      const body = note.body.slice(range.start, range.end);
      return {
        notePath: note.note.path,
        body,
        totalLines,
        totalCharacters: note.body.length,
        ...(request.lineRange === undefined && request.startOffset === undefined
          ? { retainedUnderstanding: retainedNotePassages(note) }
          : {}),
        lineRange: { start: range.startLine, end: range.endLine },
        evidence: { ...note.note, range, quote: body },
        truncated: end < selectedEnd,
        structure: JSON.stringify(note.structure).length <= 12000 ? note.structure : null,
        structureOmitted: JSON.stringify(note.structure).length > 12000,
      };
    },
    writeGated: false,
  };
}

function retainedNotePassages(note: NoteReadResult) {
  const spans = parseIntelligenceRecordSpans(note.body);
  const records: Array<{ recordId: string; source: SourceReference }> = [];
  let omitted = Math.max(0, spans.length - 4);
  let bytes = Buffer.byteLength(JSON.stringify({ records: [], omitted: spans.length }));
  for (const span of spans.slice(-4).reverse()) {
    const raw = note.body.slice(span.start, span.end);
    const start = span.start + raw.indexOf("\n") + 1;
    const end = span.start + raw.lastIndexOf("<!-- notient-intelligence:v1:end:");
    if (start <= span.start || end <= start) {
      omitted++;
      continue;
    }
    const item = {
      recordId: intelligenceRecordId(span.record),
      source: {
        ...note.note,
        range: sourceRange(note.body, start, end),
        quote: note.body.slice(start, end),
      },
    };
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > 8000) {
      omitted++;
      continue;
    }
    records.push(item);
    bytes += size;
  }
  return { records, omitted };
}

export interface VaultListNeighborsArgs {
  notePath: string;
}

export interface VaultNeighbor {
  notePath: string;
  type: string;
  agent: string;
  confidence: number;
  direction: "outgoing" | "incoming";
}

export interface VaultListNeighborsResult {
  notePath: string;
  neighbors: VaultNeighbor[];
}

/**
 * Lists notes that share an approved-and-applied edge with the given note.
 * The query unions the writeback edge tables (supports, contradicts, extends,
 * exemplifies, synthesizes, related_to) with authored Markdown/wiki links, embeds and property references. Every
 * table is filtered server-side by `approved = true AND applied = true`, so
 * proposals and incomplete writebacks never surface as neighbours.
 */
export function makeListNeighborsTool(
  graph: Pick<GraphService, "neighbors">,
): ToolDefinition<VaultListNeighborsArgs, GraphNeighbors> {
  return {
    name: "vault.list_neighbors",
    description:
      "Read bounded, revision-checked connections, provenance and evidence for a note. Reports incomplete indexing and omitted stale sources.",
    schema: {
      type: "object",
      properties: {
        notePath: {
          type: "string",
          description: "Vault-relative path of the source note.",
        },
      },
      required: ["notePath"],
    },
    validate: (raw) => {
      if (!isObject(raw)) throw new Error("expected object");
      const notePath = requireOrdinaryNotePath(raw.notePath, "notePath");
      return { notePath };
    },
    invoke: async (args, signal) => graph.neighbors({ path: args.notePath }, signal),
    writeGated: false,
  };
}

export interface VaultGetVitalsArgs {
  notePath: string;
}

export interface VaultGetVitalsResult {
  snapshot: VitalsSnapshot | null;
}

/**
 * Computes the vitals snapshot for the given note. Returns `{snapshot: null}`
 * when the note is not indexed.
 */
export function makeGetVitalsTool(
  vitals: VitalsService,
): ToolDefinition<VaultGetVitalsArgs, VaultGetVitalsResult> {
  return {
    name: "vault.get_vitals",
    description: "Compute the freshness/health/connectivity snapshot for a note.",
    schema: {
      type: "object",
      properties: {
        notePath: {
          type: "string",
          description: "Vault-relative path of the note.",
        },
      },
      required: ["notePath"],
    },
    validate: (raw) => {
      if (!isObject(raw)) throw new Error("expected object");
      const notePath = requireOrdinaryNotePath(raw.notePath, "notePath");
      return { notePath };
    },
    invoke: async (args) => {
      const notePath = requireOrdinaryNotePath(args.notePath, "notePath");
      const snapshot = await vitals.computeSnapshot(notePath);
      return { snapshot };
    },
    writeGated: false,
  };
}

function requireOrdinaryNotePath(raw: unknown, label: string): string {
  const path = requireString(raw, label);
  if (!isCanonicalOrdinaryNotePath(path)) {
    throw new Error(`${label} must be an exact ordinary public vault-relative Markdown note path`);
  }
  return path;
}
