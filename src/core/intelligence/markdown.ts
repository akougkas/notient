import { detectNewline } from "../markdown/frontmatter";
import { intelligenceRecordId } from "./identity";
import { intelligenceRecordSchema, type IntelligenceRecord } from "./types";

interface LineSpan {
  start: number;
  contentEnd: number;
  next: number;
  text: string;
}

interface HeadingSection {
  headingLine: number;
  endLine: number;
}

export interface IntelligenceAppendPlan {
  text: string;
  body: string;
  appendedIds: string[];
  duplicateIds: string[];
  continuation: boolean;
}

const START_MARKER = /^<!-- notient-intelligence:v1:start:(i-[a-f0-9]{64}):([A-Za-z0-9_-]+) -->$/;
const END_MARKER = /^<!-- notient-intelligence:v1:end:(i-[a-f0-9]{64}) -->$/;
const RECORD_HEADING = /^ {0,3}### (finding|interpretation|decision|question|relationship|feedback) · (supported|provisional|disputed|decided|open|retained|superseded)$/u;

export class EditedIntelligenceRecordError extends Error {
  constructor(id: string, reason: string) {
    super(`note intelligence record ${id} needs review: ${reason}`);
    this.name = "EditedIntelligenceRecordError";
  }
}

function linesOf(text: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    if (newline < 0) {
      lines.push({ start, contentEnd: text.length, next: text.length, text: text.slice(start) });
      break;
    }
    const contentEnd = newline > start && text[newline - 1] === "\r" ? newline - 1 : newline;
    lines.push({ start, contentEnd, next: newline + 1, text: text.slice(start, contentEnd) });
    start = newline + 1;
  }
  return lines;
}

function skipFrontmatter(lines: readonly LineSpan[]): number {
  if (lines[0]?.text.trim() !== "---") return 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.text.trim() === "---") return index + 1;
  }
  return 0;
}

function matchesHeading(text: string, section: string): boolean {
  const match = text.match(/^ {0,3}(#{2})[ \t]+(.+?)[ \t]*#*[ \t]*$/u);
  return match?.[2]?.trim() === section;
}

function headingLevel(text: string): number | null {
  const match = text.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)/u);
  return match ? match[1]?.length ?? null : null;
}

function looksLikeUnmarkedRecord(lines: readonly LineSpan[], index: number, end: number): boolean {
  const limit = Math.min(end, index + 16);
  let attribution = false;
  let details = false;
  for (let cursor = index + 1; cursor < limit; cursor += 1) {
    const text = lines[cursor]?.text ?? "";
    if (/^ {0,3}#{1,6}[ \t]+/u.test(text)) break;
    if (/^- \*\*Attribution:\*\*/u.test(text)) attribution = true;
    if (/^- \*\*(Assessment of retained record|Capture|Evidence|Qualification|Relationship|Source revision|Feedback)/u.test(text))
      details = true;
  }
  return attribution && details;
}

function findSections(text: string, section?: string): HeadingSection[] {
  const lines = linesOf(text);
  const sections: HeadingSection[] = [];
  let fence: { char: "`" | "~"; length: number } | null = null;
  const start = skipFrontmatter(lines);
  for (let index = start; index < lines.length; index += 1) {
    const raw = lines[index]?.text ?? "";
    const fenceMatch = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence === null && fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      fence = { char: marker[0] as "`" | "~", length: marker.length };
      continue;
    }
    if (fence !== null) {
      if (
        fenceMatch &&
        fenceMatch[1]?.[0] === fence.char &&
        (fenceMatch[1]?.length ?? 0) >= fence.length &&
        (fenceMatch[2] ?? "").trim() === ""
      )
        fence = null;
      continue;
    }
    const level = headingLevel(raw);
    const current = sections.at(-1);
    if (current && current.endLine === lines.length && level !== null && level <= 2)
      current.endLine = index;
    if (level !== null && level <= 2) {
      if (section === undefined ? level === 2 : matchesHeading(raw, section))
        sections.push({ headingLine: index, endLine: lines.length });
      continue;
    }
  }
  return sections;
}

