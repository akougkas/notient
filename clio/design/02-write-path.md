# Stage 2: recoverable writes for Sentient Notes

Status: implementation contract for Sol, incorporating the manager's amendments A through G, NOTIENT.md section 7 and the manager's triage of 2a-review-1. Product policies in section 8 are provisional pending the owner.
Baseline: `clio-mvp` at `453af506`. Scope: NOTIENT.md B3, B6 stage 2, B7 and the explicitly inherited archive cases. Target: Clio 0.6.2 as released.
Implement only under `clio/`, with Node standard library, `node:sqlite` and installed Git. No dependencies, daemon, runtime writes or Clio repository changes. The external data directory remains necessary on 0.6.2.
**2a:** capture, replace, frontmatter, single-operation undo, journal, recovery and Git. Ship and use 2a in a real Clio fixture session before implementing 2b.
**2b:** move and batch undo, including all reference repair and multi-note recovery. Stage 2a may omit these inputs; stage 2b adds them through operator reinstallation and a fresh session.
Sources: archive DESIGN sections 2.3, 3.4 through 3.7 and 4.2; SPRINT G-01 and N-19/N-22/N-23/N-25/N-26. Fresh implementations replace the old verbatim-port requirement. Current B3 tool scope supersedes old link/relate tools, old folder names and old approval workflows.

## 1. Revision and body semantics

**2a:** all byte, frontmatter and capture rules. **2b:** reuse them for every moved/referring file and inverse batch delta.

- `revision` is lowercase SHA-256 of the complete original Buffer, including UTF-8 BOM, frontmatter, CR/LF and final newline. Absence is `null`, never the hash of an empty file. Git OIDs are separate.
- Accept valid UTF-8 only, at most 4 MiB per note; reject NUL and unpaired surrogates in supplied strings. Buffers are authoritative. Map UTF-16 parser positions to UTF-8 byte offsets before splicing.
- Split lines into content plus exact terminator (`LF`, `CRLF`, none). Never normalize an existing file. Generated frontmatter lines use its first terminator, otherwise LF; replacement separators follow the rule below. Mixed endings outside an edit remain unchanged.
- Frontmatter opens only on the first line after optional BOM, with `---` plus optional horizontal whitespace. It closes with `---` or `...` plus optional horizontal whitespace. An unclosed opening refuses with `FRONTMATTER_INVALID`. The span includes both delimiters and the closing terminator; the body begins after it, or after BOM when absent.
- `replace` locates exact `oldText` in the body only, counting overlapping matches at offset + 1. Require one occurrence. Zero returns `QUOTE_NOT_FOUND` with exactly `not an exact supplied quotation; copy a contiguous passage verbatim, preserving punctuation and whitespace`; several return `QUOTE_AMBIGUOUS` with exactly `occurs more than once; quote a longer contiguous passage identifying one occurrence`. Never match frontmatter or normalize the quotation to obtain a match.
- Reject any bare CR in `newText`, meaning a CR not followed by LF, before planning a replacement. Recognize CRLF as one separator and LF as one separator. Convert every separator in `newText` to the matched span's sole newline convention, even when the caller supplied another convention. For example, replacing `a\r\nb` with `x\ny` stores `x\r\ny`. When the matched span has no separator, use the file's dominant newline convention: count CRLF pairs and standalone LF separators across the complete file, choose the more frequent convention, break a tie with the file's first separator, and use LF when the file has none. This preserves the file's prevailing style for a newly introduced multiline span. An exact oldText/newText identity without bare CR remains a no-op. For any other matched span mixing CRLF and LF, refuse a replacement containing separators with `MIXED_NEWLINE_EDIT`; a single-line replacement is safe. Preserve every byte outside the splice. EOF newline changes require a match reaching EOF and an explicit replacement that changes it.
- `frontmatter` changes top-level keys only, preserving BOM, delimiters, unrelated fields/comments/order and all body bytes. Read bounded spans for ordinary YAML mappings, quoted scalars, flow collections and block scalars. Reject duplicate/complex keys, ambiguous boundaries, merge keys, anchors, aliases, custom tags and malformed quoting. Do not repair YAML.
- `set` values are JSON encoded in `valueJson`: null, boolean, finite number, string, array or object; maximum decoded depth 4 and serialized UTF-8 size 4,096 bytes. Emit JSON expressions, which are valid YAML 1.2. Preserve the key/colon prefix and an unambiguous same-line comment; append new keys before the closing delimiter in input order. Preserve standalone comments outside a replaced field span.
- Reject duplicate set/unset keys and overlap. An absent unset is a no-op. With no block, prepend one after the BOM using the selected newline while retaining the complete body; unset-only remains a no-op. No implicit timestamps for revise.
- Capture accepts a complete Markdown document, normalizes its new document's CRLF to LF, preserves optional BOM and body EOF choice, and adds the mandatory provenance described in section 5. It does not promise byte-identical caller frontmatter.
- A move changes only parsed destination spans and paths, preserving display aliases, fragments, labels, titles and every unrelated byte. Exact before/after Buffers are the basis for preview, recovery and undo.
- Link writeback, including Related sections and frontmatter relation arrays, belongs to stage 4. Its W table and planners are outside 2a/2b. The witness tool, served-window locator and V table are deferred. Stage 2 retains the body-only replacement quotation rules above and their ordinary replacement tests.
- Reason: byte splices preserve authored Markdown without expanding stage 2 into deferred link writeback or witness work.

## 2. Intent journal and recovery

**2a:** the complete coordinator, with one note plus its log and single-op inverse. **2b:** the same coordinator over every move path or batch delta, all file intents prepared before any stamp.

### Layout and authority

Use resolved external data directory `D`; directories 0700, journal files/blobs/private indexes 0600.

```text
D/journal/<vault-id>/writer.db
D/journal/<vault-id>/intents.db
D/journal/<vault-id>/ops/<operation-id>/record.json
D/journal/<vault-id>/ops/<operation-id>/blobs/<sha256>
D/journal/<vault-id>/ops/<operation-id>/commit-index
```

