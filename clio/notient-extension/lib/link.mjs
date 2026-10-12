import { documentSpans, parseMarkdown } from './markdown.mjs';
import { tokenizeMove, inventoryIndex, resolveMoveTarget, applySplices } from './move.mjs';
import { refuse, validText, portableName, revision, portableFold } from './paths.mjs';

const noMd = name => name.replace(/\.md$/i, '');
const fragment = edge => edge.heading !== undefined ? `#${edge.heading}` : edge.block !== undefined ? `#^${edge.block}` : '';

export function validateTargetPath(name) {
  validText(name, 'Target path');
  if (!name.length || name.length > 4096 || !/\.md$/i.test(name)) refuse('INVALID_PATH', 'Use an exact vault-relative Markdown target.', [name]);
  name.split('/').forEach(portableName);
  return name;
}

export function referenceContext(scan, source) {
  if (scan.blockers?.length) refuse('LINK_SCAN_INCOMPLETE', `A fresh reference scan is incomplete: ${JSON.stringify(scan.blockers)}`, scan.blockers.map(blocker => blocker.path));
  const notes = scan.notes.map(note => ({ ...note, aliases: parseMarkdown(note.bytes.toString('utf8'), note.path).aliases }));
  const current = notes.find(note => note.path === source);
  if (!current) refuse('NOTE_NOT_FOUND', 'The source note is absent from the fresh scan.', [source]);
  const index = inventoryIndex(scan.inventory, notes);
  const reads = notes.map(note => ({ path: note.path, revision: revision(note.bytes) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { notes, current, index, reads, inventory: scan.inventory };
}

export function wikiSpelling(context, source, target) {
  validateTargetPath(target);
  const targetNote = context.notes.find(note => note.path === target);
  if (!targetNote) refuse('TARGET_NOT_FOUND', 'The named Markdown target is absent.', [target]);
  if (source === target) refuse('SELF_LINK', 'A relationship must name another note.', [target]);
  const parts = noMd(target).split('/');
  const choices = Array.from({ length: parts.length }, (_, index) => parts.slice(-index - 1).join('/'));
  choices.push(`/${noMd(target)}`);
  for (const spelling of choices) {
    if (/[\[\]|#&\\\r\n]/.test(spelling)) continue;
    const resolved = resolveMoveTarget({ kind: 'wiki', target: spelling, fragment: '' }, source, context.index);
    if (resolved.state === 'resolved' && resolved.identity === target) return spelling;
  }
  refuse('AMBIGUOUS_REFERENCE', 'No safe exact wiki spelling uniquely resolves the target.', [target]);
}

function visibleHeading(line, bodyStart, visible) {
  const bom = line.start === bodyStart && line.content.startsWith('\uFEFF') ? 1 : 0;
  const text = line.content.slice(bom);
  const match = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(text);
  if (!match) return null;
  const offset = line.start + bom + /^ */.exec(text)[0].length;
  if (!visible[offset] || !visible[offset + match[1].length]) return null;
  return { level: match[1].length, title: match[2], line, atx: true };
}

export function requireAnchor(note, edge) {
  for (const key of ['heading', 'block']) if (edge[key] !== undefined) {
    validText(edge[key], key);
    if (!edge[key].trim() || edge[key].length > (key === 'heading' ? 200 : 80) || /[\[\]|#\r\n]/.test(edge[key]) || key === 'heading' && /[*`<>\\]/.test(edge[key]) || key === 'block' && !/^[A-Za-z0-9_-]+$/.test(edge[key])) refuse('INVALID_QUALIFIER', 'Use one safe plain heading or block identifier.', [note.path]);
  }
  if (edge.heading !== undefined && edge.block !== undefined) refuse('INVALID_QUALIFIER', 'Heading and block qualifiers are mutually exclusive.', [note.path]);
  if (edge.heading === undefined && edge.block === undefined) return;
  const document = documentSpans(note.bytes);
  const tokenized = tokenizeMove(note.bytes, { visibility: true });
  if (tokenized.issues.length) refuse('AMBIGUOUS_REFERENCE', `Target anchor context is uncertain: ${JSON.stringify(tokenized.issues)}`, [note.path]);
  let matches;
  if (edge.heading !== undefined) matches = parseMarkdown(document.text, note.path).outline.filter(heading => portableFold(heading.title) === portableFold(edge.heading) && tokenized.visible[document.lines[heading.line - 1]?.start + /^ */.exec(document.lines[heading.line - 1]?.content ?? '')[0].length]).map(heading => ({ exact: heading.title === edge.heading }));
  else matches = [...document.text.slice(document.bodyStart).matchAll(/(?:^|[ \t])\^([A-Za-z0-9_-]+)[ \t]*(?:\r?\n|$)/gm)].filter(match => portableFold(match[1]) === portableFold(edge.block) && tokenized.visible[document.bodyStart + match.index + match[0].indexOf('^')]).map(match => ({ exact: match[1] === edge.block }));
  if (matches.length !== 1 || !matches[0].exact) refuse('TARGET_ANCHOR', 'The requested target anchor must exist exactly once with exact spelling in live Markdown.', [note.path]);
}

function sectionLayout(bytes, source) {
  const document = documentSpans(bytes);
  const tokenized = tokenizeMove(bytes, { visibility: true });
  const headings = document.lines.filter(line => line.start >= document.bodyStart).map(line => visibleHeading(line, document.bodyStart, tokenized.visible)).filter(Boolean);
  const outline = parseMarkdown(document.text).outline;
  for (let row = 1; row < document.lines.length; row++) {
    const underline = document.lines[row]; const line = document.lines[row - 1];
    if (line.start < document.bodyStart || !/^ {0,3}(=+|-+)[ \t]*$/.test(underline.content) || !line.content.trim()) continue;
    const marker = underline.start + /^ */.exec(underline.content)[0].length;
    if (!tokenized.visible[marker] || headings.some(heading => heading.line.start === line.start)) continue;
    const content = line.content.replace(/^\uFEFF/, '');
    if (/^ {0,3}(?:[-+*][ \t]+|\d{1,9}[.)][ \t]+|>|`{3,}|~{3,})/.test(content)) continue;
    const bom = line.start === document.bodyStart && line.content.startsWith('\uFEFF') ? 1 : 0;
    const heading = outline.find(value => value.line === row && value.level <= 2);
    const prior = document.lines[row - 2];
    const priorPlain = prior && prior.start >= document.bodyStart && prior.content.trim() && !/^ {0,3}(?:#{1,6}[ \t]+|[-+*][ \t]+|\d{1,9}[.)][ \t]+|>|`{3,}|~{3,})/.test(prior.content) && prior.content.split('').some((char, offset) => /\S/.test(char) && tokenized.visible[prior.start + offset]);
    if (!heading || /^[ \t]{4,}|^\t/.test(content) || tokenized.contexts.get(line.start) !== bom || priorPlain) refuse('AMBIGUOUS_REFERENCE', `A Setext heading on line ${row} has uncertain paragraph or container context.`, [source]);
    headings.push({ level: heading.level, title: heading.title, line: { ...line, end: underline.end }, atx: false });
  }
  headings.sort((a, b) => a.line.start - b.line.start);
  const related = headings.find(heading => heading.atx && heading.level === 2 && /^Related$/i.test(heading.title));
  const end = related ? headings.find(heading => heading.line.start > related.line.start && heading.level <= 2)?.line.start ?? document.text.length : null;
  return { document, tokenized, related, end, headings };
}

function hasReference(layout, source, target, qualifier, index) {
  if (!layout.related) return false;
  return layout.tokenized.tokens.some(token => token.kind === 'wiki' && !token.embed && !token.unsafe && token.start >= layout.related.line.end && token.finish <= layout.end && token.fragment === qualifier && resolveMoveTarget(token, source, index).identity === target);
}

function convention(document, anchors = []) {
  const endings = new Set(anchors.map(line => line?.ending).filter(Boolean));
  if (endings.size > 1) refuse('MIXED_NEWLINE_EDIT', 'The insertion boundary has ambiguous mixed line separators.');
  if (endings.size) return [...endings][0];
  const crlf = document.lines.filter(line => line.ending === '\r\n').length;
  const lf = document.lines.filter(line => line.ending === '\n').length;
  return crlf === lf ? document.newline : crlf > lf ? '\r\n' : '\n';
}

function insertion(layout, bullets, hadTerminal, source) {
  const { document, related, end, headings, tokenized } = layout;
  if (!related) {
    const newline = convention(document, document.lines.slice(-2));
    const trailing = /(?:\r?\n)*$/.exec(document.text)[0];
    const separation = !document.text.length || document.text.length === document.bom ? '' : trailing.length ? /\r?\n\r?\n$/.test(trailing) ? '' : newline : newline + newline;
    return { offset: document.text.length, replacement: `${separation}## Related${newline}${newline}${bullets.join(newline)}${hadTerminal || document.text.length === document.bom ? newline : ''}` };
  }
  const subheading = headings.find(heading => heading.line.start > related.line.start && heading.line.start < end && heading.level > 2)?.line.start ?? end;
  const lines = document.lines.filter(line => line.start >= related.line.end && line.start < subheading);
  const listAt = lines.findIndex(line => /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/.test(line.content) && tokenized.visible[line.start + /^ */.exec(line.content)[0].length]);
  let anchor = related.line;
  let list = false;
  if (listAt >= 0) {
    list = true;
    const marker = /^ *(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(lines[listAt].content)[0];
    let base = marker.length;
    let separated = false;
    let paragraph = false;
    let nested = false;
    const blockStart = content => /^(?:#{1,6}[ \t]+|>|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}$|[-+*][ \t]+|\d{1,9}[.)][ \t]+|<|%%|\$\$)/.test(content.trimStart());
    for (const line of lines.slice(listAt)) {
      if (!line.content.trim()) { separated = true; continue; }
      const live = line.content.split('').some((char, offset) => /\S/.test(char) && tokenized.visible[line.start + offset]);
      const markerCandidate = live ? /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(line.content) : null;
      const nextMarker = markerCandidate && /^ */.exec(line.content)[0].length < base ? markerCandidate : null;
      if (markerCandidate && !nextMarker) nested = true;
      if (!nextMarker && /^ */.exec(line.content)[0].length < base) {
        if (separated || /^(?:#{1,6}[ \t]+|>|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}$)/.test(line.content.trimStart())) break;
        if (!paragraph || !live || blockStart(line.content)) refuse('AMBIGUOUS_REFERENCE', `A list continuation on line ${document.lines.findIndex(value => value.start === line.start) + 1} has uncertain container context.`, [source]);
      }
      if (nextMarker) { base = nextMarker[0].length; nested = false; }
      const content = nextMarker ? line.content.slice(base) : line.content;
      paragraph = live && !nested && Boolean(content.trim()) && !blockStart(content);
      separated = false;
      anchor = line;
    }
  } else {
    for (const line of lines) if (line.content.trim() && line.content.split('').some((char, i) => /\S/.test(char) && tokenized.visible[line.start + i])) anchor = line;
  }
  const next = document.lines.find(line => line.start === anchor.end);
  const previous = list ? document.lines[document.lines.findIndex(line => line.start === anchor.start) - 1] : null;
  const newline = convention(document, [previous, anchor, next]);
  const atEnd = anchor.end === document.text.length;
  let replacement = `${anchor.ending ? '' : newline}${list ? '' : newline}${bullets.join(newline)}`;
  if (!atEnd || hadTerminal) replacement += newline;
  if (!atEnd && next?.content.trim() && !list) replacement += newline;
  return { offset: anchor.end, replacement };
}

export function planLink(scan, source, edges, { origin = 'operator' } = {}) {
  if (!['operator', 'unattended', 'clio'].includes(origin) || !Array.isArray(edges) || edges.length < 1 || edges.length > 4) refuse('INVALID_INPUT', 'Supply one to four relationship edges with a declared origin.');
  const seen = new Set();
  for (const edge of edges) {
    if (!edge || Object.keys(edge).some(key => !['targetNotePath', 'rationale', 'heading', 'block'].includes(key))) refuse('INVALID_INPUT', 'Relationship edges have closed fields.');
    validateTargetPath(edge.targetNotePath); validText(edge.rationale, 'Rationale');
    if (!edge.rationale.trim() || edge.rationale.length > 240) refuse('INVALID_RATIONALE', 'A rationale must contain 1 to 240 nonblank characters.');
    if (seen.has(edge.targetNotePath)) refuse('DUPLICATE_TARGET', 'Duplicate relationship targets are refused.', [edge.targetNotePath]);
    seen.add(edge.targetNotePath);
    if (edge.targetNotePath === source) refuse('SELF_LINK', 'A relationship must name another note.', [source]);
  }
  if (origin === 'clio') refuse('EMBEDDING_OFF', 'Clio candidate admission is unavailable until stage 4b.');
  const context = referenceContext(scan, source);
  const rendered = edges.map(edge => {
    const spelling = wikiSpelling(context, source, edge.targetNotePath);
    requireAnchor(context.notes.find(note => note.path === edge.targetNotePath), edge);
    return { edge, bullet: `- [[${spelling}${fragment(edge)}]]` };
  });
  const before = context.current.bytes;
  if (/\r(?!\n)/.test(before.toString('utf8'))) refuse('MIXED_NEWLINE_EDIT', 'Relationship writeback refuses bare CR.');
  let layout = sectionLayout(before, source);
  if (layout.tokenized.issues.length) refuse('AMBIGUOUS_REFERENCE', `Source context is uncertain: ${JSON.stringify(layout.tokenized.issues)}`, [source]);
  const needed = rendered.filter(({ edge }) => !hasReference(layout, source, edge.targetNotePath, fragment(edge), context.index));
  const link = { admitted: edges.map(edge => ({ targetNotePath: edge.targetNotePath, relation: 'related_to', confidence: null, basis: origin, rationale: edge.rationale })), dropped: [], candidateSet: null };
  if (!needed.length) return { bytes: before, splices: [], link, reads: context.reads, inventory: context.inventory };
  const hadTerminal = before.toString('utf8').endsWith('\n');
  let closing = '';
  const fence = layout.tokenized.unclosedFence;
  if (fence) {
    if (fence.depth || fence.indent) refuse('UNSAFE_FENCE', `An unclosed container fence on line ${fence.line} cannot be repaired safely.`, [source]);
    convention(layout.document, [layout.document.lines.at(-1), { ending: fence.newline }]);
    closing = `${hadTerminal ? '' : fence.newline}${fence.char.repeat(fence.count)}${hadTerminal ? fence.newline : ''}`;
    layout = sectionLayout(Buffer.concat([before, Buffer.from(closing)]), source);
  }
  const afterNeeded = needed.filter(({ edge }) => !hasReference(layout, source, edge.targetNotePath, fragment(edge), context.index));
  const insert = afterNeeded.length ? insertion(layout, afterNeeded.map(item => item.bullet), hadTerminal, source) : null;
  const splices = [];
  if (insert && insert.offset >= before.toString('utf8').length) {
    const offset = insert.offset - before.toString('utf8').length;
    closing = closing.slice(0, offset) + insert.replacement + closing.slice(offset);
  } else if (insert) {
    const byte = Buffer.byteLength(layout.document.text.slice(0, insert.offset));
    splices.push({ startByte: byte, endByte: byte, replacement: insert.replacement });
  }
  if (closing) splices.push({ startByte: before.length, endByte: before.length, replacement: closing });
  const after = applySplices(before, splices);
  const checked = sectionLayout(after, source);
  if (rendered.some(({ edge }) => !hasReference(checked, source, edge.targetNotePath, fragment(edge), context.index))) refuse('AMBIGUOUS_REFERENCE', 'The rendered relationships do not parse as live references.', [source]);
  return { bytes: after, splices, link, reads: context.reads, inventory: context.inventory };
}
