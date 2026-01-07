# Reranking Strategies for Obsidian Vault RAG

## Overview
Reranking is a post-retrieval step that improves result quality by reordering candidates based on query relevance. It addresses the limitation that vector search may miss highly relevant documents that rank lower initially.

## Why Reranking Matters

### The Problem
1. **Vector search limitations:** Semantic similarity doesn't always align with query relevance
2. **Context stuffing:** Adding too many results to LLM context hurts performance
3. **Precision vs. Recall tradeoff:** High recall (many results) reduces precision

### The Solution
Reranking allows you to:
- **Retrieve more candidates** (e.g., top-25) with vector search
- **Rerank to top-N** (e.g., top-3) most relevant
- **Improve precision** without sacrificing recall
- **Reduce context window** while maintaining quality

## Reranking Architecture

### Two-Stage Retrieval Pipeline

```
Query → Vector Search (top-K=25) → Reranker (top-N=3) → LLM Context
```

**Benefits:**
- Fast first stage (vector search: <100ms)
- Smart second stage (reranking: ~500ms)
- Better final results

## Reranking Models

### 1. Cohere Rerank API

**Model:** `rerank-english-v2.0` (or newer)

**Characteristics:**
- **Free tier available**
- **High quality** reranking
- **Fast:** ~500ms for 25 documents
- **Easy integration**

**Usage:**
```python
import cohere

co = cohere.Client(api_key=COHERE_API_KEY)

rerank_docs = co.rerank(
    query=query,
    documents=documents,  # List of document texts
    top_n=3,  # Final number of results
    model="rerank-english-v2.0"
)

# Returns list of RerankResult objects
# Access: rerank_docs[0].document["text"]
```

**Key Points:**
- Takes query + list of documents
- Returns reordered list with relevance scores
- Works best with 10-50 initial candidates

### 2. Cross-Encoder Models

**Alternative approach:**
- Fine-tuned BERT models
- Cross-encoder architecture
- Higher quality but slower
- Requires hosting infrastructure

### 3. LLM-Based Reranking

**Using your reasoning LLM:**
- More flexible
- Can incorporate complex reasoning
- Slower but more capable
- Good for complex queries

**Example:**
```python
def rerank_with_llm(query, results, llm):
    # Format results with query
    prompt = build_rerank_prompt(query, results)
    
    # Get LLM ranking
    ranking = llm.generate(prompt)
    
    # Reorder results
    return reorder_by_ranking(results, ranking)
```

## Implementation Patterns

### 1. Basic Reranking

```python
def search_with_rerank(query, top_k=25, top_n=3):
    # Stage 1: Vector search
    vector_results = vector_search(query, top_k=top_k)
    
    # Extract document texts
    documents = [r["metadata"]["text"] for r in vector_results]
    
    # Stage 2: Rerank
    reranked = co.rerank(
        query=query,
        documents=documents,
        top_n=top_n,
        model="rerank-english-v2.0"
    )
    
    # Map back to original results
    doc_to_result = {r["metadata"]["text"]: r for r in vector_results}
    final_results = [
        doc_to_result[r.document["text"]] 
        for r in reranked
    ]
    
    return final_results
```

### 2. Reranking with Metadata

**Include metadata in reranking:**

```python
def rerank_with_metadata(query, results):
    # Build enhanced documents with metadata
    documents = []
    for r in results:
        doc_text = r["metadata"]["text"]
        title = r["metadata"].get("title", "")
        topic = r["metadata"].get("topic", "")
        
        # Enhance with metadata
        enhanced = f"Title: {title}\nTopic: {topic}\n\n{doc_text}"
        documents.append(enhanced)
    
    return co.rerank(query=query, documents=documents, top_n=3)
```

### 3. Conditional Reranking

**Only rerank when needed:**

