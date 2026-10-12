import { recoverEditAges, movedFiles } from './vitals-index.mjs';
import { currentFile, revision } from './paths.mjs';

export function freezeEditAges(vault, directory, files, now, budget, restoredAges = [], move = null) {
  const notes = files.filter(file => file.role !== 'log');
  const current = new Map(notes.filter(file => file.before !== null).map(file => [file.path, currentFile(vault.path, file.path)]));
  const rows = notes.filter(file => file.before !== null).map(file => ({ path: file.path, revision: revision(file.before), mtime: current.get(file.path).stat.mtimeMs }));
  const ages = recoverEditAges(vault, directory, rows, now, { budget, strictBudget: true });
  const moved = move ? movedFiles({ operation: 'move', ...move, files }) : null;
  const vitalsFallbackPaths = [];
  const vitalsBefore = notes.map(file => {
    const value = file.before !== null ? ages.get(file.path) : moved?.destination.path === file.path ? ages.get(moved.source.path) : restoredAges.find(value => value.path === file.path);
    if (value?.fallback) vitalsFallbackPaths.push(file.path);
    return { path: file.path, lastUserEditMs: value ? Math.min(now, value.at ?? value.lastUserEditMs) : null };
  });
  return { vitalsBefore, vitalsFallbackPaths };
}
