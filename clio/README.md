# Notient for Clio

Sentient Notes carry durable intelligence in their Markdown body, frontmatter and links. Clio visits the vault and answers from its evidence. Notes remain readable without Notient.

Stage 1 is accepted and stages 2a and 2b are implemented on `clio-mvp`. The extension exposes `status`, `refresh`, `search`, `note`, `capture`, `revise` and `undo` as command tools on Clio 0.6.2. Revise includes reviewed moves with reference repair; undo supports one operation or an entire batch. Its API 2 runtime reads state and displays a status line and panel. The paired plugin supplies the vault-manager skill. The implementation has been exercised through actual command entrypoints on isolated fixture copies. Operator installation and a live Clio fixture acceptance session remain operator acts. Stage 3 has not begun.

## Requirements and storage

Use Node 22.19 or newer and Clio Coder 0.6.2 or newer. Verification used Node v24.20.0 and Clio Coder 0.6.2. Both packages use Node standard library modules and `node:sqlite`. Neither package has a dependency manifest, installed dependencies or a vendored parser.

A Node release that satisfies the engine range can still lack SQLite FTS5, including Node 23.x. Each status and search invocation probes support with `CREATE VIRTUAL TABLE temp.x USING fts5(a)` in an in-memory database. Status reports `fts5` and `nodeVersion`. When FTS5 is unavailable, status reports unavailable index counts and the runtime shows a warning. Search exits 0 with `hits: []` and `coverage: { state: "unknown", indexing: { state: "unavailable", reason: "fts5_unavailable" }, message: "Structural index coverage is unavailable; empty results do not establish that the vault has no matching notes." }`. This degraded response leaves the index untouched. Its empty hits must not be treated as evidence of absence.

Persistent state defaults to `${XDG_STATE_HOME:-~/.local/state}/notient/`. `config.json` is mode 0600 and records canonical vault paths, their IDs, roles and read-only registration. Each index lives at `vaults/<sha256(realpath)[0:16]>/index.db`, outside the vault. `journal/<vault-id>/writer.db` serializes writers; `intents.db` stores structural publication claims separately. Each operation keeps its durable record, immutable before/after blobs and private Git index under `journal/<vault-id>/ops/<request-id>/`. Journal history and Git history are retained through the MVP. The index includes notes, blocks, chunks, FTS5, links, tags and a bounded log of the last 1,000 served passages.

Setup initializes a vault's own git repository when needed and writes the PARA default to `Notient/Conventions.md` only when absent. It creates `Notient/Inbox`, `Notient/Log` and `Notient/Plans`. Setup is an explicit bootstrap action; stage 1 does not commit these files or provide journaled content writes. Existing conventions are preserved byte for byte. `--read-only` skips every vault mutation, including git initialization and conventions creation.

Setup updates `runtime/settings.json` and the source manifest's exact read roots before installation. There may be at most 15 registered vaults plus the data directory. The manifest uses JSON syntax, which is valid YAML. Re-run setup and review a reinstall after changing registrations or the state location. Do not run setup against an installed, digested package copy.

## Operator setup and installation

Run the following in an operator terminal from this checkout. Setup exits 2 with a one-line reason whenever `AI_AGENT` is present, including an empty value. Do not bypass that refusal in a model tool call.

```sh
cd /home/akougkas/projects/notient
node clio/notient-extension/bin/setup.mjs --vault /home/akougkas/projects/notient/clio/fixtures/toy-vault
node clio/notient-extension/bin/setup.mjs --vault /mnt/c/Users/akougk/Projects/vaultex --read-only
clio-coder extensions validate clio/notient-extension
clio-coder library install /home/akougkas/projects/notient/clio/notient-plugin
clio-coder extensions install /home/akougkas/projects/notient/clio/notient-extension --user
```

Start a new Clio session after installation. The command-tool schemas are frozen for a session, and any package edit changes its integrity digest. An update therefore needs a reviewed reinstall and a fresh session. The operator can display `/ext:notient:status` or `/ext:notient:log`.

Command tools run under Clio's execution approval policy and have no OS sandbox on 0.6.2. Their implementations enforce registered vault selection and the registered read-only flag. Stage 2 writes require an authorization origin, exact request words and one batch label. The origin field is caller-supplied attribution; execution mode is unauthenticated on 0.6.2. Unattended location and structural refusals are enforced for that declared origin. The API 2 runtime declares no filesystem writes, execution or network authority. It has state and store capability flags as specified but does not write either one. Runtime freshness is explicitly the last refresh snapshot; the `status` command tool also scans file metadata for changes.

## Use stage 1 in Clio

Ask Clio: `Use Notient to tell me what the toy-vault says about storage. Cite an exact passage with its path and line numbers.`

The required evidence is an actual gateway call to `extension_notient__search`, followed by an answer citing its returned passage. Clio should use `extension_notient__status` to select the fixture ID and `extension_notient__refresh` to build its index first. The development measurement has its own index and does not populate operator state.

The model-facing capability names are:

| Capability | Example input | Behavior |
| --- | --- | --- |
| `extension_notient__status` | `{}` | List vaults, index freshness, pending recovery, last commit and spool count. Reconcile authorized pending writes. Runtime observations remain read-only. |
| `extension_notient__refresh` | `{"vault":"369ffff57ba9cf77"}` | Incrementally index changed notes. `force: true` hashes every note. |
| `extension_notient__search` | `{"vault":"369ffff57ba9cf77","query":"storage","limit":5}` | Return at most 20 verified passages. `sourcePath` excludes the originating note. |
| `extension_notient__note` | `{"vault":"369ffff57ba9cf77","path":"3-resources/storage/Key-Value Store Design.md"}` | Return body, original frontmatter, revision, outline, links and tags. Optional `startLine` and `endLine` are inclusive. |

Every tool accepts a registered vault ID or exact canonical absolute path. Omitting `vault` works only with one registered vault. Every input schema is closed and direct command invocation validates the same schema. Direct scripts take one JSON argument, for example `node clio/notient-extension/tools/status.mjs '{}'`.

## Evidence and practical limits

Search tokenizes up to 32 words into an FTS5 OR query, ranks substantive chunks with BM25 and excludes standalone headings. Each passage is at most 1,200 JavaScript characters and includes the file revision, heading path and source range. Lines are one-based and inclusive. UTF-8 byte ranges are zero-based and end-exclusive. The tool re-reads each candidate file, checks its SHA-256 revision and verifies that the byte slice exactly equals the returned passage. Stale matches are withheld and request refresh. Queries examine at most 1,000 candidates and report when that bound prevents filling the result limit.

