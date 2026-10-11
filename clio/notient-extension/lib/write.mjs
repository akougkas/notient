import { existsSync, mkdirSync, lstatSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, chmodSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { currentFile, writePath, revision, refuse, WriteError, validText, MAX_NOTE_BYTES, portableName, portableFold } from './paths.mjs';
import { selectVault, readConfig, dataDirectory } from './config.mjs';
import { createGitAdapter, preflightGit } from './git.mjs';
import { statusSnapshot } from './status.mjs';
import { documentSpans, replaceBody, editFrontmatter } from './markdown.mjs';
import { repairCommittedIndex } from './index.mjs';
import { persistIntent, saveRecord, readBlob, readRecord, listRecords, operationDirectory, withWriterLock, requestIdPattern, syncDirectory, durableFile } from './journal.mjs';

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function requestDigest(vault, tool, input) {
  const { dryRun, planHash, vault: selector, ...request } = input;
  return revision(canonicalJson({ vault: vault.id, tool, input: request }));
}

export function requireAuthority(vault, authorization, files, { recovery = false, dryRun = false } = {}) {
  if (!authorization || !['operator', 'clio', 'unattended'].includes(authorization.origin) || !validText(authorization.request, 'Authorization request').trim()) refuse('INVALID_AUTHORIZATION', 'An origin and exact nonblank request are required.');
  if (vault.readOnly && !dryRun) refuse(recovery ? 'RECOVERY_BLOCKED_AUTHORIZATION' : 'READ_ONLY_VAULT', 'The registered vault is read-only.');
  if (vault.role === 'operator' && authorization.origin === 'unattended' && files.some(file => file.role !== 'log' && !file.path.startsWith('Notient/'))) refuse('UNATTENDED_REFUSED', 'Unattended changes in an operator vault must remain inside Notient.', files.map(file => file.path));
}

export function freshAuthority(vault, directory, record) {
  const selected = selectVault(vault.id, directory);
  if (selected.path !== vault.path) refuse('RECOVERY_BLOCKED_AUTHORIZATION', 'The registered vault root changed.');
  requireAuthority(selected, record.authorization, record.files, { recovery: true });
}

export function classifyFiles(vault, record) {
  return record.files.map(file => {
    const current = currentFile(vault.path, file.path);
    return { file, current, state: current.revision === file.after ? 'after' : current.revision === file.before ? 'before' : 'conflict' };
  });
}

function ensureVaultParents(vault, record, file, sync) {
  writePath(vault.path, file.path);
  let current = vault.path;
  for (const part of file.path.split('/').slice(0, -1)) {
    current = path.join(current, part);
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 });
      const relative = path.relative(vault.path, current).split(path.sep).join('/');
      if (!record.createdDirectories.includes(relative)) record.createdDirectories.push(relative);
      sync(current);
      sync(path.dirname(current));
    }
    if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory()) refuse('UNSAFE_PATH', 'Publication requires ordinary parent directories.', [file.path]);
  }
}

export function prepareSiblings(vault, directory, record, sync = syncDirectory) {
  for (const file of record.files) {
    if (file.after === null || currentFile(vault.path, file.path).revision === file.after) continue;
    ensureVaultParents(vault, record, file, sync);
    const temp = path.join(vault.path, file.temp);
    const after = readBlob(directory, vault, record.id, file.after);
    if (existsSync(temp)) {
      const stat = lstatSync(temp);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || revision(readFileSync(temp)) !== file.after) refuse('TEMP_CONFLICT', 'A temporary sibling cannot be proven to belong to this operation.', [file.temp]);
    } else durableFile(temp, after, { mode: file.mode, sync });
  }
}

