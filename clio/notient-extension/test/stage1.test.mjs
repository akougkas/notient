import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { atomicJson, indexPath, readConfig, selectVault } from '../lib/config.mjs';
import { revision, vaultId } from '../lib/paths.mjs';
import { parseMarkdown } from '../lib/markdown.mjs';
import { refreshIndex, searchIndex, openIndex, probeFts5 } from '../lib/index.mjs';
import { inspectNote } from '../lib/note.mjs';
import { statusSnapshot } from '../lib/status.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const toy = fileURLToPath(new URL('../../fixtures/toy-vault/', import.meta.url));

function fixture(t, copy = false) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'notient-stage1-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const vaultPath = path.join(temporary, 'vault');
  const directory = path.join(temporary, 'state/notient');
  if (copy) cpSync(toy, vaultPath, { recursive: true, filter: name => !name.split(path.sep).includes('.git') });
  else mkdirSync(vaultPath);
  const vault = { id: vaultId(vaultPath), path: vaultPath, role: 'operator', readOnly: true };
  atomicJson(path.join(directory, 'config.json'), { version: 1, vaults: [vault] });
  return { temporary, vault, directory };
}

function put(f, name, text) {
  mkdirSync(path.dirname(path.join(f.vault.path, name)), { recursive: true });
  writeFileSync(path.join(f.vault.path, name), text);
}

function command(f, name, input) {
  const result = spawnSync(process.execPath, [path.join(root, `tools/${name}.mjs`), JSON.stringify(input)], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory), AI_AGENT: 'test' } });
  return { ...result, value: JSON.parse(result.stdout) };
}

function snapshot(directory) {
  const result = {};
  function visit(base) {
    for (const entry of readdirSync(path.join(directory, base), { withFileTypes: true })) {
      const name = path.join(base, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) result[name] = revision(readFileSync(path.join(directory, name)));
    }
  }
  visit('');
  return result;
}

test('operator setup refuses every AI_AGENT value before touching files', t => {
  const f = fixture(t);
  for (const value of ['clio', '']) {
    const result = spawnSync(process.execPath, [path.join(root, 'bin/setup.mjs'), '--vault', f.vault.path], { encoding: 'utf8', env: { ...process.env, AI_AGENT: value, XDG_STATE_HOME: path.dirname(f.directory) } });
    assert.equal(result.status, 2);
    assert.equal(result.stderr, 'Notient setup is an operator act and refuses AI_AGENT.\n');
    assert.equal(result.stdout, '');
    assert.equal(existsSync(path.join(f.vault.path, 'Notient')), false);
    assert.equal(existsSync(path.join(f.vault.path, '.git')), false);
  }
});

test('setup registers read-only without changing a vault and updates only its copied package envelope', t => {
  const f = fixture(t);
  const packageCopy = path.join(f.temporary, 'notient-extension');
  cpSync(root, packageCopy, { recursive: true });
  const env = { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) };
  delete env.AI_AGENT;
  const result = spawnSync(process.execPath, [path.join(packageCopy, 'bin/setup.mjs'), '--vault', f.vault.path, '--read-only'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(f.vault.path), []);
  assert.equal(statSync(path.join(f.directory, 'config.json')).mode & 0o777, 0o600);
  assert.equal(readConfig(f.directory).vaults[0].readOnly, true);
  const manifest = JSON.parse(readFileSync(path.join(packageCopy, 'clio-coder-extension.yaml'), 'utf8'));
  assert.deepEqual(manifest.runtime.permissions.fs, { read: [f.directory, f.vault.path], write: [] });
  assert.match(result.stdout, /clio-coder library install/);
  assert.match(result.stdout, /clio-coder extensions install.*--user/);
});