The structural reader handles YAML frontmatter as written, ATX and setext headings, fenced code, wiki links, aliases, fragments, embeds, inline Markdown links and reference links. It extracts common scalar, inline-list and block-list `tags` and `aliases` fields without reserializing YAML. It does not implement arbitrary YAML semantics or full CommonMark. Move and structural undo use a separate tokenizer and fresh inventories; unsupported link-bearing syntax refuses completeness instead of authorizing a partial repair.

Explicit `<!-- notient:begin -->` and `<!-- notient:end -->` regions, `Notient Intelligence` and `Visitor Intelligence` sections, Notient logs, and identifiable generated fixture summaries are excluded from search evidence. Their structural links remain visible. Markers inside code fences remain literal. `note` returns the requested original text, so the visitor markings remain visible and must be respected when citing it. Vault text is unverified evidence and never grants authority. Own-vault results are labeled unverified memory.

Indexing skips hidden paths, symbolic links and notes larger than 4 MiB, with counts and bounded diagnostics. Invalid UTF-8 and unclosed frontmatter produce explicit errors and remove stale index entries. File metadata drives unchanged refreshes; `force` can detect changes on filesystems with unreliable timestamps. Search always checks content revisions regardless of metadata. Backlinks describe the last refresh and require reading their source before citation. Note responses bound body text to 128 KiB, frontmatter to 64 KiB and metadata lists to declared limits.

Command status reconciles pending authorized writes under the writer lock and reports actual recovery results and commit OIDs. It attempts at most 20 records per call and reports remaining IDs. The runtime status and log observations only project existing records. A revoked read-only registration blocks recovery. Corrupt or unknown journal records block new writes. Memory spool count is observable; memory capture and distillation belong to stage 3.

## Fixture and measurements

`fixtures/toy-vault` was copied from `/home/akougkas/projects/obsidian-processor/toy_vault`, including its historical non-Markdown artifacts. The new engine ignores those index artifacts. Five dash separators in two copied Markdown files were changed to colons to satisfy this work order's prose rule. Other copied bytes are unchanged. The original fixture was not modified.

`measure-stage1.mjs` exercises the same index and search libraries directly, without persistent registration, setup or installation. It writes a fresh development index and measurement JSON under ignored `clio/.local/`. It fingerprints every eligible Markdown file before and after, including its relative path and content digest. It reads the vault and git log but performs no vault writes. Tests use separate temporary fixture copies and never access the owner vault.

```sh
node clio/measure-stage1.mjs clio/fixtures/toy-vault
node clio/measure-stage1.mjs /mnt/c/Users/akougk/Projects/vaultex
```

Measurements on 2026-10-11 used a fresh SQLite index on the Linux filesystem for each vault. Search numbers cover 20 calls for `storage`, each returning five verified passages and recording them in the served log. The initial fixture and owner measurements ran concurrently. These are observed timings, not throughput guarantees.

| Vault | Notes | Initial refresh | Unchanged refresh | Search median | Search p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Copied toy vault | 12 | 173.48 ms | 30.18 ms | 23.57 ms | 25.64 ms |
| Owner vault on Windows drive | 994 | 43,308.75 ms | 4,417.53 ms | 198.12 ms | 203.39 ms |

Both runs reported zero skipped notes, zero indexing errors, zero stale search paths and zero pending metadata changes. Each unchanged refresh reported `changed: 0` and `hashed: 0`. The final owner index contains 65,366 blocks, 69,515 chunks, 11,992 links and 2,839 note-tag pairs.

The owner Markdown fingerprint was identical before and after:

```text
count: 994
sha256: 78179af5bf2523039f603896026dae85bfb83db3cc74602a1cd995f46b2aac65
markdownUnchanged: true
```

The fixture's first returned passage was:

```text
path: 3-resources/storage/spdk-nvme-of-quickstart.md
revision: 788232fd2eec35eadd16ed6d0bf4be0fc242c485de3b48efc4c5f3a70e0dafe4
headingPath: ["SPDK NVMe-oF Quickstart Guide"]
source: {"startLine":28,"endLine":28,"startByte":606,"endByte":744}
Storage Performance Development Kit (SPDK) provides a set of drivers and libraries for fast, user-mode, polled-mode storage applications.
```

Full measurement JSON remains in `.local/stage1-369ffff57ba9cf77-OtQxMA/measurement.json` and `.local/stage1-6753164dc88bb99b-vLLEcT/measurement.json`. Both reports say `registered: false`: direct development measurements leave persistent registration to operator setup. No live model call is claimed by these measurements.

## Verification and stage boundary

The verification commands are:

```sh
node --test clio/notient-extension/test
clio-coder extensions validate clio/notient-extension
clio-coder extensions test clio/notient-extension
clio-coder library validate clio/notient-plugin
```

All four commands exited 0 on the final package. Relevant actual output:

```text
$ node --test clio/notient-extension/test
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 631.208692

$ clio-coder extensions validate clio/notient-extension
Valid: /home/akougkas/projects/notient/clio/notient-extension
SHA-256: b00c11c9916f9dbf462c1e112bcc188106ca38aee73dbd6bba5d59cecb24b733
Registration check: passed

$ clio-coder extensions test clio/notient-extension
✔ read-only runtime registers status, log and session observations (21.327562ms)
✔ runtime shows real index, pending journal and five log lines without writing (17.570401ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 147.958687

$ clio-coder library validate clio/notient-plugin
ok: package notient is valid (1 resource checked)
```

The complete envelope output is retained locally in `.local/stage1-extension-validate.txt`. It declares `fs.write: []`, `exec: false` and `net: false`. Its empty runtime `tools` list is intentional; the four model-callable declarations are under `capabilities.tools`. Registration validation starts package code under the declared permissions but does not activate the runtime or invoke handlers. The two runtime tests invoke handlers with Clio's extension test host.

The subsequent FTS5 degradation fix was verified on Node v24.20.0 with an injected probe failure. The Node tests reported 19 passed and zero failed, the runtime tests reported three passed and zero failed, and extension validation reported Valid with Registration check passed. The added cases cover probe retries and database cleanup, unavailable status counts, the exact unknown-coverage message, successful command exits, unchanged index bytes and the runtime warning. A real Node 23 invocation was not part of this check.

