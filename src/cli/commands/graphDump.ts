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
 *     `source IN ['wikilink','markdown','embed','frontmatter','structure']`).
 *   - Tier 2 is Tier 1 with chunk-derived metadata folded into node
 *     attributes (token estimates, embedded model). Edges are unchanged.
 *   - Tier 3 is the full graph including `class = 'INFERRED'` edges.
 *
 * Determinism: nodes are sorted by id, edges by (created_at, id).
 */

import { DateTime, RecordId, type Surreal } from "surrealdb";
import {
  EDGE_TABLES,
  type EdgeTable,
  isEdgeSource,
  isExtractorEdgeTable,
} from "../../core/db/edgeTables";
import { readSingleStatementRows } from "../../core/db/queryResult";
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
  table: EdgeTable;
  in: string;
  out: string;
  source: string;
  confidenceClass: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
  attributes: Record<string, unknown>;
  createdAt: string;
}

export interface DumpedGraph {
  tier: DumpTier;
  nodes: DumpedNode[];
  edges: DumpedEdge[];
}

const ENTITY_TABLES = ["note", "block", "chunk", "tag", "concept", "claim", "question"] as const;

const TIER1_SOURCES = ["wikilink", "markdown", "embed", "frontmatter", "structure"] as const;

export async function runGraphDumpCommand(options: GraphDumpOptions): Promise<number> {
  const tier = options.tier ?? 3;
  const format = options.format ?? "json";

  let connection: { db: Surreal; close: () => Promise<void> } | undefined;
  let graph: DumpedGraph | undefined;
  let failure: unknown;
  try {
    const opened = await connectVaultSurreal(options.vaultPath);
    connection = opened;
    graph = await collectGraph(opened.db, tier);
  } catch (error) {
    failure = error;
  }
  if (connection !== undefined) {
    try {
      await connection.close();
    } catch (error) {
      failure = combineErrors(failure, error);
    }
  }
  if (failure !== undefined || graph === undefined) {
    const error = failure ?? new Error("graph dump completed without a graph");
    options.emitter.emit({
      type: "error",
      code: "INTERNAL",
      message: `graph dump failed: ${formatError(error)}`,
    });
    return 1;
  }
  try {
    const serialised = serialise(graph, format);
    if (options.outPath !== undefined) {
      if (options.outPath.length === 0) {
        throw new Error("graph dump output path must not be empty");
      }
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
      message: `graph dump failed: ${formatError(error)}`,
    });
    return 1;
  }
}

async function collectGraph(db: Surreal, tier: DumpTier): Promise<DumpedGraph> {
  const nodes = await collectNodes(db, tier);
  const edges = await collectEdges(db, tier);
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const edge of edges) {
    if (!nodeIds.has(edge.in) || !nodeIds.has(edge.out)) {
      throw new Error(`graph dump storage integrity: edge ${edge.id} has a missing endpoint`);
    }
  }
  return { tier, nodes, edges };
}

async function collectNodes(db: Surreal, tier: DumpTier): Promise<DumpedNode[]> {
  const nodes: DumpedNode[] = [];
  for (const table of ENTITY_TABLES) {
    if (tier === 1 && table === "chunk") continue;
    const result: unknown = await db.query(`SELECT * FROM ${table};`).collect();
    const rows = readSingleStatementRows(result, `graph dump ${table}`);
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
    const result: unknown = await db.query(`SELECT * FROM ${table};`).collect();
    const rows = readSingleStatementRows(result, `graph dump ${table}`);
    for (const row of rows) {
      const edge = toEdge(row, table);
      if (!includeEdge(edge, tier)) continue;
      edges.push(edge);
    }
  }
  edges.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return edges;
}

export function decodeDumpNode(row: unknown, table: (typeof ENTITY_TABLES)[number]): DumpedNode {
  const record = requireRecord(row, `graph dump ${table} row`);
  const id = requireRecordId(record.id, table, `graph dump ${table} id`).toString();
  const { id: _omitId, ...attributes } = record;
  return { id, table, attributes: encodeAttributes(attributes, `graph dump ${id}`) };
}

function toNode(row: unknown, table: (typeof ENTITY_TABLES)[number]): DumpedNode {
  return decodeDumpNode(row, table);
}

export function decodeDumpEdge(row: unknown, table: EdgeTable): DumpedEdge {
  const record = requireRecord(row, `graph dump ${table} row`);
  const allowedFields = [
    "id",
    "in",
    "out",
    "source",
    "class",
    "confidence",
    "evidence",
    "agent",
    "approved",
    "applied",
    "created_at",
  ];
  if (Object.keys(record).some((key) => !allowedFields.includes(key))) {
    throw new Error(`graph dump ${table} storage integrity: edge row has unknown fields`);
  }
  for (const field of [
    "id",
    "in",
    "out",
    "source",
    "class",
    "confidence",
    "approved",
    "applied",
    "created_at",
  ]) {
    if (!(field in record)) {
      throw new Error(`graph dump ${table} storage integrity: edge row is missing ${field}`);
    }
  }
  const id = requireRecordId(record.id, table, `graph dump ${table} id`).toString();
  const from = requireEntityRecordId(record.in, `graph dump ${id} source`).toString();
  const to = requireEntityRecordId(record.out, `graph dump ${id} target`).toString();
  if (!isEdgeSource(record.source)) {
    throw new Error(`graph dump ${table} storage integrity: invalid provenance source`);
  }
  if (record.class !== "EXTRACTED" && record.class !== "INFERRED" && record.class !== "AMBIGUOUS") {
    throw new Error(`graph dump ${table} storage integrity: invalid confidence class`);
  }
  if (
    typeof record.confidence !== "number" ||
    !Number.isFinite(record.confidence) ||
    record.confidence < 0 ||
    record.confidence > 1
  ) {
    throw new Error(`graph dump ${table} storage integrity: invalid confidence`);
  }
  if (typeof record.approved !== "boolean" || typeof record.applied !== "boolean") {
    throw new Error(`graph dump ${table} storage integrity: invalid decision state`);
  }
  validateOptionalAgent(record.agent, table);
  validateEvidence(record.evidence, table);
  const createdAt = requireDateTime(record.created_at, `graph dump ${id} created_at`);
  const {
    id: _id,
    in: _in,
    out: _out,
    source: _source,
    class: _class,
    created_at: _createdAt,
    ...attributes
  } = record;
  return {
    id,
    table,
    in: from,
    out: to,
    source: record.source,
    confidenceClass: record.class,
    createdAt,
    attributes: encodeAttributes(attributes, `graph dump ${id}`),
  };
}

