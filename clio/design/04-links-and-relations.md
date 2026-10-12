# Stage 4: semantic candidates, links, relations and vitals

Status: implementation contract incorporating manager amendments A, B and D; Q1 remains open for the owner in section 10.
Scope: NOTIENT.md B6 stage 4, 7.1 and 7.7; archive DESIGN 2.2, 3.2, 3.3, 4.3 and 10.
Prerequisites: accepted stages 2 and 3, including the manager's fixes to 02. This document extends 02; its revision, authorization, journal, Git, recovery and undo contracts remain authoritative.

## 1. Delivery boundary and reasons

- **4a ships first:** derived-schema migration, version:2 journal, arithmetic vitals in note and `extension_notient__vitals`, plus `link` and `relate` for operator and unattended origins. Complete W01 through W24 and the adversarial list. Freeze every new command schema now; candidates and semantic paths report `embedding_off` without inference.
- **4b follows shipped 4a:** embedding adapter and setup flags, int8 packs, real candidates, hybrid retrieval with per-arm separation, and clio-origin admission. Demonstrate 4a through real tools before starting 4b. Both stages use released 0.6.2 command tools, Node standard library and node:sqlite only; no package dependencies or daemon.
- Candidate ranking, vector refresh and vitals change only external derived index state. They never invoke write recovery, append vault logs or make Git commits. Command status and write tools retain 02 recovery duties. A registered read-only vault may build its external index.
- All command tools remain execution-class in the released host. Calling candidates read-class describes its effect on the vault, not an available manifest exemption or sandbox. The runtime keeps its existing read-only observations and stage 3 reminders.
- **Waits for A1:** model-callable API 2 runtime tools and actual host read-class admission. **Waits for A2:** confined runtime writes to registered external vault roots. Persistent runtime indexing additionally needs a writable external data root/A3; A1 alone does not make SQLite writable. A6 is needed for runtime use in headless/worker sessions.
- **4b:** the host embedding adapter seam ships with the command adapter; selecting it waits for admitted runtime tools and writable index storage. Do not widen the runtime envelope or invoke a hidden runtime command to proxy embeddings from command tools.
- No witness tool, nine-way comparison engine, calibration workflow, scheduler, gardener, automatic filing, semantic proposals database or background model. Clio performs judgment in conversation; the extension validates admission and bytes.
- Reason: give one actual candidate-to-write-to-undo path without importing the retired approval system. This operator-configured command transport is the requested stage 4 exception to B6's earlier harness wait.
- Leave the accepted plugin skills unchanged until the manager signals their refresh. Their later stage 4 update will use these final tool contracts after schema installation and session restart.

## 2. Operator configuration and embedding adapter

**4a:** embeddings remain off; no endpoint setup flags, probe, adapter or credential path is required. **4b:** implement the shared configuration, explicit per-vault enablement and adapter below.

- Add exactly one top-level `embeddings` object in config.json, absent/null when unconfigured. Each vault has only an `embeddings` boolean, default false; never a per-vault provider object. Enabling a shared destination does not opt in any other vault. Preserve existing configuration fields/version convention and 0600 permissions.
```json
{"embeddings":{"baseUrl":"http://mini.example:4000/v1","model":"operator-model-id","responseModel":"probe-reported-model-id","dimension":768,"apiKey":null,"batch":32,"timeoutMs":15000,"maxInputBytes":1600,"documentPrefix":"","queryPrefix":"","spaceVersion":"1"},"vaults":[{"id":"registered-id","path":"/registered/vault","role":"operator","readOnly":true,"embeddings":false}]}
```
- Values above are illustrative, not endpoint discovery or measured model settings. Required operator fields are only baseUrl, model, dimension and maxInputBytes. Defaults: batch 32, timeoutMs 15000, documentPrefix/queryPrefix empty and spaceVersion "1". Provider kind is the fixed adapter identity openai-compatible, not another required operator field. Setup persists its probed responseModel, null if absent, and apiKey null when no key is supplied. apiKey is otherwise a nonempty string; responseModel is null or a nonempty identifier; dimension 1..8192, batch 1..32, timeoutMs 1000..60000, maxInputBytes 64..32768; prefixes <=512 characters, model/responseModel/spaceVersion <=200 characters, model/spaceVersion nonempty.
- Extend AI_AGENT-guarded setup for an **existing** `--vault`: `--embeddings-url`, `--embeddings-model`, `--embeddings-dimension`, `--embeddings-max-input-bytes` are required together to configure/probe the shared object and opt in that vault. Optional flags: `--embeddings-batch`, `--embeddings-timeout-ms`, `--embeddings-document-prefix`, `--embeddings-query-prefix`, `--embeddings-space-version`, `--embeddings-key-stdin`. `--embeddings-on` instead enables that vault against the existing probed shared object; `--embeddings-off` disables only that vault. Configuration/on/off modes are mutually exclusive. A shared-profile change is disclosed as affecting every already opted-in vault and makes their old vector spaces stale; it never enables a previously disabled vault. Key input is only one secret line on stdin, never argv or environment; responseModel is pinned by the probe, never an operator flag.
- Test AI_AGENT presence, including an empty value, before reading stdin, probing the network or changing any file. Configuration-only setup must not bootstrap or write the vault. Print the selected vault, destination origin, model, dimension and content-export purpose, never a key. Use the existing atomic config write; status/runtime projections expose only redacted embedding identity and state.
- Normalize a base URL ending in `/v1`; append exactly `/embeddings`. Admit http/https, including operator-selected loopback/private hosts; reject URL credentials, query, fragment and redirects. Do not fetch alternate URLs from responses. Send JSON `{model,input:[...],encoding_format:"float"}` and optional Bearer header from config only.
- Before accepting new enabled settings, setup probes one fixed nonsecret canary string, validates the vector/dimension, and records responseModel from the response, or null if absent. Enabling an additional vault re-probes the existing shared profile and requires its pinned identity/dimension to match. No vault text is sent by setup. Keep the requested wire model and reported identity separately because valid OpenAI-compatible gateways may resolve aliases. A failed probe preserves the shared object and every vault's opt-in bit.
- No endpoint, key, model, dimension, prefix or embedding profile can come from a model-callable argument or environment. Existing state-directory selection is unchanged. Redact request text, response bodies and authorization headers from errors/logs; report bounded code/status/model/dimension diagnostics.
- Provider contract: `describe() -> {provider,model,responseModel,dimension,spaceId,maxBatch,maxInputBytes}`; `embed(texts,{signal}) -> {vectors,model,responseModel,dimension}`. model is the configured wire identifier, responseModel its pinned reported identity. Ranking/packing take this interface, never configuration globals or transport credentials. A future host adapter splits at its advertised batch limit, uses context.embed and fingerprints the host profile identity.
- `spaceId` hashes canonical provider kind, normalized destination, configured model, pinned responseModel, dimension, both prefixes, maxInputBytes, spaceVersion and preprocessing version. Exclude the credential, timeout and batch size. A host-profile change creates a different space even when its display model name matches.
- Apply query/document prefix once before the byte bound. Never silently truncate indexed chunks. Oversized inputs are skipped with path/chunk diagnostics and incomplete coverage; setup must choose a bound compatible with the actual model context. Operator increments spaceVersion when a server changes weights behind an unchanged model name; dimension checks cannot detect that substitution.
- Validate one response vector per input with distinct complete numeric indices, all finite elements, exact configured dimension and nonzero norm. The reported model, including absence, must match setup's pinned responseModel. A changed reported identity/dimension disables semantic use as stale-model until operator setup verifies the configuration again; never silently adopt a response identity mid-refresh.
- One HTTP request at a time, AbortSignal deadline equal to the smaller of configured timeout and remaining tool budget, response cap 16 MiB; no automatic retry within a tool call. Classify timeout/429/5xx as retryable for the next explicit refresh. An invalid batch writes no vectors from that batch. No inference calls are made by status, note, vitals, write planning or recovery.
- Reason: credentials remain operator-owned, content destinations cannot be redirected by a note, and the mathematical/storage path is reusable with the host service.