The first Node invocation failed with `Cannot find module '/home/akougkas/projects/notient/clio/notient-extension/test'`. `test/index.js` now makes that exact directory command work. The next run found an incorrect test expectation: the CRLF fixture's heading was on line 5, while the test requested line 6. Correcting the requested line made the byte-range assertion pass. No product source-range change was needed for that failure.

Stage 1 was accepted by the architect at `453af506`. Local library and command checks do not establish the live Clio gateway acceptance check. Operator setup and installation, a real Clio search call and a cited answer remain the live evidence. The Clio Coder repository, retired standalone program, owner-vault content and Clio installation were not modified during development.

The current boundary is stage 2a: capture, body replacement, frontmatter changes, single-operation undo, journal, recovery and Git. Move and batch undo belong to stage 2b and require a successful real Clio fixture session first. Stage 3 and later work require their separate work orders. Vaultex remains outside the write checks for this checkout.


## Stage 2a command contracts

All three write schemas are closed. `vault`, `batch` and `authorization: {origin, request}` are required. Batch labels use letters, digits, dot, underscore and hyphen, beginning with a letter or digit. `requestId` is optional; an absent ID is minted and returned. Explicit IDs contain 8 to 64 characters from `[A-Za-z0-9._-]`. Retain that ID for an identical retry. Reusing an ID with changed input is refused.

| Tool | Required operation fields | Behavior |
| --- | --- | --- |
| `extension_notient__capture` | `name`, complete `content` | Create `Notient/Inbox/YYYY-MM-DD-name.md` with provenance and an LF-normalized body, using a collision suffix when needed. |
| `extension_notient__revise` | `operation`, `path`, read `revision` | `replace` takes literal `oldText` and `newText`. `frontmatter` takes `set: [{key, valueJson}]` and/or `unset: [key]`. |
| `extension_notient__undo` | One original `opId` | Restore that operation's note bytes through one inverse commit and append one new log line. |

`dryRun: true` creates no journal, database, Git object, temporary file or audit line. It returns complete diffs, byte splices and a `planHash`. A real deletion of a capture requires that preceding hash. Other operations may bind their preview with it. A changed note, log baseline, read dependency, inventory or Git HEAD refuses the review hash. Preview diff display encodes CR as `\r` and marks a missing final newline; the underlying hashes still cover exact original bytes.

Replacement searches only the body after the BOM and frontmatter. Zero, multiple and overlapping matches refuse. Replacement separators follow the matched span's sole convention; a span without separators uses the file's dominant convention, with its first convention breaking a tie. Bare CR in `newText` refuses. A mixed-style matched span refuses a multiline replacement; exact identity remains a no-op and single-line replacement is safe. Unrelated bytes remain exact. Frontmatter editing preserves delimiters, key spelling, independent comments, unrelated fields and every body byte. It rejects unsupported or ambiguous YAML, duplicate keys, anchors, aliases, merge keys and custom tags. Source frontmatter is bounded to 64 KiB and 512 fields. Requested JSON values have decoded depth at most four and serialized UTF-8 size at most 4096 bytes. No timestamps or provenance are silently added by revise.

A successful real write reports its request ID, operation ID, batch, exact before/after revisions and verified commit OID. A byte-identical plan returns `noop` and creates no operation. Single-operation undo refuses current third-party edits, later overlapping Notient writes, changed Git history and undo-of-undo. A capture deletion checks parsed incoming references and refuses known referrers. Complete move resolution belongs to stage 2b. Historical audit lines remain byte-identical prefixes after undo.

Affected files, including the monthly log, must be quiescent for live writes. Portable Node leaves a residual race between the final revision check and rename or unlink. The fixture race test observes that an edit in this gap can be overwritten. Caller origin is attribution on 0.6.2; declared unattended restrictions are enforced and scheduling remains future work. Journal records, blobs and Git history are retained through the MVP.

Git commits use `Notient <notient@localhost>` for author and committer with the frozen intent timestamp. A private `GIT_INDEX_FILE` builds exactly the planned tree; expected-old-OID `update-ref` publishes it. Git then updates only planned paths in the normal index using its own lock. A foreign lock is retried three times within two seconds and is retained. A published write can return `indexState: pending`; command status finishes normal-index reconciliation and subsequent structural repair. Git 2.36 or newer receives `core.fsync=committed`; an older version produces a durability warning and proceeds. Unsupported directory fsync produces a recorded warning while regular-file fsync remains mandatory. Captures publish with exclusive open, write and fsync, with no hard-link dependency. A torn new file that matches neither journal state is preserved as a conflict.

Existing affected notes and logs must match their HEAD and stage-zero blobs and Git mode. The writer refuses affected dirt, encoding transforms, special index flags, unmerged or sparse/split indexes, detached HEAD and active Git operations. Unrelated staged, unstaged, ignored and untracked work stays outside the commit delta. It does not create a baseline commit for an untracked existing note. Bootstrap conventions and existing fixture notes need an operator baseline before revising them. New captures are eligible on an unborn branch.

Registration-only access changes are an operator act:

```sh
node clio/notient-extension/bin/setup.mjs --vault /home/akougkas/projects/notient/clio/fixtures/toy-vault --access read-write
```

That mode changes only an existing registration and source read roots. It leaves vault notes, Git and conventions untouched. The `AI_AGENT` guard remains. Source package changes require reviewed reinstallation and a fresh Clio session.

## Stage 2a verification record

The six implementation steps were committed separately. The final checks used Node v24.20.0, Git 2.43.0 and Clio Coder 0.6.2. These commands exited zero:

```text
node --test clio/notient-extension/test
  tests 71, pass 71, fail 0, duration_ms 34112.106146
clio-coder extensions validate clio/notient-extension
  Valid; Registration check: passed
clio-coder extensions test clio/notient-extension
  tests 4, pass 4, fail 0
clio-coder library validate clio/notient-plugin
  ok: package notient is valid (1 resource checked)
```

The final Node run includes all 19 stage 1 and FTS5 cases. Golden checks compare complete Buffers across LF, CRLF, mixed endings, BOM, no final newline, body-only replacement and frontmatter changes. They exercise unique and overlapping witnesses, byte-identical no-ops, nested arrays and mappings, duplicate YAML keys, unsafe syntax, explicit and minted request IDs, retry reuse, revision conflicts, read-only registration and unattended boundaries. Git fixtures prove raw unrelated staged entries stay identical, explicit Notient paths bypass ignore rules, Unicode index version four works, CRLF survives both autocrlf settings, filters and split indexes refuse, ref CAS failure preserves applied bytes, and foreign locks remain untouched.

