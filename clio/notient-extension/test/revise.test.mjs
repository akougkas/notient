import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { replaceBody, editFrontmatter, documentSpans, parseMarkdown } from '../lib/markdown.mjs';
import { writeOperation } from '../lib/write.mjs';
import { revision } from '../lib/paths.mjs';
import { atomicJson } from '../lib/config.mjs';
import { refreshIndex, searchIndex } from '../lib/index.mjs';
import { git } from '../lib/git.mjs';
import { writerFixture, put, snapshot } from './write-helpers.mjs';
import { baseline } from './git-write.test.mjs';

function reviseFixture(t, bytes = '# Note\n\nOriginal sentence.\n') {
  const f = writerFixture(t);
  put(f, 'One.md', bytes);
  baseline(f);
  refreshIndex(f.vault, f.directory);
  return f;
}

const inputFor = f => ({ vault: f.vault.id, requestId: 'revise-golden-001', batch: 'revise-test', authorization: { origin: 'operator', request: 'Replace the original sentence.' }, operation: 'replace', path: 'One.md', revision: revision(readFileSync(path.join(f.vault.path, 'One.md'))), oldText: 'Original sentence.', newText: 'Revised sentence.' });

test('body replacement preserves BOM, frontmatter, Unicode and the matched newline convention', () => {
  for (const [before, oldText, newText, after] of [
    ['# Note\nOriginal sentence.\n', 'Original sentence.', 'Revised sentence.', '# Note\nRevised sentence.\n'],
    ['\uFEFF--- \r\ntitle: Original sentence.\r\n...\r\n# Body\r\nOriginal sentence.\r\n', 'Original sentence.', 'Revised sentence.', '\uFEFF--- \r\ntitle: Original sentence.\r\n...\r\n# Body\r\nRevised sentence.\r\n'],
    ['# Café 🧠\r\nOne\r\nTwo\nLast', 'One\r\nTwo', 'Changed\nLines', '# Café 🧠\r\nChanged\r\nLines\nLast'],
    ['# Note\nNo final newline', 'No final newline', 'New final newline\n', '# Note\nNew final newline\n'],
  ]) {
    const result = replaceBody(Buffer.from(before), oldText, newText);
    assert.deepEqual(result.bytes, Buffer.from(after));
    const splice = result.splices[0];
    assert.deepEqual(Buffer.concat([Buffer.from(before).subarray(0, splice.startByte), Buffer.from(splice.replacement), Buffer.from(before).subarray(splice.endByte)]), result.bytes);
  }
});

test('R5 separator fallback follows the dominant file style and mixed-span multiline edits refuse', () => {
  for (const [before, oldText, newText, expected] of [
    ['First\nSecond\r\nThird\r\nPhrase', 'Phrase', 'New\nLines', 'First\nSecond\r\nThird\r\nNew\r\nLines'],
    ['First\r\nSecond\nThird\nPhrase', 'Phrase', 'New\r\nLines', 'First\r\nSecond\nThird\nNew\nLines'],
    ['One\r\nTwo\nLast', 'One\r\nTwo\n', 'Single', 'SingleLast'],
    ['One\r\nTwo\nLast', 'One\r\nTwo\n', 'One\r\nTwo\n', 'One\r\nTwo\nLast'],
  ]) assert.deepEqual(replaceBody(Buffer.from(before), oldText, newText).bytes, Buffer.from(expected));
  assert.throws(() => replaceBody(Buffer.from('One\r\nTwo\nLast'), 'One\r\nTwo\n', 'New\nLines'), error => error.code === 'MIXED_NEWLINE_EDIT');
  assert.throws(() => replaceBody(Buffer.from('Phrase'), 'Phrase', 'New\rLine'), error => error.code === 'INVALID_INPUT');
});

test('a BOM without frontmatter stays outside the body and does not hide the first heading', () => {
  const text = '\uFEFF# Café\r\nAuthored bytes.';
  const parsed = parseMarkdown(text);
  assert.equal(parsed.bodyStart, 1);
  assert.equal(parsed.outline[0].title, 'Café');
  assert.equal(parsed.chunks[0].source.startByte, 3);
  assert.deepEqual(replaceBody(Buffer.from(text), 'Authored', 'Revised').bytes, Buffer.from('\uFEFF# Café\r\nRevised bytes.'));
});

test('R11 quotation refusals use the inherited wording verbatim', () => {
  for (const [text, quote, message] of [
    ['aaa', 'aa', 'occurs more than once; quote a longer contiguous passage identifying one occurrence'],
    ['One.\n', 'one.', 'not an exact supplied quotation; copy a contiguous passage verbatim, preserving punctuation and whitespace'],
  ]) assert.throws(() => replaceBody(Buffer.from(text), quote, 'Replacement'), error => error.message === message);
});