- `requestId` is optional. Accept 8 to 64 ASCII characters matching `[A-Za-z0-9._-]{8,64}`; mint and return a UUID if absent. The supplied or minted requestId is the operationId, journal record ID, operation-directory basename and audit/commit operation ID. Allocate no separate operation UUID and require no extra request-ID trailer. IDs are unique per vault across tools; retries find the original record and OID. Validate the entire ID before using it as a single directory component. Per-file intent IDs remain internal UUIDs.
- Digest recursively key-sorted validated request JSON with defaults, excluding `dryRun`, `planHash` and `requestId`, and bind to vault ID/tool. Preserve array order/request words. Reuse of an ID with another digest is `REQUEST_ID_REUSED`. A retry with no supplied ID is new work; previews/no-ops reserve no ID.
- Hold SQLite `BEGIN IMMEDIATE` on `writer.db` for the whole real write/recovery, busy timeout 5,000 ms; roll back on release. OS locks release after SIGKILL. Every Notient vault mutator takes it. A competing writer returns `WRITER_BUSY`; status reports busy. Do not age-reclaim a live writer.
- `intents.db` is a separate database so durable stamp transactions can commit while the writer-lock transaction remains open. Use WAL, `synchronous=FULL`, busy timeout 5 seconds. The structural index remains independent, per-note transactional and idempotent by `(path,revision)`.
- Dry runs create no database, directory, journal, Git object, temporary file or audit line. Inspect pending records read-only; refuse `RECOVERY_REQUIRED` if any unfinished content/ref/index work remains. This exception preserves N-25's zero-write dry run. Search/refresh/note and the API 2 runtime never recover vault writes.

### Durable schemas and ordering

All fields required; unknown versions fail closed; null/empty values initialize unavailable fields. Limits: record 8 MiB, 100 changed note paths plus one log, 64 MiB combined before/after blobs.

```text
record = {
  version:1, id:string, requestId:string, vaultId:string, vaultPath:absolute path,
  tool:capture|revise|undo, operation:capture|replace|frontmatter|move|undo,
  requestDigest:sha256, batch:string, authorization:{origin,request},
  roleAtIntent:operator|own, createdAt:UTC ISO, updatedAt:UTC ISO,
  state:intent|applied|committed|conflicted|aborted, planHash:sha256,
  source:relative path|null, destination:relative path|null,
  reads:[{path,revision}], inventoryHash:sha256|null,
  files:[{intentId:UUID,path,role:note|log,action:create|replace|delete,
          before:sha256|null,after:sha256|null,mode:integer,temp:relative path|null}],
  intentSet:{manifestHash:sha256,prepared:boolean}, applyOrder:[relative path],
  createdDirectories:[relative path],
  git:{ref:string,baseHead:oid|null,tree:oid|null,commit:oid|null,
       entries:[{path,before:{mode,oid}|null,after:{mode,oid}|null}]},
  log:{path,line}, undo:{targets:[string],commits:[oid]}, undoneBy:string|null,
  capture:{bodyHash:sha256,workspace:string,capturedAt:UTC ISO,limitPerHour:integer}|null,
  indexState:pending|updated, derivedIndexState:pending|updated,
  durability:full|limited, warnings:[{code,message}],
  conflicts:[{path,expectedBefore,expectedAfter,actual,reason}],
  timings:{scanMs,lockWaitMs,journalMs,applyMs,gitMs,totalMs}, error:{code,message}|null
}
intents row = {id:UUID PRIMARY KEY,operation_id:string,path:string,
  manifest_hash:sha256,before_hash:sha256|null,after_hash:sha256|null,
  authorization_hash:sha256,state:prepared|applied,write_started_at_ms:integer|null}
```

- Each before/after hash names an immutable full Buffer blob; null denotes absence. Include the log too. One file intent per path includes a move's separate source deletion, destination creation and all referrers. Unchanged dependencies belong in `reads`.
- Freeze role, authorization, batch, timestamp, capture provenance/name/body hash, audit line, full target set and order. Recovery never asks a model, chooses another suffix, invents request words or upgrades origin.
- Exclusive-create each blob, verify and fsync it plus its directory. Write/fsync `record.json.tmp`, rename it and fsync its directory/new ancestors. The initial record has `intentSet.prepared=false`; its manifest hash binds all immutable file descriptors and authority.
- Insert every file intent in one `intents.db` transaction with null stamp/state prepared, then COMMIT. Persist `intentSet.prepared=true` by the record fsync/rename protocol. Only then can any file be stamped. Recovery of a false marker verifies already inserted rows or inserts the whole set when absent and all paths still equal before. Partial/mismatching row sets are `JOURNAL_CORRUPT`.
- Immediately before a file publication, commit `UPDATE intents SET write_started_at_ms=? WHERE id=? AND write_started_at_ms IS NULL AND state='prepared'`. Exactly one affected row is a fresh claim. Zero rows cannot authorize a competing fresh write. Under the exclusive writer lock, recovery may resume an already stamped row after the four-input decision below. Never clear a stamp.
- The second crash boundary is after publication/fsync but before updating that row to applied. Mark it applied in a committed SQLite transaction only after a live after-hash check. Set operation applied after every path, including log, is verified after. Treat stale JSON/progress as hints, not proof of file contents.
- Persist candidate Git OID before file publication. A published/verified ref makes the operation committed; attempt normal-index repair first, but a bounded lock failure may leave a committed record with `indexState=pending`. `derivedIndexState` separately tracks searchable-index repair after commit.
- Fsync files is mandatory. Unsupported directory fsync and older Git's weaker durability yield `durability=limited` with specific warnings; other sync errors stop progress. Never claim power-loss guarantees beyond the filesystem. Keep records/blobs/history through MVP; no pruning.

### Recovery at every real write and command status

1. Take the writer lock; inspect records plus SQL rows, verify schemas, manifests and blobs. Process nonterminal operations and committed records with pending index/derived/backlink cleanup in creation order. Missing/corrupt authoritative journal data blocks the vault with `JOURNAL_CORRUPT`; never rebuild stamps from observed after-bytes.
2. Check canonical root/registration and write access. Apply the intersection of frozen role/origin restrictions and current role/access to the complete target set, including undo provenance. Revocation/downgrade gives `RECOVERY_BLOCKED_AUTHORIZATION`; preserve bytes/ref. Status cannot promote an unattended operation to operator origin.
3. Recognize the recorded candidate by exact OID, parent, tree, operation/authority trailers and reachability on the recorded branch. If already published, do not reapply notes or log, even after later human saves. Repair only eligible normal-index entries, mark committed, restore undo backlinks and derived state. Report `already_committed`, `index_repaired` or `committed_index_pending` with the actual OID.
4. Otherwise read every touched path's raw current bytes or absence. For each file evaluate `(current,before,after,writeStartedAt)` using the table below; do this for the whole set before further mutation. Missing creation is before; missing deletion is after. Ignore cached progress when deciding.

| Observed case | Action and report |
| --- | --- |
| Current equals before, different from after | If unstamped, claim it; if stamped, resume it under the writer lock. `resumed_from_intent` when the entire operation is before. |
| Current equals after, different from before, stamp exists | Do not rewrite. Mark that row applied; finish the original prepared Git commit. All after gives `committed_after_apply`; a before/after mix gives `completed_partial_apply`. Never append another log line. |
| Current equals after, different from before, no stamp | Refuse as `UNSTAMPED_AFTER`, attributed to another writer; `conflict_preserved`. Identical desired bytes alone do not prove Notient wrote them. |
| Current equals neither | Refuse `NEWER_EDIT`, preserve bytes and block further vault mutations; `conflict_preserved`. This includes a torn O_EXCL creation whose writer cannot be proved. |
| Before equals after equals current | Pure reconciler returns unchanged with either stamp state. Actual plans omit such file intents. |

