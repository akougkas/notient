/**
 * Embedding Model Benchmark
 *
 * Compares embedding models for:
 * - Latency (single query, batch)
 * - Semantic quality (similar/dissimilar discrimination)
 * - Memory footprint (embedding size)
 *
 * Candidate models:
 * - granite-embedding:30m (384d, 512 ctx)
 * - granite-embedding:278m (768d, 512 ctx)
 * - qwen3-embedding:0.6b (1024d, 32k ctx)
 */

const OLLAMA_HOST = "http://192.168.86.249:11434";

interface EmbeddingResult {
  model: string;
  dimension: number;
  singleLatencyMs: number[];
  batchLatencyMs: number[];
  similarityScores: { pair: string; score: number; expected: "high" | "low" }[];
}

const MODELS = [
  "granite-embedding:30m",
  "granite-embedding:278m",
  "qwen3-embedding:0.6b",
];

// Test pairs for semantic similarity
const SIMILAR_PAIRS = [
  ["Machine learning algorithms improve over time", "ML models learn from training data"],
  ["Obsidian is a note-taking application", "Obsidian helps you organize your notes"],
  ["TypeScript adds types to JavaScript", "TS provides type safety for JS code"],
  ["Git tracks changes to source code", "Version control systems like git manage code history"],
  ["Python is popular for data science", "Data scientists often use Python programming"],
];

const DISSIMILAR_PAIRS = [
  ["Machine learning algorithms improve over time", "The recipe calls for two cups of flour"],
  ["Obsidian is a note-taking application", "The stock market closed higher today"],
  ["TypeScript adds types to JavaScript", "Ancient Rome was a powerful empire"],
  ["Git tracks changes to source code", "The weather forecast predicts rain"],
  ["Python is popular for data science", "My favorite color is blue"],
];

async function getEmbedding(model: string, text: string): Promise<{ embedding: number[]; duration: number }> {
  const start = performance.now();
  const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });
  const duration = performance.now() - start;
  const data = await res.json();
  return { embedding: data.embedding || [], duration };
}