export function applyRecord(vault, directory, record, { barrier = () => {}, sync = syncDirectory, deadline = Infinity } = {}) {
  for (const name of record.applyOrder) {
    if (performance.now() > deadline) refuse('WRITE_TIMEOUT', 'The cooperative write deadline expired.', [], true);
    const file = record.files.find(candidate => candidate.path === name);
    let current = currentFile(vault.path, name);
    if (current.revision === file.after) { file.progress = 'applied'; continue; }
    if (current.revision !== file.before) refuse('REVISION_CONFLICT', 'The file no longer matches its planned revision.', [name], true);
    ensureVaultParents(vault, record, file, sync);
    const filename = writePath(vault.path, name);
    barrier('beforeRecheck', record, file);
    const checked = currentFile(vault.path, name);
    if (checked.revision !== file.before || (current.stat && (checked.stat?.ino !== current.stat.ino || checked.stat?.dev !== current.stat.dev))) refuse('REVISION_CONFLICT', 'The file changed before its final publication check.', [name], true);
    barrier('afterRecheck', record, file);
    if (file.action === 'delete') unlinkSync(filename);
    else if (file.action === 'replace') renameSync(path.join(vault.path, file.temp), filename);
    else {
      const fd = openSync(filename, 'wx', file.mode);
      try { writeFileSync(fd, readBlob(directory, vault, record.id, file.after)); fsyncSync(fd); }
      finally { closeSync(fd); }
    }
    sync(path.dirname(filename));
    barrier('afterFilePublish', record, file);
    current = currentFile(vault.path, name);
    if (current.revision !== file.after) refuse('REVISION_CONFLICT', 'The published file changed before verification.', [name], true);
    file.progress = 'applied';
    saveRecord(directory, vault, record, sync);
  }
  record.state = 'applied';
  saveRecord(directory, vault, record, sync);
}

export function cleanupSiblings(vault, record, sync = syncDirectory) {
  for (const file of record.files) {
    if (!file.temp) continue;
    const filename = path.join(vault.path, file.temp);
    if (!existsSync(filename)) continue;
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || revision(readFileSync(filename)) !== file.after) continue;
    unlinkSync(filename);
    sync(path.dirname(filename));
  }
}

export function newRecord(vault, plan) {
  const files = plan.files.map((file, ordinal) => ({ path: file.path, role: file.role ?? 'note', action: file.before === null ? 'create' : file.after === null ? 'delete' : 'replace', before: file.before === null ? null : revision(file.before), after: file.after === null ? null : revision(file.after), mode: file.mode ?? 0o600, temp: file.after === null ? null : path.posix.join(path.posix.dirname(file.path), `.notient-${plan.id}-${ordinal}.tmp`), progress: 'pending' }));
  return {
    version: 1, id: plan.id, vaultId: vault.id, vaultPath: vault.path,
    tool: plan.tool, operation: plan.operation, requestDigest: plan.requestDigest, batch: plan.batch,
    authorization: plan.authorization, createdAt: plan.createdAt, updatedAt: plan.createdAt,
    state: 'intent', planHash: plan.planHash, source: plan.source ?? null, destination: null,
    reads: [], inventoryHash: null, files, applyOrder: files.map(file => file.path), createdDirectories: [],
    git: { ref: plan.git?.ref ?? null, baseHead: plan.git?.baseHead ?? null, tree: null, commit: null, indexBeforeHash: null, indexAfterHash: null, lockSeed: null, indexInstalled: false },
    log: plan.log, undo: plan.undo ?? { targets: [], commits: [] }, undoneBy: null,
    indexState: 'pending', durability: 'full', conflicts: [], timings: { scanMs: 0, lockWaitMs: 0, journalMs: 0, applyMs: 0, gitMs: 0, totalMs: 0 }, error: null,
  };
}

export function persistPlan(vault, directory, plan, sync = syncDirectory) {
  const record = newRecord(vault, plan);
  const blobs = new Map();
  for (const file of plan.files) {
    for (const bytes of [file.before, file.after]) {
      if (bytes === null) continue;
      if (bytes.length > MAX_NOTE_BYTES) refuse('NOTE_TOO_LARGE', 'Changed files cannot exceed 4 MiB.', [file.path]);
      blobs.set(revision(bytes), bytes);
    }
  }
  persistIntent(directory, vault, record, blobs, name => { const supported = sync(name); if (!supported) record.durability = 'directory-sync-unavailable'; return supported; });
  return record;
}

