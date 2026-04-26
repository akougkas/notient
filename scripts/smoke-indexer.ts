#!/usr/bin/env bun
/**
 * Real end-to-end smoke harness for the Notient indexer pipeline.
 *
 * Runs chunker, embedder, extractor, and graph writes against a live LM Studio
 * instance (dynamo by default) and asserts that real rows land in SQLite and
 * real vectors land in HNSW. Bypasses Obsidian entirely. Bypasses test mocks
 * entirely. If dynamo is unreachable the harness exits non-zero with a clear
 * message rather than silently degrading.
 *
 * Usage:
 *   bun scripts/smoke-indexer.ts
 *   SMOKE_VAULT_PATH=/path/to/vault bun scripts/smoke-indexer.ts
 *
 * Environment:
 *   SMOKE_VAULT_PATH       Override vault root (default: vaultex test vault)
 *   SMOKE_LMSTUDIO_URL     Override base URL (default: dynamo at .143:1234/v1)
 *   SMOKE_REASONING_MODEL  Override reasoning/extractor model
 *   SMOKE_EMBED_MODEL      Override embedding model
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Database, type DatabaseAdapter } from "../src/core/db/database";
import { EventBus } from "../src/core/events/eventBus";
import { GraphStore } from "../src/core/graph/graphStore";
import { Embedder } from "../src/core/indexer/embedder";
import { Extractor } from "../src/core/indexer/extractor";
import { HnswVectorIndex } from "../src/core/indexer/hnswVectorIndex";
import { indexNote } from "../src/core/indexer/indexNote";
import { LMStudioProvider } from "../src/core/llm/lmStudioProvider";

const DEFAULT_VAULT = "/mnt/c/Users/akougk/Projects/vaultex";
// Phase 4 substrate: ONLY mini. Chat = llama-server on :8080 (Nemotron-Cascade
// loaded); embedding = Ollama on :11434 (nomic-embed-text-v2-moe loaded).
const DEFAULT_LLM_URL = "http://192.168.86.141:8080/v1";
const DEFAULT_EMBED_URL = "http://192.168.86.141:11434/v1";
const DEFAULT_REASONING_MODEL = "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M";
const DEFAULT_EMBED_MODEL = "nomic-embed-text-v2-moe";
const EMBED_DIM = 768;

interface InlineNote {
  path: string;
  body: string;
}

const FALLBACK_NOTES: InlineNote[] = [
  {
    path: "Projects/notient-roadmap.md",
    body: `# Notient Roadmap

Notient is an Obsidian plugin that augments a personal vault with local LLM
reasoning. Phase 2 introduces a senses pipeline that ingests notes, chunks
them, embeds them with nomic-embed-text-v2-moe, and extracts entities, claims,
and questions. The orchestrator brain coordinates four agents: NoteEditor,
ContextBuilder, Worker, and the Chief of Staff.

Open question: should the vector index live in WASM or shell out to a native
HNSW process per vault?`,
  },
  {
    path: "Areas/research-cadence.md",
    body: `# Research Cadence

Maintain a weekly review on Sunday. Rotate among three buckets: ML systems,
distributed storage, and developer tooling. Each session produces at least one
atomic note and one open question. The atomic note must cite the source with a
permanent link.`,
  },
  {
    path: "Resources/embedding-models.md",
    body: `# Embedding Models Survey

nomic-embed-text-v2-moe outputs 768 dimensions and supports late chunking. It
is a Mixture of Experts variant of the v1.5 family. BGE-M3 also produces 1024
dimensions and supports multi-vector retrieval. Granite embeddings from IBM
target instruction-tuned retrieval at 107M parameters.`,
  },
  {
    path: "Archives/2024-q4-experiments.md",
    body: `# 2024 Q4 Experiments

Tested local reranking with granite-4.0-h-350m on a corpus of 500 personal
notes. Mean recall@10 improved from 0.62 to 0.79. The reranker added 180ms of
latency per query on the dynamo node. Concluded that reranking is worth the
cost for vault sizes above 1000 notes.`,
  },
  {
    path: "Projects/vault-lock-design.md",
    body: `# Vault Lock Design

Multiple Obsidian windows can open the same vault. The plugin must serialize
writes to notient.db and vectors.bin. The chosen approach is a lock file with
a generation token. On startup the plugin attempts to acquire the lock; if it
sees a stale generation it steals the lock, otherwise it backs off.`,
  },
];

interface NoteSample {
  path: string;
  body: string;
}

interface StageTimings {
  totalMs: number;
  result: {
    chunkCount: number;
    embedCount: number;
    nodeCount: number;
    edgeCount: number;
  };
}

class FsAdapter implements DatabaseAdapter {
  async readBinary(path: string): Promise<ArrayBuffer | null> {
    if (!existsSync(path)) return null;
    const buf = readFileSync(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const fs = await import("node:fs/promises");
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, new Uint8Array(data));
  }
}

function loadWasmBuffer(): ArrayBuffer {
  const wasmPath = resolve(import.meta.dir, "../node_modules/sql.js/dist/sql-wasm.wasm");
  const buf = readFileSync(wasmPath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function pickVaultNotes(root: string): NoteSample[] {
  const folders = ["1-projects", "2-areas", "3-resources", "4-archive", "0-inbox"];
  const picks: NoteSample[] = [];
  for (const folder of folders) {
    if (picks.length >= 5) break;
    const dir = join(root, folder);
    if (!existsSync(dir)) continue;
    const found = findFirstSmallMd(dir, 50_000);
    if (found) {
      const body = readFileSync(found, "utf8");
      const relativePath = found.slice(root.length + 1).replace(/\\/g, "/");
      picks.push({ path: relativePath, body });
    }
  }
  return picks;
}

function findFirstSmallMd(dir: string, maxBytes: number): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries.sort()) {
    const fullPath = join(dir, entry);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      const found = findFirstSmallMd(fullPath, maxBytes);
      if (found) return found;
      continue;
    }
    if (!entry.endsWith(".md")) continue;
    if (stats.size < 200 || stats.size > maxBytes) continue;
    return fullPath;
  }
  return null;
}

async function main(): Promise<number> {
  const vaultRoot = process.env.SMOKE_VAULT_PATH ?? DEFAULT_VAULT;
  const baseUrl = process.env.SMOKE_LLM_URL ?? process.env.SMOKE_LMSTUDIO_URL ?? DEFAULT_LLM_URL;
  const embedUrl = process.env.SMOKE_EMBED_URL ?? DEFAULT_EMBED_URL;
  const reasoningModel = process.env.SMOKE_REASONING_MODEL ?? DEFAULT_REASONING_MODEL;
  const embedModel = process.env.SMOKE_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;

  const tempDir = mkdtempSync(join(tmpdir(), "notient-smoke-"));
  const dbPath = join(tempDir, "notient-smoke.db");
  const vectorsPath = join(tempDir, "vectors.bin");
  const wasmPath = join(tempDir, "sql-wasm.wasm");

  console.log("[smoke] temp dir :", tempDir);
  console.log("[smoke] llm url  :", baseUrl);
  console.log("[smoke] embed url:", embedUrl);
  console.log("[smoke] models   :", `reasoning=${reasoningModel} embed=${embedModel}`);

  const cleanup = (): void => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.warn("[smoke] cleanup warn:", (error as Error).message);
    }
  };

  const wallStart = Date.now();
  let exitCode = 0;
  try {
    const adapter = new FsAdapter();
    await adapter.writeBinary(wasmPath, loadWasmBuffer());

    const database = new Database(adapter, { dbPath, wasmPath });
    await database.init();
    console.log(`[smoke] sqlite ready (schema v${Database.currentSchemaVersion})`);

    const provider = new LMStudioProvider({ baseUrl });
    const embedProvider = new LMStudioProvider({ baseUrl: embedUrl });
    const probeStart = Date.now();
    const reachable = await provider.isAvailable();
    const probeMs = Date.now() - probeStart;
    if (!reachable) {
      console.error(`[smoke] FATAL: llama-server unreachable at ${baseUrl} (probe ${probeMs}ms)`);
      console.error("[smoke] Ensure mini's llama-server systemd unit is active and serving /v1/models.");
      cleanup();
      return 1;
    }
    const embedReachable = await embedProvider.isAvailable();
    if (!embedReachable) {
      console.error(`[smoke] FATAL: embedding endpoint unreachable at ${embedUrl}`);
      console.error("[smoke] Ensure mini's ollama service is active and has nomic-embed-text-v2-moe pulled.");
      cleanup();
      return 1;
    }
    const modelsResponse = await fetch(`${baseUrl}/models`);
    const modelsBody = (await modelsResponse.json()) as { data: { id: string }[] };
    const modelIds = modelsBody.data.map((m) => m.id);
    console.log(`[smoke] llm OK in ${probeMs}ms; ${modelIds.length} models on llama-server`);
    if (!modelIds.includes(reasoningModel)) {
      console.warn(`[smoke] WARN: reasoning model "${reasoningModel}" not listed by llama-server`);
    }
    const embedModelsResponse = await fetch(`${embedUrl}/models`);
    const embedModelsBody = (await embedModelsResponse.json()) as { data: { id: string }[] };
    const embedModelIds = embedModelsBody.data.map((m) => m.id);
    if (!embedModelIds.some((id) => id === embedModel || id === `${embedModel}:latest`)) {
      console.warn(`[smoke] WARN: embedding model "${embedModel}" not listed by ollama`);
    }

    const bus = new EventBus();
    const graph = new GraphStore(database);
    const vectorIndex = new HnswVectorIndex({ maxElements: 50_000 });
    await vectorIndex.init(EMBED_DIM);
    const embedder = new Embedder(embedProvider, { model: embedModel, batchSize: 16 });
    const extractor = new Extractor(provider, { model: reasoningModel, concurrency: 4 });

    let notes: NoteSample[];
    if (existsSync(vaultRoot)) {
      notes = pickVaultNotes(vaultRoot);
      if (notes.length < 5) {
        console.warn(
          `[smoke] only ${notes.length} notes from ${vaultRoot}; padding with fallback notes`,
        );
        for (const fallback of FALLBACK_NOTES) {
          if (notes.length >= 5) break;
          notes.push(fallback);
        }
      }
    } else {
      console.warn(`[smoke] vault path missing (${vaultRoot}); using inline fallback notes`);
      notes = [...FALLBACK_NOTES];
    }
    notes = notes.slice(0, 5);
    console.log(`[smoke] selected ${notes.length} notes`);
    for (const note of notes) console.log("        -", note.path, `(${note.body.length}b)`);

    const timings: StageTimings[] = [];
    for (const note of notes) {
      const t0 = Date.now();
      const result = await indexNote({
        notePath: note.path,
        noteBody: note.body,
        database,
        graph,
        vectorIndex,
        embedder,
        extractor,
        bus,
      });
      const totalMs = Date.now() - t0;
      timings.push({
        totalMs,
        result: {
          chunkCount: result.chunkCount,
          embedCount: result.embedCount,
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount,
        },
      });
      console.log(
        `[smoke] indexed ${note.path} in ${totalMs}ms ` +
          `(chunks=${result.chunkCount} embeds=${result.embedCount} ` +
          `nodes=${result.nodeCount} edges=${result.edgeCount})`,
      );
    }

    await database.persist();
    const persistedVectors = await vectorIndex.persist();
    await adapter.writeBinary(vectorsPath, persistedVectors);

    const counts = {
      notes: countRows(database, "notes"),
      chunks: countRows(database, "chunks"),
      embeddings: countRows(database, "embeddings"),
      graphNodes: countRows(database, "graph_nodes"),
      graphEdges: countRows(database, "graph_edges"),
    };
    const failures: string[] = [];
    if (counts.notes !== 5) failures.push(`notes expected 5, got ${counts.notes}`);
    if (counts.chunks <= 5) failures.push(`chunks expected > 5, got ${counts.chunks}`);
    if (counts.embeddings !== counts.chunks)
      failures.push(`embeddings (${counts.embeddings}) != chunks (${counts.chunks})`);
    if (counts.graphNodes < 5) failures.push(`graph_nodes expected >= 5, got ${counts.graphNodes}`);
    if (counts.graphEdges < 1) failures.push(`graph_edges expected >= 1, got ${counts.graphEdges}`);

    const reloadIndex = new HnswVectorIndex({ maxElements: 50_000 });
    const reloadBlob = readFileSync(vectorsPath);
    const reloadBuffer = reloadBlob.buffer.slice(
      reloadBlob.byteOffset,
      reloadBlob.byteOffset + reloadBlob.byteLength,
    ) as ArrayBuffer;
    await reloadIndex.load(reloadBuffer);
    if (reloadIndex.size() !== counts.embeddings) {
      failures.push(
        `reloaded vector index size ${reloadIndex.size()} != embeddings ${counts.embeddings}`,
      );
    }
    const sampleEmbedRow = database.query<{ vector: Uint8Array }>(
      "SELECT vector FROM embeddings LIMIT 1;",
    )[0];
    if (!sampleEmbedRow) {
      failures.push("could not retrieve a sample embedding for knn probe");
    } else {
      const queryVector = new Float32Array(
        sampleEmbedRow.vector.buffer,
        sampleEmbedRow.vector.byteOffset,
        sampleEmbedRow.vector.byteLength / 4,
      );
      const knn = reloadIndex.search(queryVector, 3);
      if (knn.length === 0) failures.push("reloaded knn returned 0 results");
      else console.log(`[smoke] knn probe returned ${knn.length} results, top=${knn[0].id}`);
    }

    const wallMs = Date.now() - wallStart;
    const sumMs = timings.reduce((acc, t) => acc + t.totalMs, 0);
    const avgMs = sumMs / Math.max(1, timings.length);
    console.log("");
    console.log("[smoke] ===== summary =====");
    console.log(`        notes        : ${counts.notes}`);
    console.log(`        chunks       : ${counts.chunks}`);
    console.log(`        embeddings   : ${counts.embeddings}`);
    console.log(`        graph_nodes  : ${counts.graphNodes}`);
    console.log(`        graph_edges  : ${counts.graphEdges}`);
    console.log(`        wall time    : ${wallMs}ms`);
    console.log(`        avg per note : ${avgMs.toFixed(0)}ms`);
    console.log(`        dynamo probe : ${probeMs}ms`);

    if (failures.length > 0) {
      console.error("[smoke] FAIL:");
      for (const failure of failures) console.error(`        - ${failure}`);
      exitCode = 2;
    } else {
      console.log("[smoke] PASS");
    }

    await database.close();
  } catch (error) {
    console.error("[smoke] FATAL:", (error as Error).stack ?? error);
    exitCode = 3;
  } finally {
    cleanup();
  }
  return exitCode;
}

function countRows(database: Database, table: string): number {
  const rows = database.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table};`);
  return rows[0]?.n ?? 0;
}

const code = await main();
process.exit(code);
