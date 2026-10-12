import { listRecords } from './journal.mjs';
import { createGitAdapter, createGitBudget } from './git.mjs';
import { arithmeticVitals } from './vitals.mjs';

export function graphDegrees(db) {
  const degrees = new Map(db.prepare('SELECT path FROM notes').all().map(row => [row.path, { inbound: new Set(), outbound: new Set() }]));
  for (const row of db.prepare("SELECT path,target_path,payload FROM links WHERE resolution='resolved' AND target_path IS NOT NULL").iterate()) {
    const payload = JSON.parse(row.payload);
    if (payload.kind !== 'wiki' || payload.embed || row.path === row.target_path || !degrees.has(row.path) || !degrees.has(row.target_path)) continue;
    degrees.get(row.path).outbound.add(row.target_path);
    degrees.get(row.target_path).inbound.add(row.path);
  }
  return new Map([...degrees].map(([name, value]) => [name, { inbound: value.inbound.size, outbound: value.outbound.size }]));
}

export function storedVitals(db) {
  return new Map(db.prepare('SELECT * FROM note_vitals').all().map(row => [row.path, row]));
}

export function recoverEditAges(vault, directory, rows, now) {
  const result = new Map(rows.map(row => [row.path, { at: Math.min(now, row.mtime), fallback: false }]));
  if (!rows.length) return result;
  try {
    const records = listRecords(directory, vault, false).filter(record => record.git.commit && record.state !== 'aborted');
    if (!records.length) return result;
    const budget = createGitBudget();
    const order = budget.call(vault.path, ['rev-list', '--first-parent', 'HEAD']).split('\n');
    const positions = new Map(order.map((oid, index) => [oid, index]));
    const history = records.filter(record => positions.has(record.git.commit)).sort((a, b) => positions.get(a.git.commit) - positions.get(b.git.commit));
    const adapter = createGitAdapter(vault, directory, { budget });
    const verified = new Set();
    const verify = record => { if (!verified.has(record.id)) { adapter.verify(record); verified.add(record.id); } };
    for (const row of rows) {
      const latest = history.find(record => record.files.some(file => file.role === 'note' && file.path === row.path));
      const file = latest?.files.find(file => file.role === 'note' && file.path === row.path);
      if (!file || file.after !== row.revision) { result.get(row.path).fallback = false; continue; }
      result.get(row.path).fallback = true;
      if (budget.call(vault.path, ['rev-list', '--first-parent', '-1', 'HEAD', '--', row.path]) !== latest.git.commit) continue;
      let name = row.path;
      let after = row.revision;
      for (const record of history.slice(history.indexOf(latest))) {
        const changed = record.files.find(file => file.role === 'note' && file.path === name);
        if (!changed) continue;
        if (changed.after !== after) break;
        verify(record);
        const frozen = record.version === 2 ? record.vitalsBefore.find(value => value.path === name)?.lastUserEditMs : null;
        if (Number.isFinite(frozen)) { result.set(row.path, { at: Math.min(now, frozen), fallback: false }); break; }
        if (record.operation === 'capture' && changed.before === null) { result.set(row.path, { at: Math.min(now, Date.parse(record.createdAt)), fallback: false }); break; }
        if (changed.before === null) {
          const prior = record.files.find(file => file.role === 'note' && file.after === null && file.before === changed.after);
          if (!prior) break;
          name = prior.path; after = prior.before;
        } else after = changed.before;
      }
    }
  } catch { for (const value of result.values()) value.fallback = true; }
  return result;
}

export function installVitals(db, vault, directory, previous, metrics, now, { advance = false, rebuild = false, record = null } = {}) {
  const rows = db.prepare('SELECT path,revision,mtime FROM notes').all();
  const missing = rows.filter(row => previous.get(row.path)?.revision !== row.revision && !record?.files.some(file => file.role === 'note' && file.path === row.path && file.after === row.revision));
  const recovered = recoverEditAges(vault, directory, missing, now);
  const graph = graphDegrees(db);
  const put = db.prepare('INSERT OR REPLACE INTO note_vitals VALUES (?,?,?,?,?,?)');
  const fallback = new Set(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='editAgeFallbackPaths'").get()?.value ?? '[]').filter(name => rows.some(row => row.path === name)));
  for (const row of rows) {
    let old = previous.get(row.path);
    let provenance = null;
    const published = record?.files.find(file => file.role === 'note' && file.path === row.path && file.after === row.revision);
    if (published) {
      const moved = record.files.find(file => file.role === 'note' && file.after === null && file.before === published.after);
      const candidate = previous.get(row.path) ?? (moved ? previous.get(moved.path) : null);
      const before = candidate?.revision === (moved?.before ?? published.before) ? candidate : null;
      if (!old && before) old = before;
      const frozen = record.version === 2 ? record.vitalsBefore.find(value => value.path === row.path)?.lastUserEditMs : null;
      const at = record.operation === 'capture' && published.before === null ? Date.parse(record.createdAt) : Number.isFinite(frozen) ? frozen : before?.last_user_edit_ms ?? row.mtime;
      provenance = { at: Math.min(now, at), fallback: !Number.isFinite(frozen) && !before && record.operation !== 'capture' };
    } else if (old?.revision !== row.revision) provenance = recovered.get(row.path) ?? { at: Math.min(now, row.mtime), fallback: true };
    const at = provenance?.at ?? old?.last_user_edit_ms ?? Math.min(now, row.mtime);
    if (provenance) { if (provenance.fallback) fallback.add(row.path); else fallback.delete(row.path); }
    const counts = metrics.get(row.path) ?? (old?.revision === row.revision ? { words: old.word_count, chunkCoverage: old.word_count > 0 ? 1 : 0 } : null);
    if (!counts) continue;
    const values = arithmeticVitals({ ...counts, ...graph.get(row.path), lastUserEditMs: at, maturity: old?.maturity ?? 'raw' }, now, { advance, rebuild });
    put.run(row.path, row.revision, values.words, at, values.maturity, new Date(now).toISOString());
  }
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('editAgeFallbackPaths', ?)").run(JSON.stringify([...fallback].sort()));
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('vitalsInitialized', '1')").run();
}
