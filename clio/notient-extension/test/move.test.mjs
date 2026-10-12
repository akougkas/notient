import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planMove, scanMoveVault, tokenizeMove, applySplices } from '../lib/move.mjs';
import { writeOperation } from '../lib/write.mjs';
import { revision } from '../lib/paths.mjs';
import { writerFixture, put, snapshot } from './write-helpers.mjs';
import { baseline } from './git-write.test.mjs';

const scan = values => ({ notes: Object.entries(values).filter(([name]) => /\.md$/i.test(name)).map(([name, text]) => ({ path: name, bytes: Buffer.from(text), revision: revision(text), mode: 0o644 })), inventory: Object.keys(values).sort(), blockers: [] });
const after = (plan, name) => plan.files.find(file => file.path === name)?.after?.toString();

test('S4 exact root paths outrank deep suffixes while relative and case conflicts still refuse', () => {
  const exact = planMove(scan({ 'old/One.md': 'Source', 'deep/old/One.md': 'Other', 'deeper/OLD/One.md': 'Folded suffix', 'From.md': '[[old/One]]\n' }), 'old/One.md', 'new/Two.md');
  assert.equal(exact.ok, true, JSON.stringify(exact.blockers));
  assert.equal(after(exact, 'From.md'), '[[Two]]\n');
  const suffix = planMove(scan({ 'deep/old/One.md': 'Source', 'From.md': '[[old/One]]\n' }), 'deep/old/One.md', 'new/Two.md');
  assert.equal(suffix.ok, true, JSON.stringify(suffix.blockers));
  for (const values of [
    { 'old/One.md': 'Source', 'folder/old/One.md': 'Other', 'folder/From.md': '[[old/One]]\n' },
    { 'old/One.md': 'Source', 'OLD/One.md': 'Other', 'From.md': '[[old/One]]\n' },
    { 'deep/old/One.md': 'Source', 'deeper/old/One.md': 'Other', 'From.md': '[[old/One]]\n' },
  ]) {
    const source = Object.keys(values).find(name => values[name] === 'Source');
    const result = planMove(scan(values), source, 'new/Two.md');
    assert.equal(result.ok, false); assert.equal(result.blockers[0].code, 'AMBIGUOUS_REFERENCE'); assert.deepEqual(result.files, []);
  }
});

const goldens = [
  ['M01 unique basename', { 'From.md': '[[One]]\n' }, '[[Two]]\n'],
  ['M02 display alias', { 'From.md': '[[One|  Exact 🧠 alias ]]\n' }, '[[Two|  Exact 🧠 alias ]]\n'],
  ['M03 heading fragment', { 'From.md': '[[One#Heading%20Name|alias]]\r\n' }, '[[Two#Heading%20Name|alias]]\r\n'],
  ['M04 embed', { 'From.md': '![[One#^id]]\n' }, '![[Two#^id]]\n'],
  ['M05 Markdown title', { 'From.md': '[Label](old/One.md "Exact title")\n' }, '[Label](new/Two.md "Exact title")\n'],
  ['M06 shared definition', { 'From.md': '[a][ KEY ] [b][key]\n[Key]: old/One.md \'Title\'\n' }, '[a][ KEY ] [b][key]\n[Key]: new/Two.md \'Title\'\n'],
  ['M08 BOM', { 'From.md': '\uFEFF# Café 🧠\r\n[[One]]\r\nEOF' }, '\uFEFF# Café 🧠\r\n[[Two]]\r\nEOF'],
  ['M10 blocks and self', { 'From.md': '[[One#^block-id]] [self](#Heading) ![[#^self]]\n' }, '[[Two#^block-id]] [self](#Heading) ![[#^self]]\n'],
  ['M12 root and relative', { 'From.md': '[[/old/One]] [[./old/One.md]]\n' }, '[[/new/Two]] [[./new/Two.md]]\n'],
  ['M13 image angle encoding', { 'From.md': '![Exact](<old/One.md#A%20B> "a title")\n' }, '![Exact](<new/Two.md#A%20B> "a title")\n'],
];

for (const [name, values, expected] of goldens) test(`move golden ${name}`, () => {
  const inventory = scan({ 'old/One.md': '# One\n', ...values });
  const plan = planMove(inventory, 'old/One.md', 'new/Two.md');
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers));
  assert.equal(after(plan, 'From.md'), expected);
  for (const file of plan.files.filter(file => file.before && file.after)) assert.deepEqual(applySplices(file.before, file.splices), file.after);
  assert.deepEqual(inventory.notes.find(note => note.path === 'From.md').bytes, Buffer.from(values['From.md']));
});

