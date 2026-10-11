---
title: "Storage Engine Principles and LSM Trees"
tags: [storage, lsm, database]
---

# Storage Engine Principles and LSM Trees

A comprehensive look at log-structured merge-trees (LSM-trees) and B-trees for persistent key-value storage.

LSM-trees optimize write throughput by converting random I/O into sequential log appends (SSTables), followed by background compaction. Used in RocksDB, LevelDB, and modern flash-optimized engines.