function recordsInSection(body: string, section?: string): IntelligenceRecord[] {
  const lines = linesOf(body);
  const records: IntelligenceRecord[] = [];
  const ids = new Set<string>();
  for (const range of findSections(body, section)) {
    let fence: { char: "`" | "~"; length: number } | null = null;
    for (let index = range.headingLine + 1; index < range.endLine; index += 1) {
      const raw = lines[index]?.text ?? "";
      const fenceMatch = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
      if (fence === null && fenceMatch) {
        const marker = fenceMatch[1] ?? "";
        fence = { char: marker[0] as "`" | "~", length: marker.length };
        continue;
      }
      if (fence !== null) {
        if (
          fenceMatch &&
          fenceMatch[1]?.[0] === fence.char &&
          (fenceMatch[1]?.length ?? 0) >= fence.length &&
          (fenceMatch[2] ?? "").trim() === ""
        )
          fence = null;
        continue;
      }
      const start = raw.match(START_MARKER);
      if (!start) {
        if (RECORD_HEADING.test(raw) && looksLikeUnmarkedRecord(lines, index, range.endLine))
          throw new EditedIntelligenceRecordError("unmarked", "a generated record block lost its marker");
        continue;
      }
      const id = start[1];
      const payload = start[2];
      if (!id || !payload) throw new EditedIntelligenceRecordError("unknown", "its marker is malformed");
      let record: IntelligenceRecord;
      try {
        record = intelligenceRecordSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
      } catch (error) {
        throw new EditedIntelligenceRecordError(id, `its stored record is invalid (${String(error)})`);
      }
      if (intelligenceRecordId(record) !== id)
        throw new EditedIntelligenceRecordError(id, "its stored identity no longer matches");
      let endIndex = index + 1;
      while (endIndex < range.endLine) {
        const end = (lines[endIndex]?.text ?? "").match(END_MARKER);
        if (end) {
          if (end[1] !== id) throw new EditedIntelligenceRecordError(id, "its ending marker does not match");
          break;
        }
        endIndex += 1;
      }
      if (endIndex >= range.endLine)
        throw new EditedIntelligenceRecordError(id, "its ending marker is missing");
      const visible = body.slice(lines[index]?.next ?? 0, lines[endIndex]?.start ?? 0);
      const expected = `${renderRecordContent(record, "\n")}\n`;
      if (visible.replace(/\r\n/gu, "\n") !== expected)
        throw new EditedIntelligenceRecordError(id, "its visible content changed");
      if (!ids.has(id)) {
        ids.add(id);
        records.push(record);
      }
      index = endIndex;
    }
  }
  return records;
}

