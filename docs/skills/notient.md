---
name: notient
description: Notient is a local-first knowledge agent backing the user's Obsidian vault. It maintains a graph of claims, decisions, questions, and contradictions across the user's notes, and exposes seven CLI verbs for read and write access. Invoke this skill whenever the user asks about their own notes, decisions, or vault memory, opens a session inside a vault directory, or finishes a conversation that should leave durable artifacts.
---

## What is Notient

Notient is a local-first knowledge agent backing an Obsidian vault. It runs its own four-agent swarm that maintains a graph of claims, decisions, open questions, and contradictions across the vault's notes. Notient exposes seven CLI verbs and is always invoked as `notient <verb> [...args] --as claude-code`. The daemon is local. If the daemon is not running, every command fails fast. That failure is the signal to stand down silently for the rest of the session, not to retry or surface a noisy error.

## When to invoke

Invoke when:

- The user asks about their own notes, decisions, or vault memory. Phrasings include "what do I think about", "what did I decide on", "what have I written about", "what's my position on", "I've been working on". Use `ask` for questions, `brief` for topics.
- A session starts in a directory that contains an Obsidian vault (a `.obsidian/` directory exists). Drain `events --since 0` once at session start to catch up on swarm discoveries since the last session, then store the returned cursor.
- The user is editing a file with architectural or note-like intent and asks for related context from their vault. Use `brief --file <path>`.
- The user asks "what do I have on <topic>?" or "what have I written about <topic>?". Use `brief <topic>`.
- The user finishes a long conversation that produced durable insights, or a session ends with material new content that did not flow back into the vault. Offer `distill --from <transcript>`.
- The user says "remember that" or "save this as a note" about a slice of the conversation. Use `distill` on that slice. Run `--dry-run` first when uncertain.
- The user references vault state implicitly ("did I already write this up?", "have I argued for this before?"). Use `ask`; surface citations so the user can confirm.

Do not invoke when:

- The user asks a generic programming or general-knowledge question with no vault context.
- `notient` is not on PATH, or a previous invocation in this session returned daemon-not-running. Stand down for the rest of the session.
- The user is editing inside a directory that has no `.obsidian/` and the request has no vault hook.
- The user is debugging Notient itself or asking how the CLI works. Direct them to `notient --help` rather than firing the verbs.

## How to invoke

The verb hierarchy is read-first, write-last. Reach for `ask` and `brief` before anything else. Reach for `events` at session boundaries. Reach for `distill` only when the user has explicitly asked to capture conversation content into the vault, and only after `session list` confirms a grant or after a `--dry-run` has been shown to the user. The `session` verbs are administrative; the user drives them and the skill calls them on the user's behalf when they ask.

### `ask`

Single-shot natural-language intent. Read-only by contract. Use when the user has a specific question that should be answered from the vault graph.

```bash
notient ask "what is my position on auth strategies?" --as claude-code
```

The default response is JSON:

```json
{
  "answer": "string",
  "citations": [{"path": "string", "anchor": "string"}],
  "openQuestions": ["string"],
  "openContradictions": ["string"],
  "confidence": 0.0,
  "toolCalls": [{"name": "string", "args": {}}],
  "durationMs": 0
}
```

Pass `--format text` to extract only the `answer` field for plain prose output. Use that when the user wants a direct sentence and you do not need the structured fields.

### `brief`

Topic-driven or file-driven structured brief. Deterministic queries plus one summary call. Use when the user wants a structured snapshot rather than a narrative answer.

```bash
notient brief "TDD" --as claude-code
notient brief --file /path/to/current.md --as claude-code
```

Topic mode is for "what do I have on X" questions where X is a concept. File mode is for "what is in my vault that relates to this file I am editing". Pick file mode whenever the user has a concrete file in front of them and the question is contextual to it. The result includes `summary`, `relevantNotes`, `recentDecisions`, `openQuestions`, and `openContradictions`. Use `--max-notes`, `--max-questions`, and `--max-decisions` to bound the result when the topic is broad.

### `distill`

Ingests an external conversation transcript and writes proposal files under `<vault>/Notient/proposals/distilled-*`. Accepts markdown, JSONL, or JSON.

```bash
notient distill --from /tmp/conversation.md --dry-run --as claude-code
notient distill --from /tmp/conversation.md --as claude-code
```

