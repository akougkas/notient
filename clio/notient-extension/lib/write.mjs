import { existsSync, mkdirSync, lstatSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, chmodSync, readdirSync, fchmodSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { currentFile, readNote, writePath, revision, refuse, WriteError, validText, MAX_NOTE_BYTES, portableName, portableFold } from './paths.mjs';
import { selectVault, readConfig, dataDirectory, notConfigured } from './config.mjs';
import { createGitAdapter, preflightGit, git, createGitBudget } from './git.mjs';
import { statusSnapshot } from './status.mjs';
import { documentSpans, replaceBody, editFrontmatter, parseMarkdown, resolveLink } from './markdown.mjs';
import { repairCommittedIndex } from './index.mjs';
import { listNotes } from './vault.mjs';
import { scanMoveVault, planMove, moveInventory, guardInverseReferences } from './move.mjs';
import { simulateUndo, certifyCancellation, hydrateOperation } from './undo.mjs';
import { captureDocument, captureBodyHash, captureReviewBytes, captureReceipt } from './capture.mjs';
import { planLink } from './link.mjs';
import { planRelate } from './relate.mjs';
import { freezeEditAges } from './vitals-write.mjs';
import { persistIntent, saveRecord, readBlob, readRecord, listRecords, operationDirectory, withWriterLock, requestIdPattern, syncDirectory, durableFile, freezeIntentSet, prepareFileIntents, readFileIntents, claimFileIntent, markFileApplied } from './journal.mjs';

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
  if (vault.role === 'operator' && authorization.origin === 'unattended' && files.some(file => file.role !== 'log' && !file.path.startsWith('Notient/'))) refuse(recovery ? 'RECOVERY_BLOCKED_AUTHORIZATION' : 'UNATTENDED_REFUSED', 'Unattended changes in an operator vault must remain inside Notient.', files.map(file => file.path));
}

export function freshAuthority(vault, directory, record) {
  const selected = selectVault(vault.id, directory);
  if (selected.path !== vault.path) refuse('RECOVERY_BLOCKED_AUTHORIZATION', 'The registered vault root changed.');
  requireAuthority(selected, record.authorization, record.files, { recovery: true });
  requireAuthority({ ...selected, role: record.roleAtIntent ?? selected.role }, record.authorization, record.files, { recovery: true });
  if ((selected.role === 'operator' || record.roleAtIntent === 'operator') && record.authorization.origin === 'unattended' && (record.operation === 'move' || record.undo.targets.some(id => readRecord(directory, vault, id).operation === 'move'))) refuse('RECOVERY_BLOCKED_AUTHORIZATION', 'Unattended structural work cannot be recovered in an operator vault.');
}

export function classifyFiles(vault, record) {
  return record.files.map(file => {
    const current = currentFile(vault.path, file.path, { raw: true });
    return { file, current, state: current.revision === file.after ? 'after' : current.revision === file.before ? 'before' : 'conflict' };
  });
}

