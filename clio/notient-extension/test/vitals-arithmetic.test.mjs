import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { arithmeticVitals, proseMetrics } from '../lib/vitals.mjs';
import { migrateIndex, wordCountVersion } from '../lib/index-schema.mjs';
import { parseMarkdown } from '../lib/markdown.mjs';
import { openIndex, refreshIndex, searchIndex } from '../lib/index.mjs';
import { indexPath } from '../lib/config.mjs';
import { writerFixture, put, snapshot } from './write-helpers.mjs';

const now = Date.parse('2026-10-11T00:00:00Z');
const day = 86400000;
const base = { words: 0, inbound: 0, outbound: 0, chunkCoverage: 0, lastUserEditMs: now, maturity: 'raw' };
const matureBase = { words: 200, inbound: 2, outbound: 3, lastUserEditMs: now - 8 * day, maturity: 'adolescent' };
const vectors = [
  ['V01 empty isolated raw', {}, { health: 0, freshness: 1, wordBand: 0, connectivityTier: 'isolated', maturity: 'raw' }],
  ['V02 600 words at fourteen days', { words: 600, chunkCoverage: 1, inbound: 1, lastUserEditMs: now - 14 * day }, { freshness: Math.exp(-1), wordBand: 1 - Math.exp(-1), health: (3 - Math.exp(-1)) / 3, maturity: 'adolescent' }],
  ['V03 future edit clamps age to zero', { lastUserEditMs: now + day }, { freshness: 1 }],
  ['V04 substantive chunks are binary', { chunkCoverage: 1 }, { chunkCoverage: 1, health: 1 / 3 }],
  ['V05 one inbound edge is sparse', { inbound: 1 }, { inbound: 1, outbound: 0, edges: 1, hasEdges: 1, connectivityTier: 'sparse' }],
  ['V06 three edges remain sparse', { outbound: 3 }, { edges: 3, connectivityTier: 'sparse' }],
  ['V07 four edges are connected', { inbound: 2, outbound: 2 }, { edges: 4, connectivityTier: 'connected' }],
  ['V08 eleven edges remain connected', { inbound: 3, outbound: 8 }, { edges: 11, connectivityTier: 'connected' }],
  ['V09 twelve edges form a hub', { inbound: 2, outbound: 10 }, { edges: 12, connectivityTier: 'hub' }],
  ['V10 one word advances raw once', { words: 1 }, { maturity: 'adolescent' }],
  ['V11 199 words cannot mature', { ...matureBase, words: 199 }, { maturity: 'adolescent' }],
  ['V12 four edges cannot mature', { ...matureBase, outbound: 2 }, { maturity: 'adolescent' }],
  ['V13 exactly seven days cannot mature', { ...matureBase, lastUserEditMs: now - 7 * day }, { maturity: 'adolescent' }],
  ['V14 200 words five edges seven days plus one millisecond mature', { ...matureBase, lastUserEditMs: now - 7 * day - 1 }, { maturity: 'mature' }],
  ['V15 nine outgoing edges cannot synthesize', { maturity: 'mature', inbound: 3, outbound: 9 }, { maturity: 'mature' }],
  ['V16 two incoming edges cannot synthesize', { maturity: 'mature', inbound: 2, outbound: 10 }, { maturity: 'mature' }],
  ['V17 ten outgoing three incoming edges synthesize', { maturity: 'mature', inbound: 3, outbound: 10 }, { maturity: 'synthesis-ready' }],
  ['V18 earned maturity survives a rewrite', { maturity: 'synthesis-ready' }, { maturity: 'synthesis-ready' }],
  ['V19 normal refresh advances only one qualifying rung', { ...matureBase, maturity: 'raw', inbound: 3, outbound: 10 }, { maturity: 'adolescent' }],
  ['V20 rebuild reaches its fixpoint within three rungs', { ...matureBase, maturity: 'raw', inbound: 3, outbound: 10 }, { maturity: 'synthesis-ready' }, { rebuild: true }],
];
for (const [name, input, expected, options] of vectors) test(`vitals arithmetic ${name}`, () => {
  const values = arithmeticVitals({ ...base, ...input }, now, { advance: true, ...options });
  for (const [key, value] of Object.entries(expected)) assert.equal(values[key], value, key);
  assert.equal(values.lastUserEditAt, new Date(input.lastUserEditMs ?? now).toISOString());
});

