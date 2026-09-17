# Getting Started

This is the first-run path from dormant Markdown or Obsidian files to an awakened vault whose notes can answer together with citations. Notient is the per-vault substrate, not another agent: models and client agents visit, while the user's Markdown remains the durable memory.

## What must be installed

- Bun 1.4.2 or newer.
- SurrealDB 3.0.5, with `surreal` on `PATH`. Notient starts SurrealDB itself as a per-vault child process. Do not launch a SurrealDB server by hand.
- An OpenAI-compatible model endpoint. Local inference is the reference setup: llama.cpp `llama-server`, Ollama, LM Studio, vLLM, SGLang, and other runtimes work when they expose the compatible routes Notient uses. A deliberately configured compatible cloud endpoint with an optional bearer credential is also supported. Native Triton and other engine-specific protocols require an OpenAI-compatible front end.

## Inspect and undo a change

To compare ideas, press **Ctrl+P → Compare notes**. Choose the saved notes, optionally enter a question, then press **Ctrl+R**. **Esc** stops an active request; results include rendered explanations and numbered quotations that open the exact source. **Explore connections** finds a bounded set of related notes. The same operations are available as `notient compare "First.md" "Second.md" --question "What differs?" --vault "$VAULT"` and `notient correlate "First.md" --folder Research --vault "$VAULT"`.

In the TUI, press **Ctrl+P**, choose **Change history**, and select a change. **Tab** compares versions; **r** switches between rendered Markdown and exact source. Press **u** to review undo, then **Enter** to confirm or **Esc** to keep the note. Newer edits are protected. Completed undo receipts remain visible, so a lost response can be retried safely.

The same journal is available with `notient history --vault /path/to/vault --pretty` and `notient undo '<history-id>' --vault /path/to/vault --pretty`. Undo requires the human operator. In Obsidian, use **Review → Change history**.

## Install the release, or build and put `notient` on PATH

The release package installs without a checkout:

```bash
curl -LO https://github.com/akougkas/notient/releases/download/v0.1.0/notient-0.1.0.tgz
curl -LO https://github.com/akougkas/notient/releases/download/v0.1.0/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
bun add --global "$PWD/notient-0.1.0.tgz"
```

From source:

```bash
git clone https://github.com/akougkas/notient.git
cd notient
bun install
bun run build     # → dist/notient.js, dist/daemon.js, dist/schema.surql
bun link          # registers this checkout, so `notient` resolves on PATH
notient --help
```

`bun link` symlinks the `bin.notient` entry at `dist/notient.js`, so after a `git pull` you rebuild with `bun run build` and the linked command picks up the new bundle without re-linking. `bun unlink` from the repo root removes it again.

If you would rather not link, every command below works with `bun dist/notient.js …` substituted for `notient`. Do not run the bundle under `node`; it is Bun-native.

## Choose a model endpoint

