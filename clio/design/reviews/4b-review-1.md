# Stage 4b incremental review

## 82a7aff2: shared embedding configuration, setup and transport

1. **Empty query or fragment delimiters bypass rejection and change the probe endpoint.** `clio/notient-extension/lib/embedding-config.mjs:17` checks only the truthiness of URL.search and URL.hash; `:20` retains the serialized delimiter. **Violates 04 §2's explicit rejection of query/fragment destinations and exact `/embeddings` suffix, and §8's exact-request-path transport requirement.** For `http://host/v1#`, standard URL parsing gives an empty hash but retains `#` in the serialized URL. Concatenation at `clio/notient-extension/lib/embedding-adapter.mjs:48` produces `http://host/v1#/embeddings`, whose HTTP path is `/v1`. Likewise, `http://host/v1?` produces request target `/v1?/embeddings`. Consequently, setup accepts prohibited destination syntax and sends its canary to the wrong route, so a correctly configured embeddings route cannot satisfy that probe. The destination cases at `clio/notient-extension/test/embedding-transport.test.mjs:76` cover only nonempty query and fragment values.

2. **The host adapter uses a different call contract from Clio's documented embedding service.** `clio/notient-extension/lib/embedding-adapter.mjs:88` calls `service.embed(batch, options)`; `:89` checks model and dimension without supplying or checking the host profile identity. **Violates 04 §1's requirement to ship the host adapter seam and §2's requirement to use context.embed with host-profile identity, while deferring its selection until the harness permits it.** The released host contract in `/home/akougkas/iowarp/clio-coder/docs/guide/semantic-context.md:36` is `context.embed({ inputs, task, expectedProfileIdentity? })`, returning vectors with the exact profile identity. Passing that context to this adapter supplies an array where the host expects an object, and no expectedProfileIdentity reaches the host. Consequently, the adapter cannot bind to the documented service, and its existing checks cannot distinguish two host profiles with matching model and dimension. The stub at `clio/notient-extension/test/embedding-transport.test.mjs:84` implements the same invented positional signature, so it does not establish compatibility. Correcting the seam does not require enabling runtime selection or changing the extension envelope.

block 82a7aff2: prohibited empty query/fragment delimiters change the request endpoint (item 1), and the host adapter does not implement the documented context.embed contract or identity check (item 2).

## 92bd319b: V19 fix for stage 4a item 19

approve 92bd319b for stage 4a item 19; block all of stage 4a on its retained version:1 batch-undo attribution defect (4a item 20), which remains unchanged through 738e1bdf.

## eb1d3c67: int8 vector generations

3. **Generation rebuild republishes invalid vectors as ready.** `clio/notient-extension/lib/vector-store.mjs:214` reads the old vector through `snapshot.packed(row)`, and `:216` copies it without reconstruction or vector validation before the generation is activated at `:224`. **Violates 04 §3's rejection of zero-norm vectors before publication and requirement to reuse only valid same-space vectors.** Replace one committed vector's bytes with zeros while retaining its length, slot and scale. The raw pack reader checks the offset and read length, so rebuilding accepts those bytes, publishes a new generation and reports success. Candidate/search reads subsequently reject the copied vector through `reconstructedVector`. Consequently, force rebuilding can preserve unusable data and label the replacement generation ready instead of recomputing its invalid row. The new read paths in the subsequent requested commits do not repair this publication path.

4. **Generation rebuild retains the entire metadata set without the scan-memory bound.** `clio/notient-extension/lib/vector-store.mjs:209` allocates a generation-wide metadata array, and `:216` retains every row until publication. The check at `:215` limits only packed vector bytes. **Violates 04 §3's separate hard 64 MiB scan-buffer bound and explicit limit-refusal requirement.** A corpus with 200,000 chunks and distinct 512-character paths retains more than 97 MiB of path text alone, before hashes and other fields. Its dimension-768 pack occupies only 153.6 MB and passes the 1 GiB check. Consequently, this valid corpus can exceed the prescribed memory bound during force rebuild without a limit result; the deadline does not bound retained memory. This path remains unchanged through 738e1bdf.

