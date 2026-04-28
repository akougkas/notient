# Phase D TUI Manual Checklist

Run after `bun run smoke:cli:phaseD` is green. Each item is yes/no.

1. [ ] `/help` lists the new verbs (approve, deny, undo, history) alongside the Phase C set.
2. [ ] After the assistant requests a `notes.*` write, a `pending: <tool> (callId=…)` line renders.
3. [ ] `/approve <callId>` resolves the gate and the assistant resumes.
4. [ ] `/deny <callId>` resolves with approved=false and the assistant emits a refusal note.
5. [ ] `/undo` reverses the most recent write and prints the entry that was reversed (kind + target).
6. [ ] `/history` lists the last 10 chat-driven writes, newest first.
7. [ ] Typing `@inbox/` and pressing Tab replaces the partial with the first match and shows the next four hints.
8. [ ] Typing `@inbox/foo` and pressing Tab also completes (filename prefix inside a folder).
9. [ ] `/read inbox/foo.md` renders the body in a fenced block, truncated at ~5000 chars.
10. [ ] A long-history conversation prints a `context summarized (… → … tokens)` info line when budget overflows.
11. [ ] An 8K-context model running with default 200_000 setting prints `warning: configured modelContextTokens=200000 but turn estimates …`.
12. [ ] First chat turn of the session prints `tool-mode for <model>: native (attempts=<1|2>)`.