## 3. Derived vector state, persistence and stale models

**4a:** migrate all tables and metadata below idempotently, including reserved vector/candidate tables; maintain arithmetic note_vitals and embedding state off. Version:2 journal integration is in section 6. **4b:** populate vector/candidate state and implement every pack, publication, scanning and stale-model rule below.

- Store packs beside `vaults/<vault-id>/index.db`, under the external state directory, as `vectors.<spaceId>.<generation>.i8`. All file names are locally generated basenames; no paths supplied by an endpoint. Candidate receipts are index rows. Journal records stay in 02's journal.
- Schema migration adds `vector_spaces(space_id PK,provider,model,response_model,dim,pack_file,pack_slots,generation,state,corpus_generation,created_at)` and `vec_meta(space_id,chunk_id,path,revision,text_hash,slot,scale,model,dim,PRIMARY KEY(space_id,chunk_id),UNIQUE(space_id,slot))`. Chunk foreign keys cascade; every lookup also checks revision/text_hash so reused chunk IDs cannot reuse old vectors.
- `meta` names the active space/generation and stores schema/preprocessing versions. Additional tables: `candidate_sets(id PK,vault,source,revision,space_id,index_generation,inventory_hash,payload_json,created_at,expires_at)`; `note_vitals(path PK,revision,word_count,last_user_edit_ms,maturity,updated_at)`. Migrate idempotently in a transaction; never alter journal history to migrate an index.
- Normalize vector v to unit L2 length. Let scale=max(abs(v))/127 and q[i]=clamp(round(v[i]/scale),-127,127). Store signed int8 q contiguously at slot*dim, and one positive finite Float64 SQLite REAL scale per vector. Reject empty, nonfinite, zero-norm or wrong-dimension vectors before publication.
- Compute cosine from the reconstructed vectors, including their post-quantization norms; do not assume quantization preserves a unit norm. Query vectors may remain normalized floats in memory. Clamp roundoff to [-1,1]; bestDistance=1-cosine lies in [0,2]. No binary sign-only scan or ANN index.
- Reuse the external index-writer exclusion shared with structural refresh/committed-index repair. Network calls occur outside SQLite transactions and the index publication lock. Capture revisions/text hashes first; after inference acquire the lock and discard rows whose chunks or config space changed. Never acquire a vault writer lock while holding the index lock.
- Pack publication: read committed pack_slots; truncate only an unreferenced crash tail beyond that prefix under the index lock; append complete vector bytes, fsync the pack, then transactionally install vec_meta rows and the new pack_slots. New generation files use exclusive creation and directory fsync where supported. SQLite derived-state transactions use WAL, 5 s busy timeout and synchronous=FULL for pack-pointer publication.
- A reader opens the pack while holding its SQLite read snapshot of file/generation/slots/rows, then scans no bytes beyond slots*dim. Validate all offsets, row spaces and prefix length. A pack short read or invalid metadata disables semantic results for that snapshot; never substitute zero vectors or corrupt structural/journal state.
- Crash before pack fsync leaves no referenced bytes; crash after fsync before SQL commit leaves an ignored tail; SQL commit exposes only durable bytes. On unsupported directory fsync report a durability warning and rebuild a missing derived pack. An interruption must not touch vault bytes.
- Re-embedding allocates a new slot; old unreferenced slots are ignored. `refresh tier:embed force:true` builds a fresh generation, reusing valid same-space vectors and recomputing only missing/invalid ones, then atomically swaps all slots/pointer. Keep old generation files through this stage so Windows open readers cannot race deletion; report retained bytes. No hard links or automatic compaction/pruning.
- Model, dimension, endpoint, prefix or spaceVersion changes make the prior pack `stale-model` immediately. Do not query it under the new configuration. Build a new space from a frozen structural generation, catch up changed chunks, then activate only when every currently eligible chunk has a valid row; skipped oversized/invalid chunks remain explicit coverage gaps.
- After initial activation, ordinary source edits invalidate only their old revision's vectors. Available same-space vectors may serve an incomplete snapshot, labeled with missing counts. A model-space rebuild is never partially mixed with its predecessor.
- Embedding states: `off`, `building`, `ready`, `incomplete`, `stale-model`, `unavailable`. Preserve a retryable batch failure in index metadata; subsequent explicit refresh resumes missing rows, not a new queue service. State and counts are observable in status and refresh.
- Hard bounds: at most 1 GiB committed active pack, 64 MiB scan buffers and 64 source chunks per candidates request. Exceeding a bound reports a limit with no truncated candidate set. Batch refresh honors its deadline and returns remaining counts. These are engineering resource bounds, not relevance thresholds.

