# Chunking Strategies for Obsidian Vault RAG

## Overview
Chunking is the process of breaking down large documents into smaller, manageable pieces for embedding and retrieval. The quality of chunking directly impacts RAG performance.

## Key Chunking Methods

### 1. Token-Based Chunking
**Best for:** General-purpose chunking with consistent token limits

**Implementation:**
- Use `tiktoken` or similar tokenizers to count tokens accurately
- Set chunk size based on embedding model context window (typically 256-512 tokens)
- Use `RecursiveCharacterTextSplitter` with token-aware length function

**Example:**
```python
from langchain.text_splitter import RecursiveCharacterTextSplitter
import tiktoken

tokenizer = tiktoken.get_encoding("p50k_base")

def tiktoken_len(text: str) -> int:
    tokens = tokenizer.encode(text, disallowed_special=())
    return len(tokens)

splitter = RecursiveCharacterTextSplitter(
    chunk_size=400,
    length_function=tiktoken_len,
    separators=["\n\n", "\n", " ", ""]
)
```

**Key Points:**
- Token-based chunking ensures chunks fit within model limits
- Use appropriate separators hierarchy: paragraphs → sentences → words
- Prevents truncation mid-word or mid-sentence

### 2. Markdown-Aware Chunking
**Best for:** Obsidian vaults (markdown-heavy)

**Implementation:**
- Use `MarkdownHeaderTextSplitter` to respect document structure
- Split at heading boundaries (H1-H6)
- Preserve heading hierarchy in metadata

**Example:**
```python
from langchain.text_splitter import MarkdownHeaderTextSplitter

headers_to_split_on = [
    ("#", "#"),
    ("##", "##"),
    ("###", "###"),
    ("####", "####"),
    ("#####", "#####"),
    ("######", "######"),
]

md_splitter = MarkdownHeaderTextSplitter(
    headers_to_split_on=headers_to_split_on,
)
```

**Key Points:**
- Maintains semantic coherence by respecting document structure
- Headings provide natural boundaries for chunks
- Include heading path in chunk metadata for better context

### 3. Semantic Chunking
**Best for:** High-quality retrieval where semantic coherence matters

**Implementation:**
- Use embedding-based similarity to find natural breakpoints
- `RollingWindowSplitter` analyzes semantic similarity between sentences
- Splits occur when semantic similarity drops below threshold

**Key Points:**
- More computationally expensive but produces higher-quality chunks
- Better preserves meaning and context
- Reduces information loss at boundaries

### 4. Hybrid Approach
**Best for:** Production systems requiring balance of quality and performance

**Strategy:**
1. First pass: Markdown-aware splitting at headings
2. Second pass: Token-based splitting for large sections
3. Optional: Semantic refinement for critical documents

## Best Practices for Obsidian Vaults

### 1. Respect Document Structure
- **Small notes (<500 chars):** Keep as single chunk
- **Section-based notes:** Split at H1/H2 boundaries
- **Large sections (>1500 chars):** Further split at paragraph boundaries
- **Frontmatter:** Store as metadata, don't embed

### 2. Chunk Size Guidelines
- **Minimum:** 50 characters (avoid noise)
- **Optimal:** 256-512 tokens (balance context and precision)
- **Maximum:** 1500 characters (prevent information overload)
- **Small note threshold:** 500 characters (single chunk)

### 3. Metadata Preservation
Include in chunk metadata:
- **Document ID:** Unique identifier for parent document
- **Chunk index:** Position within document
- **Heading path:** Full heading hierarchy (e.g., ["# Guides", "## Data"])
- **File path:** Original file location
- **Tags:** From frontmatter
- **Last modified:** For incremental updates

### 4. ID Prefix Strategy
Use consistent ID patterns for document chunks:
- Format: `{doc_id}#chunk{index}` or `{doc_id}_chunk{index}`
- Enables easy retrieval of all chunks for a document
- Supports multi-level prefixes: `doc1#v1#chunk1` (versioning)

### 5. Overlap Strategy
- **No overlap:** Sufficient for semantic search on notes
- **If overlap needed:** 10-20% overlap for critical sections
- **Sentence-level overlap:** Prefer sentence boundaries over arbitrary positions

### 6. Quality Filtering
Filter out low-quality chunks:
- **HTML/XML fragments:** Non-readable content
- **Incomplete sentences:** Cut-off phrases
- **Non-English content:** If not relevant
- **PII detection:** Remove personally identifiable information
- **Empty/minimal chunks:** Below minimum threshold

### 7. Incremental Updates
- **Content hash:** Detect changes efficiently
- **Debounced updates:** Batch rapid changes
- **Selective re-indexing:** Only update changed chunks
- **Version tracking:** Support document versioning

## Chunking Pipeline for Obsidian

### Step 1: Parse Markdown
```python
def parse_markdown(file_path: string, content: string):
    # Extract frontmatter
    # Parse headings hierarchy
    # Identify sections
    # Return structured representation
```

### Step 2: Determine Chunking Strategy
```python
if total_content < SMALL_NOTE_THRESHOLD:
    return single_chunk
elif has_clear_headings:
    return markdown_aware_chunking
elif content_length > MAX_SECTION_SIZE:
    return hybrid_chunking
else:
    return semantic_chunking
```

### Step 3: Create Chunks
```python
for section in parsed_sections:
    if section.length > MAX_CHUNK_SIZE:
        sub_chunks = split_at_paragraphs(section)
    else:
        sub_chunks = [section]
    
    for chunk in sub_chunks:
        create_chunk(
            note_id=note_id,
            chunk_index=index,
            heading_path=section.headings,
            text=chunk.text,
            metadata={...}
        )
```

## Common Pitfalls to Avoid

1. **Arbitrary splitting:** Don't split mid-sentence or mid-thought
2. **Ignoring structure:** Markdown headings provide natural boundaries
3. **Too small chunks:** Lose context and meaning
4. **Too large chunks:** Dilute relevance and exceed context windows
5. **Missing metadata:** Heading paths and document context are crucial
6. **No quality checks:** Bad chunks pollute the index
7. **Static chunking:** Don't account for document-specific needs

## Performance Considerations

- **Batch processing:** Process multiple documents in batches
- **Parallel chunking:** Use multiprocessing for large vaults
- **Caching:** Cache parsed structures for unchanged documents
- **Incremental updates:** Only re-chunk modified sections