export function finishRecord(vault, directory, record, adapter, options = {}) {
  if (!adapter) refuse('GIT_UNAVAILABLE', 'The Git write adapter is required.');
  const sync = name => { const supported = (options.sync ?? syncDirectory)(name); if (!supported) record.durability = 'directory-sync-unavailable'; return supported; };
  const published = adapter.recognize(record);
  const states = published ? [] : classifyFiles(vault, record);
  const conflicts = states.filter(item => item.state === 'conflict');
  if (conflicts.length) {
    record.state = 'conflicted';
    record.conflicts = conflicts.map(({ file, current }) => ({ path: file.path, expectedBefore: file.before, expectedAfter: file.after, actual: current.revision, reason: 'Current bytes equal neither recorded revision.' }));
    saveRecord(directory, vault, record, sync);
    return { operationId: record.id, result: 'conflict_preserved', commit: null, conflicts: record.conflicts };
  }
  if (!published) {
    try { adapter.checkBase(record); }
    catch (error) {
      if (states.every(item => item.state === 'before') && error.code === 'GIT_HEAD_CHANGED') {
        record.state = 'aborted'; record.error = { code: error.code, message: error.message };
        saveRecord(directory, vault, record, sync);
        cleanupSiblings(vault, record, sync);
        return { operationId: record.id, result: 'aborted_unapplied', commit: null, conflicts: [] };
      }
      throw error;
    }
    if (!record.git.commit) { adapter.prepare(record); saveRecord(directory, vault, record, sync); }
    prepareSiblings(vault, directory, record, sync);
    options.barrier?.('afterIntent', record);
    const started = performance.now();
    applyRecord(vault, directory, record, options);
    record.timings.applyMs += performance.now() - started;
    options.barrier?.('afterPublish', record);
    adapter.publish(record);
    options.barrier?.('afterRef', record);
  }
  const installed = record.git.indexInstalled || adapter.reconcileIndex(record);
  record.git.indexInstalled = installed;
  record.indexState = 'pending';
  if (installed) {
    record.state = 'committed'; record.conflicts = []; record.error = null;
    saveRecord(directory, vault, record, sync);
    cleanupSiblings(vault, record, sync);
    try { if (repairCommittedIndex(vault, directory, record)) record.indexState = 'updated'; }
    catch (error) { record.error = { code: 'INDEX_REPAIR_PENDING', message: error.message }; }
    saveRecord(directory, vault, record, sync);
  } else saveRecord(directory, vault, record, sync);
  return { operationId: record.id, result: published ? 'already_committed' : states.every(item => item.state === 'before') ? 'resumed_from_intent' : states.every(item => item.state === 'after') ? 'committed_after_apply' : 'completed_partial_apply', commit: record.git.commit, conflicts: [] };
}

export function recoverPending(vault, directory, adapter, options = {}) {
  const results = [];
  const records = listRecords(directory, vault);
  const pending = records.filter(record => !['committed', 'aborted'].includes(record.state) || (record.state === 'committed' && record.indexState === 'pending'));
  for (const record of pending.slice(0, 20)) {
    try {
      freshAuthority(vault, directory, record);
      results.push(finishRecord(vault, directory, record, adapter, options));
    } catch (error) {
      results.push({ operationId: record.id, result: error.code ?? 'RECOVERY_ERROR', commit: record.git.commit, conflicts: [], error: error.message });
      break;
    }
    if (results.at(-1).result === 'conflict_preserved') break;
  }
  return { results, remaining: pending.slice(results.length).map(record => record.id) };
}

