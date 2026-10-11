import { existsSync, mkdirSync, lstatSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { currentFile, writePath, revision, refuse, WriteError, validText, MAX_NOTE_BYTES } from './paths.mjs';
import { selectVault, readConfig } from './config.mjs';
import { createGitAdapter } from './git.mjs';
import { statusSnapshot } from './status.mjs';
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
  const installed = adapter.reconcileIndex(record);
  record.git.indexInstalled = installed;
  record.indexState = installed ? 'updated' : 'pending';
  if (installed) {
    record.state = 'committed'; record.conflicts = []; record.error = null;
    saveRecord(directory, vault, record, sync);
    cleanupSiblings(vault, record, sync);
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
