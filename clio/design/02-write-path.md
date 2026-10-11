# Stage 2: recoverable writes for Sentient Notes

Status: implementation contract for Sol; product questions in section 8 remain owner decisions.
Baseline: `clio-mvp` at `453af506`. Scope: NOTIENT.md B3, B6 stage 2 and B7; Clio 0.6.2 as released.
Implement only under `clio/`. Use Node standard library, `node:sqlite`, and the installed Git executable. No dependencies, daemon, runtime writes, new model route or Clio repository changes.
The extension owns all software writes; skills own judgment. A successful write means its bytes, audit line and Git commit are durable to the filesystem guarantees below.

## 1. Revision and body semantics

- `revision` is lowercase SHA-256 of the entire original file Buffer, including UTF-8 BOM, frontmatter, every CR/LF byte and final newline. It is not a Git object ID. Absence is `null`, never the hash of an empty file.
- Accept valid UTF-8 only, at most 4 MiB per note. Reject NUL and unpaired surrogates in supplied strings. Keep Buffers authoritative; maintain UTF-16-to-UTF-8 offsets only for parsing and error locations.
- Split lines into content and exact terminator (`LF`, `CRLF`, or none). Do not normalize the whole file. For generated lines choose the first existing terminator, else LF. Mixed endings elsewhere stay unchanged.
- Frontmatter exists only when the first line after an optional UTF-8 BOM is `---` plus optional horizontal whitespace. Its closing line is `---` or `...` plus optional horizontal whitespace. An opening without a close is `FRONTMATTER_INVALID`.
- The frontmatter span includes delimiters and the closing line's terminator. The body begins immediately after it. Without frontmatter, the body starts after the BOM. A later thematic break is body text.
- `replace` searches literal `oldText` only in that body span. Require exactly one occurrence, including overlapping occurrences in the uniqueness check. No match or multiple matches refuses. `oldText` cannot be empty.
- Match and replacement strings are exact, including their newlines. Do not convert caller-supplied LF to CRLF. A replacement can change the final newline only when its matched span reaches EOF and the caller's `newText` changes it. All bytes outside that span remain identical.
- `frontmatter` changes top-level keys only. Preserve the BOM, delimiter spelling, unrelated fields, comments, field order and complete body bytes. Existing field spans include their indented/block-list continuation lines; preserve independent comment/blank lines outside those spans.
- Implement a bounded span reader for ordinary top-level YAML mappings, quoted scalars, flow collections and block scalars. Reject duplicate keys, ambiguous field boundaries, complex keys, merge keys, anchors, aliases, custom tags and malformed quoting before changing anything. Do not infer meaning or repair YAML.
- `set` supplies JSON values encoded in `valueJson`. Parse and validate them, then serialize each changed value as one JSON expression, which is also YAML 1.2. Allow null, booleans, finite numbers, strings, arrays and objects; maximum decoded depth 4 and 4,096 serialized UTF-8 bytes per value. This avoids an open schema and YAML injection.
- Preserve an existing key's spelling and colon prefix, replacing only its value span; keep a same-line YAML comment where its boundary is unambiguous. Append new keys before the closing delimiter in supplied order. Reject duplicate `set` keys and overlap with `unset`; an absent `unset` key is a no-op.
- With no frontmatter, prepend a block after the BOM using the selected newline; the old body remains byte-identical. An unset-only change with no block is a no-op. Never silently add timestamps or rename properties.
- A move changes only parsed destination spans and filesystem paths. Preserve alias/display text, fragment spelling, labels, Markdown titles, delimiters and every unrelated byte. `capture.content` is a complete new Markdown document and is written exactly as supplied, including its final-newline choice.
- Reason: raw-byte revisions and local splices make review, crash recovery and exact undo independent of Markdown or YAML serialization.

## 2. Intent journal and recovery

### Layout and authority

Use the existing resolved data directory `D`, outside every vault. Directories are mode 0700; state, blobs and private indexes are mode 0600.

```text
D/journal/<vault-id>/writer.db
D/journal/<vault-id>/ops/<operation-id>/record.json
D/journal/<vault-id>/ops/<operation-id>/blobs/<sha256>
D/journal/<vault-id>/ops/<operation-id>/git-index.before
D/journal/<vault-id>/ops/<operation-id>/git-index.next
D/journal/<vault-id>/ops/<operation-id>/commit-index
```

