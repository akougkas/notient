# Obsidian and Notient

Notient works directly on an Obsidian vault because both products treat Markdown as durable data.
The terminal experience does not require Obsidian to be running. The first-party desktop plugin
adds native editor context, exact source navigation, search, capture, connection browsing, workflow previews and editor write
protection. Its current development build and installation steps are in
[the Obsidian integration](../integrations/obsidian/README.md); the full sprint plugin is still in progress.

The Note workspace shows outgoing links, backlinks and reviewed/proposed relationships from the same graph service used by the terminal and external agents. It checks saved-file revisions, distinguishes authored links from model assessments, and labels stale or unavailable evidence. Connection buttons open existing files through Obsidian; evidence buttons use native revision-checked source navigation. Dirty editor context remains separate from saved-file graph evidence.

## Start with an existing vault

Initialize the vault root once:

```bash
notient init /absolute/path/to/ObsidianVault
```

Notient recognizes `.obsidian` while walking parent directories, so from any ordinary nested vault
folder a bare interactive invocation opens the TUI for the correct root:

```bash
cd /absolute/path/to/ObsidianVault/Projects/current
notient
```

Commands also accept `--vault`, and `NOTIENT_VAULT` is useful for an agent launched from a neutral
project. Repeating `notient init` preserves an existing complete strict configuration byte for
byte; it does not merge or migrate legacy fields.

## Markdown behavior

Notient indexes ordinary public `.md` files and understands the Obsidian structures that carry
meaning between them:

- YAML frontmatter, aliases, scalar or list tags, and untouched frontmatter bytes;
- `[[wikilinks]]`, path-qualified links, headings, and display aliases;
- inline and reference-style Markdown links, percent-encoded destinations, note embeds, and YAML note references in incoming/outgoing connections and graph paths;
- Markdown headings, code fences, blockquotes, lists, tables, and inline tags;
- reference-aware moves across wikilinks, relative Markdown/reference links, YAML link values and attachments, preserving aliases and heading/block fragments;
- fenced code remains source data, not links to rewrite.

After an indexing-format upgrade, startup refreshes unchanged structural records locally. It preserves Markdown, human edit times, reviewed semantic relationships and matching cached embeddings; the refresh does not grant permission for background AI.

The watcher observes eligible Markdown saves from Obsidian. Notient's targeted note operations
re-read current bytes before applying an approved write and record the exact before/after receipt
for guarded human undo. A conflicting edit is refused rather than replaced with a stale snapshot.
Notient-owned conversations and proposals are also Markdown under `Notient/`. The runtime graph
database, socket, boot secrets, and process records live in the owner-private external state
directory; the strict config and operator-managed deployment `.env` remain under `.notient/` in
the vault.

## Boundaries

`.obsidian` is editor configuration, not note content. Both `.obsidian` and `.notient`, every other
dot-prefixed segment, absolute paths, traversal, and symlink escapes are excluded from agent-facing
read and write tools. Notient does not rewrite Obsidian settings or claim `.canvas` files as Markdown notes.
The optional desktop plugin is installed and explicitly paired by the operator.

Keep Obsidian's own sync or Git workflow responsible for transporting Markdown. Stop Notient
cleanly before moving a vault between machines, and run one daemon per local vault path. If an
external sync produces a conflict file, treat it as user-owned Markdown and resolve it explicitly;
Notient does not silently choose a winner.

For first-run model and lifecycle setup, continue with [Getting Started](getting-started.md). For
coding-agent access to the same vault, see [Agent integrations](agents.md).

Review → Change history shows saved before/after versions with native Markdown rendering and exact source. Review undo, then confirm the single recorded effect; newer saved edits or unsaved native buffers prevent it. Interrupted operations remain inspectable, and completed receipts survive restart without replaying the change. Original journal entries remain visible after undo.

From the **Note** workspace, **Compare with…** opens Obsidian’s native fuzzy note picker and accepts a focused question. **Explore connections** searches for relevant candidates. Results show rendered explanations and exact source quotations; opening one preserves the analysis. **Stop** cancels the provider request. Comparisons use saved revisions, exclude unsaved editor text, and do not modify notes.