## 4. Retrieval, candidate receipts and hit separation

**4a:** admit the final schemas but keep inference off. Valid candidates returns an empty set, null receipt and reason `embedding_off`; validate source/revision first. Explicit semantic search returns no hits with that reason; hybrid may return lexical hits while reporting its semantic arm off. Default search stays lexical; embed refresh returns off with zero embedded chunks. Separation is undetermined until 4b, with no invented numeric signal. **4b:** implement the complete retrieval and separation behavior below without changing the frozen input schemas.

- Extend explicit `refresh` with tier `structural|embed`, default structural. Existing plain refresh performs no network call. Embed requires a current structural snapshot and an enabled operator configuration; otherwise report the prerequisite. budgetMs defaults to 240000; stop between batches and return committed progress/remaining. force has its existing structural meaning or the vector-generation rebuild meaning in section 3.
- Search mode defaults to hybrid when this vault has embeddings enabled, otherwise lexical. Hybrid embeds the query once; if unavailable/stale/oversized, answer lexically and label semantic coverage incomplete. Explicit semantic mode returns no hits and a reason if the semantic arm cannot run; never silently relabel lexical hits as semantic.
- Preserve R3's workspace filter and sourcePath exclusion in **both** arms before ranking. Lexical precise query is an AND of safely quoted normalized terms, capped at 32. Only when it returns zero rows, use an OR fallback of at most eight significant terms of >=3 Unicode characters, deduplicated in encounter order.
- Freeze the English stopword set for significance as `a an and are as at be been being but by can could did do does for from had has have how i if in into is it its may of on or our should so than that the their them then there these they this those to was we were what when where which who why will with would you your`. Match terms after JavaScript normalize("NFKC").toLowerCase(), never rewriting source bytes. Zero significant terms makes lexical separation undetermined.
- Each arm scores all eligible rows but retains candidateCap=min(1000,limit*8) chunk rows for ranking/fusion. Separately retain up to the top 50 scores/term records for separation so limit=1 cannot manufacture an undetermined label. Break ties by exact path then chunk ordinal. Count diagnostic candidates before the display limit.
- Hybrid RRF is 0.7/(60+rank_semantic)+0.3/(60+rank_lexical), ranks starting at 1, absent arm contribution 0. Fuse by chunk identity; keep one highest-scored chunk per note after fusion. Explicit single-arm modes retain cosine/BM25 or term-fallback scores. Never compare RRF magnitude to cosine admission.
- Before serving each result, reread its raw revision and verify the exact source byte slice. Drop drifted rows, mark refresh needed in external state, and report incomplete coverage. Return the same bounded served passage/range contract as stage 1; never quote an unserved continuation.
- Candidates uses every eligible indexed source chunk, all at the caller's raw revision, against an exhaustive same-space scan. Source vectors must be complete; no HTTP call or source-chunk sampling is hidden in candidates. For each target note take the minimum source/target chunk distance and retain that winning pair.
- Exclude the source and notes already joined by a resolved wikilink in either direction. Use the structural snapshot and report its freshness; embeds and Markdown links do not count as wikilinks. A stale snapshot must not be presented as a complete graph. Read/revision-check the source and each returned target, and re-slice both winning passages before storing a receipt.
- Return at most 12 notes, ordered by bestDistance then path. Negative or zero similarities stay visible; admission later drops them. Candidate scan deadline is 25 s, checked at bounded vector intervals; abort without a receipt on exhaustion. Missing source vectors, changed source, unavailable pack or no eligible neighbors has a typed reason, not invented semantic scores.
- Receipt id is a random UUID, stored only after all returned evidence checks. Payload freezes source revision, exact target paths/revisions, winning chunk byte ranges/text hashes, finite distances, vector space, index generation and inventory hash. Expiry is 24 h. An empty result returns candidateSet:null. No admission can use a path that was scored but not returned.
- candidate_sets is derived evidence, never an authorization token or a session secret. Limit live receipts to 10000/vault; refuse further creation with an actionable index-capacity reason rather than deleting a receipt an in-flight preview needs. Expired receipts may be reclaimed by explicit index refresh; frozen journal evidence is separate.
- **Semantic separation:** on raw descending cosines s1..sN, N=min(50,available), N<10 => undetermined. Otherwise z=(s1-mean(s2..sN))/populationStddev(s2..sN); z<2 => flat, z>=2 => separated. Equal zero-variance tail/top => flat, z=0; top above a constant tail => separated, value:null, reason:zero_variance_gap. No Infinity/NaN in JSON.
- **Lexical separation:** fewer than ten diagnostic candidates or no significant terms => undetermined; otherwise flat when fallback fired or no candidate contains every significant term. Otherwise separated. Token membership uses the same normalized significant terms.
- **Combined:** any separated available arm => separated; every available arm flat => flat; otherwise undetermined. An unavailable arm is omitted; no available arm => undetermined. Return each arm's signal so this precedence is inspectable. Candidates has only its semantic signal, computed over per-note best cosines before exclusion by display limit.
- Every signal carries zMin:2 and calibrated:false. Separation never suppresses a hit, changes admission's positive-similarity rule, or enters coverage. Coverage answers index readiness/absence; off embeddings alone do not degrade an explicitly lexical query. No calibration input is admitted in stage 4.
- Reason: retrieval provenance can be checked without pretending that rank, a flatness label or a candidate receipt proves a semantic assertion.