A retained child harness injects only the three stage 2a barriers through the shared coordinator. No production manifest or environment switch exposes a fault barrier. The parent waits for IPC, sends SIGKILL and starts the actual command status entrypoint in a new process. Required observations:

| Kill point | Status recovery result | Observed result |
| --- | --- | --- |
| Durable intent and sibling fsync before publication | `resumed_from_intent` | Before bytes existed at kill; one frozen log line and commit after recovery. |
| All bytes published before the ref | `committed_after_apply` | One commit, one log line and no duplicate after a second status call. |
| Ref published before normal index and committed record | `already_committed` | The exact existing OID was recognized and the index was finished. |

Additional cases recover an exclusive Unicode capture, preserve a third-party edit after kill, resume only after restoring a recorded state, release the killed SQLite writer lock, report a live writer as busy, block revoked authorization, recover undo backlinks, and abort an unapplied plan after HEAD changes. Error records are saved while the writer lock is still held. Runtime status, log and both session observations leave notes, journals, Git and state files byte-identical even with a pending intent.

Failures encountered during implementation were corrected before these passing results. An initial path fixture used a portable name while expecting refusal. A fresh-process status fixture initially selected the wrong isolated state directory. Clio 0.6.2 rejected the manifest's `pattern` keyword, so character restrictions moved into semantic validation. A multiline flow-collection golden exposed a column-zero closing bracket that the span reader then learned to handle. Independent comments between continuation lines and nested duplicate keys received additional byte-preservation cases.

A bounded development demonstration ran the actual command entrypoints on a copied toy vault with isolated configuration and index. It used batch `stage2a-demo`, eight real operations and three previews. Persistent operator registration and the original fixture were unchanged. Each commit delta contained exactly its selected note and `Notient/Log/2026-10.md`. The unrelated staged entry remained byte-identical. Final journal pending count was zero. Index metadata reported one pending external note because the demonstration deliberately edited an unrelated staged note after the initial refresh; write repair updates only its affected paths.

Full request/response JSON, complete OIDs, changed-path sets, git log and timings remain in `.local/stage2a-demo-JjLFpT/measurement.json`. The harness and all measurements stay under ignored `.local/`.

| Operation | Returned operation ID | Commit OID |
| --- | --- | --- |
| capture | `demo-capture-001` | `4bf66ce5731c12c0c50774791a1cc29a219ca591` |
| replace | `demo-replace-001` | `6f40a9f43922e30790a01f1af2d28943e632b058` |
| undo | `demo-undo-replace` | `cd616a65535b0c6b19ef362cb1f816f4a8a10866` |
| capture | `demo-fm-capture` | `84bb7f14c46340851db0c03de16d36312e716f43` |
| frontmatter | `demo-frontmatter` | `54e837db64d4508db98484b6cb7d39b73bcbbf42` |
| undo | `demo-undo-metadata` | `953de62db15e0f11b76209215ae685ba9e5c85f1` |
| capture | `demo-disposable` | `f561b289547538d1050417520f152d0f7d13d222` |
| undo | `demo-undo-disposable` | `11335685c2183a86dbb5e6d282ce849f294b526c` |

Full SHA-256 buffer observations:

| Buffer | Before | After | Undo |
| --- | --- | --- | --- |
| Body replacement | `e0106c53f995bf20854f8af1456e270d933e731eed9133b0e7131e9e0d80b000` | `f9a6be5e92f9f46d8b4a2e8c92619c204039734e5f40cdceaa7774a088f76505` | `e0106c53f995bf20854f8af1456e270d933e731eed9133b0e7131e9e0d80b000` |
| Frontmatter | `aaec3fc82f863ee2df1cf2b456be8bccf1260b559656e9066a6d385fe92a05d8` | `58a24e232c7fe4e795897ce4a6296a6303a2aeddd6e1817ce0eaab36041a8adb` | `aaec3fc82f863ee2df1cf2b456be8bccf1260b559656e9066a6d385fe92a05d8` |

The disposable capture returned revision `2bc23eaac996ebf6d2b861b69151fbb20a15f16cf1fa13745b1ea475e73dba8a` and was absent after its reviewed undo. Directory fsync succeeded on the Linux fixture filesystem. Git reported 2.43.0, so committed fsync was enabled. No Windows-drive write or live Clio model call was performed.

Timings below are individual observations, with a fresh Node command process for every call. The first capture used a fresh writer database; later calls reused that vault state. End-to-end includes process startup and serialization. Internal total includes index repair and record updates. `journalMs` measures the initial durable intent, and Git time measures preflight and the Git adapter phases. The small mixed-operation sample does not support percentile claims.

| Operation ID | End-to-end ms | Lock ms | Intent ms | Apply ms | Git ms | Internal total ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `demo-capture-001` | 627.35 | 13.84 | 38.39 | 40.24 | 345.74 | 588.11 |
| `demo-replace-001` | 679.89 | 0.27 | 39.40 | 38.33 | 395.05 | 638.11 |
| `demo-undo-replace` | 689.70 | 0.30 | 39.27 | 38.28 | 389.19 | 648.07 |
| `demo-fm-capture` | 619.84 | 0.20 | 34.37 | 39.49 | 374.38 | 577.96 |
| `demo-frontmatter` | 698.04 | 0.20 | 47.92 | 38.09 | 395.21 | 651.84 |
| `demo-undo-metadata` | 689.26 | 0.20 | 41.59 | 39.00 | 385.85 | 647.69 |
| `demo-disposable` | 628.52 | 0.21 | 35.36 | 38.92 | 373.38 | 586.46 |
| `demo-undo-disposable` | 675.50 | 0.20 | 34.31 | 38.21 | 367.43 | 633.96 |

## Operator fixture session before stage 2b

Keep the affected fixture files quiescent. Run operator setup and the two installation commands above, then start a new Clio session. Ask Clio to refresh and search the fixture with a cited passage, capture a note using `extension_notient__capture`, read it with `note`, preview and apply a unique replacement, then apply a frontmatter change. Undo frontmatter, undo replacement, and preview the original capture's deletion before undoing it with that hash. Certified operation/inverse pairs permit this reverse sequence while active overlapping changes still refuse.

