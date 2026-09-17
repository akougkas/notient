/**
 * Write-gated note tools. Every invocation routes through `ApprovalGate`;
 * only an approved decision results in a vault write. Each successful write
 * also records a row in the `history` table for guarded undo. The indexer
 * cross-references `daemon_write` to recognize daemon-authored changes.
 *
 * Tools provided:
 *   - notes.create               (fails if path already exists)
 *   - notes.append               (appends to end of note body)
 *   - notes.replace_section      (replaces body under a markdown heading)
 *   - notes.update_frontmatter   (merges shallow patch into YAML frontmatter)
 *
 * Existing-note tools are revision-bound. The caller names the exact saved
 * revision it read; the tool plans the complete after-image once, against
 * that revision, and the approval authorizes only that planned transition.
 * A note that changes before planning, while approval is outstanding or at
 * the final guarded write is a conflict. Nothing is recomputed against newer
 * bytes, because nobody reviewed that recomputation.
 */

import { z } from "zod";
import { NoteReadService, contentRevision } from "../../../api/notes";
import {
  NoteApiError,
  type NoteReadResult,
  type SourceRange,
  revisionSchema,
} from "../../../api/schema";
import type {
  DurableNoteWriteInput,
  DurableNoteWriteKind,
  DurableNoteWriteResult,
} from "../../history/durableNoteWriter";
import { detectNewline, locateFrontmatter, patchFrontmatter } from "../../markdown/frontmatter";
import { isCanonicalOrdinaryNotePath } from "../../vault/publicPath";
import type { ApprovalGate } from "../approvalGate";
import type { ApprovalMode } from "../types";
import type { ToolDefinition, ToolInvokeContext, ToolJsonSchema } from "./registry";

