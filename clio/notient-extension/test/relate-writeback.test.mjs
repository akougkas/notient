import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planRelate, relations } from '../lib/relate.mjs';
import { applySplices } from '../lib/move.mjs';
import { revision } from '../lib/paths.mjs';
import { writerFixture, put, snapshot } from './write-helpers.mjs';
import { refreshIndex, openIndex } from '../lib/index.mjs';

function scan(source, targets = {}) {
  const files = { 'Source.md': source, 'Target.md': '# Target\n', 'Earlier.md': '# Earlier\n', ...targets };
  return { inventory: Object.keys(files).sort(), blockers: [], notes: Object.entries(files).map(([name, text]) => { const bytes = Buffer.from(text); return { path: name, bytes, revision: revision(bytes), mode: 0o644 }; }) };
}
function check(before, after, relation = 'supports') {
  const inventory = scan(before); const plan = planRelate(inventory, 'Source.md', { target: 'Target.md', relation });
  assert.deepEqual(plan.bytes, Buffer.from(after)); assert.deepEqual(applySplices(Buffer.from(before), plan.splices), plan.bytes);
  assert.deepEqual(inventory.notes[0].bytes, Buffer.from(before));
  const retry = planRelate(scan(after), 'Source.md', { target: 'Target.md', relation }); assert.deepEqual(retry.bytes, plan.bytes); assert.deepEqual(retry.splices, []);
  assert.deepEqual(plan.relate, { target: 'Target.md', relation });
  return plan;
}

for (const [index, relation] of relations.entries()) test(`relation writeback W${15 + index} ${relation} changes only its list and preserves siblings comments and body`, () => {
  const before = `---\ntags: ["authored", "keep"]\nnotient: # preserved root comment\n  ${relation}:\n    - "[[Earlier]]" # earlier assertion\n  description: "Preserve this sibling"\n  extra: {count: 3}\n# independent comment\n---\n# Authored body\n\nPreserve every body byte.\n`;
  const expected = before.replace('    - "[[Earlier]]" # earlier assertion\n', '    - "[[Earlier]]" # earlier assertion\n    - "[[Target]]"\n');
  check(before, expected, relation);
});

test('relation writeback W20 aliased exact whole target is byte-identical and fragments do not satisfy it', () => {
  const before = '---\nnotient: {supports: ["[[Target|existing alias]]", "unmatched string"]}\n---\nBody.\n'; check(before, before);
  const fragment = '---\nnotient: {supports: ["[[Target#Part|alias]]"]}\n---\nBody.\n';
  check(fragment, fragment.replace('["[[Target#Part|alias]]"]', '["[[Target#Part|alias]]", "[[Target]]"]'));
});

test('relation writeback W21 refuses wrong map list and member types and reserved YAML without changing bytes', () => {
  for (const value of ['42', 'false', 'plain scalar', '["list instead of map"]', '{supports: "scalar instead of list"}', '{supports: {nested: map}}', '{supports: [true]}', '{supports: [12]}', '{supports: [null]}', '{supports: [[nested]]}', '&owned {supports: []}', '*owned', '!custom {supports: []}', '{supports: [], supports: []}', '{<<: {supports: []}}']) {
    const before = `---\nnotient: ${value}\n---\nBody.\n`; const inventory = scan(before);
    assert.throws(() => planRelate(inventory, 'Source.md', { target: 'Target.md', relation: 'supports' })); assert.deepEqual(inventory.notes[0].bytes, Buffer.from(before));
  }
  for (const before of ['---\nnotient:\n  supports: []\n  supports: []\n---\nBody.\n', '---\nnotient:\n  supports:\n    - "[[Earlier]]"\n    - {not: string}\n---\nBody.\n', '---\nnotient:\n\tsupports: []\n---\nBody.\n', '---\nnotient: {supports: ["open}\n---\nBody.\n']) assert.throws(() => planRelate(scan(before), 'Source.md', { target: 'Target.md', relation: 'supports' }));
});

test('relations initialize absent and null maps and lists while preserving comments and delimiters', () => {
  check('# Body\n', '---\nnotient: {"supports":["[[Target]]"]}\n---\n# Body\n');
  check('---\ntags: [keep]\n---\nBody.\n', '---\ntags: [keep]\nnotient: {"supports":["[[Target]]"]}\n---\nBody.\n');
  for (const value of ['null', '~', '']) {
    const before = `---\nnotient: ${value} # kept\n---\nBody.\n`;
    const after = before.replace(`notient: ${value} # kept`, `notient: ${value ? '' : ' '}{"supports": ["[[Target]]"]} # kept`);
    check(before, after);
  }
  check('---\nnotient: # kept\n---\nBody.\n', '---\nnotient: {"supports": ["[[Target]]"]} # kept\n---\nBody.\n');
  for (const value of ['null', '~', '']) {
    const before = `---\nnotient:\n  supports: ${value} # kept\n  other: "keep"\n---\nBody.\n`;
    const after = before.replace(`supports: ${value} # kept`, `supports: ${value ? '' : ' '}["[[Target]]"] # kept`);
    check(before, after);
  }
  check('---\nnotient:\n  supports: # kept\n  other: "keep"\n---\nBody.\n', '---\nnotient:\n  supports: ["[[Target]]"] # kept\n  other: "keep"\n---\nBody.\n');
});