- `operation-id` equals the caller's `requestId`, a lowercase UUID. A request retried with that ID returns/reconciles the existing operation; it never creates another capture. Reject reuse with a different canonical request digest as `REQUEST_ID_REUSED`.
- Canonical request digest: SHA-256 of recursively key-sorted JSON of the validated input with defaults applied and `dryRun` and `planHash` removed. Preserve array order and the request words. Bind it to vault ID and tool name.
- Acquire one SQLite `BEGIN IMMEDIATE` transaction in `writer.db` for the entire recovery/write call, with a 5,000 ms busy timeout. A singleton table initializes on the first real write. Roll back the lock transaction on release. SQLite OS locks release after SIGKILL; no PID lease or stale-lock deletion is needed.
- Every Notient vault mutator, including command-tool recovery, must take that lock. `refresh`, search and the runtime never acquire it to mutate a vault. A busy writer gives `WRITER_BUSY`; `status` reports busy and performs no competing recovery.
- Dry runs create no database, directory, journal, Git object, temporary file or audit line. They inspect pending records read-only and refuse with `RECOVERY_REQUIRED` if recovery is necessary. This is the explicit exception to recovery before a write-tool invocation.

### Durable record schema

All listed record fields are required; nullable values start as null, lists as empty. Unknown versions fail closed. Maximum record size 8 MiB; maximum 100 changed note paths plus one monthly log, and 64 MiB of combined before/after blobs per operation.

```text
record = {
  version: 1, id: UUID, vaultId: string, vaultPath: canonical absolute path,
  tool: capture|revise|undo, operation: capture|replace|frontmatter|move|undo,
  requestDigest: sha256, batch: string, authorization: {origin,request},
  createdAt: UTC ISO string, updatedAt: UTC ISO string,
  state: intent|applied|committed|conflicted|aborted,
  planHash: sha256, source: relative path|null, destination: relative path|null,
  reads: [{path,revision}], inventoryHash: sha256|null,
  files: [{path,role: note|log,action: create|replace|delete,
           before: sha256|null,after: sha256|null,mode: integer,
           temp: relative sibling path|null,progress: pending|applied}],
  applyOrder: [relative path], createdDirectories: [relative path],
  git: {ref:string,baseHead:oid|null,tree:oid|null,commit:oid|null,
        indexBeforeHash:sha256|null,indexAfterHash:sha256|null,
        lockSeed:relative .git path,indexInstalled:boolean},
  log: {path:relative path,line:string},
  undo: {targets:[operation-id],commits:[oid]}, undoneBy: operation-id|null,
  indexState: pending|updated, durability: full|directory-sync-unavailable,
  conflicts: [{path,expectedBefore:sha256|null,expectedAfter:sha256|null,actual:sha256|null,reason:string}],
  timings: {scanMs,lockWaitMs,journalMs,applyMs,gitMs,totalMs},
  error: {code:string,message:string}|null
}
```

- Each hash in `files.before/after` names an immutable blob with those exact bytes. A deletion has no after blob; creation has no before blob. Store the complete managed log before/after too. `reads` holds unchanged dependencies of a move/structural undo; the changed files already carry their own preconditions.
- Freeze the timestamp, selected collision name, audit line, target set, authorization and apply order in the first durable intent. Recovery never asks a model, reselects a capture name, generates a new log line, or expands authority.
- Write every blob using exclusive create, verify its hash, fsync it, and fsync the blob directory. Write `record.json.tmp`, fsync, rename to `record.json`, then fsync its directory and newly created ancestors. Only now may any vault file change.
- Update records by the same fsync/temp/rename/directory-sync protocol. Persist `applied` only after all note and log after-states have been verified and their directory updates synced. Persist `committed` only after Git publication and normal-index reconciliation.
- Fsync regular files is mandatory. On a filesystem that rejects directory fsync with a documented unsupported error, retain the record with `durability=directory-sync-unavailable` and report a warning. Other sync errors stop progress. This guarantees process-crash recovery, not stronger power-loss durability than the filesystem provides.
- Keep committed records and blobs for undo. No automatic retention/pruning in stage 2. Derived SQLite index updates happen after `committed`; failure leaves `indexState=pending`, not an uncommitted write.

### Exact recovery procedure

1. Command `status` and every real write take the writer lock, read all records, verify schemas/blob hashes and process nonterminal operations in creation order. Corrupt or missing data is `JOURNAL_CORRUPT`; block further writes to that vault and retain artifacts.
2. Recheck registration, canonical root, role and `readOnly`. Revoked write access gives `RECOVERY_BLOCKED_AUTHORIZATION`; do not complete even a previously authorized write. Runtime status only observes and displays this condition.
3. First recognize the recorded Git commit by its exact OID, operation trailer, tree and parent, and check reachability from the recorded branch. If already published, do not reapply note bytes. Reconcile only the owned normal-index update, mark committed, update undo backlinks and repair the derived index. Later human note edits are then ordinary later edits.
4. Classify every touched path by its full current-byte hash or absence before changing any further path. For creates, absence is before; for deletes, absence is after. For unchanged content moved between paths, path identity still matters. Classify while holding the writer lock even when a previous progress flag says applied.
5. Require the recorded branch and base HEAD, valid Git state, unchanged read dependencies/inventory except for this operation's own planned path transitions, and proven ownership of temporary artifacts. If a changed HEAD/dependency invalidates an entirely before-state plan with no published commit, mark `aborted` and report `aborted_unapplied`; a fresh preview/request ID is required. With any applied path, the same condition is a conflict. Never silently rebase a pending operation onto a new Git HEAD.