function displayText(value: string): string {
  const text = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/\\/gu, "\\\\")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/([`*_{}\[\]#|])/gu, "\\$1");
  return text.replace(/^([-+])(?=[ \t])/u, "\\$1").replace(/^(\d+)([.)])(?=[ \t])/u, "$1\\$2");
}

function displayNoteTarget(path: string): string {
  if (/[|#\]]/u.test(path)) return `\`${path.replaceAll("`", "\\`")}\``;
  return `[[${path}]]`;
}

function renderRecordContent(record: IntelligenceRecord, newline: string): string {
  const lines = [
    `### ${record.kind.replaceAll("-", " ")} · ${record.status}`,
    "",
    displayText(record.statement),
    "",
    `- **Attribution:** ${record.attribution.kind} — ${displayText(record.attribution.label)} (${displayText(record.attribution.id)})`,
  ];
  if (record.capturedContribution) lines.push("- **Capture:** submitted contribution");
  if (record.assessmentOf) lines.push(`- **Assessment of retained record:** ${record.assessmentOf}`);
  for (const evidence of record.evidence) {
    lines.push(
      `- **Evidence (${evidence.relation}, ${evidence.assessment}):** ${displayNoteTarget(evidence.source.path)} — “${displayText(evidence.source.quote)}”`,
    );
  }
  for (const qualification of record.qualifications)
    lines.push(`- **Qualification:** ${displayText(qualification)}`);
  for (const relationship of record.relationships)
    lines.push(
      `- **Relationship (${relationship.provenance}${relationship.relation ? `, ${relationship.relation}` : ""}):** ${displayNoteTarget(relationship.target)} — ${displayText(relationship.meaning)}`,
    );
  for (const dependency of record.dependencies)
    lines.push(`- **Source revision:** ${displayNoteTarget(dependency.path)} — ${dependency.revision}`);
  if (record.feedback !== null) {
    lines.push(
      `- **Feedback (${record.feedback.reason}):** ${displayText(record.feedback.explanation)} — ${displayText(record.feedback.target)}`,
      `- **Suppression key:** ${displayText(record.feedback.targetKey)}`,
    );
  }
  return lines.join(newline);
}

function renderRecord(input: IntelligenceRecord, newline: string): string {
  const record = intelligenceRecordSchema.parse(input);
  const id = intelligenceRecordId(record);
  const payload = Buffer.from(JSON.stringify(record), "utf8").toString("base64url");
  return [
    `<!-- notient-intelligence:v1:start:${id}:${payload} -->`,
    renderRecordContent(record, newline),
    `<!-- notient-intelligence:v1:end:${id} -->`,
  ].join(newline);
}

export function parseIntelligenceRecords(body: string, designation: string): IntelligenceRecord[] {
  validateDesignation(designation);
  return recordsInSection(body, designation);
}

export function parseAllIntelligenceRecords(body: string): IntelligenceRecord[] {
  return recordsInSection(body);
}

export function stripIntelligenceMarkers(text: string): string {
  return text.replace(
    /^<!-- notient-intelligence:v1:(?:start|end):[^\r\n]*(?:\r?\n|$)/gmu,
    "",
  );
}

export function withoutRetainedIntelligence(text: string): string {
  return text.replace(
    /<!-- notient-intelligence:v1:start:[\s\S]*?<!-- notient-intelligence:v1:end:i-[a-f0-9]{64} -->/gu,
    (record) => record.replace(/[^\r\n]/g, " "),
  );
}

export function prepareIntelligenceAppend(
  body: string,
  designation: string,
  inputRecords: readonly IntelligenceRecord[],
): IntelligenceAppendPlan {
  validateDesignation(designation);
  const existingIds = new Set(
    parseAllIntelligenceRecords(body).map((record) => intelligenceRecordId(record)),
  );
  const appendedIds: string[] = [];
  const duplicateIds: string[] = [];
  const pending = new Map<string, IntelligenceRecord>();
  for (const input of inputRecords) {
    const record = intelligenceRecordSchema.parse(input);
    const id = intelligenceRecordId(record);
    if (existingIds.has(id) || pending.has(id)) {
      duplicateIds.push(id);
      continue;
    }
    pending.set(id, record);
    appendedIds.push(id);
  }
  if (pending.size === 0)
    return { text: "", body, appendedIds, duplicateIds, continuation: false };
  const newline = detectNewline(body);
  const prefix = body.length === 0 ? "" : body.endsWith("\n") ? newline : `${newline}${newline}`;
  const rendered = [...pending.values()].map((record) => renderRecord(record, newline)).join(`${newline}${newline}`);
  const continuation = canContinueSection(body, designation);
  const text = continuation
    ? `${prefix}${rendered}${newline}`
    : `${prefix}## ${designation}${newline}${newline}${rendered}${newline}`;
  return { text, body: `${body}${text}`, appendedIds, duplicateIds, continuation };
}

function activeStructure(body: string): {
  lines: LineSpan[];
  last: { index: number; raw: string; level: number } | null;
  clean: boolean;
} {
  const lines = linesOf(body);
  let fence: { char: "`" | "~"; length: number } | null = null;
  let inComment = false;
  let last: { index: number; raw: string; level: number } | null = null;
  for (let index = skipFrontmatter(lines); index < lines.length; index += 1) {
    const raw = lines[index]?.text ?? "";
    if (!inComment) {
      const fenceMatch = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
      if (fence === null && fenceMatch) {
        const marker = fenceMatch[1] ?? "";
        fence = { char: marker[0] as "`" | "~", length: marker.length };
        continue;
      }
      if (fence !== null) {
        if (
          fenceMatch &&
          fenceMatch[1]?.[0] === fence.char &&
          (fenceMatch[1]?.length ?? 0) >= fence.length &&
          (fenceMatch[2] ?? "").trim() === ""
        )
          fence = null;
        continue;
      }
      const level = headingLevel(raw);
      if (level !== null && level <= 2) last = { index, raw, level };
    }
    let cursor = 0;
    while (cursor < raw.length) {
      const at = raw.indexOf(inComment ? "-->" : "<!--", cursor);
      if (at < 0) break;
      inComment = !inComment;
      cursor = at + (inComment ? 4 : 3);
    }
  }
  return { lines, last, clean: !inComment && fence === null };
}

export function canContinueSection(body: string, designation: string): boolean {
  try {
    validateDesignation(designation);
  } catch {
    return false;
  }
  const active = activeStructure(body);
  if (
    !active.clean ||
    active.last === null ||
    active.last.level !== 2 ||
    !matchesHeading(active.last.raw, designation)
  )
    return false;
  const found = findSections(body, designation).at(-1);
  if (
    found === undefined ||
    found.headingLine !== active.last.index ||
    found.endLine !== active.lines.length
  )
    return false;
  let fence: { char: "`" | "~"; length: number } | null = null;
  for (let index = found.headingLine + 1; index < active.lines.length; index += 1) {
    const raw = active.lines[index]?.text ?? "";
    const fenceMatch = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence === null && fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      fence = { char: marker[0] as "`" | "~", length: marker.length };
      continue;
    }
    if (
      fence !== null &&
      fenceMatch &&
      fenceMatch[1]?.[0] === fence.char &&
      (fenceMatch[1]?.length ?? 0) >= fence.length &&
      (fenceMatch[2] ?? "").trim() === ""
    )
      fence = null;
  }
  return fence === null;
}

export function appendedIntelligenceRecords(before: string, addition: string): IntelligenceRecord[] {
  const known = new Set(parseAllIntelligenceRecords(before).map((record) => intelligenceRecordId(record)));
  return parseAllIntelligenceRecords(`${before}${addition}`).filter(
    (record) => !known.has(intelligenceRecordId(record)),
  );
}

export function isRecordsOnlyContinuation(
  before: string,
  addition: string,
  designations: readonly string[],
): boolean {
  try {
    if (!designations.some((designation) => canContinueSection(before, designation))) return false;
    if (withoutRetainedIntelligence(addition).trim() !== "") return false;
    const starts = (addition.match(/^<!-- notient-intelligence:v1:start:/gmu) ?? []).length;
    return starts > 0 && appendedIntelligenceRecords(before, addition).length === starts;
  } catch {
    return false;
  }
}

function validateDesignation(designation: string): void {
  if (
    designation.length === 0 ||
    designation.trim() !== designation ||
    designation.length > 256 ||
    /[\r\n\u0000-\u001f\u007f]/u.test(designation)
  )
    throw new Error("note intelligence designation must be a single explicit heading name");
}