test('vitals arithmetic refuses negative nonfinite fractional and nonbinary inputs and reads never promote', () => {
  for (const input of [{ words: -1 }, { words: 0.5 }, { words: Infinity }, { inbound: -1 }, { outbound: NaN }, { chunkCoverage: 2 }, { lastUserEditMs: NaN }, { maturity: 'verified' }]) assert.throws(() => arithmeticVitals({ ...base, ...input }, now), /Invalid structural/);
  assert.throws(() => arithmeticVitals(base, Infinity), /Invalid structural/);
  const input = { ...base, ...matureBase, maturity: 'raw', inbound: 3, outbound: 10 };
  for (let i = 0; i < 4; i++) assert.equal(arithmeticVitals(input, now).maturity, 'raw');
});

test('vitals prose counts nonoverlapping visible Unicode words and substantive chunks once', () => {
  const text = '---\ntags: [metadata]\n---\n# Title\n\nnaïve déjà 𐐀word 123 mother-in-law don\'t\n\n- [[Only generated link]]\n\n`hidden inline words`\n\n    indented secret\n\n> ```\n> secret fence words\n> ```\n\n<!-- hidden comment -->\n%% hidden obsidian comment %%\n\n<!-- notient:begin -->\nvisitor hidden evidence\n<!-- notient:end -->\n\nVisible final.\n';
  const bytes = Buffer.from(text); const parsed = parseMarkdown(text);
  const metrics = proseMetrics(bytes, parsed);
  assert.equal(metrics.words, 8); assert.equal(metrics.chunkCoverage, 1);
  for (const text of ['# Heading only\n', '- [[Target]]\n', '```\ncode only\n```\n', '    code only\n', '<!-- notient:begin -->\nvisitor text\n<!-- notient:end -->\n']) assert.deepEqual(proseMetrics(Buffer.from(text), parseMarkdown(text)), { words: 0, chunkCoverage: 0 });
});

test('V1 prose counts displayed link text without hidden destinations or titles', () => {
  for (const text of [
    'See [[Hidden target|label]].\n',
    'See [label](folder/hidden(nested(destination)).md "hidden title").\n',
    'See [label](<folder/hidden destination.md> "hidden title").\n',
    'See [label][hidden id].\n\n[hidden id]: folder/hidden.md "hidden title"\n',
    'See [[Hidden target#Hidden heading|label]] and [shown label](folder/hidden(a(b(c))).md).\n',
    'See [[Hidden target|𐐀label]] and [shown label](folder/hidden(a(b(c))).md).\n',
  ]) {
    const expected = text.includes(' and ') ? 5 : 2;
    assert.deepEqual(proseMetrics(Buffer.from(text), parseMarkdown(text)), { words: expected, chunkCoverage: 1 }, text);
  }
});

test('V1 refresh explicitly rebuilds obsolete word counts with unchanged file metadata', t => {
  const f = writerFixture(t); put(f, 'One.md', 'See [[Hidden target|label]].\n'); refreshIndex(f.vault, f.directory);
  const before = snapshot(f.vault.path);
  const db = openIndex(f.directory, f.vault, true);
  db.prepare("UPDATE meta SET value='unicode-prose-v1' WHERE key='wordCountVersion'").run();
  db.prepare('UPDATE note_vitals SET word_count=4').run(); db.close();
  const result = refreshIndex(f.vault, f.directory);
  assert.equal(result.hashed, 1); assert.equal(result.unchanged, 1);
  const after = openIndex(f.directory, f.vault);
  assert.equal(after.prepare('SELECT word_count FROM note_vitals').get().word_count, 2);
  assert.equal(after.prepare("SELECT value FROM meta WHERE key='wordCountVersion'").get().value, wordCountVersion); after.close();
  assert.deepEqual(snapshot(f.vault.path), before);
});

test('V10 link display text keeps the visibility mask for inline code', () => {
  for (const text of [
    'See [shown `hidden code`](folder/hidden(nested).md).\n',
    'See [[Hidden destination|shown ``hidden ` code``]].\r\n',
    'See [shown `hidden code`][id].\n\n[id]: hidden.md\n',
    '𐐀See [[Hidden destination|𐐀shown `秘密 code`]].\n',
    'See [before`hidden`after](hidden.md).\n',
  ]) assert.deepEqual(proseMetrics(Buffer.from(text), parseMarkdown(text)), { words: text.includes('before') ? 3 : 2, chunkCoverage: 1 }, text);
});

