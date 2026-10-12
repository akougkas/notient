import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planLink } from '../lib/link.mjs';
import { applySplices, tokenizeMove } from '../lib/move.mjs';
import { revision } from '../lib/paths.mjs';
import { refreshIndex, searchIndex, openIndex } from '../lib/index.mjs';
import { readVitals } from '../lib/vitals-read.mjs';
import { writerFixture, put } from './write-helpers.mjs';

const edge = { targetNotePath: 'Target.md', rationale: 'The operator named this related note.' };
function scan(text, extras = {}) {
  const files = { 'Source.md': text, 'Target.md': '# Target\n\n## Part\n\nBlock paragraph. ^block-id\n', ...extras };
  return { notes: Object.entries(files).filter(([name]) => /\.md$/i.test(name)).map(([name, text]) => { const bytes = Buffer.from(text); return { path: name, bytes, revision: revision(bytes), mode: 0o644 }; }), inventory: Object.keys(files).sort(), blockers: [] };
}
const goldens = [
  ['W01 LF without Related', '# Source\n\nBody.\n', '# Source\n\nBody.\n\n## Related\n\n- [[Target]]\n'],
  ['W02 CRLF', '# Source\r\n\r\nBody.\r\n', '# Source\r\n\r\nBody.\r\n\r\n## Related\r\n\r\n- [[Target]]\r\n'],
  ['W03 heading inside closed fence', '```md\n## Related\n```\n', '```md\n## Related\n```\n\n## Related\n\n- [[Target]]\n'],
  ['W04 heading inside frontmatter scalar', '---\nexample: |\n  ## Related\n---\nBody.\n', '---\nexample: |\n  ## Related\n---\nBody.\n\n## Related\n\n- [[Target]]\n'],
  ['W05 unclosed backtick fence', '```js\ncode\n', '```js\ncode\n```\n\n## Related\n\n- [[Target]]\n'],
  ['W06 unclosed longer tilde fence', '~~~~~md\ncode', '~~~~~md\ncode\n~~~~~\n\n## Related\n\n- [[Target]]'],
  ['W07 bare target present', '## Related\n\n- [[Target]]\n', '## Related\n\n- [[Target]]\n'],
  ['W08 aliased target present', '## Related\n\n- [[Target|kept alias]]\n', '## Related\n\n- [[Target|kept alias]]\n'],
  ['W09 embed alone', '## Related\n\n- ![[Target]]\n', '## Related\n\n- ![[Target]]\n- [[Target]]\n'],
  ['W10 heading fragment alone', '## Related\n\n- [[Target#Part]]\n', '## Related\n\n- [[Target#Part]]\n- [[Target]]\n'],
  ['W11 list continuation and H3', '## Related\n\n- [[Other]]\n  preserved continuation\n\n### Nested\n\nNested prose.\n', '## Related\n\n- [[Other]]\n  preserved continuation\n- [[Target]]\n\n### Nested\n\nNested prose.\n'],
  ['W12 BOM before H2', '\uFEFF## Related\n\n- [[Other]]\n', '\uFEFF## Related\n\n- [[Other]]\n- [[Target]]\n'],
  ['W13 body BOM after frontmatter', '---\ntags: [keep]\n---\n\uFEFF## Related\n', '---\ntags: [keep]\n---\n\uFEFF## Related\n\n- [[Target]]\n'],
  ['W14 no terminal newline', '## Related\n\n- [[Other]]', '## Related\n\n- [[Other]]\n- [[Target]]'],
  ['W22 outside section alone', '[[Target]]\n\n## Related\n\n- [[Other]]\n', '[[Target]]\n\n## Related\n\n- [[Other]]\n- [[Target]]\n'],
  ['W23 empty body', '', '## Related\n\n- [[Target]]\n'],
  ['W24 present before later unclosed fence', '## Related\n\n- [[Target]]\n\n```\nunfinished', '## Related\n\n- [[Target]]\n\n```\nunfinished'],
];
for (const [name, before, expected] of goldens) test(`link writeback ${name}`, () => {
  const inventory = scan(before); const plan = planLink(inventory, 'Source.md', [edge]);
  assert.deepEqual(plan.bytes, Buffer.from(expected)); assert.deepEqual(applySplices(Buffer.from(before), plan.splices), plan.bytes);
  assert.deepEqual(inventory.notes[0].bytes, Buffer.from(before));
  const retry = planLink(scan(expected), 'Source.md', [edge]); assert.deepEqual(retry.bytes, plan.bytes); assert.deepEqual(retry.splices, []);
  assert.equal(plan.link.admitted[0].confidence, null); assert.equal(plan.link.admitted[0].basis, 'operator');
});

