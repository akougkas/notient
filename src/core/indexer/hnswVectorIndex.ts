// The env shim must be evaluated before hnswlib-wasm is imported, otherwise the
// bundle's `typeof window == 'object' || typeof importScripts == 'function'`
// gate throws synchronously under Bun and Node test runtimes. The shim is a
// no-op when a real `window` already exists (browsers, Obsidian renderer).
import "./hnswEnvShim";
import { loadHnswlib } from "hnswlib-wasm";
import type { VectorIndex, VectorSearchResult } from "./vectorIndex";

export interface HnswOptions {
  maxElements?: number;
  M?: number;
  efConstruction?: number;
  efSearch?: number;
  space?: "cosine" | "l2" | "ip";
}

interface SerializedHeader {
  version: 2;
  dim: number;
  options: Required<HnswOptions>;
  /** Raw vectors keyed by user-facing id. The HNSW graph is rebuilt on load. */
  entries: Array<{ id: string; vector: number[] }>;
}

/**
 * HNSW-backed vector index using `hnswlib-wasm`.
 *
 * Persistence note: `hnswlib-wasm@0.8.2` does not expose `Module.FS` (it sits
 * in the unexported-symbols list). We therefore cannot extract the serialized
 * graph file written by `index.writeIndex(...)` from the wasm filesystem from
 * outside the runtime. Instead we serialize the raw input vectors keyed by id
 * and rebuild the graph by replaying `addPoint` on load. This keeps
 * persistence portable across browsers and Bun, and matches user-vault scale
 * (rebuild cost is O(N * M * efConstruction) which is still seconds for tens
 * of thousands of notes).
 */
export class HnswVectorIndex implements VectorIndex {
  // biome-ignore lint/suspicious/noExplicitAny: hnswlib-wasm types are loose at the boundary
  private lib: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: HierarchicalNSW instance type lives in the wasm module
  private index: any = null;
  private dim = 0;
  private nextLabel = 0;
  private readonly idToLabel = new Map<string, number>();
  private readonly labelToId = new Map<number, string>();
  private readonly idToVector = new Map<string, Float32Array>();
  private readonly options: Required<HnswOptions>;

  constructor(opts: HnswOptions = {}) {
    this.options = {
      maxElements: opts.maxElements ?? 50_000,
      M: opts.M ?? 16,
      efConstruction: opts.efConstruction ?? 200,
      efSearch: opts.efSearch ?? 64,
      space: opts.space ?? "cosine",
    };
  }

  async init(dim: number): Promise<void> {
    this.dim = dim;
    this.lib = await loadHnswlib();
    this.index = new this.lib.HierarchicalNSW(this.options.space, dim, "");
    this.index.initIndex(
      this.options.maxElements,
      this.options.M,
      this.options.efConstruction,
      100,
    );
    this.index.setEfSearch(this.options.efSearch);
  }

  add(id: string, vector: Float32Array): void {
    this.requireInit();
    if (vector.length !== this.dim) {
      throw new Error(`vector dim ${vector.length} != index dim ${this.dim}`);
    }
    const existing = this.idToLabel.get(id);
    if (existing !== undefined) {
      this.index.markDelete(existing);
      this.labelToId.delete(existing);
      this.idToLabel.delete(id);
    }
    const label = this.nextLabel++;
    const stored = Float32Array.from(vector);
    this.index.addPoint(Array.from(stored), label, false);
    this.idToLabel.set(id, label);
    this.labelToId.set(label, id);
    this.idToVector.set(id, stored);
  }

  remove(id: string): void {
    this.requireInit();
    const label = this.idToLabel.get(id);
    if (label === undefined) return;
    this.index.markDelete(label);
    this.idToLabel.delete(id);
    this.labelToId.delete(label);
    this.idToVector.delete(id);
  }

  search(query: Float32Array, k: number): VectorSearchResult[] {
    this.requireInit();
    if (k <= 0) throw new Error("k must be > 0");
    if (query.length !== this.dim) {
      throw new Error(`query dim ${query.length} != index dim ${this.dim}`);
    }
    if (this.idToLabel.size === 0) return [];
    const cap = Math.min(k, this.idToLabel.size);
    const result = this.index.searchKnn(Array.from(query), cap, undefined);
    const out: VectorSearchResult[] = [];
    for (let i = 0; i < result.neighbors.length; i++) {
      const id = this.labelToId.get(result.neighbors[i]);
      if (id === undefined) continue;
      out.push({ id, score: 1 - result.distances[i] });
    }
    return out;
  }

  size(): number {
    return this.idToLabel.size;
  }

  async persist(): Promise<ArrayBuffer> {
    this.requireInit();
    const entries: SerializedHeader["entries"] = [];
    for (const [id, vector] of this.idToVector) {
      entries.push({ id, vector: Array.from(vector) });
    }
    const header: SerializedHeader = {
      version: 2,
      dim: this.dim,
      options: this.options,
      entries,
    };
    return new TextEncoder().encode(JSON.stringify(header)).buffer as ArrayBuffer;
  }

  async load(blob: ArrayBuffer): Promise<void> {
    const json = new TextDecoder().decode(blob);
    const parsed = JSON.parse(json) as SerializedHeader;
    if (parsed.version !== 2) {
      throw new Error(`unsupported HnswVectorIndex header version ${parsed.version}`);
    }
    this.dim = parsed.dim;
    Object.assign(this.options, parsed.options);
    this.idToLabel.clear();
    this.labelToId.clear();
    this.idToVector.clear();
    this.nextLabel = 0;

    this.lib = await loadHnswlib();
    this.index = new this.lib.HierarchicalNSW(this.options.space, this.dim, "");
    this.index.initIndex(
      this.options.maxElements,
      this.options.M,
      this.options.efConstruction,
      100,
    );
    this.index.setEfSearch(this.options.efSearch);

    for (const entry of parsed.entries) {
      const vector = Float32Array.from(entry.vector);
      const label = this.nextLabel++;
      this.index.addPoint(Array.from(vector), label, false);
      this.idToLabel.set(entry.id, label);
      this.labelToId.set(label, entry.id);
      this.idToVector.set(entry.id, vector);
    }
  }

  private requireInit(): void {
    if (!this.index || !this.lib) throw new Error("HnswVectorIndex.init() must be called first");
  }
}