export function coordinatePlan(vault, directory, buildPlan, { adapter, ...options } = {}) {
  const started = performance.now();
  return withWriterLock(directory, vault, lockWaitMs => {
    const recovery = recoverPending(vault, directory, adapter, options);
    if (recovery.results.some(result => result.result === 'conflict_preserved' || result.error) || recovery.remaining.length) refuse('RECOVERY_REQUIRED', 'Pending recovery prevents a new write.');
    const plan = buildPlan();
    requireAuthority(vault, plan.authorization, plan.files);
    const journalStarted = performance.now();
    const record = persistPlan(vault, directory, plan, options.sync);
    record.timings.lockWaitMs = lockWaitMs;
    record.timings.journalMs = performance.now() - journalStarted;
    try {
      const result = finishRecord(vault, directory, record, adapter, { deadline: started + 240000, ...options });
      record.timings.totalMs = performance.now() - started;
      saveRecord(directory, vault, record, options.sync);
      return { record, result, recovery: recovery.results };
    } catch (error) {
      record.error = { code: error.code ?? 'WRITE_FAILED', message: error.message };
      saveRecord(directory, vault, record, options.sync);
      throw error;
    }
  });
}

export function recoverVault(vault, directory, options = {}) {
  const pending = listRecords(directory, vault).filter(record => !['committed', 'aborted'].includes(record.state) || record.state === 'committed' && record.indexState === 'pending');
  if (!pending.length) return { results: [], remaining: [], busy: false };
  try {
    return withWriterLock(directory, vault, () => ({ ...recoverPending(vault, directory, createGitAdapter(vault, directory), options), busy: false }));
  } catch (error) {
    return { results: [{ operationId: null, result: error.code ?? 'RECOVERY_ERROR', commit: null, conflicts: [], error: error.message }], remaining: pending.map(record => record.id), busy: error.code === 'WRITER_BUSY' };
  }
}

export function commandStatusSnapshot(directory, input = {}) {
  const config = readConfig(directory);
  const selected = input.vault ? config.vaults.filter(vault => vault.id === input.vault || vault.path === input.vault) : config.vaults;
  const recovery = new Map();
  for (const vault of selected) {
    try { recovery.set(vault.id, recoverVault(vault, directory)); }
    catch (error) { recovery.set(vault.id, { results: [{ operationId: null, result: error.code ?? 'RECOVERY_ERROR', commit: null, conflicts: [], error: error.message }], busy: false }); }
  }
  const snapshot = statusSnapshot(directory, input);
  snapshot.stage = 2;
  snapshot.recovery = 'Command status reconciles authorized pending writes. Runtime observations remain read-only.';
  snapshot.recovered = [];
  for (const vault of snapshot.vaults) {
    const result = recovery.get(vault.id);
    if (vault.journal && result) { vault.journal.recoveryResults = result.results; vault.journal.busy = result.busy; vault.journal.remaining = result.remaining ?? []; }
    snapshot.recovered.push(...(result?.results ?? []));
  }
  return snapshot;
}

