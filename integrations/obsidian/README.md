# Notient for Obsidian desktop

Version 0.1.0, released with Notient 0.1.0. It installs from the release ZIP and is
not in the Obsidian community directory.

Requires Obsidian **1.11.4 or newer**, a Notient daemon, and an explicit pairing.
The plugin uses supported Secret Storage, workspace/editor, Markdown rendering,
and CodeMirror extension APIs. It never reads a Linux token file from Windows.

From the repository:

```sh
bun install --frozen-lockfile
bun install --cwd integrations/obsidian --frozen-lockfile
bun run typecheck:obsidian
bun run build:obsidian
```

Copy `dist/main.js`, `dist/manifest.json`, and `dist/styles.css` from this package
into the selected vault's `.obsidian/plugins/notient/`, then enable Notient in
Obsidian's Community plugins settings. Keep the containing directory named
`notient`. These artifacts are local development builds, not a directory approval
or published release.

Create a pairing from the terminal for that same vault:

```sh
notient pair create --vault /path/to/vault --label "Obsidian desktop" \
  --kind human --scopes read,write,host
```

Enter its endpoint, vault identity and single-use code in Settings → Notient.
For Windows Obsidian and a WSL daemon, use the printed localhost endpoint and
select the corresponding Windows vault. The plugin verifies a local note against
the daemon and saves the Windows path mapping in device-local Obsidian storage;
the scoped token goes into Obsidian Secret Storage.

Settings also provides workflow preferences and background pause/resume. To save
these administrative permissions, deliberately include `admin` in a human pairing's
scopes (`read,write,host,admin`). Read/write/host pairings can use the workspace and
review notes without granting configuration authority. The plugin does not upgrade
its own permissions. Connection details collapse after pairing; workflow controls
cover scopes, schedules, resources, allowed effects and family-specific options.
Changes are reviewed before saving, and new installations enable no background AI.

The current sidebar follows the active saved note, shows its properties/outline,
previews all seven configured workflows, searches saved evidence, opens exact
source selections, inspects jobs and reviews stored suggestions with source evidence, exact Markdown,
human approve/reject decisions and partial application receipts. Unsaved editor
content is distinguished from the saved revision. Workflow previews do not apply
authored-note changes.

**Ask** gives grounded answers with exact source passages. **Write** captures
Markdown with a device-local recoverable draft, a native rendered preview and an
explicit save through the daemon's change/history authority. Use **Capture a
thought** or **Capture the selected text** from the command palette; selection
capture copies text without changing the editor. Ctrl/⌘ Enter reviews a draft.
Writing works offline; review/save requires the paired daemon. Interrupted saves
retain the original review and idempotency key for an explicit retry.

Four selection commands work on a passage selected in a saved note, from the
command palette or the editor's context menu: **Ask about selection**, **Brief
from selection**, **Find connections for selection** and **Propose an edit to the
selection**. The selection is bound to the saved revision it came from. With no
selection, or with unsaved edits, the command explains why it cannot run. A
proposed edit is only ever an exact preview in Review, and a note that changed
after the selection is a conflict instead of a silent recompute.

Connected editors veto writes to dirty buffers. Clean editors are briefly protected
against ordinary typing while a daemon filesystem change finishes; Obsidian's
normal external-file synchronization remains active. A disconnect retains any
pending guard until an authenticated reconnection confirms its outcome. Disabling
the plugin does not silently remove the daemon's protection: reconnect it, or use
`notient pair list` and `notient pair revoke --id …` to deliberately release that
pairing. Read-only daemon access remains available during deferred write recovery.

Remaining N07 work includes selection-scoped workflows and broader host
validation. Do not treat this build as
full plugin acceptance.

Run `bun run release:prepare` from the repository root to prepare the local
development ZIP alongside the CLI tarball under the root `artifacts/` directory.
Unzip its `notient/` folder into `.obsidian/plugins/`. Actual Windows Obsidian
1.13.7 / WSL validation uses a disposable vault: native rendering and navigation,
unsaved-buffer protection, reviewed creation/rejection and daemon restart recovery.
This does not establish complete N07 acceptance or a published plugin release.