test('move golden M07 collects every ambiguous referrer and refuses the complete closure', () => {
  const inventory = scan({ 'old/One.md': 'Source', 'other/One.md': 'Other', 'A.md': '[[One]] [[/old/One]]', 'B.md': '![[One|display]]', 'C.md': '[[One#Heading]]' });
  const before = inventory.notes.map(note => Buffer.from(note.bytes));
  const plan = planMove(inventory, 'old/One.md', 'new/Two.md');
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.files, []);
  assert.deepEqual(plan.repairs, []);
  assert.deepEqual([...new Set(plan.blockers.map(blocker => blocker.path))], ['A.md', 'B.md', 'C.md']);
  assert.ok(plan.blockers.every(blocker => blocker.reason));
  assert.deepEqual(inventory.notes.map(note => note.bytes), before);
});

test('move golden M09 rebases outgoing notes, attachments and explicit missing paths', () => {
  const inventory = scan({ 'old/One.md': '[n](../Peer.md) ![image](../media/a%20b.png "title") [[./missing#Head]] [ghost](./ghost.md) [[#^self]]\r\n', 'Peer.md': 'Peer', 'media/a b.png': 'image' });
  const plan = planMove(inventory, 'old/One.md', 'deep/new/Two.md');
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers));
  assert.equal(after(plan, 'deep/new/Two.md'), '[n](../../Peer.md) ![image](../../media/a%20b.png "title") [[../../old/missing#Head]] [ghost](../../old/ghost.md) [[#^self]]\r\n');
  assert.equal(plan.files[0].path, 'deep/new/Two.md');
  assert.equal(plan.files.at(-1).path, 'old/One.md');
});

test('move golden M11 repairs newly ambiguous previously unique bindings', () => {
  const plan = planMove(scan({ 'old/One.md': 'Source', 'else/Two.md': 'Existing', 'From.md': '[[One]] [[Two|existing]]\n' }), 'old/One.md', 'new/Two.md');
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers));
  assert.equal(after(plan, 'From.md'), '[[new/Two]] [[else/Two|existing]]\n');
});

test('move golden M14 refuses duplicate definitions and alias-only identity but honors explicit names', () => {
  const values = { 'old/One.md': '---\naliases: [Nick]\n---\nSource', 'Else.md': '---\naliases: [One]\n---\nOther', 'A.md': '[[Nick]]', 'B.md': '[use][x]\n[x]: old/One.md\n[X]: Else.md\n' };
  const plan = planMove(scan(values), 'old/One.md', 'new/Two.md');
  assert.equal(plan.ok, false);
  assert.ok(plan.blockers.some(blocker => blocker.path === 'A.md' && /Alias-only/.test(blocker.reason)));
  assert.ok(plan.blockers.some(blocker => blocker.path === 'B.md' && /Duplicate/.test(blocker.reason)));
  delete values['A.md']; delete values['B.md']; values['From.md'] = '[[One]]';
  const explicit = planMove(scan(values), 'old/One.md', 'new/Two.md');
  assert.equal(explicit.ok, true, JSON.stringify(explicit.blockers));
  assert.equal(after(explicit, 'From.md'), '[[Two]]');
});

test('move tokenizer ignores code and comments, includes callouts and visitor links, and repairs scalar YAML', () => {
  const source = '\uFEFF---\nrelated: "[[One#Head|display]]" # [[One]]\n---\n`[[One]]`\n````md\n[[One]]\n````\n    [[One]]\n<!-- [[One]] -->\n> [!info] [[One]]\n<!-- notient:begin -->\n[[One]]\n';
  const plan = planMove(scan({ 'old/One.md': 'Source', 'From.md': source }), 'old/One.md', 'new/Two.md');
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers));
  assert.equal(after(plan, 'From.md'), source.replace('related: "[[One#', 'related: "[[Two#').replace('> [!info] [[One]]', '> [!info] [[Two]]').replace('<!-- notient:begin -->\n[[One]]', '<!-- notient:begin -->\n[[Two]]'));
  assert.equal(tokenizeMove(Buffer.from(source)).tokens.length, 3);
});

test('move preserves single-quoted YAML scalar escaping and exact byte ranges', () => {
  const plan = planMove(scan({ 'One.md': 'Source', 'From.md': "---\nrelated: '[[One|display]]'\n---\n" }), 'One.md', "O'Brien.md");
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers));
  assert.equal(after(plan, 'From.md'), "---\nrelated: '[[O''Brien|display]]'\n---\n");
});

test('move ignores blockquoted fences and indented code while retaining later visible links', () => {
  const source = '> ~~~~md\n> [[One]]\n> ~~~~\n>     [[One]]\n> ```md\n> [[One]]\n# Outside the quote\n[[One]]\n';
  const plan = planMove(scan({ 'One.md': 'Source', 'From.md': source }), 'One.md', 'Two.md');
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers));
  assert.equal(after(plan, 'From.md'), source.replace('# Outside the quote\n[[One]]', '# Outside the quote\n[[Two]]'));
});

