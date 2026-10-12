import { readdirSync } from 'node:fs';
import path from 'node:path';
import { readNote, revision, portableFold, refuse } from './paths.mjs';
import { documentSpans, frontmatterFields, parseMarkdown } from './markdown.mjs';

const posix = path.posix;
const sorted = values => [...new Set(values)].sort();
const noMd = name => name.replace(/\.md$/i, '');
const labelKey = label => label.replace(/\\([\p{P}\p{S}])/gu, '$1').trim().replace(/\s+/g, ' ').toLowerCase();
const external = target => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target);
const indentation = text => [...(/^[ \t]*/.exec(text)?.[0] ?? '')].reduce((column, char) => char === '\t' ? column + 4 - column % 4 : column + 1, 0);
const escaped = (text, offset) => { let count = 0; while (offset > 0 && text[--offset] === '\\') count++; return count % 2 === 1; };

export function moveInventory(root) {
  const names = [];
  function visit(parent) {
    for (const entry of readdirSync(path.join(root, parent), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const name = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) names.push(name);
    }
  }
  visit('');
  return names.sort();
}

export function scanMoveVault(root, { maxNotes = 10000, maxBytes = 256 * 1024 * 1024 } = {}) {
  const inventory = [];
  const notes = [];
  const blockers = [];
  let size = 0;
  function visit(parent) {
    let entries;
    try { entries = readdirSync(path.join(root, parent), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0); }
    catch (error) { blockers.push({ path: parent, reason: `Unreadable directory: ${error.code}`, code: 'MOVE_SCAN_INCOMPLETE' }); return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const name = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        if (/\.md$/i.test(name)) blockers.push({ path: name, reason: 'Skipped symbolic-link Markdown.', code: 'MOVE_SCAN_INCOMPLETE' });
        continue;
      }
      if (entry.isDirectory()) { visit(name); continue; }
      if (!entry.isFile()) continue;
      inventory.push(name);
      if (!/\.md$/i.test(name)) continue;
      if (notes.length >= maxNotes) refuse('MOVE_SCAN_LIMIT', `The fresh scan exceeds ${maxNotes} Markdown notes.`);
      try {
        const current = readNote(root, name);
        if (current.bytes.includes(0) || current.stat.nlink !== 1) throw new Error('NUL or unexpected hard link');
        size += current.bytes.length;
        if (size > maxBytes) refuse('MOVE_SCAN_LIMIT', `The fresh scan exceeds ${maxBytes} Markdown bytes.`);
        notes.push({ path: name, bytes: current.bytes, revision: current.revision, mode: current.stat.mode & 0o777 });
      } catch (error) {
        if (error.code === 'MOVE_SCAN_LIMIT') throw error;
        blockers.push({ path: name, reason: `Unreadable Markdown: ${error.message}`, code: 'MOVE_SCAN_INCOMPLETE' });
      }
    }
  }
  visit('');
  return { inventory: inventory.sort(), notes, blockers, bytes: size };
}

function closingBracket(text, start, visible) {
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (!visible[i]) continue;
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '[') depth++;
    if (text[i] === ']' && --depth === 0) return i;
    if (text[i] === '\n' && text[i + 1] === '\n') break;
  }
  return -1;
}

function destinationAt(text, start, limit, inline) {
  let i = start;
  while (i < limit && /\s/.test(text[i])) i++;
  const angle = text[i] === '<';
  const begin = i + (angle ? 1 : 0);
  if (angle) {
    i++;
    while (i < limit && text[i] !== '>' && text[i] !== '\n' && text[i] !== '\r') { if (text[i] === '\\') i++; i++; }
    if (text[i] !== '>') return null;
  } else {
    let depth = 0;
    while (i < limit) {
      const c = text[i];
      if (c === '\\' && i + 1 < limit) { i += 2; continue; }
      if (/\s/.test(c) || c === ')' && depth === 0 && inline) break;
      if (c === '(') depth++;
      if (c === ')') { if (!depth) return null; depth--; }
      i++;
    }
    if (depth) return null;
  }
  const end = i;
  if (angle) i++;
  while (i < limit && /\s/.test(text[i])) i++;
  const titleStart = i;
  if (['"', "'", '('].includes(text[i])) {
    const close = text[i] === '(' ? ')' : text[i];
    i++;
    while (i < limit && text[i] !== close) { if (text[i] === '\\') i++; i++; }
    if (text[i] !== close) return null;
    i++;
    while (i < limit && /\s/.test(text[i])) i++;
  }
  if (inline ? text[i] !== ')' : i !== limit) return null;
  return { start: begin, end, angle, titleStart, finish: inline ? i + 1 : limit };
}

