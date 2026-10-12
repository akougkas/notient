import { openIndex } from './index.mjs';
import { recoverEditAges, movedFiles } from './vitals-index.mjs';
import { currentFile, revision } from './paths.mjs';

export function freezeEditAges(vault, directory, files, now, budget, baseHead, restoredAges = [], move = null) {
  const notes = files.filter(file => file.role !== 'log');
  const current = new Map(notes.filter(file => file.before !== null).map(file => [file.path, currentFile(vault.path, file.path)]));
  const ages = new Map();
  let db;
  try {
    db = openIndex(directory, vault);
    if (db?.prepare('PRAGMA user_version').get().user_version === 2) {
      const cachedHead = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='lastCommit'").get()?.value ?? 'null')?.hash;
      for (const file of notes) {
        if (file.before === null) continue;
        const cached = db.prepare('SELECT * FROM note_vitals WHERE path=?').get(file.path);
        if (cached?.revision !== revision(file.before) || !cachedHead || !baseHead) continue;
        if (cachedHead !== baseHead && budget.call(vault.path, ['rev-list', '--first-parent', '-1', baseHead, '--', file.path]) !== budget.call(vault.path, ['rev-list', '--first-parent', '-1', cachedHead, '--', file.path])) continue;
        ages.set(file.path, Math.min(now, cached.last_user_edit_ms));
      }
    }
  } catch (error) { if (error.code === 'GIT_TIMEOUT') throw error; }
  finally { db?.close(); }
  const missing = notes.filter(file => file.before !== null && !ages.has(file.path)).map(file => ({ path: file.path, revision: revision(file.before), mtime: current.get(file.path).stat.mtimeMs }));
  for (const [name, value] of recoverEditAges(vault, directory, missing, now, { budget, strictBudget: true })) ages.set(name, value.at);
  const moved = move ? movedFiles({ operation: 'move', ...move, files }) : null;
  return notes.map(file => {
    const restored = restoredAges.find(value => value.path === file.path)?.lastUserEditMs;
    return { path: file.path, lastUserEditMs: file.before === null ? moved?.destination.path === file.path ? ages.get(moved.source.path) ?? null : Number.isFinite(restored) ? Math.min(now, restored) : null : ages.get(file.path) ?? Math.min(now, current.get(file.path).stat.mtimeMs) };
  });
}