test('V11 comments are removed before link tokenization without exposing destinations', () => {
  for (const text of [
    'See [la<!-- hidden -->bel](hidden destination.md).\n',
    'See [[Hidden destination|la<!-- hidden -->bel]].\r\n',
    'See [la<!-- hidden -->bel][id].\n\n[id]: hidden.md\n',
    'See [la<!-- hidden\ncontinued -->bel](hidden(a(b)).md).\n',
    '𐐀See [𐐀la<!-- one -->bel `hidden code`<!-- two -->](hidden.md).\n',
  ]) {
    const bytes = Buffer.from(text); const parsed = parseMarkdown(text);
    assert.equal(parsed.links.length, 1, text);
    assert.deepEqual(proseMetrics(bytes, parsed), { words: 2, chunkCoverage: 1 }, text);
    for (const chunk of parsed.chunks) assert.equal(bytes.subarray(chunk.source.startByte, chunk.source.endByte).toString(), chunk.passage);
    assert.equal(parsed.chunks.some(chunk => chunk.passage.includes('<!--')), false);
    assert.equal(bytes.subarray(parsed.links[0].source.startByte, parsed.links[0].source.endByte).toString().startsWith('['), true);
  }
  for (const text of ['- [la<!-- hidden -->bel](hidden.md)\n', '- [la<!-- hidden\ncontinued -->bel](hidden.md)\n']) assert.deepEqual(proseMetrics(Buffer.from(text), parseMarkdown(text)), { words: 0, chunkCoverage: 0 }, text);
});

test('V11 refresh backfills comment-filtered labels with exact visible evidence and unchanged vault bytes', t => {
  const f = writerFixture(t); const text = 'See [la<!-- hidden [[Fake]] #hidden -->bel `hidden code`](hidden(a(b)).md).\r\n';
  put(f, 'Source.md', text); const before = snapshot(f.vault.path); refreshIndex(f.vault, f.directory);
  const db = openIndex(f.directory, f.vault, true);
  db.prepare("UPDATE meta SET value='unicode-prose-v5' WHERE key='wordCountVersion'").run();
  db.prepare('UPDATE note_vitals SET word_count=9').run(); db.close();
  assert.equal(refreshIndex(f.vault, f.directory).hashed, 1);
  const rebuilt = openIndex(f.directory, f.vault);
  assert.equal(rebuilt.prepare('SELECT word_count FROM note_vitals').get().word_count, 2);
  assert.equal(rebuilt.prepare('SELECT count(*) AS n FROM links').get().n, 1);
  assert.equal(rebuilt.prepare('SELECT count(*) AS n FROM tags').get().n, 0);
  for (const chunk of rebuilt.prepare('SELECT source,passage FROM chunks').all()) {
    const source = JSON.parse(chunk.source);
    assert.equal(Buffer.from(text).subarray(source.startByte, source.endByte).toString(), chunk.passage);
    assert.equal(chunk.passage.includes('<!--'), false);
  }
  rebuilt.close(); assert.deepEqual(snapshot(f.vault.path), before);
});

test('V2 parser retains exact visible source spans on both sides of HTML comments', () => {
  for (const [text, words] of [
    ['Visible <!-- hidden --> prose.\n', 2],
    ['naïve<!-- hidden --> déjà.\r\n', 2],
    ['Before <!--\nhidden\n--> after.\n', 2],
    ['Before <!-- hidden --> middle <!-- hidden --> after.\n', 3],
    ['`<!-- hidden -->` Visible prose.\n', 2],
  ]) {
    const bytes = Buffer.from(text); const parsed = parseMarkdown(text);
    assert.deepEqual(proseMetrics(bytes, parsed), { words, chunkCoverage: 1 }, text);
    for (const chunk of parsed.chunks) assert.equal(bytes.subarray(chunk.source.startByte, chunk.source.endByte).toString('utf8'), chunk.passage);
    if (!text.startsWith('`')) assert.equal(parsed.chunks.some(chunk => chunk.passage.includes('hidden')), false);
  }
});