block eb1d3c67: invalid vectors republished by generation rebuild (item 3) and unbounded retained rebuild metadata (item 4).

## 7c11b813: embed refresh and candidate receipts

5. **Force refresh needs the broken or full old pack to work before it can replace it.** `clio/notient-extension/lib/embed-refresh.mjs:24` skips chunks whose metadata exists without checking their packed bytes; `:48` or `:54` publishes into the old pack before the force-generation branch at `:66`. **Violates 04 §3's missing-pack recovery and the fresh-generation force contract referenced by §4's embed-refresh rule.** Delete or truncate an active pack while retaining its SQLite rows. Metadata-only selection finds no missing batch, and empty publication reaches `lib/vector-store.mjs:156`, which refuses the missing or short old pack before the rebuild is reached. A separate supported case is an old pack at 1 GiB with obsolete slots and one newly invalidated chunk: publishing its recomputed vector hits the old-pack size limit at `lib/vector-store.mjs:158` before force can reclaim obsolete slots. Consequently, the prescribed explicit rebuild cannot recover these derived-state failures even when the replacement generation would fit. The direct rebuild entry also requires opening the old pack at `lib/vector-store.mjs:206`.

6. **An empty candidate result can report current coverage despite missing neighbor vectors.** `clio/notient-extension/lib/candidates.mjs:32` suppresses semantic coverage degradation for `no_candidates`, and the empty return at `:67` omits the missing/skipped check used by the nonempty return. **Violates 04 §3 and §4's incomplete semantic coverage and absence-reporting requirements.** Start with fully embedded Source.md and Target.md, edit Target.md, then refresh only the structural index. Source still has complete vectors, while Target's new chunks have none. The scan skips Target and returns `reason:no_candidates` with `coverage.state:current`, despite an incomplete embedding space and an eligible neighbor that was not searched. Consequently, the empty result overstates coverage. The defect remains at `candidates.mjs:32` and `:69` in 738e1bdf.

7. **Empty-generation publication discards its durability warning.** `clio/notient-extension/lib/embed-refresh.mjs:48` calls `publishVectors([], [])` and ignores the result. **Violates 04 §3's requirement to report unsupported directory fsync.** For an empty or entirely oversized corpus, this call creates the initial empty pack. When directory fsync is unsupported, the storage layer returns `DIRECTORY_FSYNC_UNAVAILABLE`, but refresh returns `warnings:[]` because no nonempty batch passed through the warning collector at `:54`. Consequently, the operator receives successful publication without the required disclosure of its durability limitation.

block 7c11b813: force refresh cannot recover a broken or full old pack (item 5), empty candidates overstate coverage (item 6), and empty publication drops the durability warning (item 7).

## 738e1bdf: hybrid search and arm diagnostics

8. **A configuration change can compare a new-profile query vector with the old-profile pack.** `clio/notient-extension/lib/hybrid-search.mjs:92` reads the scan profile, but `:94` constructs an adapter that independently rereads configuration; `:96` uses the first profile without comparing it with the adapter's space identity or returned model. **Violates 04 §3's immediate stale-model rule and same-space requirement for §4's semantic ranking.** Search reads profile A, then operator setup publishes profile B at `bin/setup.mjs:143` and is descheduled before updating vector state at `:145`. Search creates adapter B, embeds its query, then scans the still-active A pack using the earlier profile. With equal dimensions, all cosine calculations succeed; the adapter's own configuration check verifies B and cannot catch the mismatch with A. Consequently, hybrid or semantic search can serve similarities between incompatible vector spaces instead of refusing semantic use or falling back. Embed refresh performs the missing identity comparison at `lib/embed-refresh.mjs:52`.

