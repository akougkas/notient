import { existsSync } from 'node:fs';
import path from 'node:path';
import { atomicJson } from './config.mjs';
import { listRecords } from './journal.mjs';
import { createGitAdapter } from './git.mjs';
import { gardenPath, gardenTransaction, queueCounts } from './garden-store.mjs';

export function reconcileGarden(vault, directory, { exportResults = true, barrier = () => {} } = {}) {
  if (!existsSync(gardenPath(directory, vault))) return;
  const records = listRecords(directory, vault); const adapter = createGitAdapter(vault, directory); const receipts = [];
  gardenTransaction(directory, vault, db => {
    for (const record of records.filter(record => record.state === 'committed' && (record.gardenRun || record.managedDocument || record.plan || record.operation === 'undo'))) {
      const runId = record.gardenRun?.runId ?? record.managedDocument?.runId;
      const run = runId ? db.prepare('SELECT * FROM runs WHERE id=?').get(runId) : null;
      if (runId && !run) continue;
      const applied = record.gardenRun ? db.prepare('SELECT state FROM actions WHERE runId=? AND slot=?').get(runId, record.gardenRun.slot)?.state === 'committed' : record.managedDocument ? db.prepare('SELECT lastWrittenRevision FROM owned WHERE path=?').get(record.managedDocument.path)?.lastWrittenRevision === record.files.find(file => file.path === record.managedDocument.path).after : record.plan ? db.prepare('SELECT state FROM plan_actions WHERE proposalId=?').get(record.plan.proposalId)?.state === 'committed' : false;
      if (applied && !record.undoneBy) continue;
      if (!adapter.recognize(record)) continue;
      if (record.gardenRun) {
        db.prepare("UPDATE actions SET state=?,operationId=? WHERE runId=? AND slot=?").run(record.undoneBy ? 'undone' : 'committed', record.id, runId, record.gardenRun.slot);
        const after = record.files.find(file => file.path === record.source)?.after;
        db.prepare('UPDATE queue SET processedRevision=? WHERE key=? AND runId=?').run(after, record.gardenRun.itemId, runId);
      }
      if (record.managedDocument) {
        const { kind, path: name, itemIds } = record.managedDocument; const file = record.files.find(file => file.path === name);
        if (!record.undoneBy) db.prepare('INSERT OR REPLACE INTO owned VALUES (?,?)').run(name, file.after);
        if (kind === 'plan' && !record.undoneBy) for (const itemId of itemIds) db.prepare("UPDATE queue SET state='complete',processedRevision=revision,resultJson=? WHERE key=? AND runId=?").run(JSON.stringify({ ok: true, tool: 'garden', vault: vault.id, runId, itemId, state: 'complete', operationIds: [record.id], reason: 'A verified plan records the structural proposal.' }), itemId, runId);
        if (kind === 'digest' && !record.undoneBy) {
          const items = db.prepare('SELECT key AS itemId,path,state,resultJson FROM queue WHERE runId=?').all(runId);
          const state = items.every(item => ['complete', 'skipped'].includes(item.state)) ? 'complete' : 'partial';
          const operations = records.filter(candidate => candidate.state === 'committed' && candidate.batch === run.batch).map(candidate => ({ id: candidate.id, operation: candidate.operation, oid: candidate.git.commit, indexState: candidate.indexState, derivedIndexState: candidate.derivedIndexState }));
          const receipt = { version: 1, runId, vault: vault.id, batch: run.batch, startedAt: run.startedAt, finishedAt: record.createdAt, state, coverage: JSON.parse(run.deterministicJson).coverage, deterministic: JSON.parse(run.deterministicJson), items, operations, documents: Object.fromEntries(['plan', 'digest'].map(kind => { const saved = records.find(candidate => candidate.state === 'committed' && candidate.managedDocument?.runId === runId && candidate.managedDocument.kind === kind); return [kind, saved ? { path: saved.source, revision: saved.files.find(file => file.path === saved.source).after, operationId: saved.id, oid: saved.git.commit } : null]; })), warnings: [], hostReceipt: null, model: null, usage: null, cost: null, session: null, hostRunId: null };
          db.prepare('UPDATE runs SET state=?,resultJson=? WHERE id=?').run(state, JSON.stringify(receipt), runId); receipts.push(receipt);
        }
        if (record.undoneBy) {
          const prior = JSON.parse(db.prepare('SELECT resultJson FROM runs WHERE id=?').get(runId).resultJson ?? '{}');
          db.prepare("UPDATE runs SET state='interrupted',resultJson=? WHERE id=?").run(JSON.stringify({ ...prior, state: 'interrupted', undone: true }), runId);
        }
      }
      if (record.plan) db.prepare('UPDATE plan_actions SET state=?,operationId=? WHERE proposalId=?').run(record.undoneBy ? 'undone' : 'committed', record.id, record.plan.proposalId);
      if (record.operation === 'undo') for (const file of record.files) {
        if (!db.prepare('SELECT 1 FROM owned WHERE path=?').get(file.path)) continue;
        const originals = record.undo.targets.map(id => records.find(candidate => candidate.id === id));
        if (originals.some(original => original?.managedDocument?.path === file.path)) db.prepare('INSERT OR REPLACE INTO owned VALUES (?,?)').run(file.path, file.after);
      }
    }
    for (const run of db.prepare('SELECT * FROM runs').all()) {
      const counters = { operations: db.prepare("SELECT count(*) AS n FROM actions WHERE runId=? AND state='committed'").get(run.id).n, plans: records.filter(record => record.state === 'committed' && record.managedDocument?.runId === run.id && record.operation === 'garden_plan').length, digests: records.filter(record => record.state === 'committed' && record.managedDocument?.runId === run.id && record.operation === 'garden_digest').length };
      db.prepare('UPDATE runs SET counters=? WHERE id=?').run(JSON.stringify(counters), run.id);
      if (['complete', 'partial'].includes(run.state) && !receipts.some(receipt => receipt.runId === run.id)) receipts.push(JSON.parse(run.resultJson));
    }
  });
  barrier('beforeGardenExport');
  if (exportResults) for (const receipt of receipts) atomicJson(path.join(path.dirname(gardenPath(directory, vault)), 'garden-runs', receipt.runId, 'result.json'), receipt);
}