5. Before resuming any path, require recorded branch/base HEAD, valid Git state, unchanged dependencies/inventory except this operation's transitions, and ownership of temporary artifacts. A changed HEAD/dependency with all paths before and no published commit aborts as `aborted_unapplied`; partial application conflicts. Never silently rebase a pending write.
6. If files are after but commit preparation is missing, validate/reconstruct the exact candidate from frozen blobs, parent, time and message, then publish with expected old OID. Normally preparation precedes publication; missing required rows/blobs remain corruption. If `update-ref` may have run, reread the ref before any retry. After-bytes plus stamps permit completion; neither a new request nor a new authorization is necessary.
7. Conflicted operations reclassify next call. Resume only after restoration to valid recorded states and original Git/read preconditions. An unstamped-after path must be restored to before; never retroactively stamp it. A torn new file is preserved for comparison with the journal; restoring absence allows exclusive-create retry. Never automatically truncate, delete or accept a matching prefix.
8. `aborted` requires all-before and no published commit, solely for step 5; retry returns `OPERATION_ABORTED`. No conflict-abandon tool. Clean only proven journal-owned temporary files after committed/aborted durability. Normal Git locks are always Git's responsibility; never delete them. Return each attempted recovery result with duration, pending IDs and conflicts. New writes wait until prior content/ref/normal-index work resolves.

Command status adds `recovered` containing these results; API 2 status/log projections remain read-only. This explicitly supersedes B3's old status “none” column and the archive's recovery-on-every-index-reader rule: a search cannot acquire hidden vault/Git write authority. Corrupt structural indexes can be quarantined/rebuilt independently; journal corruption cannot.

## 3. Publishing bytes and observed races

**2a:** replacement rename, exclusive creation, log append and single-op inverse. **2b:** source deletion, destination creation and reference updates in one recoverable operation.

- Validate paths component-by-component beneath the registered real root. Refuse symlinks, nonregular files, unexpected hard links, hidden note paths, traversal, Windows-reserved/trailing-dot/trailing-space names and case-fold collisions. Reject case-only moves. Capture's parent realpath must be the registered `Notient/Inbox`.
- Compute the full plan before intent, including revisions, authority, Git preconditions, log and diff. 2b scans live Markdown/attachments and records dependencies instead of trusting the index; recheck them before first publication.
- For replacement, after durable intent prepare/fsync a hidden sibling `.<name>.notient-tmp-<pid>-<intentId>` with `O_EXCL`, original mode, and parent fsync. Commit its write stamp, immediately reread/check the target's raw before revision and regular-file identity, then rename the sibling, fsync parent and verify after-bytes. Obsidian ignores dotfiles; sync may briefly upload them.
- A failed compare rereads the target: exact after with an existing stamp is already applied; a third value conflicts. Preserve the exact newer bytes. No implicit retry with a revised before revision.
- Creates use `open` with `O_WRONLY|O_CREAT|O_EXCL`, mode 0600, after durable intent and stamp; write all bytes, fsync, close and fsync parent. No `link()` anywhere. `EEXIST` triggers reconciliation, never truncation or a new collision suffix. New files may be observable empty/partial; a process crash is covered by the journal's preserved before/after and conflict recovery, not an atomic-create claim.
- Allocate capture suffixes before intent, from the chosen dated name through `-2` to `-9999`, case-folded. Freeze the selected name. For replacements, fsync/rename prevents torn Markdown; this guarantee does not extend to O_EXCL creates.
- 2b order: create destination with rebased outgoing links, replace other referring notes sorted by path, delete source after a final source-revision check, then apply the frozen log. Prepare every intent first; stamp immediately before its own publication. Multi-file work is recoverable, never advertised as an atomic vault transaction.
- Record each applied row durably. On failure retain partial progress for recovery; no blind rollback. Post-publication changes are reported as third states unless the operation's ref was already published, in which case they are subsequent edits.
- A save before final revision check is `REVISION_CONFLICT`. A save after publication is detected by postcheck/recovery when observable. A save strictly between check and rename/unlink can be overwritten by portable Node. Require quiescent affected files and their staging for live checks, disclose the residual race, and exercise concurrency only on fixtures under P1.

## 4. Git isolation, durability and latency

**2a:** private commit construction, publication, index repair and a single-op inverse commit. **2b:** use exactly the same path for multi-file moves and aggregate batch inverses.

- Require the vault's own ordinary `.git`, a symbolic local branch and no merge/rebase/cherry-pick/unmerged state. Refuse shared worktrees, sparse/split indexes and unsupported index extensions. Support unborn HEAD with an empty tree and no parent.
- Before intent, existing affected notes/logs must equal their raw HEAD and stage-0 index blobs/modes. Refuse affected staged/unstaged changes, untracked existing files, assume-unchanged/skip-worktree or filter/encoding/EOL baseline mismatches with `DIRTY_TARGET`/`GIT_ENCODING_MISMATCH`. Unrelated staged/unstaged/untracked files remain untouched. No silent baseline commits; unborn vaults permit new targets only.
- Leave `.gitignore` and tracked workspace files unchanged. Report whether recommended `.obsidian/workspace*.json` ignores work using `git check-ignore --no-index`. Track precisely planned Notient notes/logs even if `Notient/` is ignored, using explicit plumbing entries; never stage directories or sweep operator changes.
- Use fixed argv, no shell. Clear inherited Git repository/index/object/author selection variables. Per call set `core.autocrlf=false`, `core.safecrlf=false`, `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `commit.gpgsign=false`, `gc.auto=0`; never alter user config. Raw blobs use `hash-object --no-filters -w --stdin`; read with `cat-file`.
- Author/committer: `Notient <notient@localhost>`, both timestamps frozen to intent time. Origin/request remain attribution in journal/log/trailers, not impersonation of the operator.
- Build private `GIT_INDEX_FILE=.../commit-index`: `read-tree <baseHead>` or `--empty`, then `update-index --add --cacheinfo` for planned blobs/modes and `--force-remove` for deletions, then `write-tree`, `commit-tree`. Verify tree delta equals only journal paths. Persist candidate OID/tree before touching notes; unreachable preparation objects are harmless.
- Record affected normal-index entries and recheck them before first publication. Do not take or manufacture `.git/index.lock`, copy/install a whole normal index, use hard-link seeds, or stage from working files. Normal-index updates happen only after ref publication.
- Once every after-state is verified, run `update-ref <ref> <candidate> <baseHead>` with expected old OID, using repository-format zero OID for unborn HEAD. If HEAD moved, leave applied bytes/journal and report `GIT_HEAD_CHANGED`; do not force or rebase. If the ref is already at/reachable through the exact candidate, recover its publication.
- After ref publication, for each planned path reread its stage-0 entry. If equal to planned after, skip; if equal to recorded before, run normal `git update-index --add --cacheinfo` or `--force-remove`. Git acquires/releases its own lock. An affected third entry gives `COMMITTED_INDEX_CONFLICT`, leaves it untouched and keeps indexState pending. Unrelated entries need no refresh.
- On foreign lock failure make at most three retries, with 100/250/500 ms delays inside a shared 2,000 ms contention budget. On exhaustion return the committed OID, `indexState=pending` and warning `GIT_INDEX_BUSY`; recovery finishes eligible entries. Never delete a foreign lock. An index error cannot erase a published commit or justify repeating note writes.
- Normal-index repair is resumable per path. Operator staging on unrelated paths is permitted and must remain byte-identical; same-path staging must be quiescent. Git locks serialize each update but do not provide compare-and-update of the preceding read. Document that narrow race; do not pretend the private index locks the normal one.
- For `git version` >= 2.36 use `core.fsync=committed`; older versions proceed with `GIT_DURABILITY_LIMITED`. Fsync journal/private index files and filesystem directories as supported. Never refuse solely because this Git option is unavailable.

Ordering: durable blobs/record; all SQL intents prepared; private Git preparation and recorded OID; dependency/authority recheck; per-file stamp/publication/applied; operation applied; expected-old-OID ref publication; bounded normal-index repair; record committed even if index repair is pending; derived-index repair and cleanup. A crash after ref but before record/index is recognized by the candidate OID.

```text
notient(<operation>): <JSON source path, capture path, or "batch:<targetBatch>">

