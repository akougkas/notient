# Notient Phase 4.6 - GraphRAG Reasoning Engine

> Source studied: `.planning/graph-rag-survey.pdf`, "Graph Retrieval-Augmented Generation: A Survey", Peng et al., ACM Transactions on Information Systems 44(2), Article 35, December 2025, https://doi.org/10.1145/3777378.

## Executive Summary

Phase 4.6 is the GraphRAG reasoning upgrade for Notient.

Phase 4 ships the user-facing surfaces: Stream, Vitals, Search, Chat, graph bridge, canvas, undo.
Phase 4.5 ships the compounding intelligence layer: Source Ledger, Source Spans, durable artifacts, Atlas, Activity Log, Memory Lint, Bases exports.
Phase 4.6 should then teach Notient how to retrieve and reason over the vault as a graph, not just as a bag of chunks.

The survey's strongest lesson is simple: normal RAG fails in knowledge vaults because it ignores relationships, repeats redundant chunks, and struggles with global questions. GraphRAG fixes this by making retrieval explicitly structural: retrieve nodes, edges, paths, subgraphs, and community summaries, then serialize that graph context into a compact evidence packet the model can reason over.

Notient already has most raw ingredients:

- `notes`, `chunks`, `embeddings`
- `graph_nodes` and `graph_edges`
- approved and staged relations
- HNSW vector search
- DBSCAN note clustering
- Linker, Synthesizer, ContradictionHunter
- Phase 4 planned Search and Chat surfaces
- Phase 4.5 planned Source Ledger, Source Spans, Atlas, artifact store

What Notient does not yet have is the GraphRAG middle layer:

- query planning
- entity linking
- path and subgraph retrieval
- community-summary retrieval
- graph-aware pruning
- a compact graph serialization language
- retrieval traces and retrieval-quality evaluation

Phase 4.6 adds that layer without adopting external GraphRAG frameworks, graph databases, GNN packages, or heavyweight training pipelines. The implementation should be small, deterministic, local-first TypeScript over Notient's existing SQLite, HNSW, graph, and markdown architecture.

## Phase Placement

Do not implement Phase 4.6 before Phase 4 and Phase 4.5 are coded and green.

Phase 4.6 depends on Phase 4 for:

- Search pipeline modes and SearchView
- Chat agent loop and tool registry
- conversation persistence
- universal undo
- graph bridge and canvas exporter
- UI affordances for showing citations and trace cards

Phase 4.6 depends on Phase 4.5 for:

- Source Ledger
- Source Spans
- generated artifact status and authority
- Atlas hot context
- Activity Log
- Research Frontier concepts
- artifact index policy

Phase 4.6 is not a replacement for 4.5. It is the reasoning engine that uses 4.5's trustworthy source/artifact substrate.

## What The Survey Teaches

### 1. GraphRAG Is A Three-Stage Pipeline

The survey organizes GraphRAG around:

1. G-Indexing: construct or identify the graph, then build graph, text, and vector indices.
2. G-Retrieval: retrieve query-relevant graph elements.
3. G-Generation: convert graph elements into an LLM-readable context and generate an answer.

Port to Notient:

- G-Indexing maps to the current indexer, graph store, vector index, Source Ledger, and artifact store.
- G-Retrieval becomes a new `src/core/graphrag` package.
- G-Generation becomes a graph context formatter, grounded answer generator, and verifier used by Search Deep mode and Chat.

The important move is not "add graphs". Notient already has graphs. The important move is to make retrieval choose graph elements deliberately instead of throwing nearby chunks into a prompt.

### 2. Plain RAG Failure Modes Are Exactly Notient's Opportunity

The survey identifies three traditional RAG weaknesses that matter for a knowledge vault:

- relationship blindness: related notes are retrieved as isolated text, not as connected claims
- redundant context: many chunks repeat the same idea, wasting the context window
- local-only view: a query that needs a global synthesis cannot be answered by top-K chunks alone

Port to Notient:

- answer "why do I believe this?" by retrieving the support path, not only the most similar paragraphs
- answer "what contradicts this?" by retrieving claim-to-claim contradiction paths and evidence spans
- answer "what is the shape of my thinking on X?" by retrieving communities and synthesis artifacts
- answer "what changed?" by applying recency and source freshness to graph retrieval

### 3. The Useful Graph Types Are Hybrid

The survey covers several graph forms:

- tree structures: chunks at leaves, summaries at internal nodes
- document graphs: notes/chunks as nodes, similarity/citation/metadata edges
- knowledge graphs: entities, claims, and typed relations
- heterogeneous graphs: mixed node and edge types for domain-specific reasoning

Port to Notient:

Notient should intentionally become a heterogeneous personal knowledge graph:

- note nodes: files in the vault
- chunk nodes: optional retrieval-only nodes tied to `chunks`
- source nodes: ledger entries from Phase 4.5
- span nodes: precise evidence ranges from Phase 4.5
- concept nodes: extracted entities/topics
- claim nodes: extracted assertions
- question nodes: open loops and research frontiers
- artifact nodes: promoted answers, synthesis notes, maps of content, decision records
- community nodes: graph clusters or semantic clusters

Edges should remain typed and evidence-bearing:

- `mentions`
- `asserts`
- `asks`
- `supports`
- `contradicts`
- `extends`
- `exemplifies`
- `synthesizes`
- `derived_from`
- `cites`
- `aliases`
- `member_of`
- `near`
- `depends_on`

Do not overbuild ontology first. Keep the Phase 4.6 edge set conservative and compatible with current `graph_edges`, then add only the extra edge types needed for source/artifact/community reasoning.

