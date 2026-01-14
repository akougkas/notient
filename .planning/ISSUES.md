# Known Issues

Issues discovered during development. Track and fix as needed.

---

## Active Issues

### ProfileManager EISDIR Error
**Status**: Minor, non-blocking
**Error**: `Failed to load profile: Error: EISDIR: illegal operation on a directory, read`
**Cause**: Profile directory exists but `profile.json` file doesn't
**Impact**: Profile features won't work until first profile creation
**Fix**: Add defensive check in ProfileManager.load() to create file if missing

### obsidian-file-color Plugin Error
**Status**: External plugin, not our bug
**Error**: `Cannot convert undefined or null to object at Object.entries`
**Impact**: None to Notient

---

## Resolved This Session (2026-01-14)

### ✅ SQLite Migration "no such table"
**Fixed**: `e7ca9eb` - Split DDL + strip comments before execution
**Cause**: sql.js `prepare()` expects single statements, multi-statement DDL failed silently

### ✅ Path Doubling in DB Save
**Fixed**: `6f83b30` - Use vault-relative paths for Obsidian adapter
**Cause**: FileSystemAdapter prepends vault root, absolute paths caused doubling

### ✅ Sidebar Stuck Spinning
**Fixed**: `90cabd3` - Added init:state-changed event subscription
**Cause**: UI signal never updated from InitStateMachine events

### ✅ 22 Lint Warnings
**Fixed**: Multiple commits via parallel agents
**Cause**: Legacy `any` types and cognitive complexity

---

*Last updated: 2026-01-14 Session 4*
