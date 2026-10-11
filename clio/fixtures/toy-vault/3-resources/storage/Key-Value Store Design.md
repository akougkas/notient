---
title: Key-Value Store Design
type: concept
status: evergreen
value: gold
tags:
- concept
- database
- lsm
- storage
aliases:
- KV Design
- Storage Engine Principles and LSM Trees
- Storage Engines
- duplicate-storage-principles
created: 2026-08-15 11:00
updated: 2026-09-24 15:18
---
# Key-Value Store Design

Fundamental architectural patterns for modern embedded and distributed key-value storage engines.

## LSM-Tree Architecture
1. **MemTable:** In-memory write buffer (Skiplist or RB-Tree).
2. **Write-Ahead Log (WAL):** Sequential log guaranteeing durability across crashes.
3. **SSTables (Sorted String Tables):** Immutable on-disk sorted runs organized into hierarchical levels.
4. **Compaction:** Background merge-sort process reclaiming deleted keys and bounding read amplification.

Popular implementations include RocksDB, LevelDB, and Speedb.

---

## Merged from [[duplicate-storage-principles]]
*Merged on 2026-09-24 15:18*

# Storage Engine Principles and LSM Trees

A comprehensive look at log-structured merge-trees (LSM-trees) and B-trees for persistent key-value storage.

LSM-trees optimize write throughput by converting random I/O into sequential log appends (SSTables), followed by background compaction. Used in RocksDB, LevelDB, and modern flash-optimized engines.