test('V2 refresh indexes visible comment-adjacent evidence without hidden prose or links', t => {
  const f = writerFixture(t); const text = 'Visible <!-- hidden [[Secret]] #hidden --> prose.\r\n'; put(f, 'One.md', text);
  const before = snapshot(f.vault.path); refreshIndex(f.vault, f.directory);
  const db = openIndex(f.directory, f.vault);
  assert.equal(db.prepare('SELECT word_count FROM note_vitals').get().word_count, 2);
  const chunks = db.prepare('SELECT source,passage FROM chunks').all();
  assert.deepEqual(chunks.map(chunk => chunk.passage), ['Visible ', ' prose.\r\n']);
  for (const chunk of chunks) { const source = JSON.parse(chunk.source); assert.equal(Buffer.from(text).subarray(source.startByte, source.endByte).toString(), chunk.passage); }
  assert.equal(db.prepare('SELECT count(*) AS n FROM links').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM tags').get().n, 0); db.close();
  assert.deepEqual(snapshot(f.vault.path), before);
});

test('V3 link-only classification requires actual complete link tokens and whitespace', () => {
  for (const [text, words, chunkCoverage] of [
    ['- [[A]] supports [[B]]\n', 3, 1],
    ['> - [[Hidden A|A]] supports [[Hidden B|B]]\r\n', 3, 1],
    ['- [[A]]\t[[B]]\n', 0, 0],
    ['- [A](hidden(a(b)).md) [[B|shown]]\n', 0, 0],
    ['- [[A]] [[B\n', 2, 1],
    ['- [[A]] <!-- hidden --> [[B]]\n', 0, 0],
  ]) assert.deepEqual(proseMetrics(Buffer.from(text), parseMarkdown(text)), { words, chunkCoverage }, text);
});

test('V3 indexed authored prose between links remains evidence while pure token lists do not', t => {
  const f = writerFixture(t); const text = '- [[A]] supports [[B]]\n\n- [[A]] [[B]]\n'; put(f, 'Source.md', text); put(f, 'A.md', '# A\n'); put(f, 'B.md', '# B\n');
  const before = snapshot(f.vault.path); refreshIndex(f.vault, f.directory);
  const db = openIndex(f.directory, f.vault);
  assert.equal(db.prepare("SELECT word_count FROM note_vitals WHERE path='Source.md'").get().word_count, 3);
  assert.deepEqual(db.prepare("SELECT passage FROM chunks WHERE path='Source.md'").all().map(row => row.passage), ['- [[A]] supports [[B]]\n']);
  assert.equal(db.prepare("SELECT count(*) AS n FROM links WHERE path='Source.md'").get().n, 4); db.close();
  assert.equal(searchIndex(f.vault, f.directory, { query: 'supports' }).hits[0].passage, '- [[A]] supports [[B]]\n');
  assert.deepEqual(snapshot(f.vault.path), before);
});

test('structural migration preserves version one rows and vault bytes and installs bounded cascading derived tables idempotently', t => {
  const f = writerFixture(t); put(f, 'One.md', '# One\n\nPreserved original prose.\n'); refreshIndex(f.vault, f.directory);
  const before = snapshot(f.vault.path);
  const db = new DatabaseSync(indexPath(f.directory, f.vault));
  db.exec('PRAGMA foreign_keys=ON; DROP TABLE vec_meta; DROP TABLE vector_spaces; DROP TABLE candidate_sets; DROP TABLE note_vitals; PRAGMA user_version=1;');
  const notes = db.prepare('SELECT * FROM notes').all(); const chunks = db.prepare('SELECT * FROM chunks').all();
  migrateIndex(db); migrateIndex(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.deepEqual(db.prepare('SELECT * FROM notes').all(), notes); assert.deepEqual(db.prepare('SELECT * FROM chunks').all(), chunks);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='wordCountVersion'").get().value, wordCountVersion);
  db.prepare('INSERT INTO vector_spaces(space_id,provider,model,dim,state,corpus_generation,created_at) VALUES (?,?,?,?,?,?,?)').run('space', 'fixture', 'model', 2, 'off', 1, new Date(now).toISOString());
  const insert = db.prepare('INSERT INTO vec_meta VALUES (?,?,?,?,?,?,?,?,?)');
  insert.run('space', chunks[0].id, 'One.md', notes[0].revision, 'hash', 0, 0.1, 'model', 2);
  assert.throws(() => insert.run('space', chunks[1].id, 'One.md', notes[0].revision, 'hash', 0, 0.1, 'model', 2), /UNIQUE/);
  assert.throws(() => insert.run('space', chunks[1].id, 'One.md', notes[0].revision, 'hash', 1, 0, 'model', 2), /CHECK/);
  db.prepare('DELETE FROM chunks WHERE id=?').run(chunks[0].id); assert.equal(db.prepare('SELECT count(*) AS n FROM vec_meta').get().n, 0);
  db.close();
  const readonly = openIndex(f.directory, f.vault); assert.equal(readonly.prepare('PRAGMA user_version').get().user_version, 2); readonly.close();
  assert.deepEqual(snapshot(f.vault.path), before);
});
