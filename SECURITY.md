# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Report privately through GitHub:
<https://github.com/akougkas/notient/security/advisories/new>. Please do not open a
public issue for a vulnerability. Include the version, your platform and the
smallest reproduction you have. Expect a first reply within a week. This is a
single-maintainer project, so fixes are best effort.

## What Notient is designed to protect

- The daemon listens on a private Unix socket and on loopback HTTP only. HTTP
  clients authenticate with a credential obtained through a single-use pairing
  code, and each credential carries explicit scopes (`read`, `write`, `host`,
  `admin`).
- Agents and the in-app assistant cannot approve their own changes, grant
  themselves scopes or undo history. Those actions belong to a human principal.
- Vault paths are confined to the vault. Hidden paths such as `.notient/`, `.git/`
  and `.obsidian/` are not readable through note operations.
- Endpoint credentials live only in the vault's private `.notient/.env`. They are
  not written to `config.json`, returned by status calls or included in debug dumps.
- Notient has no hosted service and sends no telemetry. Note content leaves the
  machine only toward the model endpoint you configure and toward an MCP host that
  requests it.

## Out of scope

Notient assumes the local user account is trusted. Another process running as the
same user can read the vault and the daemon's private state. The model endpoint
and any MCP host you connect are trust boundaries you choose; what they do with the
content they receive is outside Notient's control.