function toEdge(row: unknown, table: EdgeTable): DumpedEdge {
  return decodeDumpEdge(row, table);
}

function includeEdge(edge: DumpedEdge, tier: DumpTier): boolean {
  if (tier === 3) return true;
  // Tier 1 and Tier 2 share the same edge filter; Tier 2 enrichment is on
  // the node side (chunk attributes) rather than on the edge side.
  return (
    edge.confidenceClass === "EXTRACTED" &&
    TIER1_SOURCES.includes(edge.source as (typeof TIER1_SOURCES)[number])
  );
}

function encodeAttributes(record: Record<string, unknown>, label: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = encodeAttribute(value, `${label}.${key}`);
  }
  return out;
}

function encodeAttribute(value: unknown, label: string): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} storage integrity: numeric attribute is not finite`);
    }
    return value;
  }
  if (value instanceof DateTime) return requireDateTime(value, label);
  if (value instanceof RecordId) return value.toString();
  if (Array.isArray(value)) {
    return value.map((entry, index) => encodeAttribute(entry, `${label}[${index}]`));
  }
  const record = requireRecord(value, label);
  return encodeAttributes(record, label);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} storage integrity: expected an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    throw new Error(`${label} storage integrity: unsupported native value`);
  }
  return value as Record<string, unknown>;
}

function requireRecordId<TableName extends string>(
  value: unknown,
  table: TableName,
  label: string,
): RecordId<TableName> {
  if (!(value instanceof RecordId) || value.table.name !== table) {
    throw new Error(`${label} storage integrity: expected a native ${table} record id`);
  }
  return value as RecordId<TableName>;
}

function requireEntityRecordId(value: unknown, label: string): RecordId {
  if (
    !(value instanceof RecordId) ||
    !ENTITY_TABLES.includes(value.table.name as (typeof ENTITY_TABLES)[number])
  ) {
    throw new Error(`${label} storage integrity: expected a native entity record id`);
  }
  return value;
}

function requireDateTime(value: unknown, label: string): string {
  if (!(value instanceof DateTime)) {
    throw new Error(`${label} storage integrity: expected a native datetime`);
  }
  const date = value.toDate();
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${label} storage integrity: datetime is invalid`);
  }
  return date.toISOString();
}

function validateOptionalAgent(value: unknown, table: EdgeTable): void {
  if (value === undefined) return;
  if (value === null || typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`graph dump ${table} storage integrity: invalid agent`);
  }
}

function validateEvidence(value: unknown, table: EdgeTable): void {
  if (value === undefined) {
    if (isExtractorEdgeTable(table)) {
      throw new Error(`graph dump ${table} storage integrity: extractor edge lacks evidence`);
    }
    return;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`graph dump ${table} storage integrity: invalid evidence`);
  }
  const ids = new Set<string>();
  for (const entry of value) {
    const id = requireRecordId(entry, "chunk", `graph dump ${table} evidence`).toString();
    if (ids.has(id)) {
      throw new Error(`graph dump ${table} storage integrity: duplicate evidence`);
    }
    ids.add(id);
  }
}

function serialise(graph: DumpedGraph, format: DumpFormat): string {
  if (format === "json") return serialiseJson(graph);
  if (format === "graphml") return serialiseGraphMl(graph);
  return serialiseCypher(graph);
}

function serialiseJson(graph: DumpedGraph): string {
  const nodes = graph.nodes.map((node) => ({
    ...node.attributes,
    id: node.id,
    table: node.table,
  }));
  const edges = graph.edges.map((edge) => ({
    ...edge.attributes,
    id: edge.id,
    table: edge.table,
    in: edge.in,
    out: edge.out,
    source: edge.source,
    class: edge.confidenceClass,
    created_at: edge.createdAt,
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
  if (value.includes("`")) {
    throw new Error("graph dump cannot encode a record id containing a backtick");
  }
  return value;
}

function cypherLabel(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    throw new Error("graph dump cannot encode a non-canonical table name");
  }
  return value;
}

function cypherString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function parseDumpTier(value: unknown): DumpTier | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("INVALID_PARAMS: --tier must be 1, 2, or 3");
  }
  if (value === "1") return 1;
  if (value === "2") return 2;
  if (value === "3") return 3;
  throw new Error("INVALID_PARAMS: --tier must be 1, 2, or 3");
}

function combineErrors(primary: unknown, closeError: unknown): Error {
  if (primary === undefined) {
    return new Error(`database connection close failed: ${formatError(closeError)}`);
  }
  return new Error(
    `${formatError(primary)}; database connection close also failed: ${formatError(closeError)}`,
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseDumpFormat(value: unknown): DumpFormat {
  if (value === undefined) return "json";
  if (value === "json" || value === "graphml" || value === "cypher") return value;
  throw new Error("INVALID_PARAMS: --format must be json | graphml | cypher");
}
