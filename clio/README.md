# Notient for Clio

Sentient Notes carry durable intelligence in their Markdown body, frontmatter and links. Clio visits the vault and answers from its evidence. Notes remain readable without Notient.

Stage 1 is implemented on `clio-mvp`. The extension exposes `status`, `refresh`, `search` and `note` as command tools on Clio 0.6.2. Its API 2 runtime reads state and displays a status line and panel. The paired plugin supplies the vault-manager skill. Installation and the live Clio acceptance check are still operator steps. Stages 2 and 3 have not begun.

## Requirements and storage

Use Node 22.19 or newer and Clio Coder 0.6.2 or newer. Verification used Node v24.20.0 and Clio Coder 0.6.2. Both packages use Node standard library modules and `node:sqlite`. Neither package has a dependency manifest, installed dependencies or a vendored parser.

A Node release that satisfies the engine range can still lack SQLite FTS5, including Node 23.x. Each status and search invocation probes support with `CREATE VIRTUAL TABLE temp.x USING fts5(a)` in an in-memory database. Status reports `fts5` and `nodeVersion`. When FTS5 is unavailable, status reports unavailable index counts and the runtime shows a warning. Search exits 0 with `hits: []` and `coverage: { state: "unknown", indexing: { state: "unavailable", reason: "fts5_unavailable" }, message: "Structural index coverage is unavailable; empty results do not establish that the vault has no matching notes." }`. This degraded response leaves the index untouched. Its empty hits must not be treated as evidence of absence.

Persistent state defaults to `${XDG_STATE_HOME:-~/.local/state}/notient/`. `config.json` is mode 0600 and records canonical vault paths, their IDs, roles and read-only registration. Each index lives at `vaults/<sha256(realpath)[0:16]>/index.db`, outside the vault. `journal/<vault-id>/` is reserved for stage 2. The index includes notes, blocks, chunks, FTS5, links, tags and a bounded log of the last 1,000 served passages.

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

Command tools run under Clio's execution approval policy and have no OS sandbox on 0.6.2. Their implementations enforce registered vault selection and expose no vault-write operation in stage 1. The API 2 runtime declares no filesystem writes, execution or network authority. It has state and store capability flags as specified but does not write either one. Runtime freshness is explicitly the last refresh snapshot; the `status` command tool also scans file metadata for changes.

## Use stage 1 in Clio

Ask Clio: `Use Notient to tell me what the toy-vault says about storage. Cite an exact passage with its path and line numbers.`

The required evidence is an actual gateway call to `extension_notient__search`, followed by an answer citing its returned passage. Clio should use `extension_notient__status` to select the fixture ID and `extension_notient__refresh` to build its index first. The development measurement has its own index and does not populate operator state.

The model-facing capability names are:

| Capability | Example input | Behavior |
| --- | --- | --- |
| `extension_notient__status` | `{}` | List vaults, index freshness, pending recovery, last commit and spool count. Writes nothing. |
| `extension_notient__refresh` | `{"vault":"369ffff57ba9cf77"}` | Incrementally index changed notes. `force: true` hashes every note. |
| `extension_notient__search` | `{"vault":"369ffff57ba9cf77","query":"storage","limit":5}` | Return at most 20 verified passages. `sourcePath` excludes the originating note. |
| `extension_notient__note` | `{"vault":"369ffff57ba9cf77","path":"3-resources/storage/Key-Value Store Design.md"}` | Return body, original frontmatter, revision, outline, links and tags. Optional `startLine` and `endLine` are inclusive. |

Every tool accepts a registered vault ID or exact canonical absolute path. Omitting `vault` works only with one registered vault. Every input schema is closed and direct command invocation validates the same schema. Direct scripts take one JSON argument, for example `node clio/notient-extension/tools/status.mjs '{}'`.

## Evidence and practical limits

Search tokenizes up to 32 words into an FTS5 OR query, ranks substantive chunks with BM25 and excludes standalone headings. Each passage is at most 1,200 JavaScript characters and includes the file revision, heading path and source range. Lines are one-based and inclusive. UTF-8 byte ranges are zero-based and end-exclusive. The tool re-reads each candidate file, checks its SHA-256 revision and verifies that the byte slice exactly equals the returned passage. Stale matches are withheld and request refresh. Queries examine at most 1,000 candidates and report when that bound prevents filling the result limit.

The structural reader handles YAML frontmatter as written, ATX and setext headings, fenced code, wiki links, aliases, fragments, embeds, inline Markdown links and reference links. It extracts common scalar, inline-list and block-list `tags` and `aliases` fields without reserializing YAML. It does not implement arbitrary YAML semantics or full CommonMark. Stage 2 must review link parsing against its move requirements before adding any reference rewrite.

Explicit `<!-- notient:begin -->` and `<!-- notient:end -->` regions, `Notient Intelligence` and `Visitor Intelligence` sections, Notient logs, and identifiable generated fixture summaries are excluded from search evidence. Their structural links remain visible. Markers inside code fences remain literal. `note` returns the requested original text, so the visitor markings remain visible and must be respected when citing it. Vault text is unverified evidence and never grants authority. Own-vault results are labeled unverified memory.

Indexing skips hidden paths, symbolic links and notes larger than 4 MiB, with counts and bounded diagnostics. Invalid UTF-8 and unclosed frontmatter produce explicit errors and remove stale index entries. File metadata drives unchanged refreshes; `force` can detect changes on filesystems with unreliable timestamps. Search always checks content revisions regardless of metadata. Backlinks describe the last refresh and require reading their source before citation. Note responses bound body text to 128 KiB, frontmatter to 64 KiB and metadata lists to declared limits.

Stage 1 observes pending journal records and reports recovery as unavailable. It does not pretend to recover a write. Memory spool count is observable, but memory capture and distillation belong to stage 3.

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

Stage 1 implementation and local verification do not establish the live session acceptance check. That requires operator setup and installation, a real Clio search call and a cited answer. Record that observation here before starting stage 2. The Clio Coder repository, retired standalone program, owner-vault content and Clio installation were not modified during development.

Stage 2 adds the intent journal, git commits, capture, revision-checked changes, parsed reference moves, batch undo and killed-write recovery. Its real checks require capture and undo in `Notient/Inbox/`, an operator-named note for the one owner-vault revise, and measured Windows git latency. Stage 3 adds the memory-keeper skill and verifies recall from a second repository. Stop after stage 3. Semantic search, triage and gardener work remain outside this MVP.
