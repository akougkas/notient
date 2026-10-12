import path from 'node:path';
import { documentSpans, frontmatterFields, replaceBody } from '../lib/markdown.mjs';
import { validText, refuse } from '../lib/paths.mjs';

export const marker = '<!-- notient-memory:append -->';
export const bodyLimit = 16000;
const quoted = '"(?:\\\\.|[^"\\\\])*"';
const sourcePattern = new RegExp(`^Source: session: (unknown|${quoted}); repository: (${quoted}); entries: (\\[.*\\]); basis: unverified task-bank recall\\.$`);
const tuple = (repository, id, date) => JSON.stringify([repository, id, date]);
const lf = value => value.replaceAll('\r\n', '\n');

function provenance(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date) || !Number.isFinite(Date.parse(value.date)) || new Date(value.date).toISOString().slice(0, 10) !== value.date) refuse('MEMORY_FORMAT', 'Use the frozen UTC contribution date.');
  if (typeof value.repository !== 'string' || !path.isAbsolute(value.repository) || path.resolve(value.repository) !== value.repository || /[\r\n]/.test(path.basename(value.repository))) refuse('MEMORY_FORMAT', 'Use the trusted canonical repository path.');
  if (!Array.isArray(value.entries) || !value.entries.length || value.entries.some(id => typeof id !== 'string' || !validText(id).length) || new Set(value.entries).size !== value.entries.length) refuse('MEMORY_FORMAT', 'Use distinct observed source entry IDs.');
  if (value.session !== undefined && value.session !== null && (typeof value.session !== 'string' || !validText(value.session).length)) refuse('MEMORY_FORMAT', 'Use a trusted session ID or unknown.');
}

export function contribution(value) {
  provenance(value);
  const lesson = lf(validText(value.lesson)).trim();
  if (!lesson || /\r/.test(lesson) || lesson.includes(marker) || /^Source:|^## \d{4}-\d{2}-\d{2} · /m.test(lesson)) refuse('MEMORY_FORMAT', 'A lesson cannot forge contribution boundaries or Source lines.');
  const session = value.session == null ? 'unknown' : JSON.stringify(value.session);
  return `## ${value.date} · ${path.basename(value.repository)}\n\n${lesson}\n\nSource: session: ${session}; repository: ${JSON.stringify(value.repository)}; entries: ${JSON.stringify(value.entries)}; basis: unverified task-bank recall.\n\n`;
}

export function memoryDocument(title, value, tags = ['memory', 'storage']) {
  validText(title);
  if (!title.trim() || /[\r\n]/.test(title)) refuse('MEMORY_FORMAT', 'Use one readable topic title.');
  const text = `---\ntype: memory\ncreated: ${JSON.stringify(value.date)}\nupdated: ${JSON.stringify(value.date)}\nrepositories: ${JSON.stringify([value.repository])}\ntags: ${JSON.stringify(tags)}\n---\n# ${title}\n\n${contribution(value)}${marker}\n`;
  readMemory(Buffer.from(text));
  return text;
}

export function readMemory(bytes) {
  const document = documentSpans(bytes);
  const body = document.text.slice(document.bodyStart);
  if (body.length > bodyLimit) refuse('MEMORY_SIZE', 'Automatic memory extension exceeds the 16000-character body bound.');
  const type = frontmatterFields(document).find(field => field.key === 'type')?.value.trim();
  if (!['memory', '"memory"', "'memory'"].includes(type) || !/^# [^\r\n]+\r?\n/.test(body)) refuse('MEMORY_ADOPTION_REQUIRED', 'Preview explicit adoption before extending an incompatible authored note.');
  const occurrences = [...body.matchAll(/<!-- notient-memory:append -->/g)];
  if (occurrences.length !== 1 || !new RegExp(`^${marker}(?:\\r?\\n)?$`).test(body.slice(occurrences[0].index))) refuse('MEMORY_MARKER', 'Automatic extension requires exactly one final append marker.');
  const end = occurrences[0].index;
  const headings = [...body.slice(0, end).matchAll(/^## (\d{4}-\d{2}-\d{2}) · ([^\r\n]+)\r?\n/gm)];
  if (!headings.length) refuse('MEMORY_ADOPTION_REQUIRED', 'Existing memory needs readable dated contributions.');
  const entries = [];
  const identities = new Map();
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const content = body.slice(heading.index + heading[0].length, headings[i + 1]?.index ?? end);
    const lines = lf(content).trim().split('\n');
    const source = sourcePattern.exec(lines.at(-1));
    if (!source || lines.filter(line => line.startsWith('Source:')).length !== 1) refuse('MEMORY_FORMAT', 'Every contribution ends with one exact Source line.');
    const value = { date: heading[1], repository: JSON.parse(source[2]), entries: JSON.parse(source[3]), session: source[1] === 'unknown' ? null : JSON.parse(source[1]), lesson: lines.slice(0, -1).join('\n').trim(), heading: `${heading[1]} · ${heading[2]}` };
    provenance(value);
    if (path.basename(value.repository) !== heading[2] || !value.lesson) refuse('MEMORY_FORMAT', 'Contribution headings and source repositories must agree.');
    for (const id of value.entries) {
      const key = tuple(value.repository, id, value.date);
      if (identities.has(key)) refuse('MEMORY_PROVENANCE_COLLISION', 'A canonical source tuple occurs in more than one contribution.');
      identities.set(key, value);
    }
    entries.push(value);
  }
  return { document, body, entries, identities, markerOffset: document.bodyStart + end };
}

export function appendMemory(bytes, value) {
  const parsed = readMemory(bytes);
  contribution(value);
  const fresh = [];
  for (const id of value.entries) {
    const old = parsed.identities.get(tuple(value.repository, id, value.date));
    if (!old) fresh.push(id);
    else if (old.lesson !== lf(value.lesson).trim()) refuse('MEMORY_PROVENANCE_COLLISION', 'Changed content reuses an already recorded canonical source tuple.');
  }
  if (!fresh.length) return { noop: true, bytes, oldText: null, newText: null };
  const suffix = parsed.document.text.slice(parsed.markerOffset + marker.length);
  const oldText = marker + suffix;
  const newText = contribution({ ...value, entries: fresh }) + oldText;
  const result = replaceBody(bytes, oldText, newText);
  readMemory(result.bytes);
  return { noop: false, ...result, oldText, newText };
}
