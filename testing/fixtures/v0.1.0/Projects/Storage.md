---
aliases: [Storage plan, Durable context]
tags: [systems, design/storage]
reviewed: false
owner: Ada
---
# Storage

The 2026 storage service keeps three replicas. ^replicas

## Decision
Use local Markdown as the authored record.

## Decision
Derived indexes can be rebuilt; approvals must be retained.

> [!warning] Recovery
> Index rebuilds do not restore human decisions.

- [ ] Test offline recovery
- [x] Preserve note bytes

See [[History/Storage#Policy|previous policy]] and [[Projects/Storage#^replicas]].
![[Attachments/topology.svg]]
[Recovery](../Inbox/Recovery.md#Checklist)

```md
# Not an outline entry
[[Fake]] #not-a-tag ^not-a-block
```

#durability
