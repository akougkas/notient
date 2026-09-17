# Notient

**A terminal home for your notes, knowledge and ideas.**

Notient helps you find what you know, understand how it connects, and turn new
thoughts into useful notes. Your Markdown stays in your own folders. You choose
the models. Your agents can work with the same knowledge through CLI and MCP.

The terminal workspace is the main experience. Obsidian remains a companion
editor, with a native desktop sidebar for grounded answers, capture, source
navigation and reviewed changes.

**Current version: 0.1.0**, the first public release. It is early software with
honest gaps: read [what was verified and what was not](docs/release-v0.1.0.md)
before trusting it with a vault you care about. Your Markdown is never changed
without a review you approve, and every applied change has a guarded undo.

## Make yourself at home

- **Ask and explore.** Search saved notes, ask grounded questions, open exact
  source passages and return to your conversation.
- **Get your bearings.** Prepare a brief on a topic or note, compare ideas, and
  follow links, backlinks and evidence-backed relationships.
- **Write and capture.** Save a thought, keep a recoverable draft, preview Markdown,
  edit a note or save a useful answer. Review the change before it reaches disk.
- **Review and recover.** Inspect suggestions, source evidence and saved versions.
  Guarded undo refuses to overwrite newer edits.
- **Choose your automation.** Seven built-in workflows can extract, enrich, relate,
  find contradictions, synthesize, process an inbox or review for archive.
  Background AI is disabled on fresh installations. Explicit scopes, permitted
  effects and resource budgets govern enabled work.

In the TUI, **Ctrl+P** opens the menu, **Ctrl+B** captures a thought, **Ctrl+O**
switches conversations and **Ctrl+S** saves an answer. Contextual shortcuts appear
at the bottom of the workspace. **Esc** stops an active chat turn.

## Install

Requires **Bun 1.4.2 or newer** and **SurrealDB 3.0.5** on `PATH`. Notient manages
its own per-vault database process. Linux and WSL are the exercised daemon
platforms. macOS is implemented and covered by deterministic tests, and has not
been validated on a real host. A native Windows daemon is unsupported; Windows
Obsidian connects to a WSL daemon through explicitly paired localhost HTTP.

From the GitHub release:

```sh
curl -LO https://github.com/akougkas/notient/releases/download/v0.1.0/notient-0.1.0.tgz
curl -LO https://github.com/akougkas/notient/releases/download/v0.1.0/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
bun add --global ./notient-0.1.0.tgz
notient --version
```

From source:

```sh
git clone https://github.com/akougkas/notient.git && cd notient
bun install --frozen-lockfile
bun run build
bun link
```

Notient is not published to npm.

## First run

```sh
notient setup /absolute/path/to/vault
notient --vault /absolute/path/to/vault
```

`notient setup` writes default settings, records one model endpoint in the vault's
private `.notient/.env` when you give it one, and ends in the same read-only report
as `notient doctor`. It never sends a generation request and never enables
background work. A real run on a fresh two-note vault, with the home directory
shortened:

```console
$ notient --version
version version=0.1.0

$ notient setup ~/MyVault --yes
Notient setup · /home/you/MyVault

✓ Settings are in .notient/config.json. Reading and lexical search need nothing else.
✓ No model endpoint yet. Add one later by running notient setup again.

Notient · Some features need attention
/home/you/MyVault

✓ Bun — Running 1.4.2; requires 1.4.2 or newer.
✓ Platform — linux supports local daemon IPC.
✓ SurrealDB — 3.0.5 is available on PATH.
✓ Vault — Directory is accessible; no Markdown was read or changed.
✓ Configuration — Saved product configuration is valid. Vault deployment values take precedence over shell values.
· Daemon — No daemon is listening for this vault.
  Use notient daemon list to inspect ownership, or launch notient --vault <path>. Doctor does not start or stop services.
· Answers — No reasoning model configured. Reading, writing and lexical search remain available.
  Check NOTIENT_LLM_BASE_URL, NOTIENT_LLM_MODEL and context/slot settings in .notient/.env. Saved deployment changes take effect after a deliberate daemon restart.
· Semantic search — No embedding model is configured. Lexical search and grounded answers can still use the structural index.
  For semantic retrieval, configure NOTIENT_EMBED_BASE_URL and NOTIENT_EMBED_MODEL in .notient/.env.

Read-only checks. Saved model catalogs establish advertised availability, not answer quality or tool support. No generation requests, file changes, or service changes were made.

Next
  Open your workspace: notient --vault "/home/you/MyVault"
  Pair Obsidian: notient pair create --vault "/home/you/MyVault" --label "Obsidian desktop" --kind human --scopes read,write,host
  Background work is off. Enable a workflow in the workspace with Ctrl+P → Preferences.
  An endpoint credential belongs in .notient/.env as NOTIENT_LLM_API_KEY; never pass it on a command line.

$ notient search "replicas" --vault ~/MyVault | tail -1 | jq ".result.hits"
[
  {
    "notePath": "Projects/Storage.md",
    "chunkId": "chunk:8aegrfjko8yuxn20om5m",
    "snippet": "We decided to keep three replicas and acknowledge a write only after two persist it.",
    "score": 0.4774763882160187,
    "matchedText": "replicas"
  }
]
```