### 4. Hybrid Indexing Beats Single Indexing

The survey separates graph indexing, text indexing, and vector indexing. The practical lesson is that each index answers a different part of the problem:

- graph index gives adjacency, paths, neighborhoods, and explicit relations
- text index gives keyword and exact phrase recall
- vector index gives semantic recall

Port to Notient:

Every GraphRAG retrieval should use a hybrid seed set:

- lexical title/chunk matches from Phase 4 Quick Search
- HNSW chunk matches from Phase 4 Balanced Search
- entity/concept matches from `graph_nodes`
- recent active-note neighborhood from `graph_edges`
- Atlas/community/artifact matches from Phase 4.5

This avoids the common RAG trap where vector similarity retrieves semantically adjacent but structurally irrelevant chunks.

### 5. Embedding Long Graph Summaries Can Collapse Signal

The survey warns that embedding long textual descriptions of graph elements can blur distinctions. Short node/edge labels and long community summaries should not be treated identically.

Port to Notient:

Store different embedding targets:

- chunk embeddings: current behavior
- node label embeddings: short, precise concept/entity/claim labels
- edge evidence embeddings: small source spans, not entire notes
- community summary embeddings: separate index namespace with lower weight for precise lookup and higher weight for global synthesis
- artifact summary embeddings: search-friendly capsule, not full artifact body

Do not embed every giant generated summary and let it compete equally with source chunks. Generated artifacts need authority and index policy from Phase 4.5.

### 6. Retrieval Granularity Must Be Query-Dependent

The survey breaks retrieval into nodes, triplets, paths, subgraphs, and hybrids.

Port to Notient:

Notient should choose retrieval granularity by query intent:

| Query intent | Best granularity | Example |
| --- | --- | --- |
| lookup | chunks + nodes | "Where did I write about epistemic luck?" |
| relation | triplets | "What supports this claim?" |
| contradiction | claim nodes + contradiction/support edges | "Where do I disagree with myself?" |
| multi-hop reasoning | paths | "How did this idea lead to that decision?" |
| synthesis | communities + subgraphs | "What is my overall view on local-first AI?" |
| research planning | question nodes + frontier artifacts | "What should I investigate next?" |
| provenance | source spans + paths | "Why does Notient think this is true?" |

The default should be hybrid, but the retrieval budget should be allocated differently by intent.

### 7. Iterative Retrieval Is Useful, But It Needs Strict Budgets

The survey distinguishes once retrieval, iterative retrieval, adaptive retrieval, and multi-stage retrieval.

Port to Notient:

Implement multi-stage deterministic retrieval first:

1. seed candidates
2. link entities
3. expand graph locally
4. retrieve bounded paths
5. merge duplicates
6. prune and compress
7. generate
8. verify citations

Add adaptive retrieval only as a bounded planner:

- max 3 retrieval rounds
- max 2 graph hops by default
- max 40 nodes in a context packet
- max 80 edges in a context packet
- max token budget per mode
- every added item must improve coverage, diversity, or path completeness

Do not let an LLM wander the graph freely.

### 8. Pruning And Merging Are Core, Not Optimization

Graph retrieval explodes quickly. The survey repeatedly points to candidate explosion and noisy subgraphs.

Port to Notient:

Add a graph pruner that scores every candidate item using:

```text
score =
  0.30 * semantic_score +
  0.20 * graph_score +
  0.15 * evidence_score +
  0.15 * source_authority +
  0.10 * freshness +
  0.05 * active_note_relevance +
  0.05 * diversity_bonus
```

Where:

- `semantic_score`: vector or reranker score against the query
- `graph_score`: path proximity, edge confidence, PageRank-like centrality inside candidate subgraph
- `evidence_score`: exact source span exists, citation is accepted, edge has evidence
- `source_authority`: source-only > accepted artifact > draft artifact > generated unaccepted artifact
- `freshness`: note/source/artifact recency with Phase 4 Vitals decay
- `active_note_relevance`: relation to current note/workspace state
- `diversity_bonus`: prevents ten chunks from the same note dominating

This should be transparent and testable. Store per-factor scores in the retrieval trace.

### 9. Graph Serialization Is A Product Feature

The survey compares graph formats: edge tables, natural language, code-like forms, trees, and node sequences. The practical standard is complete, concise, and understandable.

Port to Notient:

Create a Notient Graph Context Packet. It should be concise enough for local models and readable enough for debugging:

```text
QUERY
What changed in my view on local-first AI?

NODES
N1 note "Essays/local-first-ai.md" maturity=evergreen freshness=0.84
N2 claim "Local-first tools should preserve user agency" source=N1 span=S14
N3 artifact "Decision: Notient uses Obsidian-native primitives" status=accepted authority=generated_accepted

EDGES
E1 N1 asserts N2 confidence=1.00 evidence=S14
E2 N2 supports N3 confidence=0.82 evidence=S14,S51
E3 N4 contradicts N2 confidence=0.77 evidence=S80,S14

PATHS
P1 N4 -> contradicts -> N2 -> supports -> N3

COMMUNITIES
C2 "Local-first AI and user agency" members=18 summary_artifact=A7

EVIDENCE
S14 [[Essays/local-first-ai.md#...]] "short source excerpt"
S51 [[Notient/Artifacts/...]] "short accepted artifact excerpt"
```

This beats dumping raw markdown into a prompt. It preserves topology, citations, status, authority, and compression.

### 10. Training Is Not The Right Phase 4.6 Investment

