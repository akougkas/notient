import { readdirSync } from 'node:fs';
import path from 'node:path';
import { readNote, revision, refuse } from './paths.mjs';

export function inventoryHash(root) {
  const names = [];
  function visit(relative) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) names.push(name);
    }
  }
  visit(''); return revision(JSON.stringify(names.sort()));
}

export function evidenceFor(vault, chunk, files = new Map()) {
  if (!files.has(chunk.path)) files.set(chunk.path, readNote(vault.path, chunk.path));
  const current = files.get(chunk.path); const source = JSON.parse(chunk.source); const headingPath = JSON.parse(chunk.heading);
  if (current.revision !== chunk.revision || chunk.passage.length > 1200 || !Number.isSafeInteger(source.startByte) || !Number.isSafeInteger(source.endByte) || source.startByte < 0 || source.endByte > current.bytes.length || source.endByte < source.startByte || current.bytes.subarray(source.startByte, source.endByte).toString('utf8') !== chunk.passage) refuse('EVIDENCE_CHANGED', 'The raw revision or literal evidence slice changed.', [chunk.path], true);
  return { path: chunk.path, revision: chunk.revision, headingPath, source, passage: chunk.passage };
}
