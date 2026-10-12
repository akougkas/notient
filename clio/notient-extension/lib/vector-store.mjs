import { openSync, closeSync, fstatSync, lstatSync, existsSync, fsyncSync, ftruncateSync, readSync, writeSync, constants } from 'node:fs';
import path from 'node:path';
import { openIndex } from './index.mjs';
import { readConfig, indexPath } from './config.mjs';
import { withIndexWriter } from './index-lock.mjs';
import { embeddingSpace, embeddingInput, configuredEmbedding } from './embedding-config.mjs';
import { quantizeVector, reconstructedVector } from './vector-math.mjs';
import { revision, refuse, readNote } from './paths.mjs';
import { syncDirectory } from './journal.mjs';
import { scanBudget } from './retrieval-evidence.mjs';

const maxPackBytes = 1024 * 1024 * 1024;
export const metaValue = (db, key) => db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null;
export const setMeta = (db, key, value) => db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, String(value));

export function* vectorChunks(db, profile, { sourcePath, workspace, path: exact } = {}) {
  const rows = db.prepare(`SELECT c.*,n.revision,n.outline,ROW_NUMBER() OVER (PARTITION BY c.path ORDER BY c.id)-1 AS ordinal
    FROM chunks c JOIN notes n ON n.path=c.path JOIN blocks b ON b.id=c.block
    WHERE b.kind!='heading' AND (? IS NULL OR c.path!=?) AND (? IS NULL OR c.path=?)
    AND (? IS NULL OR EXISTS (SELECT 1 FROM note_workspaces w WHERE w.path=c.path AND w.workspace=?)) ORDER BY c.path,c.id`).iterate(sourcePath ?? null, sourcePath ?? null, exact ?? null, exact ?? null, workspace ?? null, workspace ?? null);
  for (const row of rows) {
    let input;
    try { input = embeddingInput(profile, row.passage); }
    catch (error) { if (error.code !== 'EMBEDDING_INPUT_LIMIT') throw error; yield { ...row, eligible: false, textHash: revision(row.passage) }; continue; }
    yield { ...row, eligible: true, input, textHash: revision(row.passage) };
  }
}

export function vectorMetadata(db, space, chunk) {
  const row = db.prepare('SELECT * FROM vec_meta WHERE space_id=? AND chunk_id=?').get(space.space_id, chunk.id);
  if (!row || row.path !== chunk.path || row.revision !== chunk.revision || row.text_hash !== chunk.textHash) return null;
  if (row.model !== space.model || row.dim !== space.dim || !Number.isSafeInteger(row.slot) || row.slot < 0 || row.slot >= space.pack_slots || !Number.isFinite(row.scale) || row.scale <= 0) refuse('VECTOR_PACK_INVALID', 'Vector metadata is inconsistent with its committed pack.');
  return row;
}

function packPrefix(space) {
  const size = space.pack_slots * space.dim;
  if (!Number.isSafeInteger(space.pack_slots) || space.pack_slots < 0 || !Number.isSafeInteger(space.generation) || space.generation < 1 || !Number.isSafeInteger(size) || size > maxPackBytes || space.pack_file !== `vectors.${space.space_id}.${space.generation}.i8`) refuse('VECTOR_PACK_INVALID', 'Vector pack identity or committed size is invalid.');
  return size;
}

function openPack(directory, vault, space, writable = false) {
  const prefix = packPrefix(space); const filename = path.join(path.dirname(indexPath(directory, vault)), space.pack_file);
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) refuse('VECTOR_PACK_INVALID', 'Vector packs must be ordinary private files.');
  const fd = openSync(filename, (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW);
  const opened = fstatSync(fd);
  if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size < prefix) { closeSync(fd); refuse('VECTOR_PACK_INVALID', 'The vector pack is shorter than its committed prefix.'); }
  return { fd, prefix };
}

function verifySpace(space, profile) {
  if (space.space_id !== embeddingSpace(profile) || space.provider !== 'openai-compatible' || space.model !== profile.model || space.response_model !== profile.responseModel || space.dim !== profile.dimension) refuse('VECTOR_PACK_INVALID', 'The vector space does not match the configured identity.');
}

function counts(db, profile, space) {
  let eligible = 0; let embedded = 0; let skipped = 0;
  for (const chunk of vectorChunks(db, profile)) {
    if (!chunk.eligible) { skipped++; continue; }
    eligible++; if (space && vectorMetadata(db, space, chunk)) embedded++;
  }
  return { eligible, embedded, missing: eligible - embedded, skipped };
}

