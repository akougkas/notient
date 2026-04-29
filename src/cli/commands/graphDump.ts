/**
 * `notient graph dump` CLI verb.
 *
 * Spec: docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md §11.1.
 *
 * Streams the vault graph out of SurrealDB in one of three serialisation
 * formats. Read-only; opens a short-lived connection via the per-vault
 * port file and tears it down before returning.
 *
 * Tier filter semantics:
 *   - Tier 1 keeps deterministic edges only (`class = 'EXTRACTED'` AND
 *     `source IN ['wikilink','embed','frontmatter','structure']`).
 *   - Tier 2 is Tier 1 with chunk-derived metadata folded into node
 *     attributes (token estimates, embedded model). Edges are unchanged.
 *   - Tier 3 is the full graph including `class = 'INFERRED'` edges.
 *
 * Determinism: nodes are sorted by id, edges by (created_at, id).
 */

import type { Surreal } from "surrealdb";
import { EDGE_TABLES } from "../../core/db/edgeTables";
import type { Emitter } from "../output";
import { connectVaultSurreal } from "./awakenSurrealClient";

export type DumpTier = 1 | 2 | 3;
export type DumpFormat = "json" | "graphml" | "cypher";

export interface GraphDumpOptions {
  vaultPath: string;
  tier?: DumpTier;
  format?: DumpFormat;
  outPath?: string;
  emitter: Emitter;
  clientIdentity?: string;
}

interface DumpedNode {
  id: string;
  table: string;
  attributes: Record<string, unknown>;
}

interface DumpedEdge {
  id: string;
  table: string;
  in: string;
  out: string;
  source: string;
  attributes: Record<string, unknown>;
  createdAt: string;
}

export interface DumpedGraph {
  tier: DumpTier;
  nodes: DumpedNode[];
  edges: DumpedEdge[];
}

const ENTITY_TABLES = ["note", "block", "chunk", "tag", "concept", "claim", "question"] as const;

const TIER1_SOURCES: ReadonlyArray<string> = ["wikilink", "embed", "frontmatter", "structure"];