Notient-Operation: <supplied requestId or minted UUID>
Notient-Vault: <vault-id>
Notient-Batch: <batch>
Notient-Origin: <operator|clio|unattended>
Notient-Request: <one-line JSON string with exact request words>
Notient-Destination: <one-line JSON string or null>
Notient-Reverts: <JSON array of original commit OIDs; empty except undo>
```

- Bound each Git subprocess to 15 seconds and aggregate Git work to 60 seconds, additionally enforcing the normal-index contention bound above. Never blindly retry an uncertain ref update. Write/status host timeout is 300,000 ms, cooperative deadline 240,000 ms; status attempts at most 20 records and reports the rest. Blocking filesystem calls remain subject to host termination/recovery.
- Measure `scanMs`, `lockWaitMs`, `journalMs`, `applyMs`, `gitMs`, `totalMs` with `performance.now()`, plus per-recovery elapsedMs. Include index lock retries and whether commit success left index pending. Derived indexing is separate; no full vault refresh per write.

## 5. Frozen command contracts and operation algorithms

**2a:** capture, replace, frontmatter and undo by opId. **2b:** add move, destination and targetBatch. The schemas below describe the completed stage 2b contract; 2a may omit its structural fields and modes. Schemas are frozen within a session, so expansion requires operator reinstallation and session restart.

Each schema below is literal Clio input schema data. Every object is closed. Use node command entrypoints, 300,000 ms timeout and 1,048,576 maximum output bytes. Clio 0.6.2 rejects the `pattern` keyword; enforce character rules in semantic validation, including direct CLI calls. Extend validation to arrays/nested objects; no schema references, `oneOf` or executable keywords. `dryRun` defaults false; absent `planHash` binds no prior preview except where explicitly required.

### `capture`

```json
{"type":"object","additionalProperties":false,"required":["vault","batch","authorization","name","content"],"properties":{
  "vault":{"type":"string","minLength":1,"maxLength":4096},
  "requestId":{"type":"string","minLength":8,"maxLength":64},
  "batch":{"type":"string","minLength":1,"maxLength":80},
  "authorization":{"type":"object","additionalProperties":false,"required":["origin","request"],"properties":{
    "origin":{"type":"string","enum":["operator","clio","unattended"]},"request":{"type":"string","minLength":1,"maxLength":2000}}},
  "name":{"type":"string","minLength":1,"maxLength":120},
  "content":{"type":"string","minLength":1,"maxLength":48000},
  "dryRun":{"type":"boolean"},"planHash":{"type":"string","minLength":64,"maxLength":64}
}}
```

- `name` is a portable basename without `.md`, separators or leading dot; preserve valid Unicode/internal spaces. Create only `Notient/Inbox/<UTC YYYY-MM-DD>-<name>.md`, then `-2`, `-3` before `.md` on collision. Caller cannot select another directory. Freeze the date/name at intent creation.
- Parse supplied frontmatter before mutation; reject supplied reserved `created_by`, `workspace`, `captured_at` as `CAPTURE_RESERVED_FIELD`. Add `created_by: clio`, `workspace: <basename of process.cwd()>`, `captured_at: <intent UTC ISO>` and `tags: []` when absent; existing tags must be a list of strings. Command children run in the workspace on 0.6.2; never substitute the package directory or infer source session. Preserve other supplied properties, including stage 3 memory metadata. `created_by` names the capturing tool's contributor; actual authorization origin remains independently logged.
- Body dedup hash is SHA-256 of LF-normalized body bytes after frontmatter/BOM, retaining final-newline choice. Under the writer lock, inspect prior committed, non-undone captures in this vault; in 2b follow their committed moves. A live body still matching that hash returns `noop` with its path/revision/original ID, even if frontmatter differs. A deleted/changed/undone capture does not suppress new work. Dedup is scoped to journaled captures, not arbitrary authored notes.
- Config `captureLimitPerHour` is a positive integer, default 12, per vault across workspaces/origins. Dedup precedes quota. Count non-aborted capture intents created in the rolling prior 3,600,000 ms; pending intents reserve capacity and undo does not refund it. Persist reservation as the intent itself, under the writer lock. Preview checks but reserves nothing; recovery/retry consumes no new slot. Refusal is `CAPTURE_RATE_LIMIT` with the UTC retry time in its message.
- A capture preview shows the proposed generated metadata. Its plan hash replaces only generated `captured_at` with a fixed placeholder before hashing; execution freezes the actual time. Filename date, workspace, tags and user bytes remain bound, so a midnight/name collision change is `PLAN_CHANGED`. Return the actual committed revision.
- Ship `search.workspace` in 2a as an optional exact case-sensitive frontmatter-workspace filter before ranking/limit; missing metadata does not match. This is filtering, not authority. Freeze its full amended schema with the writes:

```json
{"type":"object","additionalProperties":false,"required":["query"],"properties":{
  "vault":{"type":"string","minLength":1,"maxLength":4096},
  "query":{"type":"string","minLength":1,"maxLength":4000},
  "limit":{"type":"integer","minimum":1,"maximum":20},
  "sourcePath":{"type":"string","minLength":1,"maxLength":4096},
  "workspace":{"type":"string","minLength":1,"maxLength":255}
}}
```

### `revise`

```json
{"type":"object","additionalProperties":false,"required":["vault","batch","authorization","operation","path","revision"],"properties":{
  "vault":{"type":"string","minLength":1,"maxLength":4096},
  "requestId":{"type":"string","minLength":8,"maxLength":64},
  "batch":{"type":"string","minLength":1,"maxLength":80},
  "authorization":{"type":"object","additionalProperties":false,"required":["origin","request"],"properties":{
    "origin":{"type":"string","enum":["operator","clio","unattended"]},"request":{"type":"string","minLength":1,"maxLength":2000}}},
  "operation":{"type":"string","enum":["replace","frontmatter","move"]},
  "path":{"type":"string","minLength":1,"maxLength":4096},
  "revision":{"type":"string","minLength":64,"maxLength":64},
  "oldText":{"type":"string","minLength":1,"maxLength":24000},
  "newText":{"type":"string","maxLength":24000},
  "set":{"type":"array","maxItems":32,"items":{"type":"object","additionalProperties":false,"required":["key","valueJson"],"properties":{
    "key":{"type":"string","minLength":1,"maxLength":80},"valueJson":{"type":"string","minLength":1,"maxLength":4096}}}},
  "unset":{"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":80}},
  "destination":{"type":"string","minLength":1,"maxLength":4096},
  "dryRun":{"type":"boolean"},"planHash":{"type":"string","minLength":64,"maxLength":64}
}}
```

- Semantic validation is mandatory: `replace` requires only `oldText,newText`; `frontmatter` requires at least one nonempty `set/unset` and forbids the other modes' fields; `move` requires only `destination`. Reject even empty fields belonging to another mode. Keys match `[A-Za-z_][A-Za-z0-9_-]{0,79}`; hashes are lowercase hex; request IDs and operation IDs match `[A-Za-z0-9._-]{8,64}` and need not be UUIDs; batch labels match `[A-Za-z0-9][A-Za-z0-9._-]{0,79}`. Reject all-whitespace authorization requests.
- A real move requires the preceding dry run's `planHash`. Other operations may supply one to bind a review. Hash canonical requested note changes `{path,before,after,mode}`, the sorted read set with revisions, path inventory, base Git HEAD, vault ID and operation. Include log path/before revision; exclude generated log timestamp/after bytes, candidate Git OIDs and requestId. Apply the capture timestamp placeholder rule above. Request words, batch and origin are attribution and stay out of planHash; validate current authorization independently before publication and retain attribution in the journal/log/commit. Recompute at execution; a bound-content mismatch is `PLAN_CHANGED` before intent. No persistent preview store is needed.
- Dry runs return complete deterministic unified diffs with three context lines, source byte ranges for splices and expected revisions of every changed path. Escape CR as `\r`, label missing final newlines, and state this display encoding. Preserve actual bytes in the planned hashes. If the full response exceeds 900,000 UTF-8 bytes, refuse with `PREVIEW_TOO_LARGE`; never silently truncate an approval diff.
- Generate diffs in memory; dry runs cannot use filesystem scratch files or write Git objects. The host's 64 KiB total JSON input bound still applies independently of individual string limits. An affected file's before revision returned in a move preview is the read receipt for its automatic reference edits.
- Byte-identical revise plans return `noop`; no journal, audit or commit is created. Always validate the supplied revision even for a no-op. Batch undo follows the selection rule below: eligible originals must be closed even when their aggregate content delta is zero.

### Move resolution and refusal

- Implement an offset-preserving tokenizer, not a whole-document regular-expression replacement or serializer. Retain exact spans for path, fragment, alias/label, title, enclosing YAML quoting and reference definition. Ignore fenced/indented code, inline code and comments; recognize Obsidian links in ordinary YAML string values as well as body text. Do not exclude visitor-written links from structural repair.
- Enumerate all vault Markdown and attachment paths, excluding `.git`, `.obsidian`, hidden/temp paths and symlinks. A skipped/unreadable Markdown file or unsupported link-bearing syntax prevents proving completeness and refuses a move. Cap scan at 10,000 notes/256 MiB; larger vaults return `MOVE_SCAN_LIMIT`.
- Match actual file spelling first. Treat a case-insensitive alternative, case-fold collision or normalization-dependent spelling as `AMBIGUOUS_REFERENCE` for affected links. Do not silently use filesystem-dependent casing.
- For wiki paths beginning `./` or `../`, resolve from the referring note's directory. A leading `/` means vault root. Other slash-containing wiki paths try exact vault-root path, then a unique suffix path; if a different source-relative path also exists, refuse ambiguity. Bare wiki basenames consider every matching basename in the vault, with optional `.md`; only a unique candidate is writable. Do not use stage 1's source-directory preference to guess among duplicates.
- Preserve `|display alias` verbatim; it is never part of path resolution. Frontmatter aliases assist discovery but do not establish filesystem identity. An alias-only target that could denote the moved note is unresolved/ambiguous for writes; do not inherit stage 1's alias fallback to silently turn it into a file link. An explicit filename target is resolved by its path regardless of another note's display aliases. This avoids guessing where Obsidian's completion or proximity behavior could differ.
- Empty wiki/Markdown path plus `#Heading` or `#^block` resolves to the referring note itself. Preserve headings, block IDs, embeds `!`, fragment encoding and display aliases exactly; a move changes no heading or block identifier. External URI schemes and `//` targets stay unchanged.
- Markdown inline/image links resolve from the source directory, or vault root for a leading `/`; reference uses resolve their normalized definition label. Decode the path once, resolve exact path before optional `.md`, and treat malformed escapes, duplicate definitions or an unlocatable destination span as ambiguous. Rewrite a shared definition once, preserving every use/label/title.
- Plan against both old and proposed inventories. Rewrite incoming references to the source, relative outgoing references in the moved note, and previously unique references whose binding the proposed name would make ambiguous or change. Preserve attachment and missing path-explicit outgoing destinations by rebasing their lexical absolute identity. A missing bare wiki target whose binding may change is ambiguous.
- For rewritten wiki targets choose the shortest suffix of the destination path, excluding `.md` when the original excluded it, that uniquely resolves in the proposed inventory. A unique basename wins; otherwise prepend parent components until unique. Preserve explicitly relative/root-prefixed styles when possible and verify them by resolving again. For Markdown preserve relative/root style, angle delimiters and extension presence; percent-encode changed path segments as needed without modifying fragments.
- Frontmatter links require known scalar boundaries and exact escaping spans. Refuse affected folded scalars, encoded links with no exact source mapping, YAML aliases/merges or uncertain escaped strings. Unsupported constructs never justify a best-effort rewrite.
- Managed log lines are historical data and cannot be rewritten. The log encoding in section 6 prevents request words from creating rendered links. If a legacy managed log nevertheless contains an affected live link, refuse with `AUDIT_LINK_BLOCKER` instead of altering its history or ignoring the broken reference.
- Ambiguity is global to the affected closure: any reference that might target the moved note, any relative outgoing reference that cannot be rebased, or any binding that might change under the new inventory refuses the whole move. Unrelated pre-existing ghosts remain unchanged. Report every blocker up to 100 plus a total count; write nothing.
- Reparse the proposed bytes and prove every repaired reference resolves to the intended same identity, applying the source-to-destination identity mapping. Reject overlapping splices. All affected files must pass revision, clean-target and authorization checks; a single failure refuses the plan.

