# Notient for Clio

Sentient Notes carry durable intelligence in their Markdown body, frontmatter and links. Clio visits the vault and answers from its evidence. Notes remain readable without Notient.

Stage 1 is accepted and stage 2a is implemented on `clio-mvp`. The extension exposes `status`, `refresh`, `search`, `note`, `capture`, `revise` and single-operation `undo` as command tools on Clio 0.6.2. Its API 2 runtime reads state and displays a status line and panel. The paired plugin supplies the vault-manager skill. Operator installation and a real Clio fixture session remain required before stage 2b, which adds move and batch undo. Stage 3 has not begun.

## Requirements and storage

Use Node 22.19 or newer and Clio Coder 0.6.2 or newer. Verification used Node v24.20.0 and Clio Coder 0.6.2. Both packages use Node standard library modules and `node:sqlite`. Neither package has a dependency manifest, installed dependencies or a vendored parser.

A Node release that satisfies the engine range can still lack SQLite FTS5, including Node 23.x. Each status and search invocation probes support with `CREATE VIRTUAL TABLE temp.x USING fts5(a)` in an in-memory database. Status reports `fts5` and `nodeVersion`. When FTS5 is unavailable, status reports unavailable index counts and the runtime shows a warning. Search exits 0 with `hits: []` and `coverage: { state: "unknown", indexing: { state: "unavailable", reason: "fts5_unavailable" }, message: "Structural index coverage is unavailable; empty results do not establish that the vault has no matching notes." }`. This degraded response leaves the index untouched. Its empty hits must not be treated as evidence of absence.

Persistent state defaults to `${XDG_STATE_HOME:-~/.local/state}/notient/`. `config.json` is mode 0600 and records canonical vault paths, their IDs, roles and read-only registration. Each index lives at `vaults/<sha256(realpath)[0:16]>/index.db`, outside the vault. `journal/<vault-id>/writer.db` serializes writers. Each operation keeps its durable record, immutable before/after blobs and private Git index under `journal/<vault-id>/ops/<request-id>/`. Journal history and Git history are retained through the MVP. The index includes notes, blocks, chunks, FTS5, links, tags and a bounded log of the last 1,000 served passages.

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

Command tools run under Clio's execution approval policy and have no OS sandbox on 0.6.2. Their implementations enforce registered vault selection and the registered read-only flag. Stage 2a writes require an authorization origin, exact request words and one batch label. The origin field is caller-supplied attribution; execution mode is unauthenticated on 0.6.2. Unattended location refusals are enforced for that declared origin. The API 2 runtime declares no filesystem writes, execution or network authority. It has state and store capability flags as specified but does not write either one. Runtime freshness is explicitly the last refresh snapshot; the `status` command tool also scans file metadata for changes.

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

The structural reader handles YAML frontmatter as written, ATX and setext headings, fenced code, wiki links, aliases, fragments, embeds, inline Markdown links and reference links. It extracts common scalar, inline-list and block-list `tags` and `aliases` fields without reserializing YAML. It does not implement arbitrary YAML semantics or full CommonMark. Stage 2b must establish its move parser and reference completeness before adding reference rewrites.

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
| `extension_notient__capture` | `name`, complete `content` | Create exact bytes in `Notient/Inbox/`, using a collision suffix when needed. |
| `extension_notient__revise` | `operation`, `path`, read `revision` | `replace` takes literal `oldText` and `newText`. `frontmatter` takes `set: [{key, valueJson}]` and/or `unset: [key]`. |
| `extension_notient__undo` | One original `opId` | Restore that operation's note bytes through one inverse commit and append one new log line. |

`dryRun: true` creates no journal, database, Git object, temporary file or audit line. It returns complete diffs, byte splices and a `planHash`. A real deletion of a capture requires that preceding hash. Other operations may bind their preview with it. A changed note, log baseline, read dependency, inventory or Git HEAD refuses the review hash. Preview diff display encodes CR as `\r` and marks a missing final newline; the underlying hashes still cover exact original bytes.

Replacement searches only the body after the BOM and frontmatter. Zero, multiple and overlapping matches refuse. Caller-supplied line endings remain exact. Frontmatter editing preserves delimiters, key spelling, independent comments, unrelated fields and every body byte. It rejects unsupported or ambiguous YAML, duplicate keys, anchors, aliases, merge keys and custom tags. Source frontmatter is bounded to 64 KiB and 512 fields. Requested JSON values have decoded depth at most four and serialized UTF-8 size at most 4096 bytes. No timestamps or provenance are silently added.

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

Keep the affected fixture files quiescent. Run operator setup and the two installation commands above, then start a new Clio session. Ask Clio to refresh and search the fixture with a cited passage, capture a note using `extension_notient__capture`, read it with `note`, preview and apply a unique replacement, and undo that replacement by its operation ID. Exercise a frontmatter change and its single-operation undo. Use a separate fresh capture for the reviewed capture-deletion check, because later overlapping writes refuse an earlier operation's standalone undo.

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