export function vectorState(vault, directory, { db: supplied } = {}) {
  const config = readConfig(directory); const selected = config.vaults.find(value => value.id === vault.id && value.path === vault.path);
  const result = configuredEmbedding(config, selected ?? { embeddings: false });
  if (result.state === 'off') return result;
  let db = supplied;
  try {
    db ??= openIndex(directory, vault);
    if (!db || db.prepare('PRAGMA user_version').get().user_version !== 2) return result;
    const space = db.prepare('SELECT * FROM vector_spaces WHERE space_id=?').get(result.spaceId);
    const active = metaValue(db, 'activeSpace');
    Object.assign(result, counts(db, config.embeddings, space));
    if (!space) { result.state = active ? 'stale-model' : 'building'; return result; }
    verifySpace(space, config.embeddings);
    if (space.state === 'stale-model') { result.state = 'stale-model'; return result; }
    if (space.pack_file) { const { fd } = openPack(directory, vault, space); closeSync(fd); }
    result.state = active !== result.spaceId || !space.pack_file ? 'building' : result.missing || result.skipped ? 'incomplete' : 'ready';
    if (space.state === 'unavailable') result.state = 'unavailable';
    return result;
  } catch { return { ...result, state: 'unavailable' }; }
  finally { if (!supplied) db?.close(); }
}

export function openVectorSnapshot(vault, directory, profile, { allowBuilding = false } = {}) {
  const db = openIndex(directory, vault); let fd; let closed = false;
  try {
    if (!db) refuse('VECTOR_PACK_UNAVAILABLE', 'A structural index is required.');
    db.exec('BEGIN');
    const id = embeddingSpace(profile); const space = db.prepare('SELECT * FROM vector_spaces WHERE space_id=?').get(id);
    if (!space || !space.pack_file || !allowBuilding && metaValue(db, 'activeSpace') !== id || !(allowBuilding ? ['building', 'ready', 'incomplete', 'unavailable'] : ['ready', 'incomplete']).includes(space.state)) refuse('VECTOR_PACK_UNAVAILABLE', 'No usable pack matches the configured vector space.');
    verifySpace(space, profile);
    ({ fd } = openPack(directory, vault, space));
    const packed = metadata => {
      if (metadata.space_id !== id || metadata.model !== profile.model || metadata.dim !== profile.dimension || !Number.isSafeInteger(metadata.slot) || metadata.slot < 0 || metadata.slot >= space.pack_slots) refuse('VECTOR_PACK_INVALID', 'A vector offset is outside the committed pack.');
      const bytes = Buffer.alloc(space.dim); let got = 0;
      while (got < bytes.length) { const read = readSync(fd, bytes, got, bytes.length - got, metadata.slot * space.dim + got); if (!read) refuse('VECTOR_PACK_INVALID', 'A vector pack read was short.'); got += read; }
      return bytes;
    };
    const vector = metadata => reconstructedVector(packed(metadata), metadata.scale, space.dim);
    return { db, space, packed, vector, chunks: options => vectorChunks(db, profile, options), metadata: chunk => vectorMetadata(db, space, chunk), close() { if (closed) return; closed = true; if (fd !== undefined) { closeSync(fd); fd = undefined; } if (db.isTransaction) db.exec('ROLLBACK'); db.close(); } };
  } catch (error) { if (fd !== undefined) closeSync(fd); if (db?.isTransaction) db.exec('ROLLBACK'); db?.close(); throw error; }
}

function spaceRow(db, profile) {
  const id = embeddingSpace(profile); const active = metaValue(db, 'activeSpace');
  if (active && active !== id) db.prepare("UPDATE vector_spaces SET state='stale-model' WHERE space_id=?").run(active);
  db.prepare(`INSERT OR IGNORE INTO vector_spaces(space_id,provider,model,response_model,dim,state,corpus_generation,created_at) VALUES (?,?,?,?,?,'building',?,?)`).run(id, 'openai-compatible', profile.model, profile.responseModel, profile.dimension, Number(metaValue(db, 'indexGeneration') ?? 0), new Date().toISOString());
  return db.prepare('SELECT * FROM vector_spaces WHERE space_id=?').get(id);
}