Record actual gateway calls, returned request and operation IDs, Git OIDs, batch, paths and raw before/after/undo revisions here. A prose claim of a call is insufficient. The manager authorized stage 2b after verifying 2a on the clean tree and merging the designs at `77c0e90f`. Installation and live gateway evidence remain operator acts. Vaultex remains read only throughout this checkout's work.

## Stage 2b step 1: move preview

The move planner scans live Markdown and attachment paths, retains destination byte ranges, repairs against both inventories and reparses the proposed bytes. `revise` accepts `operation: "move"` with `destination` and `dryRun: true`; real publication returns `STAGE_NOT_ENABLED` at this step. Any blocker returns no file changes. The pure planner reports each reason and byte range, capped at 100 displayed blockers with the full count. Tool refusals carry the same details in the error message and name their paths.

Actual checks on 2026-10-11:

```text
node --test clio/notient-extension/test
  tests 94, pass 94, fail 0, duration_ms 35895.97558
clio-coder extensions validate clio/notient-extension
  Valid; Registration check: passed; fs.write: []
```

The added cases cover all M01 through M14, exact BOM/CRLF/Unicode splices, YAML escaping, code/comments, visitor links, attachments, explicit missing outgoing targets, new competing basenames, source-relative alternatives, normalization/case collisions and managed history. Audit regressions replay Vaultex's ambiguous `agent-memory`, alias-only `PDSW25` and malformed nested ContextOS link. One ambiguous reference in each of three referrers blocks every path; whole-workspace snapshots prove previews and refusals leave all bytes unchanged.

Read-only individual planner measurements, with reports retained in ignored `.local/`:

| Vault and proposed source | Notes | Visible file paths | Markdown bytes | Scan ms | Plan ms | Total ms | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Toy, `3-resources/storage/Key-Value Store Design.md` | 12 | 76 | 8,905 | 5.13 | 28.81 | 33.94 | 7 changed note paths, 5 destination splices, 0 blockers |
| Vaultex, `agent-memory.md` in external_sources | 994 | 2,343 | 16,738,690 | 35,970.65 | 13,185.78 | 49,156.44 | Refused, 1,000 blockers counted, 100 reported, 0 changes |

The Vaultex run refused unsupported link-bearing syntax as well as affected ambiguity. These are observations of one proposed move, not an estimate of accepted moves or a throughput percentile. No file in either vault was published or installed.

## Stage 2b step 2: move publication

Real move now requires the preview `planHash` and uses the shared coordinator. Publication order is destination creation, other referrers sorted by path, source removal after a final raw revision/identity check, then the frozen log. All structural file intents are inserted together in external `intents.db`, using WAL and `synchronous=FULL`; each publication receives a durable stamp and an applied marker. Recovery checks the complete manifest and every path before resuming. Missing or mismatching rows block with `JOURNAL_CORRUPT`; unstamped after-bytes and torn creations remain conflicts. Records from 2a remain readable while the architect reviews their separate semantics.

Actual checks:

```text
node --test clio/notient-extension/test
  tests 101, pass 101, fail 0, duration_ms 42155.35765
clio-coder extensions validate clio/notient-extension
  Valid; Registration check: passed; fs.write: []
```

A fresh command-process measurement on an isolated toy-vault copy committed `demo-move-001`, batch `stage2b-demo`, OID `5bd619dadba551b26ea734418e27879bcf3e3903`. Its delta contains 7 note paths plus one monthly log, with 5 reference splices. The unrelated staged entry stayed byte-identical. Preview took 156.72 ms; the real command took 1,679.99 ms end to end. Internal measurements: scan 22.40 ms, lock 11.66 ms, initial journal 136.06 ms, publication 440.94 ms, Git 843.53 ms, total 1,627.98 ms. The complete request/results and path set are retained in ignored `.local/stage2b-demo-ArOB9v/measurement.json`.

Fixtures cover partial destination/referrer progress, one original candidate and log after recovery, exact after-bytes supplied without a stamp, torn destinations, final-source saves, changed dependencies/attachments, origin/request hash binding, all rows prepared before the first stamp, corrupt rows and revoked authority. No Vaultex write or installation was performed.

## Stage 2b step 3: batch and move undo

`undo` now accepts exactly one of `opId` or `targetBatch`. It verifies reachable original Git deltas, certifies fully cancelled later operation/inverse pairs, and simulates selected operations in reverse commit order. The final buffer/path delta is published as one new operation and commit. Batch and move inverses require a preceding preview hash; capture deletion retains the same requirement. A fresh inverse inventory scan refuses new incoming, dangling, rebound or ambiguous references without expanding the original write set. Old log lines remain unchanged and every selected original receives the inverse backlink after publication.

Actual checks:

```text
node --test clio/notient-extension/test
  tests 110, pass 110, fail 0, duration_ms 63434.277861
clio-coder extensions validate clio/notient-extension
  Valid; Registration check: passed; fs.write: []
```

An isolated command-process demonstration performed capture, replace and move in `stage2b-demo`, then one reviewed batch undo. The original storage-note SHA-256 was restored to `ebe36cf5779d4ecdf1d657bb3835e4f5d53bf1566f3db7c8e280a0cdd7a80509`. All 8 inverse note-path states matched their returned hashes or absence; the unrelated staged entry remained byte-identical. Four historical log lines remain. Full responses, hashes and paths are in ignored `.local/stage2b-demo-1he7iH/measurement.json`.

| Operation | ID | OID | End-to-end ms | Git ms |
| --- | --- | --- | ---: | ---: |
| capture | `demo-batch-capture` | `0f538c4468a8cd75da85610e80bbe99be2e73f81` | 651.32 | 373.01 |
| replace | `demo-batch-replace` | `2c20e88bb8995968165638f8f3e91d830a2ff6ff` | 749.45 | 422.36 |
| move | `demo-move-001` | `76c23258d568515110aa08a42180a0941b3c2c60` | 1,903.63 | 921.54 |
| batch undo | `demo-batch-undo` | `d8c46e2ce3404e6e7906e0d79af8553d62d6e222` | 2,324.34 | 1,081.22 |

The inverse names all three original OIDs in `Notient-Reverts` and changes 8 note paths plus one log. Internal inverse measurements: scan 33.86 ms, lock 0.36 ms, journal 127.79 ms, publication 487.91 ms, total 2,264.28 ms. These are individual fixture observations. Tests also cover capture/replace/move chains with absent intermediate paths, single move inverse, partially undone batches, certified reverse single-op undos, edited referrers, occupied original paths, new references, later active overlaps, interleaved human commits and repeated no-op undo. No Vaultex write or installation was performed.