### `undo`

```json
{"type":"object","additionalProperties":false,"required":["vault","batch","authorization"],"properties":{
  "vault":{"type":"string","minLength":1,"maxLength":4096},
  "requestId":{"type":"string","minLength":8,"maxLength":64},
  "batch":{"type":"string","minLength":1,"maxLength":80},
  "authorization":{"type":"object","additionalProperties":false,"required":["origin","request"],"properties":{
    "origin":{"type":"string","enum":["operator","clio","unattended"]},"request":{"type":"string","minLength":1,"maxLength":2000}}},
  "opId":{"type":"string","minLength":8,"maxLength":64},
  "targetBatch":{"type":"string","minLength":1,"maxLength":80},
  "dryRun":{"type":"boolean"},"planHash":{"type":"string","minLength":64,"maxLength":64}
}}
```

- Require exactly one of `opId,targetBatch`. `batch` labels this undo request; `targetBatch` selects original work in this vault only. In 2a allow opId only for a capture/replace/frontmatter operation; structural selectors and move targets become available in 2b. In both stages select committed, not-yet-undone, non-undo operations. Unknown targets refuse; an already wholly undone selection returns `noop` with its undo IDs. Undo-of-undo is outside stage 2 and refuses explicitly.
- A batch is all selected operations in reverse commit order, never a best-effort subset. Require their original commit OIDs to be reachable on this branch and verify their non-log Git tree deltas against journal blobs. Refuse changed Git history or a later active unselected Notient operation touching the same paths, even if its bytes happen to match. First cancel certified pairs of fully undone later operations and their inverse commits after verifying their non-log deltas cancel exactly. This permits successive single-op undos of frontmatter, replace and capture in reverse order; an inverse commit alone is not an active overlapping edit.
- Simulate the reverse deltas in memory. The current affected paths must equal the final selected after-states; then each virtual reverse step must match its original after-state. This handles capture, replace and move chains without trying to restore a now-missing intermediate path from disk. Any third-party difference yields `UNDO_CONFLICT` and no change.
- Undoing a move restores its original path/content and exact before-bytes of every rewritten reference, removes its destination, and preserves unrelated files. Rescan for new incoming references or name collisions that would become dangling/rebound under the inverse inventory; refuse those instead of expanding the undo's write set.
- A real batch undo or undo involving a move requires a dry-run `planHash` in 2b. In 2a a single capture deletion also requires its preview hash, binding the absent/restored path and live revision. Every undo uses its own supplied origin/request and revalidates the entire inverse write set. It is one new journaled operation and one Git inverse commit with all original OIDs in `Notient-Reverts`. Construct that inverse through the private Git index; do not use a working-tree `git revert` that can disturb unrelated staged work.
- Restore note content/path deltas, retain previous log lines, and append one undo line naming the original operation IDs. This is a content revert with an append-only audit history. Mark originals' `undoneBy` only after the inverse commit is published; recover those markers idempotently from the undo record.
- In 2b, a batch undo with selected eligible originals and zero aggregate content delta still creates one journaled audit-only inverse. The appended log line is the commit's content; include all selected original OIDs in `Notient-Reverts` and mark every selected original undone after publication. Keep the preview, history, revision, authorization and recovery checks even though no note bytes change. Return `noop` only when no eligible original is selected, including an already wholly undone batch; an unknown target still refuses. Reason: closing active history must not depend on whether its content changes cancel out.