test('setup initializes a vault-local repository and preserves existing conventions', t => {
  const f = fixture(t);
  const packageCopy = path.join(f.temporary, 'notient-extension');
  cpSync(root, packageCopy, { recursive: true });
  const env = { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) };
  delete env.AI_AGENT;
  const args = [path.join(packageCopy, 'bin/setup.mjs'), '--vault', f.vault.path];
  let result = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(path.join(f.vault.path, '.git/HEAD')));
  const conventionsPath = path.join(f.vault.path, 'Notient/Conventions.md');
  assert.match(readFileSync(conventionsPath, 'utf8'), /0-inbox/);
  writeFileSync(conventionsPath, '# Operator conventions\r\nKeep these bytes.\r\n');
  result = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(conventionsPath, 'utf8'), '# Operator conventions\r\nKeep these bytes.\r\n');
  assert.equal(readConfig(f.directory).vaults.length, 1);
});

test('toy vault tools return verified storage passages without changing vault bytes', t => {
  const f = fixture(t, true);
  const before = snapshot(f.vault.path);
  const refresh = command(f, 'refresh', {});
  assert.equal(refresh.status, 0, refresh.stderr);
  assert.equal(refresh.value.scanned, 12);
  assert.equal(refresh.value.changed, 12);
  const search = command(f, 'search', { query: 'storage', limit: 5 });
  assert.equal(search.status, 0, search.stderr);
  assert.equal(search.value.hits.length, 5);
  for (const hit of search.value.hits) {
    const bytes = readFileSync(path.join(f.vault.path, hit.path));
    assert.equal(hit.revision, revision(bytes));
    assert.equal(bytes.subarray(hit.source.startByte, hit.source.endByte).toString('utf8'), hit.passage);
    assert.ok(hit.passage.length <= 1200);
    assert.ok(hit.headingPath.length);
    assert.ok(!/^#{1,6}\s+[^\n]+\n?$/.test(hit.passage));
  }
  const note = command(f, 'note', { path: '3-resources/storage/Key-Value Store Design.md' });
  assert.equal(note.status, 0, note.stderr);
  assert.ok(note.value.linksIn.some(link => link.path === '1-projects/consensus/Raft Implementation.md'));
  assert.ok(note.value.tags.includes('storage'));
  const status = command(f, 'status', {});
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.value.fts5, true);
  assert.equal(status.value.nodeVersion, process.version);
  assert.equal(status.value.vaults[0].index.pending, 0);
  assert.deepEqual(snapshot(f.vault.path), before);
  assert.ok(existsSync(indexPath(f.directory, f.vault)));
});

test('incremental refresh changes, deletes and relinks notes without stale FTS rows', t => {
  const f = fixture(t);
  put(f, 'Source.md', '# Source\n\n[[Target]] has storage.\n');
  refreshIndex(f.vault, f.directory);
  let result = refreshIndex(f.vault, f.directory);
  assert.equal(result.changed, 0);
  assert.equal(result.hashed, 0);
  put(f, 'Target.md', '# Target\n\nquartz storage\n');
  result = refreshIndex(f.vault, f.directory);
  assert.equal(result.changed, 1);
  assert.equal(inspectNote(f.vault, f.directory, { path: 'Target.md' }).linksIn.length, 1);
  put(f, 'Target.md', '# Target\n\nNew graphite passage.\n');
  refreshIndex(f.vault, f.directory);
  assert.equal(searchIndex(f.vault, f.directory, { query: 'quartz' }).hits.length, 0);
  assert.equal(searchIndex(f.vault, f.directory, { query: 'graphite' }).hits.length, 1);
  unlinkSync(path.join(f.vault.path, 'Target.md'));
  result = refreshIndex(f.vault, f.directory);
  assert.equal(result.deleted, 1);
  assert.equal(searchIndex(f.vault, f.directory, { query: 'graphite' }).hits.length, 0);
  assert.equal(inspectNote(f.vault, f.directory, { path: 'Source.md' }).linksOut[0].resolution, 'unresolved');
});

