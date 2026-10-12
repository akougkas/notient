import { randomUUID } from 'node:crypto';
import { dataDirectory, readConfig, selectVault, notConfigured } from './config.mjs';
import { currentFile, revision, portableName, validText, refuse } from './paths.mjs';
import { probeFts5, refreshIndex, openIndex, unavailableFts5Coverage } from './index.mjs';
import { readCoverage } from './embedding-off.mjs';
import { graphDegrees } from './vitals-index.mjs';
import { recoverVault, canonicalJson } from './write.mjs';
import { withIndexWriter } from './index-lock.mjs';
import { publishGardenDocument } from './garden-documents.mjs';
import { manualFinding } from './garden-evidence.mjs';
import { reconcileGarden } from './garden-reconcile.mjs';
import { listRecords } from './journal.mjs';
import { createGitAdapter } from './git.mjs';
import { openGarden, gardenTransaction, gardenRun, liveGardenRun, queueCounts, gardenLimits } from './garden-store.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9._-]{8,48}$/.test(value);
export const managedGardenPath = name => /^Notient\/(?:Plans|Digest)\//.test(name);
const excluded = name => /^(?:Notient\/(?:Log|Plans|Digest)\/|Notient\/Conventions\.md$)/.test(name);
const item = (row, slot) => ({ id: row.key, path: row.path, revision: row.processedRevision ?? row.revision, leaseToken: row.leaseToken, leaseUntil: new Date(row.leaseUntil).toISOString(), attempt: row.attempts, slot, requestId: `${row.runId}.${slot}` });

export function gardenInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !['begin', 'settle', 'propose', 'finish'].includes(raw.action) || typeof raw.vault !== 'string' || !raw.vault.length || raw.vault.length > 4096) refuse('INVALID_INPUT', 'Garden requires one registered vault and action.');
  const fields = { begin: ['runId', 'request'], settle: ['runId', 'itemId', 'leaseToken', 'outcome', 'reason', 'operationIds', 'findingJson'], propose: ['runId', 'proposalsJson', 'revision', 'dryRun', 'planHash'], finish: ['runId', 'revision', 'dryRun', 'planHash'] };
  if (Object.keys(raw).some(key => !['vault', 'action', ...fields[raw.action]].includes(key))) refuse('INVALID_INPUT', 'Garden actions accept only their closed input fields.');
  const input = { ...raw, runId: raw.runId ?? (raw.action === 'begin' ? randomUUID() : null) };
  if (!id(input.runId)) refuse('INVALID_INPUT', 'runId must contain 8 to 48 permitted ID characters.');
  if (input.action === 'begin' && (typeof input.request !== 'string' || !validText(input.request).trim() || input.request.length > 2000)) refuse('INVALID_INPUT', 'Begin requires the exact nonblank maintenance request.');
  if (input.action === 'settle') {
    if (!hash(input.itemId) || typeof input.leaseToken !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.leaseToken) || !['complete', 'deferred', 'failed'].includes(input.outcome) || typeof input.reason !== 'string' || !validText(input.reason).trim() || input.reason.length > 1000 || !Array.isArray(input.operationIds) || input.operationIds.length > 3 || new Set(input.operationIds).size !== input.operationIds.length || input.operationIds.some(value => typeof value !== 'string' || !/^[A-Za-z0-9._-]{8,64}$/.test(value))) refuse('INVALID_INPUT', 'Settlement requires a lease, bounded reason, outcome and unique operation IDs.');
  }
  if (['propose', 'finish'].includes(input.action)) {
    if (input.revision !== 'absent' && !hash(input.revision) || input.dryRun !== undefined && typeof input.dryRun !== 'boolean' || input.planHash !== undefined && !hash(input.planHash)) refuse('INVALID_INPUT', 'Document publication requires absent or an exact revision and bounded preview fields.');
    if (input.action === 'propose' && (typeof input.proposalsJson !== 'string' || input.proposalsJson.length < 2 || input.proposalsJson.length > 24000)) refuse('INVALID_INPUT', 'Supply the bounded proposals JSON.');
  }
  return input;
}

export function gardenDocuments(vault, run) {
  return Object.fromEntries(['plan', 'digest'].map(kind => {
    const name = `Notient/${kind === 'plan' ? 'Plans' : 'Digest'}/${run.startedAt.slice(0, 10)}.md`;
    return [kind, { path: name, revision: currentFile(vault.path, name).revision ?? 'absent' }];
  }));
}