export interface NotesFacade {
  readNote(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

export type NotesHistoryRecord = DurableNoteWriteInput;

export interface NotesToolsContext {
  facade: NotesFacade;
  approvalGate: ApprovalGate;
  hash: (content: string) => Promise<string>;
  approvalMode: () => ApprovalMode;
  applyWrite: (record: NotesHistoryRecord) => Promise<DurableNoteWriteResult>;
  generateCallId: () => string;
}

export interface NotesWriteSuccess {
  applied: true;
  path: string;
  sha: string;
  /** SurrealDB record-id string from `HistoryService.record`. */
  historyId: string;
}

export interface NotesWriteSkipped {
  applied: false;
  reason: string;
}

export type NotesWriteResult = NotesWriteSuccess | NotesWriteSkipped;

const PREVIEW_SEGMENT_MAX = 4000;

const writableNotePath = z
  .string()
  .refine(
    isCanonicalOrdinaryNotePath,
    "notePath must be an exact writable public Markdown note path outside Notient-owned artifact folders",
  );
const noteRevision = revisionSchema.describe(
  "Exact saved revision returned when you read the note. A changed note is refused; read it again.",
);

const createArgs = z
  .object({
    notePath: writableNotePath.describe("Vault-relative path of the new note."),
    body: z.string().describe("Full markdown body for the new note."),
  })
  .strict();
export type NotesCreateArgs = z.infer<typeof createArgs>;

const appendArgs = z
  .object({
    notePath: writableNotePath.describe("Vault-relative path of the note to append to."),
    revision: noteRevision,
    text: z.string().min(1).describe("Text to append to the end of the note body."),
  })
  .strict();
export type NotesAppendArgs = z.infer<typeof appendArgs>;

const replaceSectionArgs = z
  .object({
    notePath: writableNotePath.describe("Vault-relative path of the note."),
    revision: noteRevision,
    heading: z
      .string()
      .min(1)
      .describe("Heading text exactly as reported in the note structure, without leading #."),
    occurrence: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("1-based occurrence of a repeated heading. Required when the text repeats."),
    body: z.string().describe("Replacement body for the section (without the heading line)."),
  })
  .strict();
export type NotesReplaceSectionArgs = z.infer<typeof replaceSectionArgs>;

const updateFrontmatterArgs = z
  .object({
    notePath: writableNotePath.describe("Vault-relative path of the note."),
    revision: noteRevision,
    patch: z
      .record(z.string().min(1), z.json())
      .refine((patch) => Object.keys(patch).length > 0, "patch must name at least one property")
      .describe(
        "Top-level properties to set. Each named value replaces the existing one (tags and aliases lists are replaced, not merged); null removes the property.",
      ),
  })
  .strict();
export type NotesUpdateFrontmatterArgs = z.infer<typeof updateFrontmatterArgs>;

/** Provider grammars reject recursive `$defs`; the JSON patch stays an
 * object at the model boundary and `validate` enforces the exact shape. */
function jsonSchema(schema: z.ZodType): ToolJsonSchema {
  const generated = z.toJSONSchema(schema, { io: "input" }) as ToolJsonSchema & {
    $defs?: unknown;
  };
  const { $defs: _definitions, ...rest } = generated;
  const patch = rest.properties.patch as { description?: string } | undefined;
  if (patch) rest.properties.patch = { type: "object", description: patch.description };
  return rest;
}

function strictParse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new Error(
    parsed.error.issues
      .map((issue) =>
        issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      )
      .join("; "),
  );
}

function segment(text: string): string {
  if (text.length <= PREVIEW_SEGMENT_MAX) return text;
  return `${text.slice(0, PREVIEW_SEGMENT_MAX)}\n... (${text.length - PREVIEW_SEGMENT_MAX} more chars; exact content is bound by revision)`;
}

function short(revision: string): string {
  return revision.slice(0, 12);
}

export function makeCreateNoteTool(
  context: NotesToolsContext,
): ToolDefinition<NotesCreateArgs, NotesWriteResult> {
  return {
    name: "notes.create",
    description: "Create a new note at the given path. Fails when the path already exists.",
    schema: jsonSchema(createArgs),
    writeGated: true,
    validate: (raw) => strictParse(createArgs, raw),
    invoke: async (args, signal, invokeContext) => {
      if (await context.facade.exists(args.notePath))
        throw new NoteApiError("CONFLICT", `path already exists: ${args.notePath}`);
      const afterRevision = contentRevision(args.body);
      const decision = await context.approvalGate.request(
        {
          id: invokeContext.callId ?? context.generateCallId(),
          name: "notes.create",
          args: { ...args, afterRevision },
        },
        context.approvalMode(),
        `Create new note at ${args.notePath}\nRevision: new -> ${short(afterRevision)}\n---\n${segment(args.body)}`,
        signal,
        invokeContext,
      );
      if (!decision.approved) return { applied: false, reason: decision.reason };
      // The invocation can sit pending for minutes on the RPC path; the
      // guarded create below is the authority, this check only explains it.
      if (await context.facade.exists(args.notePath))
        return { applied: false, reason: `path already exists: ${args.notePath}` };
      const receipt = await context.applyWrite({
        ...context.approvalGate.writeGuard(decision, signal),
        kind: "notes.create",
        target: args.notePath,
        before: null,
        after: args.body,
        clientIdentity: invokeContext.clientIdentity,
      });
      if (!receipt.applied)
        return { applied: false, reason: `path already exists: ${args.notePath}` };
      return {
        applied: true,
        path: args.notePath,
        sha: await context.hash(args.body),
        historyId: receipt.historyId,
      };
    },
  };
}

export function makeAppendNoteTool(
  context: NotesToolsContext,
): ToolDefinition<NotesAppendArgs, NotesWriteResult> {
  return {
    name: "notes.append",
    description:
      "Append text to the end of an existing note's body. Requires the revision you read; a changed note is refused.",
    schema: jsonSchema(appendArgs),
    writeGated: true,
    validate: (raw) => strictParse(appendArgs, raw),
    invoke: (args, signal, invokeContext) =>
      applyPlannedEdit(context, "notes.append", args, signal, invokeContext, (note) => {
        const after = appendBody(note.body, args.text);
        return {
          after,
          preview: `Append to ${args.notePath} (${args.text.length} chars at the end)\n---\n${segment(after.slice(note.body.length))}`,
        };
      }),
  };
}

export function makeReplaceSectionTool(
  context: NotesToolsContext,
): ToolDefinition<NotesReplaceSectionArgs, NotesWriteResult> {
  return {
    name: "notes.replace_section",
    description:
      "Replace the body under one markdown heading; the heading line and the rest of the note are preserved. Requires the revision you read. Repeated headings require an occurrence; ambiguous or missing headings are refused.",
    schema: jsonSchema(replaceSectionArgs),
    writeGated: true,
    validate: (raw) => strictParse(replaceSectionArgs, raw),
    invoke: (args, signal, invokeContext) =>
      applyPlannedEdit(context, "notes.replace_section", args, signal, invokeContext, (note) => {
        const plan = planSectionReplacement(note, args.heading, args.body, args.occurrence);
        return {
          after: plan.after,
          preview: [
            `Replace section "${args.heading}" (occurrence ${plan.occurrence}, lines ${plan.range.startLine}-${plan.range.endLine}) in ${args.notePath}`,
            `--- removed (${plan.removed.length} chars)`,
            segment(plan.removed),
            `+++ inserted (${plan.inserted.length} chars)`,
            segment(plan.inserted),
          ].join("\n"),
        };
      }),
  };
}

export function makeUpdateFrontmatterTool(
  context: NotesToolsContext,
): ToolDefinition<NotesUpdateFrontmatterArgs, NotesWriteResult> {
  return {
    name: "notes.update_frontmatter",
    description:
      "Set top-level properties in the note's YAML frontmatter, creating the block when absent. Requires the revision you read. Named values replace existing ones; null removes a property. Unparseable frontmatter is refused.",
    schema: jsonSchema(updateFrontmatterArgs),
    writeGated: true,
    validate: (raw) => strictParse(updateFrontmatterArgs, raw),
    invoke: (args, signal, invokeContext) =>
      applyPlannedEdit(context, "notes.update_frontmatter", args, signal, invokeContext, (note) => {
        if (note.structure.frontmatter.error !== null)
          throw new NoteApiError(
            "CONFLICT",
            `frontmatter is not valid YAML; fix it before patching: ${note.structure.frontmatter.error}`,
          );
        const after = patchFrontmatter(note.body, args.patch);
        return {
          after,
          preview: [
            `Update properties ${Object.keys(args.patch).join(", ")} in ${args.notePath}`,
            "--- before",
            segment(locateFrontmatter(note.body)?.raw ?? "(no frontmatter)"),
            "+++ after",
            segment(locateFrontmatter(after)?.raw ?? "(no frontmatter)"),
          ].join("\n"),
        };
      }),
  };
}

type ExistingNoteArgs = {
  notePath: string;
  revision: string;
};

/**
 * One path for every existing-note effect: read the caller's exact revision,
 * plan the full after-image, request approval for that plan, confirm the
 * revision again and hand the planned bytes to the durable writer, whose
 * guarded write and live `authorize` recheck close the final race.
 */
async function applyPlannedEdit<Args extends ExistingNoteArgs>(
  context: NotesToolsContext,
  name: Exclude<DurableNoteWriteKind, "notes.create" | "notes.move">,
  args: Args,
  signal: AbortSignal,
  invokeContext: ToolInvokeContext,
  plan: (note: NoteReadResult) => { after: string; preview: string },
): Promise<NotesWriteResult> {
  const note = await readRevision(context, args.notePath, args.revision);
  const planned = plan(note);
  if (planned.after === note.body)
    throw new NoteApiError("CONFLICT", `change leaves ${args.notePath} unchanged`);
  const afterRevision = contentRevision(planned.after);
  const decision = await context.approvalGate.request(
    {
      id: invokeContext.callId ?? context.generateCallId(),
      name,
      args: { ...(args as ExistingNoteArgs), afterRevision },
    },
    context.approvalMode(),
    `${planned.preview}\nRevision: ${short(args.revision)} -> ${short(afterRevision)}`,
    signal,
    invokeContext,
  );
  if (!decision.approved) return { applied: false, reason: decision.reason };
  const current = (await context.facade.exists(args.notePath))
    ? contentRevision(await context.facade.readNote(args.notePath))
    : null;
  if (current !== args.revision) return staleAfterApproval(args.notePath);
  const receipt = await context.applyWrite({
    ...context.approvalGate.writeGuard(decision, signal),
    kind: name,
    target: args.notePath,
    before: note.body,
    after: planned.after,
    clientIdentity: invokeContext.clientIdentity,
  });
  if (!receipt.applied) return staleAfterApproval(args.notePath);
  return {
    applied: true,
    path: args.notePath,
    sha: await context.hash(planned.after),
    historyId: receipt.historyId,
  };
}

async function readRevision(
  context: NotesToolsContext,
  notePath: string,
  revision: string,
): Promise<NoteReadResult> {
  if (!(await context.facade.exists(notePath)))
    throw new NoteApiError("NOT_FOUND", `path does not exist: ${notePath}`);
  const reader = new NoteReadService({ read: (path) => context.facade.readNote(path) });
  try {
    return await reader.read({ path: notePath, revision });
  } catch (error) {
    if (error instanceof NoteApiError && error.code === "CONFLICT")
      throw new NoteApiError(
        "CONFLICT",
        `note revision changed: ${notePath}; read it again and plan against the current revision`,
      );
    throw error;
  }
}

function staleAfterApproval(notePath: string): NotesWriteSkipped {
  return {
    applied: false,
    reason: `note changed after the approved preview; nothing was written: ${notePath}`,
  };
}

function appendBody(before: string, addition: string): string {
  if (before.length === 0 || /[\r\n]$/.test(before)) return before + addition;
  return `${before}${detectNewline(before)}${addition}`;
}

export interface SectionReplacement {
  after: string;
  removed: string;
  inserted: string;
  occurrence: number;
  range: SourceRange;
}

/**
 * Splices the body of one canonical heading section. Headings come from the
 * shared Markdown structure, so fenced pseudo-headings, setext headings, BOMs
 * and repeated headings resolve exactly as `notes.read` reports them. Only
 * the bytes between the heading line and the next heading of the same or
 * higher level change; the inserted text follows the heading's line endings.
 */
export function planSectionReplacement(
  note: Pick<NoteReadResult, "body" | "structure">,
  heading: string,
  replacement: string,
  occurrence?: number,
): SectionReplacement {
  const { body } = note;
  const candidates = note.structure.headings.filter(
    (entry) =>
      entry.text === heading && (occurrence === undefined || entry.occurrence === occurrence),
  );
  if (candidates.length === 0)
    throw new NoteApiError(
      "NOT_FOUND",
      occurrence === undefined
        ? `heading not found: ${heading}`
        : `heading occurrence not found: ${heading} #${occurrence}`,
    );
  if (candidates.length > 1)
    throw new NoteApiError(
      "CONFLICT",
      `heading "${heading}" occurs ${candidates.length} times; pass its occurrence`,
    );
  const target = candidates[0];
  const headingEnd = target.range.end;
  const terminator = body.startsWith("\r\n", headingEnd)
    ? "\r\n"
    : body[headingEnd] === "\n" || body[headingEnd] === "\r"
      ? body[headingEnd]
      : "";
  const start = headingEnd + terminator.length;
  const end = Math.max(start, target.section.end);
  const removed = body.slice(start, end);
  const newline = terminator || detectNewline(body);
  let inserted = replacement.replace(/\r\n?/g, "\n");
  if (newline !== "\n") inserted = inserted.replaceAll("\n", newline);
  if (!inserted.endsWith(newline) && (end < body.length || /[\r\n]$/.test(body)))
    inserted += newline;
  const prefix = terminator === "" && inserted.length > 0 ? newline : "";
  return {
    after: body.slice(0, start) + prefix + inserted + body.slice(end),
    removed,
    inserted,
    occurrence: target.occurrence,
    range: target.section,
  };
}