test('search refuses stale evidence and logs only exact served bytes', t => {
  const f = fixture(t);
  put(f, 'One.md', '# One\n\nstorage original\n');
  refreshIndex(f.vault, f.directory);
  put(f, 'One.md', '# One\n\nstorage changed\n');
  let search = searchIndex(f.vault, f.directory, { query: 'storage' });
  assert.deepEqual(search.hits, []);
  assert.deepEqual(search.stalePaths, ['One.md']);
  assert.equal(statusSnapshot(f.directory).vaults[0].index.pending, 1);
  refreshIndex(f.vault, f.directory);
  search = searchIndex(f.vault, f.directory, { query: 'storage' });
  const db = openIndex(f.directory, f.vault);
  const served = db.prepare('SELECT * FROM served').all();
  db.close();
  assert.equal(served.length, 1);
  assert.equal(served[0].passage, search.hits[0].passage);
  assert.equal(served[0].revision, search.hits[0].revision);
  assert.equal(served[0].passage_hash, revision(search.hits[0].passage));
});

test('long lexical queries suppress their source and accept punctuation without FTS syntax errors', t => {
  const f = fixture(t);
  put(f, 'Self.md', '# Source\n\nThis storage phrase appears only in my own note.\n');
  put(f, 'Other.md', '# Other\n\nStorage reference.\n');
  refreshIndex(f.vault, f.directory);
  const result = searchIndex(f.vault, f.directory, { query: '"This storage phrase" OR: appears (only) in my own note!', sourcePath: 'Self.md' });
  assert.ok(result.hits.length);
  assert.ok(result.hits.every(hit => hit.path === 'Other.md'));
  assert.equal(searchIndex(f.vault, f.directory, { query: 'phrase', sourcePath: 'Self.md' }).hits.length, 0);
  assert.throws(() => searchIndex(f.vault, f.directory, { query: 'storage', limit: 21 }), /between 1 and 20/);
});

test('frontmatter, Unicode, CRLF and long source lines retain exact byte ranges', t => {
  const f = fixture(t);
  const text = '\uFEFF---\r\ntags: [storage, café]\r\nodd: "keep: bytes"\r\n---\r\n# Résumé\r\n\r\n' + 'Storage café 🧠 '.repeat(200) + '\r\n';
  put(f, 'Unicode.md', text);
  refreshIndex(f.vault, f.directory);
  const search = searchIndex(f.vault, f.directory, { query: 'café', limit: 20 });
  assert.ok(search.hits.length > 1);
  for (const hit of search.hits) {
    assert.equal(Buffer.from(text).subarray(hit.source.startByte, hit.source.endByte).toString('utf8'), hit.passage);
    assert.ok(hit.passage.length <= 1200);
    assert.ok(!hit.passage.includes('\uFFFD'));
  }
  const note = inspectNote(f.vault, f.directory, { path: 'Unicode.md', startLine: 5, endLine: 5 });
  assert.equal(note.body, '# Résumé\r\n');
  assert.equal(note.frontmatter, text.slice(0, text.indexOf('# Résumé')));
  assert.deepEqual(note.source, { startLine: 5, endLine: 5, startByte: Buffer.byteLength(note.frontmatter), endByte: Buffer.byteLength(note.frontmatter + note.body) });
});

test('visitor evidence is excluded and code does not invent links or headings', t => {
  const f = fixture(t);
  put(f, 'Evidence.md', '# Authored\n\nrealproof storage\n\n<!-- notient:begin -->\nvisitoronly claim\n<!-- notient:end -->\n\n## Details\n\nordinary proof\n\n## Notient Intelligence\n\nothergenerated claim\n\n## Authored again\n\n```md\n[[Fake]]\n# False heading\n```\n\n[[Real#Part|Alias]] and ![[Real#Part|Embed]].\n');
  refreshIndex(f.vault, f.directory);
  assert.equal(searchIndex(f.vault, f.directory, { query: 'visitoronly othergenerated' }).hits.length, 0);
  assert.equal(searchIndex(f.vault, f.directory, { query: 'realproof' }).hits.length, 1);
  const note = inspectNote(f.vault, f.directory, { path: 'Evidence.md' });
  assert.deepEqual(note.linksOut.map(link => [link.target, link.fragment, link.alias, link.embed]), [['Real', 'Part', 'Alias', false], ['Real', 'Part', 'Embed', true]]);
  assert.ok(!note.outline.some(heading => heading.title === 'False heading'));
});

