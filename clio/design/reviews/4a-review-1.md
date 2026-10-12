# Stage 4a incremental review

## a3ba8231: migration and vitals arithmetic

1. **Hidden link destinations count as prose.** `clio/notient-extension/lib/vitals.mjs:34` leaves aliased inline wikilinks intact before the word matcher. **Violates 04 §7's visible-prose word-count contract.** For `See [[Hidden target|label]].`, the function counts four words instead of the two displayed words, `See label`. The same line's Markdown substitution stops at the first closing parenthesis, so a nested-parenthesis destination can also leave hidden destination text in the count. Consequently, link syntax inflates words, wordBand and health and can satisfy a maturity word threshold without the required amount of visible prose. Use the resolved token spans to distinguish displayed text from destinations rather than counting the raw link syntax.

2. **Visible prose surrounding an HTML comment disappears.** `clio/notient-extension/lib/vitals.mjs:29` obtains all countable spans exclusively from `parsed.blocks`. The existing parser at `clio/notient-extension/lib/markdown.mjs:424` discards entire lines containing HTML comments, including surrounding visible text. **Violates 04 §7's requirement to count visible prose once from body spans.** For `Visible <!-- hidden --> prose.\n`, the new visibility mask could preserve the two visible words, but the counting loop receives no block and reports zero words. Consequently, ordinary prose contributes nothing to wordBand, and a nonempty note can remain raw. The new consumer must obtain spans that retain visible text before and after comments; masking a comment inside an already discarded line cannot repair the omission.

3. **The link-only filter also removes authored relation prose.** `clio/notient-extension/lib/vitals.mjs:34` allows closing brackets and arbitrary intervening text inside its supposed wikilink match. **Violates 04 §7's exclusion of link-only generated lists while retaining visible prose.** For `- [[A]] supports [[B]]\n`, the expression can match from the first `[[` through the final `]]` and remove the whole line, although it visibly contains `A supports B`. Consequently, a substantive paragraph is reported as zero words and zero chunk coverage, understating health and preventing its first maturity promotion. Require a sequence of actual link tokens and whitespace before classifying a line as link-only.

block a3ba8231: hidden link destination counting (item 1), dropped prose surrounding HTML comments (item 2), and authored prose removed by the link-only filter (item 3).

## 866dc3a2: vitals tool and note.vitals

4. **Legacy edit-age recovery crosses intervening operator commits.** `clio/notient-extension/lib/vitals-index.mjs:41` walks a history filtered to Notient records and joins successive operations by matching before/after hashes. The path-history check at `:38` verifies only the latest touching commit. **Violates 04 §7's contiguous verified Notient-chain requirement and prohibition on deriving an older edit age from an arbitrary matching historical hash.** Consider an old Notient capture of bytes A, an operator commit changing A to B, another operator commit restoring A, and a version:1 Notient replacement of A with C. On index rebuild, the latest commit check succeeds, and the loop links the replacement's before-hash A directly to the old capture's after-hash A, skipping both operator commits. It then restores the capture date and clears the fallback flag. Consequently, freshness is understated and the seven-day maturity threshold can be satisfied despite a recent operator edit. This path remains unchanged in `7ab3b440`.

block 866dc3a2: legacy edit-age recovery crosses intervening operator commits (item 4).

## 7ab3b440: link planner

5. **Insertion detaches authored prose from its existing list item.** `clio/notient-extension/lib/link.mjs:109` stops the first-list scan at an unindented lazy continuation. **Violates 04 §6's requirement to insert after the first top-level list including its continuations and preserve existing list content, covered by W11 and the list adversarial cases.** For `## Related\n\n- Existing item\ncontinued authored prose\n`, the planner inserts `- [[Target]]\n` before `continued authored prose`. Markdown then attaches that continuation to the new relationship bullet. Consequently, the operator's prose changes list membership and meaning even though its raw bytes remain present; the final reference check accepts the result.

6. **A Setext heading fails to terminate Related and permits a false no-op.** `clio/notient-extension/lib/link.mjs:70` derives section boundaries solely from the ATX heading expression at `:44`. **Violates 04 §6's next-visible-H1/H2 section boundary and outside-occurrence rule, and W22's required insertion when a target exists only outside Related.** For `## Related\n\n- [[Other]]\n\nNext section\n============\n\n[[Target]]\n`, the Setext H1 is ignored, and the later target is classified as present inside Related. Consequently, the planner returns unchanged bytes without adding the requested relationship to the Related section.