test('relations append to block and flow containers while preserving order nested siblings and single quotes', () => {
  const before = "---\nnotient: {supports: ['unmatched', '[[Earlier]]'], extra: {deep: [1, 2]}, text: 'Don''t change'}\n---\nBody.\n";
  check(before, before.replace("'[[Earlier]]']", "'[[Earlier]]', \"[[Target]]\"]"));
  check('---\nnotient: {extra: "keep"}\n---\nBody.\n', '---\nnotient: {extra: "keep", "supports": ["[[Target]]"]}\n---\nBody.\n');
  check('---\nnotient:\n  other: "keep"\n---\nBody.\n', '---\nnotient:\n  other: "keep"\n  supports: ["[[Target]]"]\n---\nBody.\n');
  check('---\nnotient: {}\n---\nBody.\n', '---\nnotient: {"supports": ["[[Target]]"]}\n---\nBody.\n');
  check('---\nnotient:\n  supports: []\n  other: keep\n---\nBody.\n', '---\nnotient:\n  supports: ["[[Target]]"]\n  other: keep\n---\nBody.\n');
});

test('relations preserve multiline flow member comments including trailing commas and CRLF BOM bytes', () => {
  for (const comma of ['', ',']) {
    const before = `---\nnotient: {supports: [\n    "[[Earlier]]"${comma} # old member\n  ], other: "keep"}\n---\nBody.\n`;
    const after = before.replace(`"[[Earlier]]"${comma} # old member`, '"[[Earlier]]", # old member').replace('  ], other:', '    "[[Target]]"\n  ], other:');
    check(before, after);
  }
  const before = '\uFEFF---\r\ncreated: "2026-10-11"\r\nnotient:\r\n  supports:\r\n    - "[[Earlier]]"\r\n  other: kept\r\n---\r\n\uFEFF# Body\r\n\r\nKeep body without final newline';
  check(before, before.replace('    - "[[Earlier]]"\r\n', '    - "[[Earlier]]"\r\n    - "[[Target]]"\r\n'));
});

test('relations refuse self absent and unsafe targets unsupported relations origins and value overflow', () => {
  for (const input of [{ target: 'Source.md', relation: 'supports' }, { target: '../Target.md', relation: 'supports' }, { target: 'Absent.md', relation: 'supports' }, { target: 'Target.md', relation: 'related_to' }, { target: 'Target.md', relation: 'supports', confidence: 1 }]) assert.throws(() => planRelate(scan('Body\n'), 'Source.md', input));
  assert.throws(() => planRelate(scan('Body\n'), 'Source.md', { target: 'Target.md', relation: 'supports' }, { origin: 'clio' }), error => error.code === 'EMBEDDING_OFF');
  const before = `---\nnotient: {supports: ["${'x'.repeat(4090)}"]}\n---\nBody\n`;
  assert.throws(() => planRelate(scan(before), 'Source.md', { target: 'Target.md', relation: 'supports' }), error => error.code === 'RELATION_LIMIT');
});

test('structural refresh caches literal typed relation names and backfills earlier graph payloads without changing Markdown', t => {
  const f = writerFixture(t);
  for (const [name, text] of Object.entries({ 'Source.md': `---\nnotient: {${relations.map(relation => `${relation}: ["[[Target]]"]`).join(', ')}, unrelated: ["prefix [[Target]] suffix"]}\n---\nBody.\n`, 'Target.md': '# Target\n' })) put(f, name, text);
  const before = snapshot(f.vault.path); refreshIndex(f.vault, f.directory);
  const rows = () => { const db = openIndex(f.directory, f.vault); try { return db.prepare("SELECT payload FROM links WHERE path='Source.md'").all().map(row => JSON.parse(row.payload)); } finally { db.close(); } };
  assert.deepEqual(rows().filter(row => row.relation).map(row => row.relation), relations);
  const old = openIndex(f.directory, f.vault, true); old.prepare("UPDATE meta SET value='exact-wiki-v2' WHERE key='graphRule'").run(); old.exec('DELETE FROM links'); old.close();
  assert.equal(refreshIndex(f.vault, f.directory).changed, 0); assert.deepEqual(rows().filter(row => row.relation).map(row => row.relation), relations);
  assert.deepEqual(snapshot(f.vault.path), before);
});