### Output contract

Every result is one JSON object. Fields below are required unless shown with `?`; no undocumented success fields. Never return a successful write before the commit is published and verified.

```text
success = {
  ok:true, tool:capture|revise|undo, operation:capture|replace|frontmatter|move|undo,
  vault:string, requestId:string, operationId:string|null,
  outcome:preview|noop|committed|already_committed, batch:string,
  planHash:sha256, changes:[{path,action,before:sha256|null,after:sha256|null,
    diff:string,splices:[{startByte,endByte,replacement:string}]}],
  commit:{oid,parent:oid|null,subject:string}|null,
  log:{path,line}|null, undo:{operationIds:[string],commits:[oid]},
  capture:{path,bodyHash,workspace,capturedAt,revision,duplicateOf:string|null}|null,
  recovery:[{operationId,result,commit:oid|null,elapsedMs,conflicts:[{path,reason}]}],
  indexState:pending|updated|unchanged, derivedIndexState:pending|updated|unchanged,
  warnings:[{code,message}],
  timings:{scanMs,lockWaitMs,journalMs,applyMs,gitMs,totalMs}
}
failure = {
  ok:false, tool:string, vault:string|null, requestId:string|null,
  operationId:string|null, state:refused|intent|applied|conflicted,
  error:{code:string,message:string,retryable:boolean,paths:[string]},
  recovery:[{operationId,result,commit:oid|null,elapsedMs,conflicts:[{path,reason}]}],
  partial:boolean, commit:oid|null
}
```

- `changes` lists content files plus the managed log; creation/deletion have null missing-side revisions. Log timestamp/after bytes may differ between preview and application as specified by `planHash`. Empty `splices` is valid for creates/deletes. The final reply may omit diff content only by setting each `diff` to `""`; preview diffs are mandatory and complete.
- Preview/no-op use `operationId=null`, `commit=null`, `log=null`, both index states unchanged; always return the supplied or minted requestId. `capture` is null for other tools, describes the generated note for previews/writes, and names the live original for dedup no-ops. There is no journal reservation for a no-op. Preview shows the planned audit line in its log change diff. A committed retry uses the recorded operation and OID. Cap error paths/conflicts to 100 with total count in the message.
- Exit 0 for success/no-op/preview, including a published commit with normal-index repair pending; return its OID and warning. Exit 1 for a structured refusal or uncommitted recoverable failure. Not configured is the inherited exit-0 shape `{unavailable:"not-configured",setupHint:<exact setup command>}`; status instead returns configured:false and setupHint. `partial=true` means at least one vault path may differ from before; inspect `operationId` with status instead of issuing a new request ID.
- Command `status` keeps existing fields and adds top-level `recovered:[{vault,operationId,result,commit,elapsedMs,conflicts}]` plus per-vault `journal.operations` (last 50 IDs/requestIds, batches, states, commit, undoneBy, indexState), `journal.pendingCount`, `journal.recoveryAvailable=true` and `journal.busy`. Report `runtime.fts5` from an actual temporary FTS5 table probe and Node version each start; FTS5 absence cannot block note/write/journal tools. Runtime projections never call mutating status.

