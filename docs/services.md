# Persistent local operation

The daemon stays running until explicitly stopped or signalled. A quiet vault no longer causes an unconditional four-hour shutdown. Local file reads, structural indexing and lexical search start even when inference is unconfigured or unreachable. Embedding/extraction availability is separate; durable live recovery of model work is still being completed for v0.1.0.

`daemon start` delegates capability discovery to the daemon; an ambiguous model catalogue does not prevent local operation or launch an interactive configuration writer. Use `notient doctor --vault … --pretty` to inspect the saved deployment and current readiness without generation or service changes.

Install the user service for an existing configured vault:

```sh
notient daemon service install --vault /absolute/path/to/vault
notient daemon service status --vault /absolute/path/to/vault
notient daemon service uninstall --vault /absolute/path/to/vault
```

Linux/WSL uses a per-vault unit in `~/.config/systemd/user/`. macOS uses a per-vault plist in `~/Library/LaunchAgents/`. These commands require the human operator; an explicit agent identity is refused. Installation is idempotent. If a daemon already owns the vault, installation preserves that process rather than stopping it. The installed service can take over at the next login or explicit service start after the existing owner exits. Uninstall removes the service definition and stops its managed process; it does not remove vault content or database state.

The service runs the exact Bun executable and daemon entry associated with the CLI used to install it. Reinstall the service after moving the installation or changing Bun's location. Deployment credentials stay in the existing private vault deployment file; service definitions carry only executable paths and PATH. The service uses `/` as its working directory and disables implicit project dotenv loading. The daemon still applies the vault's explicit `.notient/.env` precedence.

Linux services start on the user's service-manager login lifecycle. Running after logout may require the operator's chosen systemd lingering setup; Notient does not silently change that machine policy. WSL must have systemd enabled for the user service path. If no user service manager is available, the definition can still be prepared and the result includes a fallback action:

```sh
notient daemon start --vault /absolute/path/to/vault
notient daemon status --vault /absolute/path/to/vault
notient daemon stop --vault /absolute/path/to/vault
```

Verification in this sprint: WSL/Linux user systemd install, active status, repeated install preserving the same MainPID, `systemd-analyze --user verify`, and uninstall all passed on a disposable vault with an unreachable inference endpoint. The test service and enablement symlink were removed. Generated launchd XML has focused formatting/escaping tests; actual macOS launchd operation has not been verified. No service was installed for the owner's experimental the owner's experimental vault vault during these checks.

Undo records its intent before effects and retains completion in the original history entry. Restart does not run pending undos automatically: inspect the saved versions and explicitly resume the same entry. Receipt retries preserve later human edits; unresolved undo intents are excluded from history pruning.

Chat now applies `chat.budget` from the existing product configuration: `modelCalls` (default 12), `tokens` (160,000), `durationMs` (180,000), and the provider's shared reasoning/answer ceiling `generationTokens` (16,384). Capability probes, context summarization, tool-driven analysis, answer generation and post-turn memory all spend that run's allowance. A nested analysis retains its tighter local bounds while charging the parent as well. Memory is best-effort within the remaining allowance and never delays the completed answer. Foreground socket events expose `turn:usage`; resumable `chat:usage` records retain cumulative accounting for the answer and memory phases under one `runId`. Phase snapshots are cumulative: do not add them together. Missing provider usage stays a charged reservation estimate, and aggregate completion counts are never labeled visible-answer tokens. Budget exhaustion blocks further model dispatch and checks again before domain effects. Existing configuration files receive bounded defaults in memory; their bytes are not rewritten at startup.
