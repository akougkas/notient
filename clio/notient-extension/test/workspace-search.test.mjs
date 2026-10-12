import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writerFixture, put } from './write-helpers.mjs';
import { refreshIndex, searchIndex, openIndex } from '../lib/index.mjs';
import { writeOperation } from '../lib/write.mjs';
import { baseline } from './git-write.test.mjs';

const provenance = workspace => `---\ncreated_by: "operator"\ncaptured_at: "2026-10-11T12:00:00.000Z"\nworkspace: ${JSON.stringify(workspace)}\n---\n`;

test('T9 frozen search schema and semantic validation share the 255-character workspace bound', t => {
  const f = writerFixture(t); const maximum = 'x'.repeat(255);
  put(f, 'Bound.md', `---\nworkspace: "${maximum}"\n---\nquartz\n`); refreshIndex(f.vault, f.directory);
  const manifest = JSON.parse(readFileSync(new URL('../clio-coder-extension.yaml', import.meta.url), 'utf8'));
  assert.equal(manifest.capabilities.tools.find(tool => tool.name === 'search').inputSchema.properties.workspace.maxLength, 255);
  assert.equal(searchIndex(f.vault, f.directory, { query: 'quartz', workspace: maximum }).hits[0].path, 'Bound.md');
  assert.throws(() => searchIndex(f.vault, f.directory, { query: 'quartz', workspace: maximum + 'x' }), /255/);
  for (const [workspace, expected] of [[maximum, 0], [maximum + 'x', 1]]) {
    const command = spawnSync(process.execPath, [fileURLToPath(new URL('../tools/search.mjs', import.meta.url)), JSON.stringify({ query: 'quartz', workspace })], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: f.directory.slice(0, -'/notient'.length) } });
    assert.equal(command.status, expected, command.stdout);
    if (expected === 0) assert.equal(JSON.parse(command.stdout).hits[0].path, 'Bound.md');
    else assert.match(JSON.parse(command.stdout).error.message, /workspace.*bounds/);
  }
});

test('T8 exact workspace alone matches authored notes and backfills the older provenance-dependent cache', t => {
  const f = writerFixture(t);
  put(f, 'Authored.md', '---\nworkspace: repo\n---\nquartz\n');
  put(f, 'Incomplete.md', '---\nworkspace: "repo"\ncaptured_at: invalid\n---\nquartz\n');
  put(f, 'Single quoted.md', "---\nworkspace: 'repo'\n---\nquartz\n");
  put(f, 'Case.md', '---\nworkspace: Repo\n---\nquartz\n');
  put(f, 'Prefix.md', '---\nworkspace: repo-extra\n---\nquartz\n');
  put(f, 'Missing.md', '---\ncreated_by: clio\ncaptured_at: "2026-10-11T12:00:00.000Z"\n---\nquartz\n');
  refreshIndex(f.vault, f.directory);
  const expected = ['Authored.md', 'Incomplete.md', 'Single quoted.md'];
  assert.deepEqual(searchIndex(f.vault, f.directory, { query: 'quartz', workspace: 'repo', limit: 20 }).hits.map(hit => hit.path).sort(), expected);
  const db = openIndex(f.directory, f.vault, true);
  db.exec("DELETE FROM meta WHERE key='workspaceRule'; UPDATE note_workspaces SET workspace=NULL"); db.close();
  assert.deepEqual(searchIndex(f.vault, f.directory, { query: 'quartz', workspace: 'repo', limit: 20 }).hits.map(hit => hit.path).sort(), expected);
});

test('R9 workspace exact filter runs before ranking and the 1000-candidate ceiling', t => {
  const f = writerFixture(t);
  for (let i = 0; i < 1001; i++) put(f, `Other/${i}.md`, provenance('other') + 'quartz\n');
  put(f, 'Target.md', provenance('Project A') + 'The desired quartz passage.\n');
  put(f, 'Prefix.md', provenance('Project A extra') + 'quartz\n');
  put(f, 'Case.md', provenance('project a') + 'quartz\n');
  put(f, 'No provenance.md', 'quartz\n');
  refreshIndex(f.vault, f.directory);
  const result = searchIndex(f.vault, f.directory, { query: 'quartz', workspace: 'Project A', limit: 20 });
  assert.deepEqual(result.hits.map(hit => hit.path), ['Target.md']);
  assert.equal(result.candidateLimitReached, false);
  assert.equal(searchIndex(f.vault, f.directory, { query: 'quartz', workspace: 'missing' }).hits.length, 0);
});

test('R9 schema accepts workspace and capture repair populates provenance without a refresh', t => {
  const f = writerFixture(t); baseline(f); refreshIndex(f.vault, f.directory);
  const captured = writeOperation('capture', { name: 'Searchable', content: 'Workspace quartz evidence.\n', batch: 'workspace', authorization: { origin: 'operator', request: 'Capture workspace evidence.' } }, { directory: f.directory });
  assert.equal(captured.ok, true, JSON.stringify(captured));
  const input = { query: 'quartz', workspace: captured.capture.workspace };
  const command = spawnSync(process.execPath, [fileURLToPath(new URL('../tools/search.mjs', import.meta.url)), JSON.stringify(input)], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: f.directory.slice(0, -'/notient'.length) } });
  assert.equal(command.status, 0, command.stdout);
  assert.deepEqual(JSON.parse(command.stdout).hits.map(hit => hit.path), [captured.capture.path]);
  const db = openIndex(f.directory, f.vault, true);
  db.exec('DROP TABLE note_workspaces'); db.close();
  const backfilled = searchIndex(f.vault, f.directory, input);
  assert.deepEqual(backfilled.hits.map(hit => hit.path), [captured.capture.path]);
  assert.match(readFileSync(new URL('../clio-coder-extension.yaml', import.meta.url), 'utf8'), /"workspace"/);
});
