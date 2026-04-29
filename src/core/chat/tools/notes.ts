/**
 * Write-gated note tools. Every invocation routes through `ApprovalGate`;
 * only an approved decision results in a vault write. Each successful write
 * also records a row in the `history` table so Task 15 can offer one-click
 * undo. Phase 4 Task 6 removed the legacy self-write mark; the indexer
 * cross-references the SurrealDB `daemon_write` table (Task 2) to skip
 * daemon-authored writes without a per-call hook.
 *
 * Tools provided:
 *   - notes.create               (fails if path already exists)
 *   - notes.append               (appends to end of note body)
 *   - notes.replace_section      (replaces body under a markdown heading)
 *   - notes.update_frontmatter   (merges shallow patch into YAML frontmatter)
 */

import type { Database } from "../../db/database";
import type { HistoryKind } from "../../history/types";
import type { ApprovalGate } from "../approvalGate";
import type { ApprovalMode } from "../types";
import {
  type ToolDefinition,
  type ToolInvokeContext,
  type ToolJsonSchema,
  isObject,
  requireString,
} from "./registry";

export interface NotesFacade {
  readNote(path: string): Promise<string>;
  writeNote(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface NotesHistoryRecord {
  kind: HistoryKind;
  target: string;
  before: string | null;
  after: string;
  /**
   * Per-invocation client identity that produced the record (Phase D1 LD-5).
   * Undefined falls back to `human` inside HistoryService.record so older
   * call sites that don't yet plumb identity behave unchanged.
   */
  clientIdentity?: string;
}

export interface NotesToolsContext {
  facade: NotesFacade;
  approvalGate: ApprovalGate;
  hash: (content: string) => Promise<string>;
  approvalMode: () => ApprovalMode;
  recordHistory: (record: NotesHistoryRecord) => Promise<string>;
  generateCallId: () => string;
}

export interface NotesWriteSuccess {
  applied: true;
  path: string;
  sha: string;
  /**
   * SurrealDB record-id string from `HistoryService.record`. Phase 4
   * Task 4 swapped the SQLite numeric autoincrement id for the
   * `RecordId<"history">.toString()` form.
   */
  historyId?: string;
}

export interface NotesWriteSkipped {
  applied: false;
  reason: string;
}

export type NotesWriteResult = NotesWriteSuccess | NotesWriteSkipped;

export interface NotesCreateArgs {
  notePath: string;
  body: string;
}

const PREVIEW_MAX = 800;

function summarizeBody(body: string): string {
  if (body.length <= PREVIEW_MAX) return body;
  return `${body.slice(0, PREVIEW_MAX)}\n... (${body.length - PREVIEW_MAX} more chars)`;
}

function previewCreate(path: string, body: string): string {
  return `Create new note at ${path}\n---\n${summarizeBody(body)}`;
}

function previewAppend(path: string, before: string, addition: string): string {
  return `Append to ${path}\n---\nBefore: ${before.length} chars\nAdding: ${summarizeBody(addition)}`;
}

function previewReplaceSection(path: string, heading: string, replacement: string): string {
  return `Replace section "${heading}" in ${path}\n---\n${summarizeBody(replacement)}`;
}

function previewFrontmatter(path: string, patch: Record<string, unknown>): string {
  return `Update frontmatter on ${path}\n---\n${summarizeBody(JSON.stringify(patch, null, 2))}`;
}

const CREATE_SCHEMA: ToolJsonSchema = {
  type: "object",
  properties: {
    notePath: { type: "string", description: "Vault-relative path of the new note." },
    body: { type: "string", description: "Full markdown body for the new note." },
  },
  required: ["notePath", "body"],
};

export function makeCreateNoteTool(
  context: NotesToolsContext,
): ToolDefinition<NotesCreateArgs, NotesWriteResult> {
  return {
    name: "notes.create",
    description: "Create a new note at the given path. Fails when the path already exists.",
    schema: CREATE_SCHEMA,
    writeGated: true,
    validate: (raw) => {
      if (!isObject(raw)) throw new Error("expected object");
      const notePath = requireString(raw.notePath, "notePath");
      const body = typeof raw.body === "string" ? raw.body : null;
      if (body === null) throw new Error("body must be a string");
      return { notePath, body };
    },
    invoke: async (args, signal, invokeContext) => {
      if (await context.facade.exists(args.notePath)) {
        return { applied: false, reason: `path already exists: ${args.notePath}` };
      }
      const decision = await context.approvalGate.request(
        { id: context.generateCallId(), name: "notes.create", args: { ...args } },
        context.approvalMode(),
        previewCreate(args.notePath, args.body),
        signal,
        invokeContext,
      );
      if (!decision.approved) {
        return { applied: false, reason: decision.reason ?? "rejected by user" };
      }
      const sha = await context.hash(args.body);
      await context.facade.writeNote(args.notePath, args.body);
      const historyId = await context.recordHistory({
        kind: "notes.create",
        target: args.notePath,
        before: null,
        after: args.body,
        clientIdentity: invokeContext?.clientIdentity,
      });
      return { applied: true, path: args.notePath, sha, historyId };
    },
  };
}

export interface NotesAppendArgs {
  notePath: string;
  text: string;
}

const APPEND_SCHEMA: ToolJsonSchema = {
  type: "object",
  properties: {
    notePath: { type: "string", description: "Vault-relative path of the note to append to." },
    text: { type: "string", description: "Text to append to the end of the note body." },
  },
  required: ["notePath", "text"],
};

export function makeAppendNoteTool(
  context: NotesToolsContext,
): ToolDefinition<NotesAppendArgs, NotesWriteResult> {
  return {
    name: "notes.append",
    description: "Append text to the end of an existing note's body.",
    schema: APPEND_SCHEMA,
    writeGated: true,
    validate: (raw) => {
      if (!isObject(raw)) throw new Error("expected object");
      const notePath = requireString(raw.notePath, "notePath");
      const text = typeof raw.text === "string" ? raw.text : null;
      if (text === null) throw new Error("text must be a string");
      if (text.length === 0) throw new Error("text must not be empty");
      return { notePath, text };
    },
    invoke: async (args, signal, invokeContext) => {
      if (!(await context.facade.exists(args.notePath))) {
        return { applied: false, reason: `path does not exist: ${args.notePath}` };
      }
      const before = await context.facade.readNote(args.notePath);
      const after = appendBody(before, args.text);
      const decision = await context.approvalGate.request(
        { id: context.generateCallId(), name: "notes.append", args: { ...args } },
        context.approvalMode(),
        previewAppend(args.notePath, before, args.text),
        signal,
        invokeContext,
      );
      if (!decision.approved) {
        return { applied: false, reason: decision.reason ?? "rejected by user" };
      }
      const sha = await context.hash(after);
      await context.facade.writeNote(args.notePath, after);
      const historyId = await context.recordHistory({
        kind: "notes.append",
        target: args.notePath,
        before,
        after,
        clientIdentity: invokeContext?.clientIdentity,
      });
      return { applied: true, path: args.notePath, sha, historyId };
    },
  };
}

export interface NotesReplaceSectionArgs {
  notePath: string;
  heading: string;
  body: string;
}

const REPLACE_SECTION_SCHEMA: ToolJsonSchema = {
  type: "object",
  properties: {
    notePath: { type: "string", description: "Vault-relative path of the note." },
    heading: {
      type: "string",
      description: "Markdown heading text (without leading #) to replace the body under.",
    },
    body: {
      type: "string",
      description: "Replacement body for the section (without the heading line).",
    },
  },
  required: ["notePath", "heading", "body"],
};

export function makeReplaceSectionTool(
  context: NotesToolsContext,
): ToolDefinition<NotesReplaceSectionArgs, NotesWriteResult> {
  return {
    name: "notes.replace_section",
    description:
      "Replace the body content under a markdown heading. Heading line is preserved; only the section body changes.",
    schema: REPLACE_SECTION_SCHEMA,
    writeGated: true,
    validate: (raw) => {
      if (!isObject(raw)) throw new Error("expected object");
      const notePath = requireString(raw.notePath, "notePath");
      const heading = requireString(raw.heading, "heading");
      const body = typeof raw.body === "string" ? raw.body : null;
      if (body === null) throw new Error("body must be a string");
      return { notePath, heading, body };
    },
    invoke: async (args, signal, invokeContext) => {
      if (!(await context.facade.exists(args.notePath))) {
        return { applied: false, reason: `path does not exist: ${args.notePath}` };
      }
      const before = await context.facade.readNote(args.notePath);
      const replaced = replaceSection(before, args.heading, args.body);
      if (replaced === null) {
        return {
          applied: false,
          reason: `heading not found: ${args.heading}`,
        };
      }
      const decision = await context.approvalGate.request(
        { id: context.generateCallId(), name: "notes.replace_section", args: { ...args } },
        context.approvalMode(),
        previewReplaceSection(args.notePath, args.heading, args.body),
        signal,
        invokeContext,
      );
      if (!decision.approved) {
        return { applied: false, reason: decision.reason ?? "rejected by user" };
      }
      const sha = await context.hash(replaced);
      await context.facade.writeNote(args.notePath, replaced);
      const historyId = await context.recordHistory({
        kind: "notes.replace_section",
        target: args.notePath,
        before,
        after: replaced,
        clientIdentity: invokeContext?.clientIdentity,
      });
      return { applied: true, path: args.notePath, sha, historyId };
    },
  };
}

export interface NotesUpdateFrontmatterArgs {
  notePath: string;
  patch: Record<string, unknown>;
}

const UPDATE_FRONTMATTER_SCHEMA: ToolJsonSchema = {
  type: "object",
  properties: {
    notePath: { type: "string", description: "Vault-relative path of the note." },
    patch: {
      type: "object",
      description: "Shallow object merged into the note's YAML frontmatter.",
    },
  },
  required: ["notePath", "patch"],
};

export function makeUpdateFrontmatterTool(
  context: NotesToolsContext,
): ToolDefinition<NotesUpdateFrontmatterArgs, NotesWriteResult> {
  return {
    name: "notes.update_frontmatter",
    description:
      "Merge a shallow patch object into the note's YAML frontmatter. Creates the frontmatter block when absent.",
    schema: UPDATE_FRONTMATTER_SCHEMA,
    writeGated: true,
    validate: (raw) => {
      if (!isObject(raw)) throw new Error("expected object");
      const notePath = requireString(raw.notePath, "notePath");
      if (!isObject(raw.patch)) throw new Error("patch must be an object");
      return { notePath, patch: raw.patch };
    },
    invoke: async (args, signal, invokeContext) => {
      if (!(await context.facade.exists(args.notePath))) {
        return { applied: false, reason: `path does not exist: ${args.notePath}` };
      }
      const before = await context.facade.readNote(args.notePath);
      const next = mergeFrontmatter(before, args.patch);
      const decision = await context.approvalGate.request(
        { id: context.generateCallId(), name: "notes.update_frontmatter", args: { ...args } },
        context.approvalMode(),
        previewFrontmatter(args.notePath, args.patch),
        signal,
        invokeContext,
      );
      if (!decision.approved) {
        return { applied: false, reason: decision.reason ?? "rejected by user" };
      }
      const sha = await context.hash(next);
      await context.facade.writeNote(args.notePath, next);
      const historyId = await context.recordHistory({
        kind: "notes.update_frontmatter",
        target: args.notePath,
        before,
        after: next,
        clientIdentity: invokeContext?.clientIdentity,
      });
      return { applied: true, path: args.notePath, sha, historyId };
    },
  };
}

/**
 * History record shape persisted by the default recorder. Task 15 reads from
 * the same table to power one-click undo.
 */
export interface NotesHistoryColumns {
  kind: string;
  target: string;
  before: string | null;
  after: string;
  createdAt: number;
}

/**
 * Default history recorder. Writes to the `history` table created in V1
 * schema. The `before/after` payloads are stored as raw markdown strings so
 * the inverter (Task 15) can replay them verbatim.
 */
export function makeHistoryRecorder(
  db: Database,
  now: () => number = () => Date.now(),
): (record: NotesHistoryRecord) => Promise<number> {
  return async (record) => {
    const beforeJson = record.before === null ? null : JSON.stringify(record.before);
    const afterJson = JSON.stringify(record.after);
    db.run(
      `INSERT INTO history (kind, target, before, after, created_at)
       VALUES (?, ?, ?, ?, ?);`,
      [record.kind, record.target, beforeJson, afterJson, now()],
    );
    const idRow = db.query<{ id: number }>("SELECT last_insert_rowid() AS id;")[0];
    await db.persist();
    return idRow.id;
  };
}

function appendBody(before: string, addition: string): string {
  if (before.length === 0) return addition;
  if (before.endsWith("\n")) return before + addition;
  return `${before}\n${addition}`;
}

/**
 * Replaces the body content under the given heading. Heading match is
 * case-sensitive on the trimmed text; leading `#` characters are stripped.
 * Returns `null` when no matching heading exists.
 */
export function replaceSection(content: string, heading: string, body: string): string | null {
  const lines = content.split("\n");
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (!match) continue;
    if (match[2].trim() === heading.trim()) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx < 0) return null;
  let endIdx = lines.length;
  for (let j = headingIdx + 1; j < lines.length; j++) {
    if (/^#{1,6}\s+/.test(lines[j])) {
      endIdx = j;
      break;
    }
  }
  const before = lines.slice(0, headingIdx + 1);
  const after = lines.slice(endIdx);
  const replacement = body.length === 0 ? [""] : body.split("\n");
  const next = [...before, ...replacement, ...after].join("\n");
  if (content.endsWith("\n") && !next.endsWith("\n")) return `${next}\n`;
  return next;
}

/**
 * Merges a shallow patch object into the note's YAML frontmatter. Existing
 * top-level keys are overwritten; new keys are appended. When no frontmatter
 * exists the function creates a fresh `---` block at the top of the note.
 */
export function mergeFrontmatter(content: string, patch: Record<string, unknown>): string {
  const fm = readFrontmatter(content);
  const existing = fm ? parseFlatYaml(fm.yaml) : new Map<string, string>();
  for (const [key, value] of Object.entries(patch)) {
    const current = existing.get(key);
    if (current !== undefined && isPlainObject(value)) {
      const parsedCurrent = parseInlineYamlValue(current);
      if (isPlainObject(parsedCurrent)) {
        existing.set(key, formatYamlValue(deepMergePlainObjects(parsedCurrent, value)));
        continue;
      }
    }
    existing.set(key, formatYamlValue(value));
  }
  const yaml = Array.from(existing.entries())
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  const block = `---\n${yaml}\n---\n`;
  if (fm) {
    return `${block}${fm.body}`;
  }
  return content.length === 0 ? block : `${block}${content}`;
}

interface RawFrontmatter {
  yaml: string;
  body: string;
}

function readFrontmatter(content: string): RawFrontmatter | null {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return null;
  const headerLen = content.startsWith("---\n") ? 4 : 5;
  const closeIdx = content.indexOf("\n---", headerLen);
  if (closeIdx === -1) return null;
  const yaml = content.slice(headerLen, closeIdx);
  const after = closeIdx + 4;
  const body = content.slice(after).replace(/^\r?\n/, "");
  return { yaml, body };
}

function parseFlatYaml(yaml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of yaml.split("\n")) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    out.set(match[1], match[2]);
  }
  return out;
}

function formatYamlValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function parseInlineYamlValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMergePlainObjects(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const existing = next[key];
    if (Array.isArray(existing) && Array.isArray(value)) {
      next[key] = appendUnique(existing, value);
    } else if (isPlainObject(existing) && isPlainObject(value)) {
      next[key] = deepMergePlainObjects(existing, value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function appendUnique(current: unknown[], additions: unknown[]): unknown[] {
  const next = [...current];
  const seen = new Set(current.map((value) => JSON.stringify(value)));
  for (const value of additions) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(value);
  }
  return next;
}
