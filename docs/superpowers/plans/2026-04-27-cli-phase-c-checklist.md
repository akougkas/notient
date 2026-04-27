# Phase C TUI Manual Checklist

Run after `bun run smoke:cli:phaseC` is green. Each item is yes/no.

1. [ ] `notient chat --vault <fixture>` (no positional) launches a full-screen TUI with status bar, transcript area, and input bar.
2. [ ] `/help` lists exactly: read, search, awaken, vitals, health, clear, quit.
3. [ ] Typing a question and pressing Enter streams an assistant reply visible character-by-character.
4. [ ] During the reply, a `vault.search_notes` tool indicator appears.
5. [ ] The tool indicator is followed by a `done <id>` line within a few seconds.
6. [ ] `/search "TDD"` returns at least one path.
7. [ ] `/vitals notes/<some-note>.md` returns a snapshot summary.
8. [ ] `/quit` cleanly returns to the shell with no orphan processes.

If any item fails, capture stderr from `~/.notient/<vault-hash>/logs/` and reopen Phase C until green.
