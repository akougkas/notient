import path from 'node:path';
import { refuse, validText } from './paths.mjs';

export function documentSpans(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { refuse('INVALID_UTF8', 'The document must be valid UTF-8.'); }
  validText(text, 'Document');
  const bom = text.startsWith('\uFEFF') ? 1 : 0;
  const lines = [];
  let offset = bom;
  for (const raw of text.slice(bom).match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const ending = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '';
    lines.push({ start: offset, end: offset + raw.length, content: raw.slice(0, raw.length - ending.length), ending });
    offset += raw.length;
  }
  let closing = -1;
  if (/^---[ \t]*$/.test(lines[0]?.content ?? '')) {
    closing = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(line.content));
    if (closing < 0) refuse('FRONTMATTER_INVALID', 'Frontmatter has no closing delimiter.');
  }
  return { text, bom, lines, closing, bodyStart: closing < 0 ? bom : lines[closing].end, newline: lines.find(line => line.ending)?.ending ?? '\n' };
}

export function replaceBody(bytes, oldText, newText) {
  validText(oldText, 'oldText'); validText(newText, 'newText');
  if (/\r(?!\n)/.test(newText)) refuse('INVALID_INPUT', 'newText cannot contain bare CR.');
  if (!oldText.length) refuse('INVALID_INPUT', 'oldText cannot be empty.');
  const document = documentSpans(bytes);
  const matches = [];
  let offset = document.bodyStart;
  for (;;) {
    offset = document.text.indexOf(oldText, offset);
    if (offset < 0) break;
    matches.push(offset);
    if (matches.length > 1) refuse('QUOTE_AMBIGUOUS', 'occurs more than once; quote a longer contiguous passage identifying one occurrence');
    offset++;
  }
  if (!matches.length) refuse('QUOTE_NOT_FOUND', 'not an exact supplied quotation; copy a contiguous passage verbatim, preserving punctuation and whitespace');
  if (oldText === newText) return { bytes, splices: [] };
  const conventions = new Set(oldText.match(/\r?\n/g) ?? []);
  if (conventions.size > 1 && newText.includes('\n')) refuse('MIXED_NEWLINE_EDIT', 'A multiline replacement cannot choose a convention for a mixed-style matched span.');
  const endings = document.lines.map(line => line.ending);
  const crlf = endings.filter(ending => ending === '\r\n').length;
  const lf = endings.filter(ending => ending === '\n').length;
  const fallback = crlf === lf ? document.newline : crlf > lf ? '\r\n' : '\n';
  newText = newText.replace(/\r?\n/g, conventions.size === 1 ? [...conventions][0] : fallback);
  const startByte = Buffer.byteLength(document.text.slice(0, matches[0]));
  const endByte = startByte + Buffer.byteLength(oldText);
  return { bytes: Buffer.concat([bytes.subarray(0, startByte), Buffer.from(newText), bytes.subarray(endByte)]), splices: [{ startByte, endByte, replacement: newText }] };
}