test('literal witness rejects missing, multiple, overlapping and frontmatter-only matches', () => {
  for (const [text, oldText, code] of [['aaa', 'aa', 'QUOTE_AMBIGUOUS'], ['same same', 'same', 'QUOTE_AMBIGUOUS'], ['body', 'missing', 'QUOTE_NOT_FOUND'], ['---\ntitle: phrase\n---\n', 'phrase', 'QUOTE_NOT_FOUND'], ['---\nunclosed', 'unclosed', 'FRONTMATTER_INVALID']]) {
    assert.throws(() => replaceBody(Buffer.from(text), oldText, 'new'), error => error.code === code);
  }
  assert.throws(() => replaceBody(Buffer.from('body'), '', 'new'), error => error.code === 'INVALID_INPUT');
  assert.deepEqual(replaceBody(Buffer.from('same'), 'same', 'same').bytes, Buffer.from('same'));
});

test('frontmatter goldens preserve field spelling, comments, delimiters and every body byte', () => {
  const before = '\uFEFF--- \r\n# top\r\n"title" :   "Old"   # inline\r\nkeep: [x, y]\nsummary: |  # old\r\n  Literal &body\r\n  Still block.\r\n\r\n# independent\r\ntags:\r\n  - old\r\n  - more\r\n...\t\r\n# Body\nAuthored café 🧠\r\n';
  const expected = '\uFEFF--- \r\n# top\r\n"title" :   "New"   # inline\r\nkeep: [x, y]\nsummary: {"a":[1,true,null]}  # old\r\n\r\n# independent\r\nstatus: "active"\r\n...\t\r\n# Body\nAuthored café 🧠\r\n';
  const result = editFrontmatter(Buffer.from(before), [{ key: 'title', valueJson: '"New"' }, { key: 'summary', valueJson: '{"a":[1,true,null]}' }, { key: 'status', valueJson: '"active"' }], ['tags']);
  assert.deepEqual(result.bytes, Buffer.from(expected));
  const original = documentSpans(Buffer.from(before));
  const changed = documentSpans(result.bytes);
  assert.deepEqual(result.bytes.subarray(Buffer.byteLength(changed.text.slice(0, changed.bodyStart))), Buffer.from(before).subarray(Buffer.byteLength(original.text.slice(0, original.bodyStart))));
});

test('frontmatter supports missing blocks, empty values, flow collections and quoted scalar spans', () => {
  for (const [before, set, unset, after] of [
    ['\uFEFF# Body\r\nExact', [{ key: 'value', valueJson: '["x",2,false]' }], [], '\uFEFF---\r\nvalue: ["x",2,false]\r\n---\r\n# Body\r\nExact'],
    ['---\nvalue:\n  - old\nkeep: true\n---\nBody', [{ key: 'value', valueJson: 'null' }], [], '---\nvalue: null\nkeep: true\n---\nBody'],
    ['---\nvalue: # keep\n  - old\n---\n', [{ key: 'value', valueJson: '1' }], [], '---\nvalue: 1 # keep\n---\n'],
    ['---\nvalue: [\n  one, two\n]\n---\nBody', [], ['value'], '---\n---\nBody'],
    ['---\nvalue: "old"\nkeep: {a: 1, b: [2]}\n---\n', [{ key: 'value', valueJson: 'true' }], [], '---\nvalue: true\nkeep: {a: 1, b: [2]}\n---\n'],
    ['# Body', [], ['missing'], '# Body'],
  ]) assert.deepEqual(editFrontmatter(Buffer.from(before), set, unset).bytes, Buffer.from(after));
});

test('unsafe frontmatter and ambiguous JSON values are refused before any splice', () => {
  for (const text of ['---\na: 1\na: 2\n---\n', '---\na:\n  child: 1\n  child: 2\n---\n', '---\na: &anchor value\n---\n', '---\na: *alias\n---\n', '---\n<<: {a: 1}\n---\n', '---\n? complex\n: key\n---\n', '---\na: !custom x\n---\n', '---\na: "unclosed\n---\n', '---\na: "closed" trailing\n---\n', '---\na: {x: 1, x: 2}\n---\n']) assert.throws(() => editFrontmatter(Buffer.from(text), [{ key: 'title', valueJson: '"new"' }]));
  for (const valueJson of ['not JSON', '1e1000', '[[[[[[]]]]]]', '"\\u0000"', '"\\ud800"']) assert.throws(() => editFrontmatter(Buffer.from('Body'), [{ key: 'title', valueJson }]));
  for (const [set, unset] of [[[{ key: 'title', valueJson: '1' }, { key: 'title', valueJson: '2' }], []], [[{ key: 'title', valueJson: '1' }], ['title']], [[], ['title', 'title']]]) assert.throws(() => editFrontmatter(Buffer.from('Body'), set, unset));
});