function eligible(vault, directory) {
  const roots = vault.gardener?.inboxRoots ?? ['0-inbox'];
  if (!Array.isArray(roots) || roots.length > 8) refuse('INVALID_CONFIGURATION', 'Gardener inbox roots must contain zero to eight safe directories.');
  for (const root of roots) { if (typeof root !== 'string' || !root.length || root.length > 4096) refuse('INVALID_CONFIGURATION', 'Invalid gardener inbox root.'); root.split('/').forEach(portableName); }
  const db = openIndex(directory, vault); if (!db) return [];
  try {
    const graph = graphDegrees(db);
    return db.prepare('SELECT n.path,n.revision,v.word_count FROM notes n JOIN note_vitals v ON n.path=v.path AND n.revision=v.revision').all().filter(row => !excluded(row.path) && row.word_count > 0 && (['Notient/Inbox', ...roots].some(root => row.path.startsWith(root + '/')) || graph.get(row.path)?.inbound === 0 && graph.get(row.path)?.outbound === 0));
  } finally { db.close(); }
}

function begin(vault, directory, input, now, options = {}) {
  const recovered = recoverVault(vault, directory);
  if (recovered.busy || recovered.blocking?.length || recovered.results.some(result => result.error || result.result === 'conflict_preserved')) return { ok: true, tool: 'garden', vault: vault.id, runId: input.runId, state: 'blocked', reason: 'recovery_required', recovery: recovered, items: [] };
  reconcileGarden(vault, directory);
  const stamp = now(); const digest = revision(canonicalJson({ vault: vault.id, request: input.request }));
  const admitted = gardenTransaction(directory, vault, db => {
    const prior = db.prepare('SELECT * FROM runs WHERE id=?').get(input.runId);
    if (prior) {
      if (prior.inputDigest !== digest) refuse('REQUEST_ID_REUSED', 'The run ID already names a different maintenance request.');
      return { run: prior, retry: true };
    }
    if (db.prepare("SELECT 1 FROM runs WHERE state='active' AND leaseUntil>? LIMIT 1").get(stamp)) return { busy: true };
    db.prepare("UPDATE queue SET state=CASE WHEN attempts>=5 THEN 'poison' ELSE 'queued' END,leaseToken=NULL,leaseUntil=NULL,lastError='Lease expired' WHERE state='leased' AND leaseUntil<=?").run(stamp);
    db.prepare("UPDATE runs SET state='interrupted' WHERE state='active' AND leaseUntil<=?").run(stamp);
    if (db.prepare('SELECT count(*) AS n FROM runs').get().n >= gardenLimits.capacity) refuse('GARDEN_CAPACITY', 'Retained garden runs reached capacity.');
    const run = { id: input.runId, vault: vault.id, startedAt: new Date(stamp).toISOString(), deadline: stamp + gardenLimits.workMs, leaseUntil: stamp + gardenLimits.leaseMs, state: 'active', batch: `garden.${input.runId}`, request: input.request, inputDigest: digest, limits: JSON.stringify(gardenLimits), counters: JSON.stringify({ operations: 0, plans: 0, digests: 0 }), deterministicJson: null, resultJson: null };
    db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(run)); return { run, retry: false };
  });
  if (admitted.busy) return { ok: true, tool: 'garden', vault: vault.id, runId: input.runId, state: 'busy', items: [] };
  if (admitted.retry && admitted.run.resultJson) {
    if (JSON.parse(admitted.run.resultJson).undone) refuse('GARDEN_RUN_UNDONE', 'An undone run requires a fresh run ID and new review.');
    const db = openGarden(directory, vault);
    try { return { ...JSON.parse(admitted.run.resultJson), queue: queueCounts(db), receipts: db.prepare('SELECT key AS itemId,state,resultJson FROM queue WHERE runId=?').all(input.runId) }; }
    finally { db.close(); }
  }
  if (admitted.retry && (admitted.run.state !== 'active' || stamp > admitted.run.deadline)) refuse('GARDEN_RUN_EXPIRED', 'This interrupted run ID cannot be replayed.');
  const fts5 = probeFts5(); let structural = null; let coverage = unavailableFts5Coverage();
  if (fts5) { structural = refreshIndex(vault, directory, { maxChanged: 50, budgetMs: 60000, promotionEpoch: input.runId, promotionLimit: 50 }); coverage = readCoverage(vault, directory); }
  const deterministic = admitted.run.deterministicJson ? JSON.parse(admitted.run.deterministicJson) : { structural, vectors: { embedded: 0, reason: 'deterministic_core', remaining: null }, vitals: { promoted: structural?.promoted ?? 0, visited: structural?.vitalsVisited ?? 0, remaining: structural?.vitalsRemaining ?? null, limit: 50 }, pruning: { expiredReceipts: 0 }, coverage };
  if (fts5 && !admitted.run.deterministicJson) {
    withIndexWriter(vault, directory, () => {
    const db = openIndex(directory, vault, true);
    try {
      const live = new Set(listRecords(directory, vault).map(record => record.semanticEvidence?.candidateSet).filter(Boolean));
      const rows = db.prepare('SELECT id FROM candidate_sets WHERE expires_at<=?').all(new Date(stamp).toISOString());
      for (const row of rows) if (!live.has(row.id)) deterministic.pruning.expiredReceipts += Number(db.prepare('DELETE FROM candidate_sets WHERE id=?').run(row.id).changes);
    } finally { db.close(); }
    });
  }
  gardenTransaction(directory, vault, db => { db.prepare('UPDATE runs SET deterministicJson=? WHERE id=?').run(JSON.stringify(deterministic), input.runId); });
  options.barrier?.('afterGardenTick');
  const candidates = coverage.state === 'current' ? eligible(vault, directory) : [];
  return gardenTransaction(directory, vault, db => {
    const run = liveGardenRun(db, input.runId, now());
    if (run.resultJson) return JSON.parse(run.resultJson);
    for (const note of candidates) {
      const key = revision(canonicalJson([vault.id, note.path, note.revision, 'review', 'gardener-v1']));
      if (db.prepare('SELECT 1 FROM queue WHERE key=? OR path=? AND processedRevision=?').get(key, note.path, note.revision)) continue;
      if (db.prepare('SELECT count(*) AS n FROM queue').get().n >= gardenLimits.capacity) refuse('GARDEN_CAPACITY', 'Retained garden queue reached capacity.');
      db.prepare("UPDATE queue SET state='skipped',lastError='Source revision changed' WHERE path=? AND revision!=? AND state='queued'").run(note.path, note.revision);
      db.prepare("INSERT INTO queue VALUES (?,?,?,NULL,'review','gardener-v1',?,'queued',0,NULL,NULL,NULL,NULL,NULL)").run(key, note.path, note.revision, run.startedAt);
    }
    const items = db.prepare("SELECT * FROM queue WHERE runId=? AND state='leased' ORDER BY enqueuedAt,path").all(run.id).map((row, index) => item(row, index + 1));
    if (coverage.state === 'current') for (const row of db.prepare("SELECT * FROM queue WHERE state='queued' ORDER BY enqueuedAt,path LIMIT ?").all(3 - items.length)) {
      const current = currentFile(vault.path, row.path);
      if (current.revision !== row.revision) { db.prepare("UPDATE queue SET state='skipped',lastError='Source revision changed' WHERE key=?").run(row.key); continue; }
      const token = randomUUID(); const leaseUntil = now() + gardenLimits.leaseMs;
      if (db.prepare("UPDATE queue SET state='leased',attempts=attempts+1,leaseToken=?,leaseUntil=?,runId=? WHERE key=? AND state='queued'").run(token, leaseUntil, run.id, row.key).changes) items.push(item({ ...row, leaseToken: token, leaseUntil, runId: run.id, attempts: row.attempts + 1 }, items.length + 1));
    }
    const result = { ok: true, tool: 'garden', vault: vault.id, runId: run.id, batch: run.batch, deadline: new Date(run.deadline).toISOString(), state: coverage.state === 'current' ? 'active' : 'deferred', coverage, deterministic, items, queue: queueCounts(db), documents: gardenDocuments(vault, run) };
    db.prepare('UPDATE runs SET deterministicJson=?,resultJson=? WHERE id=?').run(JSON.stringify(deterministic), JSON.stringify(result), run.id); return result;
  });
}