7. **A new Related section uses the tail's separators instead of the document convention.** `clio/notient-extension/lib/link.mjs:93` supplies the last two lines as anchors to `convention`, which returns their separator before considering the file's dominant convention. **Violates 04 §6's requirement to use 02's document convention for a new section, with 02 §1 defining dominance across the complete file.** For `first\nsecond\nthird\nfourth\nfifth\r\nsixth\r\n`, the dominant convention is LF, but the new heading, blank line and bullet use CRLF. Consequently, the generated bytes violate the specified mixed-newline writeback rule even though the original bytes are preserved.

block 866dc3a2 and 7ab3b440: legacy edit-age attribution across operator commits (item 4), reassigned list continuation (item 5), missed Setext section boundary (item 6), and incorrect newline convention for a new section (item 7).

## c78b91ea: relate planner

8. **Adding a relation changes an untouched block-scalar sibling.** `clio/notient-extension/lib/relate.mjs:192` inserts a missing relation after the last nonblank line recorded by the opaque-scalar branch at `:80`. **Violates 04 §6's sibling-preservation requirement and W15 through W19's requirement to change only the selected relation.** For `---\nnotient:\n  memo: |+\n    Keep this line.\n\n---\nBody.\n`, the planner inserts `  supports: ["[[Target]]"]\n` before the blank line retained by `|+`. That blank line then lies outside `memo`, changing its decoded value from `Keep this line.\n\n` to `Keep this line.\n`. Consequently, a successful additive relation operation changes operator-authored metadata outside its selected relation even though the original bytes remain present.

9. **Implicit-null containers without a space after the colon cannot be initialized.** `clio/notient-extension/lib/relate.mjs:184` inserts a map immediately after the colon of `notient:\n`; the corresponding list branch at `:194` does the same for nested `  supports:\n`. **Violates 04 §6's explicit requirement to initialize null maps and null relation lists.** The generated forms are `notient:{"supports": ["[[Target]]"]}` and `supports:["[[Target]]"]`, without the required YAML separation. Final frontmatter validation refuses these generated forms. Consequently, ordinary valid empty containers are rejected instead of initialized. The null fixtures include spaces or comments after the colon and do not cover these forms.

block c78b91ea: changed block-scalar sibling value (item 8) and refused implicit-null initialization (item 9).

## 1f4144c4: fix for item 1

10. **Copying a link label restores code that the visibility mask excluded.** `clio/notient-extension/lib/vitals.mjs:44` copies the raw alias over the earlier visibility mask. **Violates 04 §7's exclusion of code from prose words.** For ``See [shown `hidden code`](Target.md).``, tokenization masks the inline code, but copying the label restores `hidden code`; the result counts four words instead of the two eligible prose words, `See shown`. Reference-link labels follow the same path. Consequently, code inside a label inflates wordBand and health and can satisfy maturity word thresholds. The original hidden-destination example is corrected, but this new counting defect remains at `lib/vitals.mjs:39` in `b45069f1`.

block 1f4144c4: link-label replacement restores excluded code (item 10).

## b6bbd350: fix for item 2

11. **A comment inside a link label makes the hidden destination count as prose.** `clio/notient-extension/lib/markdown.mjs:479` scans each visible source part independently after comment removal. **Violates 04 §7's visible-prose counting contract and leaves the combined link/comment case from items 1 and 2 incomplete.** For `See [shown <!-- hidden --> label](private/secret.md).`, the comment splits the valid Markdown link into two source parts, neither of which contains a complete link token. The counting path therefore retains the destination and counts six words instead of the three displayed words, `See shown label`. Consequently, hidden destination text still inflates health and maturity inputs when a comment occurs inside the label. The original standalone comment-adjacent example is corrected, but this defect remains at `lib/markdown.mjs:500` in `b45069f1`.

block b6bbd350: comment-split link labels expose hidden destinations to word counting (item 11).

## b45069f1: fix for item 3

approve b45069f1 for item 3.

block c78b91ea, 1f4144c4 and b6bbd350: changed block-scalar sibling value (item 8), refused implicit-null initialization (item 9), restored code in link labels (item 10), and hidden destination counting across comments (item 11); approve b45069f1 for item 3.