9. **Query inference and scanning do not share the remaining command deadline.** `clio/notient-extension/lib/hybrid-search.mjs:95` calls `adapter.embed([query])` without a remaining-budget signal, then `:96` starts a scan with a fresh 25-second allowance. **Violates 04 §2's smaller-of-configured-timeout-and-remaining-tool-budget rule and §4's lexical fallback behavior on semantic unavailability.** The search command timeout is 60 seconds at `clio-coder-extension.yaml:75`, and the configured request timeout may also be 60 seconds. Coverage and lexical work consume part of that minute before inference starts, but the request still receives its full configured timeout. Consequently, a slow request can hit the host's command kill before search returns its lexical fallback; a late successful query can likewise leave insufficient time for the newly allocated scan allowance and result verification.

10. **Hybrid fallback exposes raw single-arm scores instead of weighted reciprocal ranks.** `clio/notient-extension/lib/hybrid-search.mjs:50` and `:51` return unchanged rows when the other arm is unavailable, and `:112` restores raw BM25 cost for the lexical case. **Violates 04 §4's hybrid formula, zero contribution from an absent arm, and reservation of raw BM25/cosine scores for explicit single-arm modes.** With unavailable semantic inference, hybrid search returns raw lexical costs rather than `0.3/(60+rank_lexical)`; with only semantic available, it returns cosine rather than `0.7/(60+rank_semantic)`. Consequently, the same `mode:hybrid` changes score meaning according to availability, although ranking within the sole available arm remains ordered. The assertion at `test/hybrid-search.test.mjs:33` encodes this divergence. V18's default-mode selection itself is preserved.

block 738e1bdf: query/pack vector-space mismatch during configuration change (item 8), missing shared command deadline (item 9), and raw scores in hybrid fallback (item 10).

block the reviewed 4b implementation through 738e1bdf: endpoint and host-adapter contracts (items 1 and 2), invalid rebuild publication and memory bound (items 3 and 4), force recovery, empty coverage and durability reporting (items 5 through 7), and hybrid space identity, deadline and scoring (items 8 through 10).

## d01698bf: Clio-origin link admission and frozen semantic evidence

Static review of the requested commits through ea232e24; no tests or product execution. File references below are relative to the repository and remain valid at that pin. E8 through E10 are outside this pass.

11. **A committed mixed request loses the receipt evidence for its nonpositive drop.** `clio/notient-extension/lib/link-admission.mjs:55` continues after recording a nonpositive drop, before `:57` adds the selected target's evidence to the frozen list. `clio/notient-extension/lib/journal-v2.mjs:41` requires that list to contain only as many targets as were admitted, and `:43` restricts membership to admitted targets. **Violates 04 §6's requirement to freeze exact receipt evidence/distances for selected retrieved targets before intent.** Supply `[N0.md, N1.md]` from a valid receipt with distances 1 and 0 respectively. N0 is dropped for `nonpositive_similarity`; N1 is admitted at .95 and its link is committed. The journal retains the N0 drop in `link.dropped`, but freezes only N1's distance and passages. Consequently, after the candidate receipt is deleted or the index is rebuilt, the durable operation cannot substantiate its recorded N0 decision from its own evidence. The omitted target was selected, retrieved and revision-checked; it differs from an unknown target with no receipt evidence. Dropped-only no-ops still require no journal record.

12. **The required negative stored-distance boundary has no admission fixture.** `clio/notient-extension/test/link-admission.test.mjs:32` defines the admission case table; its corrupt-distance rows at `:41`, `:42` and `:43` supply NaN, Infinity and 3, but no negative `bestDistance`. **Violates 04 §8's explicit negative/nonfinite-distance corruption case.** Consequently, the required lower-bound rejection has no regression proof. `lib/link-admission.mjs:18` currently rejects negative values, so this is a missing prescribed test, not a demonstrated functional failure. The other inherited boundaries are covered by this table, the integration cases and the earlier shared-validation fixtures at `test/link-writeback.test.mjs:157` and `:160`; zero proposals correctly refuse under the frozen `minItems:1` schema.

block d01698bf: incomplete frozen evidence for selected retrieved drops (item 11) and missing required negative-distance fixture (item 12).

## 951e2f86: V20 fix for stage 4a item 20

approve 951e2f86 for stage 4a item 20; approve all of stage 4a through this commit.

## 820396eb: E1 fix for item 1

approve 820396eb for item 1.

## f3855636: E2 fix for item 2