function settle(vault, directory, input, now) {
  const finding = input.findingJson === undefined ? null : manualFinding(vault, directory, input.findingJson);
  return gardenTransaction(directory, vault, db => {
    liveGardenRun(db, input.runId, now(), true);
    const row = db.prepare('SELECT * FROM queue WHERE key=? AND runId=?').get(input.itemId, input.runId);
    if (!row || row.leaseToken !== input.leaseToken || row.leaseUntil <= now()) refuse('GARDEN_LEASE_INVALID', 'The source lease is absent, changed or expired.');
    if (row.resultJson && row.state === 'complete') {
      const prior = JSON.parse(row.resultJson); if (prior.reason !== input.reason && prior.reason !== 'A verified plan records the structural proposal.' || canonicalJson(prior.operationIds) !== canonicalJson(input.operationIds) || input.outcome !== 'complete') refuse('REQUEST_ID_REUSED', 'The item already has a different settlement.'); return prior;
    }
    if (row.state !== 'leased') refuse('GARDEN_LEASE_INVALID', 'The item is no longer leased.');
    const records = listRecords(directory, vault); const adapter = createGitAdapter(vault, directory);
    const owned = records.filter(record => record.gardenRun?.runId === input.runId && record.gardenRun?.itemId === row.key || record.managedDocument?.runId === input.runId && record.managedDocument.itemIds.includes(row.key));
    if (owned.some(record => !['committed', 'aborted'].includes(record.state))) return { ok: true, tool: 'garden', vault: vault.id, runId: input.runId, itemId: row.key, state: 'recovery_pending', operationIds: owned.map(record => record.id), reason: input.reason };
    if (input.outcome === 'complete' && owned.some(record => record.state === 'committed' && !record.undoneBy && !input.operationIds.includes(record.id))) refuse('GARDEN_ACTION_INVALID', 'Settlement must include every committed operation for this item.');
    for (const operationId of input.operationIds) {
      const record = records.find(record => record.id === operationId);
      if (!record || !owned.includes(record) || record.undoneBy) refuse('GARDEN_ACTION_INVALID', 'A supplied operation does not belong to this leased item.');
      if (record.state !== 'committed' || !adapter.recognize(record)) return { ok: true, tool: 'garden', vault: vault.id, runId: input.runId, itemId: row.key, state: 'recovery_pending', operationIds: input.operationIds, reason: input.reason };
    }
    const expected = records.filter(record => record.gardenRun?.runId === input.runId && record.gardenRun?.itemId === row.key && record.state === 'committed').flatMap(record => record.files.filter(file => file.path === row.path).map(file => file.after)).at(-1) ?? row.revision;
    const changed = currentFile(vault.path, row.path).revision !== expected;
    const state = changed ? 'skipped' : input.outcome === 'complete' ? 'complete' : row.attempts >= 5 ? 'poison' : 'queued';
    const result = { ok: true, tool: 'garden', vault: vault.id, runId: input.runId, itemId: row.key, state, operationIds: input.operationIds, reason: input.reason, ...(finding ? { finding } : {}) };
    db.prepare('UPDATE queue SET state=?,processedRevision=?,lastError=?,resultJson=? WHERE key=?').run(state, state === 'complete' ? expected : row.processedRevision, input.outcome === 'complete' ? null : input.reason, JSON.stringify(result), row.key); return result;
  });
}

export function gardenCommand(raw, { directory = dataDirectory(), now = () => Date.now(), ...options } = {}) {
  let input; let vault;
  try {
    input = gardenInput(raw);
    if (!readConfig(directory).vaults.length) return { ...notConfigured(), tool: 'garden', runId: input.runId, state: 'unavailable' };
    vault = selectVault(input.vault, directory);
    if (vault.readOnly) refuse('READ_ONLY_VAULT', 'Garden work requires a writable registered vault.');
    if (input.action === 'begin') return begin(vault, directory, input, now, options);
    if (input.action === 'settle') return settle(vault, directory, input, now);
    return publishGardenDocument(vault, directory, input, options);
  } catch (error) {
    if (input?.action === 'begin' && error.code === 'GARDEN_BUSY') return { ok: true, tool: 'garden', vault: vault.id, runId: input.runId, state: 'busy', items: [] };
    return { ok: false, tool: 'garden', vault: vault?.id ?? null, runId: input?.runId ?? raw?.runId ?? null, state: 'blocked', error: { code: error.code ?? 'GARDEN_UNAVAILABLE', message: error.message, retryable: error.retryable ?? false, paths: error.paths ?? [] } };
  }
}