function inputFor(tool, raw) {
  const input = { ...raw, requestId: raw.requestId ?? randomUUID(), dryRun: raw.dryRun ?? false };
  if (!requestIdPattern.test(input.requestId)) refuse('INVALID_INPUT', 'requestId must contain 8 to 64 permitted characters.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.batch ?? '')) refuse('INVALID_INPUT', 'A portable batch label of at most 80 characters is required.');
  if (!input.authorization || !['operator', 'clio', 'unattended'].includes(input.authorization.origin) || typeof input.authorization.request !== 'string' || !validText(input.authorization.request).trim() || input.authorization.request.length > 2000) refuse('INVALID_AUTHORIZATION', 'Supply an origin and exact nonblank request of at most 2000 characters.');
  if (input.planHash !== undefined && !/^[a-f0-9]{64}$/.test(input.planHash)) refuse('INVALID_INPUT', 'planHash must be a lowercase SHA-256 revision.');
  if (tool === 'capture') {
    portableName(input.name);
    if (input.name.length > 120 || /\.md$/i.test(input.name)) refuse('INVALID_INPUT', 'Capture name must be a basename without .md, of at most 120 characters.');
    validText(input.content, 'Capture content');
    if (!input.content.length || input.content.length > 48000) refuse('INVALID_INPUT', 'Capture content must contain 1 to 48000 characters.');
    documentSpans(Buffer.from(input.content));
  } else if (tool === 'revise') {
    if (!['replace', 'frontmatter'].includes(input.operation)) refuse('INVALID_INPUT', 'Stage 2a supports replace and frontmatter.');
    if (typeof input.path !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision ?? '')) refuse('INVALID_INPUT', 'A note path and lowercase read revision are required.');
    if (input.path.startsWith('Notient/Log/')) refuse('MANAGED_LOG', 'Direct revision of managed audit logs is refused.', [input.path]);
    const fields = input.operation === 'replace' ? ['oldText', 'newText'] : ['set', 'unset'];
    const allowed = new Set(['vault', 'requestId', 'batch', 'authorization', 'dryRun', 'planHash', 'operation', 'path', 'revision', ...fields]);
    if (Object.keys(raw).some(key => !allowed.has(key))) refuse('INVALID_INPUT', 'Fields belonging to another revision mode are refused.');
    if (input.operation === 'replace') {
      validText(input.oldText, 'oldText'); validText(input.newText, 'newText');
      if (!input.oldText.length || input.oldText.length > 24000 || input.newText.length > 24000) refuse('INVALID_INPUT', 'Replacement strings exceed their declared bounds.');
    } else {
      input.set ??= []; input.unset ??= [];
      if (!Array.isArray(input.set) || !Array.isArray(input.unset) || input.set.length > 32 || input.unset.length > 32 || !input.set.length && !input.unset.length) refuse('INVALID_INPUT', 'Supply at least one set or unset entry, with at most 32 of each.');
      if (input.set.some(item => !item || Object.keys(item).some(key => !['key', 'valueJson'].includes(key)))) refuse('INVALID_INPUT', 'Frontmatter set entries have closed fields.');
    }
  } else refuse('OPERATION_UNAVAILABLE', 'This operation is not implemented in the current stage 2a step.');
  return input;
}

export function unifiedDiff(name, before, after) {
  if (before !== null && after !== null && before.equals(after)) return '';
  const oldLines = (before?.toString('utf8') ?? '').match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const newLines = (after?.toString('utf8') ?? '').match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let prefix = 0;
  while (prefix < Math.min(oldLines.length, newLines.length) && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < Math.min(oldLines.length, newLines.length) - prefix && oldLines.at(-suffix - 1) === newLines.at(-suffix - 1)) suffix++;
  const start = Math.max(0, prefix - 3);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + 3);
  const show = (line, mark) => `${mark}${line.replaceAll('\r', '\\r').replace(/\n$/, '')}\n${line.endsWith('\n') ? '' : '\\ No newline at end of file\n'}`;
  const context = oldLines.slice(start, prefix).map(line => show(line, ' ')).join('');
  const removed = oldLines.slice(prefix, oldLines.length - suffix).map(line => show(line, '-')).join('');
  const added = newLines.slice(prefix, newLines.length - suffix).map(line => show(line, '+')).join('');
  const tail = oldLines.slice(oldLines.length - suffix, oldEnd).map(line => show(line, ' ')).join('');
  return `Display encoding: CR is shown as \\r.\n--- ${before === null ? '/dev/null' : `a/${name}`}\n+++ ${after === null ? '/dev/null' : `b/${name}`}\n@@ -${oldEnd > start ? start + 1 : start},${oldEnd - start} +${newEnd > start ? start + 1 : start},${newEnd - start} @@\n${context}${removed}${added}${tail}`;
}

function auditJson(value) {
  return JSON.stringify(value).replace(/"(?:\\.|[^"\\])*"/g, token => token.replaceAll('[', '\\u005b').replaceAll(']', '\\u005d'));
}

