import { refuse } from './paths.mjs';

const same = (a, b) => a === null ? b === null : b !== null && a.equals(b);

export function simulateUndo(operations, current) {
  const virtual = new Map([...current].map(([name, value]) => [name, { ...value }]));
  for (const operation of operations) for (const file of operation.files) {
    const value = virtual.get(file.path);
    if (!value || !same(value.bytes, file.after)) refuse('UNDO_CONFLICT', 'The virtual reverse step differs from the original after-state.', [file.path]);
    virtual.set(file.path, { bytes: file.before, mode: file.mode });
  }
  const files = [];
  for (const [name, final] of virtual) {
    const initial = current.get(name);
    if (same(initial.bytes, final.bytes) && (initial.bytes === null || initial.mode === final.mode)) continue;
    files.push({ path: name, role: 'note', before: initial.bytes, after: final.bytes, mode: final.mode });
  }
  const rank = file => file.before === null ? 0 : file.after === null ? 2 : 1;
  return files.sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function certifyCancellation(originals, inverse) {
  const initial = new Map();
  const virtual = new Map();
  for (const operation of originals) for (const file of operation.files) {
    if (!initial.has(file.path)) { initial.set(file.path, file.before); virtual.set(file.path, file.before); }
    if (!same(virtual.get(file.path), file.before)) refuse('UNDO_HISTORY_CHANGED', 'A cancelled operation pair has discontinuous original deltas.', [file.path]);
    virtual.set(file.path, file.after);
  }
  for (const file of inverse.files) {
    if (!initial.has(file.path) || !same(virtual.get(file.path), file.before)) refuse('UNDO_HISTORY_CHANGED', 'An inverse is not the exact cancellation of its originals.', [file.path]);
    virtual.set(file.path, file.after);
  }
  for (const [name, bytes] of initial) if (!same(virtual.get(name), bytes)) refuse('UNDO_HISTORY_CHANGED', 'The certified inverse leaves an uncancelled note delta.', [name]);
  return true;
}

export function hydrateOperation(record, read) {
  return { id: record.id, files: record.files.filter(file => file.role === 'note').map(file => ({ ...file, before: file.before === null ? null : read(record.id, file.before), after: file.after === null ? null : read(record.id, file.after) })) };
}