No model is needed to read notes, build the structural index or search lexically
(`notient search` defaults to `--mode quick`, which is lexical; `balanced` and
`deep` need an embedding model). Answers and analysis need a tool-capable
OpenAI-compatible model. [Getting started](docs/getting-started.md) covers model
setup, configuration, backups and service lifecycle.

```sh
notient doctor --vault /absolute/path/to/vault --pretty
notient ask "What did I decide about storage?" --vault /absolute/path/to/vault --format text
notient brief "storage" --vault /absolute/path/to/vault
notient brief --file "Projects/Storage.md" --vault /absolute/path/to/vault
notient history --vault /absolute/path/to/vault --pretty
```

## Bring your agents

Agents use the same daemon, note evidence and mutation authorities. A named agent
has its own attribution and cannot grant itself human approval or administration.
Ordinary agent writes ask for review by default; scoped grants or explicit operator
policies can authorize unattended effects.

```sh
notient ask "What constraints apply to this project?" \
  --vault /absolute/path/to/vault --as codex --format structured

notient mcp --vault /absolute/path/to/vault --as claude-code
```

Structured answers include exact source revisions, ranges and quotations,
retrieval coverage and inference accounting. Missing evidence causes abstention.
Reasoning tokens remain separate from answers and tool arguments; aggregate
completion usage is not labelled as visible-answer usage.

See [agent setup](docs/agents.md), [MCP tools](docs/mcp.md) and the
[note-centered HTTP API](docs/api-v1.md). The runtime-validated TypeScript client
ships as the `notient/sdk` package export.

## Use Obsidian alongside it

The desktop plugin provides a right-sidebar workspace with native Markdown
rendering, active-note context, source navigation, capture, comparison, briefs,
review, history, jobs and workflow settings. Select a passage in a saved note to
ask about it, brief from it, find its connections or propose an edit, from the
command palette or the editor menu. Attached editors veto daemon writes to dirty
buffers. Source navigation checks saved revisions.

Download `notient-obsidian-0.1.0.zip` from the
[release](https://github.com/akougkas/notient/releases/tag/v0.1.0), extract its
`notient/` folder into `.obsidian/plugins/`, enable Notient, and pair that vault
from the terminal:

```sh
notient pair create --vault /absolute/path/to/vault \
  --label "Obsidian desktop" --kind human --scopes read,write,host
```

Enter the printed endpoint, vault identity and single-use code in the plugin
settings. Configuration changes and undo require an explicitly granted `admin`
scope. Pairing the same vault again leaves the earlier pairing's editor
protection in force until you remove it with `notient pair revoke`. See
[Obsidian setup](integrations/obsidian/README.md) and
[vault compatibility](docs/obsidian.md). The plugin is not in the Obsidian
community directory.

## Where your data goes

Markdown is the source of truth. Derived data and credentials stay in private
per-vault state on your machine. Notient ships no hosted service, no telemetry and
no account. Prompts and the note excerpts they need go to the model endpoint you
configure, and nowhere else: a loopback endpoint keeps them on this machine, a LAN
endpoint keeps them on your network, and a cloud endpoint receives them. An
external MCP host also receives the content its tools request. Existing
exclusions remain authoritative.

## Status and known limits

0.1.0 was verified with the full deterministic suites, a clean install of the
release tarball, a real 27B local model, and the plugin ZIP in a real Obsidian
1.13.7 desktop host. The [release notes](docs/release-v0.1.0.md) give the numbers.
The limits that matter:

- **Latency.** With a local 27B model a grounded answer takes 15 to 30 seconds, a
  brief 30 to 70 seconds, and relationship analysis up to 3.5 minutes. Complex
  comparisons can still time out or abstain despite relevant sources.
- **Platforms.** Linux and WSL only in practice. No native Windows daemon. macOS
  is unverified on a real host.
- **Obsidian.** Installs from the release ZIP, not the community directory.
  Obsidian rewrites a note with a byte-order mark or CRLF line endings as plain LF
  when it saves; Notient then treats earlier reviews and undo for that note as
  stale instead of guessing.
- **Acceptance.** The cross-surface scenarios were exercised separately, not as
  one acceptance pass. Background throughput and resource use are unmeasured.
- A vault reached through a symlinked directory fails its configuration check;
  use the real path.

## Development

```sh
bun install --cwd integrations/obsidian --frozen-lockfile
bun run typecheck
bun run typecheck:obsidian
bun run lint
bun test testing/unit
bun run test:integration
```

After committing, `bun run release:prepare` builds the tarball, Obsidian ZIP, OpenAPI
document, installation notes, source manifest and checksums under ignored
`artifacts/` (it needs the `zip` command), and
`bun run release:check /absolute/path/to/notient-0.1.0.tgz` installs that package
into a disposable directory and exercises the daemon, CLI, SDK and MCP without a
model. See [CONTRIBUTING](CONTRIBUTING.md) and [SECURITY](SECURITY.md).

[MIT](LICENSE) · [Execution ledger](docs/sprints/v0.1.0.md)
