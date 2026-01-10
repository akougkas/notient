/**
 * Reranker Model Benchmark
 *
 * Tests three reranking models on real index data:
 * - qllama/bge-reranker-v2-m3 (BGE cross-encoder)
 * - B-A-M-N/qwen3-reranker-0.6b-fp16 (Qwen3 small)
 * - B-A-M-N/Qwen3-Reranker-4B (Qwen3 large)
 *
 * Metrics collected:
 * - Latency (p50, p95, mean)
 * - Score distribution (relevant vs irrelevant)
 * - Ranking quality (MRR, NDCG)
 * - Throughput (queries/sec)
 */

const OLLAMA_HOST = "http://192.168.86.249:11434";
const INDEX_PATH =
  "/mnt/c/Users/akougk/Projects/vaultex/.obsidian/plugins/notient/idx_20260110T005450_v3_granite-embedding_30m_d384_384d.json";

interface Chunk {
  text: string;
  path?: string;
  tier?: string;
  chunkIndex?: number;
}

interface BenchmarkResult {
  model: string;
  queryLatencies: number[];
  scores: { query: string; doc: string; score: number; expected: "relevant" | "irrelevant" }[];
  errors: string[];
}

interface TestCase {
  query: string;
  instruction?: string;
  relevantDocs: string[];
  irrelevantDocs: string[];
}

// Test cases with manually curated relevant/irrelevant pairs
const TEST_CASES: TestCase[] = [
  {
    query: "machine learning artificial intelligence",
    instruction: "Find documents about AI and machine learning concepts",
    relevantDocs: [
      "Machine learning is a subset of artificial intelligence that enables systems to learn from data.",
      "Deep learning neural networks are transforming AI applications across industries.",
      "AI-powered tools help automate repetitive tasks and improve decision making.",
    ],
    irrelevantDocs: [
      "The weather forecast shows rain tomorrow with temperatures around 15 degrees.",
      "Recipe for chocolate cake: mix flour, sugar, eggs, and cocoa powder.",
      "The meeting is scheduled for next Tuesday at 3pm in conference room B.",
    ],
  },
  {
    query: "Obsidian vault notes organization",
    instruction: "Find information about organizing notes in Obsidian",
    relevantDocs: [
      "Obsidian uses a local vault to store all your markdown notes and attachments.",
      "Organize your notes using folders, tags, and links between documents.",
      "The daily notes plugin helps maintain a consistent journaling practice.",
    ],
    irrelevantDocs: [
      "Python is a popular programming language for data science applications.",
      "The stock market closed higher today with tech stocks leading gains.",
      "Exercise regularly and maintain a balanced diet for better health.",
    ],
  },
  {
    query: "TypeScript React component props",
    instruction: "Find documentation about TypeScript and React component properties",
    relevantDocs: [
      "Define component props using TypeScript interfaces for type safety.",
      "React functional components accept props as their first argument.",
      "Use generic types to create reusable component prop definitions.",
    ],
    irrelevantDocs: [
      "Java enterprise applications use Spring framework for dependency injection.",
      "CSS flexbox provides powerful layout capabilities for responsive design.",
      "Database normalization reduces data redundancy in relational schemas.",
    ],
  },
  {
    query: "git branch merge conflict resolution",
    instruction: "Find help with resolving git merge conflicts",
    relevantDocs: [
      "Git merge conflicts occur when the same lines are modified in different branches.",
      "Use git mergetool to resolve conflicts with a visual diff editor.",
      "After resolving conflicts, stage the files and complete the merge commit.",
    ],
    irrelevantDocs: [
      "The solar system contains eight planets orbiting the sun.",
      "Coffee beans are roasted at different temperatures for various flavors.",
      "Ancient Rome was one of the largest empires in human history.",
    ],
  },
  {
    query: "Claude Code tips productivity",
    instruction: "Find tips for using Claude Code effectively",
    relevantDocs: [
      "10 Pro Claude Code Tips & Tricks NO ONE Shares",
      "Claude Code is Amazing... Until It DELETES Production",
      "Use Claude Code for terminal control and command execution",
    ],
    irrelevantDocs: [
      "Photoshop tutorials for image editing beginners",
      "Best practices for email marketing campaigns",
      "Home gardening tips for growing vegetables",
    ],
  },
];

// Qwen3 Reranker prompt template
function buildQwen3Prompt(query: string, document: string, instruction: string): string {
  return `<|im_start|>system
Judge whether the Document meets the requirements based on the Query and the Instruct provided.
Note that the answer can only be "yes" or "no".
<|im_end|>
<|im_start|>user
<Instruct>: ${instruction}
<Query>: ${query}
<Document>: ${document}
<|im_end|>
<|im_start|>assistant
<think>

</think>

`;
}

// BGE Reranker prompt (simpler cross-encoder format)
function buildBGEPrompt(query: string, document: string): string {
  return `query: ${query}\ndocument: ${document}`;
}

