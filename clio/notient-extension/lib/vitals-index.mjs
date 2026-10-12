import { listRecords, readRecord } from './journal.mjs';
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

export function movedFiles(record) {
  if (record?.operation !== 'move') return null;
  const source = record.files.find(file => file.role === 'note' && file.path === record.source && file.before !== null && file.after === null);
  const destination = record.files.find(file => file.role === 'note' && file.path === record.destination && file.before === null && file.after !== null);
  return source && destination ? { source, destination } : null;
}

export function inverseOrigins(record, previous, originals) {
  const origins = new Map(record.files.filter(file => file.role === 'note' && file.before !== null).map(file => [file.path, previous(file)]));
  if (record.operation === 'undo') for (const original of originals) {
    const moved = movedFiles(original);
    if (!moved) continue;
    const value = origins.get(moved.destination.path); origins.delete(moved.destination.path);
    if (value !== undefined) origins.set(moved.source.path, value);
  }
  return origins;
}

export function recoverEditAges(vault, directory, rows, now, { budget = createGitBudget(), strictBudget = false } = {}) {
  const result = new Map(rows.map(row => [row.path, { at: Math.min(now, row.mtime), fallback: false }]));
  if (!rows.length) return result;
  try {
    const records = listRecords(directory, vault, false, { legacyObservations: true }).filter(record => record.git.commit && record.state !== 'aborted');
    if (!records.length) return result;
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
      let name = row.path;
      let after = row.revision;
      let head = 'HEAD';
      for (const record of history.slice(history.indexOf(latest))) {
        const changed = record.files.find(file => file.role === 'note' && file.path === name);
        if (!changed) continue;
        if (changed.after !== after || budget.call(vault.path, ['rev-list', '--first-parent', '-1', head, '--', name]) !== record.git.commit) break;
        verify(record);
        const frozen = record.version >= 2 ? record.vitalsBefore.find(value => value.path === name)?.lastUserEditMs : null;
        if (Number.isFinite(frozen)) { result.set(row.path, { at: Math.min(now, frozen), fallback: record.vitalsFallbackPaths?.includes(name) ?? false }); break; }
        if (record.operation === 'capture' && changed.before === null) { result.set(row.path, { at: Math.min(now, Date.parse(record.createdAt)), fallback: false }); break; }
        if (changed.before === null || record.operation === 'undo') {
          const moved = movedFiles(record);
          const originals = record.operation === 'undo' ? record.undo.targets.map(id => { const original = readRecord(directory, vault, id, false); verify(original); return original; }) : [];
          const origin = moved?.destination.path === name ? moved.source.path : inverseOrigins(record, file => file.path, originals).get(name);
          const prior = record.files.find(file => file.role === 'note' && file.path === origin && file.before !== null && (record.operation === 'undo' || file.after === null));
          if (!prior) break;
          name = prior.path; after = prior.before;
        } else after = changed.before;
        head = record.git.baseHead;
        if (head === null) break;
      }
    }
  } catch (error) { if (error.code === 'JOURNAL_CORRUPT' || strictBudget && error.code === 'GIT_TIMEOUT') throw error; for (const value of result.values()) value.fallback = true; }
  return result;
}

export function installVitals(db, vault, directory, previous, metrics, now, { advance = false, rebuild = false, record = null, promotionEpoch, promotionLimit = Infinity } = {}) {
  const rows = db.prepare('SELECT path,revision,mtime FROM notes').all();
  const missing = rows.filter(row => previous.get(row.path)?.revision !== row.revision && !record?.files.some(file => file.role === 'note' && file.path === row.path && file.after === row.revision));
  const recovered = recoverEditAges(vault, directory, missing, now);
  const graph = graphDegrees(db);
  const put = db.prepare('INSERT OR REPLACE INTO note_vitals VALUES (?,?,?,?,?,?)');
  const inverse = record?.operation === 'undo' ? inverseOrigins(record, file => { const value = previous.get(file.path); return value?.revision === file.before ? value : undefined; }, record.undo.targets.map(id => readRecord(directory, vault, id, false))) : new Map();
  const fallback = new Set(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='editAgeFallbackPaths'").get()?.value ?? '[]').filter(name => rows.some(row => row.path === name)));
  const epoch = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='gardenPromotions'").get()?.value ?? 'null');
  const advanced = new Set(epoch && epoch.runId === promotionEpoch ? epoch.paths : []);
  const selected = new Set(rows.filter(row => !advanced.has(row.path)).sort((a, b) => (metrics.get(b.path)?.words ?? previous.get(b.path)?.word_count ?? 0) - (metrics.get(a.path)?.words ?? previous.get(a.path)?.word_count ?? 0) || a.path.localeCompare(b.path)).slice(0, Math.max(0, promotionLimit - advanced.size)).map(row => row.path));
  let promoted = 0;
  for (const row of rows) {
    let old = previous.get(row.path);
    let provenance = null;
    const published = record?.files.find(file => file.role === 'note' && file.path === row.path && file.after === row.revision);
    if (published) {
      const restored = inverse.get(row.path);
      if (restored) old = restored;
      const pair = movedFiles(record);
      const moved = pair?.destination.path === row.path ? pair.source : null;
      const candidate = previous.get(row.path) ?? (moved ? previous.get(moved.path) : null);
      const before = restored ?? (candidate?.revision === (moved?.before ?? published.before) ? candidate : null);
      if (!old && before) old = before;
      if (!old && published.before === null && inverse.has(row.path)) old = inverse.get(row.path);
      const frozen = record.version >= 2 ? record.vitalsBefore.find(value => value.path === row.path)?.lastUserEditMs : null;
      const at = record.operation === 'capture' && published.before === null ? Date.parse(record.createdAt) : Number.isFinite(frozen) ? frozen : before?.last_user_edit_ms ?? row.mtime;
      provenance = { at: Math.min(now, at), fallback: (record.vitalsFallbackPaths?.includes(row.path) ?? false) || !Number.isFinite(frozen) && !before && record.operation !== 'capture' };
    } else if (old?.revision !== row.revision) provenance = recovered.get(row.path) ?? { at: Math.min(now, row.mtime), fallback: true };
    const at = provenance?.at ?? old?.last_user_edit_ms ?? Math.min(now, row.mtime);
    if (provenance) { if (provenance.fallback) fallback.add(row.path); else fallback.delete(row.path); }
    const counts = metrics.get(row.path) ?? (old?.revision === row.revision ? { words: old.word_count, chunkCoverage: old.word_count > 0 ? 1 : 0 } : null);
    if (!counts) continue;
    const shouldAdvance = advance && (!promotionEpoch || selected.has(row.path));
    const values = arithmeticVitals({ ...counts, ...graph.get(row.path), lastUserEditMs: at, maturity: old?.maturity ?? 'raw' }, now, { advance: shouldAdvance, rebuild: rebuild && (!promotionEpoch || selected.has(row.path)) });
    if (promotionEpoch && shouldAdvance) { advanced.add(row.path); if (values.maturity !== (old?.maturity ?? 'raw')) promoted++; }
    put.run(row.path, row.revision, values.words, at, values.maturity, new Date(now).toISOString());
  }
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('editAgeFallbackPaths', ?)").run(JSON.stringify([...fallback].sort()));
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('vitalsInitialized', '1')").run();
  if (promotionEpoch) db.prepare("INSERT OR REPLACE INTO meta VALUES ('gardenPromotions',?)").run(JSON.stringify({ runId: promotionEpoch, paths: [...advanced] }));
  return promoted;
}
