import { openGarden, queueCounts } from './garden-store.mjs';
import { currentFile } from './paths.mjs';

export function gardenStatus(vault, directory) {
  const db = openGarden(directory, vault);
  if (!db) return { configured: false, queue: null, runs: [], owned: [], proposals: [] };
  try {
    return { configured: true, queue: queueCounts(db), poison: db.prepare("SELECT key,path,revision,attempts,lastError FROM queue WHERE state='poison' ORDER BY enqueuedAt,path LIMIT 10").all(), runs: db.prepare('SELECT id,state,batch,startedAt,deadline,counters FROM runs ORDER BY startedAt DESC,id LIMIT 10').all(), owned: db.prepare('SELECT * FROM owned ORDER BY path').all().slice(0, 100).map(row => {
      let actual; try { actual = currentFile(vault.path, row.path).revision; } catch { actual = 'unreadable'; }
      return { path: row.path, expected: row.lastWrittenRevision, actual, state: actual === row.lastWrittenRevision ? 'current' : 'edited' };
    }), proposals: db.prepare('SELECT * FROM plan_actions ORDER BY proposalId LIMIT 100').all() };
  } finally { db.close(); }
}