## Stage 2b step 4: structural fault barriers and skill

The test-only child harness now exposes candidate preparation, every structural path publication before its applied marker, all after-bytes, each normal-index update, the committed marker before cleanup, and partial exclusive creation. Existing 2a barriers remain available. There are no manifest switches or production environment triggers. Raw journal classification preserves torn buffers even when UTF-8 or NUL validation would reject them as a normal note read. Native index repair rereads each planned path before updating it and skips an already installed after-entry.

The new fault matrix executes 17 barriers for move and 17 for batch undo, plus torn creations and later human saves. Each matrix case revokes registration before recovery, confirms unchanged vault bytes, restores access, runs fresh command status twice, and checks the exact original OID, one log/commit, all stamps, cleaned owned siblings and byte-identical unrelated staging. Across the added tests, 38 children are killed at explicit IPC barriers. A separately staged third index entry remains unchanged. Case/normalization alternatives for alias-only targets and blockquoted code have additional parser goldens.

Actual final checks:

```text
node --test clio/notient-extension/test
  tests 152, pass 152, fail 0, duration_ms 143171.872029
clio-coder extensions validate clio/notient-extension
  Valid; Registration check: passed; fs.write: []
clio-coder extensions test clio/notient-extension
  tests 4, pass 4, fail 0, duration_ms 315.112721
clio-coder library validate clio/notient-plugin
  ok: package notient is valid (1 resource checked)
```

The updated vault-manager skill requires move and batch preview hashes, review of automatic reference changes, exactly one undo selector, quiescent files/staging and retained request IDs. It describes ambiguity, torn creation, revoked authority, structural origin restrictions, preserved history and pending index recovery.

A fresh status process recovered a killed partial toy-vault move in 1,104.66 ms end to end, including 1,039.01 ms for the recorded recovery. The second status took 222.46 ms. Both recognized OID `3b343bceed41761ed0e1977f869a79fda28422c1`; there was one move commit and the unrelated staged entry remained identical. The report is retained in ignored `.local/stage2b-demo-uxdtCY/measurement.json`. A final mixed-command fixture run restored the original source, retained four log lines and kept unrelated staging identical; capture, replace, move and batch undo took 817.76, 903.08, 2,231.81 and 2,761.34 ms respectively. Its report is in `.local/stage2b-demo-vtmb9y/measurement.json`.

Stage 2b implementation stops here. Live Clio fixture acceptance and installation remain operator acts. Astra's 2a review and the manager's numbered corrections take priority next. No stage 3 implementation or Vaultex write was performed.

## Manager review corrections

R1 rereads each affected normal-index entry before every attempt, including attempts following a foreign lock. An installed after-entry is skipped with its raw cache entry preserved; a newly staged third value gives `COMMITTED_INDEX_CONFLICT` without overwriting it. The manager also narrowed the review-hash rule: vault ID and operation join byte deltas, dependencies, inventory, HEAD and log baseline; request words, batch and origin remain attribution outside the hash. Existing request-ID digest checks still bind identical retries.

Actual R1 checks: `node --test clio/notient-extension/test/review-fixes.test.mjs` reported 18 passed, 0 failed, 11,533.67 ms, including the Git/publication fixtures it imports. The additional operation/no-op hash check reported 1 passed, 0 failed, 478.45 ms. Extension validation passed. These targeted checks follow the complete 152-test passing 2b run.

R2 extends the prepared SQL intent set and durable per-path publication stamps to capture, replace, frontmatter and single-operation undo. Recovery uses the four inputs: current hash, before hash, after hash and write-start stamp. Matching after-bytes without a stamp give `UNSTAMPED_AFTER`; third states give `NEWER_EDIT`; identical before/after/current is unchanged. Every fresh claim precedes publication, and an after-state is marked applied only after verification. An unpublished legacy record without authoritative stamps cannot resume; verified published legacy history remains readable. The old recovery fixture now persists before-states first and claims each simulated publication before supplying its after-bytes.

Actual R2 command: `node --test clio/notient-extension/test/journal.test.mjs clio/notient-extension/test/capture.test.mjs clio/notient-extension/test/revise.test.mjs clio/notient-extension/test/fault.test.mjs`. Output: 63 tests, 63 passed, 0 failed, 22,343.07 ms. This includes all eight reconcile vectors and an unstamped replacement fixture that preserves bytes and cannot claim them retroactively. Extension validation passed.

R3 records verified published work as `committed` before normal-index repair. `indexState` now reports the normal Git index; `derivedIndexState` reports the searchable index. Eligible derived repair can finish while a foreign normal-index lock remains held. Incomplete normal-index work remains in recovery's pending/blocking set after an attempted repair and prevents new writes. Derived-only work remains observable without blocking vault mutation or requiring FTS5. Success and preview replies include both states and the capture field; capture receipts are completed by R6. Recovery results include elapsed time and vault ID, and journal projections expose the request ID. A published index conflict is reported with the actual commit and a `COMMITTED_INDEX_CONFLICT` warning while preserving the staged entry.

Actual R3 checks: the focused journal, undo and review run passed 52 tests, 0 failed, 17,608.07 ms. The complete `node --test clio/notient-extension/test` run passed 164 tests, 0 failed, 147,358.90 ms. Extension validation passed; the runtime passed 4 tests, 0 failed, 275.44 ms. The pending-lock fixture proves committed state, separate repair states, blocked new capture, retained pending IDs and successful undo after normal-index completion.

R4's certified cancellation mechanism was implemented with batch undo. A dedicated single-operation sequence now compares the complete captured and replaced buffers after reversing frontmatter and replacement. Backlinks must identify an inverse that actually selects that original; pointing to a different valid inverse refuses as `UNDO_HISTORY_CHANGED` and preserves every vault byte. The operator-session instructions now use the required reverse sequence instead of substituting a separate capture.

Actual R4 command: `node --test clio/notient-extension/test/cancelled-undo.test.mjs clio/notient-extension/test/batch-undo.test.mjs clio/notient-extension/test/undo.test.mjs`. Output: 59 tests, 59 passed, 0 failed, 30,752.98 ms. Extension validation passed.