The survey covers training-free, training-based, and joint retriever/generator training. For Notient, training is not the right v1 path.

Port to Notient:

Prefer training-free methods:

- deterministic graph algorithms
- HNSW retrieval
- lexical retrieval
- local LLM reranking
- local LLM query decomposition
- local LLM answer generation with strict citations

Do not port:

- GNN retrievers
- joint retriever/generator training
- reinforcement-learning graph walkers
- external knowledge graph engines
- large benchmark-specific fine-tuning

Notient's edge is not training a universal GraphRAG model. It is building the best local personal-knowledge retrieval engine from user-owned notes, sources, artifacts, and graph relations.

### 11. Evaluation Must Measure Retrieval, Not Just Answers

The survey emphasizes that answer quality alone hides retrieval failures.

Port to Notient:

Add a GraphRAG evaluation harness with direct retrieval metrics:

- query relevance: how strongly retrieved items match the query
- evidence coverage: whether answer claims have source spans
- graph compactness: useful edges per token
- path completeness: whether required bridge nodes are present
- diversity: distinct notes/sources/communities represented
- faithfulness: generated claims trace to retrieved evidence
- latency: per stage
- context compression ratio: raw candidate tokens versus final packet tokens

Each Deep Search and Chat answer should optionally expose a retrieval trace. This is also how Notient becomes debuggable.

### 12. The Future-Work Section Maps To Notient's Long-Term Advantage

The survey's future directions are almost a roadmap for Notient:

- dynamic graphs: Notient updates as the vault changes
- multimodality: later source spans can include PDFs/images/audio, but Phase 4.6 should stay text-first
- scalable retrieval: Notient needs bounded graph expansion before vaults hit tens of thousands of notes
- graph context compression: essential for local models
- benchmarks: Notient can ship its own vault-level regression fixtures
- broader applications: research, writing, code notes, decision logs, legal/medical style evidence trails

The Phase 4.6 implementation should focus on dynamic local text graphs, scalable bounded retrieval, and compression. Multimodal GraphRAG is later.

## Phase 4.6 Product Outcome

After Phase 4.6, Notient should feel different in four places.

### Deep Search Becomes Graph Search

Deep mode should no longer mean "Balanced Search plus a synthesis prompt."

It should mean:

- decompose the query
- link key entities/concepts
- retrieve source chunks
- retrieve graph nodes and typed edges
- retrieve paths connecting important claims
- retrieve community summaries for global context
- compress into a Graph Context Packet
- generate an answer with citations and visible reasoning trace

### Chat Gains Graph Tools

The Chat agent should get read-only graph tools:

- `graph.find_nodes`
- `graph.find_edges`
- `graph.expand`
- `graph.find_paths`
- `graph.retrieve_context`
- `graph.explain_claim`
- `graph.find_contradictions`
- `graph.community_summary`

Write tools still go through Phase 4 approvals and Phase 4.5 artifact promotion.

### Atlas Becomes A Retrieval Layer

Phase 4.5 Atlas is a human-readable hot map. Phase 4.6 should make it machine-usable:

- community summaries become retrievable graph nodes
- accepted artifacts become high-authority generated context
- stale artifacts are demoted during retrieval
- Research Frontiers seed query decomposition
- Activity Log informs freshness and recent-work relevance

### Answers Become Evidence Trails

Every non-trivial answer should be able to show:

- source spans used
- graph nodes used
- edges used
- paths used
- communities used
- generated artifacts used
- pruned-but-near misses
- which stage found each item

This is the difference between "AI notes app" and "intelligent vault with inspectable memory."

## Architecture

Create a new core package:

```text
src/core/graphrag/
  types.ts
  queryPlanner.ts
  queryPlanner.test.ts
  entityLinker.ts
  entityLinker.test.ts
  seedRetriever.ts
  seedRetriever.test.ts
  graphRetriever.ts
  graphRetriever.test.ts
  pathFinder.ts
  pathFinder.test.ts
  communityIndex.ts
  communityIndex.test.ts
  graphPruner.ts
  graphPruner.test.ts
  graphContextPacket.ts
  graphContextPacket.test.ts
  graphLanguageFormatter.ts
  graphLanguageFormatter.test.ts
  groundedGenerator.ts
  groundedGenerator.test.ts
  verifier.ts
  verifier.test.ts
  retrievalTraceStore.ts
  retrievalTraceStore.test.ts
  evaluator.ts
  evaluator.test.ts
  prompts/
    planQuery.ts
    decomposeQuery.ts
    generateGroundedAnswer.ts
    verifyGrounding.ts
```

### Service Responsibilities

`GraphQueryPlanner`

- Classifies query intent.
- Selects retrieval mode and budgets.
- Decides whether query decomposition is needed.
- Emits a deterministic plan object before retrieval starts.

`GraphEntityLinker`

- Links query mentions to `graph_nodes`.
- Handles aliases and fuzzy labels.
- Distinguishes exact node matches from semantic matches.
- Returns ambiguous candidates instead of forcing false certainty.

`GraphSeedRetriever`

- Collects candidates from lexical, vector, entity, active-note, Atlas, and artifact sources.
- Keeps source type and initial score attached to each candidate.

`GraphRetriever`

- Expands from seeds over approved graph edges.
- Optionally includes staged edges only when the surface requests proposed knowledge.
- Supports node, triplet, path, subgraph, and community retrieval.

`GraphPathFinder`

- Finds bounded paths between query-linked entities, active note claims, answer candidates, and contradiction/support targets.
- Uses BFS/shortest path first.
- Penalizes low-confidence, unapproved, stale, or generated-only paths.

