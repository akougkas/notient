# Notient 0.2.0 mid-development checkpoint

Saved September 27, 2026 at Anthony's explicit request to stop development, stop all Notient servers and daemons, commit the work, and resume later. This is a state snapshot, not a release declaration or a competing plan.

## Read before resuming

Read root AGENTS.md and root SPRINT.md. SPRINT.md remains the sole active plan and is intentionally gitignored; its complete scope and detailed observations remain in this workspace. If it is missing in a different checkout, obtain it from Anthony. Do not reconstruct the release scope from historical docs.

Owner rules: no docs changes, added code comments, testing suites, CI or development gates. Preserve contributions already present. Use direct bounded interactions and useful build/typecheck. Product permissions, evidence, review and recovery remain mandatory. TUI/CLI/MCP are the primary release experience; the latest Obsidian work is a companion refinement.

## Stopped state

All 26 discovered Notient daemons, their 26 owned SurrealDB children, and one leftover Notient CLI client were sent SIGTERM and exited. Process inspection found none of those PIDs remaining. The original vault socket was removed. No project dev server was found beyond these runtimes. Development must remain stopped until Anthony resumes it.

Original vault: C:\Users\akougk\Projects\vaultex, available as /mnt/c/Users/akougk/Projects/vaultex. Its runtime directory is /home/akougkas/.notient/6753164dc88bb99b. Last daemon served localhost:45861, but this is stopped and the next endpoint must be rediscovered. Background cultivation was directly observed paused before shutdown. Keep it paused when resuming unless Anthony changes the scope.

The installed Obsidian plugin remains in the vault's .obsidian/plugins/notient directory. It will be disconnected while the daemon is stopped. Existing paired credentials remain private in their existing storage; do not print, commit or recreate them casually. The selected conversation before shutdown was c6d1d7255f73014e, with zero draft length and no active send.

## Current implementation and observations

The existing work tree includes the broader Sentient Notes transformation: note-resident intelligence and evidence, contribution assessment, feedback/reconsideration, adaptive bounded cultivation, methodology selection and proposals, reviewed structural operations, persistent TUI conversation, CLI/MCP operations, and typed HTTP/SDK chat. This checkpoint does not independently establish every release requirement as complete. SPRINT.md records the actual observations and unresolved gaps.

The original vault's bounded Tier 1/2 awaken completed 897/897 notes with zero failures. Its 16,061 chunks had Mini vectors with zero missing vectors or embedding errors. Background cultivation remained paused. A prior direct semantic read returned five current-revision hits. The earlier Tier 3 aggregate discrepancy, 75 versus 76, remains unexplained at the per-note level; do not invent an attribution.

Latest Obsidian implementation:

- src/api/surfaces.ts validates actual retrieval/excerpt/graph results and projects evidence, returned-note locations and relationship maps using stable tool call IDs. It retains stale/incomplete qualifications and does not derive executed actions or counts from assistant prose.
- integrations/obsidian/src/surfaceViews.ts renders bounded native DOM/SVG surfaces, exact passage copying/expansion and source controls, a lazy returned-note folder tree, directed map arrows and explicit relationship states. Hidden extra results and source controls are constructed when opened.
- integrations/obsidian/src/chat.ts integrates one orb, persistent history, an outlined bottom composer, keyed historical messages and live surfaces, ordinary activity disclosures, visible errors/approvals, copying/selection, keyboard access and slash commands. /search and /connections use the same native views without inference.
- presence.ts and styles.css provide the warm clay/parchment/sage identity, a 140px resting orb and 44px docked orb, ambient motion and bounded arrival reveals. Ordinary working status is visually quiet but accessible to screen readers. Hidden-window, reduced-motion and user-pause behavior are implemented. Restored history does not receive arrival reveals.
- replyBuffer.ts paints buffered text at 60fps, handles hidden/reduced-motion flush and Unicode surrogate boundaries, and bounds final draining to approximately 900ms. There is no new measurement establishing 120Hz content-stream rendering.

Opus in the existing left Claude Code pane implemented presence/styling. Provider retries delayed it; root completed the shared projections, native renderer and chat integration. Its task is done. No further delegation should automatically continue from this checkpoint.

Direct native Windows observations: at 420px, one 140px resting orb, composer width about 386.5px, no horizontal overflow, working ambient-motion pause, and Tab completion of /sea to /search. Full answer and passage clipboard copies were exact, with visible Copied feedback. The returned-note tree exposed eight real paths. Incoming tool results preserved historical DOM and selection.

A real turn through the composer completed in 6480ms with vault.list_neighbors and five arrowed authored connections. Its live surface nodes survived finalization, three user articles matched three saved user turns, and no error was reported. This interaction used the current attached ToDos note; it is not a fresh article-grounding demonstration. Independent observation views preserved the user's selected conversation/draft and restored clipboard, focus and background throttling. Local /connections returned five edges; /search agentic organization returned eight notes and native evidence/locations surfaces without inference.

The live-source demo is stored in the vault at Notient/conversations/2026-09-27 notient-canvas-live-source-demo dad8db.md. The older real search/read fixture is Notient/conversations/2026-09-27 notient-demo-grounded-connections 2aa2ca.md. Conversation history contains genuine model failures as well as successful execution; do not rewrite it into a success narrative.

Root and companion typechecks passed during implementation, and the companion built successfully. No testing suites were run in the latest engineering work. Existing dirty testing/docs changes from earlier work are preserved in the requested all-work checkpoint commit, not rewritten or endorsed as new requirements.

## Local deliverables and recovery

Installed companion main.js was 1,046,577 bytes and all three installed files matched integrations/obsidian/dist. The latest local package directory is artifacts/notient-0.2.0-local-crqvj2wj, containing the core tarball, companion ZIP, OpenAPI and version files. All four checksum entries passed after the companion refresh. The core tarball and OpenAPI were not regenerated for the UI-only changes. Build outputs/artifacts remain ignored local files.

Native screenshots are artifacts/notient-native-canvas/quiet.png and connections.png. The earlier standalone canvas motion study is artifacts/notient-canvas-study.html; it is a recorded-response study, not live inference.

Previous companion rollback files are /tmp/notient-companion-canvas-8holcfr7. Older vault/activation backups and disposable methodology vaults are referenced in SPRINT.md. Temporary observation scripts and copied results were removed. Do not delete vault runtime databases, paired secrets or recovery records when restarting.

## First work after explicit resume

1. Re-read SPRINT.md and inspect the working tree and current vault config. Confirm background pause and actual inference availability without reconfiguring homelab services.
2. Start only the necessary original-vault daemon, using the existing private vault env. Current local entry point is bun --env-file=/mnt/c/Users/akougk/Projects/vaultex/.notient/.env dist/daemon.js --vault /mnt/c/Users/akougk/Projects/vaultex. Rebuild source if required for the intended work, rediscover the endpoint, and reconnect the existing Obsidian pairing. Do not restart the 25 disposable experiment daemons by default.
3. Prioritize methodology reasoning: inspect the supplied context and dense prompt for the missed shared reporting practice, then demonstrate a useful model-generated convention through reviewed note retention and separate guarded settings activation. Do not repeatedly rerun unchanged inputs or invent a positive convention.
4. Reconcile the full agreed sprint outcomes against implementation and direct observations; complete remaining representative bounded cultivation and integration limits. The release is not complete.

The canvas is runtime-grounded tool-to-surface composition. Arbitrary model-authored layout planning remains future refinement. Model action provenance is also unresolved: one 4164ms probe claimed a search without executing tools; a changed-input correction produced a real search in 6654ms. A corrected example does not establish general reasoning reliability.