| Observed case | Action | Recovery result |
| --- | --- | --- |
| Every file equals before; no note changed | Resume the frozen plan, recheck each file, apply, append its one frozen log line, commit. | `resumed_from_intent` |
| Every file equals after | Reconstruct missing Git preparation from blobs if necessary; commit or recognize the existing commit. Do not append the log again. | `committed_after_apply` or `already_committed` |
| A mix of before and after, including a partial move | Complete only before-state files in the recorded order; leave after-state files untouched; then commit. | `completed_partial_apply` |
| Any file equals neither before nor after | Change no more vault files. Persist `conflicted`, expose expected/actual hashes and safe journal blob references, and block new writes. | `conflict_preserved` |

6. A conflicted operation is reclassified on the next recovery call. It resumes only when the operator has restored every conflict to a recorded before/after state and the original Git/read preconditions hold. No automatic overwrite, merge, rollback of third-party content, or permission inference from notes.
7. A pre-mutation validation failure has no intent. `aborted` requires proof of no published commit and all before-states; step 5 is its only automatic use. A retry of that request ID returns `OPERATION_ABORTED`, not a new operation. Stage 2 exposes no conflict-abandon command. Never mark a partly applied operation aborted.
8. After committed durability, remove only journal-named temporary siblings whose bytes/identity prove ownership. For `aborted_unapplied`, first persist aborted, then release only the proven owned Git lock/seed and note temps; leave the unchanged normal index alone. Empty newly created directories may remain. Return every attempted recovery result, including pending/busy/errors; never report a recovered commit without its actual OID.

Client impact: command `status` now may finish authorized pending writes, contrary to B3's old “none” column. The owner's current recovery requirement takes precedence. Keep its existing input schema; change its description and timeout. The API 2 status/log runtime stays strictly read-only and cannot run recovery.

## 3. Applying bytes atomically

- Validate all paths under the registered real root with component-by-component `lstat`/realpath checks. Refuse symlinks, nonregular files, unexpected hard links, hidden note paths, path traversal and Windows-reserved/trailing-dot/trailing-space names. Reject case-only renames and case-fold collisions on every platform so a plan is portable to Vaultex.
- Build the complete plan in memory before intent: before/after bytes, all references, Git preconditions, log and diff. For moves take a fresh vault scan, including frontmatter and attachments, rather than trusting the index. Recheck that read set before publishing the first changed file.
- After intent is durable, write each new version to a same-directory hidden sibling `.notient-<id>-<ordinal>.tmp` using `O_EXCL`, original file mode for replacements, and 0600 for captures/log creation. Fsync the sibling and its parent. Never reuse an unverified existing sibling.
- For replacement, immediately re-open the target with no-follow semantics, verify its full before revision and regular-file identity, close it, then `rename` the sibling over the target. Fsync the directory and re-read/hash the installed path. A mismatch before or after publication is a conflict, never an implicit retry with newer bytes.
- For an absent destination, use `link(temp,destination)` followed by removal of the owned temp link. This publishes complete bytes atomically and fails on `EEXIST`. Node has no portable exclusive rename; this narrow create exception is necessary to honor B3's exclusive-create promise. Unsupported same-filesystem hard links refuse before note changes.
- Capture collision allocation happens before intent; try `name.md`, `name-2.md` through `name-9999.md`, case-folded. A destination appearing after intent is a conflict. Recovery must not silently switch to the next suffix.
- Move order: publish destination, replace other referring notes in sorted path order, remove source after a final source-revision check, then replace/append the managed log. Destination content includes rebased outgoing links. A move is recoverable across several files; it is not an atomic vault-wide filesystem transaction.
- Record progress after every applied file, but recovery trusts observed hashes over progress flags. Failure after any mutation leaves the durable intent and completed bytes for recovery. Do not blindly roll back a partial operation.
- If Obsidian saves before the final recheck, return `REVISION_CONFLICT` and preserve that save. If it saves after publication, the postcheck or subsequent recovery detects a third state and preserves it. If it saves strictly between recheck and rename, portable Node cannot prevent overwriting that unobserved version. Do not claim compare-and-swap semantics; product question P1 governs concurrent-save acceptance.
- Reason: atomic complete-file publication prevents torn Markdown; the journal handles multi-file progress. Revision checks detect observed races but cannot supply a missing filesystem CAS primitive.