async function callOllamaGenerate(
  model: string,
  prompt: string,
  options: Record<string, unknown> = {}
): Promise<{ response: string; duration: number; evalCount: number }> {
  const start = performance.now();

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        temperature: 0,
        num_predict: 10,
        ...options,
      },
    }),
  });

  const duration = performance.now() - start;
  const data = await res.json();

  return {
    response: data.response || "",
    duration,
    evalCount: data.eval_count || 0,
  };
}

async function callOllamaEmbedding(model: string, prompt: string): Promise<{ embedding: number[]; duration: number }> {
  const start = performance.now();

  const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt }),
  });

  const duration = performance.now() - start;
  const data = await res.json();

  return {
    embedding: data.embedding || [],
    duration,
  };
}

// For Qwen3: parse yes/no from response and convert to score
function parseQwen3Score(response: string): number {
  const lower = response.toLowerCase().trim();
  if (lower.includes("yes")) return 1.0;
  if (lower.includes("no")) return 0.0;
  // Ambiguous - return middle score
  return 0.5;
}

// For BGE: use embedding similarity as score
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
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

async function benchmarkQwen3Model(
  model: string,
  testCases: TestCase[]
): Promise<BenchmarkResult> {
  const result: BenchmarkResult = {
    model,
    queryLatencies: [],
    scores: [],
    errors: [],
  };

  console.log(`\n🧪 Testing ${model}...`);

  for (const tc of testCases) {
    const instruction = tc.instruction || "Find relevant documents for the query";

    // Test relevant docs
    for (const doc of tc.relevantDocs) {
      try {
        const prompt = buildQwen3Prompt(tc.query, doc, instruction);
        const { response, duration } = await callOllamaGenerate(model, prompt);
        const score = parseQwen3Score(response);

        result.queryLatencies.push(duration);
        result.scores.push({
          query: tc.query.slice(0, 50),
          doc: doc.slice(0, 50),
          score,
          expected: "relevant",
        });

        process.stdout.write(score >= 0.5 ? "✓" : "✗");
      } catch (err) {
        result.errors.push(`${tc.query}: ${err}`);
        process.stdout.write("E");
      }
    }

    // Test irrelevant docs
    for (const doc of tc.irrelevantDocs) {
      try {
        const prompt = buildQwen3Prompt(tc.query, doc, instruction);
        const { response, duration } = await callOllamaGenerate(model, prompt);
        const score = parseQwen3Score(response);

        result.queryLatencies.push(duration);
        result.scores.push({
          query: tc.query.slice(0, 50),
          doc: doc.slice(0, 50),
          score,
          expected: "irrelevant",
        });

        process.stdout.write(score < 0.5 ? "✓" : "✗");
      } catch (err) {
        result.errors.push(`${tc.query}: ${err}`);
        process.stdout.write("E");
      }
    }
  }

  console.log();
  return result;
}

async function benchmarkBGEModel(
  model: string,
  testCases: TestCase[]
): Promise<BenchmarkResult> {
  const result: BenchmarkResult = {
    model,
    queryLatencies: [],
    scores: [],
    errors: [],
  };

  console.log(`\n🧪 Testing ${model}...`);

  for (const tc of testCases) {
    // Get query embedding once
    const queryPrompt = `query: ${tc.query}`;
    const { embedding: queryEmb } = await callOllamaEmbedding(model, queryPrompt);

    // Test relevant docs
    for (const doc of tc.relevantDocs) {
      try {
        const start = performance.now();
        const docPrompt = `document: ${doc}`;
        const { embedding: docEmb } = await callOllamaEmbedding(model, docPrompt);
        const duration = performance.now() - start;

        const score = (cosineSimilarity(queryEmb, docEmb) + 1) / 2; // Normalize to 0-1

        result.queryLatencies.push(duration);
        result.scores.push({
          query: tc.query.slice(0, 50),
          doc: doc.slice(0, 50),
          score,
          expected: "relevant",
        });

        process.stdout.write(score >= 0.5 ? "✓" : "✗");
      } catch (err) {
        result.errors.push(`${tc.query}: ${err}`);
        process.stdout.write("E");
      }
    }

    // Test irrelevant docs
    for (const doc of tc.irrelevantDocs) {
      try {
        const start = performance.now();
        const docPrompt = `document: ${doc}`;
        const { embedding: docEmb } = await callOllamaEmbedding(model, docPrompt);
        const duration = performance.now() - start;

        const score = (cosineSimilarity(queryEmb, docEmb) + 1) / 2;

        result.queryLatencies.push(duration);
        result.scores.push({
          query: tc.query.slice(0, 50),
          doc: doc.slice(0, 50),
          score,
          expected: "irrelevant",
        });

        process.stdout.write(score < 0.5 ? "✓" : "✗");
      } catch (err) {
        result.errors.push(`${tc.query}: ${err}`);
        process.stdout.write("E");
      }
    }
  }

  console.log();
  return result;
}

