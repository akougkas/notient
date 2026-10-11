import path from 'node:path';

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
  let offset = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    lines.push({ text: line.replace(/\r?\n$/, ''), start: offset, end: offset + line.length });
    offset += line.length;
  }
  let bodyStart = 0;
  let frontmatter = '';
  if (lines[0]?.text.replace(/^\uFEFF/, '') === '---') {
    const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line.text));
    if (end < 0) throw new Error('Frontmatter has no closing delimiter.');
    bodyStart = lines[end].end;
    frontmatter = text.slice(0, bodyStart);
  }
  const outline = [];
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
    if (excluded || !line.text.trim()) { finish(); continue; }
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