## 4. Git isolation, durability and latency

- Require the vault's own ordinary `.git` directory and a symbolic local branch. Refuse bare/shared worktrees, detached HEAD, merges/rebases/cherry-picks, unmerged indexes, sparse/split indexes and unsupported index extensions. A fresh unborn branch is supported with an empty base tree and no parent.
- Before intent, every existing affected note and managed log must be byte-identical to its HEAD blob and its stage-0 index blob, with matching mode. Refuse affected staged changes, untracked existing files, assume-unchanged/skip-worktree flags, filter/encoding transforms and EOL-normalized baseline mismatches. Return `DIRTY_TARGET` or `GIT_ENCODING_MISMATCH` with paths. Allow unrelated dirty, staged, ignored and untracked files without modifying their bytes or staged entries.
- This refusal is necessary: committing an already dirty target would incorporate authored changes outside Notient's request. Never create a silent baseline commit to absorb them. For an unborn vault only new Notient targets are eligible; existing conventions/untracked notes require an operator-created baseline before revision.
- Do not edit `.gitignore`, remove existing rules, or untrack existing Obsidian files. The recommended operator rule is `.obsidian/workspace*.json`; show whether it is effective using `git check-ignore --no-index`. Untracked workspace files stay outside every private commit regardless. Already tracked workspace changes remain unrelated operator dirt.
- Track the exact planned `Notient/Inbox/`, conventions changes and monthly logs even when user ignore patterns cover `Notient/`: explicit plumbing entries bypass ignore discovery. Never ignore Notient notes/logs globally and never add an entire Notient directory. Unrelated contents remain untouched.
- Use fixed argv with no shell. Clear inherited repository-selection/index/object/author Git environment variables, retain the ordinary executable environment, and set only the vault-specific overrides. Per invocation set `core.autocrlf=false`, `core.safecrlf=false`, `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `commit.gpgsign=false`, `gc.auto=0`; never change the user's Git configuration. Write blobs with `hash-object --no-filters -w --stdin`; read with `cat-file`, not checkout/filter pipelines.
- Author and committer for every Notient commit: `Notient <notient@localhost>`. Set both timestamps to the intent timestamp. `authorization.origin` records the contributor; never impersonate the operator's configured Git identity.
- Build `commit-index` outside the vault using `GIT_INDEX_FILE`: `read-tree <baseHead>` or `read-tree --empty`, then update only planned paths with explicit blob OIDs/modes or removals, then `write-tree` and `commit-tree`. Use NUL-delimited index input. The tree must differ from base only at journal-listed paths.
- Before touching note files, persist the candidate commit OID/tree and prepared normal-index hashes in the intent. Unreachable prepared objects are acceptable after a refused operation; never publish a ref early.
- Preserve the normal index by snapshotting it and building `git-index.next` as a copy with only affected entries changed. Protect this snapshot through publication with Git's ordinary `.git/index.lock` as well as the Notient writer lock.
- Acquire the Git lock without an unowned-empty-lock crash gap: write/fsync `.git/notient-<id>-index.seed` with an operation token, then `link(seed,.git/index.lock)` exclusively. The seed and lock must remain the same regular-file inode. A foreign lock gives `GIT_INDEX_BUSY`; never delete it based on age. If hard links are unavailable, refuse before note changes.
- Recovery may reclaim only a lock whose seed, operation record and inode prove ownership after the SQLite writer lock is acquired. Build private indexes using their own filenames, never asking Git to overwrite the owned real `index.lock`.
- Once all after-bytes are verified, publish the commit with `git update-ref <recorded-ref> <candidate> <baseHead>` using an expected old OID; use the repository's zero OID for an unborn ref. A moved HEAD gives `GIT_HEAD_CHANGED`, retains applied bytes, and blocks recovery until reviewed. Never force a ref.
- Then write `git-index.next` bytes through the owned seed/lock inode, fsync it, rename `.git/index.lock` to `.git/index`, and fsync `.git`. Recheck affected stage-0 entries; preserve unrelated stages, modes and flags. Persist committed, then unlink only the owned seed.
- If killed around ref/index publication: recognize the candidate commit first; install the recorded next index only if the current index equals the recorded before hash, or recognize the after hash as already installed. If an external index differs, compute a surgical update from its current entries only when affected entries still equal their recorded before/after forms. Otherwise report `COMMITTED_INDEX_CONFLICT` without discarding the external index.
- Git must finish its own object/ref durability before success. Require a Git version supporting `core.fsync=committed` and use it per write invocation; verify support in isolated fixtures. Fsync the installed index and its directory. Report filesystem durability limitations from section 2, rather than equating a zero Git exit with power-loss guarantees.

Required ordering: read-only preflight and plan; fsynced blobs plus first intent with null Git preparation fields; owned Git lock; recheck HEAD/normal index and save both private index snapshots; prepare/fsync Git objects and persist candidate OID plus index hashes; recheck read dependencies; apply files and persist applied; publish ref; install/fsync normal index; persist committed; clean up; repair derived index. Fsync private index snapshot files and their containing directory before recording their hashes. A crash before Git preparation is complete resumes from the original blobs and preconditions.

Commit message grammar; JSON-encode request/path values to preserve newlines and prevent forged trailers:

```text
notient(<operation>): <JSON source path, capture path, or "batch:<targetBatch>">

