import { portableName, refuse } from './paths.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const relations = ['supports', 'contradicts', 'extends', 'exemplifies', 'synthesizes'];
const closed = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function notePath(value) {
  if (typeof value !== 'string' || !value.length || value.length > 4096 || !/\.md$/i.test(value)) return false;
  try { value.split('/').forEach(portableName); return true; } catch { return false; }
}
export function evidence(value) {
  return closed(value, ['path', 'revision', 'headingPath', 'source', 'passage']) && notePath(value.path) && hash(value.revision) && Array.isArray(value.headingPath) && value.headingPath.every(title => typeof title === 'string') && typeof value.passage === 'string' && value.passage.length > 0 && value.passage.length <= 1200 && closed(value.source, ['startLine', 'endLine', 'startByte', 'endByte']) && Object.values(value.source).every(Number.isSafeInteger) && value.source.startLine >= 1 && value.source.endLine >= value.source.startLine && value.source.startByte >= 0 && value.source.endByte > value.source.startByte;
}

export function validateVersionTwo(record) {
  if (!['link', 'relate', 'semanticEvidence', 'vitalsBefore'].every(key => Object.hasOwn(record, key))) refuse('JOURNAL_CORRUPT', 'Version two requires frozen admission and edit-age fields.');
  const notes = record.files.filter(file => file.role === 'note');
  if (Object.hasOwn(record, 'vitalsFallbackPaths') && (!Array.isArray(record.vitalsFallbackPaths) || new Set(record.vitalsFallbackPaths).size !== record.vitalsFallbackPaths.length || record.vitalsFallbackPaths.some(name => !notes.some(file => file.path === name)))) refuse('JOURNAL_CORRUPT', 'Frozen fallback paths must name changed notes uniquely.');
  if (!Array.isArray(record.vitalsBefore) || record.vitalsBefore.length !== notes.length || new Set(record.vitalsBefore.map(value => value?.path)).size !== notes.length || record.vitalsBefore.some(value => !closed(value, ['path', 'lastUserEditMs']) || !notes.some(file => file.path === value.path) || value.lastUserEditMs !== null && (!Number.isFinite(value.lastUserEditMs) || Math.abs(value.lastUserEditMs) > 8640000000000000))) refuse('JOURNAL_CORRUPT', 'Frozen edit ages must cover each changed note exactly once.');
  for (const file of record.files) {
    if (!Array.isArray(file.splices)) refuse('JOURNAL_CORRUPT', 'Version two requires frozen chosen splice ranges.', [file.path]);
    let end = 0;
    for (const splice of file.splices) {
      if (!closed(splice, ['startByte', 'endByte', 'replacementHash', 'replacementBytes']) || ![splice.startByte, splice.endByte, splice.replacementBytes].every(Number.isSafeInteger) || splice.startByte < end || splice.endByte < splice.startByte || splice.endByte > 4 * 1024 * 1024 || splice.replacementBytes < 0 || splice.replacementBytes > 4 * 1024 * 1024 || !hash(splice.replacementHash)) refuse('JOURNAL_CORRUPT', 'A frozen byte splice is invalid.', [file.path]);
      end = splice.endByte;
    }
  }
  if (record.operation !== 'link' && record.link !== null || record.operation !== 'relate' && record.relate !== null) refuse('JOURNAL_CORRUPT', 'Admission results belong only to their recorded operation.');
  if (record.link !== null) {
    const value = record.link;
    if (!closed(value, ['admitted', 'dropped', 'candidateSet']) || !Array.isArray(value.admitted) || !Array.isArray(value.dropped) || value.admitted.length + value.dropped.length > 4 || value.admitted.length + value.dropped.length < 1 || value.candidateSet !== null && !uuid(value.candidateSet)) refuse('JOURNAL_CORRUPT', 'The frozen link result is invalid.');
    for (const edge of value.admitted) if (!closed(edge, ['targetNotePath', 'relation', 'confidence', 'basis', 'rationale']) || !notePath(edge.targetNotePath) || edge.targetNotePath === record.source || edge.relation !== 'related_to' || typeof edge.rationale !== 'string' || !edge.rationale.trim() || edge.rationale.length > 240 || (record.authorization.origin === 'clio' ? edge.basis !== 'clio-candidate' || !Number.isFinite(edge.confidence) || edge.confidence <= 0 || edge.confidence > 0.95 : edge.basis !== record.authorization.origin || edge.confidence !== null)) refuse('JOURNAL_CORRUPT', 'A frozen admitted edge is invalid.');
    for (const edge of value.dropped) if (!closed(edge, ['targetNotePath', 'reason']) || !notePath(edge.targetNotePath) || !['not_retrieved', 'nonpositive_similarity'].includes(edge.reason)) refuse('JOURNAL_CORRUPT', 'A frozen dropped edge is invalid.');
    if (new Set([...value.admitted, ...value.dropped].map(edge => edge.targetNotePath)).size !== value.admitted.length + value.dropped.length || record.authorization.origin !== 'clio' && (value.candidateSet !== null || value.dropped.length)) refuse('JOURNAL_CORRUPT', 'Frozen link admission has inconsistent identity or attribution.');
  } else if (record.operation === 'link') refuse('JOURNAL_CORRUPT', 'A link operation lacks its frozen result.');
  if (record.relate !== null && (!closed(record.relate, ['target', 'relation']) || !notePath(record.relate.target) || record.relate.target === record.source || !relations.includes(record.relate.relation))) refuse('JOURNAL_CORRUPT', 'The frozen typed relation is invalid.');
  if (record.operation === 'relate' && record.relate === null) refuse('JOURNAL_CORRUPT', 'A relation operation lacks its frozen result.');
  if (record.semanticEvidence !== null) {
    const value = record.semanticEvidence;
    const selected = [...(record.link?.admitted ?? []).map(edge => edge.targetNotePath), ...(record.link?.dropped ?? []).filter(edge => edge.reason === 'nonpositive_similarity').map(edge => edge.targetNotePath)];
    if (record.operation !== 'link' || record.authorization.origin !== 'clio' || !closed(value, ['version', 'candidateSet', 'sourceRevision', 'spaceId', 'indexGeneration', 'createdAt', 'expiresAt', 'targets']) || value.version !== 1 || !uuid(value.candidateSet) || value.candidateSet !== record.link.candidateSet || !hash(value.sourceRevision) || !hash(value.spaceId) || !Number.isSafeInteger(value.indexGeneration) || value.indexGeneration < 0 || !date(value.createdAt) || !date(value.expiresAt) || Date.parse(value.expiresAt) <= Date.parse(value.createdAt) || !Array.isArray(value.targets) || value.targets.length !== selected.length) refuse('JOURNAL_CORRUPT', 'Frozen semantic admission has an invalid identity.');
    if (record.files.find(file => file.path === record.source)?.before !== value.sourceRevision || new Set(value.targets.map(target => target?.path)).size !== value.targets.length) refuse('JOURNAL_CORRUPT', 'Frozen semantic admission has inconsistent source or targets.');
    for (const target of value.targets) if (!closed(target, ['path', 'revision', 'bestDistance', 'sourceEvidence', 'targetEvidence']) || !notePath(target.path) || !hash(target.revision) || !Number.isFinite(target.bestDistance) || target.bestDistance < 0 || target.bestDistance > 2 || !evidence(target.sourceEvidence) || !evidence(target.targetEvidence) || target.sourceEvidence.path !== record.source || target.sourceEvidence.revision !== value.sourceRevision || target.targetEvidence.path !== target.path || target.targetEvidence.revision !== target.revision || !selected.includes(target.path) || record.link.admitted.some(edge => edge.targetNotePath === target.path) !== (target.bestDistance < 1) || !record.reads.some(read => read.path === target.path && read.revision === target.revision)) refuse('JOURNAL_CORRUPT', 'Frozen semantic evidence is invalid or differs from its dependency.');
  } else if (record.operation === 'link' && record.authorization.origin === 'clio') refuse('JOURNAL_CORRUPT', 'Clio link admission lacks its frozen evidence.');
}
