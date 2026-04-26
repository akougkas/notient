# Phase 4 Independent Review

Date: 2026-04-26
Branch: `beta-spec`
Head: `9c37192`
Range reviewed: `6e29a5e..HEAD` shows 24 commits, including the Phase 4.5 and 4.6 planning commits.

## Gate Results

| Gate | Result |
| --- | --- |
| `git status --short` before gates | clean |
| `bun run typecheck && bun run lint && bun test` | pass, 496 tests |
| `bun run build` | pass, `main.js` 1,139,786 bytes |
| `bun run smoke:phase4` | skipped, endpoint unreachable at `http://192.168.86.141:8080/v1` |
| Mini substrate sweep in `src/ scripts/` | clean |
| Banned token and dash spot check | no true dash-clause prose violation found in added prose |

## Severity Counts

| Severity | Count |
| --- | ---: |
| Critical | 3 |
| High | 4 |
| Medium | 4 |
| Low | 3 |

## Findings

1. Critical: SearchView GUI does not execute searches. `SearchView.configure` installs a runner, but `searchAppActions.runSearch` in `src/main.ts:839` only records history. It never calls `dispatchSearch`, and `cancelSearch` never calls `cancelDispatch`. `QueryBar` and `FilterRow` only call `searchActions.value?.runSearch()`, so entering a query or toggling a maturity filter does not drive the pipeline in Obsidian.

2. Critical: universal undo is not wired to the production mutation paths claimed by Phase 4. Chat note tools insert raw markdown into `history` in `src/core/chat/tools/notes.ts:355`, while `HistoryService.undo` parses `before` and `after` as JSON in `src/core/history/historyService.ts:96`. A normal chat write can make `notient-undo-last` throw before the inverter runs. Separately, `ApprovalService` records no history rows for accept/reject, and maturity/native-graph writes have inverters but no production producer.

3. Critical: typed native-graph relation approvals are not harmless when EchoGuard is absent. `NativeGraphBridge.applyApprovedRelation` writes frontmatter without `echoGuard.mark` in `src/core/graph/nativeGraphBridge.ts:56`. The save handler will reindex because `indexNote` hashes the whole note at `src/core/indexer/indexNote.ts:30`, strips frontmatter only after that, and deletes outgoing graph edges for the note at `src/core/indexer/indexNote.ts:85`. A note-level `CONTRADICTS` or `SUPPORTS` approval can be promoted, written to frontmatter, then removed by the follow-on reindex.

4. High: frontmatter updates are shallow and can clobber existing `notient` data. `mergeFrontmatter` overwrites top-level keys in `src/core/chat/tools/notes.ts:407`. Native relation writes and Vitals writeback both patch `{ notient: ... }`, so health, freshness, relations, or prior relation targets can replace each other instead of merging or appending idempotently.

5. High: the Search and Canvas GUI surface is incomplete. `SearchApp` renders `QueryBar`, `FilterRow`, results, and preview only. There is no "View as canvas" control in `src/ui/search/SearchApp.tsx:8`, and the configured `viewAsCanvas` action saves a canvas but does not open it. I also found no UI path for "Preview as canvas" on a Synthesizer proposal; only the canvas generator core is tested.

6. High: Deep synthesis citations are not clickable. `SynthesisCard` renders citation spans with `data-wikilink` at `src/ui/search/components/SynthesisCard.tsx:37`, but there is no click handler that calls `openLink`.

7. High: yolo mode is not reachable as specified from Chat. `ChatActions.toggleYolo` exists in `src/main.ts:958`, but `ChatTab` exposes no control or confirmation modal. Yolo auto-approval also does not render a pill, because `ApprovalGate` calls only `onResolved` in yolo mode and `recordHistoryAutoApprove` is intentionally a no-op in `src/main.ts:574`.

8. Medium: editor decoration clicks do not target the proposal. The CM6 dot click handler in `src/main.ts:1079` switches to the Stream tab, then discards `proposalId`. `StreamTab` has no selected or focused proposal state, so the DoD requirement to open Stream "to that proposal" is not met.

9. Medium: Vitals persistence on save is ordered before indexing. The modify handler emits `vault:note-saved` at `src/main.ts:1117`, then enqueues indexing. The Vitals listener at `src/main.ts:1040` computes against the old `notes` row. After the indexer updates word count and `updated_at`, no second Vitals persist is triggered. If frontmatter writeback is enabled, it also loops once through the modify handler because there is no EchoGuard mark.

10. Medium: today's smoke did not exercise live mini. The script behaved correctly by skipping on an unreachable endpoint, but it did not reconfirm the prior live chat/search path.

11. Medium: most DoD rows remain human-only in Obsidian. The code paths exist for many rows, but GUI behavior for Search, Canvas, yolo mode, deep citation clicks, decoration focus, and native graph refresh has not been driven by a person.

12. Low: stale substrate language remains in docs and conventions. `src/` and `scripts/` are clean, but the Phase 4 plan still says "dynamo" and "LM Studio" in several places, and `.claude/CLAUDE.md` still says LM Studio. The locked mini defaults in `src/core/settings/types.ts` are correct.

13. Low: production `console.*` sites remain despite project conventions. `rg` found production logging in `src/main.ts`, `src/core/llm/lmStudioProvider.ts`, co-author files, and agent error paths.

14. Low: the requested commit count is off by two. The reviewed range contains 24 commits because the Phase 4.5 and Phase 4.6 planning commits are included before the 22 Phase 4 implementation commits.

## DoD Coverage Table