R5 normalizes replacement separators to the matched span's sole convention, falling back to the file's dominant convention when the span contains none. The first file convention breaks a tie. Bare CR refuses; mixed-style spans refuse multiline changes while exact identity remains a no-op and a single-line replacement is permitted. The revised CRLF golden now expects CRLF inside the changed span and preserves the neighboring LF byte sequence.

Actual R5 command: `node --test clio/notient-extension/test/revise.test.mjs clio/notient-extension/test/undo.test.mjs`. Output: 37 tests, 37 passed, 0 failed, 11,401.38 ms. Cases include dominant-style fallback in both directions, mixed-span refusal, safe single-line removal, exact identity and bare-CR rejection. Extension validation passed.

R6 creates `Notient/Inbox/YYYY-MM-DD-<name>.md` from the UTC intent date, preserves portable Unicode names and allocates case-folded suffixes before intent. Capture adds `created_by: clio` (T6 corrects the earlier R6 origin wording), `captured_at` in UTC, `workspace` from the current workspace basename, and `tags: []` when absent. Caller frontmatter fields remain, with reserved provenance keys refused and existing tags required to be strings in a list. New document separators become LF; optional BOM and body EOF choice remain. The capture receipt returns the path, body hash, workspace, captured time, live revision and duplicate ID.

Admission checks committed, non-undone journal captures for a matching LF-normalized body before checking quota, following active committed moves. A match returns a zero-write no-op with the live path/revision and original ID even when supplied metadata differs. Deleted, changed or undone captures do not suppress new work. The rolling quota defaults to 12 captures per hour across origins and workspaces, counts pending reservations, excludes aborted intents and does not refund undo. Configure a positive integer `captureLimitPerHour` in external `config.json`, either as a default or on an individual vault registration. Access-only setup changes preserve that setting. Refusals report the UTC retry time. Preview hashes replace only generated capture time with a placeholder; date, workspace and user bytes remain bound.

Actual R6 checks: the capture, undo and existing crash tests passed 42 tests, 0 failed, 22,414.17 ms. Admission/construction checks passed 21 tests, 0 failed, 17,147.66 ms, including 12 admitted captures, the 13th refusal, rolling expiry, custom quota, metadata-only dedup, moved captures, tags and reserved fields. The complete Node suite passed 172 tests, 0 failed, 156,536.45 ms. The access-setting preservation check passed 1 test, 0 failed, 128.80 ms. Extension validation passed and runtime tests passed 4, 0 failed. Capture crash assertions now read the frozen dated path and generated after-buffer from the journal. The plugin skill files remain owned by Astra and were not edited for this correction.

R7 rechecks registration, the current role, the role frozen at intent and read-only access after the writer lock and immediately before publication. An untouched intent invalidated by a changed branch or base HEAD becomes `aborted_unapplied`. The targeted run passed 38 tests in 22,334.531 ms.

R8 places F2 after durable note publication and verification, before its applied marker and audit log. Capture recovery completes the stamped partial apply. Published commit recognition preserves later human saves. The targeted fault run passed 21 tests in 23,247.027 ms.

Search accepts an optional exact, case-sensitive `workspace` filter over that frontmatter property alone. SQL applies it before ranking and the 1000-candidate bound. Refresh and committed-write repair cache workspace values outside the vault; an older index missing that cache is backfilled on its first filtered search. Missing workspace does not match a supplied filter. T8 removes the earlier dependency on capture provenance. R9 exercised 1001 higher-ranking foreign-workspace notes, exact case and prefix exclusions, capture repair, schema acceptance and old-index backfill. The targeted run passed 30 tests in 3,987.238 ms.

R10 returns `configured: false`, `unavailable: "not-configured"` and the operator setup command with exit 0 when no vault is registered. Valid status and write calls do not create state. Its targeted run passed 20 tests in 768.475 ms. R11 uses the inherited missing and duplicate quotation messages verbatim; its targeted run passed 22 tests in 5,120.265 ms. The complete R1 through R11 run passed 181 tests in 169,053.452 ms.

S6 confirms the structural hash correction already shipped in R1. Move and batch-undo previews bind bytes, read revisions, inventory, HEAD, vault identity and operation. Batch and authorization attribution can change before execution when authorization remains valid. Both regressions fail against an isolated copy of pre-R1 commit `4981cb49`, then pass against the current checkout; the combined current-tree run passed 30 tests in 17,011.666 ms. The old contradictory attribution expectation in move publication tests was removed by R1.

S1 makes move and inverse tokenization honor blockquote and list containers, fenced code, HTML comments and Obsidian comments. Nested-list references and supported multiline definitions remain live. Tab-indented containers that cannot be classified safely refuse with `AMBIGUOUS_REFERENCE` and the source line. The first twelve regression cases had eight failures; the combined passing run had 46 tests in 3,776.566 ms.

S2 includes every scanned Markdown log in structural read sets. Historical live references return `AUDIT_LINK_BLOCKER`; edits after intent stop publication through revision checks. The current audit log may transition to its frozen after revision only with its durable write stamp. Three regressions failed before the fix; the combined run passed 53 tests in 30,525.794 ms.

S3 recognizes a verified published candidate before reading current note bytes. A later destination save larger than 4 MiB or containing invalid text does not prevent committed-state recognition and normal-index repair. Later bytes remain untouched. Its regression failed before the fix, and the combined run passed 27 tests in 4,792.476 ms.

S4 gives an exact vault-root wiki path precedence over suffix matches elsewhere. Distinct source-relative paths, multiple suffixes and folded case collisions still refuse. Its regression failed before the fix; the combined run passed 47 tests in 3,615.302 ms.

S5 authorizes batch undo over the active originals only. A cancelled outside move no longer prevents unattended undo of a remaining managed capture. Its regression first returned `UNATTENDED_REFUSED`; the combined run passed 44 tests in 32,900.622 ms.

S7 closes an active zero-delta batch with an audit-only inverse commit. The originals receive `undoneBy`, repeated execution returns the recorded commit, and a fully closed selection returns `noop`. Cancelled zero-delta history permits an earlier overlapping undo. The first regression returned `noop` incorrectly. The combined passing run had 45 tests in 36,643.783 ms; the two focused cases, including interrupted audit-only inverse recovery, passed in 6,095.930 ms.

S8 writes the move destination as a one-line JSON string in the `Notient-Destination` Git trailer. Other operations retain `null`. The regression first found the incorrect null trailer; the publication run passed 17 tests in 12,042.821 ms.

