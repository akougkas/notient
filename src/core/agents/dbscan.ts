export interface DbscanPoint {
  id: string;
  v: Float32Array;
}

export interface DbscanOptions {
  epsilon: number;
  minPoints: number;
}

export function dbscanCosine(points: DbscanPoint[], options: DbscanOptions): DbscanPoint[][] {
  const labels = new Array<number | null>(points.length).fill(null);
  let cluster = -1;
  for (let i = 0; i < points.length; i++) {
    if (labels[i] !== null) continue;
    const neighbors = regionQuery(points, i, options.epsilon);
    if (neighbors.length < options.minPoints) {
      labels[i] = -1;
      continue;
    }
    cluster++;
    labels[i] = cluster;
    expandCluster(points, labels, neighbors, cluster, options);
  }
  return collectClusters(points, labels, cluster);
}

function expandCluster(
  points: DbscanPoint[],
  labels: Array<number | null>,
  seeds: number[],
  cluster: number,
  options: DbscanOptions,
): void {
  const queue = [...seeds];
  while (queue.length > 0) {
    const j = queue.shift() as number;
    if (labels[j] === -1) labels[j] = cluster;
    if (labels[j] !== null) continue;
    labels[j] = cluster;
    const inner = regionQuery(points, j, options.epsilon);
    if (inner.length >= options.minPoints) {
      for (const k of inner) queue.push(k);
    }
  }
}

function collectClusters(
  points: DbscanPoint[],
  labels: Array<number | null>,
  maxCluster: number,
): DbscanPoint[][] {
  const result: DbscanPoint[][] = [];
  for (let c = 0; c <= maxCluster; c++) {
    const group = points.filter((_, i) => labels[i] === c);
    if (group.length > 0) result.push(group);
  }
  return result;
}

function regionQuery(points: DbscanPoint[], i: number, epsilon: number): number[] {
  const out: number[] = [];
  for (let j = 0; j < points.length; j++) {
    if (cosineDistance(points[i].v, points[j].v) <= epsilon) out.push(j);
  }
  return out;
}

function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  const denom = Math.sqrt(aMag) * Math.sqrt(bMag);
  if (denom === 0) return 1;
  return 1 - dot / denom;
}
