---
title: SPDK NVMe-oF Quickstart Guide
source: https://spdk.io/doc/nvmeof.html
created: 2026-09-24 10:05
tags:
- storage
- systems
- architecture
- hpc
value: silver
lifecycle: active
vitality: 85.0
vitality_updated: '2026-09-24'
summary: A technical overview of SPDK and NVMe-oF technologies designed for high-speed, user-mode, polled-mode storage networking.
suggested_folder: 3-resources/storage
permanence: permanent
themes:
- High-speed I/O
- Storage Infrastructure
areas: research
processed: '2026-09-24'
related:
- '[[H5IQ Intelligent Engine]]'
- '[[IOWarp]]'
---
# SPDK NVMe-oF Quickstart Guide

Storage Performance Development Kit (SPDK) provides a set of drivers and libraries for fast, user-mode, polled-mode storage applications.

NVMe-over-Fabrics (NVMe-oF) extends NVMe storage networking over RDMA and TCP fabrics, eliminating kernel context switches and interrupts.

## Storage Integration
This technology forms the foundation for our high-speed I/O layer in [[IOWarp]].
We should explore hardware integration with [[SPDK NVMe-oF]] controllers on Dynamo.