test('ambiguous wiki names and encoded Markdown targets are represented explicitly', t => {
  const f = fixture(t);
  put(f, 'A/Target.md', '# A\n');
  put(f, 'B/Target.md', '# B\n');
  put(f, 'Space Note.md', '# Spaced\n');
  put(f, 'Source.md', '# Source\n\n[[Target|keep alias]] ![file](Space%20Note.md#Part) [web](https://example.org/a_(b))\n');
  refreshIndex(f.vault, f.directory);
  const note = inspectNote(f.vault, f.directory, { path: 'Source.md' });
  assert.equal(note.linksOut[0].resolution, 'ambiguous');
  assert.deepEqual(note.linksOut[0].candidates, ['A/Target.md', 'B/Target.md']);
  assert.equal(note.linksOut[1].resolution, 'resolved');
  assert.equal(note.linksOut[1].fragment, 'Part');
  assert.equal(note.linksOut[2].resolution, 'external');
});

test('notes reject traversal and symlinks while refresh reports skipped links', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.temporary, 'outside.md'), 'Private outside note.');
  symlinkSync(path.join(f.temporary, 'outside.md'), path.join(f.vault.path, 'link.md'));
  symlinkSync(f.temporary, path.join(f.vault.path, 'escape'));
  assert.throws(() => inspectNote(f.vault, f.directory, { path: '../outside.md' }), /traversal/);
  assert.throws(() => inspectNote(f.vault, f.directory, { path: 'link.md' }), /Symbolic/);
  assert.throws(() => inspectNote(f.vault, f.directory, { path: 'escape/outside.md' }), /Symbolic/);
  assert.equal(refreshIndex(f.vault, f.directory).skippedCount, 2);
});

test('reference links resolve definitions and literal visitor markers in a code fence do not hide authored text', t => {
  const f = fixture(t);
  put(f, 'Target.md', '# Target\n');
  put(f, 'Source.md', '# Source\n\n[Named][ref] and ![ref][] and [ref].\n\n[ref]: Target.md#Fragment\n\n```text\n<!-- notient:begin -->\nexample\n<!-- notient:end -->\n```\n\nvisibleafterfence proof\n');
  refreshIndex(f.vault, f.directory);
  const note = inspectNote(f.vault, f.directory, { path: 'Source.md' });
  assert.equal(note.linksOut.length, 3);
  assert.ok(note.linksOut.every(link => link.resolution === 'resolved' && link.fragment === 'Fragment'));
  assert.equal(searchIndex(f.vault, f.directory, { query: 'visibleafterfence' }).hits.length, 1);
});

test('unreadable note formats are reported without serving stale content', t => {
  const f = fixture(t);
  put(f, 'Broken.md', '# Good\n\nstorage proof\n');
  refreshIndex(f.vault, f.directory);
  put(f, 'Broken.md', '---\nmissing close\n');
  const result = refreshIndex(f.vault, f.directory);
  assert.equal(result.errorCount, 1);
  assert.equal(searchIndex(f.vault, f.directory, { query: 'storage' }).hits.length, 0);
  assert.throws(() => inspectNote(f.vault, f.directory, { path: 'Broken.md' }), /closing delimiter/);
});

test('direct command schemas refuse unknown properties and invalid limits', t => {
  const f = fixture(t);
  for (const [name, input] of [['status', { authorization: {} }], ['search', { query: 'storage', limit: 21 }], ['note', { path: 'One.md', startLine: 0 }], ['refresh', { force: 'true' }]]) {
    const result = command(f, name, input);
    assert.equal(result.status, 1);
    assert.ok(result.value.error);
  }
});

test('unregistered vaults and data inside a vault are refused', t => {
  const f = fixture(t);
  assert.throws(() => selectVault('/unregistered', f.directory), /registered vault/);
  assert.throws(() => indexPath(f.vault.path, f.vault), /external index/);
  const linked = path.join(f.temporary, 'linked-state');
  symlinkSync(f.vault.path, linked);
  assert.throws(() => indexPath(linked, f.vault), /external index/);
});