Run `--dry-run` first when there is no active session grant covering the proposals folder, or when the transcript content is uncertain. The dry run surfaces the candidate proposals without writing. Promote to a live run only after the user confirms or after `session list` shows a covering grant.

### `events`

Long-poll stream of swarm discoveries. NDJSON output: one event per line, then a final cursor line. Default behavior long-polls for 30 seconds.

```bash
notient events --since 0 --as claude-code
notient events --since 4821 --no-poll --as claude-code
```

The last line of the response is `{"type":"events:cursor","cursor":<n>}`. Record `n` and pass it as `--since` on the next call. Use `--no-poll` for an immediate return when checking once at session start. Use the default long-poll when watching for new activity. The cursor is a monotonic integer the daemon issues; preserving it across sessions is what makes catch-up correct. If the cursor is lost, restart from `--since 0` and accept the duplicates.

### `session grant`

Issues a scoped trust grant for unattended writes. The user must authorize this before any write-effecting loop runs.

```bash
notient session grant --client claude-code \
  --folders "Inbox/" "Notient/agent-asks/" \
  --max-writes 20 --ttl 60 --as claude-code
```

Folders are vault-relative. `--max-writes` caps the total writes the grant authorizes. `--ttl` is in minutes. Never auto-issue a grant on the user's behalf and never widen the folder list beyond what the user asked for. If a flow needs broader scope than the active grant, stop and ask.

### `session list`

Lists active grants. Filter by client when checking for an existing grant.

```bash
notient session list --client claude-code --as claude-code
```

### `session revoke`

Revokes a grant by id.

```bash
notient session revoke ses_01HXYZ --as claude-code
```

## Identity

> Every invocation passes `--as claude-code`. No exceptions. The daemon associates writes with the matching session grant by this identity, and `--as`-tagged conversations stay separable from human-direct sessions. Any command issued without `--as claude-code` is a defect.

## Boundaries

- Never write through `ask`. The verb is read-only by contract and writes are rejected.
- Never assume write authority. Before any write-effecting flow (any `distill` without `--dry-run`), call `notient session list --client claude-code --as claude-code` and confirm an active grant covers the target folder.
- Surface contradictions inline. When `ask` or `brief` returns non-empty `openContradictions`, tell the user. Do not silently drop them.
- Honor `session revoke` immediately. If the user revokes during a loop, stop the loop on the next iteration boundary.
- Treat daemon-not-running as a hard stop. Do not retry. The user starts the daemon when they want Notient.
- Never chain verbs across grant boundaries. If a `distill` run consumes the grant's `--max-writes` budget, stop and tell the user; do not request a fresh grant on its behalf.

## Errors

- `daemon-not-running`: any non-zero exit whose stderr contains `daemon-not-running` or a socket-not-found message. Stand down for the remainder of the session. No retries, no alerts.
- `permission-denied`: respect immediately. If the operation needs a session grant, tell the user which folder and which verb the grant must cover.
- Path validation failure on `distill --from <path>`: the path must exist and must not contain `..` traversal. Surface the daemon's error verbatim to the user.
- Empty result on `ask` or `brief`: the daemon returned valid JSON with empty fields. Say so plainly. Do not fabricate an answer or guess the user's intent.
- Malformed NDJSON line in `events` output: skip the malformed line, keep parsing, and still record the trailing cursor. A single bad line is not a session-ending failure.

## Detection examples

| User says | Verb to call |
|---|---|
| "What's my position on auth strategies?" | `notient ask "what is my position on auth strategies?" --as claude-code` |
| "What do I have on TDD?" | `notient brief "TDD" --as claude-code` |
| "Have I written anything about retrieval-augmented generation?" | `notient brief "retrieval-augmented generation" --as claude-code` |
| "Is there anything in the vault relevant to this file?" | `notient brief --file <current path> --as claude-code` |
| "What did I decide about the storage layout?" | `notient ask "what did I decide about the storage layout?" --as claude-code` |
| "Catch me up on what the swarm found since last time." | `notient events --since <stored cursor> --no-poll --as claude-code` |
| "Save the gist of this conversation." | `notient distill --from <transcript> --dry-run --as claude-code`, then live after grant |
| "Remember that I want to revisit the embedding cache." | `notient distill --from <slice> --as claude-code` (after `session list` confirms a grant) |