test('link writeback ignores code and comments and repairs safe root fences with literal BOM bytes', () => {
  for (const before of ['> ```md\n> ## Related\n> [[Target]]\n> ```\n', '- Item\n    ```md\n    ## Related\n    [[Target]]\n    ```\n', '<!--\n## Related\n[[Target]]\n-->\n', '%%\n## Related\n[[Target]]\n%%\n', '    ## Related\n    [[Target]]\n', '## Related\n\n`[[Target]]`\n', '---\ntags: [keep]\n---\n\uFEFF````md\n## Related\n']) {
    const plan = planLink(scan(before), 'Source.md', [edge]);
    let restored = plan.bytes;
    let delta = 0;
    const inverse = plan.splices.map(splice => { const startByte = splice.startByte + delta; delta += Buffer.byteLength(splice.replacement); return { startByte, endByte: startByte + Buffer.byteLength(splice.replacement), replacement: '' }; });
    restored = applySplices(restored, inverse); assert.deepEqual(restored, Buffer.from(before));
    const tokens = tokenizeMove(plan.bytes).tokens.filter(token => token.kind === 'wiki' && !token.embed && token.target === 'Target'); assert.equal(tokens.length, 1);
    assert.deepEqual(planLink(scan(plan.bytes.toString()), 'Source.md', [edge]).bytes, plan.bytes);
  }
});

