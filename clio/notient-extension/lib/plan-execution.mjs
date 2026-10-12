import { currentFile, readNote, revision, refuse, validText } from './paths.mjs';
import { readPlanProposals, approvedDelta } from './garden-documents.mjs';
import { listRecords, readRecord, readBlob, operationDirectory } from './journal.mjs';
import { createGitAdapter } from './git.mjs';
import { canonicalJson, inputFor, requestDigest } from './write.mjs';
import { openGarden, gardenTransaction } from './garden-store.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';

const modeFields = operation => operation === 'replace' ? ['oldText', 'newText'] : operation === 'frontmatter' ? ['set', 'unset'] : operation === 'move' ? ['destination'] : operation === 'link' ? ['link'] : operation === 'relate' ? ['relate'] : [];
const actionFor = input => Object.fromEntries(['operation', 'path', 'revision', ...modeFields(input.operation)].filter(key => input[key] !== undefined).map(key => [key, input[key]]));

export function validatePlanInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'go,path,proposalId,revision' || typeof value.path !== 'string' || value.path.length > 4096 || !/^Notient\/Plans\/\d{4}-\d{2}-\d{2}\.md$/.test(value.path) || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision) || typeof value.proposalId !== 'string' || !validText(value.proposalId).length || value.proposalId.length > 80 || typeof value.go !== 'string' || !validText(value.go).trim() || value.go.length > 500) refuse('INVALID_INPUT', 'Plan execution requires a closed path, revision, proposal ID and exact go words.');
}

function executionBatch(vault, input) {
  const chars = revision(canonicalJson([vault.id, input.plan.proposalId, input.requestId])).slice(0, 32).split(''); chars[12] = '8'; chars[16] = (parseInt(chars[16], 16) & 3 | 8).toString(16); const hex = chars.join('');
  return `plan.${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function preparePlanExecution(vault, directory, input, { budget } = {}) {
  if (!input.plan) return { input, admission: null, prior: null };
  validatePlanInput(input.plan);
  if (input.authorization.origin !== 'operator' || input.gardenRun) refuse('INVALID_AUTHORIZATION', 'An exact operator go is required; unattended work cannot execute a plan.');
  const db = openGarden(directory, vault); let prior;
  try { prior = db?.prepare('SELECT * FROM plan_actions WHERE proposalId=?').get(input.plan.proposalId); } finally { db?.close(); }
  if (prior) {
    if (prior.state === 'undone') refuse('PLAN_ALREADY_UNDONE', 'This proposal was undone and requires a newly reviewed proposal.');
    if (existsSync(path.join(operationDirectory(directory, vault, prior.requestId), 'record.json'))) {
      const record = readRecord(directory, vault, prior.requestId);
      if (record.undoneBy) refuse('PLAN_ALREADY_UNDONE', 'This proposal was undone and requires a newly reviewed proposal.');
      if (record.plan?.proposalId !== input.plan.proposalId) refuse('JOURNAL_CORRUPT', 'The execution reservation differs from its journal.');
      if (record.plan.path !== input.plan.path || record.state !== 'committed' && record.plan.go !== input.plan.go) refuse('PLAN_EXECUTION_PENDING', 'Resume the original exact plan and operator go for this pending execution.');
      const recorded = inputFor('revise', { ...input, requestId: record.id, batch: record.batch });
      if (revision(canonicalJson(actionFor(recorded))) !== record.plan.actionDigest) refuse('PLAN_ACTION_MISMATCH', 'The repeated go must name the same approved action.');
      return { input, admission: null, prior: record };
    }
    if (prior.requestId !== input.requestId) refuse('PLAN_EXECUTION_PENDING', 'The proposal already has a reserved request ID; resume that request.', [], true);
  }
  const document = currentFile(vault.path, input.plan.path);
  if (document.revision !== input.plan.revision) refuse('PLAN_CHANGED', 'Read the exact current plan and review its proposal again.', [input.plan.path], true);
  const proposal = readPlanProposals(document.bytes.toString('utf8')).find(value => value.id === input.plan.proposalId);
  if (!proposal || !proposal.action || !proposal.preview || Object.keys(proposal).sort().join(',') !== 'action,evidence,id,itemId,preview,reason,request') refuse('PLAN_INVALID', 'The named proposal has no supported executable payload.');
  const records = listRecords(directory, vault); const adapter = createGitAdapter(vault, directory, { budget });
  const original = records.find(record => record.state === 'committed' && !record.undoneBy && record.operation === 'garden_plan' && record.source === input.plan.path && readPlanProposals(readBlob(directory, vault, record.id, record.files.find(file => file.path === record.source).after).toString('utf8')).some(value => canonicalJson(value) === canonicalJson(proposal)));
  if (!original || !adapter.recognize(original)) refuse('PLAN_INVALID', 'The proposal must match a verified retained plan publication; document approval words grant no authority.');
  const normalized = inputFor('revise', { ...proposal.action, requestId: input.requestId, batch: input.batch, authorization: input.authorization, dryRun: true });
  if (canonicalJson(actionFor(input)) !== canonicalJson(actionFor(normalized))) refuse('PLAN_ACTION_MISMATCH', 'The selected mode, payload and source revision must equal the saved action.');
  const actionDigest = revision(canonicalJson(actionFor(normalized)));
  const request = `Plan ${input.plan.path}@${input.plan.revision}#${input.plan.proposalId}\n${proposal.request}\nOperator go: ${input.plan.go}`;
  if (request.length > 2000) refuse('INVALID_AUTHORIZATION', 'The exact plan request and operator words exceed 2000 characters.');
  const bound = { ...input, requestId: prior?.requestId ?? input.requestId, batch: executionBatch(vault, input), authorization: { origin: 'operator', request } };
  if (prior && prior.inputDigest !== requestDigest(vault, 'revise', bound)) refuse('REQUEST_ID_REUSED', 'The reserved proposal execution has different exact input.');
  const admission = { ...input.plan, actionDigest, proposal };
  return { input: bound, admission, prior: null };
}

