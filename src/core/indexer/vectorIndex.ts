export interface VectorSearchResult {
  id: string;
  score: number;
}

export interface VectorIndex {
  init(dim: number): Promise<void>;
  add(id: string, vector: Float32Array): void;
  remove(id: string): void;
  search(query: Float32Array, k: number): VectorSearchResult[];
  size(): number;
  persist(): Promise<ArrayBuffer>;
  load(blob: ArrayBuffer): Promise<void>;
}

export class InMemoryVectorIndex implements VectorIndex {
  private dim = 0;
  private readonly vectors = new Map<string, Float32Array>();

  async init(dim: number): Promise<void> {
    this.dim = dim;
    this.vectors.clear();
  }

  add(id: string, vector: Float32Array): void {
    if (vector.length !== this.dim) {
      throw new Error(`vector dim ${vector.length} != index dim ${this.dim}`);
    }
    this.vectors.set(id, Float32Array.from(vector));
  }

  remove(id: string): void {
    this.vectors.delete(id);
  }

  search(query: Float32Array, k: number): VectorSearchResult[] {
    if (k <= 0) throw new Error("k must be > 0");
    if (query.length !== this.dim) {
      throw new Error(`query dim ${query.length} != index dim ${this.dim}`);
    }
    const queryNorm = magnitude(query);
    const results: VectorSearchResult[] = [];
    for (const [id, v] of this.vectors) {
      const score = cosine(query, v, queryNorm);
      results.push({ id, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  size(): number {
    return this.vectors.size;
  }

  async persist(): Promise<ArrayBuffer> {
    const entries: Array<[string, number[]]> = [];
    for (const [id, v] of this.vectors) entries.push([id, Array.from(v)]);
    const json = JSON.stringify({ dim: this.dim, entries });
    return new TextEncoder().encode(json).buffer as ArrayBuffer;
  }

  async load(blob: ArrayBuffer): Promise<void> {
    const json = new TextDecoder().decode(blob);
    const parsed = JSON.parse(json) as { dim: number; entries: Array<[string, number[]]> };
    this.dim = parsed.dim;
    this.vectors.clear();
    for (const [id, arr] of parsed.entries) this.vectors.set(id, Float32Array.from(arr));
  }
}

function magnitude(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum) || 1;
}

function cosine(a: Float32Array, b: Float32Array, aMag?: number): number {
  const am = aMag ?? magnitude(a);
  const bm = magnitude(b);
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (am * bm);
}
