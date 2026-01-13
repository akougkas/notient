import * as path from "node:path";
import type { FileSystemAdapter } from "obsidian";
import type { Kysely } from "kysely";
import type { StoragePaths } from "../../services/storagePaths";
import { generateId } from "../ids";
import type { Database } from "./schema";

export async function migrateJsonToSqlite(
  db: Kysely<Database>,
  adapter: FileSystemAdapter,
  paths: StoragePaths,
): Promise<void> {
  const { count } = await db
    .selectFrom("notes")
    .select(db.fn.count("path").as("count"))
    .executeTakeFirstOrThrow();
  if (Number(count) > 0) return; // Already populated

  console.log("[Migration] Starting JSON to SQLite migration...");

  await migrateConversations(db, adapter, paths);
  await migrateActions(db, adapter, paths);
  await migrateIndex(db, adapter, paths);
}

async function migrateConversations(
  db: Kysely<Database>,
  adapter: FileSystemAdapter,
  paths: StoragePaths,
): Promise<void> {
  const convPath = paths.legacyConversations;
  if (!(await adapter.exists(convPath))) return;

  try {
    console.log("[Migration] Migrating conversations...");
    const content = await adapter.read(convPath);
    const data = JSON.parse(content);

    // biome-ignore lint/suspicious/noExplicitAny: Legacy JSON
    const rows: any[] = [];
    for (const [_, conv] of Object.entries(data)) {
      // @ts-ignore
      for (const msg of conv.messages || []) {
        rows.push({
          id: msg.id || generateId("msg"),
          note_path: null,
          role: msg.role,
          content: msg.content,
          thinking: msg.thinking || null,
          created_at: msg.timestamp || Date.now(),
        });
      }
    }

    if (rows.length > 0) {
      const chunkSize = 100;
      for (let i = 0; i < rows.length; i += chunkSize) {
        await db
          .insertInto("messages")
          .values(rows.slice(i, i + chunkSize))
          .execute();
      }
    }

    await adapter.rename(convPath, `${convPath}.backup`);
  } catch (e) {
    console.error("[Migration] Failed to migrate conversations:", e);
  }
}

async function migrateActions(
  db: Kysely<Database>,
  adapter: FileSystemAdapter,
  paths: StoragePaths,
): Promise<void> {
  const actPath = paths.legacyActions;
  if (!(await adapter.exists(actPath))) return;

  try {
    console.log("[Migration] Migrating actions...");
    const content = await adapter.read(actPath);
    const data = JSON.parse(content);

    const actions = data.past || [];
    // biome-ignore lint/suspicious/noExplicitAny: Legacy JSON
    const rows = actions.map((a: any) => ({
      id: a.id || generateId("act"),
      task_id: a.taskId || null,
      type: a.type,
      risk: "low",
      note_path: a.notePath || null,
      created_at: a.timestamp || Date.now(),
      applied_at: a.timestamp || Date.now(),
      undone_at: null,
      payload: JSON.stringify(a.payload || {}),
    }));

    if (rows.length > 0) {
      const chunkSize = 100;
      for (let i = 0; i < rows.length; i += chunkSize) {
        await db
          .insertInto("actions")
          .values(rows.slice(i, i + chunkSize))
          .execute();
      }
    }

    await adapter.rename(actPath, `${actPath}.backup`);
  } catch (e) {
    console.error("[Migration] Failed to migrate actions:", e);
  }
}

async function migrateIndex(
  db: Kysely<Database>,
  adapter: FileSystemAdapter,
  paths: StoragePaths,
): Promise<void> {
  try {
    const files = await adapter.list(paths.pluginRoot);
    const idxFile = files.files.find((f) => {
      const name = path.basename(f);
      return name.startsWith("idx_") && name.endsWith(".json");
    });

    if (!idxFile) return;

    console.log(`[Migration] Migrating index: ${idxFile}`);
    const content = await adapter.read(idxFile);
    const idx = JSON.parse(content);
    const docs = idx.docs || [];
    console.log(`[Migration] Found ${docs.length} chunks`);

    const { notes, chunks, embeddings } = processIndexDocs(docs, idx.meta);

    await insertBatch(db, "notes", Array.from(notes.values()));
    await insertBatch(db, "chunks", chunks);
    await insertBatch(db, "embeddings", embeddings);

    await adapter.rename(idxFile, `${idxFile}.backup`);
    console.log("[Migration] Index migration complete");
  } catch (e) {
    console.error("[Migration] Failed to migrate index:", e);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Legacy JSON
function processIndexDocs(docs: any[], meta: any) {
  // biome-ignore lint/suspicious/noExplicitAny: Legacy JSON
  const notes = new Map<string, any>();
  // biome-ignore lint/suspicious/noExplicitAny: Legacy JSON
  const chunks: any[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: Legacy JSON
  const embeddings: any[] = [];

  for (const doc of docs) {
    if (!notes.has(doc.path)) {
      notes.set(doc.path, {
        path: doc.path,
        hash: doc.contentHash || "",
        mtime: doc.mtimeMs || 0,
        title: doc.title || path.basename(doc.path, path.extname(doc.path)),
        health_score: null,
        para_type: null,
        word_count: null,
      });
    }

    chunks.push({
      id: doc.chunkId,
      note_path: doc.path,
      tier: doc.tier,
      kind: doc.kind,
      parent_chunk_id: doc.parentChunkId || null,
      heading_path: doc.headingPath ? JSON.stringify(doc.headingPath) : null,
      text: doc.text,
      start_line: doc.startLine || null,
      end_line: doc.endLine || null,
    });

    if (doc.embedding && doc.embedding.length > 0) {
      embeddings.push({
        chunk_id: doc.chunkId,
        model_key: meta.modelKey,
        dimension: meta.dimension,
        vector: new Uint8Array(new Float32Array(doc.embedding).buffer),
      });
    }
  }

  return { notes, chunks, embeddings };
}

// biome-ignore lint/suspicious/noExplicitAny: Generic batch insert
async function insertBatch(db: Kysely<Database>, table: keyof Database, rows: any[]) {
  if (rows.length === 0) return;
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    await db
      .insertInto(table)
      .values(rows.slice(i, i + chunkSize))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}