export function checkPlanDelta(vault, input, plan, admission) {
  if (!admission) return;
  for (const evidence of admission.proposal.evidence) {
    const live = readNote(vault.path, evidence.path);
    if (live.revision !== evidence.revision) refuse('EVIDENCE_CHANGED', 'The saved proposal evidence changed; a new review is required.', [evidence.path], true);
    const lines = live.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    if (!lines.slice(evidence.startLine - 1, evidence.endLine).join('').includes(evidence.quote)) refuse('EVIDENCE_CHANGED', 'The saved literal quotation no longer matches its lines.', [evidence.path], true);
  }
  if (canonicalJson(approvedDelta(plan)) !== canonicalJson(admission.proposal.preview.changes)) refuse('PLAN_IMPACT_CHANGED', 'The fresh affected-note delta differs from the approved proposal; review a revised proposal.', plan.files.filter(file => file.role !== 'log').map(file => file.path), true);
}

export function reservePlanExecution(vault, directory, input, digest) {
  if (!input.plan) return;
  gardenTransaction(directory, vault, db => {
    const prior = db.prepare('SELECT * FROM plan_actions WHERE proposalId=?').get(input.plan.proposalId);
    if (prior && (prior.requestId !== input.requestId || prior.inputDigest !== digest || prior.state === 'undone')) refuse('PLAN_EXECUTION_PENDING', 'The proposal already has a different reserved execution.');
    if (!prior) db.prepare("INSERT INTO plan_actions VALUES (?,?,?,?,NULL,'reserved')").run(input.plan.proposalId, input.plan.revision, input.requestId, digest);
  });
}

export function checkFrozenPlanReservation(vault, directory, record) {
  if (!record.plan) return;
  const db = openGarden(directory, vault);
  try {
    const row = db?.prepare('SELECT * FROM plan_actions WHERE proposalId=?').get(record.plan.proposalId);
    if (!row || row.requestId !== record.id || row.inputDigest !== record.requestDigest || row.planRevision !== record.plan.revision || row.state === 'undone') refuse('PLAN_EXECUTION_PENDING', 'The frozen operator intent lacks its exact execution reservation.');
  } finally { db?.close(); }
}