## 5. Frozen command contracts and result shapes

**4a:** install every schema and result extension in this section together, including candidates, search modes and embed refresh placeholders. New link/relate operations serve operator/unattended origins; clio-origin execution of those new modes is deferred to 4b with typed `EMBEDDING_OFF`, including on an otherwise no-op plan. Existing 02 operations keep their origin behavior. **4b:** activate semantic behavior and clio-origin handling behind these same schemas; no second schema expansion is required for the split.

All objects below are closed, including nested objects. Use only the released schema dialect: no pattern, oneOf or $ref. Enforce character/path rules semantically under 02. Input remains <=64 KiB. New candidates timeout 30000 ms, vitals 60000 ms; maxOutputBytes 1048576 each. Existing write timeouts/output bounds remain.

Candidates schema:
```json
{"type":"object","additionalProperties":false,"required":["vault","source","revision"],"properties":{
  "vault":{"type":"string","minLength":1,"maxLength":4096},
  "source":{"type":"string","minLength":1,"maxLength":4096},
  "revision":{"type":"string","minLength":64,"maxLength":64},
  "limit":{"type":"integer","minimum":1,"maximum":12}
}}
```
Default limit 8. Source is an exact vault-relative Markdown file; revision is the complete raw SHA-256 under 02. No free query, endpoint or arbitrary candidate distance arguments.

Vitals schema:
```json
{"type":"object","additionalProperties":false,"required":["vault"],"properties":{
  "vault":{"type":"string","minLength":1,"maxLength":4096},
  "maturity":{"type":"string","enum":["raw","adolescent","mature","synthesis-ready"]},
  "connectivityTier":{"type":"string","enum":["isolated","sparse","connected","hub"]},
  "folder":{"type":"string","minLength":1,"maxLength":4096},
  "sort":{"type":"string","enum":["health","freshness","words"]},
  "limit":{"type":"integer","minimum":1,"maximum":100}
}}
```
Default sort health ascending, freshness ascending, words descending, then exact path; default limit 20. Folder is a normalized component prefix, not a substring. Filters are conjunctions. No model, writeback or scoring weights argument.

The complete revise schema supersedes 02's revise schema; fields for the five operations are disjoint:
```json
{"type":"object","additionalProperties":false,"required":["vault","batch","authorization","operation","path","revision"],"properties":{
  "vault":{"type":"string","minLength":1,"maxLength":4096},
  "requestId":{"type":"string","minLength":8,"maxLength":64},
  "batch":{"type":"string","minLength":1,"maxLength":80},
  "authorization":{"type":"object","additionalProperties":false,"required":["origin","request"],"properties":{
    "origin":{"type":"string","enum":["operator","clio","unattended"]},
    "request":{"type":"string","minLength":1,"maxLength":2000}}},
  "operation":{"type":"string","enum":["replace","frontmatter","move","link","relate"]},
  "path":{"type":"string","minLength":1,"maxLength":4096},
  "revision":{"type":"string","minLength":64,"maxLength":64},
  "oldText":{"type":"string","minLength":1,"maxLength":24000},
  "newText":{"type":"string","maxLength":24000},
  "set":{"type":"array","maxItems":32,"items":{"type":"object","additionalProperties":false,"required":["key","valueJson"],"properties":{
    "key":{"type":"string","minLength":1,"maxLength":80},"valueJson":{"type":"string","minLength":1,"maxLength":4096}}}},
  "unset":{"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":80}},
  "destination":{"type":"string","minLength":1,"maxLength":4096},
  "link":{"type":"object","additionalProperties":false,"required":["edges"],"properties":{
    "candidateSet":{"type":"string","minLength":36,"maxLength":36},
    "edges":{"type":"array","minItems":1,"maxItems":4,"items":{"type":"object","additionalProperties":false,"required":["targetNotePath","rationale"],"properties":{
      "targetNotePath":{"type":"string","minLength":1,"maxLength":4096},
      "rationale":{"type":"string","minLength":1,"maxLength":240},
      "heading":{"type":"string","minLength":1,"maxLength":200},
      "block":{"type":"string","minLength":1,"maxLength":80}}}}}},
  "relate":{"type":"object","additionalProperties":false,"required":["target","relation"],"properties":{
    "target":{"type":"string","minLength":1,"maxLength":4096},
    "relation":{"type":"string","enum":["supports","contradicts","extends","exemplifies","synthesizes"]}}},
  "dryRun":{"type":"boolean"},"planHash":{"type":"string","minLength":64,"maxLength":64}
}}
```
- Require link only for operation:link and relate only for operation:relate. Even empty foreign-mode fields refuse. Heading/block are mutually exclusive, name an actual unique live anchor, and cannot inject wiki delimiters or newlines. No caller-supplied confidence/type: link always means related_to; relate has the five distinct relations.
- Preserve existing search schema fields vault, query, limit, sourcePath and R3 workspace; add only `mode:{type:"string",enum:["hybrid","lexical","semantic"]}`, optional. Keep query required and all current bounds/default limit 10. Preserve refresh vault/force and add only optional `tier:{type:"string",enum:["structural","embed"]}`, `budgetMs:{type:"integer",minimum:1000,maximum:240000}`. Existing objects stay closed. Note's input is unchanged.
- Install all new schemas in one reviewed extension update and restart the Clio session. No runtime mutation of schemas; no caller environment switch enabling future fields.