## 97072019: coordinator integration and version:2 journal

12. **Published version:2 records can bypass immutable-manifest verification.** `clio/notient-extension/lib/journal.mjs:57` requires `intentSet` only for move operations; the version:2 validator does not require it either. **Violates 04 §6's required integrity coverage of admission, splices and vitalsBefore, and 02 §2's refusal of missing or corrupt authoritative journal data.** Removing `intentSet` from a published link, relate or other nonmove version:2 record skips the manifest check, while `prepareFileIntents` at `:129` skips the SQL row verification. Git recognition verifies the committed bytes and operation ID, but does not bind the new admission or edit-age fields. Consequently, an altered rationale or frozen age can pass validation and be returned by a committed retry or adopted during index rebuilding. Unpublished records refuse later in `finishRecord`; that guard does not protect already published records.

13. **Moves that rebase outgoing references lose edit-age provenance and earned maturity.** `clio/notient-extension/lib/vitals-write.mjs:27` identifies a newly created move destination only by equality between its after-bytes and a deleted source's before-bytes. **Violates 04 §6's requirement to freeze provenance for every changed path and §7's preservation of prior edit age and earned maturity through Notient writes.** Moving `Folder/Source.md`, containing `[ref](../Target.md)`, to `Source.md` changes that reference to `[ref](Target.md)`. The equality fails, so the destination receives `vitalsBefore.lastUserEditMs:null`. The same inference at `lib/vitals-index.mjs:86` prevents transferring the prior row, assigning publication-time age and raw maturity. The inverse-origin mapping at `:74` also fails for that move, and rebuilding cannot recover the source through the unequal-byte heuristic. Consequently, a supported move and its inverse can discard provenance even though the operation already records explicit source and destination identities. The added move fixture uses unchanged body bytes and does not cover rebased outgoing links.

14. **The new freezing path can make a stale cached edit age authoritative.** `clio/notient-extension/lib/vitals-write.mjs:18` accepts a cached age when the index's global lastCommit equals the current HEAD. **Violates 04 §6's frozen-provenance requirement and §7's requirement for verified attribution without crossing intervening operator edits.** Capture and index bytes A at T0; let the operator commit B and then restore A at T1; run explicit refresh; then perform a Notient replacement A to C. The existing matching-revision path retains T0 in `lib/vitals-index.mjs:95`, while `lib/index.mjs:198` updates the global lastCommit to the operator's new HEAD. The new freezing code therefore accepts T0 without checking the intervening path history and stores it in the version:2 record. Consequently, the falsely old age survives a subsequent index rebuild and can satisfy the seven-day maturity threshold. This is a separate cache-to-journal path that remains after V4 repairs the legacy-history traversal.

block 97072019: optional integrity manifest on published version:2 records (item 12), lost provenance on moves with rewritten outgoing references (item 13), and stale cached age frozen into new history (item 14).

## 509e8f4f: V4 fix for item 4

approve 509e8f4f for item 4's legacy-history traversal.

## 81b4825b: V5 fix for item 5

approve 81b4825b for item 5.

block 97072019: missing-manifest integrity bypass (item 12), move provenance loss (item 13), and stale cached age publication (item 14); approve 509e8f4f for item 4 and 81b4825b for item 5.

## 27386e2c: V6 fix for item 6

15. **A Setext title beginning with triple-backtick inline code still permits an outside-target no-op.** `clio/notient-extension/lib/link.mjs:78` skips every candidate title beginning with three or more backticks before reaching the uncertainty refusal at `:83`. **Violates 04 §6's next-visible-H1/H2 section boundary and outside-occurrence rule, W22, and the standing rule that uncertain syntax refuses.** Consider this source, with a final LF and a live `Target.md`:

~~~~text
## Related

- [[Other]]

```Next section```
============

[[Target]]
~~~~

The title contains a complete inline-code span, not a fence opener: `lib/move.mjs:155` rejects a backtick fence whose info contains backticks, then masks only the inline span at `:173` through `:184`. The Setext underline and later target remain visible. However, the new section scan skips the title without recognizing the heading or refusing uncertainty. Related therefore extends to EOF, `hasReference` at `lib/link.mjs:94` accepts the outside target, and `planLink` at `:180` returns unchanged success. Consequently, the requested relationship is still omitted from Related. The plain-title witness from item 6 is fixed, but this boundary defect remains through `cd63f033`.