## 6. Authorization and the monthly log

**2a:** apply origin rules to capture, nonstructural revisions and single-op inverses. **2b:** additionally check every reference rewrite and batch inverse; unattended structural refusal remains in operator vaults.

- All write tools require `authorization.origin` and exact request words. Operator and Clio origins may manage any otherwise valid Markdown note in a writable registered vault. `readOnly=true` refuses all real writes and recovery regardless of origin or role.
- In an operator vault, `unattended` may capture and revise only within `Notient/`, and cannot move anything. An unattended undo is allowed only if its entire inverse affects `Notient/` and contains no move. No permissions come from a note, a plan note, a convention or a recalled memory.
- Deny direct capture/revise targeting `Notient/Log/`; the log is an internal side effect. The `Notient/` boundary is component-aware. The own role removes only unattended location/move restrictions, preserving revision checks, Git cleanliness, journaling, review hashes, logs and undo rules.
- Origin is caller-supplied attribution on 0.6.2, not authenticated proof of execution mode. `AI_AGENT` distinguishes setup from model tools, not attended from unattended. Keep Clio's execution approval policy; do not promise enforcement against a caller that lies about origin. No scheduler is introduced.
- The vault-manager skill reads before edit, previews changes the operator did not spell out, uses one batch per task, consults conventions before filing and reports the batch/operation IDs. Tool-enforced `planHash` binds expanded structural effects; it is not a fabricated operator approval token.
- Append exactly one UTF-8 line per committed operation to the UTC intent month's `Notient/Log/YYYY-MM.md`. Use a Markdown bullet followed by compact JSON, so request text cannot inject Markdown lines or forge fields:

```text
- {"time":"<UTC ISO>","id":"<operation ID>","operation":"move","note":"<source>","destination":"<destination or null>","batch":"<label>","origin":"clio","request":"<exact words>","files":[{"path":"<note path>","before":"<hash or null>","after":"<hash or null>"}],"undo":["<original ids>"]}
```

- `files` includes all changed note paths but excludes the log itself to avoid self-referential hashes. The journal includes the log's exact before/after revision. Use the existing log's line ending; add one separator newline if missing, preserving all preceding bytes. Recovery applies the frozen after blob exactly once. Historical logs are never rewritten by undo.
- Within JSON string values, additionally encode `[` and `]` as `\u005b` and `\u005d`. JSON decoding still recovers the exact request/path words, while Obsidian cannot interpret those strings as wiki or Markdown links. Do not escape the structural array brackets of the JSON object.
- Log appends preserve hand-written lines and require the same revision/Git checks as note changes. Captures remain editable by explicit revise under current B3, superseding the archive's never-rewritten Inbox rule. Exclude `Notient/Log/` and `Notient/Notient.md` from indexing; index captures normally. No dashboard generator ships in 2a/2b; any future owned-file regeneration requires live revision equal to last Notient-written revision and otherwise reports `ownedModified` without overwriting.
- Record committed own revisions and affected paths in the derived index. Refresh may update structure for them, but must not treat a Notient write as new external evidence or trigger another write. Add no automatic enrichment loop in stage 2.

## 7. Implementation and verification for Sol

**2a:** implement and ship the nonstructural path, execute R01 through R08 plus the byte/contract cases and required crash barriers, then demonstrate it in a real Clio fixture session. **2b:** only after that evidence, implement move/batch undo and execute the 14 M cases plus structural/fault integration checks. W belongs to stage 4 and V is deferred; neither table nor its internal planners is a stage 2 gate. No stage 3 implementation before both gates.

- Use one write coordinator for capture/revise/undo; split read-only journal projection from recovery. Test literal body quotation through replace. Do not implement link/relate/witness tools or their deferred planners for stage 2, and do not infer permission from a planner result.
- Ship the applicable schemas for each stage, validating nested arrays/objects, enums, character rules and bounds in direct CLI entrypoints. Use supported schema keywords only. Update command descriptions/timeouts. Reinstallation and session restart are operator acts when schemas expand. Preserve API 2 read-only runtime behavior during stage 2.
- Add registration-only setup `--access read-only|read-write --vault <registered path>`, retaining the AI_AGENT guard. This edits external registration/read roots only; no hidden vault/Git/conventions write. It enables the named B7 checks.
- G-01 supplies minimum counts and named examples. The active executable mappings below retain R01 through R08 for 2a and M01 through M14 for 2b. The archive W and V tables remain deferred reference material. Goldens compare exact Buffers or exact structured decisions, not a copy of the implementation. Use at least 12 fixture notes with frontmatter, CRLF, callouts, block IDs, wiki/embeds, aliases, references, every GFM task state, unclosed fences, BOM and code-span tags.

### G-01 reference-move.json / N-26: 14 cases, stage 2b

| ID | Input or boundary | Required result |
| --- | --- | --- |
| M01 | Unique basename wikilink | Rewrite to shortest unique new target. |
| M02 | Aliased wikilink | Preserve display alias exactly. |
| M03 | Heading fragment | Preserve fragment spelling exactly. |
| M04 | Wiki embed | Rewrite path; retain exclamation and fragment. |
| M05 | Relative Markdown link | Rebase target; preserve label/title. |
| M06 | Reference-style definition shared by uses | Rewrite definition once, preserve all uses. |
| M07 | Ambiguous basename in one of three referrers | Pure planner reports/does not alter ambiguous span; coordinator refuses entire move with every file unchanged. |
| M08 | File starts with BOM | Preserve BOM and unrelated bytes. |
| M09 | Moved note's own relative links | Rebase outgoing note/attachment and explicit missing targets. |
| M10 | Block reference and fragment-only self link | Preserve block ID and self identity. |
| M11 | Basename becomes nonunique after move | Choose unique suffix and repair changed bindings. |
| M12 | Root and explicitly relative wiki paths | Preserve style and verified identity. |
| M13 | Markdown image, encoded path, angle target/title | Change only destination spans; preserve all decorations. |
| M14 | Duplicate reference definitions or alias-only uncertain target | Report ambiguity; whole move is a no-op. |

### G-01 reconcile.json / N-23: 8 cases, stage 2a

B=before, A=after, C=current, S=writeStartedAt. Unless stated, B differs from A; absence is a valid state, not an empty Buffer.