function plannedLog(vault, input, operation, source, files, createdAt, undo) {
  const name = `Notient/Log/${createdAt.slice(0, 7)}.md`;
  const current = currentFile(vault.path, name);
  const ending = current.bytes?.toString('utf8').match(/\r?\n/)?.[0] ?? '\n';
  const line = `- ${auditJson({ time: createdAt, id: input.requestId, operation, note: source, destination: null, batch: input.batch, origin: input.authorization.origin, request: input.authorization.request, files: files.map(file => ({ path: file.path, before: file.before === null ? null : revision(file.before), after: file.after === null ? null : revision(file.after) })), undo: undo.targets })}`;
  const separator = current.bytes?.length && !current.bytes.toString('utf8').endsWith('\n') ? ending : '';
  const after = Buffer.concat([current.bytes ?? Buffer.alloc(0), Buffer.from(`${separator}${line}${ending}`)]);
  return { file: { path: name, role: 'log', before: current.bytes, after, mode: current.mode }, log: { path: name, line } };
}

function captureFiles(vault, input) {
  const base = 'Notient/Inbox';
  const probe = writePath(vault.path, `${base}/notient-probe-${randomUUID()}.md`);
  const names = existsSync(path.dirname(probe)) ? new Set(readdirSync(path.dirname(probe)).map(portableFold)) : new Set();
  for (let suffix = 1; suffix <= 9999; suffix++) {
    const name = `${input.name}${suffix === 1 ? '' : `-${suffix}`}.md`;
    if (names.has(portableFold(name))) continue;
    const filename = `${base}/${name}`;
    if (currentFile(vault.path, filename).revision !== null) continue;
    return [{ path: filename, role: 'note', before: null, after: Buffer.from(input.content), mode: 0o600, splices: [] }];
  }
  refuse('CAPTURE_COLLISIONS', 'No available capture name remains within 9999 candidates.');
}

export function buildWritePlan(tool, vault, directory, input) {
  const started = performance.now();
  const operation = tool === 'capture' ? 'capture' : input.operation;
  let files;
  if (tool === 'capture') files = captureFiles(vault, input);
  else {
    const current = currentFile(vault.path, input.path);
    if (current.revision === null) refuse('NOTE_NOT_FOUND', 'The requested note does not exist.', [input.path]);
    if (current.revision !== input.revision) refuse('REVISION_CONFLICT', 'The note changed since its read revision.', [input.path], true);
    const edited = input.operation === 'replace' ? replaceBody(current.bytes, input.oldText, input.newText) : editFrontmatter(current.bytes, input.set, input.unset);
    if (edited.bytes.length > MAX_NOTE_BYTES) refuse('NOTE_TOO_LARGE', 'The result exceeds 4 MiB.', [input.path]);
    files = [{ path: input.path, role: 'note', before: current.bytes, after: edited.bytes, mode: current.mode, splices: edited.splices }];
  }
  requireAuthority(vault, input.authorization, files, { dryRun: input.dryRun });
  const createdAt = new Date().toISOString();
  const undo = { targets: [], commits: [] };
  const source = files[0].path;
  const noop = files.every(file => file.before !== null && file.after !== null && file.before.equals(file.after));
  const audit = noop ? null : plannedLog(vault, input, operation, source, files, createdAt, undo);
  if (audit) files.push(audit.file);
  const gitStarted = performance.now();
  const git = preflightGit(vault, files);
  const gitMs = performance.now() - gitStarted;
  const planHash = revision(canonicalJson({ files: files.filter(file => file.role !== 'log').map(file => ({ path: file.path, before: file.before === null ? null : revision(file.before), after: file.after === null ? null : revision(file.after), mode: file.mode })), reads: [], inventoryHash: null, ref: git.ref, baseHead: git.baseHead, log: audit ? { path: audit.file.path, before: audit.file.before === null ? null : revision(audit.file.before) } : null }));
  if (input.planHash && input.planHash !== planHash) refuse('PLAN_CHANGED', 'The requested bytes, log baseline or Git HEAD differ from the preview.', files.map(file => file.path));
  return { id: input.requestId, tool, operation, files, source, createdAt, authorization: input.authorization, batch: input.batch, requestDigest: requestDigest(vault, tool, input), planHash, log: audit?.log ?? null, noop, undo, git, timings: { scanMs: performance.now() - started - gitMs, gitMs } };
}

