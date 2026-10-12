import { documentSpans, frontmatterFields, headerParts, yamlKey, editFrontmatter } from './markdown.mjs';
import { applySplices, resolveMoveTarget } from './move.mjs';
import { referenceContext, wikiSpelling, validateTargetPath } from './link.mjs';
import { refuse } from './paths.mjs';

export const relations = ['supports', 'contradicts', 'extends', 'exemplifies', 'synthesizes'];
const unsupported = message => refuse('FRONTMATTER_UNSUPPORTED', message);

function yamlSpans(document, field) {
  const text = document.text;
  const limit = field.end;
  let nodes = 0;
  const lineAt = offset => document.lines.find(line => line.start <= offset && offset < line.end) ?? document.lines.at(-1);
  const indent = line => { if (/^ *\t/.test(line.content)) unsupported('Tabs make nested YAML indentation uncertain.'); return /^ */.exec(line.content)[0].length; };
  const nextData = offset => document.lines.find(line => line.start >= offset && line.start < limit && line.content.trim() && !/^\s*#/.test(line.content));
  function space(offset) {
    while (offset < limit) {
      if (/\s/.test(text[offset])) { offset++; continue; }
      if (text[offset] === '#' && (offset === 0 || /\s/.test(text[offset - 1]))) { const end = text.indexOf('\n', offset); offset = end < 0 ? limit : end + 1; continue; }
      break;
    }
    return offset;
  }
  function node(start, depth = 0) {
    if (++nodes > 4096 || depth > 8) unsupported('Nested YAML exceeds its bounded span parser.');
    start = space(start);
    const char = text[start];
    if (char === '[' || char === '{') {
      const mapping = char === '{'; const close = mapping ? '}' : ']';
      const result = { type: mapping ? 'map' : 'list', flow: true, start, items: [], properties: new Map(), trailingComma: false };
      let offset = space(start + 1);
      while (offset < limit && text[offset] !== close) {
        let key;
        let keyStart;
        if (mapping) {
          keyStart = offset;
          if (text[offset] === '"' || text[offset] === "'") { const keyNode = node(offset, depth + 1); if (keyNode.type !== 'string') unsupported('A flow map key must be a string.'); key = keyNode.value; offset = space(keyNode.end); }
          else { const end = text.indexOf(':', offset); if (end < 0 || end >= limit) unsupported('A flow map key has no colon.'); key = yamlKey(text.slice(offset, end).trim()); offset = end; }
          if (text[offset] !== ':' || key === '<<' || result.properties.has(key)) unsupported('Flow mapping keys are duplicate, reserved or uncertain.');
          offset = space(offset + 1);
        }
        const value = node(offset, depth + 1);
        if (mapping) result.properties.set(key, { ...value, key, keyStart }); else result.items.push(value);
        offset = space(value.end);
        result.trailingComma = false;
        if (text[offset] === ',') { result.trailingComma = true; offset = space(offset + 1); }
        else if (text[offset] !== close) unsupported('A flow collection has an uncertain item boundary.');
      }
      if (text[offset] !== close) unsupported('A flow collection has no supported closing span.');
      return { ...result, closeStart: offset, end: offset + 1, line: lineAt(start), last: mapping ? [...result.properties.values()].at(-1) : result.items.at(-1) };
    }
    if (char === '"' || char === "'") {
      let offset = start + 1;
      while (offset < limit) {
        if (char === '"' && text[offset] === '\\') { offset += 2; continue; }
        if (text[offset] === char) { if (char === "'" && text[offset + 1] === "'") { offset += 2; continue; } break; }
        if (/\r|\n/.test(text[offset])) unsupported('Multiline string quoting is unsupported for relation spans.');
        offset++;
      }
      if (text[offset] !== char) unsupported('A quoted string has no closing span.');
      const raw = text.slice(start, offset + 1);
      let value;
      try { value = char === '"' ? JSON.parse(raw) : raw.slice(1, -1).replaceAll("''", "'"); } catch { unsupported('A quoted string uses unsupported YAML escapes.'); }
      return { type: 'string', value, start, end: offset + 1, line: lineAt(start) };
    }
    let end = start;
    while (end < limit && !/[\r\n,\]}]/.test(text[end]) && !(text[end] === '#' && /\s/.test(text[end - 1] ?? ' '))) end++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    const value = text.slice(start, end);
    if (!value || /^(?:[&*!]|<<\s*:)/.test(value) || /:\s/.test(value)) unsupported('A plain scalar has an unsupported or uncertain boundary.');
    const type = /^(?:null|~)$/i.test(value) ? 'null' : /^(?:true|false|yes|no|on|off|\.nan|[+-]?\.inf)$/i.test(value) || /^[+-]?(?:\d|\.\d)/.test(value) ? 'scalar' : 'string';
    return { type, value, start, end, line: lineAt(start) };
  }
  function child(line, parts, depth, keyIndent) {
    const start = line.start + keyIndent + parts.prefix.length;
    const value = parts.value.replace(/\s+#.*$/, '').trim();
    if (value && !value.startsWith('#')) {
      if (/^[|>]/.test(value)) {
        let last = line;
        for (const next of document.lines.filter(next => next.start >= line.end && next.start < limit)) { if (next.content.trim() && indent(next) <= keyIndent) break; if (next.content.trim()) last = next; }
        return { type: 'opaque', start, end: last.end, line, lastLine: last };
      }
      const parsed = node(start, depth);
      const tail = text.slice(parsed.end, lineAt(parsed.end - 1).start + lineAt(parsed.end - 1).content.length).trim();
      if (tail && !tail.startsWith('#')) unsupported('A scalar has unsupported trailing content.');
      const after = nextData(lineAt(parsed.end - 1).end);
      if (after && indent(after) > keyIndent) unsupported('A scalar has an ambiguous indented continuation.');
      return parsed;
    }
    const first = nextData(line.end);
    if (first && (indent(first) > keyIndent || indent(first) === keyIndent && /^\s*-[ \t]+/.test(first.content))) return block(first, depth + 1);
    return { type: 'null', start, end: start, line };
  }
  function block(first, depth) {
    if (++nodes > 4096 || depth > 8) unsupported('Nested YAML exceeds its bounded span parser.');
    const level = indent(first);
    const list = /^\s*-[ \t]+/.test(first.content);
    const result = { type: list ? 'list' : 'map', flow: false, start: first.start, line: first, indent: level, items: [], properties: new Map() };
    let line = first;
    let lastLine = first;
    while (line && indent(line) === level) {
      const raw = line.content.slice(level);
      let value;
      if (list) {
        const marker = /^-[ \t]+/.exec(raw);
        if (!marker) break;
        value = node(line.start + level + marker[0].length, depth + 1);
        const tail = text.slice(value.end, lineAt(value.end - 1).start + lineAt(value.end - 1).content.length).trim();
        if (tail && !tail.startsWith('#')) unsupported('A list member has unsupported trailing content.');
        result.items.push(value);
      } else {
        if (/^-/.test(raw)) break;
        const parts = headerParts({ content: raw });
        if (parts.key === '<<' || result.properties.has(parts.key)) unsupported('Nested mapping keys are duplicate or reserved.');
        value = child(line, parts, depth + 1, level);
        result.properties.set(parts.key, { ...value, key: parts.key, keyStart: line.start + level, propertyLine: line });
      }
      lastLine = value.lastLine ?? lineAt(Math.max(value.start, value.end - 1));
      const next = nextData(lastLine.end);
      if (next && indent(next) > level) unsupported('Nested YAML has an uncertain continuation.');
      line = next;
    }
    return { ...result, end: lastLine.end, lastLine, last: list ? result.items.at(-1) : [...result.properties.values()].at(-1) };
  }
  const header = document.lines.find(line => line.start === field.start);
  const value = field.value.replace(/\s+#.*$/, '').trim();
  const root = value && !value.startsWith('#') ? node(field.valueStart) : child(header, { prefix: text.slice(field.start, field.valueStart), value: field.value }, 0, 0);
  return { root, lineAt, indent };
}

function localNewline(document, ...lines) {
  const endings = new Set(lines.map(line => line?.ending).filter(Boolean));
  if (endings.size > 1) refuse('MIXED_NEWLINE_EDIT', 'The relation insertion boundary has mixed line separators.');
  return [...endings][0] ?? document.newline;
}

function appendFlow(document, node, value, spans, changes) {
  const last = node.last;
  const closeLine = spans.lineAt(node.closeStart);
  if (!last || spans.lineAt(last.end - 1) === closeLine) {
    changes.push({ start: node.closeStart, end: node.closeStart, replacement: `${last && !node.trailingComma ? ', ' : ''}${value}` });
    return;
  }
  if (!node.trailingComma) changes.push({ start: last.end, end: last.end, replacement: ',' });
  const lastLine = spans.lineAt(last.end - 1);
  const newline = localNewline(document, lastLine, closeLine);
  const padding = spans.indent(lastLine) > spans.indent(closeLine) ? spans.indent(lastLine) : spans.indent(closeLine) + 2;
  changes.push({ start: closeLine.start, end: closeLine.start, replacement: `${' '.repeat(padding)}${value}${newline}` });
}

export function relationSpans(bytes) {
  const document = documentSpans(bytes);
  try {
    const field = frontmatterFields(document).find(field => field.key === 'notient');
    if (!field) return [];
    const root = yamlSpans(document, field).root;
    if (root.type !== 'map') return [];
    return relations.flatMap(relation => {
      const list = root.properties.get(relation);
      return list?.type === 'list' && list.items.every(item => item.type === 'string') ? list.items.filter(item => /^\[\[[^\[\]\r\n]+\]\]$/.test(item.value)).map(item => ({ relation, start: item.start, end: item.end })) : [];
    });
  } catch { return []; }
}

export function planRelate(scan, source, input, { origin = 'operator' } = {}) {
  if (!input || Object.keys(input).some(key => !['target', 'relation'].includes(key)) || !relations.includes(input.relation)) refuse('INVALID_INPUT', 'Supply one target and one of the five distinct relation names.');
  validateTargetPath(input.target);
  if (!['operator', 'unattended'].includes(origin)) refuse('EMBEDDING_OFF', 'Clio relationship writes are unavailable until stage 4b.');
  const context = referenceContext(scan, source);
  const spelling = wikiSpelling(context, source, input.target);
  const before = context.current.bytes;
  const document = documentSpans(before);
  const fields = frontmatterFields(document);
  const field = fields.find(field => field.key === 'notient');
  const relate = { target: input.target, relation: input.relation };
  const output = edited => ({ ...edited, relate, reads: context.reads, inventory: context.inventory });
  const quoted = JSON.stringify(`[[${spelling}]]`);
  if (Buffer.byteLength(quoted) > 4096) refuse('RELATION_LIMIT', 'The generated relationship exceeds the frontmatter value bound.');
  if (!field) return output(editFrontmatter(before, [{ key: 'notient', valueJson: JSON.stringify({ [input.relation]: [`[[${spelling}]]`] }) }]));
  if (/\r(?!\n)/.test(document.text.slice(0, document.bodyStart))) unsupported('Nested YAML with bare CR is unsupported.');
  const spans = yamlSpans(document, field);
  const root = spans.root;
  const changes = [];
  if (root.type === 'null') changes.push({ start: root.start, end: root.end, replacement: `{${JSON.stringify(input.relation)}: [${quoted}]}${document.text[root.end] === '#' ? ' ' : ''}` });
  else {
    if (root.type !== 'map') refuse('RELATION_TYPE', 'Frontmatter notient must be a map or null.');
    const relation = root.properties.get(input.relation);
    if (!relation) {
      if (root.flow) appendFlow(document, root, `${JSON.stringify(input.relation)}: [${quoted}]`, spans, changes);
      else {
        const newline = localNewline(document, root.lastLine);
        changes.push({ start: root.lastLine.end, end: root.lastLine.end, replacement: `${root.lastLine.ending ? '' : newline}${' '.repeat(root.indent)}${input.relation}: [${quoted}]${newline}` });
      }
    } else if (relation.type === 'null') changes.push({ start: relation.start, end: relation.end, replacement: `[${quoted}]${document.text[relation.end] === '#' ? ' ' : ''}` });
    else {
      if (relation.type !== 'list' || relation.items.some(item => item.type !== 'string')) refuse('RELATION_TYPE', 'A relation must be a string list or null.');
      const matching = relation.items.some(item => {
        const match = /^\[\[([^#|\[\]\r\n]+)(?:\|[^\[\]\r\n]*)?\]\]$/.exec(item.value);
        return match && resolveMoveTarget({ kind: 'wiki', target: match[1].trim(), fragment: '' }, source, context.index).identity === input.target;
      });
      if (matching) return output({ bytes: before, splices: [] });
      if (Buffer.byteLength(JSON.stringify([...relation.items.map(item => item.value), `[[${spelling}]]`])) > 4096) refuse('RELATION_LIMIT', 'The updated relationship list exceeds the frontmatter value bound.');
      if (relation.flow) appendFlow(document, relation, quoted, spans, changes);
      else {
        const newline = localNewline(document, relation.lastLine, relation.propertyLine);
        changes.push({ start: relation.lastLine.end, end: relation.lastLine.end, replacement: `${relation.lastLine.ending ? '' : newline}${' '.repeat(relation.indent)}- ${quoted}${newline}` });
      }
    }
  }
  const splices = changes.map(change => ({ startByte: Buffer.byteLength(document.text.slice(0, change.start)), endByte: Buffer.byteLength(document.text.slice(0, change.end)), replacement: change.replacement }));
  const after = applySplices(before, splices);
  frontmatterFields(documentSpans(after));
  return output({ bytes: after, splices });
}
