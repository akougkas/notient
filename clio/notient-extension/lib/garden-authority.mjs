import { currentFile, revision, refuse } from './paths.mjs';
import { documentSpans, frontmatterFields, editFrontmatter } from './markdown.mjs';
import { yamlSpans, planRelate } from './relate.mjs';
import { scanMoveVault, tokenizeMove, inventoryIndex, resolveMoveTarget, applySplices } from './move.mjs';
import { readBlob } from './journal.mjs';
import { openGarden, liveGardenRun, gardenTransaction } from './garden-store.mjs';
import { readCoverage } from './embedding-off.mjs';

const closed = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const denied = (message, paths = []) => refuse('UNATTENDED_REFUSED', message, paths);

export function guardAdditiveInput(input) {
  if (input.operation !== 'frontmatter') return;
  let value; try { value = JSON.parse(input.set?.[0]?.valueJson); } catch { denied('Unattended tags must encode a string array.'); }
  if (input.unset?.length || input.set?.length !== 1 || input.set[0].key !== 'tags' || !Array.isArray(value) || value.some(tag => typeof tag !== 'string')) denied('Unattended frontmatter requests may set only a string tags array and may not unset keys.');
}

function tags(bytes) {
  const document = documentSpans(bytes); const field = frontmatterFields(document).find(field => field.key === 'tags');
  if (!field) return [];
  const parsed = yamlSpans(document, field).root;
  if (parsed.type !== 'list' || parsed.items.some(item => item.type !== 'string')) denied('Unattended tags require an existing list of string members.');
  return parsed.items.map(item => item.value);
}

export function guardAdditive(vault, operation, files, { link = null, relate = null } = {}) {
  const notes = files.filter(file => file.role !== 'log');
  if (!['link', 'relate', 'frontmatter'].includes(operation) || notes.length !== 1 || notes[0].before === null || notes[0].after === null || /^Notient\/(?:Log|Plans|Digest)\//.test(notes[0].path)) denied('Unattended revisions allow only additive links, relations or tags on an ordinary note.', notes.map(file => file.path));
  const file = notes[0];
  if (operation === 'frontmatter') {
    const before = tags(file.before); const after = tags(file.after);
    if (before.some((tag, index) => after[index] !== tag) || after.length < before.length || !editFrontmatter(file.before, [{ key: 'tags', valueJson: JSON.stringify(after) }], []).bytes.equals(file.after)) denied('Unattended frontmatter must append string tags while preserving existing members, order and all other bytes.', [file.path]);
    return;
  }
  const scan = scanMoveVault(vault.path); scan.notes = scan.notes.map(note => note.path === file.path ? { ...note, bytes: file.before, revision: revision(file.before) } : note);
  if (operation === 'relate') {
    if (!relate || !planRelate(scan, file.path, relate, { origin: 'unattended' }).bytes.equals(file.after)) denied('The relation delta differs from its designated append.', [file.path]);
    return;
  }
  if (tokenizeMove(file.before).unclosedFence) denied('Closing an unclosed fence requires a reviewed structural proposal.', [file.path]);
  const splices = file.splices;
  if (!Array.isArray(splices) || splices.some(splice => splice.startByte !== splice.endByte || splice.startByte < Buffer.byteLength(documentSpans(file.before).text.slice(0, documentSpans(file.before).bodyStart)))) denied('Additive links must preserve all existing note bytes.', [file.path]);
  if (!applySplices(file.before, splices).equals(file.after)) denied('The link bytes differ from the allowed insertions.', [file.path]);
  const index = inventoryIndex(scan.inventory, scan.notes);
  for (const splice of splices) {
    const text = splice.replacement;
    if (text.split(/\r?\n/).some(line => line.trim() && line !== '## Related' && !/^- \[\[[^\]\r\n]+\]\]$/.test(line))) denied('Unattended link insertions may add only Related headings, bullets and whitespace.', [file.path]);
    for (const token of tokenizeMove(Buffer.from(text)).tokens) {
      const target = resolveMoveTarget(token, file.path, index);
      if (token.kind !== 'wiki' || token.embed || target.state !== 'resolved' || !link?.admitted.some(edge => edge.targetNotePath === target.identity)) denied('The link append introduces an unadmitted target.', [file.path]);
    }
  }
}

