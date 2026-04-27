import type { Database } from "../db/database";
import type { EventBus } from "../events/eventBus";
import type { GraphStore } from "../graph/graphStore";
import type { GraphEdge, GraphNode } from "../graph/types";
import { chunkNote } from "./chunker";
import type { Embedder } from "./embedder";
import type { Extractor } from "./extractor";
import type { Chunk, Extraction, IndexResult } from "./types";
import type { VectorIndex } from "./vectorIndex";

export interface IndexNoteArgs {
  notePath: string;
  noteBody: string;
  database: Database;
  graph: GraphStore;
  vectorIndex: VectorIndex;
  embedder: Embedder;
  extractor: Extractor;
  bus: EventBus;
  /** Optional cancellation for embedding calls. */
  signal?: AbortSignal;
}

const FENCE = "---";

export async function indexNote(args: IndexNoteArgs): Promise<IndexResult> {
  const start = Date.now();
  const { notePath, noteBody, database, graph, vectorIndex, embedder, extractor, bus, signal } =
    args;
  const sha = await sha256(noteBody);

  const existing = database.query<{ sha: string }>("SELECT sha FROM notes WHERE path = ?;", [
    notePath,
  ]);
  if (existing[0]?.sha === sha) {
    return {
      notePath,
      noteSha: sha,
      chunkCount: 0,
      embedCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      durationMs: Date.now() - start,
    };
  }

  const body = stripFrontmatter(noteBody);
  const chunks: Chunk[] = await chunkNote(notePath, body);
  // Embed and extract in parallel: distinct LM Studio models (embedding vs reasoning)
  // share no resources, so both calls flight simultaneously and keep both models hot.
  // Extractor runs its own internal 4-way concurrency over chunk extractions.
  const [vectors, extraction]: [number[][], Extraction] =
    chunks.length > 0
      ? await Promise.all([
          embedder.embed(
            chunks.map((c) => c.text),
            signal,
          ),
          extractor.extract(chunks),
        ])
      : [[] as number[][], { entities: [], claims: [], questions: [] } as Extraction];

  const nowMs = Date.now();
  const noteNode: GraphNode = {
    id: `note:${notePath}`,
    type: "note",
    label: notePath,
    notePath,
    payload: null,
    createdAt: nowMs,
  };

  const conceptNodes = extraction.entities.map((label) => buildConceptNode(label, nowMs));
  const claimNodes = extraction.claims.map((text) => buildClaimNode(notePath, text, nowMs));
  const questionNodes = extraction.questions.map((text) =>
    buildQuestionNode(notePath, text, nowMs),
  );

  const allNodes: GraphNode[] = [noteNode, ...conceptNodes, ...claimNodes, ...questionNodes];
  const edgeAgent = "extractor";
  const edges: GraphEdge[] = [
    ...conceptNodes.map((c) => buildEdge("mentions", noteNode.id, c.id, edgeAgent, [], nowMs)),
    ...claimNodes.map((c) => buildEdge("asserts", noteNode.id, c.id, edgeAgent, [], nowMs)),
    ...questionNodes.map((q) => buildEdge("asks", noteNode.id, q.id, edgeAgent, [], nowMs)),
  ];

  database.transaction(() => {
    database.run("DELETE FROM chunks WHERE note_path = ?;", [notePath]);
    // Embeddings cascade via chunks ON DELETE CASCADE.
    database.run("DELETE FROM graph_edges WHERE source_id = ?;", [noteNode.id]);
    database.run(
      `INSERT INTO notes (path, sha, word_count, indexed_at, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET sha = excluded.sha,
         word_count = excluded.word_count,
         updated_at = excluded.updated_at,
         indexed_at = excluded.indexed_at;`,
      [notePath, sha, countWords(body), nowMs, nowMs],
    );
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      database.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
        chunk.id,
        chunk.notePath,
        chunk.ord,
        chunk.text,
        chunk.sha,
      ]);
      const vector = vectors[i];
      if (vector) {
        database.run("INSERT INTO embeddings (chunk_id, model, dim, vector) VALUES (?,?,?,?);", [
          chunk.id,
          "primary-embed",
          vector.length,
          new Uint8Array(Float32Array.from(vector).buffer),
        ]);
      }
    }
    for (const node of allNodes) graph.upsertNode(node);
    for (const edge of edges) graph.insertEdge(edge);
  });

  for (let i = 0; i < chunks.length; i++) {
    const v = vectors[i];
    if (!v) continue;
    vectorIndex.add(chunks[i].id, Float32Array.from(v));
  }

  for (const node of allNodes) {
    bus.emit({
      type: "indexer:node-added",
      nodeId: node.id,
      nodeType: node.type,
      label: node.label,
      notePath: node.notePath,
    });
  }
  for (const edge of edges) {
    bus.emit({
      type: "indexer:edge-added",
      edgeId: edge.id,
      edgeType: edge.type,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
    });
  }

  const result: IndexResult = {
    notePath,
    noteSha: sha,
    chunkCount: chunks.length,
    embedCount: vectors.length,
    nodeCount: allNodes.length,
    edgeCount: edges.length,
    durationMs: Date.now() - start,
  };
  bus.emit({
    type: "indexer:note-indexed",
    path: notePath,
    result: {
      chunkCount: result.chunkCount,
      embedCount: result.embedCount,
      nodeCount: result.nodeCount,
      edgeCount: result.edgeCount,
      durationMs: result.durationMs,
    },
  });
  return result;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith(FENCE)) return content;
  const closeIdx = content.indexOf(`\n${FENCE}`, FENCE.length);
  if (closeIdx === -1) return content;
  const after = closeIdx + 1 + FENCE.length;
  return content.slice(after).replace(/^\r?\n/, "");
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildConceptNode(label: string, nowMs: number): GraphNode {
  return {
    id: `concept:${slugify(label)}`,
    type: "concept",
    label,
    notePath: null,
    payload: null,
    createdAt: nowMs,
  };
}

function buildClaimNode(notePath: string, text: string, nowMs: number): GraphNode {
  const id = `claim:${shortHash(`${notePath}|${text}`)}`;
  return {
    id,
    type: "claim",
    label: text,
    notePath,
    payload: { text },
    createdAt: nowMs,
  };
}

function buildQuestionNode(notePath: string, text: string, nowMs: number): GraphNode {
  const id = `question:${shortHash(`${notePath}|${text}`)}`;
  return {
    id,
    type: "question",
    label: text,
    notePath,
    payload: { text },
    createdAt: nowMs,
  };
}

function buildEdge(
  type: GraphEdge["type"],
  sourceId: string,
  targetId: string,
  agent: string,
  evidence: string[],
  nowMs: number,
): GraphEdge {
  return {
    id: `edge:${shortHash(`${type}|${sourceId}|${targetId}|${nowMs}`)}`,
    type,
    sourceId,
    targetId,
    confidence: 1,
    agent,
    evidence,
    approved: true,
    createdAt: nowMs,
  };
}

function shortHash(input: string): string {
  // Sync FNV-1a 32-bit, hex; deterministic and fast.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function sha256(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