export function byteSplices(before, after) {
  if (before === null || after === null || before.equals(after)) return [];
  let prefix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  while (prefix > 0 && (before[prefix] & 0xc0) === 0x80) prefix--;
  let suffix = 0;
  while (suffix < Math.min(before.length, after.length) - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  while (suffix > 0 && ((before[before.length - suffix] & 0xc0) === 0x80 || (after[after.length - suffix] & 0xc0) === 0x80)) suffix--;
  return [{ startByte: prefix, endByte: before.length - suffix, replacement: after.subarray(prefix, after.length - suffix).toString('utf8') }];
}

function outputChanges(files, preview) {
  return files.map(file => ({ path: file.path, action: file.before === null ? 'create' : file.after === null ? 'delete' : 'replace', before: file.before === null ? null : revision(file.before), after: file.after === null ? null : revision(file.after), diff: preview ? unifiedDiff(file.path, file.before, file.after) : '', splices: file.splices ?? byteSplices(file.before, file.after) }));
}

function warnings(record, durability) {
  const result = [{ code: 'QUIESCENT_FILES_REQUIRED', message: 'Affected files must remain quiescent. A save between the final revision check and rename can be overwritten.' }];
  if (record?.durability === 'directory-sync-unavailable') result.push({ code: 'DIRECTORY_SYNC_UNAVAILABLE', message: 'Directory fsync is unsupported on this filesystem; power-loss durability is limited.' });
  if (durability && !durability.fsync) result.push({ code: 'GIT_FSYNC_UNAVAILABLE', message: `${durability.version} lacks core.fsync=committed; proceeding with the available Git durability.` });
  if (record && !record.git.indexInstalled) result.push({ code: 'INDEX_UPDATE_PENDING', message: 'The commit is published. Normal Git index reconciliation remains pending and status will retry it.' });
  else if (record?.indexState === 'pending') result.push({ code: 'STRUCTURAL_INDEX_PENDING', message: 'The vault commit is durable. Refresh the structural index and use status to finish its recorded repair.' });
  return result;
}

function recordResult(vault, directory, record, recovery, outcome, duration, durability) {
  return {
    ok: true, tool: record.tool, operation: record.operation, vault: vault.id, requestId: record.id, operationId: record.id,
    outcome, batch: record.batch, planHash: record.planHash,
    changes: outputChanges(record.files.map(file => ({ ...file, before: file.before === null ? null : readBlob(directory, vault, record.id, file.before), after: file.after === null ? null : readBlob(directory, vault, record.id, file.after) })), false),
    commit: { oid: record.git.commit, parent: record.git.baseHead, subject: `notient(${record.operation}): ${JSON.stringify(record.source)}` },
    log: record.log, undo: { operationIds: record.undo.targets, commits: record.undo.commits }, recovery,
    indexState: record.indexState, warnings: warnings(record, durability), timings: { ...record.timings, totalMs: duration },
  };
}

function previewResult(tool, vault, input, plan, started) {
  return { ok: true, tool, operation: plan.operation, vault: vault.id, requestId: input.requestId, operationId: null, outcome: plan.noop ? 'noop' : 'preview', batch: plan.batch, planHash: plan.planHash, changes: plan.noop ? [] : outputChanges(plan.files, true), commit: null, log: null, undo: { operationIds: plan.undo.targets, commits: plan.undo.commits }, recovery: [], indexState: 'unchanged', warnings: warnings(null, plan.git.durability), timings: { scanMs: plan.timings.scanMs, lockWaitMs: 0, journalMs: 0, applyMs: 0, gitMs: plan.timings.gitMs, totalMs: performance.now() - started } };
}

export function writeOperation(tool, raw, { directory = dataDirectory(), ...options } = {}) {
  const started = performance.now();
  let input;
  let vault;
  let record;
  let adapter;
  let recovery = [];
  try {
    input = inputFor(tool, raw);
    vault = selectVault(input.vault, directory);
    const digest = requestDigest(vault, tool, input);
    const existing = () => {
      if (!existsSync(path.join(operationDirectory(directory, vault, input.requestId), 'record.json'))) return null;
      const found = readRecord(directory, vault, input.requestId);
      if (found.requestDigest !== digest) refuse('REQUEST_ID_REUSED', 'The request ID was already used for different input.');
      return found;
    };
    existing();
    if (input.dryRun) {
      if (listRecords(directory, vault).some(item => !['committed', 'aborted'].includes(item.state))) refuse('RECOVERY_REQUIRED', 'Complete pending recovery before previewing a new change.');
      const plan = buildWritePlan(tool, vault, directory, input);
      const result = previewResult(tool, vault, input, plan, started);
      if (Buffer.byteLength(JSON.stringify(result)) > 900000) refuse('PREVIEW_TOO_LARGE', 'The complete preview exceeds 900000 bytes.');
      return result;
    }
    requireAuthority(vault, input.authorization, []);
    if (tool === 'revise' && !existing() && !listRecords(directory, vault).some(item => !['committed', 'aborted'].includes(item.state))) {
      const plan = buildWritePlan(tool, vault, directory, input);
      if (plan.noop) return previewResult(tool, vault, input, plan, started);
    }
    return withWriterLock(directory, vault, lockWaitMs => {
      existing();
      adapter = createGitAdapter(vault, directory);
      const recovered = recoverPending(vault, directory, adapter, options);
      recovery = recovered.results;
      if (recovered.remaining.length || recovery.some(item => item.error || item.result === 'conflict_preserved')) refuse('RECOVERY_REQUIRED', 'Pending recovery prevents new writes.');
      record = existing();
      if (record) {
        if (record.state === 'aborted') refuse('OPERATION_ABORTED', 'The original operation was aborted. Use a fresh preview and request ID.');
        if (!adapter.recognize(record)) refuse('RECOVERY_REQUIRED', 'The requested operation has not published a verified commit.');
        return recordResult(vault, directory, record, recovery, 'already_committed', performance.now() - started, adapter.durability);
      }
      const plan = buildWritePlan(tool, vault, directory, input);
      if (plan.noop) return { ...previewResult(tool, vault, input, plan, started), recovery };
      const journalStarted = performance.now();
      record = persistPlan(vault, directory, plan, options.sync);
      record.timings = { ...record.timings, ...plan.timings, lockWaitMs, journalMs: performance.now() - journalStarted };
      const result = finishRecord(vault, directory, record, adapter, { deadline: started + 240000, ...options });
      if (result.result === 'conflict_preserved') refuse('REVISION_CONFLICT', 'The operation encountered changed bytes.', result.conflicts.map(item => item.path));
      record.timings.totalMs = performance.now() - started;
      saveRecord(directory, vault, record, options.sync);
      return recordResult(vault, directory, record, recovery, 'committed', performance.now() - started, adapter.durability);
    });
  } catch (error) {
    if (record && !['committed', 'aborted'].includes(record.state)) {
      record.error = { code: error.code ?? 'WRITE_FAILED', message: error.message };
      try { saveRecord(directory, vault, record, options.sync); } catch {}
    }
    let partial = false;
    let commit = null;
    if (record) {
      try { partial = record.files.some(file => currentFile(vault.path, file.path).revision !== file.before); } catch { partial = true; }
      try { if (adapter?.recognize(record)) commit = record.git.commit; } catch {}
    }
    return { ok: false, tool, vault: vault?.id ?? null, requestId: input?.requestId ?? raw.requestId ?? null, operationId: record?.id ?? null, state: ['intent', 'applied', 'conflicted'].includes(record?.state) ? record.state : 'refused', error: { code: error.code ?? 'WRITE_FAILED', message: error.message, retryable: error.retryable ?? false, paths: (error.paths ?? []).slice(0, 100) }, recovery, partial, commit };
  }
}