async function getBatchEmbeddings(model: string, texts: string[]): Promise<{ embeddings: number[][]; duration: number }> {
  const start = performance.now();
  const res = await fetch(`${OLLAMA_HOST}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
  });
  const duration = performance.now() - start;
  const data = await res.json();
  return { embeddings: data.embeddings || [], duration };
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function benchmarkModel(model: string): Promise<EmbeddingResult> {
  console.log(`\n🧪 Testing ${model}...`);

  const result: EmbeddingResult = {
    model,
    dimension: 0,
    singleLatencyMs: [],
    batchLatencyMs: [],
    similarityScores: [],
  };

  // Single embedding latency (5 warm-up, 10 measured)
  const testText = "This is a test sentence for measuring embedding latency performance.";
  for (let i = 0; i < 15; i++) {
    const { embedding, duration } = await getEmbedding(model, testText);
    if (i === 0) result.dimension = embedding.length;
    if (i >= 5) {
      result.singleLatencyMs.push(duration);
      process.stdout.write(".");
    }
  }

  // Batch latency (batches of 8)
  const batchTexts = Array(8).fill(testText);
  for (let i = 0; i < 8; i++) {
    const { duration } = await getBatchEmbeddings(model, batchTexts);
    if (i >= 3) {
      result.batchLatencyMs.push(duration);
      process.stdout.write("B");
    }
  }

  // Semantic similarity tests
  for (const [text1, text2] of SIMILAR_PAIRS) {
    const [emb1, emb2] = await Promise.all([
      getEmbedding(model, text1),
      getEmbedding(model, text2),
    ]);
    const score = cosineSimilarity(emb1.embedding, emb2.embedding);
    result.similarityScores.push({
      pair: `${text1.slice(0, 30)}... vs ${text2.slice(0, 30)}...`,
      score,
      expected: "high",
    });
    process.stdout.write(score > 0.7 ? "✓" : "✗");
  }

  for (const [text1, text2] of DISSIMILAR_PAIRS) {
    const [emb1, emb2] = await Promise.all([
      getEmbedding(model, text1),
      getEmbedding(model, text2),
    ]);
    const score = cosineSimilarity(emb1.embedding, emb2.embedding);
    result.similarityScores.push({
      pair: `${text1.slice(0, 30)}... vs ${text2.slice(0, 30)}...`,
      score,
      expected: "low",
    });
    process.stdout.write(score < 0.5 ? "✓" : "✗");
  }

  console.log();
  return result;
}

function calculateMetrics(result: EmbeddingResult) {
  const singleLat = result.singleLatencyMs.sort((a, b) => a - b);
  const batchLat = result.batchLatencyMs.sort((a, b) => a - b);

  const p50Single = singleLat[Math.floor(singleLat.length * 0.5)] || 0;
  const p95Single = singleLat[Math.floor(singleLat.length * 0.95)] || 0;
  const meanSingle = singleLat.reduce((a, b) => a + b, 0) / singleLat.length || 0;

  const p50Batch = batchLat[Math.floor(batchLat.length * 0.5)] || 0;
  const meanBatch = batchLat.reduce((a, b) => a + b, 0) / batchLat.length || 0;

  const highSim = result.similarityScores.filter((s) => s.expected === "high");
  const lowSim = result.similarityScores.filter((s) => s.expected === "low");

  const avgHighSim = highSim.reduce((a, b) => a + b.score, 0) / highSim.length || 0;
  const avgLowSim = lowSim.reduce((a, b) => a + b.score, 0) / lowSim.length || 0;
  const separation = avgHighSim - avgLowSim;

  // Accuracy: high pairs > 0.7, low pairs < 0.5
  const highCorrect = highSim.filter((s) => s.score > 0.7).length;
  const lowCorrect = lowSim.filter((s) => s.score < 0.5).length;
  const accuracy = (highCorrect + lowCorrect) / (highSim.length + lowSim.length);

  return {
    dimension: result.dimension,
    latency: {
      single: { p50: p50Single, p95: p95Single, mean: meanSingle },
      batch8: { p50: p50Batch, mean: meanBatch, perItem: meanBatch / 8 },
    },
    semantic: {
      avgHighSim,
      avgLowSim,
      separation,
      accuracy,
    },
    memoryPerChunk: result.dimension * 4, // Float32
  };
}

async function main() {
  console.log("🔬 Embedding Model Benchmark");
  console.log("=".repeat(80));
  console.log(`Ollama Host: ${OLLAMA_HOST}`);
  console.log(`Models: ${MODELS.join(", ")}`);
  console.log(`Similar pairs: ${SIMILAR_PAIRS.length}, Dissimilar pairs: ${DISSIMILAR_PAIRS.length}`);

  const results: EmbeddingResult[] = [];

  for (const model of MODELS) {
    results.push(await benchmarkModel(model));
  }

  console.log("\n" + "=".repeat(80));
  console.log("BENCHMARK RESULTS");
  console.log("=".repeat(80));

  const metricsTable: Record<string, ReturnType<typeof calculateMetrics>> = {};

  for (const result of results) {
    const metrics = calculateMetrics(result);
    metricsTable[result.model] = metrics;

    console.log(`\n📊 ${result.model}`);
    console.log("-".repeat(60));
    console.log(`  Dimension:     ${metrics.dimension}d`);
    console.log(`  Single Query:  p50=${metrics.latency.single.p50.toFixed(0)}ms  p95=${metrics.latency.single.p95.toFixed(0)}ms`);
    console.log(`  Batch (8):     total=${metrics.latency.batch8.mean.toFixed(0)}ms  per-item=${metrics.latency.batch8.perItem.toFixed(0)}ms`);
    console.log(`  Similarity:    high=${metrics.semantic.avgHighSim.toFixed(3)}  low=${metrics.semantic.avgLowSim.toFixed(3)}  sep=${metrics.semantic.separation.toFixed(3)}`);
    console.log(`  Accuracy:      ${(metrics.semantic.accuracy * 100).toFixed(1)}%`);
    console.log(`  Memory/chunk:  ${metrics.memoryPerChunk} bytes`);
  }

  // Composite score (lower is better for latency, higher for accuracy)
  console.log("\n" + "=".repeat(80));
  console.log("RANKING (composite score)");
  console.log("=".repeat(80));

  const ranked = Object.entries(metricsTable)
    .map(([model, m]) => {
      // Composite: prioritize accuracy, then latency, then memory
      const latencyScore = 100 / (1 + m.latency.single.p50 / 10); // Faster = higher
      const accuracyScore = m.semantic.accuracy * 100;
      const separationScore = m.semantic.separation * 50;
      const memoryScore = 100 / (1 + m.memoryPerChunk / 1000); // Smaller = higher
      const composite = accuracyScore * 0.4 + separationScore * 0.3 + latencyScore * 0.2 + memoryScore * 0.1;
      return { model: model.split(":")[1] || model, metrics: m, composite };
    })
    .sort((a, b) => b.composite - a.composite);

  console.log("\nRank | Model          | Dim  | Latency | Accuracy | Separation | Composite");
  console.log("-".repeat(85));
  for (const [i, r] of ranked.entries()) {
    console.log(
      `  ${i + 1}  | ${r.model.padEnd(14)} | ${String(r.metrics.dimension).padStart(4)}d | ${r.metrics.latency.single.p50.toFixed(0).padStart(5)}ms | ${(r.metrics.semantic.accuracy * 100).toFixed(1).padStart(6)}% | ${r.metrics.semantic.separation.toFixed(3).padStart(10)} | ${r.composite.toFixed(1)}`
    );
  }

  // Save results
  const outputPath = "/home/akougkas/projects/notient/testbench/reranking/embedding-results.json";
  await Bun.write(
    outputPath,
    JSON.stringify({ timestamp: new Date().toISOString(), results, metrics: metricsTable, ranked }, null, 2)
  );
  console.log(`\n💾 Results saved to ${outputPath}`);
}

main().catch(console.error);
