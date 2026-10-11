---
title: "H5IQ Intelligent Engine"
status: active
type: project
tags: [project, storage, hdf5, ai]
created: "2026-09-20 14:00"
---

# H5IQ: The Intelligent HDF5 Engine

H5IQ is a next-generation scientific I/O middleware that combines semantic indexing, local LLM metadata extraction, and asynchronous storage tiering for large-scale scientific datasets.

## Architecture
- Storage backend interfaces with [[Key-Value Store Design]] for chunk metadata.
- Leverages [[SPDK NVMe-oF]] for sub-millisecond remote block access.
- Connected to [[IOWarp]] for distributed data orchestration.
