---
name: notient
description: Use Notient as the grounded, durable memory substrate for a Markdown or Obsidian vault. Trigger when the user asks what their notes say, wants relevant prior decisions or related notes, opens a session inside a vault, asks to preserve a conclusion as a note, or wants an agent to search, read, connect, or propose changes to their notes through Notient. Prefer the configured Notient MCP tools; use the CLI only when MCP is unavailable.
---

# Notient

Treat Notient as the substrate through which the notes perceive, remember, relate, and answer. Do
not describe Notient as the visiting agent or treat its database as the source of truth. Markdown
is durable; models and hosts are transient visitors.

## Choose the smallest grounded operation

- Use `notient_ask` for a question that needs a synthesized answer with citations, confidence, and
  open questions.
- Use `notient_brief` for a bounded topic or current-file briefing.
- Use `notient_search` when raw ranked paths, scores, and snippets are more useful than synthesis.
- Use `notient_read_note` only for an exact path returned by Notient or supplied by the user.
- Use `notient_neighbors`, `notient_vitals`, and `notient_events` to inspect relationships,
  freshness, and new cognitive activity.
- Use `notient_list_notes` to explore a specific public vault folder, not to crawl the whole vault.

Prefer MCP whenever the `notient` server is available. It exposes nine read tools, six
write-capable tools, `notient://status`, `notient://vault/{+path}`, and the `notient_recall` prompt.
Do not use web search, filesystem search, or generic tool discovery to locate these tools, and do
not shell out merely to reproduce an available MCP operation.

## Preserve grounding

Copy citation paths exactly from Notient results. Distinguish retrieved evidence from generated
interpretation. Preserve Notient's confidence and open questions, including an empty or
unanswerable result. Never invent a note, quotation, path, graph relation, command result, or
successful write.

For Obsidian vaults, keep exact vault-relative `.md` paths and existing wikilink syntax. Never read
or write `.obsidian`, `.notient`, another dot-prefixed segment, an absolute path, traversal, or a
symlink escape. Do not bypass Notient with host filesystem tools when the user requested a Notient
operation.

## Propose durable changes once

Assume writes require human review. Choose the narrowest operation:

- `notient_create_note` for a new established artifact.
- `notient_append_note` to add information without replacing existing prose.
- `notient_replace_section` only to correct one named section; it is destructive within that
  section.
- `notient_update_frontmatter` only for named top-level keys.
- `notient_propose_note` for a suggestion the human should evaluate as a proposal.
- `notient_propose_link` to stage one typed relationship between two indexed public notes.

Call a requested write once and interpret its receipt exactly:

- `applied`: bytes are already durable; report the path and history id when returned.
- `pending`: no note bytes changed; report the `callId` and wait for a human decision. Do not retry.
- typed edge `pending`: the proposal exists, but the relationship and Markdown writeback do not;
  report the `proposalId` and do not retry.
- `denied`: no write will follow; report the reason and stop.

Only the human may approve or reject pending work, grant sessions, run maintenance, or undo. Never
request or use the reserved `human` identity. The MCP server authenticates this host under its
configured visitor id and attributes applied writes to that id.

## Handle lifecycle and errors

Allow one bounded daemon auto-start. If startup does not become ready within 120 seconds, report
the failure and stop using Notient for the session.

Read calls may reconnect and replay once after a disconnect. Writes fail closed on the first
ambiguous disconnect and must not be retried. Treat `DAEMON_DISCONNECTED`, `FORBIDDEN`, malformed
results, and integrity errors as terminal for that operation. Surface Notient's error without
weakening path, identity, approval, or configuration boundaries.

## CLI fallback

Use the CLI only when MCP is unavailable and `notient` is on `PATH`. Pass the host's exact agent id
on every socket-backed call, for example:

```bash
notient search "HNSW" --mode balanced --as codex
notient ask "What did we decide about indexing failures?" --format structured --as codex
notient brief --file notes/current.md --as codex
notient events --no-poll --as codex
```

Replace `codex` with the configured host identity. Do not use CLI fallbacks for admin-only actions.

Do not invoke Notient for generic knowledge or programming questions that do not depend on the
user's notes, after a terminal startup/disconnect failure in the same session, or while debugging
Notient's own source unless the user explicitly asks to test the running product.