export function yamlKey(raw) {
  if (raw.startsWith('"')) { try { const key = JSON.parse(raw); if (typeof key === 'string') return key; } catch {} }
  else if (raw.startsWith("'")) { if (raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'"); }
  else if (/^[\p{L}\p{N}_][\p{L}\p{N}_ .-]*$/u.test(raw)) return raw;
  refuse('FRONTMATTER_UNSUPPORTED', 'Only ordinary string mapping keys can be changed safely.');
}

function yamlLex(text, allowOpen = false) {
  let quote = null;
  const flow = [];
  let comment = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'" && text[i + 1] === "'") { i++; continue; }
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === '\\') {
        const escape = text[++i];
        if ('0abtnvfre "_NLP\\/\n\r'.includes(escape ?? '\0')) continue;
        const digits = { x: 2, u: 4, U: 8 }[escape];
        if (!digits || !new RegExp(`^[a-f0-9]{${digits}}$`, 'i').test(text.slice(i + 1, i + 1 + digits))) refuse('FRONTMATTER_INVALID', 'Malformed YAML string escape.');
        i += digits;
      } else if (c === '"') quote = null;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      if (comment < 0) comment = i;
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      continue;
    }
    const boundary = i === 0 || /[\s,[{:]/.test(text[i - 1]);
    if ((c === '"' || c === "'") && boundary) { quote = c; continue; }
    if ('&*!'.includes(c) && boundary) refuse('FRONTMATTER_UNSUPPORTED', 'YAML anchors, aliases and custom tags are unsupported.');
    if (c === '[' || c === '{') flow.push({ kind: c, keys: new Set(), keyStart: i + 1, needsKey: c === '{' });
    else if (c === ',' && flow.at(-1)?.kind === '{') { flow.at(-1).needsKey = true; flow.at(-1).keyStart = i + 1; }
    else if (c === ':' && flow.at(-1)?.kind === '{' && flow.at(-1).needsKey) {
      const frame = flow.at(-1);
      const key = yamlKey(text.slice(frame.keyStart, i).trim());
      if (frame.keys.has(key)) refuse('FRONTMATTER_INVALID', 'Duplicate flow mapping keys are unsupported.');
      frame.keys.add(key); frame.needsKey = false;
    }
    else if (c === ']' || c === '}') {
      if (flow.pop()?.kind !== (c === ']' ? '[' : '{')) refuse('FRONTMATTER_INVALID', 'Unbalanced YAML flow collection.');
    }
  }
  if (!allowOpen && (quote || flow.length)) refuse('FRONTMATTER_INVALID', 'Unclosed YAML quote or flow collection.');
  return allowOpen ? { comment, open: Boolean(quote || flow.length) } : comment;
}

export function headerParts(line) {
  const match = /^((?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^:#]+?))([ \t]*:[ \t]*)(.*)$/.exec(line.content);
  if (!match || /^\s|^[-?]|^<</.test(match[1]) || (match[3] && !/[ \t]$/.test(match[2]))) refuse('FRONTMATTER_UNSUPPORTED', 'A top-level mapping boundary is ambiguous.');
  return { key: yamlKey(match[1].trim()), prefix: match[1] + match[2], value: match[3] };
}

function nestedMappingKeys(field) {
  if (field.block || field.value.trim() && !field.value.trim().startsWith('#')) return;
  const levels = [];
  const previous = [field.value];
  for (const content of field.continuation) {
    const inFlow = yamlLex(previous.join('\n'), true).open;
    previous.push(content);
    if (inFlow) continue;
    let row = content.trimStart();
    if (!row || row.startsWith('#')) continue;
    const item = /^-\s+/.exec(row);
    const indent = content.length - row.length + (item?.[0].length ?? 0);
    if (item) { row = row.slice(item[0].length); while (levels.length && levels.at(-1).indent >= indent) levels.pop(); }
    if (!/^(?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[\p{L}\p{N}_][^:#]*?)[ \t]*:[ \t]*(?:$|\S)/u.test(row)) continue;
    const key = headerParts({ content: row }).key;
    while (levels.length && levels.at(-1).indent > indent) levels.pop();
    if (!levels.length || levels.at(-1).indent !== indent) levels.push({ indent, keys: new Set() });
    if (levels.at(-1).keys.has(key)) refuse('FRONTMATTER_INVALID', 'Duplicate nested mapping keys are unsupported.');
    levels.at(-1).keys.add(key);
  }
}

export function frontmatterFields(document) {
  if (document.closing < 0) return [];
  if (Buffer.byteLength(document.text.slice(0, document.bodyStart)) > 65536) refuse('FRONTMATTER_UNSUPPORTED', 'Frontmatter editing is bounded to 64 KiB.');
  const fields = [];
  const names = new Set();
  let active = null;
  for (let i = 1; i < document.closing; i++) {
    const line = document.lines[i];
    if (active && !active.block && yamlLex([active.value, ...active.continuation].join('\n'), true).open) {
      active.end = line.end;
      active.continuation.push(line.content);
      active.spans.push({ start: line.start, end: line.end });
      continue;
    }
    if (active?.block && /^[ \t]+\S/.test(line.content)) {
      active.end = line.end;
      active.spans.push({ start: line.start, end: line.end });
      continue;
    }
    if (!line.content.trim() || /^\s*#/.test(line.content)) continue;
    if (/^[ \t]|^-\s/.test(line.content)) {
      if (!active || /^\t|^ +\t/.test(line.content) || (/^-\s/.test(line.content) && !active.list)) refuse('FRONTMATTER_UNSUPPORTED', 'An indented field boundary is ambiguous.');
      active.end = line.end;
      active.spans.push({ start: line.start, end: line.end });
      if (!active.block) {
        if (/^\s*(?:\?|<<\s*:)/.test(line.content)) refuse('FRONTMATTER_UNSUPPORTED', 'Complex and merge keys are unsupported.');
        active.continuation.push(line.content);
      }
      continue;
    }
    const parts = headerParts(line);
    if (names.has(parts.key)) refuse('FRONTMATTER_INVALID', 'Duplicate top-level frontmatter keys are unsupported.');
    names.add(parts.key);
    active = { ...parts, start: line.start, valueStart: line.start + parts.prefix.length, end: line.end, firstEnd: line.end, ending: line.ending, continuation: [], spans: [], block: /^[|>](?:[1-9][+-]?|[+-][1-9]?)?(?:[ \t]+#.*)?$/.test(parts.value), list: !parts.value.trim() || /^#/.test(parts.value.trim()) };
    fields.push(active);
    if (fields.length > 512) refuse('FRONTMATTER_UNSUPPORTED', 'Frontmatter editing is bounded to 512 fields.');
  }
  for (const field of fields) {
    nestedMappingKeys(field);
    const header = field.value;
    if (field.block) {
      const comment = header.indexOf('#');
      let start = comment;
      while (start > 0 && /[ \t]/.test(header[start - 1])) start--;
      field.comment = comment < 0 ? '' : header.slice(start);
      continue;
    }
    const value = [header, ...field.continuation].join('\n');
    yamlLex(value);
    if (/^["']/.test(value.trim()) && !/^(?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*')(?:\s*(?:#[^\n]*)?)*$/.test(value.trim())) refuse('FRONTMATTER_INVALID', 'A quoted scalar has trailing or malformed content.');
    const comment = yamlLex(header, true).comment;
    let end = comment < 0 ? header.length : comment;
    while (end > 0 && /[ \t]/.test(header[end - 1])) end--;
    field.comment = `${comment === 0 ? ' ' : ''}${header.slice(end)}`;
    if (/^[|>]/.test(header.trim())) refuse('FRONTMATTER_INVALID', 'Malformed YAML block scalar indicator.');
  }
  return fields;
}

function jsonValue(source) {
  validText(source, 'valueJson');
  let value;
  try { value = JSON.parse(source); } catch { refuse('INVALID_VALUE_JSON', 'valueJson must encode one JSON value.'); }
  function check(item, depth) {
    if (depth > 4) refuse('INVALID_VALUE_JSON', 'Decoded JSON depth exceeds four.');
    if (typeof item === 'number' && !Number.isFinite(item)) refuse('INVALID_VALUE_JSON', 'JSON numbers must be finite.');
    if (typeof item === 'string') validText(item, 'Decoded JSON string');
    if (Array.isArray(item)) item.forEach(child => check(child, depth + 1));
    else if (item && typeof item === 'object') Object.entries(item).forEach(([key, child]) => { validText(key, 'Decoded JSON key'); check(child, depth + 1); });
  }
  check(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 4096 || Buffer.byteLength(source) > 4096) refuse('INVALID_VALUE_JSON', 'A JSON value exceeds 4096 UTF-8 bytes.');
  return encoded;
}

export function editFrontmatter(bytes, set = [], unset = []) {
  const document = documentSpans(bytes);
  const fields = frontmatterFields(document);
  const changes = new Map();
  const removed = new Set();
  for (const item of set) {
    if (!item || !/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(item.key) || changes.has(item.key)) refuse('INVALID_INPUT', 'Set keys must be valid and unique.');
    changes.set(item.key, jsonValue(item.valueJson));
  }
  for (const key of unset) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(key) || removed.has(key) || changes.has(key)) refuse('INVALID_INPUT', 'Unset keys must be valid, unique and disjoint from set.');
    removed.add(key);
  }
  const edits = [];
  const offset = position => Buffer.byteLength(document.text.slice(0, position));
  if (document.closing < 0) {
    if (!changes.size) return { bytes, splices: [] };
    const generated = `---${document.newline}${[...changes].map(([key, value]) => `${key}: ${value}${document.newline}`).join('')}---${document.newline}`;
    edits.push({ startByte: offset(document.bom), endByte: offset(document.bom), replacement: generated });
  } else {
    for (const field of fields) {
      if (removed.has(field.key)) {
        edits.push({ startByte: offset(field.start), endByte: offset(field.firstEnd), replacement: '' });
        for (const span of field.spans) edits.push({ startByte: offset(span.start), endByte: offset(span.end), replacement: '' });
      }
      else if (changes.has(field.key)) {
        const value = changes.get(field.key);
        const replacement = `${field.prefix.endsWith(':') ? ' ' : ''}${value}${field.comment}${field.ending}`;
        edits.push({ startByte: offset(field.valueStart), endByte: offset(field.firstEnd), replacement });
        for (const span of field.spans) edits.push({ startByte: offset(span.start), endByte: offset(span.end), replacement: '' });
        changes.delete(field.key);
      }
    }
    if (changes.size) edits.push({ startByte: offset(document.lines[document.closing].start), endByte: offset(document.lines[document.closing].start), replacement: [...changes].map(([key, value]) => `${key}: ${value}${document.newline}`).join('') });
  }
  const chunks = [];
  let start = 0;
  for (const splice of edits.sort((a, b) => a.startByte - b.startByte)) {
    chunks.push(bytes.subarray(start, splice.startByte), Buffer.from(splice.replacement));
    start = splice.endByte;
  }
  chunks.push(bytes.subarray(start));
  return { bytes: Buffer.concat(chunks), splices: edits };
}

export function sourceRange(text, start, end) {
  return {
    startLine: 1 + (text.slice(0, start).match(/\n/g)?.length ?? 0),
    endLine: 1 + (text.slice(0, Math.max(start, end - (text[end - 1] === '\n' ? 1 : 0))).match(/\n/g)?.length ?? 0),
    startByte: Buffer.byteLength(text.slice(0, start)),
    endByte: Buffer.byteLength(text.slice(0, end)),
  };
}

function scalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed.replace(/\s+#.*$/, '').trim();
}

export function frontmatterList(raw, key) {
  const lines = raw.split(/\r?\n/);
  const row = lines.findIndex(line => line.startsWith(`${key}:`));
  if (row < 0) return [];
  const value = lines[row].slice(key.length + 1).trim();
  if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1).split(/,(?=(?:[^"']|"[^"]*"|'[^']*')*$)/).map(scalar).filter(Boolean);
  if (value) return [scalar(value)];
  const values = [];
  for (let i = row + 1; i < lines.length; i++) {
    const item = /^\s*-\s+(.+)$/.exec(lines[i]);
    if (item) values.push(scalar(item[1]));
    else if (lines[i].trim() && !/^\s/.test(lines[i])) break;
  }
  return values;
}

export function splitTarget(target) {
  const hash = target.indexOf('#');
  return { target: hash < 0 ? target : target.slice(0, hash), fragment: hash < 0 ? null : target.slice(hash + 1) };
}

function scanLinks(text, start, end, definitions = new Map()) {
  const links = [];
  let i = start;
  while (i < end) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '`') {
      let length = 1;
      while (text[i + length] === '`') length++;
      const close = text.indexOf('`'.repeat(length), i + length);
      i = close >= 0 && close < end ? close + length : i + length;
      continue;
    }
    const embed = text[i] === '!';
    const open = i + (embed ? 1 : 0);
    if (text.startsWith('[[', open)) {
      const close = text.indexOf(']]', open + 2);
      if (close < 0 || close >= end) { i++; continue; }
      const inner = text.slice(open + 2, close);
      const pipe = inner.indexOf('|');
      const rawTarget = (pipe < 0 ? inner : inner.slice(0, pipe)).trim();
      links.push({ kind: 'wiki', ...splitTarget(rawTarget), alias: pipe < 0 ? null : inner.slice(pipe + 1), embed, source: sourceRange(text, i, close + 2) });
      i = close + 2;
      continue;
    }
    if (text[open] === '[') {
      let cursor = open + 1;
      let depth = 1;
      while (cursor < end && depth) {
        if (text[cursor] === '\\') { cursor += 2; continue; }
        if (text[cursor] === '[') depth++;
        if (text[cursor] === ']') depth--;
        cursor++;
      }
      if (depth) { i++; continue; }
      const alias = text.slice(open + 1, cursor - 1);
      if (text[cursor] !== '(') {
        let label = alias;
        let referenceEnd = cursor;
        if (text[cursor] === '[') {
          const close = text.indexOf(']', cursor + 1);
          if (close < 0 || close >= end) { i++; continue; }
          label = text.slice(cursor + 1, close) || alias;
          referenceEnd = close + 1;
        }
        const definition = definitions.get(label.trim().replace(/\s+/g, ' ').toLowerCase());
        if (definition) {
          links.push({ kind: 'reference', ...splitTarget(definition.target), alias, embed, source: sourceRange(text, i, referenceEnd), definitionSource: definition.source });
          i = referenceEnd;
        } else i++;
        continue;
      }
      const targetStart = cursor + 1;
      cursor = targetStart;
      depth = 1;
      let angle = text[cursor] === '<';
      while (cursor < end && depth) {
        if (text[cursor] === '\\') { cursor += 2; continue; }
        if (angle) { if (text[cursor] === '>') angle = false; }
        else if (text[cursor] === '(') depth++;
        else if (text[cursor] === ')') depth--;
        cursor++;
      }
      if (depth) { i++; continue; }
      const inner = text.slice(targetStart, cursor - 1).trim();
      const rawTarget = inner.startsWith('<') ? inner.slice(1, inner.indexOf('>')) : inner.replace(/\s+["'].*$/, '');
      links.push({ kind: 'markdown', ...splitTarget(rawTarget.replace(/\\([()])/g, '$1')), alias, embed, source: sourceRange(text, i, cursor) });
      i = cursor;
      continue;
    }
    i++;
  }
  return links;
}

export function parseMarkdown(text, filename = '') {
  const lines = [];
  const bomLength = text.startsWith('\uFEFF') ? 1 : 0;
  let offset = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const content = line.replace(/\r?\n$/, '');
    lines.push({ text: offset === 0 ? content.replace(/^\uFEFF/, '') : content, start: offset === 0 ? bomLength : offset, end: offset + line.length });
    offset += line.length;
  }
  let bodyStart = bomLength;
  let frontmatter = '';
  if (/^---[ \t]*$/.test(lines[0]?.text.replace(/^\uFEFF/, '') ?? '')) {
    const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line.text));
    if (end < 0) throw new Error('Frontmatter has no closing delimiter.');
    bodyStart = lines[end].end;
    frontmatter = text.slice(0, bodyStart);
  }
  const outline = [];
  for (const line of lines) if (line.start === bodyStart && line.text.startsWith('\uFEFF')) line.text = line.text.slice(1);
  const blocks = [];
  const links = [];
  const tags = new Set(frontmatterList(frontmatter, 'tags').map(tag => tag.replace(/^#/, '')));
  const headings = [];
  let fence = null;
  let visitor = false;
  let visitorHeading = null;
  let comment = false;
  const generated = /Generated by Obsidian Processor/.test(text) || filename.startsWith('Notient/Log/');
  const definitions = new Map();
  const definitionLines = new Set();
  let definitionFence = null;
  for (const line of lines) {
    if (line.start < bodyStart) continue;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line.text)?.[1];
    if (marker) {
      if (!definitionFence) definitionFence = marker;
      else if (marker[0] === definitionFence[0] && marker.length >= definitionFence.length) definitionFence = null;
      continue;
    }
    if (definitionFence) continue;
    const match = /^ {0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/.exec(line.text);
    if (match) {
      const key = match[1].trim().replace(/\s+/g, ' ').toLowerCase();
      if (!definitions.has(key)) definitions.set(key, { target: match[2] ?? match[3], source: sourceRange(text, line.start, line.end) });
      definitionLines.add(line.start);
    }
  }
  let current = null;
  function finish() {
    if (current) blocks.push({ ...current, source: sourceRange(text, current.start, current.end) });
    current = null;
  }
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    if (line.start < bodyStart) continue;
    if (definitionLines.has(line.start)) { finish(); continue; }
    if (!fence && /<!--\s*notient:(?:begin|start)\b/i.test(line.text)) { finish(); visitor = true; continue; }
    if (!fence && /<!--\s*notient:end\s*-->/i.test(line.text)) { finish(); visitor = false; continue; }
    if (!fence && (comment || line.text.includes('<!--'))) {
      finish();
      comment = !line.text.includes('-->');
      continue;
    }
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line.text);
    const isFence = Boolean(fenceMatch);
    if (fenceMatch) {
      if (!fence) { finish(); fence = { character: fenceMatch[1][0], length: fenceMatch[1].length }; }
      else if (fenceMatch[1][0] === fence.character && fenceMatch[1].length >= fence.length && /^ {0,3}(`+|~+)\s*$/.test(line.text)) fence = null;
    }
    const heading = !fence && !isFence ? /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line.text) : null;
    const setext = !fence && !isFence && row + 1 < lines.length && /^ {0,3}(=+|-+)\s*$/.test(lines[row + 1].text) && line.text.trim() && !/^\s*[-*>]/.test(line.text);
    if (heading || setext) {
      finish();
      const level = heading ? heading[1].length : lines[row + 1].text.trim()[0] === '=' ? 1 : 2;
      const title = heading ? heading[2] : line.text.trim();
      while (headings.length && headings.at(-1).level >= level) headings.pop();
      headings.push({ level, title });
      if (visitorHeading !== null && level <= visitorHeading) visitorHeading = null;
      if (/^(?:Notient(?: Intelligence)?|Visitor(?: Intelligence| Notes)?)(?:\s|$)/i.test(title)) visitorHeading = level;
      outline.push({ level, title, headingPath: headings.map(h => h.title), line: row + 1 });
      if (setext) row++;
    }
    const excluded = generated || visitor || visitorHeading !== null || /^>\s*(?:Context from referencing notes:|[-*]\s*\.\.\.)/.test(line.text);
    const kind = fence || isFence ? 'code' : heading || setext ? 'heading' : 'paragraph';
    const end = setext ? lines[row].end : line.end;
    if (kind !== 'code') links.push(...scanLinks(text, line.start, end, definitions).map(link => ({ ...link, evidenceExcluded: excluded })));
    const linkOnly = kind === 'paragraph' && /^[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(?:!?\[\[[^\r\n]+?\]\][ \t]*)+$/.test(line.text);
    if (excluded || linkOnly || !line.text.trim()) { finish(); continue; }
    if (current && current.kind !== kind) finish();
    if (!current) current = { kind, start: line.start, end, headingPath: headings.map(h => h.title) };
    else current.end = end;
    if (kind !== 'code') {
      const withoutCode = line.text.replace(/`+[^`]*`+/g, '');
      for (const match of withoutCode.matchAll(/(?:^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu)) tags.add(match[1]);
    }
    if (kind === 'heading' || isFence) finish();
  }
  finish();
  links.unshift(...scanLinks(text, 0, bodyStart));
  const chunks = [];
  for (const [block, value] of blocks.entries()) {
    let start = value.start;
    while (start < value.end) {
      let end = Math.min(start + 1200, value.end);
      if (end < value.end && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      if (end < value.end) {
        const newline = text.lastIndexOf('\n', end - 1);
        if (newline > start + 400) end = newline + 1;
      }
      const passage = text.slice(start, end);
      if (passage.trim()) chunks.push({ block, headingPath: value.headingPath, source: sourceRange(text, start, end), passage });
      start = end;
    }
  }
  return { frontmatter, bodyStart, outline, blocks, chunks, links, tags: [...tags], aliases: frontmatterList(frontmatter, 'aliases') };
}

export function resolveLink(link, from, notes) {
  let target;
  try { target = decodeURIComponent(link.target); } catch { return { resolution: 'unresolved', candidates: [] }; }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return { resolution: 'external', candidates: [] };
  if (!target) return { resolution: 'resolved', candidates: [from] };
  const clean = target.replace(/\.md$/i, '');
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
  const root = clean.replace(/^\//, '');
  const withoutExtension = name => name.replace(/\.md$/i, '');
  let candidates = notes.filter(note => withoutExtension(note.path) === relative).map(note => note.path);
  if (!candidates.length && link.kind === 'wiki') candidates = notes.filter(note => withoutExtension(note.path) === root).map(note => note.path);
  if (!candidates.length && link.kind !== 'wiki' && target.startsWith('/')) candidates = notes.filter(note => withoutExtension(note.path) === root).map(note => note.path);
  if (!candidates.length && link.kind === 'wiki') {
    candidates = notes.filter(note => withoutExtension(path.posix.basename(note.path)) === clean || (note.aliases ?? []).includes(clean) || withoutExtension(note.path).endsWith(`/${clean}`)).map(note => note.path);
  }
  return { resolution: candidates.length === 1 ? 'resolved' : candidates.length ? 'ambiguous' : 'unresolved', candidates };
}