13. **The corrected host request still supplies the wrong input element type.** `clio/notient-extension/lib/embedding-adapter.mjs:95` takes a batch of strings, and `:96` passes it directly as `inputs` to `service.embed`. **Violates 04 §1's host-adapter seam and §2's requirement to implement the released context.embed contract.** The public request at `/home/akougkas/iowarp/clio-coder/src/domains/extensions/public-api-v2.ts:275` requires `EmbeddingInput[]`; its text variant at `src/domains/providers/embedding/types.ts:5` is `{kind:"text",text:string}`. The host validates each input's `kind` at `src/domains/providers/embedding/service.ts:131`. Consequently, passing the released context into this adapter makes even `embed(['a'])` fail for an unqualified undefined modality instead of producing a vector. The new test at `clio/notient-extension/test/embedding-transport.test.mjs:94` explicitly expects string arrays, so its stub preserves the remaining incompatibility. E2 corrects the outer object signature, eight-input bound and exact profile-identity check from item 2, but does not yet complete that contract. The seam must map strings to typed text inputs; selecting the host adapter remains deferred as designed.

block f3855636 on the remaining host input contract (item 13, the residual of item 2).

## d378b253: E3 fix for item 3

approve d378b253 for item 3, including the later force path through ea232e24.

## db84ba68: E4 fix for item 4

approve db84ba68 for item 4, including the later force path through ea232e24.

## e6442937: E5 fix for item 5

approve e6442937 for item 5.

## b6111e15: E6 fix for item 6

approve b6111e15 for item 6.

## ea232e24: E7 fix for item 7

approve ea232e24 for item 7.

block the reviewed 4b implementation through ea232e24: pending hybrid space identity, deadline and scoring fixes (items 8 through 10), incomplete frozen evidence for selected retrieved drops (item 11), missing required negative-distance fixture (item 12), and the remaining host input contract (item 13, superseding item 2).

## 4edcb374: E8 fix for item 8

approve 4edcb374 for item 8, checked through 80d59f5a.

## 2ed7a5eb: E9 fix for item 9

14. **Two independent index-lock waits can consume more than the fallback reserve.** `clio/notient-extension/lib/hybrid-search.mjs:78` reserves six seconds after the semantic allowance, but failure recording at `:109` and served-result recording at `:126` each use `clio/notient-extension/lib/index-lock.mjs:18`, which starts a separate five-second lock wait without the remaining command deadline. **Violates 04 §4's lexical fallback requirement in the deadline scenario addressed by item 9.** With a configured inference timeout of 60000 ms, query inference can abort at elapsed second 54. Let a concurrent indexing process release its writer lock at second 58.9: failure recording acquires it after 4.9 seconds and commits quickly. If the indexing process reacquires that lock before served-result recording, search begins another five-second wait near second 59. The unchanged 60-second host timeout can then kill the command before it returns its already-computed lexical fallback. The witness uses serial index-writer ownership and the existing bounded waits; it does not require slow file reads or simultaneous writers inside the lock. E9 fixes the original independent query timeout and fresh scan allowance, but its fallback tail still lacks a shared remaining deadline. References are pinned to 80d59f5a.

block 2ed7a5eb on the remaining fallback deadline (item 14, the residual of item 9).

## 4b3e0bbc: E10 fix for item 10

approve 4b3e0bbc for item 10, checked through 80d59f5a.

## 80d59f5a: verification record and final stage 4b status

No additional divergence in this record-only commit. The reported command outputs were not rerun during static review. The record explicitly leaves real endpoint and real Clio-session acceptance pending; those checks remain operator work under 04 §8.

Items 11 and 12 are unchanged in this range. Item 13 remains at `clio/notient-extension/lib/embedding-adapter.mjs:97`; the input array still contains strings rather than typed host text inputs. Their previously recorded findings remain open without duplication here.

block all of stage 4b through 80d59f5a: incomplete frozen evidence for selected retrieved drops (item 11), missing required negative-distance fixture (item 12), remaining host input contract (item 13), and fallback index-lock waits outside the shared deadline (item 14).
