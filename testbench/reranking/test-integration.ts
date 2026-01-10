/**
 * Quick integration test for the dedicated Qwen3 reranker
 */

const OLLAMA_HOST = "http://192.168.86.249:11434";
const RERANKER_MODEL = "B-A-M-N/Qwen3-Reranker-4B";

const QWEN3_PROMPT = {
  system:
    'Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".',
  instruction: "Given a query, retrieve relevant passages that answer the query",
};

function buildQwen3Prompt(query: string, document: string): string {
  const maxDocLen = 2000;
  const truncatedDoc =
    document.length > maxDocLen ? document.slice(0, maxDocLen).trimEnd() + "..." : document;

  return `<|im_start|>system
${QWEN3_PROMPT.system}
<|im_end|>
<|im_start|>user
<Instruct>: ${QWEN3_PROMPT.instruction}
<Query>: ${query}
<Document>: ${truncatedDoc}
<|im_end|>
<|im_start|>assistant
<think>

</think>

`;
}

async function scoreDocument(query: string, document: string): Promise<{ score: number; response: string }> {
  const prompt = buildQwen3Prompt(query, document);

  const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: RERANKER_MODEL,
      prompt,
      stream: false,
      raw: true,
      options: { temperature: 0, num_predict: 5 },
    }),
  });

  const data = await response.json();
  const answer = (data.response || "").toLowerCase().trim();

  let score: number;
  if (answer.startsWith("yes")) {
    score = 1.0;
  } else if (answer.startsWith("no")) {
    score = 0.0;
  } else {
    score = 0.3;
  }

  return { score, response: data.response };
}

async function main() {
  console.log("🧪 Testing Qwen3 Reranker Integration");
  console.log("=".repeat(60));

  const testCases = [
    {
      query: "What is machine learning?",
      doc: "Machine learning is a subset of artificial intelligence that enables systems to learn from data.",
      expected: 1.0,
    },
    {
      query: "What is machine learning?",
      doc: "The weather forecast shows rain tomorrow with temperatures around 15 degrees.",
      expected: 0.0,
    },
    {
      query: "How to use Obsidian plugins?",
      doc: "Obsidian plugins extend functionality. Install them from Settings > Community plugins.",
      expected: 1.0,
    },
    {
      query: "How to use Obsidian plugins?",
      doc: "Python is a popular programming language used in data science.",
      expected: 0.0,
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    const { score, response } = await scoreDocument(tc.query, tc.doc);
    const isCorrect = score === tc.expected;

    if (isCorrect) {
      passed++;
      console.log(`✅ PASS: "${tc.query.slice(0, 30)}..." → ${response} (score=${score})`);
    } else {
      failed++;
      console.log(`❌ FAIL: "${tc.query.slice(0, 30)}..." → ${response} (score=${score}, expected=${tc.expected})`);
    }
  }

  console.log("=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed === 0) {
    console.log("\n✅ All tests passed! Reranker integration is working correctly.");
  } else {
    console.log("\n⚠️ Some tests failed. Check the reranker model and prompt format.");
  }
}

main().catch(console.error);
