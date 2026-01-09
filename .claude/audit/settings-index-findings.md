# Settings & Index Management Audit Findings

## Critical Issues (Blocking)

### 1. TYPE MISMATCH: getIndexedCount() called with await but is synchronous
- [ ] `await indexManager.getIndexedCount()` on non-async method | File: `src/ui/settings/SettingsTab.ts:776` | **Impact: Runtime bug**

```typescript
// Interface defines:
getIndexedCount(): number;  // NOT async

// But code does:
await indexManager.getIndexedCount()  // Wrong!
```

### 2. activeIndexMeta Intentionally Cleared on Load
- [ ] `mergeWithDefaults()` sets `activeIndexMeta: null` | File: `src/ui/settings/SettingsTab.ts:89-90` | **Impact: Lost metadata after reload**

```typescript
indexing: {
  ...DEFAULT_SETTINGS.indexing,
  ...data.indexing,
  // activeIndexMeta is derived at runtime, don't persist stale values
  activeIndexMeta: null,
},
```

---

## Implementation Gaps (Missing Features)

### 3. Missing Error Handling: Index Operations in IndexManagementPanel
- [ ] No error handling for switchToIndex, trimIndex, deleteIndexByPath, importIndex | File: `src/ui/settings/panels/IndexManagementPanel.ts` | **Impact: Silent failures**

Affected operations:
- Line 319: `await indexManager.switchToIndex(idx.path)` - No error handling
- Line 356: `await indexManager.trimIndex()` - Button disables but no error catch
- Line 382: `await indexManager.deleteIndexByPath(idx.path)` - Relies on notice fallback
- Line 435: `await indexManager.importIndex(text)` - No JSON validation

### 4. Button State Management Issues
- [ ] Button state lost when `onRefresh()` re-renders panel | File: `src/ui/settings/panels/IndexManagementPanel.ts:354-360` | **Impact: Flash back to normal**

```typescript
trimBtn.disabled = true;
trimBtn.textContent = "Trimming...";
const result = await indexManager.trimIndex();
this.onRefresh();  // Re-renders, button state lost
```

### 5. Unhandled Promise: autoFetchModels()
- [ ] Model fetches run without .catch() handler | File: `src/ui/settings/SettingsTab.ts:285-305` | **Impact: Silent failures**

### 6. Missing Validation for Profile Generation
- [ ] No validation that indexing completed before profile inference | File: `src/ui/settings/SettingsTab.ts:776` | **Impact: Inference from incomplete data**

### 7. Index Switching May Lose activeIndexMeta
- [ ] Settings updated but mergeWithDefaults resets activeIndexMeta to null on reload | File: `src/services/indexManager.ts:268-274` | **Impact: Lost cached metadata**

### 8. No UI for activeIndexPath
- [ ] No dropdown or input for changing activeIndexPath directly | File: `src/ui/settings/SettingsTab.ts` | **Impact: Index switching only via details view**

### 9. Chunk Size Change Has No Reindex Warning
- [ ] Changing chunkSize requires reindex but no warning shown | File: `src/ui/settings/SettingsTab.ts:683-742` | **Impact: User confusion**

### 10. ImportIndex No Dimension Compatibility Check
- [ ] Imported index dimension not validated against current model | File: `src/ui/settings/panels/IndexManagementPanel.ts:435` | **Impact: Dimension mismatch failures**

---

## Type Errors / Runtime Errors

### 11. Profile Modal Not Nullable
- [ ] `modal.run()` rejection not caught | File: `src/ui/settings/SettingsTab.ts:793` | **Impact: Button stuck disabled**

### 12. expandedPath State Not Cleared
- [ ] If index deleted while expanded, UI errors on re-render | File: `src/ui/settings/panels/IndexManagementPanel.ts:41` | **Impact: UI crash**

---

## Mock/Stub Code

### 13. listAvailableIndices() Returns Empty Array
- [ ] Method stubbed out and always returns `[]` | File: `src/services/indexManager.ts:689-692` | **Impact: Feature broken**

```typescript
listAvailableIndices(): string[] {
  // Legacy wrapper - deprecate later
  return [];
}
```

---

## Integration Issues

### 14. Profile Integration Not Verified
- [ ] `agent.setProfile()` called but no validation agent received it | File: `src/ui/settings/SettingsTab.ts:997-1004` | **Impact: Silent profile loss**

### 15. Settings Migration is NO-OP
- [ ] Only bumps version number, doesn't migrate fields | File: `src/ui/settings/SettingsTab.ts:119-123` | **Impact: Schema changes corrupt old settings**

### 16. Reconnect Button Hardcoded Delay
- [ ] 2-second delay arbitrary, may show stale status | File: `src/ui/settings/SettingsTab.ts:505` | **Impact: Misleading status**

### 17. validateSettings() Incomplete
- [ ] Missing validation for LM Studio host/model, PARA folders, index path | File: `src/ui/settings/SettingsTab.ts:125-153` | **Impact: Invalid configs accepted**

---

## Summary

| Category | Count | Severity |
|----------|-------|----------|
| Critical Issues | 2 | HIGH |
| Implementation Gaps | 8 | MEDIUM |
| Type/Runtime Errors | 2 | MEDIUM |
| Mock/Stub Code | 1 | MEDIUM |
| Integration Issues | 4 | MEDIUM |

**Total Issues:** 17

**Key Problems:**
- Silent failures during index operations
- Lost state after settings reload
- Profile changes may not propagate
- Type errors at runtime (await on non-promise)