Notient-Operation: <UUID>
Notient-Vault: <vault-id>
Notient-Batch: <batch>
Notient-Origin: <operator|clio|unattended>
Notient-Request: <one-line JSON string containing the exact request words>
Notient-Destination: <one-line JSON string or null>
Notient-Reverts: <one-line JSON array of original commit OIDs, empty unless undo>
```

- Bound each Git subprocess to 15 seconds, Git-lock wait to 5 seconds, and the total Git phase to 60 seconds. Retry only lock contention before ref mutation, with 100/250/500 ms delays inside those bounds. Never replay an uncertain `update-ref` without inspecting the recorded OID and ref first.
- Give write tools and command `status` a 300,000 ms host timeout and a 240,000 ms cooperative internal deadline. Check deadlines between filesystem actions. A blocked filesystem syscall cannot be preempted portably; host termination leaves a recoverable journal. Status limits recovery to 20 records per call and reports remaining IDs.
- Return measured `scanMs`, `lockWaitMs`, `journalMs`, `applyMs`, `gitMs`, `totalMs` from `performance.now()`. Record recovery duration separately. Index refresh time is separate from commit latency; do not run a full 994-note refresh inside every write.

## 5. Frozen command contracts and operation algorithms

Each schema below is literal Clio input schema data. Every object is closed. Use node command entrypoints, 300,000 ms timeout and 1,048,576 maximum output bytes. Extend direct CLI validation to arrays/nested objects; no schema references, `oneOf` or executable keywords.

### `capture`

```json
{"type":"object","additionalProperties":false,"required":["vault","requestId","batch","authorization","name","content"],"properties":{
  "vault":{"type":"string","minLength":1,"maxLength":4096},
  "requestId":{"type":"string","minLength":36,"maxLength":36},
  "batch":{"type":"string","minLength":1,"maxLength":80},
  "authorization":{"type":"object","additionalProperties":false,"required":["origin","request"],"properties":{
    "origin":{"type":"string","enum":["operator","clio","unattended"]},"request":{"type":"string","minLength":1,"maxLength":2000}}},
  "name":{"type":"string","minLength":1,"maxLength":120},
  "content":{"type":"string","minLength":1,"maxLength":48000},
  "dryRun":{"type":"boolean"},"planHash":{"type":"string","minLength":64,"maxLength":64}
}}
```

- `name` is a basename without `.md`, separators or a leading dot; preserve valid Unicode and internal spaces. Apply the portability checks in section 3. Content may include frontmatter and must pass the read-side locator.
- Always create inside the named vault's `Notient/Inbox/`. Caller cannot select another directory. The tool chooses a collision suffix, requires absence, journals, publishes and commits. No implicit frontmatter/provenance inference.

### `revise`

```json
{"type":"object","additionalProperties":false,"required":["vault","requestId","batch","authorization","operation","path","revision"],"properties":{
  "vault":{"type":"string","minLength":1,"maxLength":4096},
  "requestId":{"type":"string","minLength":36,"maxLength":36},
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

- Semantic validation is mandatory: `replace` requires only `oldText,newText`; `frontmatter` requires at least one nonempty `set/unset` and forbids the other modes' fields; `move` requires only `destination`. Reject even empty fields belonging to another mode. Keys match `[A-Za-z_][A-Za-z0-9_-]{0,79}`; hashes are lowercase hex; UUIDs are canonical lowercase; batch labels match `[A-Za-z0-9][A-Za-z0-9._-]{0,79}`. Reject all-whitespace authorization requests.
- A real move requires the preceding dry run's `planHash`. Other operations may supply one to bind a review. Hash canonical requested note changes `{path,before,after,mode}`, sorted dependencies, path inventory and base Git HEAD. Include log path/before revision, but exclude the mechanically generated log timestamp/after bytes and Git OIDs. Recompute at execution; any mismatch is `PLAN_CHANGED` before intent. No persistent preview store is needed.
- Dry runs return complete deterministic unified diffs with three context lines, source byte ranges for splices and expected revisions of every changed path. Escape CR as `\r`, label missing final newlines, and state this display encoding. Preserve actual bytes in the planned hashes. If the full response exceeds 900,000 UTF-8 bytes, refuse with `PREVIEW_TOO_LARGE`; never silently truncate an approval diff.
- Generate diffs in memory; dry runs cannot use filesystem scratch files or write Git objects. The host's 64 KiB total JSON input bound still applies independently of individual string limits. An affected file's before revision returned in a move preview is the read receipt for its automatic reference edits.
- Byte-identical plans return `noop`; no journal, audit or commit is created. Always validate the supplied revision even for a no-op.

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
{"type":"object","additionalProperties":false,"required":["vault","requestId","batch","authorization"],"properties":{
  "vault":{"type":"string","minLength":1,"maxLength":4096},
  "requestId":{"type":"string","minLength":36,"maxLength":36},
  "batch":{"type":"string","minLength":1,"maxLength":80},
  "authorization":{"type":"object","additionalProperties":false,"required":["origin","request"],"properties":{
    "origin":{"type":"string","enum":["operator","clio","unattended"]},"request":{"type":"string","minLength":1,"maxLength":2000}}},
  "opId":{"type":"string","minLength":36,"maxLength":36},
  "targetBatch":{"type":"string","minLength":1,"maxLength":80},
  "dryRun":{"type":"boolean"},"planHash":{"type":"string","minLength":64,"maxLength":64}
}}
```

- Require exactly one of `opId,targetBatch`. `batch` labels this undo request; `targetBatch` selects original work in this vault only. Select committed, not-yet-undone, non-undo operations. Unknown targets refuse; an already wholly undone selection returns `noop` with its undo IDs. Undo-of-undo is outside stage 2 and refuses explicitly.
- A batch is all selected operations in reverse commit order, never a best-effort subset. Require their original commit OIDs to be reachable on this branch and verify their non-log Git tree deltas against journal blobs. Refuse changed Git history or a later unselected Notient operation touching the same paths, even if its bytes happen to match.
- Simulate the reverse deltas in memory. The current affected paths must equal the final selected after-states; then each virtual reverse step must match its original after-state. This handles capture, replace and move chains without trying to restore a now-missing intermediate path from disk. Any third-party difference yields `UNDO_CONFLICT` and no change.
- Undoing a move restores its original path/content and exact before-bytes of every rewritten reference, removes its destination, and preserves unrelated files. Rescan for new incoming references or name collisions that would become dangling/rebound under the inverse inventory; refuse those instead of expanding the undo's write set.
- A real batch undo, or any undo involving a move/deletion of a capture, requires a dry-run `planHash`. Every undo is one new journaled operation and one Git inverse commit with all original OIDs in `Notient-Reverts`. Construct that inverse through the private Git index; do not use a working-tree `git revert` that can disturb unrelated staged work.
- Restore note content/path deltas, retain previous log lines, and append one undo line naming the original operation IDs. This is a content revert with an append-only audit history. Mark originals' `undoneBy` only after the inverse commit is published; recover those markers idempotently from the undo record.

### Output contract

Every result is one JSON object. Fields below are required unless shown with `?`; no undocumented success fields. Never return a successful write before the commit is published and verified.

```text
success = {
  ok:true, tool:capture|revise|undo, operation:capture|replace|frontmatter|move|undo,
  vault:string, requestId:UUID, operationId:UUID|null,
  outcome:preview|noop|committed|already_committed, batch:string,
  planHash:sha256, changes:[{path,action,before:sha256|null,after:sha256|null,
    diff:string,splices:[{startByte,endByte,replacement:string}]}],
  commit:{oid,parent:oid|null,subject:string}|null,
  log:{path,line}|null, undo:{operationIds:[UUID],commits:[oid]},
  recovery:[{operationId,result,commit:oid|null,conflicts:[{path,reason}]}],
  indexState:pending|updated|unchanged, warnings:[{code,message}],
  timings:{scanMs,lockWaitMs,journalMs,applyMs,gitMs,totalMs}
}
failure = {
  ok:false, tool:string, vault:string|null, requestId:string|null,
  operationId:UUID|null, state:refused|intent|applied|conflicted,
  error:{code:string,message:string,retryable:boolean,paths:[string]},
  recovery:[{operationId,result,commit:oid|null,conflicts:[{path,reason}]}],
  partial:boolean, commit:oid|null
}
```

- `changes` lists content files plus the managed log; creation/deletion have null missing-side revisions. Log timestamp/after bytes may differ between preview and application as specified by `planHash`. Empty `splices` is valid for creates/deletes. The final reply may omit diff content only by setting each `diff` to `""`; preview diffs are mandatory and complete.
- Preview/no-op use `operationId=null`, `commit=null`, `log=null`, `indexState=unchanged`. Preview shows the planned audit line in its log change diff. A committed retry uses the recorded operation and OID. Cap error paths/conflicts to 100 with total count in the message.
- Exit 0 for success/no-op/preview; exit 1 for a structured refusal or recoverable failure. `partial=true` means at least one vault path may differ from before; inspect `operationId` with status instead of issuing a new request ID.
- Command `status` keeps its existing fields and adds per-vault `journal.operations` (last 50 IDs, batches, states, commits, undoneBy), `journal.recoveryResults`, `journal.pendingCount`, `journal.recoveryAvailable=true` and `journal.busy`. Runtime projections never call the mutating status entrypoint.

## 6. Authorization and the monthly log

- All write tools require `authorization.origin` and exact request words. Operator and Clio origins may manage any otherwise valid Markdown note in a writable registered vault. `readOnly=true` refuses all real writes and recovery regardless of origin or role.
- In an operator vault, `unattended` may capture and revise only within `Notient/`, and cannot move anything. An unattended undo is allowed only if its entire inverse affects `Notient/` and contains no move. No permissions come from a note, a plan note, a convention or a recalled memory.
- Deny direct capture/revise targeting `Notient/Log/`; the log is an internal side effect. The `Notient/` boundary is component-aware. The own role removes only unattended location/move restrictions, preserving revision checks, Git cleanliness, journaling, review hashes, logs and undo rules.
- Origin is caller-supplied attribution on 0.6.2, not authenticated proof of execution mode. `AI_AGENT` distinguishes setup from model tools, not attended from unattended. Keep Clio's execution approval policy; do not promise enforcement against a caller that lies about origin. No scheduler is introduced.
- The vault-manager skill reads before edit, previews changes the operator did not spell out, uses one batch per task, consults conventions before filing and reports the batch/operation IDs. Tool-enforced `planHash` binds expanded structural effects; it is not a fabricated operator approval token.
- Append exactly one UTF-8 line per committed operation to the UTC intent month's `Notient/Log/YYYY-MM.md`. Use a Markdown bullet followed by compact JSON, so request text cannot inject Markdown lines or forge fields:

```text
- {"time":"<UTC ISO>","id":"<UUID>","operation":"move","note":"<source>","destination":"<destination or null>","batch":"<label>","origin":"clio","request":"<exact words>","files":[{"path":"<note path>","before":"<hash or null>","after":"<hash or null>"}],"undo":["<original ids>"]}
```

- `files` includes all changed note paths but excludes the log itself to avoid self-referential hashes. The journal includes the log's exact before/after revision. Use the existing log's line ending; add one separator newline if missing, preserving all preceding bytes. Recovery applies the frozen after blob exactly once. Historical logs are never rewritten by undo.
- Within JSON string values, additionally encode `[` and `]` as `\u005b` and `\u005d`. JSON decoding still recovers the exact request/path words, while Obsidian cannot interpret those strings as wiki or Markdown links. Do not escape the structural array brackets of the JSON object.
- Record committed own revisions and affected paths in the derived index. Refresh may update structure for them, but must not treat a Notient write as new external evidence or trigger another write. Add no automatic enrichment loop in stage 2.

## 7. Implementation and verification for Sol

- Keep `paths`, `markdown`, `git`, `journal`, `index` and tool wrappers in the existing package. Add one shared write coordinator; no independent mutation logic in capture/revise/undo. Split read-only journal projection from recovery so importing the runtime cannot write.
- Update manifest command descriptions/timeouts and add the three schemas together. Installation/reinstallation is the operator's act, followed by a session restart. Add setup `--access read-only|read-write --vault <registered path>` as a registration-only mode: edit external config and source read roots, never vault files/git/conventions. Retain the AI_AGENT guard. This enables B7 without a hidden setup write to Vaultex.
- Golden fixtures compare full Buffers before/after/undo, not normalized Markdown: LF, CRLF, mixed endings, BOM, no final newline, empty body, unclosed frontmatter, identical body/frontmatter phrases, zero/multiple/overlapping replacements, multiline replacements and byte-identical no-ops.
- Frontmatter goldens cover set/add/unset, scalar/list/object `valueJson`, comments, block scalars, field order, absent block, duplicate/complex keys, anchors/merges and invalid input. Assert every body byte and every unrelated property span is unchanged.
- Move goldens include three incoming referrers; basename/suffix/relative/root paths; duplicate names/aliases; heading/block fragments; embeds; attachment and missing explicit outgoing paths; inline Markdown with balanced parentheses/angle targets/titles; full/collapsed/shortcut references and shared definitions; YAML quoting; Unicode/percent encoding; code/comments; case collisions; existing destination; new competing basename. One ambiguous reference must leave every byte, ref and index entry unchanged.
- Undo goldens cover one op, a capture/replace/move batch, multiple writes to one note, interleaved unrelated operator commits, later unselected overlapping writes, an edited referrer, an occupied original path, new inbound links, repeated undo and undo-of-undo refusal. Verify old audit lines remain and one inverse commit appears.
- Git fixtures include unrelated staged/unstaged/untracked changes, dirty target refusal, ignored `Notient/`, tracked Obsidian workspace dirt, unborn HEAD, CRLF with autocrlf true/false, nonstandard Git env, foreign index.lock, Git timeout, ref CAS failure and missing identity. Verify commit tree delta is exactly planned and unrelated staged entries are identical afterward.
- Implement deterministic fault barriers only in a test harness invoking the shared coordinator with an injected callback. Do not expose a kill/sleep/environment switch through the production manifest. Parent waits for a child IPC barrier, sends SIGKILL, and then starts the actual `tools/status.mjs` in a fresh process.
- Required barrier: after durable intent and temporary sibling fsync, before the first publication. Assert the target still has before-bytes, status reports `resumed_from_intent`, exactly one log line and commit exist, and retrying the same request ID returns that OID.
- Additional kill barriers: after first move path; after all after-bytes; after commit creation; after ref publication; during normal-index installation; after committed record before cleanup. Repeat status twice and prove no duplicate commit/log. Include one third-party modification after kill: status must report `conflict_preserved` and retain those bytes.
- Race fixture: save before the last recheck, after publication, and inside the recheck/rename gap. Prove detection for the observable cases and record the gap's limitation honestly. Do not write a test claiming portable CAS. Inject unsupported directory fsync and hard-link errors and verify explicit durability/refusal results.
- Run `node --test clio/notient-extension/test`, `clio-coder extensions validate clio/notient-extension`, and `clio-coder extensions test clio/notient-extension`. Runtime tests prove status/log observations cannot mutate notes, journals, Git or host state. Tests never access Vaultex.
- Real fixture session after operator installation: capture, replace a sentence, preview/move a note with three incoming links, inspect actual tool results, undo the batch, and inspect actual `git log` plus raw note bytes. A prose claim of a tool call is insufficient.
- Vaultex B7: obtain the operator-named note and explicit operator access change; no random substitute. Snapshot its raw revision and Git cleanliness, capture only into `Notient/Inbox/`, and undo that capture. Preview and execute one requested revise on the named note, then undo it. Never perform the move demo or fault injection on Vaultex. Follow the owner's concurrency decision before this live write check.
- Record in `clio/README.md`: commands and actual output, returned IDs/OIDs/batch, changed-path set, note hashes before/after/undo, preserved unrelated Git entries, filesystem/hard-link/fsync observations, cold and warm end-to-end/lock/Git durations, median/p95 only where sample size supports them, timeouts/retries/conflicts, and the live cited/called evidence. Report all failed checks and limitations.

## 8. Product decisions for the owner

- **P1, concurrent Obsidian saves:** portable Node cannot atomically compare a revision and replace/unlink its path. Recommendation: require quiescent affected files for stage 2 live writes, disclose the residual race, and keep concurrent-edit stress on fixtures. Alternatives are accepting that race with journaled before-bytes, or changing constraints to permit a stronger platform-specific mechanism. Sol can implement the specified observed-race behavior now; the owner decides the operational guarantee before Vaultex writes.
- **P2, unattended origin trust:** 0.6.2 carries caller-declared origin but no authenticated attended/unattended context for these command tools. Recommendation: keep unattended invocation disabled operationally until the owner accepts this attribution limit or the harness supplies trusted mode metadata. Implement the declared-origin refusals now; do not invent a security guarantee.
- **P3, retention:** journal blobs and Git history retain previous note/request contents indefinitely in stage 2. Recommendation: retain them for reliable undo through MVP review. A deletion/expiry policy changes undo and privacy behavior and needs an owner decision; do not add automatic pruning.
- These questions do not reopen settled vault ownership, PARA defaults, command-tool architecture or the three-stage scope. They gate operational policy, not unstated implementation choices.
