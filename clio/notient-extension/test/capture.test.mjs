import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { atomicJson } from '../lib/config.mjs';
import { initializeGit, git } from '../lib/git.mjs';
import { refreshIndex, searchIndex, openIndex } from '../lib/index.mjs';
import { writeOperation } from '../lib/write.mjs';
import { documentSpans } from '../lib/markdown.mjs';
import { writerFixture, put, snapshot } from './write-helpers.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const captureInput = f => ({ vault: f.vault.id, batch: 'capture-test', authorization: { origin: 'operator', request: 'Capture [[exact]] request words.\nKeep the second line.' }, name: 'New Note', content: '# Storage\r\n\r\nExact café 🧠 bytes.' });

function captureFixture(t) { const f = writerFixture(t); initializeGit(f.vault.path); refreshIndex(f.vault, f.directory); return f; }

test('capture preserves caller body and fields while adding provenance and minting retryable IDs', t => {
  for (const content of ['# LF\nBody\n', '# CRLF\r\nBody\r\n', '\uFEFF--- \r\ntitle: Original\r\n...\r\n# Body\nMixed ending.', 'No final newline', '---\ntitle: Empty body\n---\n']) {
    const f = captureFixture(t);
    const input = { ...captureInput(f), content };
    const result = writeOperation('capture', input, { directory: f.directory });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.outcome, 'committed');
    assert.match(result.requestId, /^[a-f0-9-]{36}$/);
    const stored = readFileSync(path.join(f.vault.path, result.changes[0].path));
    const parsed = documentSpans(stored);
    const supplied = documentSpans(Buffer.from(content));
    assert.equal(parsed.text.slice(parsed.bodyStart), supplied.text.slice(supplied.bodyStart).replaceAll('\r\n', '\n'));
    assert.match(parsed.text, /created_by: "clio"/);
    assert.match(parsed.text, /tags: \[\]/);
    assert.equal(result.capture.workspace, path.basename(process.cwd()));
    assert.match(result.capture.path, /^Notient\/Inbox\/\d{4}-\d{2}-\d{2}-/);
    assert.equal(result.capture.revision, result.changes[0].after);
    assert.equal(result.indexState, 'updated');
    const retried = writeOperation('capture', { ...input, requestId: result.requestId }, { directory: f.directory });
    assert.equal(retried.outcome, 'already_committed');
    assert.equal(retried.commit.oid, result.commit.oid);
    assert.equal(git(f.vault.path, ['rev-list', '--count', 'HEAD']), '1');
    const log = readFileSync(path.join(f.vault.path, result.log.path), 'utf8');
    assert.equal(log.split('\n').filter(line => line.startsWith('- ')).length, 1);
    assert.ok(!log.includes('[['));
    assert.equal(JSON.parse(log.trim().slice(2)).request, input.authorization.request);
  }
});

test('capture allocates case-folded collision suffixes and binds explicit retry IDs', t => {
  const f = captureFixture(t);
  const date = new Date().toISOString().slice(0, 10);
  put(f, `Notient/Inbox/${date}-new note.md`, 'Unrelated existing note.');
  const input = { ...captureInput(f), requestId: 'operator.capture_001' };
  const result = writeOperation('capture', input, { directory: f.directory });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.changes[0].path, `Notient/Inbox/${date}-New Note-2.md`);
  assert.equal(result.requestId, input.requestId);
  const before = snapshot(f.temporary);
  const reused = writeOperation('capture', { ...input, content: 'Different request.' }, { directory: f.directory });
  assert.equal(reused.error.code, 'REQUEST_ID_REUSED');
  assert.deepEqual(snapshot(f.temporary), before);
});