Required result records, with ? denoting optional only where explicitly shown:
```text
Signal = {state:separated|flat|undetermined,basis:semantic-z|lexical-terms|none,
          value:number|null,zMin:2,calibrated:false,candidates:number,reason:string|null}
Separation = {state:separated|flat|undetermined,semantic:Signal|null,lexical:Signal|null}
Evidence = {path,revision,headingPath:[string],source:{startLine,endLine,startByte,endByte},passage:string}
Embedding = {state:off|building|ready|incomplete|stale-model|unavailable,spaceId:string|null,
             model:string|null,responseModel:string|null,dimension:number|null,eligible:number,embedded:number,missing:number,skipped:number}
candidates = {ok:true,tool:"candidates",vault,source,revision,candidateSet:string|null,expiresAt:string|null,
  candidates:[{path,revision,title,bestDistance:number,sourceEvidence:Evidence,targetEvidence:Evidence}],
  reason:string|null,embedding:Embedding,coverage:SearchCoverage,separation:Separation,
  timings:{scanMs,verifyMs,totalMs}}
Vitals = {freshness:number,wordBand:number,chunkCoverage:0|1,hasEdges:0|1,health:number,
          words:integer,inbound:integer,outbound:integer,edges:integer,
          connectivityTier:isolated|sparse|connected|hub,maturity:raw|adolescent|mature|synthesis-ready,
          lastUserEditAt:string}
vitals = {ok:true,tool:"vitals",vault,notes:[{path,revision,vitals:Vitals}],
          computedAt:string,indexGeneration:integer|null,coverage:SearchCoverage,remaining:integer}
note.vitals = {state:current|incomplete|unknown,snapshotRevision:string|null,values:Vitals|null,computedAt:string}
linkResult = {admitted:[{targetNotePath,relation:"related_to",confidence:number|null,basis:clio-candidate|operator|unattended,rationale}],
              dropped:[{targetNotePath,reason:not_retrieved|nonpositive_similarity}],candidateSet:string|null}
relateResult = {target,relation:supports|contradicts|extends|exemplifies|synthesizes}
```
- Paths/revisions/ranges obey stage 1/02 conventions; Evidence passages <=1200 characters. These are literal served slices, not generated summaries. candidateSet is usable for admission; evidence for answers still comes from search/note, with explicit reads for correction context.
- Candidate successful empty reasons are `embedding_off|embedding_building|stale_model|embedding_unavailable|source_vectors_missing|no_candidates`; limit/time failures are typed errors. Generic read failure is `{ok:false,tool,vault,error:{code,message,retryable,paths}}`, exit 1; inherited not-configured exit-0 shape remains. A mismatched requested source revision is REVISION_CONFLICT, never an empty success.
- Extend every 02 write success with `link:linkResult|null`, `relate:relateResult|null`; extend operation enums to link/relate. Keep its complete preview, receipt, index-state, audit and commit contract. Failures keep 02's failure shape. Dedupe/no-op still checks source revision. Dropped-only link plans return noop with the drop list and no intent/log.
- Search adds embedding and separation; status exposes Embedding and retained pack bytes per vault. Refresh adds `embedding:{...Embedding,embeddedThisCall,failedBatches,remaining}`. No response exposes keys or an unredacted endpoint URL. Coverage remains the existing type and exact unknown-coverage literal.

## 6. Admission, byte-preserving writeback and coordinator integration

**4a:** implement all byte planners, operator/unattended handling, version:2 journaling, recovery and undo; semanticEvidence is null. Reject clio-origin use of the new operations until 4b. **4b:** add candidate-backed clio link admission and freeze its semantic evidence; relate retains its nonnumeric relation contract. Shared validation and writeback rules apply in both stages.