| DoD item | Automated backing | Still user-only or currently blocked |
| --- | --- | --- |
| Stream tab ranks top items, refreshes after agent run, updates active-note relevance | `streamService.test.ts`, `ranking.test.ts`, `src/main.ts` starts service and subscribes signal | 100 ms warm-DB render and visual top-5 in Obsidian |
| Decoration dots appear and click opens Stream to proposal | `insightsPlugin.test.ts`, `paragraphMap.test.ts` | Click only switches tabs and drops `proposalId`; GUI timing still untested |
| Vitals tab renders active-note freshness, health, connectivity, maturity | `vitalsService.test.ts`, active-leaf binding in `src/main.ts` | Save-time agreement is suspect because Vitals persists before reindex |
| Approve `LINKS_TO`, append `## Related`, native graph shows edge | `approvalService.test.ts`, `nativeGraphBridge.test.ts`, `relatedSection.test.ts` | Native graph refresh after `metadataCache:resolved` requires Obsidian |
| Approve `CONTRADICTS`, frontmatter gains target wikilink | `nativeGraphBridge.test.ts` | Durability is blocked by missing EchoGuard and shallow frontmatter merge |
| Synthesizer proposal "Preview as canvas" writes and opens native canvas | `canvasGenerator.test.ts` | No proposal preview UI path found; opening native canvas untested |
| SearchView Balanced returns results, maturity filter reruns, canvas export works | `searchPipeline.test.ts`, `balanced.test.ts`, UI render tests, smoke path direct-calls pipeline | GUI run/cancel is not wired; no visible canvas button found |
| Deep mode synthesis card cites notes and citations open notes | `deep.test.ts`, `SynthesisCard` render | Citations are inert spans, not clickable links |
| Chat conversation persists and parser roundtrips | `conversationStore.test.ts`, `conversationParser.test.ts`, `chatService.test.ts` | Obsidian native search discovering the file requires GUI |
| Chat autonomously calls `vault.search_notes` and contradiction tool | `agentLoop.test.ts`, tool tests, prior smoke claim | Today's smoke skipped; live mini chat not reconfirmed |
| Safe-mode write tool renders ApprovalCard and approve/reject continues agent | `approvalGate.test.ts`, `notes.test.ts`, `ApprovalCard.test.tsx`, `agentLoop.test.ts` | Human click path in Obsidian still untested |
| Yolo mode auto-applies and renders auto-approved undo pill | `approvalGate.test.ts`, `ApprovalCard.test.tsx` in isolation | No Chat toggle/confirmation, no runtime auto-pill, no history id |
| `notient-undo-last` undoes recent mutations across categories | `historyService.test.ts`, `inverters.test.ts` | Production history producers are incomplete; chat rows use wrong serialization |
| Typecheck, lint, tests green and tests >= 250 | Gate run passed | none |
| `smoke:phase4` live line reports all surfaces ok | Smoke script exists and supports skip | Today's run skipped because mini chat endpoint was unreachable |

## Wiring Probe Summary

All Phase 4 services are registered before `kernel.seal()` in `src/main.ts`. The services that need a lifecycle start call are started: health, coordinator, idle detector, and stream. Search, chat, approvals, history, canvas, native graph bridge, vitals, saved queries, and conversation services are action-bound or event-bound rather than `start()` services.

The main wiring gaps are action-level, not registration-level: Search actions never call the dispatcher, decoration clicks drop the target proposal, yolo has no reachable UI path, canvas export lacks visible/opening UI, and frontmatter write paths are not EchoGuarded.

## Recommended Fix List

1. Wire Search GUI actions to `dispatchSearch()` and `cancelDispatch()`. Add a test that submits `QueryBar` and toggles `FilterRow` through the configured `SearchAppActions`.
2. Route all history producers through `HistoryService.record()` or JSON-serialize consistently. Inject history recording into approval accept/reject, native graph bridge writes, and maturity promotions. Return history ids where UI needs one-click undo.
3. Fix frontmatter writeback EchoGuard. The facade should expose the post-merge content or a helper that can compute the final sha before the atomic write. Add regression tests proving typed relation approval keeps the approved graph edge after the modify handler fires.
4. Replace shallow frontmatter overwrite with a real merge for `notient` objects and idempotent append for relation arrays.
5. Complete Search and Canvas UI: run/cancel, "View as canvas", native canvas opening, and Synthesizer proposal preview.
6. Make Deep citation spans use the same clickable wikilink path as chat citations.
7. Add Chat yolo toggle with confirmation and runtime auto-approved undo pills backed by real history ids.
8. Add focused proposal state for Stream so editor decoration clicks land on the exact proposal.
9. Reorder Vitals persistence to run after indexing or listen to `indexer:note-indexed`; suppress opt-in Vitals frontmatter echoes.
10. Update stale docs/convention wording from dynamo and LM Studio to mini/OpenAI-compatible where applicable.

## Post-Review Fix Pass

Applied after user approval on 2026-04-26:

- Fixed SearchView run/cancel wiring and active-mode search history.
- Fixed chat note-tool history serialization and made `HistoryService` tolerate legacy raw rows.
- Added production history records for edge accept/reject and native graph bridge writes.
- Reworked typed relation and Vitals frontmatter writeback to read, merge, hash, EchoGuard mark, then write.
- Added idempotent deep merge for inline `notient` frontmatter objects and relation arrays.
- Added visible Search "View as canvas", opened exported canvases, and added Stream "Preview as canvas" for synthesis proposals.
- Made Deep Search citations clickable.
- Added Chat safe/yolo toggle with confirmation and write-tool undo pills from real history ids.
- Removed duplicate agent-loop pre-approval so write tools present one markdown-preview ApprovalCard.

Post-fix gates:

| Gate | Result |
| --- | --- |
| `bun run typecheck && bun run lint && bun test` | pass, 502 tests |
| `bun run build` | pass, `main.js` 1,147,932 bytes |
| `bun run smoke:phase4` | skipped, endpoint unreachable at `http://192.168.86.141:8080/v1` |