test('capture previews create no artifacts and plan hashes reject later HEAD changes', t => {
  const f = captureFixture(t);
  const input = { ...captureInput(f), requestId: 'capture-preview-001' };
  const before = snapshot(f.temporary);
  const preview = writeOperation('capture', { ...input, dryRun: true }, { directory: f.directory });
  assert.equal(preview.outcome, 'preview', JSON.stringify(preview));
  assert.equal(preview.operationId, null);
  assert.match(preview.changes[0].diff, /Display encoding: CR/);
  assert.match(preview.changes[0].diff, /No newline at end of file/);
  assert.deepEqual(snapshot(f.temporary), before);
  assert.equal(existsSync(path.join(f.vault.path, 'Notient')), false);
  const applied = writeOperation('capture', { ...input, planHash: preview.planHash }, { directory: f.directory });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const changed = writeOperation('capture', { ...input, content: `${input.content}\nDifferent body.`, requestId: 'capture-preview-002', planHash: preview.planHash }, { directory: f.directory });
  assert.equal(changed.error.code, 'PLAN_CHANGED');
});

test('capture updates only affected index paths and records own revisions', t => {
  const f = captureFixture(t);
  const result = writeOperation('capture', captureInput(f), { directory: f.directory });
  assert.equal(result.ok, true, JSON.stringify(result));
  const search = searchIndex(f.vault, f.directory, { query: 'café' });
  assert.equal(search.hits.length, 1);
  assert.equal(search.hits[0].path, result.changes[0].path);
  const db = openIndex(f.directory, f.vault);
  try { assert.equal(db.prepare('SELECT revision FROM own_revisions WHERE path = ? AND operation = ?').get(result.changes[0].path, result.operationId).revision, result.changes[0].after); }
  finally { db.close(); }
});

test('capture refuses invalid input, read-only writes and publication collisions', t => {
  const f = captureFixture(t);
  for (const fields of [{ name: 'CON' }, { name: '../Escape' }, { name: 'Name.md' }, { content: '---\nUnclosed' }, { content: 'NUL\0' }, { requestId: 'short' }, { requestId: 'invalid/id-0001' }]) {
    const result = writeOperation('capture', { ...captureInput(f), ...fields }, { directory: f.directory });
    assert.equal(result.ok, false);
    assert.equal(result.operationId, null);
  }
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, readOnly: true }] });
  const before = snapshot(f.temporary);
  assert.equal(writeOperation('capture', captureInput(f), { directory: f.directory }).error.code, 'READ_ONLY_VAULT');
  assert.deepEqual(snapshot(f.temporary), before);
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [f.vault] });
  const collision = writeOperation('capture', { ...captureInput(f), requestId: 'capture-race-001' }, { directory: f.directory, barrier(name, record) { if (name === 'afterIntent') put(f, record.files[0].path, 'Third-party exclusive destination.'); } });
  assert.equal(collision.ok, false);
  const collided = `Notient/Inbox/${new Date().toISOString().slice(0, 10)}-New Note.md`;
  assert.equal(readFileSync(path.join(f.vault.path, collided), 'utf8'), 'Third-party exclusive destination.');
});

test('capture command uses closed schemas, enum checks and structured refusals', t => {
  const f = captureFixture(t);
  const run = input => spawnSync(process.execPath, [path.join(packageRoot, 'tools/capture.mjs'), JSON.stringify(input)], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory), AI_AGENT: 'test' } });
  const result = run(captureInput(f));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  for (const extra of [{ extra: true }, { authorization: { origin: 'invented', request: 'request' } }, { requestId: 'bad' }]) {
    const invalid = run({ ...captureInput(f), ...extra });
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stdout).error.code, 'INVALID_INPUT');
  }
});

test('setup access changes registration without touching vault bytes or git', t => {
  const f = writerFixture(t);
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, captureLimitPerHour: 6 }] });
  const packageCopy = path.join(f.temporary, 'package');
  cpSync(packageRoot, packageCopy, { recursive: true });
  put(f, 'One.md', 'Operator bytes.');
  const before = snapshot(f.vault.path);
  const env = { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) };
  delete env.AI_AGENT;
  for (const access of ['read-only', 'read-write']) {
    const result = spawnSync(process.execPath, [path.join(packageCopy, 'bin/setup.mjs'), '--vault', f.vault.path, '--access', access], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshot(f.vault.path), before);
    assert.deepEqual(readdirSync(f.vault.path), ['One.md']);
    const registered = JSON.parse(readFileSync(path.join(f.directory, 'config.json'))).vaults[0];
    assert.equal(registered.readOnly, access === 'read-only');
    assert.equal(registered.captureLimitPerHour, 6);
  }
});