test('frontmatter splices preserve independent comments between continuation lines', () => {
  const source = Buffer.from('---\nsummary: |\n  old text\n# independent\n  # literal block content\n  more old text\n\nkeep: true\n---\nBody bytes.');
  const expected = Buffer.from('---\nsummary: "new"\n# independent\n\nkeep: true\n---\nBody bytes.');
  const result = editFrontmatter(source, [{ key: 'summary', valueJson: '"new"' }]);
  assert.deepEqual(result.bytes, expected);
  const commentStart = source.indexOf('# independent');
  const commentEnd = commentStart + Buffer.byteLength('# independent\n');
  assert.ok(result.splices.every(splice => splice.endByte <= commentStart || splice.startByte >= commentEnd));
});

test('real revisions commit body and frontmatter changes with exact index evidence', t => {
  const f = reviseFixture(t, '\uFEFF---\r\ntitle: "Keep"\r\n---\r\n# Note\r\nOriginal sentence.\r\n');
  const before = readFileSync(path.join(f.vault.path, 'One.md'));
  const input = inputFor(f);
  const preview = writeOperation('revise', { ...input, dryRun: true }, { directory: f.directory });
  assert.equal(preview.outcome, 'preview', JSON.stringify(preview));
  const changed = writeOperation('revise', { ...input, planHash: preview.planHash }, { directory: f.directory });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.deepEqual(readFileSync(path.join(f.vault.path, 'One.md')), Buffer.from(before.toString().replace('Original sentence.', 'Revised sentence.')));
  assert.equal(searchIndex(f.vault, f.directory, { query: 'Revised' }).hits[0].revision, changed.changes[0].after);
  const bodyBefore = readFileSync(path.join(f.vault.path, 'One.md'));
  const fm = writeOperation('revise', { vault: f.vault.id, requestId: 'frontmatter-real-001', batch: input.batch, authorization: input.authorization, operation: 'frontmatter', path: 'One.md', revision: revision(bodyBefore), set: [{ key: 'title', valueJson: '"Changed"' }, { key: 'tags', valueJson: '["storage"]' }] }, { directory: f.directory });
  assert.equal(fm.ok, true, JSON.stringify(fm));
  assert.equal(git(f.vault.path, ['rev-list', '--count', 'HEAD']), '3');
  assert.deepEqual(readFileSync(path.join(f.vault.path, 'One.md')), editFrontmatter(bodyBefore, [{ key: 'title', valueJson: '"Changed"' }, { key: 'tags', valueJson: '["storage"]' }]).bytes);
});

test('byte-identical revisions create no journal, audit or Git objects and still check revision', t => {
  const f = reviseFixture(t);
  const input = { ...inputFor(f), newText: 'Original sentence.' };
  const before = snapshot(f.temporary);
  const result = writeOperation('revise', input, { directory: f.directory });
  assert.equal(result.outcome, 'noop', JSON.stringify(result));
  assert.equal(result.operationId, null);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(snapshot(f.temporary), before);
  assert.equal(existsSync(path.join(f.directory, 'journal')), false);
  assert.equal(writeOperation('revise', { ...input, revision: '0'.repeat(64) }, { directory: f.directory }).error.code, 'REVISION_CONFLICT');
});

test('revision permissions and closed mode fields refuse unintended writes', t => {
  const f = reviseFixture(t);
  const before = snapshot(f.temporary);
  for (const extra of [{ set: [] }, { destination: 'Elsewhere.md' }, { operation: 'move' }, { operation: 'frontmatter', set: [{ key: 'title', valueJson: '"x"' }] }, { path: 'Notient/Log/2026-10.md' }, { authorization: { origin: 'unattended', request: 'Revise outside Notient.' } }]) {
    const result = writeOperation('revise', { ...inputFor(f), ...extra }, { directory: f.directory });
    assert.equal(result.ok, false);
    assert.equal(result.operationId, null);
  }
  assert.deepEqual(snapshot(f.temporary), before);
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, role: 'own' }] });
  assert.equal(writeOperation('revise', { ...inputFor(f), authorization: { origin: 'unattended', request: 'Revise the own note.' } }, { directory: f.directory }).ok, true);
});

test('revise CLI validates nested closed arrays and returns typed refusals', t => {
  const f = reviseFixture(t);
  const filename = fileURLToPath(new URL('../tools/revise.mjs', import.meta.url));
  const base = { vault: f.vault.id, batch: 'frontmatter-cli', authorization: { origin: 'operator', request: 'Set the title.' }, operation: 'frontmatter', path: 'One.md', revision: inputFor(f).revision, set: [{ key: 'title', valueJson: '"New"' }], dryRun: true };
  const run = input => spawnSync(process.execPath, [filename, JSON.stringify(input)], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) } });
  assert.equal(run(base).status, 0);
  for (const input of [{ ...base, set: [{ key: 'title', valueJson: '"New"', extra: true }] }, { ...base, set: 'wrong' }, { ...base, set: Array(33).fill(base.set[0]) }]) {
    const result = run(input);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_INPUT');
  }
});
