# Notient Model Specifications & Benchmark Results

## Summary: Optimal Model Stack

| Role | Model | Provider | Key Specs |
|------|-------|----------|-----------|
| **Reranking** | `B-A-M-N/Qwen3-Reranker-4B` | Ollama | 4B params, Q4_K_M, **LOCKED** |
| **Embedding** | `qwen3-embedding:0.6b` | Ollama | 1024d, 32k ctx, 100% accuracy |
| **Chat/Reasoning** | `falcon-h1r-7b` | LM Studio | 7B params, hybrid |

---

## 1. Reranking Models (Ollama)

### Benchmark Results

| Model | F1 | Accuracy | Precision | Latency | Score Sep |
|-------|----|---------:|----------:|--------:|----------:|
| **Qwen3-Reranker-4B** | **80%** | 83.3% | **100%** | 75ms | **0.667** |
| qwen3-reranker-0.6b-fp16 | 72% | 76.7% | 90% | 79ms | 0.333 |
| bge-reranker-v2-m3 | 67% | 50.0% | 50% | 63ms | 0.060 |

### Winner: `B-A-M-N/Qwen3-Reranker-4B`

**Why:**
- **100% Precision**: Never promotes irrelevant docs (critical for search quality)
- **Best separation**: 0.667 gap between relevant/irrelevant (easy threshold setting)
- **Similar latency**: ~75ms warm (comparable to smaller models)
- **Perfect for top-k reranking**: Apply to top 20-30 vector results

**API Format (Qwen3):**
```
<|im_start|>system
Judge whether the Document meets the requirements based on the Query and the Instruct provided.
Note that the answer can only be "yes" or "no".
<|im_end|>
<|im_start|>user
<Instruct>: {instruction}
<Query>: {query}
<Document>: {document}
<|im_end|>
<|im_start|>assistant
<think>

</think>

```

**Scoring**: Parse "yes" → 1.0, "no" → 0.0

---

## 2. Embedding Models (Ollama)

### Benchmark Results

| Model | Dim | Latency | Accuracy | Separation | Memory/chunk |
|-------|----:|--------:|---------:|-----------:|-------------:|
| **qwen3-embedding:0.6b** | 1024d | 44ms | **100%** | **0.464** | 4096B |
| granite-embedding:30m | 384d | **20ms** | 80% | 0.326 | **1536B** |
| granite-embedding:278m | 768d | 57ms | 70% | 0.339 | 3072B |

### Winner: `qwen3-embedding:0.6b`

**Why:**
- **100% accuracy**: Perfect discrimination between similar/dissimilar pairs
- **Best separation**: 0.464 (vs 0.326 for granite-30m)
- **32k context**: Handles long documents without truncation
- **Acceptable latency**: 44ms single, 16ms/item in batch

**Trade-off**:
- Larger dimension (1024 vs 384) = 2.7x more memory per chunk
- For 53k chunks: ~217MB vs ~80MB index size
- Worth it for the quality improvement

**Alternative for constrained systems**: `granite-embedding:30m`
- Ultra-fast (20ms)
- 80% accuracy is decent
- Smallest memory footprint

---

## 3. Chat/Reasoning Models (LM Studio)

### Available Models

| Model | Size | Use Case |
|-------|------|----------|
| **falcon-h1r-7b** | 7B | Primary chat/reasoning |
| qwen3-14b | 14B | High quality, slower |
| qwen3-8b | 8B | Balanced alternative |
| qwen3-4b | 4B | Fast, lower quality |
| ibm/granite-4-h-small | ~2B | Ultra-fast responses |
| mistralai/ministral-3-8b | 8B | Good general purpose |

### Current Selection: `falcon-h1r-7b`

**Why:**
- Good balance of speed and quality
- Already configured and working
- Hybrid architecture optimized for reasoning

---

## 4. Model Compatibility Matrix

### Embedding ↔ Reranker Independence

✅ **Embeddings and rerankers are independent** - they don't share state.

| Component | Input | Output | Notes |
|-----------|-------|--------|-------|
| Embedding | Text | Float vector (Nd) | Used for initial retrieval |
| Reranker | Query + Document text | Relevance score (0-1) | Used for final ordering |

**Flow:**
1. **Initial retrieval**: Embed query → cosine similarity → top-k candidates
2. **Reranking**: Pass top-k texts to reranker → sort by relevance score
3. **No dimension dependency**: Reranker sees raw text, not vectors

### Index Compatibility

⚠️ **Changing embedding model requires re-indexing**

| Current Model | Index File | Dimension |
|---------------|------------|-----------|
| granite-embedding:30m | `idx_*_granite-embedding_30m_d384_*.json` | 384 |

Switching to `qwen3-embedding:0.6b` requires:
1. Delete existing index
2. Re-run full indexing (53k+ chunks)
3. Index will be ~3x larger (1024d vs 384d)

---

## 5. Recommended Configuration

### For New Installations (Optimal Quality)

```json
{
  "ollama": {
    "host": "http://192.168.86.249:11434",
    "embeddingModel": "qwen3-embedding:0.6b",
    "rerankModel": "B-A-M-N/Qwen3-Reranker-4B"
  },
  "lmstudio": {
    "host": "http://192.168.86.249:1234",
    "reasoningModel": "falcon-h1r-7b"
  }
}
```

### For Existing Installation (Keep Current Index)

```json
{
  "ollama": {
    "host": "http://192.168.86.249:11434",
    "embeddingModel": "granite-embedding:30m",
    "rerankModel": "B-A-M-N/Qwen3-Reranker-4B"
  },
  "lmstudio": {
    "host": "http://192.168.86.249:1234",
    "reasoningModel": "falcon-h1r-7b"
  }
}
```

---

## 6. Implementation Notes

### Current Gap: No Dedicated Reranker Integration

The current codebase uses LM Studio's chat model for reranking via JSON prompts:
- **File**: `src/core/llm/providers/openai-compatible.ts:308-339`
- **Problem**: Slow, unreliable JSON parsing, generic prompts

**Needed Change**: Add dedicated Qwen3 reranker via Ollama API
- Use Ollama `/api/generate` endpoint
- Apply Qwen3 yes/no prompt format
- Parse binary response for relevance scoring

### Memory Estimates

| Embedding Model | 50k chunks | 100k chunks |
|-----------------|------------|-------------|
| granite-30m (384d) | ~80MB | ~160MB |
| qwen3-0.6b (1024d) | ~210MB | ~420MB |
| granite-278m (768d) | ~160MB | ~320MB |

---

## 7. Raw Benchmark Data

- Reranker results: `testbench/reranking/results.json`
- Embedding results: `testbench/reranking/embedding-results.json`
- Benchmark scripts: `testbench/reranking/benchmark.ts`, `embedding-benchmark.ts`
