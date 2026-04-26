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
  dim: number;
  maxElements: number;
  nextLabel: number;
  idToLabel: Array<[string, number]>;
  labelToId: Array<[number, string]>;
  indexFileName: string;
  indexBytesBase64: string;
  options: Required<HnswOptions>;
}

export class HnswVectorIndex implements VectorIndex {
  // biome-ignore lint/suspicious/noExplicitAny: hnswlib-wasm types are loose at the boundary
  private lib: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: HierarchicalNSW instance type lives in the wasm module
  private index: any = null;
  private dim = 0;
  private nextLabel = 0;
  private readonly idToLabel = new Map<string, number>();
  private readonly labelToId = new Map<number, string>();
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
    this.index.addPoint(Array.from(vector), label, false);
    this.idToLabel.set(id, label);
    this.labelToId.set(label, id);
  }

  remove(id: string): void {
    this.requireInit();
    const label = this.idToLabel.get(id);
    if (label === undefined) return;
    this.index.markDelete(label);
    this.idToLabel.delete(id);
    this.labelToId.delete(label);
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
    const filename = `notient-hnsw-${Date.now()}.bin`;
    await this.index.writeIndex(filename);
    const fs = this.lib.FS;
    const bytes = fs.readFile(filename) as Uint8Array;
    fs.unlink(filename);
    const header: SerializedHeader = {
      dim: this.dim,
      maxElements: this.options.maxElements,
      nextLabel: this.nextLabel,
      idToLabel: Array.from(this.idToLabel.entries()),
      labelToId: Array.from(this.labelToId.entries()),
      indexFileName: filename,
      indexBytesBase64: base64Encode(bytes),
      options: this.options,
    };
    const json = JSON.stringify(header);
    return new TextEncoder().encode(json).buffer as ArrayBuffer;
  }

  async load(blob: ArrayBuffer): Promise<void> {
    const json = new TextDecoder().decode(blob);
    const parsed = JSON.parse(json) as SerializedHeader;
    this.dim = parsed.dim;
    this.nextLabel = parsed.nextLabel;
    this.idToLabel.clear();
    this.labelToId.clear();
    for (const [id, label] of parsed.idToLabel) this.idToLabel.set(id, label);
    for (const [label, id] of parsed.labelToId) this.labelToId.set(label, id);
    this.lib = await loadHnswlib();
    const fs = this.lib.FS;
    fs.writeFile(parsed.indexFileName, base64Decode(parsed.indexBytesBase64));
    this.index = new this.lib.HierarchicalNSW(parsed.options.space, this.dim, "");
    await this.index.readIndex(parsed.indexFileName, parsed.maxElements);
    this.index.setEfSearch(parsed.options.efSearch);
    fs.unlink(parsed.indexFileName);
  }

  private requireInit(): void {
    if (!this.index || !this.lib) throw new Error("HnswVectorIndex.init() must be called first");
  }
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64Decode(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