export async function runGraphDumpCommand(options: GraphDumpOptions): Promise<number> {
  const tier = options.tier ?? 3;
  const format = options.format ?? "json";

  let connection: { db: Surreal; close: () => Promise<void> } | undefined;
  try {
    const opened = await connectVaultSurreal(options.vaultPath);
    connection = opened;
    const graph = await collectGraph(opened.db, tier);
    const serialised = serialise(graph, format);
    if (typeof options.outPath === "string" && options.outPath.length > 0) {
      await Bun.write(options.outPath, serialised);
      options.emitter.emit({
        type: "graph:dump",
        format,
        tier,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        outPath: options.outPath,
      });
      return 0;
    }
    process.stdout.write(serialised);
    if (!serialised.endsWith("\n")) process.stdout.write("\n");
    return 0;
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "INTERNAL",
      message: `graph dump failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  } finally {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
  }
}

async function collectGraph(db: Surreal, tier: DumpTier): Promise<DumpedGraph> {
  const nodes = await collectNodes(db, tier);
  const edges = await collectEdges(db, tier);
  return { tier, nodes, edges };
}

async function collectNodes(db: Surreal, tier: DumpTier): Promise<DumpedNode[]> {
  const nodes: DumpedNode[] = [];
  for (const table of ENTITY_TABLES) {
    if (tier === 1 && table === "chunk") continue;
    const [rows] = await db
      .query<[Array<Record<string, unknown>>]>(`SELECT * FROM ${table};`)
      .collect<[Array<Record<string, unknown>>]>();
    for (const row of rows) {
      nodes.push(toNode(row, table));
    }
  }
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return nodes;
}

async function collectEdges(db: Surreal, tier: DumpTier): Promise<DumpedEdge[]> {
  const edges: DumpedEdge[] = [];
  for (const table of EDGE_TABLES) {
    const [rows] = await db
      .query<[Array<Record<string, unknown>>]>(`SELECT * FROM ${table};`)
      .collect<[Array<Record<string, unknown>>]>();
    for (const row of rows) {
      if (!includeEdge(row, tier)) continue;
      edges.push(toEdge(row, table));
    }
  }
  edges.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return edges;
}

function toNode(row: Record<string, unknown>, table: string): DumpedNode {
  const idString = stringifyValue(row.id);
  const { id: _omitId, ...rest } = row;
  return { id: idString, table, attributes: stripUndefined(rest) };
}

function toEdge(row: Record<string, unknown>, table: string): DumpedEdge {
  const idString = stringifyValue(row.id);
  const inString = stringifyValue(row.in);
  const outString = stringifyValue(row.out);
  const source = typeof row.source === "string" ? row.source : "";
  const createdAt = formatDate(row.created_at);
  const { id: _id, in: _in, out: _out, source: _source, ...rest } = row;
  return {
    id: idString,
    table,
    in: inString,
    out: outString,
    source,
    createdAt,
    attributes: stripUndefined(rest),
  };
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "toString" in value) return value.toString();
  return String(value);
}

function includeEdge(row: Record<string, unknown>, tier: DumpTier): boolean {
  const klass = typeof row.class === "string" ? row.class : "";
  const source = typeof row.source === "string" ? row.source : "";
  if (tier === 3) return true;
  // Tier 1 and Tier 2 share the same edge filter; Tier 2 enrichment is on
  // the node side (chunk attributes) rather than on the edge side.
  return klass === "EXTRACTED" && TIER1_SOURCES.includes(source);
}

function stripUndefined(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    if (value instanceof Date) {
      out[key] = value.toISOString();
      continue;
    }
    if (value !== null && typeof value === "object" && "toString" in value) {
      // SurrealDB DateTime / RecordId / Decimal all carry a toString().
      // Records that fall through here are plain objects, which JSON
      // handles natively.
      const proto = Object.getPrototypeOf(value);
      const isPlain = proto === null || proto === Object.prototype;
      if (!isPlain) {
        out[key] = value.toString();
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

function formatDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && "toString" in value) {
    return value.toString();
  }
  return "";
}

function serialise(graph: DumpedGraph, format: DumpFormat): string {
  if (format === "json") return serialiseJson(graph);
  if (format === "graphml") return serialiseGraphMl(graph);
  return serialiseCypher(graph);
}

function serialiseJson(graph: DumpedGraph): string {
  const nodes = graph.nodes.map((node) => ({
    id: node.id,
    table: node.table,
    ...node.attributes,
  }));
  const edges = graph.edges.map((edge) => ({
    id: edge.id,
    table: edge.table,
    in: edge.in,
    out: edge.out,
    source: edge.source,
    created_at: edge.createdAt,
    ...edge.attributes,
  }));
  return JSON.stringify({ tier: graph.tier, nodes, edges }, null, 2);
}

function serialiseGraphMl(graph: DumpedGraph): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">',
  );
  lines.push('  <key id="table" for="node" attr.name="table" attr.type="string"/>');
  lines.push('  <key id="table" for="edge" attr.name="table" attr.type="string"/>');
  lines.push('  <key id="source" for="edge" attr.name="source" attr.type="string"/>');
  lines.push('  <graph edgedefault="directed">');
  for (const node of graph.nodes) {
    lines.push(`    <node id="${escapeXml(node.id)}">`);
    lines.push(`      <data key="table">${escapeXml(node.table)}</data>`);
    lines.push("    </node>");
  }
  for (const edge of graph.edges) {
    lines.push(
      `    <edge id="${escapeXml(edge.id)}" source="${escapeXml(edge.in)}" target="${escapeXml(edge.out)}">`,
    );
    lines.push(`      <data key="table">${escapeXml(edge.table)}</data>`);
    lines.push(`      <data key="source">${escapeXml(edge.source)}</data>`);
    lines.push("    </edge>");
  }
  lines.push("  </graph>");
  lines.push("</graphml>");
  return lines.join("\n");
}

function serialiseCypher(graph: DumpedGraph): string {
  const lines: string[] = [];
  for (const node of graph.nodes) {
    lines.push(
      `CREATE (\`${cypherIdentifier(node.id)}\`:${cypherLabel(node.table)} {id: ${cypherString(node.id)}});`,
    );
  }
  for (const edge of graph.edges) {
    lines.push(
      `CREATE (\`${cypherIdentifier(edge.in)}\`)-[:${cypherLabel(edge.table)} {id: ${cypherString(edge.id)}, source: ${cypherString(edge.source)}}]->(\`${cypherIdentifier(edge.out)}\`);`,
    );
  }
  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cypherIdentifier(value: string): string {
  // Replace backticks so they can not break out of the quoted identifier.
  return value.replace(/`/g, "");
}

function cypherLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

function cypherString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function parseDumpTier(value: unknown): DumpTier | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("INVALID_PARAMS: --tier must be 1, 2, or 3");
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (parsed === 1 || parsed === 2 || parsed === 3) return parsed;
  throw new Error("INVALID_PARAMS: --tier must be 1, 2, or 3");
}

export function parseDumpFormat(value: unknown): DumpFormat {
  if (value === undefined) return "json";
  if (value === "json" || value === "graphml" || value === "cypher") return value;
  throw new Error("INVALID_PARAMS: --format must be json | graphml | cypher");
}