`GraphCommunityIndex`

- Turns existing DBSCAN clusters and graph neighborhoods into community records.
- Maintains community summaries as generated artifacts after Phase 4.5.
- Supports global query-focused retrieval without pulling hundreds of chunks.

`GraphPruner`

- Merges duplicate evidence.
- Deduplicates repeated chunks.
- Scores candidate nodes, edges, paths, communities, and artifacts.
- Produces a budget-fit candidate set.

`GraphContextPacketBuilder`

- Converts pruned graph retrieval into a compact packet.
- Preserves IDs, labels, types, edge directions, evidence spans, and source authority.
- Enforces token budget.

`GraphLanguageFormatter`

- Renders the packet in a model-facing text format.
- Renders the same packet in a UI-facing trace format.

`GroundedGraphGenerator`

- Generates answers from the packet.
- Requires citations for claims.
- Separates "answer", "evidence", "open questions", and "low confidence" sections.

`GraphGroundingVerifier`

- Checks that every answer claim is supported by retrieved source spans or accepted artifacts.
- Flags unsupported claims.
- Can request one bounded retrieval retry when coverage is insufficient.

`RetrievalTraceStore`

- Persists plan, candidates, scores, packet, generation metadata, and verification result.
- Powers UI trace panels and evaluation fixtures.

`GraphRagEvaluator`

- Runs canned vault queries.
- Measures retrieval and answer metrics.
- Produces stable smoke output.

## Query Planning

The planner should return a structured object:

```ts
interface GraphQueryPlan {
  id: string;
  query: string;
  intent:
    | "lookup"
    | "relation"
    | "path"
    | "synthesis"
    | "contradiction"
    | "provenance"
    | "frontier";
  retrieval: {
    granularities: Array<"chunk" | "node" | "triplet" | "path" | "subgraph" | "community" | "artifact">;
    maxSeeds: number;
    maxHops: number;
    maxNodes: number;
    maxEdges: number;
    maxPaths: number;
    maxCommunities: number;
    tokenBudget: number;
    includeStaged: boolean;
    includeGeneratedArtifacts: "accepted-only" | "accepted-and-draft" | "none";
  };
  decomposition: Array<{
    id: string;
    question: string;
    intent: GraphQueryPlan["intent"];
  }>;
}
```

Planner defaults:

| Surface | Mode | Max hops | Token budget | Include staged |
| --- | --- | ---: | ---: | --- |
| Search Quick | none | 0 | 0 | no |
| Search Balanced | light graph | 1 | 0 or rerank only | no |
| Search Deep | full graph | 2 | 6000 | optional filter |
| Chat normal | full graph | 2 | 5000 | no by default |
| Chat research | full graph + frontier | 2 | 8000 | yes when requested |
| Co-author | local graph | 1 | 1800 | no |

No planner output should be accepted if it exceeds hard settings caps.

## Entity Linking

Entity linking is a Phase 4.6 keystone because graph retrieval starts from nodes.

Inputs:

- query text
- active note path
- workspace state from Phase 4
- top lexical matches
- top vector matches
- existing `graph_nodes`
- Phase 4.5 source/artifact metadata

Outputs:

```ts
interface LinkedEntity {
  mention: string;
  nodeId: string;
  nodeType: string;
  label: string;
  confidence: number;
  matchKind: "exact" | "alias" | "fuzzy" | "semantic" | "active-note";
  ambiguity: Array<{ nodeId: string; label: string; confidence: number }>;
}
```

Implementation:

1. Normalize query terms with the same slug convention used by `indexNote.ts`.
2. Exact match against `graph_nodes.label`.
3. Alias match against new `graph_aliases`.
4. Fuzzy match using in-house token overlap, no dependency.
5. Semantic match via node-label embeddings if available.
6. Boost nodes attached to active note and recent workspace notes.
7. Return ambiguity for close scores rather than hiding it.

Add `graph_aliases` only after Phase 4.5 schema v3 exists.

## Retrieval Algorithm

The main retrieval flow:

```text
plan = GraphQueryPlanner.plan(query, surface, settings)
linked = GraphEntityLinker.link(query, workspace)
seeds = GraphSeedRetriever.retrieve(query, linked, plan)
expanded = GraphRetriever.expand(seeds, plan)
paths = GraphPathFinder.find(expanded, linked, plan)
communities = GraphCommunityIndex.retrieve(query, expanded, plan)
merged = merge(seeds, expanded, paths, communities)
pruned = GraphPruner.prune(merged, plan)
packet = GraphContextPacketBuilder.build(pruned, plan)
answer = GroundedGraphGenerator.generate(packet, query)
verification = GraphGroundingVerifier.verify(answer, packet)
trace = RetrievalTraceStore.save(all stages)
```

### Seed Retrieval

Seed types:

- lexical chunk seed
- vector chunk seed
- node label seed
- active note seed
- edge evidence seed
- source span seed
- accepted artifact seed
- community seed

Every seed stores:

```ts
interface GraphSeed {
  id: string;
  kind: "chunk" | "node" | "edge" | "span" | "artifact" | "community";
  targetId: string;
  source: "lexical" | "vector" | "entity" | "active-note" | "atlas" | "artifact" | "history";
  score: number;
  reason: string;
}
```

### Graph Expansion

Expansion should be deterministic and bounded:

```text
frontier = seed nodes
for hop in 1..maxHops:
  neighbors = approved edges touching frontier
  score each edge and neighbor
  keep top per source node
  add to candidate graph
  stop if node/edge budget reached
```