- **Link validation:** reject more than four inputs, duplicate canonical target paths, blank or >240-character rationales, self-links, absent/cross-vault/unsafe targets and unsupported qualifiers. Validate the whole request before admitting any edge. For non-retrieved Clio paths, report dropped without reading an invented path.
- **Origin clio:** require a live, unexpired candidateSet from this vault/source/revision/current space. Validate every stored distance as finite in [0,2]. In input order, drop an edge absent from the returned set or with 1-bestDistance<=0; accepted confidence=min([0.95,0.85,0.75,0.65][accepted.length],1-bestDistance). A drop promotes the next ceiling. Validate unique targets before filtering, including duplicates that would both be dropped.
- Recheck the source and each selected retrieved target against the receipt's exact revision; refusal TARGET_CHANGED/CANDIDATE_STALE preserves all bytes. Expired/rebuilt/lost receipts require a new candidates call. A new index generation alone need not invalidate immutable evidence if space/source/selected-target revisions still match.
- **Origin operator:** named live targets skip candidate membership, positivity and confidence ceilings; confidence:null, basis:operator. Ignore an optional receipt for admission rather than mislabeling an operator choice as inferred. **Origin unattended:** apply 02's location/no-move policy, confidence:null, basis:unattended; admission is only for origin clio as specified. Neither origin field proves a relationship or bypasses read-only registration.
- **Relate:** append exactly one bare target to frontmatter.notient.<relation>; no semantic candidate requirement or fabricated numeric assessment. Read/validate the target and freeze its revision as a dependency. Source-to-target direction is literal: source supports, contradicts, extends, exemplifies or synthesizes target. No reciprocal write and no automatic inference from co-occurrence.
- Both planners return pure byte splices. Use 02's raw whole-file revision including BOM/frontmatter/newlines. All target reads, reference-resolution inventory and source bytes are dependencies rechecked before publication. Rendering uses 02's exact-spelling resolver and shortest uniquely resolving wiki suffix without .md; verify it in the current inventory, refuse alias-only/case/normalization ambiguities.
- Link emits only `- [[target]]`, or the requested heading/block variant, in the first actual body `## Related` section. Store rationales/confidence in the journal/result, not as authored prose or an invented truth score in the note. Preserve frontmatter, tasks, callouts, math, inline code and all bytes outside planned splices.
- Locate Related case-insensitively with up to three leading spaces and heading whitespace. Ignore frontmatter, fenced/indented code, blockquote code, inline code and HTML/Obsidian comments. A first-body-line U+FEFF is ignored for recognition but preserved in bytes, both at file start and after frontmatter.
- Related ends at the next visible H1/H2. Presence includes its H3 subsections: a resolved `[[t]]` or `[[t|alias]]` with the exact requested qualifier satisfies it; embeds do not. A heading/block link does not satisfy a bare target. An occurrence outside this first section does not satisfy it. Code/comment lookalikes never suppress insertion.
- Insertion stays in the top-level part before its first subheading: after the first top-level list including its continuations, otherwise after the last nonblank visible content, otherwise after the Related heading. Preserve existing list content; add one normal dash bullet with the necessary blank separator. With no section append `## Related`, a blank line and the bullet.
- Use the local anchor's CRLF/LF convention, or 02's document convention for a new section; reject bare CR and ambiguous mixed separators at a splice boundary. Keep the original terminal-newline presence; an empty source creates an LF-terminated section. Never normalize untouched separators.
- Test idempotency on original bytes before fence repair. If new insertion is needed, close an unclosed top-level EOF fence with its exact character/count and newline convention, then re-evaluate the splice. Keep the reconciled buffer even if a second presence check makes the bullet unnecessary. Refuse a container/fence layout without a provably safe closure rather than writing inside code.
- Relate locates nested YAML spans, not a serialized replacement of the entire notient map. Support absent/null map or relation list, and bounded block/flow mappings with string lists; append a quoted wikilink preserving siblings, independent comments, delimiters, body and BOM. Null map/list initializes the respective container; wrong scalar/map/member types refuse.
- Relate idempotency resolves complete string wikilinks, with display aliases ignored; a fragment does not satisfy its whole-note target. Retain nonmatching strings and array order. Refuse duplicate keys, anchors/merges/tags, uncertain quoting/indentation or unsupported spans under 02's frontmatter bounds. No silent conversion of a scalar to a list or whole-document YAML serializer.
- Existing Related bullets or relation members are applied facts from Markdown, not pending database edges. Index their resolved wiki connections and typed frontmatter relation names on refresh. Never turn generated link-only text, frontmatter, visitor regions or logged rationales into independent prose evidence for another link.
- Dry run does no inference, refresh, receipt pruning, journal/SQL mutation or Git writes. Preview includes admitted/dropped results and every content/log diff. Real change uses the shared coordinator, per-write Git commit, audit, final revision recheck, normal-index repair and inverse undo; no link-specific writer.
- planHash retains the manager's contents: vault, operation, requested byte deltas, read set/inventory, HEAD and log baseline. Origin, batch and request words remain attribution. Admission must be valid again at execution even when attribution or receipt ID is outside the hash; a valid hash cannot excuse missing provenance.
- Before intent, freeze admission version, exact receipt evidence/distances, rationales, target revisions and chosen splices in the immutable journal request/plan. Hash-cover that evidence in the record integrity data. After durable intent, recovery uses this frozen evidence and 02's dependency/reconcile rules, not an expired candidate_sets row or a network call. Recheck current registration/origin authority; receipt expiry alone cannot strand applied bytes.
- New stage 4 records use version:2, retaining every version:1 field and adding required `link`, `relate`, `semanticEvidence` and `vitalsBefore`. link/relate use the result shapes above or null. semanticEvidence is null except for Clio link admission, where it freezes `{version:1,candidateSet,sourceRevision,spaceId,indexGeneration,createdAt,expiresAt,targets:[{path,revision,bestDistance,sourceEvidence,targetEvidence}]}` for selected retrieved targets; Evidence has the closed shape in section 5. vitalsBefore is `[{path,lastUserEditMs:number|null}]` for all changed note paths. Include these immutable fields in the version:2 intent-manifest hash; keep version:1 hash verification unchanged.
- Accept and recover version:1 history without rewriting it; unknown versions still fail closed. Version:1 successful retries may synthesize null link/relate response fields without modifying the stored receipt. Undo must understand both versions. Freeze vitalsBefore for every new operation, not only the two new revise modes, so later capture/replace/frontmatter/move/undo cannot erase edit-age provenance.
- Recovery after ref publication recognizes the recorded commit before classifying later note edits. Single/batch undo of link/relate uses exact recorded inverse bytes, preserves audit history and refuses later edits under 02. Audit-only batch inverses still close zero-delta histories. Idempotent retries return the recorded result/admission; they never issue a second semantic decision.

## 7. Arithmetic vitals and mapping from the old system

**4a:** implement this entire arithmetic/storage/read contract and the 20 inherited vectors, independent of embeddings. **4b:** reuse it unchanged; embeddings and candidate ranks neither promote nor demote maturity.

