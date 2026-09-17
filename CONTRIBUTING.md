# Contributing to Notient

Notient is a small project with one maintainer. Bug reports with a reproduction are
the most useful contribution. For anything larger than a fix, open an issue first so
the design can be agreed before you spend time on it.

## Setup

Requires Bun 1.4.2 or newer and SurrealDB 3.0.5 on `PATH`. Packaging also needs `zip`.

```sh
bun install --frozen-lockfile
bun install --cwd integrations/obsidian --frozen-lockfile
```

## Before you open a pull request

```sh
bun run typecheck
bun run typecheck:obsidian
bun run lint                # 0 errors; do not add warnings
bun test testing/unit
bun run test:integration    # starts real daemons and SurrealDB; about 13 minutes
```

No test may require a model, a network service or Obsidian. Tests that need
inference use the local fake providers under `testing/`.

## Ground rules

- Markdown is the source of truth. Code that writes to a vault goes through the
  change, review and history services. Nothing writes note bytes directly.
- Agents and the in-app assistant can plan and request changes. Only a person
  applies, rejects or undoes them. Do not add a path around that.
- A source reference is a path, a revision, a range and an exact quotation. Stale
  or mismatched evidence is a conflict, never a silent recompute.
- The public contract lives in `src/api/`. If you change an operation, regenerate
  the OpenAPI document with `bun tools/build-openapi.ts` and update `docs/api-v1.md`.
- Keep commits small and explain why in the message. Record user-visible changes
  in `CHANGELOG.md`.
- Never commit vault content, model transcripts, endpoints, tokens or machine paths.

By contributing you agree that your work is licensed under the [MIT license](LICENSE).