Defaults:

- 1 hop for Balanced Search, Co-author, and cheap Chat context
- 2 hops for Deep Search and normal Chat GraphRAG
- 3 hops only when user explicitly asks for chain/path reasoning

Traversal rules:

- Approved edges first.
- Staged edges only when UI mode includes proposed knowledge.
- Direct `contradicts` and `supports` edges get priority for claim reasoning.
- `mentions` edges are cheap but low authority.
- Generated artifacts are demoted unless accepted.
- Source spans are high authority when attached to an accepted edge or artifact.

### Path Retrieval

Path retrieval should support:

- shortest path between two linked nodes
- support path from source span to answer claim
- contradiction path between claims
- synthesis path from multiple notes to artifact
- question path from open question to source notes and research frontier

Scoring:

```text
path_score =
  average(edge.confidence)
  * approval_factor
  * evidence_factor
  * length_penalty
  * source_authority_factor
```

Where:

- `approval_factor = 1.0` for all approved, lower for staged when included
- `evidence_factor = 1.0` if every non-mentions edge has evidence
- `length_penalty = 1 / (1 + 0.25 * max(0, path_length - 2))`
- `source_authority_factor` follows Phase 4.5 source/artifact policy

### Community Retrieval

The survey highlights community summaries as the way to answer global questions without pulling the whole corpus.

Notient already has DBSCAN over note centroids. Phase 4.6 should generalize that into `GraphCommunityIndex`.

Community construction:

1. Semantic communities from DBSCAN note centroids.
2. Graph communities from approved edges using a simple local algorithm:
   - connected components for small vaults
   - bounded label propagation for larger vaults
   - no external graph library
3. Hybrid communities by merging semantic and graph communities with high overlap.

Community summary policy:

- Communities can be cached as Phase 4.5 artifacts.
- Summary artifacts must list member notes and source spans.
- Accepted community summaries can be used as high-level context.
- Draft summaries can be used only when the user includes generated knowledge.
- Stale summaries are demoted when member notes changed after summary creation.

Community retrieval is required for:

- "summarize my thinking about X"
- "what are the main themes?"
- "where is this idea cluster going?"
- "what should I write next?"
- "what changed over the last month?"

## Graph Context Packet

The packet is the heart of Phase 4.6.

It should preserve graph structure while fitting local-model context windows.

```ts
interface GraphContextPacket {
  id: string;
  query: string;
  planId: string;
  nodes: PacketNode[];
  edges: PacketEdge[];
  paths: PacketPath[];
  communities: PacketCommunity[];
  evidence: PacketEvidence[];
  artifacts: PacketArtifact[];
  warnings: string[];
  budget: {
    tokenEstimate: number;
    nodeCount: number;
    edgeCount: number;
    evidenceCount: number;
  };
}
```

Packet node:

```ts
interface PacketNode {
  id: string;
  kind: "note" | "chunk" | "source" | "span" | "concept" | "claim" | "question" | "artifact" | "community";
  label: string;
  notePath?: string;
  authority: "source" | "user-note" | "accepted-artifact" | "draft-artifact" | "generated-unaccepted";
  score: number;
}
```

Packet edge:

```ts
interface PacketEdge {
  id: string;
  type: string;
  sourceId: string;
  targetId: string;
  confidence: number;
  approved: boolean;
  evidenceIds: string[];
  score: number;
}
```

Packet evidence:

```ts
interface PacketEvidence {
  id: string;
  sourceId: string;
  notePath?: string;
  span?: { start: number; end: number };
  quote: string;
  authority: PacketNode["authority"];
}
```

The model-facing formatter should render a stable, compact text block with these sections:

1. Query
2. Instructions
3. Nodes
4. Edges
5. Paths
6. Communities
7. Evidence
8. Warnings

Instructions must require:

- cite evidence IDs for factual claims
- say when evidence is insufficient
- distinguish source notes from generated artifacts
- do not infer beyond the packet unless labeled as hypothesis

## Schema Additions

Phase 4.5 plans schema v3. Phase 4.6 should add schema v4 only after v3 lands.

### `graph_aliases`

Purpose: deterministic entity linking.

```sql
CREATE TABLE graph_aliases (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(node_id, normalized_alias)
);
```

Indexes:

- `graph_aliases_normalized_alias`
- `graph_aliases_node_id`

### `graph_communities`

Purpose: global retrieval and cached community summaries.

