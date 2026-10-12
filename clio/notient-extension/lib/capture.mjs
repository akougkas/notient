import path from 'node:path';
import { documentSpans, frontmatterFields, editFrontmatter } from './markdown.mjs';
import { revision, refuse, validText } from './paths.mjs';

function stringTag(raw) {
  let text = raw.trim();
  let value;
  if (text.startsWith('"')) {
    const quoted = /^"(?:\\.|[^"\\])*"/.exec(text)?.[0];
    if (!quoted || !/^\s*(?:#[^\n]*)?$/.test(text.slice(quoted.length))) refuse('CAPTURE_TAGS_INVALID', 'Capture tag boundaries are ambiguous.');
    try { value = JSON.parse(quoted); } catch { refuse('CAPTURE_TAGS_INVALID', 'Capture tags must be ordinary strings.'); }
  }
  else if (text.startsWith("'")) {
    const quoted = /^'(?:''|[^'])*'/.exec(text)?.[0];
    if (!quoted) refuse('CAPTURE_TAGS_INVALID', 'Capture tags must be ordinary strings.');
    if (!/^\s*(?:#[^\n]*)?$/.test(text.slice(quoted.length))) refuse('CAPTURE_TAGS_INVALID', 'Capture tag boundaries are ambiguous.');
    value = quoted.slice(1, -1).replaceAll("''", "'");
  }
  else {
    text = text.replace(/\s+#.*$/, '').trim();
    if (!text || /^[\[\]{},]|^(?:null|true|false|~|[-+]?(?:0x[\da-f]+|0o[0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|\.inf|\.nan))$/i.test(text)) refuse('CAPTURE_TAGS_INVALID', 'Capture tags must be strings, not other YAML values.');
    value = text;
  }
  if (typeof value !== 'string') refuse('CAPTURE_TAGS_INVALID', 'Capture tags must be strings.');
  validText(value, 'Capture tag');
  return value;
}

function validateTags(field) {
  if (field.block) refuse('CAPTURE_TAGS_INVALID', 'Capture tags must be a list of strings.');
  const header = field.value.slice(0, field.value.length - field.comment.length).trim();
  let raw = [header, ...field.continuation].join('\n').trim();
  if (header.startsWith('[')) {
    let quote = null;
    let clean = '';
    for (let i = 0; i < raw.length; i++) {
      const char = raw[i];
      if (!quote && char === '#' && (i === 0 || /\s/.test(raw[i - 1]))) { while (i < raw.length && raw[i] !== '\n') i++; clean += '\n'; continue; }
      clean += char;
      if (quote) {
        if (quote === '"' && char === '\\') clean += raw[++i] ?? '';
        else if (char === quote) { if (quote === "'" && raw[i + 1] === "'") clean += raw[++i]; else quote = null; }
      } else if (char === '"' || char === "'") quote = char;
    }
    raw = clean.trim();
  }
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const members = [];
    let quote = null;
    let start = 1;
    for (let i = 1; i < raw.length - 1; i++) {
      if (quote) {
        if (quote === '"' && raw[i] === '\\') i++;
        else if (raw[i] === quote) { if (quote === "'" && raw[i + 1] === "'") i++; else quote = null; }
      } else if (raw[i] === '"' || raw[i] === "'") quote = raw[i];
      else if (raw[i] === ',') { members.push(raw.slice(start, i)); start = i + 1; }
    }
    const last = raw.slice(start, -1);
    if (last.trim()) members.push(last);
    else if (members.length && members.at(-1).trim() === '') refuse('CAPTURE_TAGS_INVALID', 'Capture tags contain an empty YAML item.');
    members.forEach(stringTag);
    return;
  }
  if (!header || header.startsWith('#')) {
    const rows = field.continuation.filter(line => line.trim() && !/^\s*#/.test(line));
    if (!rows.length) refuse('CAPTURE_TAGS_INVALID', 'Capture tags must be a list, not null.');
    for (const row of rows) {
      const match = /^\s*-\s+(.+)$/.exec(row);
      if (!match) refuse('CAPTURE_TAGS_INVALID', 'Capture tags must be a list of strings.');
      stringTag(match[1]);
    }
    return;
  }
  refuse('CAPTURE_TAGS_INVALID', 'Capture tags must be a list of strings.');
}

export function captureBodyHash(bytes) {
  const document = documentSpans(bytes);
  return revision(Buffer.from(document.text.slice(document.bodyStart).replaceAll('\r\n', '\n')));
}

export function captureDocument(input, capturedAt, cwd = process.cwd()) {
  const normalized = Buffer.from(input.content.replaceAll('\r\n', '\n'));
  const document = documentSpans(normalized);
  const fields = frontmatterFields(document);
  if (fields.some(field => ['created_by', 'captured_at', 'workspace'].includes(field.key))) refuse('CAPTURE_RESERVED_FIELD', 'Caller frontmatter cannot supply created_by, captured_at or workspace.');
  const tags = fields.find(field => field.key === 'tags');
  if (tags) validateTags(tags);
  const workspace = path.basename(cwd);
  const set = [{ key: 'created_by', valueJson: JSON.stringify(input.authorization.origin) }, { key: 'captured_at', valueJson: JSON.stringify(capturedAt) }, { key: 'workspace', valueJson: JSON.stringify(workspace) }];
  if (!tags) set.push({ key: 'tags', valueJson: '[]' });
  const bytes = editFrontmatter(normalized, set).bytes;
  frontmatterFields(documentSpans(bytes));
  return { bytes, bodyHash: captureBodyHash(bytes), workspace, capturedAt };
}

export function captureReviewBytes(bytes) {
  return editFrontmatter(bytes, [{ key: 'captured_at', valueJson: '"<capture-time>"' }]).bytes;
}

export function captureReceipt(metadata) {
  if (!metadata) return null;
  const { limitPerHour, ...receipt } = metadata;
  return receipt;
}