Current files, lexical search, job inspection and pipeline-policy inspection work
without inference. After building, `notient pipelines list --vault /path/to/vault`
shows the seven available pipeline families and their current policies. Fresh
configuration keeps all AI background pipelines disabled. See
[explicit pipeline invocation](api-v1.md#explicit-live-pipelines) for bounded live
runs, and use `notient jobs list|get` or TUI `/jobs`/`/job` to inspect their outcomes.
An explicit run returns a durable job; admission does not mean inference completed.

Grounded answers need a tool-capable chat model. Semantic retrieval additionally needs an embedding model; lexical retrieval works without either. Models do not have to live on the same server. Local inference is the privacy-preserving reference path below. Loopback keeps Notient's model requests on this machine; a LAN endpoint receives them inside the network you operate. You may instead deliberately configure a compatible cloud endpoint; that endpoint receives the prompts, note excerpts, images, or embeddings Notient sends for inference, while Notient itself still ships no hosted service. An MCP host is a separate boundary: it receives the note content its tools request and may process that content according to the host vendor's policy.

Notient targets the compatible protocol rather than a vendor list: the endpoint must provide `/v1/models`, `/v1/chat/completions`, and `/v1/embeddings`, plus the streaming, tool-call, vision, or structured-output behavior needed by the feature you use. A runtime such as Triton that exposes only its native API needs a compatible gateway; Notient does not claim native support for engine-specific protocols.

**llama.cpp for chat.** Reserve enough `--parallel` slots for Notient's process-wide reasoning scheduler, configured by `NOTIENT_REASONING_SLOTS`. That scheduler owns chat, extraction, Tier 3 linking, and autonomous note work. `--ctx-size` must cover `NOTIENT_CONTEXT_TOKENS × NOTIENT_REASONING_SLOTS`.

```bash
llama-server -m /models/qwen3-30b-a3b-instruct.gguf \
  --port 8080 --parallel 4 --ctx-size 131072 --jinja
```

**Ollama for embeddings.**

```bash
ollama pull nomic-embed-text
ollama serve      # serves an OpenAI-compatible API at http://127.0.0.1:11434/v1
```

Check both are answering:

```bash
curl -s http://127.0.0.1:8080/v1/models | head
curl -s http://127.0.0.1:11434/v1/models | head
```

**LM Studio as an alternative.** Load a tool-capable chat model and an embedding model in the UI, then point both base URLs at `http://localhost:1234/v1`. Notient validates the configured OpenAI-compatible `/v1/models` catalog first. When that same server also exposes LM Studio's native `/api/v0/models`, Notient uses its richer load-state and context metadata. A missing native route is expected on other OpenAI-compatible servers. LM Studio's separate model-management API uses `/api/v1/models` for the operator commands below:

```bash
curl http://localhost:1234/api/v1/models
```

Look for `loaded_instances` on both models. If the embedding model is installed but not loaded, load it:

```bash
curl -X POST http://localhost:1234/api/v1/models/load \
  -H 'Content-Type: application/json' \
  -d '{"model":"<embedding-model-id>","context_length":512}'
```

## Guided setup

One command performs the next three sections and then checks the result:

```bash
notient setup /path/to/MyVault                                   # asks for the endpoint and model
notient setup /path/to/MyVault --endpoint http://127.0.0.1:1234/v1 --yes
```

Setup writes the default `config.json` when it is absent, reads the endpoint's model catalog, records the chosen reasoning model and, when exactly one loaded embedding model is advertised, the embedding model in the private `.notient/.env` (mode 600), then prints the same read-only report as `notient doctor` and the next commands to run. When the endpoint reports the loaded context, each reasoning slot is given its share of it. A blank endpoint is a valid setup: reading, the structural index and lexical search need no model.

Setup never sends a generation request, never enables background work and never replaces a saved value unless the matching flag names a new one. Run it again to add an endpoint later or to change the model with `--model`. Credentials are not accepted as arguments; add `NOTIENT_LLM_API_KEY` to `.notient/.env` by hand. Without a terminal, or with `--yes`, setup never prompts and asks for `--model` when the catalog does not identify one loaded model. The sections below describe each step for manual configuration.

## Initialize the vault

Use an absolute path. WSL paths such as `/mnt/c/Users/<you>/Projects/MyVault` are supported.

```bash
export VAULT=/path/to/MyVault
notient init "$VAULT"
```

`init` takes the vault as a positional path, creates `<vault>/.notient/`, writes the complete canonical `config.json` when it is absent, and records the vault as `lastVault` in `~/.config/notient/state.json` so later commands can omit `--vault`. Repeating `init` preserves an existing configuration file byte for byte. The daemon validates that file strictly at boot; it does not repair partial or malformed configuration.

## Configure models

The canonical place for per-vault settings is `<vault>/.notient/.env`, read at daemon boot. It wins over process env, so a `.env` that Bun picks up from your current directory (or a stale export in your shell) cannot repoint the vault at another model; to change a key, edit the vault file.

```bash
cat > "$VAULT/.notient/.env" <<'EOF'
NOTIENT_LLM_BASE_URL=http://127.0.0.1:8080/v1
NOTIENT_EMBED_BASE_URL=http://127.0.0.1:11434/v1
NOTIENT_LLM_MODEL=qwen3-30b-a3b-instruct
NOTIENT_EMBED_MODEL=nomic-embed-text
NOTIENT_CONTEXT_TOKENS=32768
NOTIENT_REASONING_SLOTS=4
EOF
chmod 600 "$VAULT/.notient/.env"
```

Drop `NOTIENT_EMBED_BASE_URL` when chat and embeddings share one server; `NOTIENT_LLM_BASE_URL` then covers both. For an endpoint that requires bearer authentication, add `NOTIENT_LLM_API_KEY=<token>`. An absent `NOTIENT_EMBED_API_KEY` inherits that token. Set a distinct embedding token when needed, or set `NOTIENT_EMBED_API_KEY=` explicitly when chat is remote/authenticated but embeddings are served by an unauthenticated local endpoint. Credentials remain deployment-only: they are never written to `config.json`, returned by daemon configuration/status RPC, or included in request-body debug dumps. `.env.example` at the repo root documents every variable.

### Changing the embedding model later

You can swap `NOTIENT_EMBED_MODEL` at any time. The daemon probes the embedding width at boot and compares it against the model and width recorded in the database. When either changed, it clears the vectors, resets only each note's Tier 2 timestamp, and redefines the HNSW index. Tier 3 extraction and its concepts, claims, questions, evidence, and timestamp remain intact. A durable startup repair re-embeds every affected note before running a linker-only refresh, and resumes from its pending flags after an interrupted boot. Nothing in the Markdown vault is touched, and you do not need to `nuke` first. Expect the Tier 2 rebuild to take as long as the original embedding pass.

## Check the installation

```bash
notient doctor --vault "$VAULT" --pretty
notient doctor --vault "$VAULT" --json
```

Doctor checks Bun, SurrealDB, vault access, strict saved configuration, the existing authenticated daemon, structural indexing and saved model catalogs. It does not start or stop services, change files, generate answers or load models. A missing or unavailable model is reported as a feature needing attention; it does not block local note access. A running reasoning deployment that differs from the saved values is reported separately. Catalog availability does not establish generation quality or tool support.

Exit status is 1 for a blocking runtime/configuration problem, and 0 for completed checks with either passes or feature notices. Automation should also inspect the structured `status` and `checks` fields. Doctor is a local-operator command; agents use authenticated read APIs for their permitted runtime information.

## Start the daemon

```bash
notient daemon start --vault "$VAULT"
notient daemon status --vault "$VAULT"
```

A healthy status has `ok: true` and `sealed: true`. If status reports a context mismatch, lower `NOTIENT_CONTEXT_TOKENS`, lower `NOTIENT_REASONING_SLOTS`, or reload the model with a larger context.

`daemon start` is idempotent. If a daemon for that vault is already answering, it reports `daemon:already_running` with the existing pid and socket path instead of forking a second copy.

### Where generated state lives

The database and process state sit under `~/.notient/<vaultId>/`, where `vaultId` is a hash of the absolute vault path. Before trusting anything there, the daemon verifies that `~/.notient` and its vault-specific child are real current-user-owned directories and establishes exact mode `0700`, independent of the launching shell's umask:

- `notient.sock`, the owner-only Unix socket every client dials, verified as a socket and set to exact mode `0600` before readiness
- `daemon.lock` and `daemon.pid`
- `admin.token`, minted fresh at each boot through an exclusive same-directory staging inode, atomically published as a regular owner-held mode-`0600` file, and deleted on shutdown
- `surreal.pid`, a generation/executable/data-directory ownership record, and `surreal.port`; stale cleanup requires exact Linux procfs or macOS process-generation proof
- `restore.quarantine`, present only while an imported generation is not yet verified or safely rolled back
- `secret.key`, the persistent SurrealDB credential for this vault
- `data/`, the SurrealDB data directory
- `backups/`, the default destination for `notient backup`

The vault itself holds `.notient/config.json`, an operator-created `.notient/.env`, `.notient/history.txt` for TUI input history, and `.notient/last.txt` after `/copy`. Conversations and proposals are Notient-owned Markdown artifacts under `Notient/`; they remain readable files while staying outside the ordinary note authority exposed to agents. Conversation embeddings live only in Notient's local SurrealDB substrate.

Print the path for a vault with `notient daemon status --vault "$VAULT"`, which reports `socketPath`.

Native Windows startup is deliberately refused because the current runtime cannot establish and then verify a current-user-only named-pipe ACL; use WSL2. On macOS, crash-left SurrealDB recovery uses the stock `ps`, `sysctl`, and `lsof` surfaces to match boot generation, process start time, executable vnode, canonical data directory, and Notient's random child-generation marker. If any surface is unavailable or the result is ambiguous, startup leaves the handoff and process untouched and reports the refusal. Stop the identified Notient/SurrealDB process or restore those stock tools before retrying; never delete `surreal.pid` while a matching process may still be alive.

## Index the vault

Startup automatically reconciles and indexes structure and lexical chunks without inference. For an explicit embedding pass, run the first two tiers in the foreground. Tier 1 parses and creates deterministic links; Tier 2 chunks and embeds. Neither needs the chat model, although Tier 2 does need the embedding endpoint.

```bash
notient awaken --vault "$VAULT" --tier 1,2
```

Then run Tier 3, the LLM extraction and linking pass, in the background. This is the slow one: the extractor packs consecutive chunks into windows with a 2400-token soft ceiling and issues exactly one structured-output call per window. Tier 3 can invoke Linker alongside extraction for each freshly indexed note.

```bash
notient awaken --vault "$VAULT" --tier 3 --background
notient awaken --vault "$VAULT" --status
```

For each note, the indexer runs Tier 1, Tier 2, then Tier 3. The tiers do not share a single note-wide transaction: Tier 1 and Tier 2 each commit separately, while Tier 3 persists its extraction and linker results through its own writes. A lower tier failure stops the higher tiers for that note.

`--status` streams NDJSON until the run reaches a terminal state. `--pause`, `--resume`, and `--cancel` control a background run. Paused and failed runs are resumable from the run's stored path set and cursor. Cancelled is terminal. `awaken_run.failures` is a capped diagnostic list of failed note paths, not the resume cursor.

Lexical search is available as structural indexing progresses; results report coverage. Grounded `ask` uses the structural index and a reasoning model, without requiring embeddings or extraction. Semantic/hybrid retrieval benefits from Tier 2; Tier 3 adds extracted knowledge.

## Ask something

```bash
notient ask "what did I decide about vector search?" --vault "$VAULT"
notient ask "what did I decide about vector search?" --vault "$VAULT" --format text
notient brief "vector search" --vault "$VAULT"
notient search "vector search" --vault "$VAULT" --mode balanced --limit 5
notient graph stats --vault "$VAULT" --json
notient links audit --vault "$VAULT" --json
```

`search` defaults to `--mode quick`, which is lexical and needs no model. `balanced` and `deep` use embeddings and fail with an embedding-model error when none is configured.

`ask` is read-only and returns `answer`, revision-bound `citations` with exact ranges/quotes, `openQuestions`, `confidence`, `toolCalls`, `durationMs`, provider-accounted `attempts` and structural `coverage`. It explicitly abstains when it cannot support an answer from current sources.

`brief` is also read-only. It returns a concise summary and useful claims, explicitly recorded decisions, questions and competing claims, each with exact source quotations. Use `--max-notes 1..8` and optionally `--folder <path>`. Source revisions, retrieval coverage, limitations and provider usage are included; missing evidence produces an explicit abstention. In the terminal, open **Brief me** from Ctrl+P and choose a topic or the current saved note. In Obsidian, use **Brief me** on the current note. Source navigation retains the result. Unsaved editor text is excluded.

## Open interactive chat

Prove the daemon and model path with a single-shot prompt first:

```bash
notient chat --vault "$VAULT" --prompt "Say exactly: Hello from Notient."
```

Then open the TUI from a real interactive terminal:

```bash
cd "$VAULT"
notient
```

Bare `notient` opens the TUI when both input and output are interactive; `notient chat --vault "$VAULT"` is the explicit equivalent. A pipe receives structured top-level help instead, and `notient --help` always prints help. Chat persists transcripts under `Notient/conversations/`. A transcript is recognized only when its frontmatter declares `notient: conversation` and `conversation_version: 1`; ordinary Markdown and any other version are not imported as conversations. The TUI is full-screen, so after you quit it a captured shell transcript may show little or nothing even though the session ran fine.

The TUI opens your last conversation. **Ctrl+P** opens the navigation menu; type “find” to search note names anywhere in the vault. **Ctrl+O** switches conversations and **Ctrl+N** starts a new one. Chat answers and note previews render Markdown; in Notes, **r** toggles the original source, **Left/Right** switches Read / Outline / Links, **Ctrl+R** refreshes the current note and its connections, and **Esc** returns to Chat. Source labels open the cited note; **Ctrl+T** expands tool activity. Enter sends, Shift+Enter or Alt+Enter inserts a newline, and PageUp/PageDown scrolls the conversation. Typing after a response always composes the next message.

Press Esc in Chat to enter navigation mode, where `1`–`5` switch views, Tab cycles views, and `:` opens a command prompt. `/help` lists commands. In Review, `j`/`k` move, `/` filters, `a` approves the selected proposal, `r` rejects it, and `A` approves all proposals on the selected note. A paused write tool accepts `/approve <callId>` or `/deny <callId> [reason]`; the decision persists in the transcript. Ctrl+C or `/quit` exits.

## Stop the daemon

```bash
notient daemon stop --vault "$VAULT"
notient daemon list          # every known pid record, across vaults
```

`daemon list` is global and does not require `--vault`. It reads every known pid record and reports a dead process as `stale` rather than hiding it. `stop` shuts down the daemon and its SurrealDB child, then removes the socket and ephemeral admin token.

## Reset a vault

`nuke` deletes `~/.notient/<vaultId>/data/`, which is the entire SurrealDB store for that vault, clears any `restore.quarantine` marker, then restarts the daemon so bootstrap applies the schema to an empty database. Your Markdown is untouched; you re-`awaken` afterwards.

```bash
notient nuke --vault "$VAULT" --yes
notient awaken --vault "$VAULT" --tier 1,2
notient awaken --vault "$VAULT" --tier 3 --background
```

Without `--yes` on a TTY it prompts. Without `--yes` and without a TTY it refuses and exits 2, so a script cannot silently destroy a vault.

Reach for `nuke` when the database is corrupt or you want a clean benchmark. You do not need it for an embedding model change, which self-heals, or for a config change, which needs only a daemon restart.

## Back up and restore the graph

`restore` is deliberately empty-database-only. The supported recovery sequence is backup, reset the graph store, let the fresh daemon finish booting, and then restore:

```bash
VAULT_GRAPH_BACKUP=/absolute/path/notient-backup.surql
notient backup --vault "$VAULT" --out "$VAULT_GRAPH_BACKUP"
notient nuke --vault "$VAULT" --yes
notient daemon status --vault "$VAULT"
notient restore "$VAULT_GRAPH_BACKUP" --vault "$VAULT"
```

Backup needs a fully awakened vault: every note must have a complete Tier 1/2/3 generation, which requires configured models and a finished `awaken`. A structural-only vault is refused with that explanation, and its Markdown needs no graph backup.

Set `VAULT_GRAPH_BACKUP` to a concrete path that does not already exist. Backup streams to a private mode-`0600`, UUID-named file in that destination directory, fsyncs it, releases maintenance, then publishes the complete inode with one exclusive hard link. The requested path is never written or removed during in-flight failure cleanup, and an operator file created concurrently wins without being overwritten or deleted. The file is a v2, records-only Notient backup authenticated with this vault's persistent `secret.key`; arbitrary, edited, truncated, and pre-authentication SurrealQL files are rejected before the privileged importer executes them. It is a graph-recovery artifact for this vault, not a Markdown archive or a portable SQL migration.

The records allowlist contains the durable note graph, provenance edges, approval intents, history, daemon-write receipts, agent events, and awaken/agent runs. It contains no schema statement, access definition, database JWT signing secret, daemon-owned `meta`, derived `conversation_memory`, live `agent_session` authorization grant, vault-local `note_write_intent`, or unresolved wikilink/embed staging row. Bootstrap owns deployment metadata, conversation vectors rebuild from canonical transcripts, grants must be issued again, filesystem write intents never cross snapshot generations, and Tier 1 rebuilds unresolved staging.

The authenticated v2 envelope separately binds the exact embedding model id and vector dimension that give its chunk vectors meaning. Restore compares that manifest with the fresh daemon's `meta:embedding` identity before import and rejects a model or width mismatch. The backup verifier also rejects any stored chunk vector whose model or length disagrees with that identity.

Backup is accepted only when the configured public Markdown set exactly equals the live non-tombstoned note set, every file SHA matches its note row, and Tier 1, Tier 2, and Tier 3 timestamps are complete and ordered with no pending linker refresh. A dump is a graph snapshot of those exact Markdown bytes; it does not contain the Markdown itself. Restore therefore requires the same public paths and bytes to still exist. A new, edited, deleted, excluded, tombstoned, partially indexed, or pending-refresh note makes the command fail closed.

Both commands acquire an admin-only maintenance lease from the daemon. The lease blocks ordinary RPC admission; drains startup repair, indexing, watcher mutations, sentient-coordinator work, chat follow-ups, approved post-RPC writes, and the event ledger; and refuses to begin while an awaken worker or unresolved human write approval is still active. Markdown edits made by an external editor while chokidar is stopped are detected by exact before/after snapshots, replayed through the canonical add/edit/delete handlers, and indexed before admission reopens. That drift invalidates the backup or restore rather than silently reporting a mixed generation.

Restore refuses any non-empty graph, operational, grant, write-intent, or unresolved-staging table rather than merging generations, and the records file repeats that empty-target check inside the same transaction as import. A durable `restore.quarantine` marker is armed before the importer can touch the database, so an interrupted restore cannot silently become a normal daemon generation after restart. After import, running awaken runs and unfinished agent runs are terminalized with an explicit restore reason; paused awaken checkpoints remain resumable. `links sync` then settles imported approval intents, and the exact Markdown/graph invariant is checked again before success.

`backup` and `nuke` never rewrite Markdown. Restore normally leaves it untouched, but an imported write-ahead approval intent may complete or roll back its already-approved note write under the intent's exact before/after byte guards. If a post-import reconciliation or SHA check fails, Notient transactionally removes every imported allowlisted row while the maintenance fence is still closed, then rebuilds from canonical Markdown before reopening admission. If rollback itself cannot be proved complete, maintenance stays poisoned and the durable quarantine blocks restart; only authenticated daemon shutdown remains available so `nuke --yes` can recover. If import, intent reconciliation, final verification, or maintenance release reports failure, run `notient nuke --vault "$VAULT" --yes` before retrying the authenticated dump.

## When the daemon will not come up

Most socket-backed verbs, including `chat`, `ask`, `brief`, `search`, and MCP, auto-spawn a missing daemon and wait up to 120 seconds. `init` and `daemon list` do not connect or spawn. `daemon stop` also refuses to spawn something merely to stop it. The substrate commands `db sql`, `graph dump`, `graph stats`, `links audit`, `backup`, and `restore` require an already-running daemon. Backup and restore additionally use the authenticated daemon socket to hold their exclusive maintenance lease while their isolated SurrealDB CLI child runs. On a large vault, a WSL mount, or the first boot after a schema change, startup can exceed the client deadline:

```text
Daemon failed to start within 120000ms
```

Start it explicitly and poll instead:

```bash
notient daemon start --vault "$VAULT"
notient daemon status --vault "$VAULT"
```

If status still cannot connect, start with the bounded read-only diagnostic:

```bash
notient doctor --vault "$VAULT" --pretty
```

For additional endpoint/process details:

```bash
command -v surreal && surreal version
curl -s http://127.0.0.1:8080/v1/models | head
curl -s http://127.0.0.1:11434/v1/models | head
ps -ef | grep -E 'notient|surreal' | grep -v grep
```

Then restart the daemon:

```bash
notient daemon stop --vault "$VAULT"
notient daemon start --vault "$VAULT"
```

## Safe scratch writes

Agent-facing writes are approval-gated by default. A matching session grant, a per-tool `auto` policy, or global `yolo` mode can apply them inline; otherwise they remain pending for a human or return denied. For an unattended write test, prefer a narrow expiring grant, run as that identity, and revoke it when you are done.

```bash
notient session grant \
  --vault "$VAULT" \
  --client codex-battle \
  --folders 0-inbox/notient-live-battle-test/ \
  --tools notes.create,notes.append \
  --max-writes 2 \
  --ttl 15

notient chat \
  --vault "$VAULT" \
  --as codex-battle \
  --prompt "Create a new note at 0-inbox/notient-live-battle-test/hello.md with body: # Hello"

notient session list --vault "$VAULT"
notient session revoke <sessionId> --vault "$VAULT"
```

## Next

- [../README.md](../README.md) for the full verb table, the configuration reference, and the architecture.
- [obsidian.md](obsidian.md) for the exact Obsidian interoperability boundary.
- [agents.md](agents.md) to install the Codex/Claude Code plugin or configure OpenCode.
- [mcp.md](mcp.md) for the complete MCP protocol and approval contract.