function nextPack(directory, vault, space) {
  const root = path.dirname(indexPath(directory, vault)); let generation = space.generation + 1;
  while (existsSync(path.join(root, `vectors.${space.space_id}.${generation}.i8`))) { generation++; if (!Number.isSafeInteger(generation)) refuse('VECTOR_PACK_LIMIT', 'Vector generation exceeds its numeric bound.'); }
  const pack_file = `vectors.${space.space_id}.${generation}.i8`;
  const fd = openSync(path.join(root, pack_file), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  return { fd, space: { ...space, generation, pack_file, pack_slots: 0 }, root };
}

function writeAll(fd, bytes, position) {
  let written = 0;
  while (written < bytes.length) { const amount = writeSync(fd, bytes, written, bytes.length - written, position + written); if (!amount) refuse('VECTOR_PACK_UNAVAILABLE', 'Vector pack write made no progress.'); written += amount; }
}

function activate(db, profile, space) {
  const measured = counts(db, profile, space);
  const active = metaValue(db, 'activeSpace') === space.space_id;
  const state = !space.pack_file ? 'building' : measured.missing ? active ? 'incomplete' : 'building' : measured.skipped ? 'incomplete' : 'ready';
  db.prepare('UPDATE vector_spaces SET state=?,corpus_generation=? WHERE space_id=?').run(state, Number(metaValue(db, 'indexGeneration') ?? 0), space.space_id);
  if (!measured.missing && space.pack_file) { setMeta(db, 'activeSpace', space.space_id); setMeta(db, 'activeGeneration', space.generation); }
  return measured;
}

export function publishVectors(vault, directory, profile, chunks, vectors, { barrier = () => {}, sync = syncDirectory } = {}) {
  if (chunks.length !== vectors.length || chunks.length > 32) refuse('VECTOR_INVALID', 'Vector publication requires one bounded batch with aligned inputs.');
  const packed = vectors.map(vector => quantizeVector(vector, profile.dimension));
  return withIndexWriter(vault, directory, () => {
    const config = readConfig(directory); const selected = config.vaults.find(value => value.id === vault.id && value.path === vault.path);
    if (!selected?.embeddings || !config.embeddings || JSON.stringify(config.embeddings) !== JSON.stringify(profile)) refuse('EMBEDDING_CONFIG_CHANGED', 'Embedding configuration changed before publication.', [], true);
    const db = openIndex(directory, vault, true); let fd;
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      let space = spaceRow(db, profile);
      if (space.state === 'stale-model') refuse('EMBEDDING_STALE_MODEL', 'The operator must re-probe the stale profile before embedding refresh.');
      const live = new Map();
      const selectedChunks = chunks.flatMap((chunk, ordinal) => {
        const current = db.prepare('SELECT c.*,n.revision FROM chunks c JOIN notes n ON n.path=c.path WHERE c.id=?').get(chunk.id);
        if (!current || current.path !== chunk.path || current.revision !== chunk.revision || revision(current.passage) !== chunk.textHash) return [];
        if (!live.has(chunk.path)) { try { live.set(chunk.path, readNote(vault.path, chunk.path).revision); } catch { live.set(chunk.path, null); } }
        return live.get(chunk.path) === chunk.revision ? [{ chunk, packed: packed[ordinal] }] : [];
      });
      if (!selectedChunks.length && chunks.length) return { published: 0, discarded: chunks.length, warnings: [] };
      let root = path.dirname(indexPath(directory, vault)); let prefix;
      if (space.pack_file === null) { const created = nextPack(directory, vault, space); fd = created.fd; space = created.space; prefix = 0; }
      else { const opened = openPack(directory, vault, space, true); fd = opened.fd; prefix = opened.prefix; ftruncateSync(fd, prefix); }
      const nextSlots = space.pack_slots + selectedChunks.length;
      if (nextSlots * space.dim > maxPackBytes) refuse('VECTOR_PACK_LIMIT', 'The committed active pack cannot exceed 1 GiB; use explicit generation rebuild.');
      selectedChunks.forEach((item, index) => writeAll(fd, item.packed.bytes, prefix + index * space.dim));
      barrier('afterAppend'); fsyncSync(fd); const durable = sync(root); barrier('afterFsync');
      db.exec('BEGIN IMMEDIATE');
      const insert = db.prepare('INSERT OR REPLACE INTO vec_meta VALUES (?,?,?,?,?,?,?,?,?)');
      selectedChunks.forEach((item, index) => insert.run(space.space_id, item.chunk.id, item.chunk.path, item.chunk.revision, item.chunk.textHash, space.pack_slots + index, item.packed.scale, profile.model, profile.dimension));
      space.pack_slots = nextSlots;
      db.prepare('UPDATE vector_spaces SET pack_file=?,pack_slots=?,generation=? WHERE space_id=?').run(space.pack_file, space.pack_slots, space.generation, space.space_id);
      activate(db, profile, space); db.exec('COMMIT'); barrier('afterSQLCommit');
      return { published: selectedChunks.length, discarded: chunks.length - selectedChunks.length, warnings: durable ? [] : [{ code: 'DIRECTORY_FSYNC_UNAVAILABLE', message: 'The vector file is synced; directory fsync is unavailable.' }] };
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    finally { if (fd !== undefined) closeSync(fd); db.close(); }
  });
}

export function markVectorFailure(vault, directory, profile, code, retryable) {
  return withIndexWriter(vault, directory, () => {
    const config = readConfig(directory);
    if (!config.vaults.find(value => value.id === vault.id && value.path === vault.path)?.embeddings || JSON.stringify(config.embeddings) !== JSON.stringify(profile)) return;
    const db = openIndex(directory, vault, true);
    try {
      db.exec('BEGIN IMMEDIATE'); const space = spaceRow(db, profile);
      db.prepare('UPDATE vector_spaces SET state=? WHERE space_id=?').run(code === 'EMBEDDING_STALE_MODEL' ? 'stale-model' : 'unavailable', space.space_id);
      setMeta(db, 'embeddingFailure', JSON.stringify({ spaceId: space.space_id, code: /^EMBEDDING_[A-Z_]+$/.test(code) ? code : 'EMBEDDING_UNAVAILABLE', retryable: Boolean(retryable), at: new Date().toISOString() }));
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    finally { db.close(); }
  });
}

export function verifyVectorConfiguration(vault, directory, profile) {
  if (!existsSync(indexPath(directory, vault))) return;
  return withIndexWriter(vault, directory, () => {
    const config = readConfig(directory);
    if (!config.vaults.find(value => value.id === vault.id && value.path === vault.path)?.embeddings || JSON.stringify(config.embeddings) !== JSON.stringify(profile)) return;
    const db = openIndex(directory, vault, true);
    try {
      db.exec('BEGIN IMMEDIATE'); const space = spaceRow(db, profile);
      activate(db, profile, space); db.prepare("DELETE FROM meta WHERE key='embeddingFailure'").run(); db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    finally { db.close(); }
  });
}

export function rebuildVectorGeneration(vault, directory, profile, { barrier = () => {}, deadline = Infinity, now = () => performance.now(), sync = syncDirectory, maxBufferBytes = 64 * 1024 * 1024 } = {}) {
  return withIndexWriter(vault, directory, () => {
    const config = readConfig(directory);
    if (!config.vaults.find(value => value.id === vault.id)?.embeddings || JSON.stringify(config.embeddings) !== JSON.stringify(profile)) refuse('EMBEDDING_CONFIG_CHANGED', 'Embedding configuration changed before rebuild.', [], true);
    const snapshot = openVectorSnapshot(vault, directory, profile); let fd; let db;
    try {
      const created = nextPack(directory, vault, snapshot.space); fd = created.fd;
      const metadata = []; const memory = scanBudget('VECTOR_REBUILD_LIMIT', maxBufferBytes); let slots = 0;
      for (const chunk of snapshot.chunks()) {
        if (now() >= deadline) refuse('VECTOR_REBUILD_TIMEOUT', 'Vector generation rebuild exceeded its deadline.', [], true);
        if (!chunk.eligible) continue;
        const row = snapshot.metadata(chunk); if (!row) refuse('VECTOR_SOURCE_MISSING', 'Complete eligible vectors are required before rebuilding a generation.');
        snapshot.vector(row);
        const packed = { bytes: snapshot.packed(row), scale: row.scale };
        if ((slots + 1) * profile.dimension > maxPackBytes) refuse('VECTOR_PACK_LIMIT', 'The rebuilt active pack cannot exceed 1 GiB.');
        const retained = { ...row, slot: slots++, scale: packed.scale }; memory.add(retained); metadata.push(retained);
        writeAll(fd, packed.bytes, retained.slot * profile.dimension);
      }
      barrier('afterAppend'); fsyncSync(fd); const durable = sync(created.root); barrier('afterFsync');
      snapshot.close(); db = openIndex(directory, vault, true); db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
      db.prepare('DELETE FROM vec_meta WHERE space_id=?').run(created.space.space_id);
      const insert = db.prepare('INSERT INTO vec_meta VALUES (?,?,?,?,?,?,?,?,?)');
      for (const row of metadata) insert.run(row.space_id, row.chunk_id, row.path, row.revision, row.text_hash, row.slot, row.scale, row.model, row.dim);
      db.prepare('UPDATE vector_spaces SET pack_file=?,pack_slots=?,generation=? WHERE space_id=?').run(created.space.pack_file, slots, created.space.generation, created.space.space_id);
      activate(db, profile, { ...created.space, pack_slots: slots }); db.exec('COMMIT'); barrier('afterSQLCommit');
      return { generation: created.space.generation, slots, reused: slots, warnings: durable ? [] : [{ code: 'DIRECTORY_FSYNC_UNAVAILABLE', message: 'The vector file is synced; directory fsync is unavailable.' }] };
    } catch (error) { if (db?.isTransaction) db.exec('ROLLBACK'); throw error; }
    finally { if (fd !== undefined) closeSync(fd); snapshot.close(); db?.close(); }
  });
}