Final review verification after R1 through R11 and S1 through S8: `node --test clio/notient-extension/test` passed 204 tests, zero failures, in 186,626.654 ms. `clio-coder extensions validate clio/notient-extension` passed the registration check. `clio-coder extensions test clio/notient-extension` passed four runtime tests in 276.160 ms. `clio-coder library validate clio/notient-plugin` reported `ok: package notient is valid (1 resource checked)`. Measurements use Node v24.20.0 and Git 2.43.0. The two plugin skill files were left to Astra throughout the second fix list. No owner-vault writes or Clio installation occurred. Stage 2 review fixes are complete; subsequent stage work awaits the manager.

Stage 3 piece 1 reuses operator-only `setup.mjs --create-own` and the shared own-role writer. The own root uses `XDG_DATA_HOME` or the home data default, independently of the workspace. Bootstrap conventions now describe canonical dated memory bodies and one Source line; existing operator conventions remain untouched. Fixture setup preserves exact runtime read roots, creates Git and managed folders, and leaves conventions untracked when the first capture commits only its note and audit log. The own role relaxes only unattended location and move; read-only and coordinator requirements remain enforced. The combined setup/authority run passed 31 tests in 4,315.248 ms; extension validation and four existing runtime tests passed.

Stage 3 piece 2 adds two read-only API 2 hooks with 250 ms timeouts and pass on timeout/error. Orientation checks at most 64 KiB of registration metadata and emits the exact 475-character model reminder at turn start. Grounding filters the full search/note names and emits the exact 397-character annotation after the first qualifying call, including a failed call. Independent `ctx.state` flags use conditional versions with at most two attempts, survive resumed state, and defer without a session. Cancellation and state errors pass; a successful stamp followed by a crash can omit the advisory as specified in 03. The Clio test host admits both effect kinds and tests eight competing callbacks per hook. Runtime tests changed from four passing and five failing to nine passing in 285.568 ms. The combined state/abort and stage 1 run passed 22 tests in 795.919 ms; validation passed. Live effect delivery and fresh cross-repository sessions still require reviewed operator reinstallation.

Stage 3 piece 3 adds readable memory fixtures and protocol goldens over the existing tools. The fixture protocol uses canonical body Source tuples, checks a unique final append marker and the 16,000-character body bound, and prepares exact replace quotations. It adds no command schema or second writer. Independent LF/CRLF append and correction files verify earlier byte preservation. Cases cover known/unknown sessions, multiple observed fixture IDs, same-day headings, session-independent dedup, changed-content collisions, duplicate markers/tuples, skipped and interrupted summary refresh, body acceptance with pending normal/search indexes, batch undo, Markdown index rebuild from another fixture workspace, and malicious prose returned as unverified inert evidence. The targeted run passed 18 tests in 12,098.618 ms; five strengthened document goldens passed in 2,075.035 ms. Validation and nine runtime tests passed; the merged plugin validates with two resources. These are fixture observations; live task-bank recall, installed hook delivery and the actual A/B session check remain operator acceptance work.

The third manager review fixes T1 through T9 follow the stage 3 fixture commit. Replacement fallback retains the dominant file convention by manager decision.

| Group | Commit | Targeted passing tests | Duration ms |
| --- | --- | ---: | ---: |
| T1 | 21c0f491 | 49 | 3,662.130 |
| T2 | c620c0be | 50 | 3,581.138 |
| T3 | 222d97de | 46 | 40,811.452 |
| T4 | dcd9bbbc | 23 | 21,348.593 |
| T5 | ec8ecb40 | 68 | 40,411.231 |
| T6 | 6ecda5ae | 52 | 23,380.832 |
| T7 | 32474a0b | 25 | 24,272.844 |
| T8 | 1fe34ee8 | 31 | 4,323.300 |
| T9 | 134f378d | 32 | 4,405.475 |

Every group has a regression that failed before its fix. T1 counts tab columns, honors backslash parity and ends inline spans at blank paragraphs; uncertain container/block boundaries refuse. T2 refuses unsupported escaped labels and internal character-reference/backslash destinations with source lines in both move directions. T3 checks the live executable mode against the Git baseline before undo intent. T4 follows a capture's subsequent active moves through first-parent commit order and stops at path ownership replacement, rather than trusting timestamps or matching an earlier source path. T5 shares one 60-second Git allowance across preflight, capture lineage and all original/inverse verification; it carries preliminary preflight cost into locked planning and checks the remaining allowance before durable intent. The deadline tests advance an injected clock while running actual Git calls, so their simulated 60-second totals are enforcement evidence, not latency measurements.

T6 always writes `created_by: clio` and keeps authorization origin in journal/audit/Git attribution. T7 refuses non-string tag items while preserving quoted strings. T8 filters on the workspace frontmatter property alone, exactly and case-sensitively, with old workspace-cache values invalidated for backfill. T9 matches the frozen schema and semantic validator at 255 characters. Extension validation passed after every group. The latest runtime check passed nine tests in 323.104 ms, and plugin validation reported two resources.

After T1 through T9, the complete Node run passed 232 tests, zero failures, in 216,687.468 ms. The stage 3 setup, state and memory cases are included. The earlier stage 3 run, before this review, passed 219 tests in 193,062.749 ms. All source changes are committed separately by piece/group; stage 3 implementation is ready for operator acceptance.

Operator setup and installation from this checkout remain explicit operator acts. Setup creates/registers the shared own vault, bootstraps conventions, and updates the exact runtime read roots; run it outside an AI_AGENT environment. Review the source envelope after setup, then install the plugin and replace the extension to admit both hooks and the corrected search bound:

```sh
node /home/akougkas/projects/notient/clio/notient-extension/bin/setup.mjs --create-own
clio-coder library install /home/akougkas/projects/notient/clio/notient-plugin
clio-coder extensions install /home/akougkas/projects/notient/clio/notient-extension --user --force
```

These commands have not been executed against the operator's installation or real own vault. Astra's skill changes were merged verbatim. The live check in design 03 section 7 remains pending: authorized real repositories A and B, fresh Clio sessions, actual nonsecret task-bank entry IDs, a confirmed own-vault body commit, hook delivery receipts, a later current search/note citation, tuple retry and an observed correction. The command fixture using a different workspace proves library/command behavior, not actual task-bank recall or model grounding. No Vaultex writes, installation, private-memory-file reads, embeddings or stage 4 implementation occurred.