```sql
CREATE TABLE graph_communities (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  method TEXT NOT NULL,
  summary_artifact_id TEXT,
  member_count INTEGER NOT NULL,
  confidence REAL NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### `graph_community_members`

Purpose: community membership.

```sql
CREATE TABLE graph_community_members (
  community_id TEXT NOT NULL REFERENCES graph_communities(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  weight REAL NOT NULL,
  PRIMARY KEY (community_id, node_id)
);
```

### `graph_retrieval_traces`

Purpose: debuggability and evaluation.

```sql
CREATE TABLE graph_retrieval_traces (
  id TEXT PRIMARY KEY,
  surface TEXT NOT NULL,
  query TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  packet_json TEXT,
  answer_path TEXT,
  metrics_json TEXT,
  created_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);
```

### `graph_retrieval_items`

Purpose: per-candidate scoring and trace UI.

```sql
CREATE TABLE graph_retrieval_items (
  trace_id TEXT NOT NULL REFERENCES graph_retrieval_traces(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  stage TEXT NOT NULL,
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  factors_json TEXT NOT NULL,
  included INTEGER NOT NULL,
  reason TEXT,
  PRIMARY KEY (trace_id, item_id, stage)
);
```

These tables are cache/trace tables. User-owned durable knowledge still lives in markdown notes, source files, and artifacts.

## Search Integration

Phase 4 defines:

- Quick: fuzzy/title/chunk search
- Balanced: vector search plus rerank
- Deep: graph expansion plus grounded synthesis

Phase 4.6 should upgrade Deep and add a visible "Graph" inspector.

### Quick

No GraphRAG. Keep it fast.

### Balanced

Light graph assist:

- retrieve lexical/vector candidates
- include 1-hop approved note/concept edges for ranking only
- show "related by graph" badges
- no generation required

### Deep

Full GraphRAG:

- plan query
- link entities
- retrieve hybrid seeds
- expand graph
- retrieve paths and communities
- build packet
- generate grounded answer
- verify citations
- store trace

Deep results should show:

- answer card
- cited source spans
- graph paths
- communities used
- "why this result" trace
- option to export packet or canvas

## Chat Integration

Phase 4 Chat gets a tool registry. Phase 4.6 adds graph tools.

### `graph.retrieve_context`

Input:

```ts
{
  query: string;
  intent?: string;
  includeStaged?: boolean;
  maxHops?: number;
  tokenBudget?: number;
}
```

Output:

```ts
{
  packetId: string;
  summary: string;
  nodeCount: number;
  edgeCount: number;
  evidenceCount: number;
  warnings: string[];
}
```

### `graph.explain_claim`

Retrieves support, contradiction, source spans, and artifact lineage for a claim.

### `graph.find_paths`

Finds bounded paths between two concepts, notes, claims, or artifacts.

### `graph.find_contradictions`

Finds contradictions around a note, claim, concept, or query.

### `graph.community_summary`

Retrieves relevant communities and their accepted summaries.

Chat behavior:

- For factual answers, call `graph.retrieve_context` before answering.
- For "why" questions, call `graph.explain_claim`.
- For "how are X and Y connected", call `graph.find_paths`.
- For "what do I think about X", include community retrieval.
- For "what should I do next", include Research Frontiers from Phase 4.5.

## UI Integration

### Search Trace Panel

Add a collapsible trace panel to Deep Search result cards:

- Query plan
- Linked entities
- Seeds
- Graph expansion
- Paths
- Communities
- Pruned items
- Final packet
- Verification result

This should not read like a developer log. It should answer: "Why did Notient use this evidence?"

### Chat Evidence Drawer

Every graph-grounded answer should have an evidence drawer:

- Claims
- Citations
- Source notes
- Artifacts
- Paths
- Unsupported or weak claims

### Graph Path Canvas

Use Phase 4's JSON Canvas exporter to visualize:

- central query node
- retrieved claim nodes
- source notes
- support/contradiction edges
- community summary node
- answer artifact node if promoted

This is an export/view option, not a new custom graph renderer.

### Atlas Integration

Atlas should gain a "GraphRAG cache" section:

- recently refreshed communities
- stale community summaries
- top contradiction clusters
- high-value source gaps
- most-used retrieval paths

## Evaluation Harness

Add:

```text
scripts/smoke-graphrag.ts
```

Package script:

```json
"smoke:graphrag": "bun run scripts/smoke-graphrag.ts"
```

Smoke output:

```text
[smoke] graphrag: queries=8 packets=8 grounded=7 avgEvidence=4.2 avgLatencyMs=1820 compactness=0.41 ok
```

Core metrics:

```ts
interface GraphRagMetrics {
  queryRelevance: number;
  evidenceCoverage: number;
  faithfulness: number;
  diversity: number;
  graphCompactness: number;
  pathCompleteness: number;
  compressionRatio: number;
  latencyMs: number;
}
```

Test fixture queries should include:

- lookup: "Where do I discuss local-first software?"
- relation: "What supports this claim?"
- contradiction: "Where do my notes disagree about AI autonomy?"
- path: "How is Notient connected to Obsidian Bases?"
- synthesis: "What is my current view on intelligent notes?"
- provenance: "Why does Notient think this artifact is true?"
- frontier: "What should I investigate next for GraphRAG?"
- recency: "What changed this week?"

Evaluation should run without needing external services for retrieval logic. LLM generation tests should use fake providers, with one optional smoke against LM Studio.

## Task Plan

## Task 0: Reconcile Shipped Phase 4 And 4.5

Scope:

- Read `.planning/STATE.md`.
- Confirm Phase 4 code is complete.
- Confirm Phase 4.5 code is complete.
- Record actual file names and service APIs.
- Adjust this plan's paths if implementation drifted.

DoD:

- Phase 4.6 plan aligns with shipped code.
- No task assumes planned-but-missing Phase 4 or 4.5 APIs.

## Task 1: Schema v4 GraphRAG Cache

Files:

- `src/core/db/schema.ts`
- `src/core/db/migrations.ts`
- `src/core/db/migrations.test.ts`
- `src/core/graphrag/types.ts`

Add:

- `graph_aliases`
- `graph_communities`
- `graph_community_members`
- `graph_retrieval_traces`
- `graph_retrieval_items`

Tests:

- v1 -> v4 migration preserves existing notes/chunks/edges.
- v2 -> v4 migration works.
- v3 -> v4 migration works after Phase 4.5 exists.
- deleting a graph node cascades aliases and community memberships.
- deleting a trace cascades trace items.

## Task 2: Entity Linker

Files:

- `src/core/graphrag/entityLinker.ts`
- `src/core/graphrag/entityLinker.test.ts`

Implement:

- exact label match
- alias match
- fuzzy token match
- active-note boost
- ambiguity return
- deterministic confidence scoring

Tests:

- exact match beats fuzzy.
- alias match links to canonical node.
- active note boosts local concepts.
- ambiguous close matches are preserved.
- no hallucinated node IDs.

## Task 3: Query Planner

Files:

- `src/core/graphrag/queryPlanner.ts`
- `src/core/graphrag/queryPlanner.test.ts`
- `src/core/graphrag/prompts/planQuery.ts`

Implement:

- deterministic keyword/rule planner first
- optional LLM planner only for ambiguous Deep/Chat queries
- hard caps from settings
- decomposition for complex synthesis and path questions

Tests:

- contradiction query selects contradiction granularity.
- "how are X and Y connected" selects path retrieval.
- "what do I think about X" selects community/subgraph retrieval.
- caps cannot be exceeded by LLM output.
- fallback planner works when LLM fails.

## Task 4: Hybrid Seed Retriever

Files:

- `src/core/graphrag/seedRetriever.ts`
- `src/core/graphrag/seedRetriever.test.ts`

Implement:

- lexical seeds from Phase 4 search
- vector seeds from HNSW
- node seeds from entity linking
- active-note seeds
- Atlas/artifact seeds after Phase 4.5
- source span seeds after Phase 4.5

Tests:

- seeds preserve source and score.
- duplicate targets merge with multi-source reasons.
- accepted source spans outrank generated draft artifacts.
- seed cap is enforced.

## Task 5: Graph Expansion And Path Finder

Files:

- `src/core/graphrag/graphRetriever.ts`
- `src/core/graphrag/graphRetriever.test.ts`
- `src/core/graphrag/pathFinder.ts`
- `src/core/graphrag/pathFinder.test.ts`

Implement:

- bounded BFS expansion
- approved-first traversal
- staged-edge inclusion only when requested
- typed edge weighting
- shortest paths
- support and contradiction path retrieval

Tests:

- max hops enforced.
- max nodes and edges enforced.
- approved edges outrank staged edges.
- contradiction paths prioritize `contradicts`.
- generated-only paths are demoted.

## Task 6: Community Index

Files:

- `src/core/graphrag/communityIndex.ts`
- `src/core/graphrag/communityIndex.test.ts`
- possibly extend `src/core/agents/dbscan.ts`

Implement:

- semantic communities from existing DBSCAN centroids
- graph connected components for approved edges
- simple label propagation for larger graphs if needed
- stale detection based on changed member notes
- summary artifact linkage to Phase 4.5

Tests:

- deterministic communities for stable input.
- changed member marks community stale.
- accepted summary is retrievable.
- draft summary excluded unless requested.

## Task 7: Pruner And Packet Builder

Files:

- `src/core/graphrag/graphPruner.ts`
- `src/core/graphrag/graphPruner.test.ts`
- `src/core/graphrag/graphContextPacket.ts`
- `src/core/graphrag/graphContextPacket.test.ts`

Implement:

- factor scoring
- duplicate merging
- note/source diversity
- source authority weighting
- token estimate
- packet construction

Tests:

- duplicate chunks merge.
- evidence-bearing edges outrank unevidenced edges.
- token budget is respected.
- at least one path is kept for path intent when available.
- warnings emitted when evidence is insufficient.

## Task 8: Graph Language Formatter

Files:

- `src/core/graphrag/graphLanguageFormatter.ts`
- `src/core/graphrag/graphLanguageFormatter.test.ts`

Implement:

- stable model-facing packet text
- UI-facing trace summary
- compact evidence excerpts
- no raw full-note dumping

Tests:

- output is deterministic.
- edge direction is preserved.
- evidence IDs appear exactly once.
- generated artifacts are labeled by authority.
- long evidence is clipped safely.

## Task 9: Grounded Generator And Verifier

Files:

- `src/core/graphrag/groundedGenerator.ts`
- `src/core/graphrag/groundedGenerator.test.ts`
- `src/core/graphrag/verifier.ts`
- `src/core/graphrag/verifier.test.ts`
- `src/core/graphrag/prompts/generateGroundedAnswer.ts`
- `src/core/graphrag/prompts/verifyGrounding.ts`

Implement:

- answer generation from packet
- citation requirements
- insufficient evidence behavior
- verifier that maps answer claims to evidence IDs
- one bounded retry when coverage is poor

Tests:

- unsupported answer claims are flagged.
- answer cites source spans.
- accepted artifacts are labeled as generated accepted knowledge.
- verifier can request retry once, not loop.

## Task 10: Retrieval Trace Store

Files:

- `src/core/graphrag/retrievalTraceStore.ts`
- `src/core/graphrag/retrievalTraceStore.test.ts`

Implement:

- save plan
- save per-stage candidates
- save scores/factors
- save packet summary
- save metrics
- load trace for UI

Tests:

- trace roundtrips.
- item factors roundtrip.
- trace delete cascades items.
- large packet is summarized, not blindly duplicated if size cap is exceeded.

## Task 11: Search Integration

Files depend on shipped Phase 4 paths, likely:

- `src/core/search/strategies/deep.ts`
- `src/core/search/searchPipeline.ts`
- `src/ui/search/components/SynthesisCard.tsx`
- new trace panel components

Implement:

- Deep mode calls GraphRAG pipeline.
- Balanced mode uses light graph ranking.
- result cards link to trace.
- "View graph packet" developer affordance behind debug setting.
- "View as canvas" uses Phase 4 canvas exporter.

Tests:

- Deep mode produces packet and answer.
- citations are clickable.
- trace is attached to result.
- Balanced still works when GraphRAG is disabled.

## Task 12: Chat Tool Integration

Files depend on shipped Phase 4 paths, likely:

- `src/core/chat/tools/graph.ts`
- `src/core/chat/tools/registry.ts`
- `src/core/chat/contextManager.ts`
- `src/core/chat/agentLoop.ts`

Implement:

- graph read tools
- tool schemas
- context manager packet injection
- chat evidence drawer data

Tests:

- "how are X and Y connected" calls path tool.
- "what contradicts X" calls contradiction tool.
- tool outputs are summarized before reinjection.
- write tools remain approval-gated.

## Task 13: UI Trace And Evidence Drawers

Files depend on shipped Phase 4 paths.

Implement:

- Deep Search trace panel
- Chat evidence drawer
- graph path canvas export
- Atlas GraphRAG cache section

Tests:

- trace panel renders plan and evidence.
- weak claims are visible.
- canvas export includes nodes and edges from packet.
- Atlas section renders stale community summaries.

## Task 14: Evaluation Harness

Files:

- `src/core/graphrag/evaluator.ts`
- `src/core/graphrag/evaluator.test.ts`
- `scripts/smoke-graphrag.ts`
- `package.json`

Implement:

- fake-provider unit tests
- fixture vault queries
- metrics calculation
- optional LM Studio smoke

Tests:

- metrics are deterministic for fixed fixture.
- compression ratio calculated.
- faithfulness drops when answer lacks citations.
- smoke script prints one stable summary line.

## Task 15: State, Docs, And Cut-Line Audit

Files:

- `.planning/STATE.md`
- `docs/superpowers/plans/...`
- any user-facing docs created by Phase 5 later

Implement:

- record completed Phase 4.6 behavior
- record tests and smoke evidence
- record cut features
- update resume instructions

## Definition Of Done

Phase 4.6 is complete when:

- Deep Search uses GraphRAG pipeline, not only vector retrieval.
- Chat has read-only graph retrieval tools.
- Entity linking resolves query mentions to graph nodes with ambiguity support.
- Graph expansion supports bounded approved-edge traversal.
- Path retrieval works for support, contradiction, and connection questions.
- Community retrieval works for global synthesis questions.
- Graph Context Packets are deterministic, compact, and citation-aware.
- Grounded answers cite source spans or accepted artifacts.
- Unsupported claims are flagged by verifier.
- Retrieval traces persist and render in Search or Chat UI.
- Evaluation harness reports retrieval quality metrics.
- No external GraphRAG framework, graph database, or GNN dependency is added.
- `bun run typecheck && bun run lint && bun test` pass.
- `bun run smoke:graphrag` passes on the test vault.

## Cut Lines

Must ship:

- query planner
- entity linker
- hybrid seed retriever
- bounded graph expansion
- path finder
- graph pruner
- context packet formatter
- Deep Search integration
- retrieval traces
- minimal evaluator

Can cut if schedule slips:

- graph label propagation beyond connected components
- Chat evidence drawer polish
- graph path canvas export
- Atlas GraphRAG cache section
- LLM-based planner, if rule planner is enough
- optional retry in verifier

Should not ship in Phase 4.6:

- GNN retrieval
- fine-tuning
- RL graph walkers
- external graph databases
- unbounded agentic graph traversal
- multimodal GraphRAG
- automatic ontology explosion
- replacing Obsidian's native graph

## Risk Register

| Risk | Mitigation |
| --- | --- |
| Context packets become too large | Hard budgets, packet token estimates, graph pruning, community summaries. |
| Generated artifacts pollute evidence | Phase 4.5 authority labels, accepted-only default, source-first scoring. |
| Graph expansion returns noisy neighborhoods | Typed edge weights, confidence thresholds, evidence requirements, diversity caps. |
| Entity linker confidently links wrong concepts | Preserve ambiguity, expose confidence, prefer exact/alias over semantic. |
| Deep Search gets slow | Multi-stage caps, cache traces, light graph assist in Balanced, full GraphRAG only in Deep. |
| Users cannot trust answers | Evidence drawer, citations, verifier, unsupported-claim warnings. |
| Evaluation becomes answer-only | Store retrieval traces and measure retrieval quality directly. |
| Phase 4.6 competes with Phase 4.5 | Keep Phase 4.6 downstream; it consumes ledger/artifacts, it does not replace them. |

## Notient-Specific Strategic Read

The survey is about GraphRAG broadly, but Notient should not copy industrial GraphRAG systems. Those systems are often built around external graph databases, large KGs, benchmark QA, and heavy model training. Notient's advantage is different:

- local-first private vault
- living markdown corpus
- human-approved graph edges
- source spans with provenance
- generated artifacts that can be accepted, rejected, or made stale
- Obsidian-native surfaces
- small local models that need compact context

So Phase 4.6 should be a distillation:

- use graph structure, not graph infrastructure
- use typed evidence, not opaque embeddings alone
- use community summaries, but only with source lineage
- use adaptive retrieval, but with strict deterministic budgets
- use generated artifacts, but label their authority
- use evaluation, but focus on retrieval faithfulness and inspectability

The end state: Notient can answer from the vault by showing the actual path through the user's knowledge. Not "I found similar notes", but "this source span supports this claim, this claim contradicts that artifact, these three notes form the community behind your current view, and here is the evidence trail."