| ID | Four inputs | Required decision |
| --- | --- | --- |
| R01 | C=B, S=null | Claim stamp, then apply. |
| R02 | C=B, S=set | Resume stamped write under writer lock. |
| R03 | C=A, S=null | Refuse UNSTAMPED_AFTER; preserve current. |
| R04 | C=A, S=set | Already applied; finish log/commit/index as needed. |
| R05 | C differs from B and A, S=null | Refuse newer edit. |
| R06 | C differs from B and A, S=set | Refuse newer edit, including partial create. |
| R07 | C=B=A, S=null | Unchanged; no new mutation or stamp. |
| R08 | C=B=A, S=set | Unchanged; no duplicate mutation. |

### Integration, fault injection and real use

- **2a byte/contract goldens:** replace LF/CRLF/mixed/EOF; frontmatter set/add/unset/comments/block scalars/invalid YAML; capture metadata/reserved keys/date collision/symlinked Inbox/LF/body dedup/rate 12 and 13/rolling expiry; search workspace filter; a committed hand-written log line survives append while an uncommitted log edit refuses DIRTY_TARGET; generated/custom 8 and 64 character request IDs, invalid/reused IDs and same-ID retry. Assert no-op/dry-run writes nothing, including Git/index/log/journal. Check one-op inverse restores full before Buffers and preserves audit history.
- **2a Git:** unrelated staged/unstaged/untracked changes, ignored Notient, tracked workspace dirt, affected dirty refusal, unborn HEAD, autocrlf true/false, Git <2.36 warning, ref CAS failure, subprocess timeout and foreign index.lock. Compare raw unrelated `git ls-files --stage -z` records and flags before/after byte-for-byte; commit tree delta must equal planned paths. Hold foreign lock after publication: observe three bounded retries, committed OID/indexState pending, then release it and recover without a second commit.
- **2a origin/degradation:** operator/clio/unattended for operator/own/read-only registrations, recovery after revocation/role downgrade, no retroactive origin upgrade, log contains original exact words, captures indexed/logs excluded. Missing FTS5 still permits writes; unavailable setup is typed exit 0; corrupt structural index is quarantined with unknown coverage and the section 7.2 literal message. Journal corruption blocks. Future owned-regeneration guard fixture proves a hand edit is preserved.
- **Harness:** inject callbacks only through the test coordinator, never manifest flags or production environment kill switches. Parent waits for child IPC at the named barrier, SIGKILLs it, then invokes actual command status in a new process twice. Assert exact bytes, stamps, one log line/commit and same-ID retry OID. No sleeps to guess a timing window.
- **2a barrier F1:** after durable intent, prepared rows and a committed stamp, before first publication. Target remains before; status resumes and commits. This is N-23's first crash point and B6's journal-to-rename check. Also exercise unstamped R03 by placing after-bytes in a prepared/no-stamp fixture.
- **2a barrier F2:** after note publication/fsync but before the row becomes applied and before ref publication. This is N-23's second crash point. Status recognizes stamped after, applies pending log, publishes the original candidate exactly once. Exercise capture and replacement. A separate two-process race on one intent proves one writer, not duplicate publication.
- **2a barrier F3:** after ref publication, before normal-index repair and committed record. Status recognizes the commit and repairs only eligible index entries; it never rewrites note/log. Repeat with a later human save and prove that save survives.
- **2b additional faults:** after each move path; after all after-bytes; after candidate creation; during normal-index repair; after committed marker before cleanup; during partial O_EXCL destination creation. Preserve any torn/third-state bytes, report conflict, then restore before/absence in the fixture and show recovery convergence. Test every move/batch inverse barrier with origin restrictions and one intent per path prepared before any stamp.
- **2b structural/undo:** three incoming referrers plus all M cases, code/comments/YAML/Unicode/case collisions/new competing names/scan limits; one ambiguity refuses all. Batch capture/replace/move chains, interleaved unrelated commits, later unselected overlapping writes, edited referrers, occupied old path, new incoming links, repeated undo and undo-of-undo refusal. Preserve previous logs; show one inverse commit naming all original OIDs.
- **Both:** fixture saves before revision check, after publication and in the check/rename gap; report the limitation honestly. Inject unsupported directory fsync and verify warnings. No hard-link capability is required. Tests never access Vaultex.
- **2a gate:** run `node --test clio/notient-extension/test`, `clio-coder extensions validate clio/notient-extension` and `clio-coder extensions test clio/notient-extension`. After operator installation/restart, real Clio fixture session captures, replaces a sentence, edits frontmatter and undoes individual operations in reverse order. Observe actual command results and Git commits/inverses. Ship/report this evidence before any 2b implementation.
- **2b gate:** rerun those commands for added behavior; real Clio fixture session captures, replaces, previews/moves a note with three incoming references, then undoes the batch. Inspect `git log`, exact restored files and retained log. Stop stage 2 after reporting actual evidence, before stage 3.
- **B7, 2a live check:** keep affected files/staging quiescent. Operator changes Vaultex registration access and names the revise target; never choose a substitute. Snapshot raw revisions/Git state, use capture only in Notient/Inbox then single-op undo; preview/perform one requested replace or frontmatter revise on the named note then single-op undo. No move demo, fault injection or automated suite on Vaultex. 2b needs no additional owner-vault mutation.
- Record commands/actual output in `clio/README.md`: stage boundary, node/Git versions, IDs/OIDs/batches, path sets and before/after/undo hashes, unrelated staged records, fsync limitations, cold/warm scan/lock/journal/apply/Git/total/recovery times on Windows drive, retry counts and pending-index recovery. Report sample counts and median/p95 only for sufficient observations; include failed checks and residual races. Designer does not claim these implementation checks have run.

## 8. Provisional product decisions and owner questions

**2a and 2b:** manager decisions P1 through P3 are effective now, pending the owner. Sol implements without waiting for further approval of these mechanics. No additional undecided product question blocks either stage.

- **P1, concurrent saves:** require quiescent affected files and staging for live writes; disclose portable Node's residual revision-check-to-rename/unlink race. Fixture stress records observable conflicts and the unpreventable window. Owner may later change the concurrency guarantee; no platform-specific CAS is introduced.
- **P2, origin:** declared origin is attribution. Implement unattended location/structural refusals in operator vaults and the own-role exception; no scheduler. Existing host approval remains. An authenticated execution-mode contract is future owner/harness work, not a new stage gate.
- **P3, retention:** retain journal blobs and Git history through MVP, with no pruning. Owner decides any later expiry/deletion policy, including the effect on undo and retained request text.
- Owner review is limited to confirming/revising these provisional product policies; do not reopen settled ownership, PARA defaults, command-tool architecture or the 2a-before-2b real-session gate.