export function reconcileFile(current, before, after, stamp) {
  if (current === before && current === after) return { state: 'unchanged', code: null, claim: false };
  if (current === before) return { state: 'before', code: null, claim: stamp === null };
  if (current === after) return stamp === null ? { state: 'conflict', code: 'UNSTAMPED_AFTER', claim: false } : { state: 'after', code: null, claim: false };
  return { state: 'conflict', code: 'NEWER_EDIT', claim: false };
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

export function applyRecord(vault, directory, record, { observe = () => {}, barrier = () => {}, sync = syncDirectory, deadline = Infinity } = {}) {
  for (const name of record.applyOrder) {
    if (performance.now() > deadline) refuse('WRITE_TIMEOUT', 'The cooperative write deadline expired.', [], true);
    const file = record.files.find(candidate => candidate.path === name);
    if (record.intentSet) freshAuthority(vault, directory, record);
    let current = currentFile(vault.path, name, { raw: true });
    if (current.revision === file.after) { markFileApplied(directory, vault, record, file); file.progress = 'applied'; continue; }
    if (current.revision !== file.before) refuse('REVISION_CONFLICT', 'The file no longer matches its planned revision.', [name], true);
    ensureVaultParents(vault, record, file, sync);
    const filename = writePath(vault.path, name);
    claimFileIntent(directory, vault, record, file);
    observe('beforeRecheck', record, file);
    const checked = currentFile(vault.path, name, { raw: true });
    if (checked.revision !== file.before || (current.stat && (checked.stat?.ino !== current.stat.ino || checked.stat?.dev !== current.stat.dev))) refuse('REVISION_CONFLICT', 'The file changed before its final publication check.', [name], true);
    observe('afterRecheck', record, file);
    freshAuthority(vault, directory, record);
    if (file.action === 'delete') unlinkSync(filename);
    else if (file.action === 'replace') renameSync(path.join(vault.path, file.temp), filename);
    else {
      const fd = openSync(filename, 'wx', file.mode);
      try {
        fchmodSync(fd, file.mode);
        const bytes = readBlob(directory, vault, record.id, file.after);
        const split = Math.ceil(bytes.length / 2);
        writeFileSync(fd, bytes.subarray(0, split));
        barrier('duringCreate', record, file);
        writeFileSync(fd, bytes.subarray(split));
        fsyncSync(fd);
      }
      finally { closeSync(fd); }
    }
    sync(path.dirname(filename));
    if (record.intentSet) barrier('afterMovePath', record, file);
    observe('afterFilePublish', record, file);
    current = currentFile(vault.path, name, { raw: true });
    if (current.revision !== file.after) refuse('REVISION_CONFLICT', 'The published file changed before verification.', [name], true);
    if (file.role === 'note') barrier('afterPublish', record, file);
    markFileApplied(directory, vault, record, file);
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

function checkDependencies(vault, directory, record) {
  for (const read of record.reads) {
    let actual;
    try { actual = (record.intentSet ? readNote(vault.path, read.path) : currentFile(vault.path, read.path)).revision; }
    catch { refuse('DEPENDENCY_CHANGED', 'A reviewed reference dependency is no longer readable.', [read.path]); }
    if (actual !== read.revision) {
      const file = record.files.find(candidate => candidate.path === read.path);
      const stamp = file && record.intentSet ? readFileIntents(directory, vault, record).get(file.path).write_started_at_ms : null;
      if (!file || actual !== file.after || stamp === null) refuse('DEPENDENCY_CHANGED', 'A reviewed reference dependency changed.', [read.path]);
    }
  }
  if (!record.inventoryHash) return;
  const names = new Set(record.intentSet ? moveInventory(vault.path) : listNotes(vault.path).notes.map(note => note.path));
  for (const file of record.files) { if (file.before === null) names.delete(file.path); else names.add(file.path); }
  if (revision(canonicalJson([...names].sort())) !== record.inventoryHash) refuse('DEPENDENCY_CHANGED', 'The reviewed note inventory changed.');
}

export function newRecord(vault, plan) {
  const files = plan.files.map((file, ordinal) => ({ intentId: randomUUID(), path: file.path, role: file.role ?? 'note', action: file.before === null ? 'create' : file.after === null ? 'delete' : 'replace', before: file.before === null ? null : revision(file.before), after: file.after === null ? null : revision(file.after), mode: file.mode ?? 0o600, temp: file.after === null ? null : path.posix.join(path.posix.dirname(file.path), `.notient-${plan.id}-${ordinal}.tmp`), progress: 'pending', splices: [...(file.splices ?? byteSplices(file.before, file.after))].sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte).map(splice => ({ startByte: splice.startByte, endByte: splice.endByte, replacementHash: revision(splice.replacement), replacementBytes: Buffer.byteLength(splice.replacement) })) }));
  const record = {
    version: 2, id: plan.id, vaultId: vault.id, vaultPath: vault.path,
    tool: plan.tool, operation: plan.operation, requestDigest: plan.requestDigest, batch: plan.batch,
    authorization: plan.authorization, createdAt: plan.createdAt, updatedAt: plan.createdAt,
    state: 'intent', planHash: plan.planHash, source: plan.source ?? null, destination: plan.destination ?? null,
    roleAtIntent: vault.role,
    reads: plan.reads ?? [], inventoryHash: plan.inventoryHash ?? null, files, applyOrder: files.map(file => file.path), createdDirectories: [],
    git: { ref: plan.git?.ref ?? null, baseHead: plan.git?.baseHead ?? null, tree: null, commit: null, indexBeforeHash: null, indexAfterHash: null, lockSeed: null, indexInstalled: false },
    log: plan.log, undo: plan.undo ?? { targets: [], commits: [] }, undoneBy: null,
    indexState: 'pending', derivedIndexState: 'pending', capture: plan.capture ?? null, durability: 'full', conflicts: [], timings: { scanMs: 0, lockWaitMs: 0, journalMs: 0, applyMs: 0, gitMs: 0, totalMs: 0 }, error: null,
    link: plan.link ?? null, relate: plan.relate ?? null, semanticEvidence: plan.semanticEvidence ?? null,
    vitalsBefore: plan.vitalsBefore ?? plan.files.filter(file => file.role !== 'log').map(file => ({ path: file.path, lastUserEditMs: file.before === null ? null : currentFile(vault.path, file.path).stat?.mtimeMs ?? null })),
  };
  freezeIntentSet(record);
  return record;
}

export function persistPlan(vault, directory, plan, sync = syncDirectory) {
  const record = newRecord(vault, plan);
  for (const file of record.files) {
    if (!file.temp) continue;
    try { lstatSync(path.join(vault.path, file.temp)); refuse('TEMP_CONFLICT', 'A reserved temporary sibling already exists before intent.', [file.temp]); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const blobs = new Map();
  for (const file of plan.files) {
    for (const bytes of [file.before, file.after]) {
      if (bytes === null) continue;
      if (bytes.length > MAX_NOTE_BYTES) refuse('NOTE_TOO_LARGE', 'Changed files cannot exceed 4 MiB.', [file.path]);
      blobs.set(revision(bytes), bytes);
    }
  }
  persistIntent(directory, vault, record, blobs, name => { const supported = sync(name); if (!supported) record.durability = 'directory-sync-unavailable'; return supported; });
  prepareFileIntents(directory, vault, record, record.files.every(file => currentFile(vault.path, file.path).revision === file.before));
  return record;
}

export function finishRecord(vault, directory, record, adapter, options = {}) {
  if (!adapter) refuse('GIT_UNAVAILABLE', 'The Git write adapter is required.');
  const sync = name => { const supported = (options.sync ?? syncDirectory)(name); if (!supported) record.durability = 'directory-sync-unavailable'; return supported; };
  const published = adapter.recognize(record);
  prepareFileIntents(directory, vault, record, !published && record.intentSet && record.files.every(file => currentFile(vault.path, file.path, { raw: true }).revision === file.before));
  const intents = record.intentSet ? readFileIntents(directory, vault, record) : null;
  const states = published ? [] : classifyFiles(vault, record);
  for (const item of states) {
    const decision = reconcileFile(item.current.revision, item.file.before, item.file.after, intents?.get(item.file.path).write_started_at_ms ?? null);
    item.state = decision.state;
    if (decision.code) item.reason = `${decision.code}: current bytes cannot be adopted as a stamped publication.`;
  }
  const conflicts = states.filter(item => item.state === 'conflict');
  if (conflicts.length) {
    record.state = 'conflicted';
    record.conflicts = conflicts.map(({ file, current, reason }) => ({ path: file.path, expectedBefore: file.before, expectedAfter: file.after, actual: current.revision, reason: reason ?? 'NEWER_EDIT: current bytes equal neither recorded revision.' }));
    saveRecord(directory, vault, record, sync);
    return { operationId: record.id, result: 'conflict_preserved', commit: null, conflicts: record.conflicts };
  }
  if (!published) {
    if (!record.intentSet) refuse('JOURNAL_CORRUPT', 'An unpublished legacy intent lacks authoritative publication stamps.');
    try {
      adapter.checkBase(record);
      checkDependencies(vault, directory, record);
    }
    catch (error) {
      if (states.every(item => item.state === 'before') && ['GIT_HEAD_CHANGED', 'DEPENDENCY_CHANGED'].includes(error.code) && !adapter.recognize(record)) {
        record.state = 'aborted'; record.error = { code: error.code, message: error.message };
        saveRecord(directory, vault, record, sync);
        cleanupSiblings(vault, record, sync);
        return { operationId: record.id, result: 'aborted_unapplied', commit: null, conflicts: [] };
      }
      throw error;
    }
    if (!record.git.commit) { adapter.prepare(record); saveRecord(directory, vault, record, sync); options.barrier?.('afterCandidate', record); }
    prepareSiblings(vault, directory, record, sync);
    if (record.intentSet) freshAuthority(vault, directory, record);
    const first = states.find(item => item.state === 'before');
    if (first) claimFileIntent(directory, vault, record, first.file);
    options.barrier?.('afterIntent', record);
    try { adapter.checkBase(record); checkDependencies(vault, directory, record); }
    catch (error) {
      if (['GIT_HEAD_CHANGED', 'DEPENDENCY_CHANGED'].includes(error.code) && classifyFiles(vault, record).every(item => item.state === 'before') && !adapter.recognize(record)) {
        record.state = 'aborted'; record.error = { code: error.code, message: error.message };
        saveRecord(directory, vault, record, sync); cleanupSiblings(vault, record, sync);
        return { operationId: record.id, result: 'aborted_unapplied', commit: null, conflicts: [] };
      }
      throw error;
    }
    const started = performance.now();
    applyRecord(vault, directory, record, options);
    record.timings.applyMs += performance.now() - started;
    saveRecord(directory, vault, record, sync);
    options.barrier?.('afterAllAfterBytes', record);
    const afterStates = classifyFiles(vault, record);
    if (afterStates.some(item => item.state !== 'after')) refuse('REVISION_CONFLICT', 'A file changed after publication and before the Git ref.', afterStates.filter(item => item.state !== 'after').map(item => item.file.path), true);
    checkDependencies(vault, directory, record);
    freshAuthority(vault, directory, record);
    adapter.publish(record);
    saveRecord(directory, vault, record, sync);
    options.barrier?.('afterRef', record);
  }
  for (const id of record.undo.targets) {
    const original = readRecord(directory, vault, id);
    if (original.undoneBy && original.undoneBy !== record.id) refuse('UNDO_CONFLICT', 'The original operation was already undone by another operation.');
    if (original.undoneBy !== record.id) { original.undoneBy = record.id; saveRecord(directory, vault, original, sync); }
  }
  record.state = 'committed'; record.conflicts = []; record.error = null;
  saveRecord(directory, vault, record, sync);
  try { record.git.indexInstalled ||= adapter.reconcileIndex(record, { barrier: options.barrier }); }
  catch (error) { record.error = { code: error.code ?? 'INDEX_UPDATE_PENDING', message: error.message }; }
  record.indexState = record.git.indexInstalled ? 'updated' : 'pending';
  record.derivedIndexState ??= 'pending';
  saveRecord(directory, vault, record, sync);
  options.barrier?.('afterCommitted', record);
  cleanupSiblings(vault, record, sync);
  if (record.derivedIndexState !== 'updated') {
    try { if (repairCommittedIndex(vault, directory, record)) record.derivedIndexState = 'updated'; }
    catch (error) { record.error ??= { code: 'INDEX_REPAIR_PENDING', message: error.message }; }
  }
  saveRecord(directory, vault, record, sync);
  return { operationId: record.id, result: published ? 'already_committed' : states.every(item => item.state === 'before') ? 'resumed_from_intent' : states.every(item => item.state === 'after') ? 'committed_after_apply' : 'completed_partial_apply', commit: record.git.commit, conflicts: [] };
}

function blocksWrites(record) {
  return !['committed', 'aborted'].includes(record.state) || record.state === 'committed' && !record.git.indexInstalled;
}

function pendingRecord(record) {
  return blocksWrites(record) || record.state === 'committed' && record.derivedIndexState === 'pending';
}

export function recoverPending(vault, directory, adapter, options = {}) {
  const results = [];
  const records = listRecords(directory, vault);
  const pending = records.filter(pendingRecord);
  const limit = Math.max(0, Math.min(20, options.limit ?? 20));
  for (const record of pending.slice(0, limit)) {
    const recoveryStarted = performance.now();
    if (performance.now() > (options.deadline ?? Infinity)) {
      results.push({ operationId: record.id, result: 'WRITE_TIMEOUT', commit: record.git.commit, conflicts: [], elapsedMs: performance.now() - recoveryStarted, error: 'The cooperative recovery deadline expired.' });
      break;
    }
    try {
      freshAuthority(vault, directory, record);
      results.push({ ...finishRecord(vault, directory, record, adapter, options), elapsedMs: performance.now() - recoveryStarted });
    } catch (error) {
      let commit = null;
      try { if (adapter.recognize(record)) commit = record.git.commit; } catch {}
      results.push({ operationId: record.id, result: error.code ?? 'RECOVERY_ERROR', commit, conflicts: record.conflicts.map(conflict => ({ path: conflict.path, reason: conflict.reason })), elapsedMs: performance.now() - recoveryStarted, error: error.message });
      break;
    }
    if (results.at(-1).result === 'conflict_preserved') break;
  }
  return { results, remaining: records.filter(pendingRecord).map(record => record.id), blocking: records.filter(blocksWrites).map(record => record.id) };
}

export function coordinatePlan(vault, directory, buildPlan, { adapter, ...options } = {}) {
  const started = performance.now();
  return withWriterLock(directory, vault, lockWaitMs => {
    const current = selectVault(vault.id, directory);
    if (current.path !== vault.path) refuse('VAULT_CHANGED', 'The registered vault root changed while waiting for the writer lock.');
    vault = current;
    const recovery = recoverPending(vault, directory, adapter, options);
    if (recovery.results.some(result => result.result === 'conflict_preserved' || result.error) || recovery.blocking.length) refuse('RECOVERY_REQUIRED', 'Pending recovery prevents a new write.');
    const plan = buildPlan();
    requireAuthority(vault, plan.authorization, plan.files);
    adapter?.consume?.(plan.id, plan.timings?.gitMs ?? 0);
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
  const started = performance.now();
  const pending = listRecords(directory, vault).filter(pendingRecord);
  if (!pending.length) return { results: [], remaining: [], busy: false };
  if (options.limit === 0) return { results: [], remaining: pending.map(record => record.id), busy: false };
  try {
    return withWriterLock(directory, vault, () => ({ ...recoverPending(vault, directory, createGitAdapter(vault, directory), { deadline: started + 240000, ...options }), busy: false }));
  } catch (error) {
    return { results: [{ operationId: null, result: error.code ?? 'RECOVERY_ERROR', commit: null, conflicts: [], error: error.message }], remaining: pending.map(record => record.id), busy: error.code === 'WRITER_BUSY' };
  }
}

export function commandStatusSnapshot(directory, input = {}) {
  const deadline = performance.now() + 240000;
  let remainingBudget = 20;
  const config = readConfig(directory);
  const selected = input.vault ? config.vaults.filter(vault => vault.id === input.vault || vault.path === input.vault) : config.vaults;
  if (!config.vaults.length) return { ...statusSnapshot(directory, input), stage: 2, recovered: [] };
  const recovery = new Map();
  for (const vault of selected) {
    try {
      const result = recoverVault(vault, directory, { deadline, limit: remainingBudget });
      remainingBudget -= result.results.filter(item => item.operationId !== null).length;
      recovery.set(vault.id, result);
    }
    catch (error) { recovery.set(vault.id, { results: [{ operationId: null, result: error.code ?? 'RECOVERY_ERROR', commit: null, conflicts: [], error: error.message }], busy: false }); }
  }
  const snapshot = statusSnapshot(directory, input);
  snapshot.stage = 2;
  snapshot.recovery = 'Command status reconciles authorized pending writes. Runtime observations remain read-only.';
  snapshot.recovered = [];
  for (const vault of snapshot.vaults) {
    const result = recovery.get(vault.id);
    if (vault.journal && result) { vault.journal.recoveryResults = result.results; vault.journal.busy = result.busy; vault.journal.remaining = result.remaining ?? []; }
    snapshot.recovered.push(...(result?.results ?? []).map(item => ({ vault: vault.id, ...item })));
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
    if (!['replace', 'frontmatter', 'move', 'link', 'relate'].includes(input.operation)) refuse('INVALID_INPUT', 'Choose replace, frontmatter, move, link or relate.');
    if (typeof input.path !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision ?? '')) refuse('INVALID_INPUT', 'A note path and lowercase read revision are required.');
    if (input.path.startsWith('Notient/Log/')) refuse('MANAGED_LOG', 'Direct revision of managed audit logs is refused.', [input.path]);
    const fields = input.operation === 'replace' ? ['oldText', 'newText'] : input.operation === 'move' ? ['destination'] : input.operation === 'link' ? ['link'] : input.operation === 'relate' ? ['relate'] : ['set', 'unset'];
    const allowed = new Set(['vault', 'requestId', 'batch', 'authorization', 'dryRun', 'planHash', 'operation', 'path', 'revision', ...fields]);
    if (Object.keys(raw).some(key => !allowed.has(key))) refuse('INVALID_INPUT', 'Fields belonging to another revision mode are refused.');
    if (input.operation === 'replace') {
      validText(input.oldText, 'oldText'); validText(input.newText, 'newText');
      if (!input.oldText.length || input.oldText.length > 24000 || input.newText.length > 24000) refuse('INVALID_INPUT', 'Replacement strings exceed their declared bounds.');
    } else if (input.operation === 'move') {
      if (typeof input.destination !== 'string' || !input.destination.length || input.destination.startsWith('Notient/Log/')) refuse('INVALID_INPUT', 'Move requires a destination outside managed logs.');
      if (!input.dryRun && !input.planHash) refuse('PLAN_HASH_REQUIRED', 'A real move requires its preceding dry-run planHash.');
    } else if (input.operation === 'link') {
      if (!input.link || Array.isArray(input.link) || Object.keys(input.link).some(key => !['candidateSet', 'edges'].includes(key)) || !Array.isArray(input.link.edges) || input.link.candidateSet !== undefined && (typeof input.link.candidateSet !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.link.candidateSet))) refuse('INVALID_INPUT', 'Link requires edges and an optional candidate receipt UUID with closed fields.');
    } else if (input.operation === 'relate') {
      if (!input.relate || Array.isArray(input.relate) || typeof input.relate !== 'object') refuse('INVALID_INPUT', 'Relate requires a target and relation.');
    } else {
      input.set ??= []; input.unset ??= [];
      if (!Array.isArray(input.set) || !Array.isArray(input.unset) || input.set.length > 32 || input.unset.length > 32 || !input.set.length && !input.unset.length) refuse('INVALID_INPUT', 'Supply at least one set or unset entry, with at most 32 of each.');
      if (input.set.some(item => !item || Object.keys(item).some(key => !['key', 'valueJson'].includes(key)))) refuse('INVALID_INPUT', 'Frontmatter set entries have closed fields.');
    }
  } else if (tool === 'undo') {
    if ((input.opId === undefined) === (input.targetBatch === undefined)) refuse('INVALID_INPUT', 'Supply exactly one of opId or targetBatch.');
    if (input.opId !== undefined && !requestIdPattern.test(input.opId)) refuse('INVALID_INPUT', 'A valid original operation ID is required.');
    if (input.targetBatch !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.targetBatch)) refuse('INVALID_INPUT', 'targetBatch must be a portable batch label.');
    const allowed = new Set(['vault', 'requestId', 'batch', 'authorization', 'dryRun', 'planHash', 'opId', 'targetBatch']);
    if (Object.keys(raw).some(key => !allowed.has(key))) refuse('INVALID_INPUT', 'Undo accepts one selector and closed request fields.');
  } else refuse('OPERATION_UNAVAILABLE', 'Unknown write tool.');
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

function plannedLog(vault, input, operation, source, files, createdAt, undo, relationship) {
  const name = `Notient/Log/${createdAt.slice(0, 7)}.md`;
  const current = currentFile(vault.path, name);
  const ending = current.bytes?.toString('utf8').match(/\r?\n/)?.[0] ?? '\n';
  const line = `- ${auditJson({ time: createdAt, id: input.requestId, operation, note: source, destination: operation === 'move' ? input.destination : null, batch: input.batch, origin: input.authorization.origin, request: input.authorization.request, files: files.map(file => ({ path: file.path, before: file.before === null ? null : revision(file.before), after: file.after === null ? null : revision(file.after) })), undo: undo.targets, ...(relationship ? { link: relationship.link ?? null, relate: relationship.relate ?? null } : {}) })}`;
  const separator = current.bytes?.length && !current.bytes.toString('utf8').endsWith('\n') ? ending : '';
  const after = Buffer.concat([current.bytes ?? Buffer.alloc(0), Buffer.from(`${separator}${line}${ending}`)]);
  return { file: { path: name, role: 'log', before: current.bytes, after, mode: current.mode }, log: { path: name, line } };
}

function captureFiles(vault, directory, input, createdAt, budget) {
  const content = captureDocument(input, createdAt);
  const records = listRecords(directory, vault);
  let history;
  for (const original of records.filter(record => record.operation === 'capture' && record.state === 'committed' && !record.undoneBy)) {
    const note = original.files.find(file => file.role === 'note' && file.after !== null);
    if (!note) continue;
    const originalHash = original.capture?.bodyHash ?? captureBodyHash(readBlob(directory, vault, original.id, note.after));
    if (originalHash !== content.bodyHash) continue;
    history ??= new Map(budget.call(vault.path, ['rev-list', '--first-parent', 'HEAD']).split('\n').map((oid, ordinal) => [oid, ordinal]));
    const origin = history.get(original.git.commit);
    if (origin === undefined) continue;
    let name = original.capture?.path ?? note.path;
    const lineage = records.filter(record => ['capture', 'move'].includes(record.operation) && record.state === 'committed' && !record.undoneBy && history.has(record.git.commit) && history.get(record.git.commit) < origin).sort((a, b) => history.get(b.git.commit) - history.get(a.git.commit));
    for (const next of lineage) {
      if (next.source !== name) continue;
      if (next.operation === 'capture') { name = null; break; }
      name = next.destination;
    }
    if (name === null) continue;
    let current;
    try { current = currentFile(vault.path, name); } catch { continue; }
    try { if (current.bytes === null || captureBodyHash(current.bytes) !== content.bodyHash) continue; }
    catch { continue; }
    return { files: [], source: name, noop: true, capture: { path: name, bodyHash: content.bodyHash, workspace: original.capture?.workspace ?? content.workspace, capturedAt: original.capture?.capturedAt ?? original.createdAt, revision: current.revision, duplicateOf: original.id, limitPerHour: original.capture?.limitPerHour ?? 12 } };
  }
  const config = readConfig(directory);
  const limitPerHour = vault.captureLimitPerHour ?? config.captureLimitPerHour ?? 12;
  if (!Number.isSafeInteger(limitPerHour) || limitPerHour < 1) refuse('INVALID_CONFIGURATION', 'captureLimitPerHour must be a positive integer.');
  const now = Date.parse(createdAt);
  const recent = records.filter(record => record.operation === 'capture' && record.state !== 'aborted' && Date.parse(record.createdAt) > now - 3600000 && Date.parse(record.createdAt) <= now);
  if (recent.length >= limitPerHour) {
    const retryAt = new Date(recent.map(record => Date.parse(record.createdAt)).sort((a, b) => a - b)[recent.length - limitPerHour] + 3600000).toISOString();
    refuse('CAPTURE_RATE_LIMIT', `The rolling capture limit is ${limitPerHour} per hour; retry at ${retryAt}.`);
  }
  const base = 'Notient/Inbox';
  const probe = writePath(vault.path, `${base}/notient-probe-${randomUUID()}.md`);
  const names = existsSync(path.dirname(probe)) ? new Set(readdirSync(path.dirname(probe)).map(portableFold)) : new Set();
  for (let suffix = 1; suffix <= 9999; suffix++) {
    const name = `${createdAt.slice(0, 10)}-${input.name}${suffix === 1 ? '' : `-${suffix}`}.md`;
    if (names.has(portableFold(name))) continue;
    const filename = `${base}/${name}`;
    if (currentFile(vault.path, filename).revision !== null) continue;
    return { files: [{ path: filename, role: 'note', before: null, after: content.bytes, mode: 0o600, splices: [] }], source: filename, noop: false, capture: { path: filename, bodyHash: content.bodyHash, workspace: content.workspace, capturedAt: content.capturedAt, revision: revision(content.bytes), duplicateOf: null, limitPerHour } };
  }
  refuse('CAPTURE_COLLISIONS', 'No available capture name remains within 9999 candidates.');
}

function inverseFiles(vault, directory, input, budget) {
  const records = listRecords(directory, vault);
  const matching = input.opId ? records.filter(record => record.id === input.opId) : records.filter(record => record.batch === input.targetBatch);
  if (!matching.length) refuse('OPERATION_NOT_FOUND', 'No journal operation matches the undo selector.');
  if (input.opId && matching[0].operation === 'undo' || matching.every(record => record.operation === 'undo')) refuse('UNDO_OF_UNDO', 'Undo of an undo is outside stage 2.');
  const originals = matching.filter(record => record.operation !== 'undo');
  if (input.opId && originals[0].state !== 'committed') refuse('OPERATION_NOT_COMMITTED', 'The original operation must be committed before undo.');
  const eligible = originals.filter(record => record.state === 'committed');
  if (!eligible.length) refuse('OPERATION_NOT_COMMITTED', 'The selected batch has no committed original operations.');
  const active = eligible.filter(record => !record.undoneBy);
  const hasMove = active.some(record => record.operation === 'move');
  const structural = !!input.targetBatch || hasMove;
  const filesForAuthority = active.flatMap(record => record.files);
  requireAuthority(vault, input.authorization, filesForAuthority, { dryRun: input.dryRun });
  if (vault.role === 'operator' && input.authorization.origin === 'unattended' && hasMove) refuse('UNATTENDED_REFUSED', 'Unattended undo containing a move is refused in an operator vault.');
  const order = budget.call(vault.path, ['rev-list', 'HEAD']).split('\n');
  const position = new Map(order.map((oid, ordinal) => [oid, ordinal]));
  const adapter = createGitAdapter(vault, directory, { budget });
  const verified = new Set();
  const verify = record => {
    if (!position.has(record.git.commit)) refuse('UNDO_HISTORY_CHANGED', 'An original or inverse commit is not reachable from this branch.');
    if (!verified.has(record.id)) { adapter.verify(record); verified.add(record.id); }
  };
  const hydrate = record => hydrateOperation(record, (id, hash) => readBlob(directory, vault, id, hash));
  const byId = new Map(records.map(record => [record.id, record]));
  const cancelled = new Set();
  const inverseIds = new Set();
  function certify(inverseId) {
    if (cancelled.has(inverseId)) return;
    const inverse = byId.get(inverseId);
    if (!inverse || inverse.operation !== 'undo' || inverse.state !== 'committed') refuse('UNDO_HISTORY_CHANGED', 'A cancellation backlink has no committed inverse.');
    verify(inverse);
    const targets = inverse.undo.targets.map(id => byId.get(id));
    if (!targets.length || targets.some(record => !record || record.operation === 'undo' || record.state !== 'committed' || record.undoneBy !== inverse.id || !inverse.undo.commits.includes(record.git.commit))) refuse('UNDO_HISTORY_CHANGED', 'The inverse backlinks or original commit list do not certify a cancellation.');
    for (const target of targets) verify(target);
    targets.sort((a, b) => position.get(b.git.commit) - position.get(a.git.commit));
    if (targets.some(target => position.get(inverse.git.commit) >= position.get(target.git.commit))) refuse('UNDO_HISTORY_CHANGED', 'The inverse does not follow every cancelled original.');
    certifyCancellation(targets.map(hydrate), hydrate(inverse));
    cancelled.add(inverse.id);
    for (const target of targets) cancelled.add(target.id);
  }
  for (const original of eligible) {
    verify(original);
    if (original.undoneBy) {
      certify(original.undoneBy);
      if (!cancelled.has(original.id)) refuse('UNDO_HISTORY_CHANGED', 'The cancellation backlink does not close this original operation.');
      inverseIds.add(original.undoneBy);
    }
  }
  const selected = active.sort((a, b) => position.get(a.git.commit) - position.get(b.git.commit));
  const source = input.targetBatch ? `batch:${input.targetBatch}` : eligible[0].source;
  if (!selected.length) return { files: [], source, noop: true, undo: { targets: [...inverseIds].sort(), commits: [...inverseIds].sort().map(id => byId.get(id).git.commit) }, reads: [], inventoryHash: null, structural, gitMs: budget.usedMs };
  const selectedIds = new Set(selected.map(record => record.id));
  const targets = new Set(selected.flatMap(record => record.files.filter(file => file.role === 'note').map(file => file.path)));
  const oldestByPath = new Map();
  for (const record of selected) for (const file of record.files.filter(file => file.role === 'note')) oldestByPath.set(file.path, Math.max(oldestByPath.get(file.path) ?? -1, position.get(record.git.commit)));
  for (const later of records) {
    if (selectedIds.has(later.id) || later.state !== 'committed' || !position.has(later.git.commit) || !later.files.some(file => file.role === 'note' && targets.has(file.path) && position.get(later.git.commit) < oldestByPath.get(file.path))) continue;
    if (later.undoneBy) certify(later.undoneBy);
    if (later.operation === 'undo') certify(later.id);
    if (cancelled.has(later.id)) continue;
    refuse('UNDO_LATER_WRITE', 'A later active unselected Notient operation touches the same path.', later.files.filter(file => file.role === 'note' && targets.has(file.path)).map(file => file.path));
  }
  const current = new Map([...targets].sort().map(name => { const value = currentFile(vault.path, name); return [name, { bytes: value.bytes, mode: value.mode }]; }));
  const files = simulateUndo(selected.map(hydrate), current);
  if (files.length > 100) refuse('UNDO_PLAN_LIMIT', 'The inverse exceeds 100 changed note paths.');
  if (!input.dryRun && !input.planHash && (structural || files.some(file => file.after === null))) refuse('PLAN_HASH_REQUIRED', 'Batch, move or capture-deletion undo requires its preceding dry-run planHash.');
  let reads = [];
  let inventoryHash = null;
  if (structural || files.some(file => file.after === null)) {
    const scan = scanMoveVault(vault.path);
    const guarded = guardInverseReferences(scan, files);
    if (guarded.blockerCount) refuse(guarded.blockers.some(blocker => blocker.code === 'AUDIT_LINK_BLOCKER') ? 'AUDIT_LINK_BLOCKER' : 'UNDO_REFERENCE_CONFLICT', `${guarded.blockerCount} inverse reference blockers: ${JSON.stringify(guarded.blockers)}`, guarded.blockers.map(blocker => blocker.path));
    reads = guarded.reads;
    inventoryHash = revision(canonicalJson(guarded.inventory));
  }
  const restoredAges = files.filter(file => file.before === null && file.after !== null).flatMap(file => {
    const original = [...selected].reverse().find(record => record.version === 2 && record.files.some(changed => changed.path === file.path && changed.before === revision(file.after)));
    const value = original?.vitalsBefore.find(value => value.path === file.path);
    return Number.isFinite(value?.lastUserEditMs) ? [value] : [];
  });
  return { files, source, noop: false, undo: { targets: selected.map(record => record.id), commits: selected.map(record => record.git.commit) }, restoredAges, reads, inventoryHash, structural: structural || files.some(file => file.after === null), gitMs: budget.usedMs };
}

export function buildWritePlan(tool, vault, directory, input, { now = () => new Date(), gitClock, gitCall, gitBudget } = {}) {
  const started = performance.now();
  const budget = gitBudget ?? createGitBudget({ now: gitClock, call: gitCall });
  const previousGitMs = budget.usedMs;
  const operation = tool === 'capture' ? 'capture' : tool === 'undo' ? 'undo' : input.operation;
  let files;
  let inverse;
  let move;
  let captured;
  let relationship;
  const createdAt = now().toISOString();
  if (tool === 'capture') { captured = captureFiles(vault, directory, input, createdAt, budget); files = captured.files; }
  else if (tool === 'undo') { inverse = inverseFiles(vault, directory, input, budget); files = inverse.files; }
  else {
    const current = currentFile(vault.path, input.path);
    if (current.revision === null) refuse('NOTE_NOT_FOUND', 'The requested note does not exist.', [input.path]);
    if (current.revision !== input.revision) refuse('REVISION_CONFLICT', 'The note changed since its read revision.', [input.path], true);
    if (input.operation === 'move') {
      if (vault.role === 'operator' && input.authorization.origin === 'unattended') refuse('UNATTENDED_REFUSED', 'Unattended moves in operator vaults are refused.', [input.path, input.destination]);
      writePath(vault.path, input.destination);
      move = planMove(scanMoveVault(vault.path), input.path, input.destination);
      if (!move.ok) refuse(move.blockers.some(blocker => blocker.code === 'AUDIT_LINK_BLOCKER') ? 'AUDIT_LINK_BLOCKER' : move.blockers[0].code, `${move.blockerCount} move blockers: ${JSON.stringify(move.blockers)}`, move.blockers.map(blocker => blocker.path));
      files = move.files;
    } else {
      const edited = input.operation === 'link' || input.operation === 'relate' ? (relationship = input.operation === 'link' ? planLink(scanMoveVault(vault.path), input.path, input.link.edges, { origin: input.authorization.origin }) : planRelate(scanMoveVault(vault.path), input.path, input.relate, { origin: input.authorization.origin })) : input.operation === 'replace' ? replaceBody(current.bytes, input.oldText, input.newText) : editFrontmatter(current.bytes, input.set, input.unset);
      if (relationship && !relationship.reads.some(read => read.path === input.path && read.revision === input.revision)) refuse('REVISION_CONFLICT', 'The source changed during the fresh relationship scan.', [input.path], true);
      if (edited.bytes.length > MAX_NOTE_BYTES) refuse('NOTE_TOO_LARGE', 'The result exceeds 4 MiB.', [input.path]);
      files = [{ path: input.path, role: 'note', before: current.bytes, after: edited.bytes, mode: current.mode, splices: edited.splices }];
    }
  }
  requireAuthority(vault, input.authorization, files, { dryRun: input.dryRun });
  const undo = inverse?.undo ?? { targets: [], commits: [] };
  const source = inverse?.source ?? move?.source ?? captured?.source ?? files[0].path;
  const noop = inverse?.noop ?? captured?.noop ?? files.every(file => file.before !== null && file.after !== null && file.before.equals(file.after));
  const audit = noop ? null : plannedLog(vault, input, operation, source, files, createdAt, undo, relationship);
  if (audit) files.push(audit.file);
  if (move || inverse?.structural) {
    const blobs = new Map(files.flatMap(file => [file.before, file.after]).filter(bytes => bytes !== null).map(bytes => [revision(bytes), bytes]));
    if ([...blobs.values()].some(bytes => bytes.length > MAX_NOTE_BYTES) || [...blobs.values()].reduce((total, bytes) => total + bytes.length, 0) > 64 * 1024 * 1024) refuse('MOVE_PLAN_LIMIT', 'The move exceeds the note or combined blob bound.');
  }
  const git = preflightGit(vault, files, { budget });
  const vitalsBefore = noop ? [] : freezeEditAges(vault, directory, files, Date.parse(createdAt), budget, git.baseHead, inverse?.restoredAges, move ? { source: move.source, destination: move.destination } : null);
  budget.check();
  const gitMs = budget.usedMs;
  const reads = inverse?.reads ?? move?.reads ?? relationship?.reads ?? [];
  const inventoryHash = inverse?.inventoryHash ?? (move || relationship ? revision(canonicalJson((move ?? relationship).inventory)) : null);
  const planHash = revision(canonicalJson({ vaultId: vault.id, operation, files: files.filter(file => file.role !== 'log').map(file => ({ path: file.path, before: file.before === null ? null : revision(file.before), after: file.after === null ? null : revision(tool === 'capture' ? captureReviewBytes(file.after) : file.after), mode: file.mode })), reads, inventoryHash, undo, ref: git.ref, baseHead: git.baseHead, log: audit ? { path: audit.file.path, before: audit.file.before === null ? null : revision(audit.file.before) } : null }));
  if (input.planHash && input.planHash !== planHash) refuse('PLAN_CHANGED', 'The requested bytes, log baseline or Git HEAD differ from the preview.', files.map(file => file.path));
  return { id: input.requestId, tool, operation, capture: captured?.capture ?? null, link: relationship?.link ?? null, relate: relationship?.relate ?? null, semanticEvidence: null, vitalsBefore, structural: !!move || !!inverse?.structural, files, source, destination: move?.destination ?? null, createdAt, authorization: input.authorization, batch: input.batch, requestDigest: requestDigest(vault, tool, input), planHash, log: audit?.log ?? null, noop, undo, reads, inventoryHash, git, timings: { scanMs: Math.max(0, performance.now() - started - (gitMs - previousGitMs)), gitMs } };
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
  const result = [{ code: 'QUIESCENT_FILES_REQUIRED', message: 'Affected files must remain quiescent. A save between the final revision check and rename or unlink can be overwritten or removed.' }];
  if (record?.durability === 'directory-sync-unavailable') result.push({ code: 'DIRECTORY_SYNC_UNAVAILABLE', message: 'Directory fsync is unsupported on this filesystem; power-loss durability is limited.' });
  if (durability && !durability.fsync) result.push({ code: 'GIT_FSYNC_UNAVAILABLE', message: `${durability.version} lacks core.fsync=committed; proceeding with the available Git durability.` });
  if (record && !record.git.indexInstalled) result.push({ code: 'INDEX_UPDATE_PENDING', message: 'The commit is published. Normal Git index reconciliation remains pending and status will retry it.' });
  if (record?.derivedIndexState === 'pending') result.push({ code: 'STRUCTURAL_INDEX_PENDING', message: 'The vault commit is durable. Refresh the structural index and use status to finish its recorded repair.' });
  if (record?.error?.code === 'COMMITTED_INDEX_CONFLICT') result.push(record.error);
  return result;
}

function recordResult(vault, directory, record, recovery, outcome, duration, durability) {
  return {
    ok: true, tool: record.tool, operation: record.operation, vault: vault.id, requestId: record.id, operationId: record.id,
    outcome, batch: record.batch, planHash: record.planHash,
    changes: outputChanges(record.files.map(file => {
      const before = file.before === null ? null : readBlob(directory, vault, record.id, file.before);
      const after = file.after === null ? null : readBlob(directory, vault, record.id, file.after);
      let delta = 0;
      const splices = record.version === 2 ? file.splices.map(splice => {
        const replacement = after?.subarray(splice.startByte + delta, splice.startByte + delta + splice.replacementBytes) ?? Buffer.alloc(0);
        if (revision(replacement) !== splice.replacementHash) refuse('JOURNAL_CORRUPT', 'A recorded splice does not match the immutable after bytes.', [file.path]);
        delta += splice.replacementBytes - (splice.endByte - splice.startByte);
        return { startByte: splice.startByte, endByte: splice.endByte, replacement: replacement.toString('utf8') };
      }) : undefined;
      return { ...file, before, after, splices };
    }), false),
    commit: { oid: record.git.commit, parent: record.git.baseHead, subject: `notient(${record.operation}): ${JSON.stringify(record.source)}` },
    log: record.log, undo: { operationIds: record.undo.targets, commits: record.undo.commits }, recovery,
    indexState: record.indexState, derivedIndexState: record.derivedIndexState, capture: captureReceipt(record.capture), link: record.link ?? null, relate: record.relate ?? null, warnings: warnings(record, durability), timings: { ...record.timings, totalMs: duration },
  };
}

function previewResult(tool, vault, input, plan, started) {
  return { ok: true, tool, operation: plan.operation, vault: vault.id, requestId: input.requestId, operationId: null, outcome: plan.noop ? 'noop' : 'preview', batch: plan.batch, planHash: plan.planHash, changes: plan.noop ? [] : outputChanges(plan.files, true), commit: null, log: null, undo: { operationIds: plan.undo.targets, commits: plan.undo.commits }, recovery: [], indexState: 'unchanged', derivedIndexState: 'unchanged', capture: captureReceipt(plan.capture), link: plan.link ?? null, relate: plan.relate ?? null, warnings: warnings(null, plan.git.durability), timings: { scanMs: plan.timings.scanMs, lockWaitMs: 0, journalMs: 0, applyMs: 0, gitMs: plan.timings.gitMs, totalMs: performance.now() - started } };
}

export function writeOperation(tool, raw, { directory = dataDirectory(), ...options } = {}) {
  const started = performance.now();
  options.gitBudget = createGitBudget({ now: options.gitClock, call: options.gitCall });
  let input;
  let vault;
  let record;
  let adapter;
  let recovery = [];
  try {
    input = inputFor(tool, raw);
    if (!readConfig(directory).vaults.length) return { ...notConfigured(), tool, requestId: input.requestId, operationId: null, state: 'unavailable', commit: null, recovery: [] };
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
      if (listRecords(directory, vault).some(blocksWrites)) refuse('RECOVERY_REQUIRED', 'Complete pending recovery before previewing a new change.');
      const plan = buildWritePlan(tool, vault, directory, input, options);
      const result = previewResult(tool, vault, input, plan, started);
      if (Buffer.byteLength(JSON.stringify(result)) > 900000) refuse('PREVIEW_TOO_LARGE', 'The complete preview exceeds 900000 bytes.');
      return result;
    }
    requireAuthority(vault, input.authorization, []);
    if (tool === 'revise' && (input.operation !== 'move' || input.path === input.destination) && !existing() && !listRecords(directory, vault).some(blocksWrites)) {
      const plan = buildWritePlan(tool, vault, directory, input, options);
      if (plan.noop) return previewResult(tool, vault, input, plan, started);
    }
    return withWriterLock(directory, vault, lockWaitMs => {
      try {
        options.barrier?.('afterWriterLock', null);
        const current = selectVault(vault.id, directory);
        if (current.path !== vault.path) refuse('VAULT_CHANGED', 'The registered vault root changed while waiting for the writer lock.');
        vault = current;
        requireAuthority(vault, input.authorization, []);
        existing();
        adapter = createGitAdapter(vault, directory);
        const recovered = recoverPending(vault, directory, adapter, { deadline: started + 240000, ...options });
        recovery = recovered.results;
        if (recovered.blocking.length || recovery.some(item => item.error || item.result === 'conflict_preserved')) refuse('RECOVERY_REQUIRED', 'Pending recovery prevents new writes.');
        record = existing();
        if (record) {
          if (record.state === 'aborted') refuse('OPERATION_ABORTED', 'The original operation was aborted. Use a fresh preview and request ID.');
          if (!adapter.recognize(record)) refuse('RECOVERY_REQUIRED', 'The requested operation has not published a verified commit.');
          return recordResult(vault, directory, record, recovery, 'already_committed', performance.now() - started, adapter.durability);
        }
        const plan = buildWritePlan(tool, vault, directory, input, options);
        if (plan.noop) return { ...previewResult(tool, vault, input, plan, started), recovery };
        adapter.consume(plan.id, plan.timings.gitMs);
        const journalStarted = performance.now();
        record = persistPlan(vault, directory, plan, options.sync);
        record.timings = { ...record.timings, ...plan.timings, lockWaitMs, journalMs: performance.now() - journalStarted };
        const result = finishRecord(vault, directory, record, adapter, { deadline: started + 240000, ...options });
        if (result.result === 'conflict_preserved') refuse(result.conflicts.some(item => item.reason.startsWith('UNSTAMPED_AFTER')) ? 'UNSTAMPED_AFTER' : 'REVISION_CONFLICT', 'The operation encountered unstamped or changed bytes.', result.conflicts.map(item => item.path));
        if (result.result === 'aborted_unapplied') refuse(record.error?.code === 'DEPENDENCY_CHANGED' ? 'DEPENDENCY_CHANGED' : 'OPERATION_ABORTED', 'The frozen operation was invalidated before publication. Use a fresh preview and request ID.');
        if (!record.git.commit || !adapter.recognize(record)) refuse('GIT_PUBLICATION_UNCERTAIN', 'A write cannot succeed before its exact commit is verified as published.');
        record.timings.totalMs = performance.now() - started;
        saveRecord(directory, vault, record, options.sync);
        return recordResult(vault, directory, record, recovery, 'committed', performance.now() - started, adapter.durability);
      } catch (error) {
        if (record && !['committed', 'aborted'].includes(record.state)) {
          let published = false;
          try { published = adapter?.recognize(record) ?? false; } catch {}
          if (!published && ['REVISION_CONFLICT', 'GIT_HEAD_CHANGED', 'DEPENDENCY_CHANGED'].includes(error.code)) {
            try {
              const states = classifyFiles(vault, record);
              if (states.some(item => item.state !== 'before')) {
                record.state = 'conflicted';
                record.conflicts = states.filter(item => item.state !== 'before').map(({ file, current }) => ({ path: file.path, expectedBefore: file.before, expectedAfter: file.after, actual: current.revision, reason: error.message }));
              }
            } catch {}
          }
          record.error = { code: error.code ?? 'WRITE_FAILED', message: error.message };
          try { saveRecord(directory, vault, record, options.sync); } catch {}
        }
        throw error;
      }
    });
  } catch (error) {
    let partial = false;
    let commit = null;
    if (record) {
      try { partial = record.files.some(file => currentFile(vault.path, file.path).revision !== file.before); } catch { partial = true; }
      try { if (adapter?.recognize(record)) commit = record.git.commit; } catch {}
    }
    return { ok: false, tool, vault: vault?.id ?? null, requestId: input?.requestId ?? raw.requestId ?? null, operationId: record?.id ?? null, state: ['intent', 'applied', 'conflicted'].includes(record?.state) ? record.state : 'refused', error: { code: error.code ?? 'WRITE_FAILED', message: error.message, retryable: error.retryable ?? false, paths: (error.paths ?? []).slice(0, 100) }, recovery, partial, commit };
  }
}