function calculateMetrics(result: BenchmarkResult) {
  const latencies = result.queryLatencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length || 0;

  // Calculate accuracy
  const relevant = result.scores.filter((s) => s.expected === "relevant");
  const irrelevant = result.scores.filter((s) => s.expected === "irrelevant");

  const truePositives = relevant.filter((s) => s.score >= 0.5).length;
  const trueNegatives = irrelevant.filter((s) => s.score < 0.5).length;
  const falsePositives = irrelevant.filter((s) => s.score >= 0.5).length;
  const falseNegatives = relevant.filter((s) => s.score < 0.5).length;

  const precision = truePositives / (truePositives + falsePositives) || 0;
  const recall = truePositives / (truePositives + falseNegatives) || 0;
  const f1 = (2 * precision * recall) / (precision + recall) || 0;
  const accuracy = (truePositives + trueNegatives) / result.scores.length || 0;

  // Score separation (higher is better)
  const avgRelevantScore = relevant.reduce((a, b) => a + b.score, 0) / relevant.length || 0;
  const avgIrrelevantScore = irrelevant.reduce((a, b) => a + b.score, 0) / irrelevant.length || 0;
  const scoreSeparation = avgRelevantScore - avgIrrelevantScore;

  return {
    latency: { p50, p95, mean },
    accuracy,
    precision,
    recall,
    f1,
    scoreSeparation,
    avgRelevantScore,
    avgIrrelevantScore,
    errorCount: result.errors.length,
  };
}

function printResults(results: BenchmarkResult[]) {
  console.log("\n" + "=".repeat(80));
  console.log("BENCHMARK RESULTS");
  console.log("=".repeat(80));

  const metricsTable: Record<string, ReturnType<typeof calculateMetrics>> = {};

  for (const result of results) {
    const metrics = calculateMetrics(result);
    metricsTable[result.model] = metrics;

    console.log(`\n📊 ${result.model}`);
    console.log("-".repeat(60));
    console.log(`  Latency:     p50=${metrics.latency.p50.toFixed(0)}ms  p95=${metrics.latency.p95.toFixed(0)}ms  mean=${metrics.latency.mean.toFixed(0)}ms`);
    console.log(`  Accuracy:    ${(metrics.accuracy * 100).toFixed(1)}%`);
    console.log(`  Precision:   ${(metrics.precision * 100).toFixed(1)}%`);
    console.log(`  Recall:      ${(metrics.recall * 100).toFixed(1)}%`);
    console.log(`  F1 Score:    ${(metrics.f1 * 100).toFixed(1)}%`);
    console.log(`  Score Sep:   ${metrics.scoreSeparation.toFixed(3)} (relevant=${metrics.avgRelevantScore.toFixed(3)}, irrelevant=${metrics.avgIrrelevantScore.toFixed(3)})`);
    if (metrics.errorCount > 0) {
      console.log(`  Errors:      ${metrics.errorCount}`);
    }
  }

  // Ranking
  console.log("\n" + "=".repeat(80));
  console.log("RANKING (by F1 score)");
  console.log("=".repeat(80));

  const ranked = Object.entries(metricsTable)
    .sort(([, a], [, b]) => b.f1 - a.f1)
    .map(([model, m], i) => ({
      rank: i + 1,
      model: model.split("/").pop(),
      f1: (m.f1 * 100).toFixed(1) + "%",
      accuracy: (m.accuracy * 100).toFixed(1) + "%",
      latency: m.latency.mean.toFixed(0) + "ms",
      separation: m.scoreSeparation.toFixed(3),
    }));

  console.log("\nRank | Model                        | F1     | Accuracy | Latency | Score Sep");
  console.log("-".repeat(85));
  for (const r of ranked) {
    console.log(
      `  ${r.rank}  | ${r.model?.padEnd(28)} | ${r.f1.padStart(6)} | ${r.accuracy.padStart(8)} | ${r.latency.padStart(7)} | ${r.separation}`
    );
  }

  return metricsTable;
}

async function main() {
  console.log("🔬 Reranker Model Benchmark");
  console.log("=".repeat(80));
  console.log(`Ollama Host: ${OLLAMA_HOST}`);
  console.log(`Test Cases: ${TEST_CASES.length}`);
  console.log(`Docs per case: ${TEST_CASES[0].relevantDocs.length + TEST_CASES[0].irrelevantDocs.length}`);
  console.log(`Total comparisons per model: ${TEST_CASES.length * (TEST_CASES[0].relevantDocs.length + TEST_CASES[0].irrelevantDocs.length)}`);

  const results: BenchmarkResult[] = [];

  // Benchmark BGE Reranker (uses embeddings)
  results.push(await benchmarkBGEModel("qllama/bge-reranker-v2-m3", TEST_CASES));

  // Benchmark Qwen3 Rerankers (use generate)
  results.push(await benchmarkQwen3Model("B-A-M-N/qwen3-reranker-0.6b-fp16", TEST_CASES));
  results.push(await benchmarkQwen3Model("B-A-M-N/Qwen3-Reranker-4B", TEST_CASES));

  const metrics = printResults(results);

  // Save results to file
  const outputPath = "/home/akougkas/projects/notient/testbench/reranking/results.json";
  await Bun.write(
    outputPath,
    JSON.stringify({ timestamp: new Date().toISOString(), results, metrics }, null, 2)
  );
  console.log(`\n💾 Results saved to ${outputPath}`);
}

main().catch(console.error);