test('link writeback honors H3 presence first section and qualified aliases without treating code as presence', () => {
  for (const before of ['## Related\n\n### Subheading\n\n- [[Target]]\n', '  ## rELAted  \n\n- [[Target|alias]]\n']) assert.deepEqual(planLink(scan(before), 'Source.md', [edge]).bytes, Buffer.from(before));
  const qualified = '## Related\n\n- [[Target#Part|alias]]\n'; assert.deepEqual(planLink(scan(qualified), 'Source.md', [{ ...edge, heading: 'Part' }]).bytes, Buffer.from(qualified));
  const block = planLink(scan('## Related\n'), 'Source.md', [{ ...edge, block: 'block-id' }]); assert.match(block.bytes.toString(), /\[\[Target#\^block-id\]\]/);
  const duplicate = '## Related\n\n- [[Other]]\n\n## Related\n\n- [[Target]]\n';
  const planned = planLink(scan(duplicate), 'Source.md', [edge]); assert.equal(planned.bytes.toString().split('- [[Target]]').length, 3); assert.equal(planned.bytes.toString().endsWith('## Related\n\n- [[Target]]\n'), true);
});

test('link writeback preserves task callout math code tags prose terminal separators and Unicode ranges', () => {
  for (const before of ['# Unicode 𐐀 café\r\n\r\n- [ ] Authored task\r\n\r\n> [!note] Keep this callout\r\n\r\n$$\r\nx+y=2\r\n$$\r\n\r\n`#code-tag`\r\n', '## Related\n\nPreserved prose.\n\n## Next\n\nKeep next.\n', '## Related\n\n- Item\n  - Nested item\n    continuation\n\n### Next\n']) {
    const plan = planLink(scan(before), 'Source.md', [edge]);
    const restored = applySplices(plan.bytes, [...plan.splices].reverse().map(splice => ({ startByte: splice.startByte, endByte: splice.startByte + Buffer.byteLength(splice.replacement), replacement: '' })));
    assert.deepEqual(restored, Buffer.from(before));
    assert.equal(plan.bytes.toString().endsWith('\n'), before.endsWith('\n'));
  }
});

test('link admission validates all edges before writing and refuses unsafe syntax anchors and origins', () => {
  const inventory = scan('Unchanged source.\n'); const before = inventory.notes.map(note => Buffer.from(note.bytes));
  const bad = [[], Array(5).fill(edge), [edge, edge], [{ ...edge, rationale: ' ' }], [{ ...edge, rationale: 'x'.repeat(241) }], [{ ...edge, targetNotePath: 'Source.md' }], [{ ...edge, targetNotePath: '../Target.md' }], [{ ...edge, targetNotePath: 'Absent.md' }], [{ ...edge, heading: 'Absent' }], [{ ...edge, heading: 'Part', block: 'block-id' }], [{ ...edge, heading: 'Part]]\nInjected' }], [{ ...edge, confidence: 1 }]];
  for (const edges of bad) assert.throws(() => planLink(inventory, 'Source.md', edges));
  assert.throws(() => planLink(inventory, 'Source.md', [edge], { origin: 'clio' }), error => error.code === 'EMBEDDING_OFF');
  assert.equal(planLink(inventory, 'Source.md', [{ ...edge, rationale: 'x'.repeat(240) }], { origin: 'unattended' }).link.admitted[0].basis, 'unattended');
  assert.deepEqual(inventory.notes.map(note => note.bytes), before);
  for (const text of ['## Related\r\n\r\n- [[Other]]\r\nNext\n', 'Bare\rCR', '> ```\n> unfinished\n', '- Item\n  ```\n  unfinished\n']) assert.throws(() => planLink(scan(text), 'Source.md', [edge]), error => ['MIXED_NEWLINE_EDIT', 'UNSAFE_FENCE', 'AMBIGUOUS_REFERENCE'].includes(error.code));
  assert.throws(() => planLink(scan('Source\n', { 'target.md': '# Case collision\n' }), 'Source.md', [edge]), error => error.code === 'AMBIGUOUS_REFERENCE');
  assert.throws(() => planLink(scan('Source\n', { 'Target.md': '# Target\n\n## Part\n\n## Part\n' }), 'Source.md', [{ ...edge, heading: 'Part' }]), error => error.code === 'TARGET_ANCHOR');
  assert.throws(() => planLink(scan('Source\n', { 'Target.md': '# Target\n\n## Part\n\n## part\n' }), 'Source.md', [{ ...edge, heading: 'Part' }]), error => error.code === 'TARGET_ANCHOR');
});

test('link planner admits all four named targets in input order with no fabricated confidence', () => {
  const edges = ['Target.md', 'B.md', 'C.md', 'D.md'].map(targetNotePath => ({ targetNotePath, rationale: 'A named relationship.' }));
  const plan = planLink(scan('Source\n', { 'B.md': '# B\n', 'C.md': '# C\n', 'D.md': '# D\n' }), 'Source.md', edges, { origin: 'unattended' });
  assert.equal(plan.bytes.toString(), 'Source\n\n## Related\n\n- [[Target]]\n- [[B]]\n- [[C]]\n- [[D]]\n');
  assert.deepEqual(plan.link.admitted.map(item => item.targetNotePath), edges.map(item => item.targetNotePath));
  assert.ok(plan.link.admitted.every(item => item.confidence === null && item.basis === 'unattended'));
});

test('link planner renders the shortest uniquely resolving suffix and freezes every fresh scan dependency', () => {
  const inventory = scan('Source\n', { 'Target.md': '# Root\n', 'Folder/Target.md': '# Folder\n', 'Other/Target.md': '# Other\n', 'attachment.png': 'attachment' });
  const plan = planLink(inventory, 'Source.md', [{ ...edge, targetNotePath: 'Folder/Target.md' }, { targetNotePath: 'Other/Target.md', rationale: 'Another named note.' }]);
  assert.match(plan.bytes.toString(), /- \[\[Folder\/Target\]\]\n- \[\[Other\/Target\]\]/);
  assert.deepEqual(plan.reads.map(read => read.path), ['Folder/Target.md', 'Other/Target.md', 'Source.md', 'Target.md']);
  assert.deepEqual(plan.inventory, inventory.inventory); assert.deepEqual(plan.link.dropped, []); assert.equal(plan.link.candidateSet, null);
});

test('structural wiki resolution uses the move resolver for ambiguous basenames case collisions and exact root suffix precedence', t => {
  const f = writerFixture(t);
  for (const [name, text] of Object.entries({ 'Source.md': '[[Target]] [[Case]] [[Root/Exact]]\n', 'Target.md': '# Root target\n', 'Folder/Target.md': '# Other target\n', 'Case.md': '# Upper\n', 'case.md': '# Lower\n', 'Root/Exact.md': '# Exact\n', 'Else/Root/Exact.md': '# Suffix\n' })) put(f, name, text);
  refreshIndex(f.vault, f.directory);
  const values = readVitals(f.vault, f.directory, {});
  assert.equal(values.notes.find(note => note.path === 'Source.md').vitals.outbound, 1);
  assert.equal(values.notes.find(note => note.path === 'Root/Exact.md').vitals.inbound, 1);
  for (const name of ['Target.md', 'Folder/Target.md', 'Case.md', 'case.md', 'Else/Root/Exact.md']) assert.equal(values.notes.find(note => note.path === name).vitals.inbound, 0);
});

test('generated link-only text remains a graph fact and never becomes independent search prose after cache upgrade', t => {
  const f = writerFixture(t); put(f, 'Source.md', 'Authored useful prose.\n\n## Related\n\n- [[Quartz]]\n'); put(f, 'Quarz.md', '# Other\n'); put(f, 'Quartz.md', '# Quartz\n');
  refreshIndex(f.vault, f.directory);
  assert.deepEqual(searchIndex(f.vault, f.directory, { query: 'Quartz' }).hits, []);
  assert.equal(readVitals(f.vault, f.directory, {}).notes.find(note => note.path === 'Source.md').vitals.outbound, 1);
  const db = openIndex(f.directory, f.vault, true);
  db.prepare("UPDATE meta SET value='visible-wiki-v1' WHERE key='graphRule'").run();
  const block = db.prepare("SELECT id FROM blocks WHERE path='Source.md' AND kind='paragraph'").get().id;
  const bytes = Buffer.from('Authored useful prose.\n\n## Related\n\n- [[Quartz]]\n');
  const source = { startLine: 5, endLine: 5, startByte: bytes.indexOf('- [[Quartz]]'), endByte: bytes.length };
  const id = db.prepare('INSERT INTO chunks(path,block,heading,source,passage) VALUES (?,?,?,?,?)').run('Source.md', block, '[]', JSON.stringify(source), '- [[Quartz]]\n').lastInsertRowid;
  db.prepare('INSERT INTO chunks_fts(rowid,passage) VALUES (?,?)').run(id, '- [[Quartz]]\n'); db.close();
  assert.equal(searchIndex(f.vault, f.directory, { query: 'Quartz' }).hits.length, 1);
  assert.equal(refreshIndex(f.vault, f.directory).changed, 0); assert.deepEqual(searchIndex(f.vault, f.directory, { query: 'Quartz' }).hits, []);
});
