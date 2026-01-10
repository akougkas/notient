# Orchestration Schemas (AI-to-AI Protocol)

> Human-readable reference for the compact formats used in TASK.md and REPORT.md

---

## TASK.md Schema

```yaml
# [Agent] - [Brief Title]
status: ready | in_progress | blocked
phase: [phase-name]
branch: [git-branch]

## do
- [file-path]: [action-verb] [what]
- [file-path]: [action-verb] [what]

## context
[Optional: 1-2 lines of relevant background if needed]

## verify
- `[command]` → [expected]

## git
files: [list of files to stage]
msg: "[commit message]"
```

**Example (compact):**
```yaml
# Archie - Backend Service Fix
status: ready
phase: p1-s2
branch: ALPHA-SPEC-SPRINT

## do
- src/main.ts: remove conditional service registration
- src/core/agent/taskQueue.ts: add LLM availability check in enqueue()

## verify
- `bun run typecheck` → pass
- `bun run build` → pass

## git
files: src/main.ts, src/core/agent/taskQueue.ts
msg: "fix(backend): Always register services"
```

---

## REPORT.md Schema

```yaml
# [Agent] Report
status: complete | blocked | failed
commit: [hash] | none

## did
- [file-path:lines]: [what was done]

## verify
typecheck: pass | fail
build: pass | fail

## issues
[none | list blockers]
```

**Example (compact):**
```yaml
# Archie Report
status: complete
commit: abc1234

## did
- src/main.ts:168-195: removed conditional, always register services
- src/core/agent/taskQueue.ts:42-48: added isAvailable() check

## verify
typecheck: pass
build: pass

## issues
none
```

---

## Agent Definition Schema (~/.claude/agents/*.md)

```yaml
---
name: [agent-name]
model: [opus|sonnet|haiku]
tools: [tool-list]
---

# [Name] - [Role]

## prime
[1-2 sentences: who you are, what you do]

## workflow
1. [step]
2. [step]
...

## rules
- [constraint]
- [constraint]

## patterns
[Optional: code patterns to follow or avoid]
```

---

## Token Efficiency Guidelines

1. **No greetings or encouragement** - skip "Ready? Go!" etc.
2. **No repeated git rules** - reference once in SCHEMA.md
3. **No examples of bad code** - just say what to do
4. **No verbose explanations** - agents understand context
5. **Use shorthand**: `p1-s2` = Phase 1 Stage 2
6. **Path:lines format**: `src/foo.ts:42-58`
7. **Verify as commands**: `bun run X` → pass/fail

---

## ORCHESTRATOR.md (Human-Readable)

The orchestrator file remains verbose and detailed because it's the human-AI interface. It should include:
- Full context for CEO understanding
- Phase/stage tracking tables
- Launch commands for running agents
- Resume instructions
- Decision rationale

Internal agent files (TASK.md, REPORT.md) use compact schemas above.