test('read-only status and note do not change index or create missing state', t => {
  const f = fixture(t);
  put(f, 'One.md', '# One\n\nStorage.\n');
  assert.equal(statusSnapshot(f.directory).vaults[0].index.state, 'missing');
  assert.equal(inspectNote(f.vault, f.directory, { path: 'One.md' }).index.available, false);
  assert.equal(existsSync(indexPath(f.directory, f.vault)), false);
  refreshIndex(f.vault, f.directory);
  const before = snapshot(f.directory);
  statusSnapshot(f.directory);
  statusSnapshot(f.directory, { runtime: true });
  inspectNote(f.vault, f.directory, { path: 'One.md' });
  assert.deepEqual(snapshot(f.directory), before);
});

test('FTS5 probe retries capability detection and closes each in-memory database', t => {
  const execute = DatabaseSync.prototype.exec;
  const close = DatabaseSync.prototype.close;
  let fail = false;
  let closed = 0;
  const calls = [];
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    calls.push(sql);
    if (fail) throw new Error('no such module: fts5');
    return execute.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, 'close', function () { closed++; return close.call(this); });
  assert.equal(probeFts5(), true);
  fail = true;
  assert.equal(probeFts5(), false);
  fail = false;
  assert.equal(probeFts5(), true);
  assert.deepEqual(calls, Array(3).fill('CREATE VIRTUAL TABLE temp.x USING fts5(a)'));
  assert.equal(closed, 3);
});

test('missing FTS5 reports versioned status and unknown coverage without touching an index', t => {
  const f = fixture(t);
  put(f, 'One.md', '# One\n\nStorage evidence.\n');
  refreshIndex(f.vault, f.directory);
  const before = snapshot(f.temporary);
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    assert.equal(sql, 'CREATE VIRTUAL TABLE temp.x USING fts5(a)');
    throw new Error('no such module: fts5');
  });
  const coverage = {
    state: 'unknown', indexing: { state: 'unavailable', reason: 'fts5_unavailable' },
    message: 'Structural index coverage is unavailable; empty results do not establish that the vault has no matching notes.',
  };
  for (const runtime of [false, true]) {
    const status = statusSnapshot(f.directory, { runtime });
    assert.equal(status.fts5, false);
    assert.equal(status.nodeVersion, process.version);
    assert.equal(status.vaults[0].error, undefined);
    assert.equal(status.vaults[0].index.state, 'unavailable');
    assert.equal(status.vaults[0].index.notes, null);
    assert.deepEqual(status.vaults[0].index.coverage, coverage);
  }
  for (const directory of [f.directory, path.join(f.temporary, 'missing-state')]) {
    const search = searchIndex(f.vault, directory, { query: 'storage', sourcePath: 'One.md' });
    assert.equal(search.fts5, false);
    assert.equal(search.nodeVersion, process.version);
    assert.deepEqual(search.coverage, coverage);
    assert.deepEqual(search.hits, []);
    assert.deepEqual(search.stalePaths, []);
    assert.equal(search.excludedSource, 'One.md');
    assert.equal(search.refreshRequired, false);
  }
  assert.deepEqual(snapshot(f.temporary), before);
});

test('command tools return degraded FTS5 results with exit zero', t => {
  const f = fixture(t);
  const before = snapshot(f.temporary);
  const injected = `
    import { DatabaseSync } from 'node:sqlite';
    const execute = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (sql) {
      if (sql === 'CREATE VIRTUAL TABLE temp.x USING fts5(a)') throw new Error('no such module: fts5');
      return execute.call(this, sql);
    };
    await import(process.argv[1]);
  `;
  for (const [name, input] of [['status', {}], ['search', { query: 'storage' }]]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', injected, path.join(root, `tools/${name}.mjs`), JSON.stringify(input)], {
      encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory), AI_AGENT: 'test' },
    });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.fts5, false);
    assert.equal(value.nodeVersion, process.version);
    assert.equal(value.error, undefined);
    if (name === 'search') {
      assert.equal(value.coverage.state, 'unknown');
      assert.equal(value.coverage.message, 'Structural index coverage is unavailable; empty results do not establish that the vault has no matching notes.');
      assert.deepEqual(value.hits, []);
    }
  }
  assert.deepEqual(snapshot(f.temporary), before);
});
