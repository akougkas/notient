# Embedding Strategies for Obsidian Vault RAG

## Overview
Embeddings convert text chunks into dense vector representations that capture semantic meaning. The choice of embedding model and strategy significantly impacts retrieval quality.

## Embedding Model Selection

### 1. Model Characteristics

**OpenAI text-embedding-ada-002:**
- **Dimensions:** 1536
- **Metric:** Cosine or dotproduct
- **Strengths:** High quality, general-purpose, well-tested
- **Cost:** Pay-per-use (~$0.0001 per 1K tokens)
- **Best for:** Production systems with budget

**Cohere embed-english-v3.0:**
- **Dimensions:** 1024
- **Metric:** Cosine or dotproduct
- **Strengths:** Good quality, free tier available
- **Best for:** Cost-conscious applications

**Sentence Transformers (paraphrase-MiniLM-L6-v2):**
- **Dimensions:** 384
- **Metric:** Cosine
- **Strengths:** Fast, local, free
- **Best for:** Local/offline systems, large-scale indexing

### 2. Model Selection Criteria

Consider:
- **Quality vs. Cost:** Higher dimensions = better quality but more storage/compute
- **Latency requirements:** Local models faster but may sacrifice quality
- **Scale:** Cost implications for large vaults
- **Domain:** Some models better for specific domains

## Embedding Best Practices

### 1. Batch Processing
**Always embed in batches** for efficiency:

```python
batch_size = 100  # Optimal for most APIs

for i in range(0, len(chunks), batch_size):
    batch = chunks[i:i+batch_size]
    embeddings = embed_model.embed_documents(batch)
    # Upsert to vector DB
```

**Benefits:**
- Reduces API calls
- Better throughput
- Lower latency per chunk

### 2. Error Handling & Retries

**Implement exponential backoff:**

```python
def embed_with_retry(batch, max_retries=5):
    for j in range(max_retries):
        try:
            res = embed_model.embed_documents(batch)
            return res
        except RateLimitError:
            time.sleep(2**j)  # Exponential backoff
            print("Retrying...")
    raise RuntimeError("Failed to create embeddings")
```

### 3. Context Enhancement

**Include metadata in embeddings:**

```python
def build_chunk_with_context(title, heading_path, content):
    # Include document title and heading hierarchy
    context = f"Document: {title}\n"
    if heading_path:
        context += "Section: " + " > ".join(heading_path) + "\n"
    context += f"\n{content}"
    return context
```

**Benefits:**
- Better semantic understanding
- Improved retrieval relevance
- Context-aware embeddings

### 4. Hybrid Embedding Strategy

**For Obsidian vaults, consider:**

1. **Note-level embeddings:** Whole-note vectors for broad matching
2. **Section-level embeddings:** Heading-aware chunks for precise retrieval
3. **Both stored:** Enables flexible retrieval strategies

**Implementation:**
```python
# Note-level embedding
note_embedding = embed_model.embed_query(full_note_content)

# Section-level embeddings
for section in sections:
    section_embedding = embed_model.embed_query(
        build_chunk_with_context(title, section.headings, section.content)
    )
```

## Vector Database Configuration

### 1. Index Setup

**Dimensions:** Match embedding model exactly
```python
dimension = 1536  # For OpenAI ada-002
dimension = 1024  # For Cohere v3.0
dimension = 384   # For MiniLM
```

**Metric:** Choose based on model recommendation
- **Cosine:** Most common, good for normalized vectors
- **Dotproduct:** Alternative, works well with normalized vectors

**Spec:** Choose cloud provider and region
```python
spec = ServerlessSpec(
    cloud="aws",  # or "gcp", "azure"
    region="us-west-2"  # Choose closest to users
)
```

### 2. Metadata Storage

**Store rich metadata:**
```python
metadata = {
    "filename": file_path,
    "title": note_title,
    "topic": classified_topic,  # From TLM classification
    "chunk_index": chunk_index,
    "total_chunks": total_chunks,
    "heading_path": heading_path,
    "tags": tags,
    "last_modified": mtime,
    "text": chunk_text[:1000]  # First 1000 chars for preview
}
```

**Benefits:**
- Enables metadata filtering
- Provides context in retrieval
- Supports document-level operations

### 3. Upsert Strategy

**Batch upserts:**
```python
batch_size = 100
vectors = []

for i, (chunk, embedding, metadata) in enumerate(zip(chunks, embeddings, metadatas)):
    vectors.append({
        "id": f"{doc_id}#chunk{i}",
        "values": embedding,
        "metadata": metadata
    })
    
    if len(vectors) >= batch_size:
        index.upsert(vectors=vectors)
        vectors = []

if vectors:
    index.upsert(vectors=vectors)
```

## Embedding Quality Considerations

### 1. Chunk Quality Impact

**Low-quality chunks degrade embeddings:**
- HTML fragments → meaningless vectors
- Incomplete sentences → poor semantic capture
- PII → privacy concerns
- Non-English → if not expected

**Solution:** Filter before embedding (see chunker.md)

### 2. Context Window Limits

**Respect model limits:**
- Most models: 512-8192 tokens
- Truncation loses information
- Use token-aware chunking

### 3. Normalization

**Most embedding models produce normalized vectors:**
- Length = 1.0 (unit vectors)
- Enables cosine similarity
- Dotproduct equivalent to cosine for normalized vectors

## Query Embedding

### 1. Query Enhancement

**Enhance queries with context:**

```python
def embed_query(query, vault_context=None):
    if vault_context:
        enhanced_query = f"Context: {vault_context}\nQuery: {query}"
    else:
        enhanced_query = query
    return embed_model.embed_query(enhanced_query)
```

### 2. Query vs. Document Embeddings

**Use same model for both:**
- Ensures compatibility
- Same semantic space
- Consistent similarity scores

## Performance Optimization

### 1. Caching

**Cache embeddings:**
- Unchanged documents don't need re-embedding
- Use content hash to detect changes
- Cache embeddings locally if using local models

### 2. Parallel Processing

**Parallelize embedding:**
```python
from concurrent.futures import ThreadPoolExecutor

def embed_batch(batch):
    return embed_model.embed_documents(batch)

with ThreadPoolExecutor(max_workers=4) as executor:
    embeddings = executor.map(embed_batch, batches)
```

### 3. Incremental Updates

**Only re-embed changed chunks:**
- Track content hashes
- Compare before embedding
- Update only modified chunks

## Cost Management

### 1. API Costs

**Monitor usage:**
- OpenAI: ~$0.0001 per 1K tokens
- Large vaults: Can be expensive
- Consider local models for bulk operations

### 2. Optimization Strategies

- **Batch efficiently:** Maximize batch sizes
- **Cache aggressively:** Avoid re-embedding
- **Filter early:** Remove bad chunks before embedding
- **Use local models:** For large-scale operations

## Evaluation Metrics

### 1. Embedding Quality

**Measure:**
- Retrieval precision/recall
- Semantic similarity scores
- Query-document relevance

### 2. Index Health

**Monitor:**
- Total vectors indexed
- Index fullness
- Query latency
- Storage usage

## Best Practices Summary

1. **Choose appropriate model** for your use case and budget
2. **Batch all operations** for efficiency
3. **Include context** in embeddings (titles, headings)
4. **Store rich metadata** for filtering and context
5. **Handle errors gracefully** with retries
6. **Filter before embedding** to avoid polluting index
7. **Cache aggressively** to reduce costs
8. **Monitor costs** especially with paid APIs
9. **Use consistent models** for queries and documents
10. **Implement incremental updates** for efficiency

