import { openIndex } from './index.mjs';
import { readNote, refuse, validText } from './paths.mjs';
import { uniqueJson } from './closed-json.mjs';

export function admitGardenEvidence(vault, directory, evidence) {
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 4) refuse('GARDEN_EVIDENCE_REQUIRED', 'Provide one to four served evidence quotations.');
  const db = openIndex(directory, vault, false, { immutable: true });
  try {
    if (!db) refuse('GARDEN_EVIDENCE_REQUIRED', 'Search must serve the evidence before proposal admission.');
    return evidence.map(value => {
      if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'endLine,path,quote,revision,startLine' || typeof value.path !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision ?? '') || !Number.isSafeInteger(value.startLine) || !Number.isSafeInteger(value.endLine) || value.startLine < 1 || value.endLine < value.startLine || typeof value.quote !== 'string' || !validText(value.quote).length || value.quote.length > 1200 || /^Notient\/(?:Log|Plans|Digest)\//.test(value.path)) refuse('GARDEN_EVIDENCE_REQUIRED', 'Evidence requires a bounded quotation, exact revision and line range.');
      const live = readNote(vault.path, value.path);
      if (live.revision !== value.revision) refuse('EVIDENCE_CHANGED', 'Proposal evidence changed since it was served.', [value.path], true);
      const witnesses = db.prepare('SELECT source,passage FROM served WHERE path=? AND revision=?').all(value.path, value.revision);
      const witnessed = witnesses.some(row => {
        const first = row.passage.indexOf(value.quote);
        if (first < 0 || row.passage.indexOf(value.quote, first + 1) >= 0) return false;
        const source = JSON.parse(row.source); const startByte = source.startByte + Buffer.byteLength(row.passage.slice(0, first)); const endByte = startByte + Buffer.byteLength(value.quote);
        return live.bytes.subarray(source.startByte, source.endByte).toString('utf8') === row.passage && live.bytes.subarray(startByte, endByte).toString('utf8') === value.quote && live.bytes.subarray(0, startByte).toString('utf8').split('\n').length === value.startLine && live.bytes.subarray(0, endByte - (value.quote.endsWith('\n') ? 1 : 0)).toString('utf8').split('\n').length === value.endLine;
      });
      if (!witnessed) refuse('GARDEN_EVIDENCE_REQUIRED', 'The unique quotation and line range must occur in an actually served search window.', [value.path]);
      return value;
    });
  } finally { db?.close(); }
}

export function manualFinding(vault, directory, text) {
  if (typeof text !== 'string' || text.length < 2 || text.length > 8000) refuse('INVALID_INPUT', 'Manual findings have a bounded JSON input.');
  const value = uniqueJson(text);
  if (!value || Object.keys(value).sort().join(',') !== 'evidence,kind,reason' || value.kind !== 'manual-only' || typeof value.reason !== 'string' || !validText(value.reason).trim() || value.reason.length > 1000) refuse('INVALID_INPUT', 'A manual finding has closed kind, reason and evidence fields.');
  return { ...value, evidence: admitGardenEvidence(vault, directory, value.evidence) };
}
