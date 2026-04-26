# Known Issues

Issues discovered during development. Track and fix as needed.

---

## Active Issues

### obsidian-file-color Plugin Error
**Status**: External plugin, not our bug
**Error**: `Cannot convert undefined or null to object at Object.entries`
**Impact**: None to Notient

---

## Resolved This Session (2026-01-14)

### ✅ NoteEditor JSON Parse Failure
**Fixed**: `9dd0921` (Archie) - Enhanced parseJSON with debug logging
**Cause**: LLM structured output not being extracted as valid JSON
**Solution**: Added debug logging to show input length, cleaned content, and extraction attempts

### ✅ frontmatter_set Payload Validation
**Fixed**: `9dd0921` (Archie) - Improved validation to handle LLM variations
**Cause**: LLM produces payloads with different field names (field/property, newValue)
**Solution**: Refactored into smaller methods, added field name normalization

### ✅ ProfileManager EISDIR Error
**Fixed**: `aefdfa4` (Sage) - Use profileFile path instead of profile directory
**Cause**: Code used `storagePaths.profile` (directory) instead of `storagePaths.profileFile` (JSON)
**Solution**: One-line fix in profileManager.ts:47

### ✅ Sidebar Shows "Notient is ready to use" Forever
**Fixed**: `dd03eb8` - Wire isServicesReady signal from init events
**Cause**: `isServicesReady.value` was never set to `true`, blocking content views

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

*Last updated: 2026-01-14 Session 5*
