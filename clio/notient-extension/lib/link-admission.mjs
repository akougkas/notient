import { withPlanningIndex } from './planning-index.mjs';
import { vectorState } from './vector-store.mjs';
import { validateLinkEdges, validateTargetPath } from './link.mjs';
import { evidence as validEvidence } from './journal-v2.mjs';
import { evidenceFor } from './retrieval-evidence.mjs';
import { readNote, revision, refuse, validText } from './paths.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const stale = message => refuse('CANDIDATE_STALE', message, [], true);
const closed = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function receiptPayload(row, vault, source, sourceRevision, spaceId, at) {
  let payload;
  try { payload = JSON.parse(row.payload_json); } catch { stale('The candidate receipt is unreadable; retrieve candidates again.'); }
  if (!closed(payload, ['version', 'vault', 'source', 'sourceRevision', 'spaceId', 'indexGeneration', 'inventoryHash', 'createdAt', 'expiresAt', 'targets', 'textHashes']) || payload.version !== 1 || payload.vault !== vault.id || payload.source !== source || payload.sourceRevision !== sourceRevision || payload.spaceId !== spaceId || !Number.isSafeInteger(payload.indexGeneration) || payload.indexGeneration < 0 || !hash(payload.inventoryHash) || !Number.isFinite(Date.parse(payload.createdAt)) || !Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= at || Date.parse(payload.expiresAt) <= Date.parse(payload.createdAt) || !Array.isArray(payload.targets) || !payload.targets.length || payload.targets.length > 12 || !Array.isArray(payload.textHashes) || payload.textHashes.length !== payload.targets.length || row.vault !== payload.vault || row.source !== payload.source || row.revision !== payload.sourceRevision || row.space_id !== payload.spaceId || row.index_generation !== payload.indexGeneration || row.inventory_hash !== payload.inventoryHash || row.created_at !== payload.createdAt || row.expires_at !== payload.expiresAt) stale('The receipt expired or differs from this vault, source, revision or vector space; retrieve candidates again.');
  const seen = new Set();
  for (const [index, target] of payload.targets.entries()) {
    if (!closed(target, ['path', 'revision', 'title', 'bestDistance', 'sourceEvidence', 'targetEvidence']) || !hash(target.revision) || typeof target.title !== 'string' || !Number.isFinite(target.bestDistance) || target.bestDistance < 0 || target.bestDistance > 2 || !validEvidence(target.sourceEvidence) || !validEvidence(target.targetEvidence) || target.sourceEvidence.path !== source || target.sourceEvidence.revision !== sourceRevision || target.targetEvidence.path !== target.path || target.targetEvidence.revision !== target.revision || seen.has(target.path) || target.path === source) stale('The receipt contains invalid candidate evidence or distance; retrieve candidates again.');
    try { validateTargetPath(target.path); validText(target.title, 'Candidate title'); } catch { stale('The receipt contains an invalid target identity.'); }
    const textHash = payload.textHashes[index];
    if (!closed(textHash, ['path', 'source', 'target']) || textHash.path !== target.path || textHash.source !== revision(target.sourceEvidence.passage) || textHash.target !== revision(target.targetEvidence.passage)) stale('The receipt evidence hashes are inconsistent; retrieve candidates again.');
    seen.add(target.path);
  }
  return payload;
}

function literal(vault, value, files) {
  return evidenceFor(vault, { path: value.path, revision: value.revision, source: JSON.stringify(value.source), heading: JSON.stringify(value.headingPath), passage: value.passage }, files);
}

export function admitClioLink(vault, directory, input, { at = Date.now(), read = readNote } = {}) {
  validateLinkEdges(input.path, input.link.edges, 'clio');
  if (typeof input.link.candidateSet !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.link.candidateSet)) stale('Clio link admission requires a live candidateSet; retrieve candidates first.');
  const payload = withPlanningIndex(vault, directory, db => {
    const embedding = vectorState(vault, directory, { db });
    if (!['ready', 'incomplete'].includes(embedding.state)) stale('The configured vector space is unavailable or changed; retrieve candidates after refresh.');
    const row = db.prepare('SELECT * FROM candidate_sets WHERE id=?').get(input.link.candidateSet);
    if (!row) stale('The candidate receipt was lost or rebuilt; retrieve candidates again.');
    return receiptPayload(row, vault, input.path, input.revision, embedding.spaceId, at);
  });
  let current;
  try { current = read(vault.path, input.path); } catch { stale('The receipt source disappeared or cannot be read; retrieve candidates again.'); }
  if (current.revision !== input.revision) stale('The receipt source changed; retrieve candidates again.');
  const files = new Map([[input.path, current]]); const admitted = []; const dropped = []; const targets = [];
  for (const edge of input.link.edges) {
    const target = payload.targets.find(value => value.path === edge.targetNotePath);
    if (!target) { dropped.push({ targetNotePath: edge.targetNotePath, reason: 'not_retrieved' }); continue; }
    let live;
    try { live = read(vault.path, target.path); } catch { refuse('TARGET_CHANGED', 'A selected retrieved target disappeared or cannot be read; retrieve candidates again.', [target.path], true); }
    if (live.revision !== target.revision) refuse('TARGET_CHANGED', 'A selected retrieved target changed; retrieve candidates again.', [target.path], true);
    files.set(target.path, live);
    try { literal(vault, target.sourceEvidence, files); literal(vault, target.targetEvidence, files); }
    catch { stale('The receipt literal evidence changed; retrieve candidates again.'); }
    const similarity = 1 - target.bestDistance;
    if (similarity <= 0) { dropped.push({ targetNotePath: edge.targetNotePath, reason: 'nonpositive_similarity' }); continue; }
    admitted.push({ targetNotePath: target.path, relation: 'related_to', confidence: Math.min([0.95, 0.85, 0.75, 0.65][admitted.length], similarity), basis: 'clio-candidate', rationale: edge.rationale });
    targets.push({ path: target.path, revision: target.revision, bestDistance: target.bestDistance, sourceEvidence: target.sourceEvidence, targetEvidence: target.targetEvidence });
  }
  return { link: { admitted, dropped, candidateSet: input.link.candidateSet }, semanticEvidence: { version: 1, candidateSet: input.link.candidateSet, sourceRevision: input.revision, spaceId: payload.spaceId, indexGeneration: payload.indexGeneration, createdAt: payload.createdAt, expiresAt: payload.expiresAt, targets } };
}