block 27386e2c: missed Setext boundary for a triple-backtick inline-code title (item 15).

## 43166601: V7 fix for item 7

approve 43166601 for item 7.

## 5b3767c8: V8 fix for item 8

approve 5b3767c8 for item 8.

## 0270e1dd: V9 fix for item 9

approve 0270e1dd for item 9.

## cd63f033: V10 fix for item 10

approve cd63f033 for item 10.

block 27386e2c: missed Setext boundary for a triple-backtick inline-code title (item 15); approve 43166601 for item 7, 5b3767c8 for item 8, 0270e1dd for item 9, and cd63f033 for item 10.

## d752fa82: V11 fix for item 11

16. **Counting link labels separately splits one visible word into two.** `clio/notient-extension/lib/vitals.mjs:43` counts display text independently after masking the complete link at `:40`, then adds it to the surrounding prose count at `:47`. **Violates 04 §7's maximal visible-word rule, including internal apostrophes and hyphens.** For `well-[known](Target.md)`, the displayed text is `well-known`, one word. The new counting path instead counts `well-` as one word and `known` as another. Likewise, `un[known](Target.md)` counts two words instead of the single displayed word `unknown`. The earlier label substitution preserved adjacency to the preceding prose in these examples. Consequently, the V11 change inflates words, wordBand and health and can satisfy maturity word thresholds without the required visible prose. The comment-split destination witness from item 11 is fixed, but the new counting defect remains through `b1f96899`.

block d752fa82: artificial word boundaries around link display text (item 16).

## 976920a1: V12 fix for item 12

approve 976920a1 for item 12.

## a6ab3a13: V13 fix for item 13

17. **Batch undo can freeze another note's edit age onto the restored note and discard its earned maturity.** `clio/notient-extension/lib/vitals-write.mjs:12` at `b1f96899` selects the current path's age whenever the inverse has non-null before-bytes. `lib/write.mjs:586` supplies restored ages only for newly recreated paths, and `lib/vitals-index.mjs:100` uses inverse identity only when no old row exists and the path is recreated. **Violates 04 §6's provenance requirement for every operation and §7's preservation of prior edit age and earned maturity through undo.** Start with A.md at a fourteen-day edit age and earned synthesis-ready maturity, and C.md at a one-day age and raw maturity. In one batch move A.md to B.md, then C.md to the vacant A.md. Both destinations are absent when each move runs. The supported batch inverse replaces A.md's current C bytes with original A bytes, deletes B.md and recreates C.md. Although `inverseOrigins` correctly maps restored A to B, the occupied-path branches retain C's one-day age and raw maturity for A.md. Consequently, the inverse records that incorrect age in its version:2 manifest, so rebuilding preserves the wrong attribution, and the original A loses its earned maturity. The single-move witness from item 13 is fixed; identity transfer remains incomplete when a batch reuses a vacated path.

block a6ab3a13: batch-undo provenance follows an occupied path instead of the restored note (item 17).

## 97d3029c: V14 fix for item 14

approve 97d3029c for item 14's cache-to-journal attribution path.

## b1f96899: frozen stage 4 tool contracts

18. **Stage 4a can select hybrid search by default while embeddings remain off.** `clio/notient-extension/lib/embedding-off.mjs:42` selects hybrid whenever the registered vault's accepted `embeddings` boolean is true and the caller omits mode. **Violates 04 §4's explicit stage 4a requirement, "Default search stays lexical."** The configuration reader accepts a saved future embedding profile and opt-in bit, while every semantic path in this release still reports embedding state off. With a current structural index, an ordinary search under that configuration therefore returns `mode:hybrid`, `reason:embedding_off` and incomplete coverage instead of the required lexical default and its structural coverage. Consequently, a configuration bit changes the default read contract before stage 4b implements semantic retrieval.

approve b1f96899 for the literal candidates, vitals and revise schemas, the prescribed search/refresh schema additions, and typed embedding_off results; block its stage 4a default-mode selection (item 18).

block all of stage 4a at b1f96899: batch-undo provenance loss on reused paths (item 17), the unresolved Setext section boundary (item 15), artificial word boundaries around link labels (item 16), and premature hybrid default selection (item 18).