- Measure from a structural snapshot, not embeddings. Count visible prose words once from non-overlapping parsed body spans, excluding frontmatter, code, visitor evidence regions and link-only generated lists. A word is a maximal Unicode letter/number run, permitting internal apostrophes/hyphens; record that word-count version so a migration is explicit.
- chunkCoverage is 1 iff there is at least one substantive eligible indexed chunk at the note revision, otherwise 0. hasEdges is 1 iff at least one resolved non-embed wikilink connects another note in either direction. Markdown links, missing targets, self-links and semantic candidates are not edges.
- Count unique directed source/target note pairs, including literal wiki strings in typed frontmatter; repeated aliases/fragments to the same note do not inflate counts. inbound and outbound count their respective sets; edges=inbound+outbound, so reciprocal pairs count twice. Reason: graph structure should not depend on repeated textual mentions.
- ageDays=max(0,(now-last_user_edit_ms)/86400000); freshness=exp(-ageDays/14); wordBand=1-exp(-words/600); health=(wordBand+chunkCoverage+hasEdges)/3. Fourteen days gives exp(-1), not 0.5. No rounding before comparisons; UI may round only display.
- Connectivity: edges=0 isolated, >=1 sparse, >=4 connected, >=12 hub. Defaults/weights are fixed, not settings a model can tune.
- Maturity starts raw. raw -> adolescent when words>0; adolescent -> mature when words>=200, inbound+outbound>=5 and edit age **strictly greater than** seven days, matching the inherited SQL predicate; mature -> synthesis-ready when outbound>=10 and inbound>=3.
- A normal explicit structural refresh advances at most one qualifying rung per note from its pre-refresh state. note/vitals reads do not promote notes merely by being called. An index rebuild runs the arithmetic ladder to a fixpoint in at most three passes, as archive section 10 specifies. No timer, model or frontmatter maturity writer.
- Preserve prior last_user_edit_ms for a verified committed Notient after-revision, including link/relate/undo; a new capture starts at its committed capture time. A changed externally authored revision uses observed file mtime, clamped to now for age. Do not let a Notient link make the original prose look freshly edited.
- Index rebuild must recover attribution from retained verified journal history, not simply set mtime for every Notient-written file. For a latest recognized after-revision, use frozen prior last-user-edit metadata from its operation; record that metadata in new plans. For older records without it, use the earliest before-file mtime in the contiguous verified Notient chain, falling back conservatively to current mtime. Mark fallback in status; never infer an older age from an arbitrary matching historical hash.
- Vitals/note make no writes or model calls. Use one now per response. note returns null values when it cannot match a structural snapshot to its live revision; snapshotRevision explains the gap. vitals hashes selected notes before returning them, omits changed/deleted rows and reports incomplete coverage/remaining. A missing structural index yields empty notes and unknown coverage, not invented isolated/raw facts.
- FTS5 absence does not invalidate otherwise readable structural metrics. Graph freshness/coverage remains explicit; a stale graph cannot support a claim of no incoming links. **Q2 decided:** retain the inherited earned monotone ladder without demotion, including after a substantive user rewrite; freshness and other current metrics may fall. Maturity is not a current truth/confidence rating.
- Deferred taxonomy remains nine distinct judgments: supports, extends, exemplifies, related_to, contradiction, temporal-change, different-assumptions, unrelated, insufficient. Future witnessed contradiction maps to the relation key contradicts; temporal-change/different-assumptions are findings, never edges. Assessment zero/bibliography-only downgrade and two-note tension validation belong to the later comparison/witness design, not this schema.

## 8. Implementation order and verification contract

**4a gate:** migration, arithmetic, version:2 journal, vitals reads/tool, operator/unattended link/relate, complete W/adversarial verification, final frozen schemas and a real write/read/undo use. Ship and report 4a before beginning 4b. **4b gate:** configured transport, pack, candidates/hybrid/separation and clio admission, then the real endpoint/candidate-to-write use below. Q3 requires measurements but sets no numeric deployment gate this release.

- Add focused pure modules for adapter/packing/scanning, separation/fusion, linker admission, writeback and vitals under clio/notient-extension/lib; command wrappers under tools. Extend existing setup/config/index/note/revise/coordinator modules. Use fresh implementation; no import/copy of the retired daemon, third-party YAML package or alternate Git path.
- **4a then 4b:** implement in the gate order above and freeze schemas during 4a. Sol records actual output in clio/README.md; this design claims no implementation measurements.
- **4b:** G-01 linker 14 minimum cases: 0,1,4 proposals; 5 throws; duplicate throws before filtering; unknown target dropped; distance 0 admits .95; distance 1/2 drops; negative/nonfinite distance corrupt; missing target promotes next .95 ceiling; all four rank ceilings; similarity below ceiling wins; blank rationale refuses; 240 accepted/241 refused. Operator/unattended bypass attribution and shared input bounds are already verified in 4a; receipt expiry/wrong vault/source/model/target revision belongs to 4b.
- **4a:** G-01 vitals 20 minimum vectors plus mapping cases: zero/600 words and negative input validation; ages 0/14/future; binary chunks/edges; connectivity 0/1,3/4,11/12; each maturity threshold on both sides, including 199/200 words,4/5 total edges,9/10 outbound,2/3 inbound,exactly seven days versus one ms later; own revisions, external edits without demotion, rebuild fixpoint and repeated read stability.
- **4b:** deterministic transport tests with a local stub only for failure injection: shared profile with two independently opted-in/off vaults; four required settings and defaults; stdin-only key and probe-pinned responseModel; failed probe preserves all config; exact request path/headers without leaked secrets; environment/argument overrides impossible; redirects refused; timeout/429/bad JSON/missing or duplicate indices/wrong dimension/zero norm; config change during inference discards stale results. Stub behavior is not live endpoint acceptance.
- **4b:** pack cases kill between append/fsync/SQL publication and during generation build/swap; prove readers see a consistent committed prefix, tail recovery is safe, stale model never mixes, invalid pack degrades independently of lexical/journal, and no hard link is used. Check simultaneous index repair/refresh has bounded locking and no deadlock.
- **4b:** retrieval cases cover exhaustive int8 versus float reference, deterministic ties, per-note minimum winning pair, source exclusion/bidirectional existing-link exclusion, all-source completeness, workspace filter in both arms, significant-term fallback, RRF constants/one chunk per note, raw per-arm signals, <10/zero variance/exact z=2, and labeled flat hits that remain returned.
- **4a:** link/relate integration includes complete previews, operator byte snapshots, target/inventory changes, existing-edge no-ops, LF/CRLF/EOF/BOM, nested YAML siblings/comments, ambiguous target refusal, one note plus audit per commit, unrelated staged bytes, normal/derived index recovery and exact single/batch undo. **4b:** additionally prove immutable semantic admission through recovery and all-dropped no-ops.
- **4a:** mixed journal versions cover version:1 pending recovery/retries after upgrade, version:2 integrity and vitalsBefore, and undo selecting originals from both versions. **4b:** add semantic-evidence corruption and expiry/index rebuild after intent; a lost candidate receipt must not strand a previously durable write.
- **4a:** exercise every reserved semantic input with embedding_off, no network/vector publication and unchanged input schemas; malformed paths/revisions remain refusals, and clio-origin new writes do not silently bypass admission. Show vitals and operator/unattended writes work without embeddings.
- Run node --test and clio-coder extensions validate/test for the changed extension; validate any later skill refresh separately. Installation remains the operator's act. Print the exact install/update commands from the implementation checkout and request consent for the reviewed package digest; start a fresh session for schema admission.
- **4a live use:** on the live fixture, read note/vitals, preview/apply one operator-named link and one typed relation, show an allowed unattended write inside Notient plus an outside refusal under 02, and undo the batch. Inspect raw before/after/undo revisions, version:2 journal, audit/OIDs and embedding_off results. Record migration/vitals/write timings and unrelated Git-state preservation. Installation remains the operator's act.
- **4b live use:** operator configures a real endpoint and opts in a fixture-derived corpus. Record actual HTTP embedding response identity/dimension and indexed rows, then a real Clio candidates -> note reads -> preview clio-origin link -> apply -> relate -> vitals -> batch undo sequence. Include a nonpositive candidate rejection and an operator-named link without a receipt.
- **4b:** first live vector check is fixture-only. Owner-vault embedding transmits content beyond the vault and requires separate operator selection/configuration; no Vaultex write, benchmark or export follows merely from this design. Product question Q1 controls expansion.
- **4b measurements:** corpus notes/chunks/eligible/skipped/missing, configured and returned model/dimension/spaceId, pack bytes including retained generations, embedding batch/total/query latency, scan/fusion/verification/total latency, candidate-set size, quantization error and recall@10 versus float32 for >=200 sampled queries when corpus size permits, sample count, cold/warm status, and external-file/Git/journal effects.
- **4b:** compare lexical/hybrid relevance on operator-labeled questions; report per-arm separation and false-flat observations with calibrated:false. Record p50/p95 only with adequate samples, and errors/timeouts alongside successful calls. **Q3 decided:** no numeric quality/latency gate this release; measurements and exact correctness invariants remain required. No synthetic prior-art figure is an acceptance claim.