test('move refuses alias-only discovery with case or normalization alternatives', () => {
  const source = '---\naliases: [Café]\n---\nSource';
  for (const target of ['CAFÉ', 'Cafe\u0301']) {
    const plan = planMove(scan({ 'One.md': source, 'From.md': `[[${target}]]` }), 'One.md', 'Two.md');
    assert.equal(plan.ok, false);
    assert.match(plan.blockers[0].reason, /Alias-only/);
    assert.deepEqual(plan.files, []);
  }
});

test('move refuses affected folded YAML, malformed encoding, case collisions, and managed history', () => {
  for (const [values, code] of [
    [{ 'From.md': '---\nrelated: >\n  [[One]]\n---\n' }, 'AMBIGUOUS_REFERENCE'],
    [{ 'old/One.md': '[bad](../%zz.md)' }, 'AMBIGUOUS_REFERENCE'],
    [{ 'old/one.md': 'Other', 'From.md': '[[One]]' }, 'AMBIGUOUS_REFERENCE'],
    [{ 'From.md': '[[old/one]]' }, 'AMBIGUOUS_REFERENCE'],
    [{ 'Notient/Log/2026-09.md': '- [[One]]\n' }, 'AUDIT_LINK_BLOCKER'],
    [{ 'From.md': '<a href="old/One.md">link</a>' }, 'MOVE_SCAN_INCOMPLETE'],
  ]) {
    const plan = planMove(scan({ 'old/One.md': 'Source', ...values }), 'old/One.md', 'new/Two.md');
    assert.equal(plan.ok, false, JSON.stringify(values));
    assert.ok(plan.blockers.some(blocker => blocker.code === code), JSON.stringify(plan.blockers));
  }
});

test('move preserves unrelated ghosts and refuses a formerly missing basename gaining identity', () => {
  const accepted = planMove(scan({ 'old/One.md': 'Source', 'From.md': '[[One]] [[Ghost]] [ghost](lost.md)' }), 'old/One.md', 'new/Two.md');
  assert.equal(accepted.ok, true);
  assert.equal(after(accepted, 'From.md'), '[[Two]] [[Ghost]] [ghost](lost.md)');
  const blocked = planMove(scan({ 'old/One.md': 'Source', 'From.md': '[[Two]]' }), 'old/One.md', 'new/Two.md');
  assert.equal(blocked.ok, false);
  assert.match(blocked.blockers[0].reason, /missing target/);
});

test('move audit goldens cover Vaultex ambiguous basenames, aliases and malformed nested links', () => {
  const source = '1-projects/professional/agentlog/material/external_sources/agent-memory.md';
  const duplicate = '1-projects/professional/agentlog/planning/agentlog-planning/reference/agent-memory.md';
  const ambiguous = planMove(scan({ [source]: 'Source', [duplicate]: 'Duplicate', 'Clipping.md': '[[agent-memory]]' }), source, '1-projects/professional/agentlog/material/external_sources/agent-memory-renamed.md');
  assert.equal(ambiguous.ok, false);
  assert.deepEqual(ambiguous.blockers[0].candidates, [source, duplicate]);
  const alias = planMove(scan({ '1-projects/professional/organizing/PDSW25 - Program Chair.md': '---\naliases: [PDSW25]\n---\nSource', 'Duties.md': '[[PDSW25]]' }), '1-projects/professional/organizing/PDSW25 - Program Chair.md', 'Chair.md');
  assert.equal(alias.ok, false);
  assert.match(alias.blockers[0].reason, /Alias-only/);
  const malformed = '[[[Introducing ContextOS - IOWarp\'s conceptual framework](1-projects/professional/genomio-proposal/planning/Bundles/contextos.md#Introducing IOWarp)]]';
  const nested = planMove(scan({ 'One.md': 'Source', 'Archive.md': malformed }), 'One.md', 'Two.md');
  assert.equal(nested.ok, false);
  assert.ok(nested.blockers.some(blocker => /Nested wiki/.test(blocker.reason)));
  const decorated = planMove(scan({ 'old/One.md': 'Source', 'From.md': '[a](<old/%4Fne.md#%5Eblock> "Exact") ![horizontal line][image1]\n[image1]: https://example.org/image.png "Title"\n' }), 'old/One.md', 'new/Café Note.md');
  assert.equal(decorated.ok, true, JSON.stringify(decorated.blockers));
  assert.equal(after(decorated, 'From.md'), '[a](<new/Caf%C3%A9%20Note.md#%5Eblock> "Exact") ![horizontal line][image1]\n[image1]: https://example.org/image.png "Title"\n');
});

