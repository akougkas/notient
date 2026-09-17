# Agent integrations

Notient gives coding agents a grounded way to visit a Markdown or Obsidian vault. The host is not
the memory system: it comes and goes, while Markdown stays authoritative and Notient's watcher,
graph, retrieval, and synthesis let the notes answer and develop together.

The shipped plugin contains one canonical `notient` skill plus an authenticated local MCP adapter.
Codex connects as `codex`; Claude Code connects as `claude-code`. OpenCode uses the same MCP
contract as `opencode`. That identity is recorded on proposed or applied changes and never grants
human/admin authority.

## Before connecting a host

Install Notient so `notient` is on the host's `PATH`, initialize the vault, configure its model
endpoints, and run `notient health --vault /absolute/path/to/vault`. The plugin deliberately does
not install or choose models and does not read credentials from an agent project.

When the host runs inside the vault, Notient discovers the nearest `.notient` or `.obsidian`
ancestor. For a neutral project, set `NOTIENT_VAULT` to the absolute vault path in the environment
that launches the host, or add an explicit `--vault /absolute/path` to a manual MCP registration.
The Codex plugin explicitly forwards only `NOTIENT_VAULT` from that launch environment to its MCP
process. Do not put provider keys in an agent config; endpoint credentials belong in the vault's
owner-private `.notient/.env`.

## Codex

Install the repository marketplace and plugin:

```bash
codex plugin marketplace add akougkas/notient
codex plugin add notient@notient
codex mcp list
```

`codex mcp list` should show one enabled server whose command is `notient mcp --as codex`. The
plugin also installs the `$notient` skill, which tells Codex when to use MCP, how to preserve
grounding, and how to interpret applied, pending, and denied write receipts.

Launch Codex with the target vault selected when the project is outside that vault:

```bash
NOTIENT_VAULT=/absolute/path/to/vault codex
```

The plugin's MCP definition whitelists that variable using Codex's documented `env_vars` contract;
it does not copy the path or any secret into the plugin. Verify the effective registration with
`codex mcp get notient --json`: `env_vars` must contain `NOTIENT_VAULT`.

For a checkout under active development, replace `akougkas/notient` with its absolute repository
path. Use an isolated `CODEX_HOME` when testing so marketplace, plugin, skill, and MCP state cannot
modify the operator's normal Codex configuration.

## Claude Code

Install the same repository through Claude Code's plugin marketplace:

```bash
claude plugin marketplace add akougkas/notient
claude plugin install notient@notient
```

The plugin's `.mcp.json` launches `notient mcp --as claude-code`, and Claude Code loads the same
canonical Notient skill as Codex. For a one-session checkout test, use:

```bash
claude --plugin-dir /absolute/path/to/notient/plugins/notient
```

Do not also register a second manual Notient MCP server in that session. One host, one visitor
identity, and one MCP connection path avoids duplicate daemons and ambiguous history attribution.

## OpenCode

OpenCode consumes MCP directly. Add this to an isolated `opencode.json` in the neutral project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "notient": {
      "type": "local",
      "command": ["notient", "mcp", "--as", "opencode"],
      "enabled": true,
      "environment": {
        "NOTIENT_VAULT": "/absolute/path/to/vault"
      }
    }
  }
}
```

Confirm it with `opencode mcp list`. Run OpenCode in a neutral project and approve only the Notient
calls you intend. Do not use host-level automatic approval to erase Notient's review boundary.

## What every host should prove

Before trusting an integration with a real vault, use a scratch vault and verify:

1. `notient_search` returns real vault-relative paths, then `notient_ask` or
   `notient_read_note` quotes bytes that exist in those paths.
2. An unanswerable question stays unanswerable instead of producing invented evidence.
3. A safe-mode note write returns `pending` and leaves Markdown unchanged until a human approves
   its exact call id.
4. A typed link remains a pending proposal until human approval and writes outside frontmatter and
   code fences.
5. `.notient`, `.obsidian`, traversal, absolute paths, and symlink escapes are refused.
6. After a human stops the daemon, one idle read reconnects once and succeeds without creating a
   second daemon.

Writes are not retried after an ambiguous disconnect. A pending receipt means no note bytes have
changed; an applied receipt includes durable history attribution; a denied receipt is terminal.
Only the human TUI/CLI may approve, reject, grant a session, run maintenance, or undo.

The complete tool, resource, error, and approval contract is in [Notient MCP](mcp.md). The single
behavioral authority loaded by both plugins is
[`plugins/notient/skills/notient/SKILL.md`](../plugins/notient/skills/notient/SKILL.md).