## 9. W table: all 24 inherited writeback cases now in scope

**4a:** all W01..W24 rows and the complete adversarial list below are required before shipping. **4b:** reuse those same byte planners; add admission/semantic fixtures without deferring any W case. The archive G-01 gives a minimum count and named boundaries, not numbered rows. Retain the W01..W24 expansion from the earlier 02 table. Goldens assert exact buffers, not normalized Markdown.

| ID | Input | Required result |
| --- | --- | --- |
| W01 | LF body without Related | Append one section/bullet; unrelated bytes unchanged. |
| W02 | CRLF file | Generated separators are CRLF. |
| W03 | Related heading inside fence | Ignore it; insert outside code. |
| W04 | Related heading in frontmatter scalar | Ignore it; preserve complete frontmatter. |
| W05 | Unclosed EOF backtick fence | Close same marker before append. |
| W06 | Unclosed EOF tilde fence with longer marker | Close same character/count. |
| W07 | Bare target already in Related | Return original bytes exactly. |
| W08 | Aliased target already in Related | Return original bytes exactly. |
| W09 | Only an embed of target | Insert a normal reference. |
| W10 | Only target with heading fragment | Insert requested bare target. |
| W11 | H3 after Related/top-level list | Insert before H3; preserve nested content. |
| W12 | UTF-8 BOM immediately before Related H2 | Recognize section and retain BOM. |
| W13 | U+FEFF on first body line after frontmatter | Recognize heading/fence without removing it. |
| W14 | No final newline | Insert without a terminal newline. |
| W15 | supports relation | Change only notient.supports; preserve body/siblings. |
| W16 | contradicts relation | Change only notient.contradicts; preserve body/siblings. |
| W17 | extends relation | Change only notient.extends; preserve body/siblings. |
| W18 | exemplifies relation | Change only notient.exemplifies; preserve body/siblings. |
| W19 | synthesizes relation | Change only notient.synthesizes; preserve body/siblings. |
| W20 | Existing relation target including alias | Byte-identical no-op. |
| W21 | Invalid notient/relation/member types | Typed refusal without changed bytes. |
| W22 | Target exists outside Related only | Insert in Related; preserve outside occurrence. |
| W23 | Empty body; callout/task/math/code-tag fixtures | Empty creates LF section; other fixtures preserve unrelated syntax. |
| W24 | Target present before an unclosed later fence | Original bytes unchanged; no gratuitous fence repair. |

Add adversarial blockquote/list fences, HTML/Obsidian comments, nested lists, a repeated target under H3, aliased qualified links, false code-presence matches, literal U+FEFF bytes, mixed newlines, duplicate Related sections, missing target anchors, flow/block relation arrays and reserved YAML constructs. Apply each new operation twice to prove idempotency and run undo against its exact initial bytes.

## 10. Owner question and settled manager decisions

**4a:** Q2 governs maturity and Q4 excludes extra scope. **4b:** Q1 controls nonfixture export, Q3 governs measured acceptance and Q4 preserves the uncalibrated separation contract.

- **Q1 open for the owner, deployment and content export:** which real endpoint/model/dimension/context bound and which registered vaults are approved for the first nonfixture embedding run? There is one shared profile plus independent vault opt-in bits, all off until the operator acts; no address or secret is inferred from prior homelab notes.
- **Q2 decided:** retain the inherited monotone maturity ladder without demotion, including after a substantive user rewrite. Current health/freshness remain independently calculated.
- **Q3 decided:** no numeric quality or latency gate this release. Record actual measurements and failures; retain exact byte, arithmetic, retrieval and recovery correctness requirements.
- **Q4 decided:** neither witnessed disagreement reports nor operator-driven calibration enters this release. Keep zMin 2.0 and calibrated:false; do not start either expansion from this contract.