```python
def smart_search(query, top_k=10, enable_rerank=True):
    results = vector_search(query, top_k=top_k)
    
    # Skip reranking for simple queries or small result sets
    if not enable_rerank or len(results) <= 3:
        return results[:3]
    
    # Rerank larger result sets
    if len(results) > 3:
        return rerank_results(query, results, top_n=3)
    
    return results
```

## Performance Considerations

### 1. Latency Tradeoffs

**Vector search:** ~50-100ms
**Reranking:** ~300-500ms (Cohere)
**Total:** ~400-600ms

**Optimization strategies:**
- Cache reranked results for common queries
- Parallel reranking for multiple queries
- Skip reranking for high-confidence results

### 2. Cost Management

**Cohere reranking:**
- Free tier available
- Pay-per-use pricing
- Monitor usage for large-scale systems

**Optimization:**
- Only rerank when necessary
- Cache results
- Batch operations when possible

### 3. When to Skip Reranking

**Skip reranking when:**
- Vector search confidence is very high
- Query is very simple
- Result set is small (<5 results)
- Latency requirements are strict

## Integration with Search Pipeline

### Complete Pipeline Example

```python
class SearchPipeline:
    def __init__(self, vector_store, reranker=None):
        self.vector_store = vector_store
        self.reranker = reranker
    
    async def search(self, query, top_k=25, top_n=3, enable_rerank=True):
        # Phase 1: Vector search (fast)
        vector_results = await self.vector_store.search(
            query, top_k=top_k
        )
        
        # Phase 2: Reranking (smart)
        if enable_rerank and self.reranker and len(vector_results) > top_n:
            reranked = await self.reranker.rerank(
                query=query,
                documents=vector_results,
                top_n=top_n
            )
            return reranked
        
        # Fallback: Return top-N from vector search
        return vector_results[:top_n]
```

## Evaluation Metrics

### 1. Precision Improvement

**Measure:**
- Precision@K before reranking
- Precision@K after reranking
- Improvement percentage

### 2. Relevance Scores

**Monitor:**
- Reranker confidence scores
- Score distribution
- Threshold analysis

### 3. User Satisfaction

**Track:**
- Click-through rates
- User feedback
- Task completion rates

## Best Practices

### 1. Optimal K and N Values

**Recommended:**
- **K (vector search):** 10-50 candidates
- **N (final results):** 3-10 results
- **Ratio:** K should be 3-5x larger than N

**Reasoning:**
- Too small K: Miss relevant documents
- Too large K: Wasted computation
- Optimal: Balance recall and efficiency

### 2. Query Enhancement

**Enhance queries before reranking:**
- Add context from conversation history
- Include user intent signals
- Expand with synonyms if needed

### 3. Result Diversity

**Consider diversity:**
- Avoid duplicate information
- Cover different aspects of query
- Balance relevance and diversity

### 4. Caching Strategy

**Cache reranked results:**
- Key: query + top_k
- TTL: Based on data update frequency
- Invalidate: When documents change

### 5. Error Handling

**Graceful degradation:**
```python
try:
    reranked = reranker.rerank(query, documents)
except Exception as e:
    # Fallback to vector search results
    logger.warning(f"Reranking failed: {e}")
    return vector_results[:top_n]
```

## Obsidian Vault Specific Considerations

### 1. Note-Level vs. Chunk-Level

**Strategy:**
- Rerank chunks first
- Then group by note
- Rerank notes if needed

### 2. Metadata Filtering

**Combine with metadata:**
- Filter by topic/tag before reranking
- Rerank within filtered set
- More efficient and relevant

### 3. Context Awareness

**Include vault context:**
- Recent notes
- Active tags
- Related folders
- Link graph information

## Common Pitfalls

1. **Reranking everything:** Only rerank when beneficial
2. **Ignoring vector search quality:** Good vector search still matters
3. **Too small K:** Missing relevant documents
4. **Too large K:** Wasted computation
5. **No caching:** Recomputing same queries
6. **Ignoring errors:** No fallback strategy
7. **Single-stage only:** Missing reranking benefits