export function guardRecordAdditive(vault, directory, record) {
  if (record.authorization.origin !== 'unattended' || vault.role !== 'operator' && !record.gardenRun) return;
  if (record.operation === 'capture' && record.files.filter(file => file.role !== 'log').every(file => file.path.startsWith('Notient/Inbox/'))) return;
  if (record.operation === 'undo' && !record.gardenRun && record.files.filter(file => file.role !== 'log').every(file => file.path.startsWith('Notient/'))) return;
  if (record.managedDocument) {
    const db = openGarden(directory, vault);
    try { const file = record.files.find(file => file.path === record.managedDocument.path); const owned = db?.prepare('SELECT lastWrittenRevision FROM owned WHERE path=?').get(file.path)?.lastWrittenRevision ?? null; if (owned !== file.before && !(record.state === 'committed' && owned === file.after)) denied('The managed document ownership changed before publication.', [file.path]); }
    finally { db?.close(); }
    return;
  }
  const files = record.files.map(file => {
    const before = file.before === null ? null : readBlob(directory, vault, record.id, file.before); const after = file.after === null ? null : readBlob(directory, vault, record.id, file.after); let delta = 0;
    const splices = file.splices.map(splice => { const replacement = after.subarray(splice.startByte + delta, splice.startByte + delta + splice.replacementBytes).toString('utf8'); delta += splice.replacementBytes - (splice.endByte - splice.startByte); return { ...splice, replacement }; });
    return { ...file, before, after, splices };
  });
  guardAdditive(vault, record.operation, files, record);
}

export function validateGardenRun(value) {
  if (!closed(value, ['runId', 'itemId', 'leaseToken', 'slot']) || typeof value.runId !== 'string' || !/^[A-Za-z0-9._-]{8,48}$/.test(value.runId) || typeof value.itemId !== 'string' || !/^[a-f0-9]{64}$/.test(value.itemId) || typeof value.leaseToken !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.leaseToken) || !Number.isInteger(value.slot) || value.slot < 1 || value.slot > 3) refuse('INVALID_INPUT', 'gardenRun requires a closed run, item, token and slot identity.');
}

export function admitGardenAction(vault, directory, input, digest, { reserve = false, recovery = false } = {}) {
  if (!input.gardenRun) return;
  validateGardenRun(input.gardenRun);
  if (input.authorization.origin !== 'unattended' || input.plan) refuse('INVALID_AUTHORIZATION', 'A garden action requires unattended attribution and no operator plan.');
  const action = db => {
    const run = recovery ? db.prepare('SELECT * FROM runs WHERE id=?').get(input.gardenRun.runId) : liveGardenRun(db, input.gardenRun.runId, Date.now());
    if (!run) refuse('GARDEN_RUN_MISSING', 'The frozen garden run is missing.');
    const item = db.prepare('SELECT * FROM queue WHERE key=? AND runId=?').get(input.gardenRun.itemId, run.id);
    const initial = JSON.parse(run.resultJson)?.items?.find(item => item.id === input.gardenRun.itemId);
    if (!item || item.leaseToken !== input.gardenRun.leaseToken || !recovery && initial?.slot !== input.gardenRun.slot || input.path !== item.path || input.requestId !== `${run.id}.${input.gardenRun.slot}` || input.batch !== run.batch || input.authorization.request !== run.request) refuse('GARDEN_ACTION_INVALID', 'The action must use its begin-assigned source, slot, request ID, batch and exact task.');
    const prior = db.prepare('SELECT * FROM actions WHERE runId=? AND slot=?').get(run.id, input.gardenRun.slot);
    if (prior && prior.inputDigest !== digest) refuse('REQUEST_ID_REUSED', 'The garden slot already has a different frozen input.');
    if (!recovery && (item.state !== 'leased' || item.leaseUntil <= Date.now() || currentFile(vault.path, item.path).revision !== (item.processedRevision ?? item.revision) || input.revision !== (item.processedRevision ?? item.revision))) refuse('GARDEN_LEASE_INVALID', 'The source lease expired, settled or changed.');
    if (!recovery && readCoverage(vault, directory).state !== 'current') refuse('GARDEN_COVERAGE_UNKNOWN', 'Fresh structural coverage is required before new garden mutations.');
    if (reserve && !prior) {
      if (db.prepare('SELECT count(*) AS n FROM actions WHERE runId=?').get(run.id).n >= 3) refuse('GARDEN_LIMIT', 'This run has reserved its three additive operations.');
      db.prepare("INSERT INTO actions VALUES (?,?,?,?,'reserved',NULL)").run(run.id, input.gardenRun.slot, input.requestId, digest);
    }
    if (recovery && (!prior || prior.requestId !== input.requestId || prior.inputDigest !== digest)) refuse('GARDEN_ACTION_INVALID', 'A durable action lacks its frozen reservation.');
  };
  if (reserve) return gardenTransaction(directory, vault, action);
  const db = openGarden(directory, vault); try { if (!db) refuse('GARDEN_RUN_MISSING', 'Begin the garden run first.'); return action(db); } finally { db?.close(); }
}