test('move preserves Markdown code labels and refuses suffix or normalization-dependent identities', () => {
  const good = planMove(scan({ 'One.md': 'Source', 'From.md': '[`code` label](One.md) [[ One |display]]' }), 'One.md', 'Two.md');
  assert.equal(good.ok, true, JSON.stringify(good.blockers));
  assert.equal(after(good, 'From.md'), '[`code` label](Two.md) [[ Two |display]]');
  for (const values of [
    { 'old/One.md': 'Source', 'folder/old/One.md': 'Other', 'folder/From.md': '[[old/One]]' },
    { 'Café.md': 'Source', 'From.md': '[[Cafe\u0301]]' },
  ]) {
    const source = Object.keys(values)[0];
    const plan = planMove(scan(values), source, 'New.md');
    assert.equal(plan.ok, false);
    assert.ok(plan.blockers.some(blocker => blocker.code === 'AMBIGUOUS_REFERENCE'));
  }
});

test('fresh move scan bounds Markdown and includes attachments while excluding hidden paths', t => {
  const f = writerFixture(t);
  put(f, 'old/One.md', 'Source'); put(f, 'From.md', '[[One]]'); put(f, 'media/image.png', Buffer.from([0, 1, 2])); put(f, '.obsidian/hidden.md', '[[One]]');
  const fresh = scanMoveVault(f.vault.path);
  assert.deepEqual(fresh.inventory, ['From.md', 'media/image.png', 'old/One.md']);
  assert.throws(() => scanMoveVault(f.vault.path, { maxNotes: 1 }), error => error.code === 'MOVE_SCAN_LIMIT');
  assert.throws(() => scanMoveVault(f.vault.path, { maxBytes: 1 }), error => error.code === 'MOVE_SCAN_LIMIT');
  symlinkSync(path.join(f.vault.path, 'From.md'), path.join(f.vault.path, 'Skipped.md'));
  assert.equal(planMove(scanMoveVault(f.vault.path), 'old/One.md', 'new/Two.md').ok, false);
});

test('revise move preview returns exact splices and diffs without changing any workspace byte', t => {
  const f = writerFixture(t);
  put(f, 'old/One.md', '# Source\n[self](#head)\n'); put(f, 'From.md', '🧠 [[One|display]] [md](old/One.md "title")\n');
  baseline(f, ['old/One.md', 'From.md']);
  const input = { vault: f.vault.id, requestId: 'move-preview-001', batch: 'move-preview', authorization: { origin: 'operator', request: 'Move One to new/Two.md and repair references.' }, operation: 'move', path: 'old/One.md', revision: revision(readFileSync(path.join(f.vault.path, 'old/One.md'))), destination: 'new/Two.md', dryRun: true };
  const before = snapshot(f.temporary);
  const result = writeOperation('revise', input, { directory: f.directory });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.outcome, 'preview');
  assert.equal(result.changes.length, 4);
  assert.equal(result.changes.find(file => file.path === 'From.md').splices.length, 2);
  assert.ok(result.changes.every(file => file.diff.includes('@@')));
  assert.deepEqual(snapshot(f.temporary), before);
  assert.equal(writeOperation('revise', { ...input, dryRun: false }, { directory: f.directory }).error.code, 'PLAN_HASH_REQUIRED');
  const tool = fileURLToPath(new URL('../tools/revise.mjs', import.meta.url));
  const cli = spawnSync(process.execPath, [tool, JSON.stringify(input)], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) } });
  assert.equal(cli.status, 0, cli.stderr + cli.stdout);
  assert.equal(JSON.parse(cli.stdout).outcome, 'preview');
  assert.deepEqual(snapshot(f.temporary), before);
});

test('revise move refusal names every blocker and leaves all bytes unchanged', t => {
  const f = writerFixture(t);
  put(f, 'old/One.md', 'Source'); put(f, 'other/One.md', 'Other');
  for (const name of ['A.md', 'B.md', 'C.md']) put(f, name, '[[One]]');
  baseline(f, ['old/One.md', 'other/One.md', 'A.md', 'B.md', 'C.md']);
  const before = snapshot(f.temporary);
  const result = writeOperation('revise', { vault: f.vault.id, batch: 'ambiguous-move', authorization: { origin: 'clio', request: 'Move One.' }, operation: 'move', path: 'old/One.md', revision: revision('Source'), destination: 'new/Two.md', dryRun: true }, { directory: f.directory });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AMBIGUOUS_REFERENCE');
  assert.deepEqual([...new Set(result.error.paths)], ['A.md', 'B.md', 'C.md']);
  assert.deepEqual(snapshot(f.temporary), before);
});
