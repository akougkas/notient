# Reranker Model Benchmark Analysis

## Summary

**Winner: `B-A-M-N/Qwen3-Reranker-4B`**

| Model | F1 | Accuracy | Precision | Latency | Score Sep |
|-------|----|---------:|----------:|--------:|----------:|
| **Qwen3-Reranker-4B** | **80%** | 83.3% | **100%** | 75ms | **0.667** |
| qwen3-reranker-0.6b-fp16 | 72% | 76.7% | 90% | 79ms | 0.333 |
| bge-reranker-v2-m3 | 67% | 50.0% | 50% | 63ms | 0.060 |

## Key Findings

### 1. Qwen3-Reranker-4B is the Clear Winner

- **100% Precision**: Never classifies irrelevant docs as relevant (critical for search quality)
- **Best Score Separation**: 0.667 gap between relevant (0.667) and irrelevant (0.000) scores
- **Similar Latency**: ~75ms warm, comparable to smaller models
- **Best Accuracy**: 83.3% correct classifications

### 2. BGE Reranker Doesn't Work via Embeddings

The BGE model achieves only 50% accuracy (coin flip) because:
- Using embedding similarity doesn't capture semantic relevance well
- Score separation is only 0.060 (relevant: 0.964, irrelevant: 0.905)
- Both relevant and irrelevant docs get high similarity scores

### 3. Qwen3 0.6B is a Viable Lightweight Alternative

- Good F1 (72%) with 90% precision
- Slightly faster cold start than 4B variant
- Could be used for high-throughput scenarios where accuracy trade-off is acceptable

## Recommendation

Lock the reranker model to **`B-A-M-N/Qwen3-Reranker-4B`** for the following reasons:

1. **Quality over speed**: 75ms latency is acceptable for reranking top-k results
2. **Zero false positives**: 100% precision means users won't see irrelevant results ranked high
3. **Clear score separation**: Easy to set threshold for filtering
4. **Production ready**: Consistent behavior across test cases

## Implementation Notes

### Prompt Format (Qwen3)

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

### Scoring

- Response contains "yes" → score = 1.0
- Response contains "no" → score = 0.0
- Use temperature=0 for deterministic output
- Limit output tokens to ~10 for speed

### Integration Strategy

1. Keep embedding search for initial retrieval (fast, uses existing index)
2. Apply Qwen3-Reranker-4B to top-k results (e.g., top 20)
3. Re-sort by reranker score
4. Return top-n to user

This two-stage approach combines speed (embeddings) with accuracy (reranker).