export function tokenizeMove(bytes, { visibility = false } = {}) {
  const document = documentSpans(bytes);
  const { text, lines, bodyStart } = document;
  const visible = new Uint8Array(text.length).fill(1);
  const yamlQuotes = new Uint8Array(text.length);
  const unsafe = [];
  const issues = [];
  const mask = (start, end) => visible.fill(0, start, end);
  let fence = null;
  let comment = null;
  let listDepth = null;
  const containers = [];
  const contexts = new Map();
  for (const [ordinal, line] of lines.entries()) {
    if (line.start < bodyStart) continue;
    const quotePrefix = /^(?:[ \t]*>[ \t]?)+/.exec(line.content)?.[0] ?? '';
    const depth = (quotePrefix.match(/>/g) ?? []).length;
    const content = line.content.slice(quotePrefix.length);
    const indent = /^ */.exec(content)[0].length;
    if (fence && content.trim() && (depth !== fence.depth || indent < fence.indent)) fence = null;
    if (fence) {
      mask(line.start, line.end);
      if (new RegExp(`^ {0,3}${fence.char}{${fence.count},}[ \\t]*$`).test(content.slice(fence.indent))) fence = null;
      continue;
    }
    if (!comment) {
      if (listDepth !== depth) { containers.length = 0; listDepth = depth; }
      if (containers.length && /^[ \t]*\t/.test(content)) issues.push({ start: line.start, end: line.end, line: ordinal + 1, code: 'AMBIGUOUS_REFERENCE', reason: 'Tab-indented continuation cannot be classified safely.' });
      if (content.trim()) while (containers.length && indent < containers.at(-1).content) containers.pop();
      const marker = /^( *)(?:[-+*]|\d{1,9}[.)])([ \t]+)/.exec(content);
      if (marker && (indent <= 3 || containers.length)) {
        if (marker[2].includes('\t') || marker[2].length > 4) issues.push({ start: line.start, end: line.end, line: ordinal + 1, code: 'AMBIGUOUS_REFERENCE', reason: 'List container padding cannot be classified safely.' });
        else containers.push({ content: marker[0].length });
      }
      const base = containers.at(-1)?.content ?? 0;
      const offset = quotePrefix.length + (marker && containers.length ? marker[0].length : Math.min(base, indent));
      contexts.set(line.start, offset);
      const remainder = line.content.slice(offset);
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(remainder);
      if (opening && visible[line.start + offset] && !(opening[1][0] === '`' && opening[2].includes('`'))) {
        fence = { char: opening[1][0], count: opening[1].length, depth, indent: marker ? marker[0].length : base };
        mask(line.start, line.end); continue;
      }
      if (indentation(remainder) >= 4) { mask(line.start, line.end); continue; }
    }
    for (let i = line.start; i < line.end; i++) {
      if (!visible[i]) continue;
      if (comment) {
        const close = text.indexOf(comment, i);
        const end = close < 0 ? text.length : close + comment.length;
        mask(i, Math.min(end, line.end));
        if (end <= line.end) { comment = null; i = end - 1; }
        else break;
      } else if (text.startsWith('<!--', i) || text.startsWith('%%', i)) {
        const html = text.startsWith('<!--', i);
        comment = html ? '-->' : '%%';
        mask(i, i + (html ? 4 : 2)); i += (html ? 4 : 2) - 1;
      } else if (text[i] === '`' && !escaped(text, i)) {
        let end = i; while (text[end] === '`') end++;
        const count = end - i;
        const blank = /\r?\n(?:[ \t]*>[ \t]?)*[ \t]*\r?\n/g;
        blank.lastIndex = end;
        const limit = blank.exec(text)?.index ?? text.length;
        let close = text.indexOf('`'.repeat(count), end);
        while (close >= 0 && (text[close - 1] === '`' || text[close + count] === '`')) close = text.indexOf('`'.repeat(count), close + count);
        if (close >= 0 && close < limit) {
          const span = text.slice(end, close);
          if (/\n[ \t]*(?:>|[-+*] |\d+[.)] |`{3,}|~{3,})/.test(span)) issues.push({ start: i, end: close + count, line: ordinal + 1, code: 'AMBIGUOUS_REFERENCE', reason: 'Inline code crosses an uncertain container or block boundary.' });
          else { mask(i, close + count); i = close + count - 1; }
        }
        else i = end - 1;
      }
    }
  }
  if (document.closing >= 0) {
    mask(0, lines[0].end); mask(lines[document.closing].start, bodyStart);
    let fields;
    try { fields = frontmatterFields(document); }
    catch (error) {
      if (/\[\[|\]\(|\]\[|\\[uxU]/.test(text.slice(0, bodyStart))) issues.push({ start: 0, end: bodyStart, reason: `Unsupported link-bearing YAML: ${error.message}` });
      fields = [];
    }
    for (const field of fields) if (field.block) unsafe.push({ start: field.valueStart, end: field.end, reason: 'Block-scalar links have no supported scalar mapping.' });
    for (const line of lines.filter(line => line.start > lines[0].start && line.end <= bodyStart)) {
      let quote = null;
      for (let i = line.start; i < line.end; i++) {
        yamlQuotes[i] = quote === "'" ? 1 : quote === '"' ? 2 : 0;
        if (quote) {
          if (quote === '"' && text[i] === '\\') {
            if (/[uxU]/.test(text[i + 1] ?? '')) unsafe.push({ start: line.start, end: line.end, reason: 'Encoded YAML string has no exact link mapping.' });
            i++;
          } else if (text[i] === quote) {
            if (quote === "'" && text[i + 1] === "'") i++; else quote = null;
          }
        } else if (text[i] === '"' || text[i] === "'") quote = text[i];
        else if (text[i] === '#' && (i === line.start || /\s/.test(text[i - 1]))) { mask(i, line.end); break; }
      }
      const key = /^\s*(?:[\w.-]+|"(?:\\.|[^"\\])*"|'(?:''|[^'])*')\s*:\s*/.exec(line.content);
      if (key) mask(line.start, line.start + key[0].length);
      if (/\\[uxU](?:005[bBdD]|0*5[bBdD]|0*9[13])/i.test(line.content)) issues.push({ start: line.start, end: line.end, reason: 'Encoded YAML brackets prevent exact link mapping.' });
    }
  }
  const definitions = new Map();
  const tokens = [];
  function add(kind, span, end, extra = {}) {
    const raw = text.slice(span.start, span.end);
    if (!external(raw) && /[&\\]/.test(raw)) issues.push({ start: span.start, end: span.end, line: text.slice(0, span.start).split('\n').length, code: 'AMBIGUOUS_REFERENCE', reason: 'Escaped or character-reference destinations are unsupported.' });
    const fragment = raw.indexOf('#');
    const pathEnd = fragment < 0 ? span.end : span.start + fragment;
    const token = { kind, start: span.start, end: pathEnd, target: text.slice(span.start, pathEnd), fragment: fragment < 0 ? '' : raw.slice(fragment), angle: span.angle ?? false, finish: end, ...extra };
    token.yamlQuote = yamlQuotes[span.start] === 1 ? "'" : yamlQuotes[span.start] === 2 ? '"' : null;
    if (kind === 'wiki') {
      const leading = /^\s*/.exec(token.target)[0].length;
      const trailing = /\s*$/.exec(token.target)[0].length;
      token.start += leading;
      token.end = Math.max(token.start, token.end - trailing);
      token.target = text.slice(token.start, token.end);
    }
    token.startByte = Buffer.byteLength(text.slice(0, token.start));
    token.endByte = Buffer.byteLength(text.slice(0, token.end));
    token.unsafe = unsafe.find(item => item.start <= token.start && item.end >= token.end)?.reason ?? null;
    tokens.push(token);
    return token;
  }
  for (let ordinal = 0; ordinal < lines.length; ordinal++) {
    const line = lines[ordinal];
    if (line.start < bodyStart) continue;
    const offset = contexts.get(line.start) ?? 0;
    if (!visible[line.start + offset]) continue;
    const match = /^ {0,3}\[((?:\\.|[^\]\\\n])+)\]:[ \t]*/.exec(line.content.slice(offset));
    if (!match) continue;
    if (/\\[\[\]]/.test(match[1])) { issues.push({ start: line.start, end: line.end, line: ordinal + 1, code: 'AMBIGUOUS_REFERENCE', reason: 'Reference labels containing escaped brackets are unsupported.' }); mask(line.start, line.end); continue; }
    let last = ordinal;
    const begin = line.start + offset + match[0].length;
    if (!text.slice(begin, line.start + line.content.length).trim()) {
      const next = lines[last + 1];
      if (next && /^ {0,3}\S/.test(next.content) && visible[next.start + /^ */.exec(next.content)[0].length]) last++;
    }
    const title = lines[last + 1];
    if (title && /^ {0,3}["'(]/.test(title.content) && visible[title.start + /^ */.exec(title.content)[0].length]) last++;
    const tail = lines[last];
    const span = destinationAt(text, begin, tail.start + tail.content.length, false);
    if (!span || span.start === span.end) {
      issues.push({ start: line.start, end: tail.end, line: ordinal + 1, reason: 'Unlocatable reference definition destination.' }); mask(line.start, tail.end); continue;
    }
    const label = labelKey(match[1]);
    const token = add('reference', span, tail.end, { label });
    const entries = definitions.get(label) ?? [];
    entries.push(token); definitions.set(label, entries);
    mask(line.start, tail.end);
    ordinal = last;
  }
  for (let i = 0; i < text.length; i++) {
    if (!visible[i]) continue;
    if (text[i] === '\\') { i++; continue; }
    if (text[i] !== '[') {
      if (text[i] === '<' && /^(?:<a\b[^>]*href\s*=|<img\b[^>]*src\s*=)/i.test(text.slice(i))) issues.push({ start: i, end: text.indexOf('>', i) + 1 || text.length, reason: 'HTML link-bearing syntax is unsupported.' });
      continue;
    }
    if (text[i + 1] === '[') {
      const end = text.indexOf(']]', i + 2);
      if (end < 0 || !visible[end] || text.slice(i + 2, end).includes('\n')) { issues.push({ start: i, end: end < 0 ? text.length : end + 2, reason: 'Unlocatable wiki destination.' }); continue; }
      const pipe = text.indexOf('|', i + 2);
      const pathEnd = pipe >= 0 && pipe < end ? pipe : end;
      add('wiki', { start: i + 2, end: pathEnd }, end + 2, { embed: text[i - 1] === '!', alias: pathEnd < end ? text.slice(pathEnd + 1, end) : null });
      if (text.slice(i + 2, pathEnd).includes('[')) issues.push({ start: i, end: end + 2, reason: 'Nested wiki destination is unsupported.' });
      i = end + 1;
      continue;
    }
    if (i < bodyStart && !yamlQuotes[i]) continue;
    const close = closingBracket(text, i, visible);
    if (close < 0) continue;
    if (text[close + 1] === '(') {
      const span = destinationAt(text, close + 2, text.length, true);
      if (span) { add('markdown', span, span.finish, { embed: text[i - 1] === '!' }); i = span.finish - 1; }
      else { issues.push({ start: i, end: Math.max(close + 2, text.indexOf('\n', close) < 0 ? text.length : text.indexOf('\n', close)), reason: 'Unlocatable Markdown destination/title.' }); i = close; }
      continue;
    }
    let label = text.slice(i + 1, close);
    let end = close;
    if (text[close + 1] === '[') {
      const labelEnd = closingBracket(text, close + 1, visible);
      if (labelEnd >= 0) { label = text.slice(close + 2, labelEnd) || label; end = labelEnd; }
    }
    const entries = definitions.get(labelKey(label));
    if (/\\[\[\]]/.test(label)) issues.push({ start: i, end: end + 1, line: text.slice(0, i).split('\n').length, code: 'AMBIGUOUS_REFERENCE', reason: 'Reference labels containing escaped brackets are unsupported.' });
    if (entries?.length > 1) for (const token of entries) token.duplicate = true;
    i = end;
  }
  for (const entries of definitions.values()) if (entries.length > 1) for (const token of entries) token.duplicate = true;
  return { tokens, issues, aliases: parseMarkdown(text).aliases, ...(visibility ? { visible, contexts, unclosedFence: fence } : {}) };
}

function inventoryIndex(names, notes) {
  const exact = new Set(names);
  const folded = new Map();
  const basenames = new Map();
  const aliases = new Map();
  for (const name of names) {
    const fold = portableFold(name);
    folded.set(fold, [...(folded.get(fold) ?? []), name]);
    const base = noMd(posix.basename(name));
    basenames.set(base, [...(basenames.get(base) ?? []), name]);
  }
  for (const note of notes) for (const alias of note.aliases ?? []) aliases.set(alias, [...(aliases.get(alias) ?? []), note.path]);
  return { names, exact, folded, basenames, aliases };
}

function lexical(source, target) {
  const name = target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(posix.dirname(source), target));
  return name === '..' || name.startsWith('../') || name.startsWith('/') ? null : name;
}

export function resolveMoveTarget(token, source, index) {
  const raw = token.yamlQuote === "'" ? token.target.replaceAll("''", "'") : token.target;
  if (external(raw)) return { state: 'external', candidates: [] };
  let target;
  try { target = token.kind === 'wiki' ? raw : decodeURIComponent(raw.replace(/\\([\p{P}\p{S}])/gu, '$1')); }
  catch { return { state: 'ambiguous', candidates: [], reason: 'Malformed percent escape.', lexical: raw }; }
  if (target.includes('\\') || target.includes('\0')) return { state: 'ambiguous', candidates: [], reason: 'Unsupported path escaping.', lexical: target };
  if (!target && token.fragment) return { state: 'resolved', candidates: [source], identity: source, self: true };
  if (!target) return { state: 'missing', candidates: [], lexical: null };
  let candidates = [];
  let alternatives = [];
  let absolute = null;
  const exact = name => {
    if (!name) return [];
    if (index.exact.has(name)) return [name];
    if (!/\.md$/i.test(name) && index.exact.has(`${name}.md`)) return [`${name}.md`];
    return [];
  };
  const folded = name => sorted([...(index.folded.get(portableFold(name ?? '')) ?? []), ...(!/\.md$/i.test(name ?? '') ? index.folded.get(portableFold(`${name}.md`)) ?? [] : [])]);
  if (token.kind !== 'wiki' || /^(?:\.\.?\/|\/)/.test(target)) {
    absolute = lexical(source, target);
    candidates = exact(absolute);
    alternatives = folded(absolute);
  } else if (target.includes('/')) {
    absolute = posix.normalize(target);
    candidates = exact(absolute);
    const rootMatched = candidates.length > 0;
    if (!candidates.length) candidates = index.names.filter(name => noMd(name).endsWith(`/${noMd(target)}`));
    const relative = exact(lexical(source, target));
    candidates = sorted([...candidates, ...relative]);
    alternatives = sorted([...folded(absolute), ...folded(lexical(source, target)), ...(rootMatched ? [] : index.names.filter(name => portableFold(noMd(name)).endsWith(`/${portableFold(noMd(target))}`)))]);
  } else {
    candidates = index.basenames.get(noMd(target)) ?? [];
    alternatives = index.names.filter(name => portableFold(noMd(posix.basename(name))) === portableFold(noMd(target)));
  }
  const all = sorted([...candidates, ...alternatives]);
  if (all.length > 1 || !candidates.length && alternatives.length || candidates.some(name => (index.folded.get(portableFold(name)) ?? []).length > 1)) return { state: 'ambiguous', candidates: all, reason: 'Ambiguous basename, path spelling, suffix or source-relative alternative.', lexical: absolute };
  if (candidates.length === 1) return { state: 'resolved', candidates, identity: candidates[0], lexical: absolute };
  const alias = sorted([...index.aliases].filter(([name]) => portableFold(name) === portableFold(target)).flatMap(([, names]) => names));
  if (alias.length && token.kind === 'wiki') return { state: 'ambiguous', candidates: alias, reason: 'Alias-only targets do not establish filesystem identity.', lexical: absolute };
  return { state: 'missing', candidates: [], lexical: absolute };
}

function encodePath(target, token) {
  if (token.kind === 'wiki') return target;
  const oldSegments = token.target.split('/');
  const preserved = new Map();
  for (const segment of oldSegments) {
    try { preserved.set(decodeURIComponent(segment.replace(/\\([\p{P}\p{S}])/gu, '$1')), segment); } catch {}
  }
  return target.split('/').map(segment => preserved.get(segment) ?? encodeURIComponent(segment).replaceAll('(', '%28').replaceAll(')', '%29').replaceAll("'", '%27')).join('/');
}

function repairedTarget(token, source, identity, index, missing = false) {
  if (!token.target && token.fragment && identity === source) return '';
  const omitMd = /\.md$/i.test(identity) && !/\.md$/i.test(token.target);
  let target;
  if (token.kind !== 'wiki' || /^(?:\.\.?\/|\/)/.test(token.target) || missing) {
    target = token.target.startsWith('/') ? `/${identity}` : posix.relative(posix.dirname(source), identity) || posix.basename(identity);
    if (token.kind === 'wiki' && !target.startsWith('/') && !target.startsWith('../')) target = `./${target}`;
    if (token.kind !== 'wiki' && token.target.startsWith('./') && !target.startsWith('.') && !target.startsWith('/')) target = `./${target}`;
    if (omitMd) target = noMd(target);
  } else {
    const parts = identity.split('/');
    for (let count = 1; count <= parts.length; count++) {
      const candidate = parts.slice(-count).join('/');
      const spelling = omitMd ? noMd(candidate) : candidate;
      const resolved = resolveMoveTarget({ ...token, target: spelling }, source, index);
      if (resolved.state === 'resolved' && resolved.identity === identity) { target = spelling; break; }
    }
    if (target === undefined) target = `/${omitMd ? noMd(identity) : identity}`;
  }
  const encoded = encodePath(target, token);
  return token.yamlQuote === "'" ? encoded.replaceAll("'", "''") : encoded;
}

export function applySplices(bytes, splices) {
  const ordered = [...splices].sort((a, b) => a.startByte - b.startByte);
  const pieces = [];
  let end = 0;
  for (const splice of ordered) {
    if (splice.startByte < end || splice.endByte < splice.startByte || splice.endByte > bytes.length) refuse('AMBIGUOUS_REFERENCE', 'Overlapping or invalid destination byte ranges.');
    pieces.push(bytes.subarray(end, splice.startByte), Buffer.from(splice.replacement));
    end = splice.endByte;
  }
  pieces.push(bytes.subarray(end));
  return Buffer.concat(pieces);
}

export function planMove(scan, source, destination) {
  const blockers = [...scan.blockers];
  const notes = scan.notes.map(note => {
    try { return { ...note, ...tokenizeMove(note.bytes) }; }
    catch (error) { blockers.push({ path: note.path, reason: `Cannot establish link completeness: ${error.message}`, code: 'MOVE_SCAN_INCOMPLETE' }); return { ...note, aliases: [], tokens: [], issues: [] }; }
  });
  const original = notes.find(note => note.path === source);
  if (!original) refuse('NOTE_NOT_FOUND', 'The requested source was not present in the fresh scan.', [source]);
  const oldIndex = inventoryIndex(scan.inventory, notes);
  const newNames = scan.inventory.map(name => name === source ? destination : name);
  const newIndex = inventoryIndex(newNames, notes.map(note => ({ ...note, path: note.path === source ? destination : note.path })));
  if (source !== destination && new Set(newNames).size !== newNames.length) blockers.push({ path: destination, reason: 'The move destination already exists.', code: 'DESTINATION_EXISTS' });
  if (source !== destination && portableFold(source) === portableFold(destination)) blockers.push({ path: destination, reason: 'Case-only or normalization-only moves are refused.', code: 'CASE_COLLISION' });
  const planned = [];
  const repairs = [];
  for (const note of notes) {
    const afterPath = note.path === source ? destination : note.path;
    const splices = [];
    for (const issue of note.issues) blockers.push({ path: note.path, line: issue.line ?? note.bytes.toString('utf8').slice(0, issue.start).split('\n').length, startByte: Buffer.byteLength(note.bytes.toString('utf8').slice(0, issue.start)), endByte: Buffer.byteLength(note.bytes.toString('utf8').slice(0, issue.end)), reason: issue.reason, code: issue.code ?? 'MOVE_SCAN_INCOMPLETE' });
    for (const token of note.tokens) {
      const before = resolveMoveTarget(token, note.path, oldIndex);
      const after = resolveMoveTarget(token, afterPath, newIndex);
      if (before.state === 'external') continue;
      const mapsSource = before.candidates.includes(source) || after.candidates.includes(destination);
      const relativeOutgoing = note.path === source && token.target && (token.kind !== 'wiki' && !token.target.startsWith('/') || /^(?:\.\.?\/)/.test(token.target));
      const intended = before.state === 'resolved' ? before.identity === source ? destination : before.identity : before.lexical;
      const changedBinding = before.state === 'resolved' ? after.state !== 'resolved' || after.identity !== intended : before.state === 'missing' && after.state !== 'missing';
      const affected = mapsSource || relativeOutgoing || changedBinding;
      if (!affected) continue;
      const reason = token.duplicate ? 'Duplicate reference definitions have ambiguous identity.' : token.unsafe ?? (before.state === 'ambiguous' ? before.reason : before.state === 'missing' && !relativeOutgoing ? 'A missing target would gain or change a binding.' : !intended ? 'The outgoing path cannot be rebased within the vault.' : null);
      if (reason) {
        blockers.push({ path: note.path, startByte: token.startByte, endByte: token.endByte, target: token.target, candidates: sorted([...before.candidates, ...after.candidates]), reason, code: 'AMBIGUOUS_REFERENCE' });
        continue;
      }
      if (!changedBinding && !relativeOutgoing && note.path !== source && before.identity !== source) continue;
      const target = repairedTarget(token, afterPath, intended, newIndex, before.state === 'missing');
      if (target === token.target) continue;
      if (note.path.startsWith('Notient/Log/')) {
        blockers.push({ path: note.path, startByte: token.startByte, endByte: token.endByte, reason: 'A historical managed log contains an affected live link.', code: 'AUDIT_LINK_BLOCKER' });
        continue;
      }
      const proof = resolveMoveTarget({ ...token, target }, afterPath, newIndex);
      if (before.state === 'missing' ? proof.state !== 'missing' || proof.lexical !== intended : proof.state !== 'resolved' || proof.identity !== intended) {
        blockers.push({ path: note.path, startByte: token.startByte, endByte: token.endByte, reason: 'The repaired target cannot prove the same identity.', code: 'AMBIGUOUS_REFERENCE' });
        continue;
      }
      const splice = { startByte: token.startByte, endByte: token.endByte, replacement: target };
      splices.push(splice); repairs.push({ path: note.path, afterPath, kind: token.kind, target: token.target, identity: intended, ...splice });
    }
    const bytes = applySplices(note.bytes, splices);
    const reparsed = tokenizeMove(bytes);
    if (reparsed.tokens.length !== note.tokens.length || reparsed.issues.length !== note.issues.length) blockers.push({ path: note.path, reason: 'The repaired document changes parsed link boundaries.', code: 'AMBIGUOUS_REFERENCE' });
    else for (let i = 0; i < note.tokens.length; i++) {
      const old = resolveMoveTarget(note.tokens[i], note.path, oldIndex);
      if (old.state !== 'resolved') continue;
      const expected = old.identity === source ? destination : old.identity;
      const fresh = resolveMoveTarget(reparsed.tokens[i], afterPath, newIndex);
      if (fresh.state !== 'resolved' || fresh.identity !== expected) blockers.push({ path: note.path, startByte: note.tokens[i].startByte, endByte: note.tokens[i].endByte, reason: 'Reparse failed to preserve a previously resolved identity.', code: 'AMBIGUOUS_REFERENCE' });
    }
    if (note.path === source || !bytes.equals(note.bytes)) planned.push({ path: note.path, afterPath, before: note.bytes, after: bytes, mode: note.mode, splices });
  }
  const uniqueBlockers = [...new Map(blockers.map(item => [JSON.stringify(item), item])).values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : (a.startByte ?? -1) - (b.startByte ?? -1));
  if (uniqueBlockers.length) return { ok: false, source, destination, files: [], repairs: [], blockers: uniqueBlockers.slice(0, 100), blockerCount: uniqueBlockers.length };
  if (source === destination) return { ok: true, source, destination, files: [], repairs: [], blockers: [], blockerCount: 0, reads: [], inventory: scan.inventory };
  const moved = planned.find(file => file.path === source);
  const files = [
    { path: destination, role: 'note', before: null, after: moved.after, mode: moved.mode, splices: moved.splices },
    ...planned.filter(file => file.path !== source).sort((a, b) => a.path < b.path ? -1 : 1).map(file => ({ ...file, role: 'note' })),
    { path: source, role: 'note', before: moved.before, after: null, mode: moved.mode, splices: [] },
  ];
  if (files.length > 100) refuse('MOVE_PLAN_LIMIT', 'The move exceeds 100 changed note paths.');
  const changed = new Set(files.map(file => file.path));
  return { ok: true, source, destination, files, repairs, blockers: [], blockerCount: 0, reads: scan.notes.filter(note => !changed.has(note.path) || note.path.startsWith('Notient/Log/')).map(note => ({ path: note.path, revision: note.revision })).sort((a, b) => a.path < b.path ? -1 : 1), inventory: scan.inventory };
}

export function guardInverseReferences(scan, files) {
  const blockers = [...scan.blockers];
  const changed = new Map(files.map(file => [file.path, file]));
  const notes = scan.notes.map(note => {
    try { return { ...note, ...tokenizeMove(note.bytes) }; }
    catch (error) { blockers.push({ path: note.path, reason: error.message }); return { ...note, aliases: [], tokens: [], issues: [] }; }
  });
  const names = new Set(scan.inventory);
  const proposed = notes.filter(note => !changed.has(note.path));
  for (const file of files) {
    if (file.after === null) names.delete(file.path);
    else {
      names.add(file.path);
      try { proposed.push({ path: file.path, ...tokenizeMove(file.after) }); }
      catch (error) { blockers.push({ path: file.path, reason: error.message }); }
    }
  }
  const beforeIndex = inventoryIndex(scan.inventory, notes);
  const afterIndex = inventoryIndex([...names].sort(), proposed);
  const changedNames = new Set(files.filter(file => file.before === null || file.after === null).map(file => file.path));
  for (const note of notes) {
    if (changed.has(note.path)) continue;
    for (const issue of note.issues) blockers.push({ path: note.path, line: issue.line ?? note.bytes.toString('utf8').slice(0, issue.start).split('\n').length, code: issue.code ?? 'AMBIGUOUS_REFERENCE', reason: issue.reason });
    for (const token of note.tokens) {
      const before = resolveMoveTarget(token, note.path, beforeIndex);
      const after = resolveMoveTarget(token, note.path, afterIndex);
      if (before.state === 'external') continue;
      const affected = before.state === 'resolved' ? after.state !== 'resolved' || after.identity !== before.identity : before.state === 'missing' ? after.state !== 'missing' : [...before.candidates, ...after.candidates].some(name => changedNames.has(name));
      if (affected) blockers.push({ path: note.path, startByte: token.startByte, endByte: token.endByte, target: token.target, code: note.path.startsWith('Notient/Log/') ? 'AUDIT_LINK_BLOCKER' : 'UNDO_REFERENCE_CONFLICT', reason: 'The inverse would leave an unselected reference dangling, rebound or ambiguous.' });
    }
  }
  return { blockers: blockers.slice(0, 100), blockerCount: blockers.length, reads: scan.notes.filter(note => !changed.has(note.path) || note.path.startsWith('Notient/Log/')).map(note => ({ path: note.path, revision: note.revision })).sort((a, b) => a.path < b.path ? -1 : 1), inventory: scan.inventory };
}
