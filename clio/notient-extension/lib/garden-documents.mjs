import { currentFile, revision, refuse, validText } from './paths.mjs';
import { openGarden, liveGardenRun, gardenRun, gardenTransaction } from './garden-store.mjs';
import { uniqueJson } from './closed-json.mjs';
import { admitGardenEvidence } from './garden-evidence.mjs';
import { buildWritePlan, writeOperation, canonicalJson, plannedLog, requestDigest, inputFor, unifiedDiff } from './write.mjs';
import { preflightGit, createGitBudget } from './git.mjs';
import { freezeEditAges } from './vitals-write.mjs';
import { listRecords, readBlob } from './journal.mjs';
import { reconcileGarden } from './garden-reconcile.mjs';
import { atomicJson } from './config.mjs';
import path from 'node:path';
import { gardenPath } from './garden-store.mjs';

export function inertBlock(text, language = '') {
  const longest = Math.max(2, ...(String(text).match(/`+/g) ?? []).map(run => run.length)); const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${text}${String(text).endsWith('\n') ? '' : '\n'}${fence}\n`;
}

export function approvedDelta(plan) {
  return plan.files.filter(file => file.role !== 'log' && !(file.before !== null && file.after !== null && file.before.equals(file.after))).map(file => ({ path: file.path, before: file.before === null ? null : revision(file.before), after: file.after === null ? null : revision(file.after) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function proposals(vault, directory, input, run, db) {
  const values = uniqueJson(input.proposalsJson);
  if (!Array.isArray(values) || !values.length || values.length > 3) refuse('INVALID_INPUT', 'Provide one to three closed structural proposals.');
  const records = listRecords(directory, vault);
  const admitted = values.map((value, index) => {
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'action,evidence,id,itemId,reason,request' || value.id !== `p-${run.id}-${index + 1}` || typeof value.itemId !== 'string' || !/^[a-f0-9]{64}$/.test(value.itemId) || ['request', 'reason'].some(key => typeof value[key] !== 'string' || !validText(value[key]).trim() || value[key].length > 1000)) refuse('INVALID_INPUT', 'A proposal must have its generated ID, leased item, request, reason, evidence and action.');
    const item = db.prepare("SELECT * FROM queue WHERE key=? AND runId=? AND state='leased'").get(value.itemId, run.id);
    if (!item || item.leaseUntil <= Date.now()) refuse('GARDEN_LEASE_INVALID', 'Each proposal requires a live item lease.');
    if (!value.action || value.action.path !== item.path || value.action.revision !== (item.processedRevision ?? item.revision) || Object.keys(value.action).some(key => ['vault', 'authorization', 'requestId', 'batch', 'gardenRun', 'plan', 'dryRun', 'planHash'].includes(key))) refuse('PLAN_ACTION_MISMATCH', 'Proposal action must use its leased source and closed revision payload.');
    const evidence = admitGardenEvidence(vault, directory, value.evidence);
    const planned = buildWritePlan('revise', vault, directory, inputFor('revise', { ...value.action, requestId: `${run.id}.preview.${index + 1}`, dryRun: true, batch: run.batch, authorization: { origin: 'unattended', request: run.request } }));
    if (planned.noop) refuse('PLAN_NO_CHANGE', 'A structural proposal must contain a real note delta.');
    const actionDigest = revision(canonicalJson(value.action));
    for (const record of records.filter(record => record.state === 'committed' && record.operation === 'garden_plan' && !record.undoneBy)) {
      const bytes = record.files.find(file => file.path === record.source)?.after;
      if (bytes && record.reads.some(read => read.path === value.action.path && read.revision === value.action.revision)) {
        const prior = readPlanProposalsFromRecord(directory, vault, record);
        if (prior.some(proposal => revision(canonicalJson(proposal.action)) === actionDigest)) refuse('PROPOSAL_ALREADY_RECORDED', 'This source, action and revision already have a retained proposal.');
      }
    }
    return { ...value, evidence, preview: { changes: approvedDelta(planned), readSet: planned.reads, diff: planned.files.filter(file => file.role !== 'log').map(file => unifiedDiff(file.path, file.before, file.after)).join('\n') } };
  });
  if (new Set(admitted.map(value => value.itemId)).size !== admitted.length) refuse('INVALID_INPUT', 'Each leased item may have only one structural proposal in this append.');
  return admitted;
}

export function readPlanProposals(text) {
  const lines = text.split('\n'); const result = []; let fence = null;
  for (let index = 0; index < lines.length; index++) {
    if (fence) { if (new RegExp(`^${fence.char}{${fence.length},}\\s*$`).test(lines[index])) fence = null; continue; }
    const opening = /^(`{3,})notient-proposal$/.exec(lines[index]);
    if (!opening) { const other = /^(`{3,}|~{3,})/.exec(lines[index]); if (other) fence = { char: other[1][0], length: other[1].length }; continue; }
    const end = lines.indexOf(opening[1], index + 1);
    if (end < 0) refuse('PLAN_INVALID', 'The proposal machine payload is incomplete.');
    const value = uniqueJson(lines.slice(index + 1, end).join('\n'));
    result.push(value); index = end;
  }
  if (new Set(result.map(value => value?.id)).size !== result.length) refuse('PLAN_INVALID', 'Duplicate proposal identities refuse execution.');
  return result;
}

const readPlanProposalsFromRecord = (directory, vault, record) => readPlanProposals(readBlob(directory, vault, record.id, record.files.find(file => file.path === record.source).after).toString('utf8'));

function digestBody(vault, directory, run, db) {
  const items = db.prepare('SELECT key AS itemId,path,state,lastError,resultJson FROM queue WHERE runId=? ORDER BY path').all(run.id);
  const operations = listRecords(directory, vault).filter(record => record.state === 'committed' && record.batch === run.batch).map(record => ({ operationId: record.id, operation: record.operation, oid: record.git.commit, changes: record.files.filter(file => file.role !== 'log').map(file => file.path), indexState: record.indexState, derivedIndexState: record.derivedIndexState, link: record.link, relate: record.relate, undoneBy: record.undoneBy }));
  return `\n## ${run.startedAt} · ${run.id}\n\nCoverage and duties:\n${inertBlock(canonicalJson(JSON.parse(run.deterministicJson)))}\nItems and attributed judgments:\n${inertBlock(canonicalJson(items))}\nVerified earlier operations:\n${inertBlock(canonicalJson(operations))}\nUndo this run with the undo tool's targetBatch:\n${inertBlock(run.batch)}\nReverse newer overlapping daily-report appends first. Model, usage, cost and host receipt are unobserved.\n`;
}

function documentPlan(vault, directory, input, operationInput) {
  const db = openGarden(directory, vault);
  try {
    const run = liveGardenRun(db, input.runId, Date.now(), input.action === 'finish');
    const kind = input.action === 'propose' ? 'plan' : 'digest'; const name = `Notient/${kind === 'plan' ? 'Plans' : 'Digest'}/${run.startedAt.slice(0, 10)}.md`;
    const current = currentFile(vault.path, name); const owned = db.prepare('SELECT lastWrittenRevision FROM owned WHERE path=?').get(name);
    if (current.revision !== (owned?.lastWrittenRevision ?? null)) refuse('OWNED_NOTE_EDITED', 'The managed document is absent from verified ownership or has an operator edit.', [name]);
    if ((current.revision ?? 'absent') !== input.revision) refuse('REVISION_CONFLICT', 'The managed document differs from the supplied read revision.', [name], true);
    const selected = kind === 'plan' ? proposals(vault, directory, input, run, db) : [];
    const section = kind === 'plan' ? selected.map(value => `\n## ${value.id}: Proposed change\n\nStatus: proposed\n\nRequest:\n${inertBlock(value.request)}\nReason:\n${inertBlock(value.reason)}\nEvidence:\n${inertBlock(canonicalJson(value.evidence))}\nAction:\n${inertBlock(canonicalJson(value.action))}\nImpact:\n${inertBlock(canonicalJson(value.preview))}\nUndo: one operation through extension_notient__undo; the executed receipt supplies its ID.\n\n${inertBlock(canonicalJson(value), 'notient-proposal')}`).join('') : digestBody(vault, directory, run, db);
    const header = `---\ntype: notient-${kind}\ndate: ${run.startedAt.slice(0, 10)}\ncreated_by: clio\n---\n# ${kind === 'plan' ? 'Proposed vault changes' : 'Vault digest'}: ${run.startedAt.slice(0, 10)}\n`;
    const prefix = current.bytes ?? Buffer.from(header); const after = Buffer.concat([prefix, Buffer.from((prefix.length && !prefix.toString('utf8').endsWith('\n') ? '\n' : '') + section)]);
    if (after.length > 65536) refuse('GARDEN_DOCUMENT_LIMIT', 'The complete daily document cannot exceed 64 KiB.', [name]);
    const files = [{ path: name, role: 'note', before: current.bytes, after, mode: current.mode, splices: current.bytes === null ? [] : [{ startByte: current.bytes.length, endByte: current.bytes.length, replacement: after.subarray(current.bytes.length).toString('utf8') }] }];
    const createdAt = run.startedAt; const operation = `garden_${kind}`; const undo = { targets: [], commits: [] };
    const audit = plannedLog(vault, operationInput, operation, name, files, createdAt, undo); files.push(audit.file);
    const budget = createGitBudget(); const git = preflightGit(vault, files, { budget }); const ages = freezeEditAges(vault, directory, files, Date.parse(createdAt), budget);
    const reads = [...new Map(selected.flatMap(value => [...value.preview.readSet, { path: value.action.path, revision: value.action.revision }, ...value.evidence.map(evidence => ({ path: evidence.path, revision: evidence.revision }))]).map(read => [read.path, read])).values()].sort((a, b) => a.path < b.path ? -1 : 1);
    const planHash = revision(canonicalJson({ vaultId: vault.id, operation, files: files.filter(file => file.role !== 'log').map(file => ({ path: file.path, before: file.before === null ? null : revision(file.before), after: revision(file.after), mode: file.mode })), reads, inventoryHash: null, ref: git.ref, baseHead: git.baseHead, log: { path: audit.file.path, before: audit.file.before === null ? null : revision(audit.file.before) } }));
    if (input.planHash && input.planHash !== planHash) refuse('PLAN_CHANGED', 'The document or its dependencies changed since preview.', [name]);
    return { id: operationInput.requestId, tool: 'garden', operation, source: name, createdAt, authorization: operationInput.authorization, batch: run.batch, requestDigest: requestDigest(vault, 'garden', operationInput), planHash, files, reads, inventoryHash: null, git, log: audit.log, undo, noop: false, ...ages, managedDocument: { kind, path: name, runId: run.id, itemIds: selected.map(value => value.itemId) }, timings: { scanMs: 0, gitMs: budget.usedMs } };
  } finally { db?.close(); }
}

export function publishGardenDocument(vault, directory, input, options = {}) {
  const db = openGarden(directory, vault); let run;
  try { run = gardenRun(db, input.runId); } finally { db?.close(); }
  if (JSON.parse(run.resultJson ?? '{}').undone) refuse('GARDEN_RUN_UNDONE', 'An undone run requires a fresh run ID and new review.');
  const kind = input.action === 'propose' ? 'plan' : 'digest';
  if (!input.dryRun && !input.planHash) refuse('PLAN_HASH_REQUIRED', 'A real garden publication requires its preview hash.');
  const operationInput = { ...input, requestId: `${run.id}.${kind}`, batch: run.batch, authorization: { origin: 'unattended', request: run.request } };
  const result = writeOperation('garden', operationInput, { directory, ...options, buildManagedPlan: () => documentPlan(vault, directory, input, operationInput) });
  if (!input.dryRun && kind === 'digest' && !result.ok && ['OWNED_NOTE_EDITED', 'GARDEN_DOCUMENT_LIMIT'].includes(result.error?.code)) {
    const receipt = gardenTransaction(directory, vault, state => {
      const items = state.prepare('SELECT key AS itemId,path,state,resultJson FROM queue WHERE runId=?').all(run.id);
      const operations = listRecords(directory, vault).filter(record => record.state === 'committed' && record.batch === run.batch).map(record => ({ id: record.id, oid: record.git.commit, indexState: record.indexState, derivedIndexState: record.derivedIndexState }));
      const receipt = { version: 1, runId: run.id, vault: vault.id, batch: run.batch, startedAt: run.startedAt, finishedAt: new Date().toISOString(), state: 'partial', coverage: JSON.parse(run.deterministicJson).coverage, deterministic: JSON.parse(run.deterministicJson), items, operations, documents: { plan: null, digest: { path: `Notient/Digest/${run.startedAt.slice(0, 10)}.md`, state: 'deferred', error: result.error } }, warnings: [result.error], hostReceipt: null, model: null, usage: null, cost: null, session: null, hostRunId: null };
      state.prepare("UPDATE runs SET state='partial',resultJson=? WHERE id=?").run(JSON.stringify(receipt), run.id); return receipt;
    });
    atomicJson(path.join(path.dirname(gardenPath(directory, vault)), 'garden-runs', run.id, 'result.json'), receipt);
  }
  const name = `Notient/${kind === 'plan' ? 'Plans' : 'Digest'}/${run.startedAt.slice(0, 10)}.md`;
  const state = openGarden(directory, vault); let runState;
  try { runState = gardenRun(state, run.id).state; } finally { state?.close(); }
  return { ...result, runId: run.id, document: { kind, path: name, revision: result.changes?.find(change => change.path === name)?.after ?? currentFile(vault.path, name).revision ?? 'absent' }, proposalIds: kind === 'plan' && result.ok ? uniqueJson(input.proposalsJson).map(value => value.id) : [], runState };
}
