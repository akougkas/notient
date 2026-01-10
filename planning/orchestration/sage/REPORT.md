# Sage - Phase 3 Simplification Report

> **Status**: COMPLETE
> **Last Updated**: 2026-01-10
> **Reviewing**: Phase 3 Intelligence Tag-Sharding

---

## Summary

Simplified the Phase 3 intelligence tag-sharding code across 2 files. Replaced deeply nested ternary operators with explicit if-else chains in helper methods. Streamlined utility functions. All functionality preserved, typecheck and build pass.

**Lines Changed**: ~35 lines refactored for clarity

---

## Simplifications Made

| File | Before | After | Change |
|------|--------|-------|--------|
| `noteIntelligence.ts` | 5-level nested ternary for freshness | `scoreFreshness()` with if-chain | +8 lines, readable |
| `noteIntelligence.ts` | 5-level nested ternary for connectivity | `scoreConnectivity()` with if-chain | +10 lines, readable |
| `noteIntelligence.ts` | 4-level nested ternary for structure | `scoreStructure()` with if-chain | +6 lines, readable |
| `noteIntelligence.ts` | 4-level nested ternary for metadata | `scoreMetadata()` with if-chain | +6 lines, readable |
| `intelligenceDb.ts` | Unused `notePath` parameter | Prefixed with `_` | Convention fix |
| `intelligenceDb.ts` | Manual loop for totalRecords | `Array.reduce()` | -2 lines, idiomatic |

---

## Patterns Cleaned

### 1. Nested Ternaries to Explicit If-Chains

**Before**: Dense nested ternary (hard to read thresholds)
```typescript
const freshness = days <= 7 ? 100 : days <= 30 ? 75 : days <= 90 ? 55 : days <= 180 ? 35 : 20;

const connectivity =
  totalLinks >= 12
    ? 100
    : totalLinks >= 6
      ? 80
      : totalLinks >= 2
        ? 55
        : totalLinks === 1
          ? 40
          : 15;
```

**After**: Explicit helper methods with clear thresholds
```typescript
private scoreFreshness(days: number): number {
  if (days <= 7) return 100;
  if (days <= 30) return 75;
  if (days <= 90) return 55;
  if (days <= 180) return 35;
  return 20;
}

private scoreConnectivity(notePath: string): number {
  const backlinks = this.linkStats?.backlinks.get(notePath) ?? 0;
  const outlinks = this.linkStats?.outlinks.get(notePath) ?? 0;
  const totalLinks = backlinks + outlinks;

  if (totalLinks >= 12) return 100;
  if (totalLinks >= 6) return 80;
  if (totalLinks >= 2) return 55;
  if (totalLinks === 1) return 40;
  return 15;
}
```

**Rationale**:
- Each threshold is on its own line
- Easy to adjust scoring brackets
- Self-documenting function names
- Easier to debug

### 2. Unused Parameter Convention

**Before**: Unused parameter without indication
```typescript
private getTopicForNote(notePath: string, noteTags: string[]): string {
  if (noteTags.length === 0) {
    return "_uncategorized";
  }
```

**After**: Underscore prefix signals intentional non-use
```typescript
private getTopicForNote(_notePath: string, noteTags: string[]): string {
  if (noteTags.length === 0) return "_uncategorized";
```

### 3. Idiomatic Reduce Over Manual Loop

**Before**: Verbose accumulator loop
```typescript
let totalRecords = 0;
for (const records of this.topics.values()) {
  totalRecords += records.size;
}
```

**After**: Functional reduce
```typescript
const totalRecords = Array.from(this.topics.values()).reduce(
  (sum, records) => sum + records.size,
  0,
);
```

---

## What Was NOT Changed

### types.ts (lines 79-104)
The `IntelligenceTopicFile` and `IntelligenceMeta` interfaces are clean and minimal. No simplification needed.

### intelligenceDb.ts - Overall Structure
The class is well-organized with clear separation:
- Public methods (load, get, upsert, delete, flush, export)
- Private methods (scheduleSave, saveTopicFile, saveMetaFile)
- Legacy migration (checkAndMigrateLegacy, migrateLegacyFile)

No unnecessary abstractions or over-engineering detected.

---

## Verification Results

- [x] `bun run typecheck` passes
- [x] `bun run build` passes (551.2kb main.js)
- [x] No changes to public API signatures
- [x] Health scoring algorithm identical (just restructured)

---

## Files Modified

1. `/home/akougkas/projects/notient/src/core/intelligence/noteIntelligence.ts`
   - Lines 377-439: Extracted 4 scoring helper methods from `computeHealth()`

2. `/home/akougkas/projects/notient/src/core/intelligence/intelligenceDb.ts`
   - Line 239: Added underscore to unused `notePath` parameter
   - Lines 291-308: Replaced manual loop with reduce

---

## Design Notes

The scoring helper methods could be static or even extracted to a separate module if health scoring needs to be reused elsewhere. For now, keeping them as private instance methods is appropriate since they depend on `this.linkStats`.

---

## Previous Report (Phase 2)

See git history for Phase 2 simplification details (chunk/embedding separation).
