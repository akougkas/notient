---
title: Obsidian Syntax
aliases:
  - obsidian
  - syntax
tags:
  - fixture
  - markdown
cssclasses:
  - wide
created: 2026-04-29
notient:
  contradicts:
    - "[[disputed]]"
---

# Obsidian Syntax

Status:: active
Rating:: 9

## Tasks

- [ ] buy milk
- [x] ship the writeback
- plain bullet with 5 * 3 and $a_i$ math
- [ ] nested field [Priority:: high] inline

## Callouts

> [!note] Plain note
> Body of the note callout.

> [!warning]- Collapsed warning
> Careful with `5 * 3` and \*literal asterisks\*.

> Not a callout, just a quotation.

## Math and escapes

Inline math $a_i + b_j$ stays intact, as does 5 * 3 and a literal \* star.

$$
\sum_{i=0}^{n} a_i
$$

## Deep headings

#### H4 Heading

Content under H4.

##### H5 Heading

Content under H5.

###### H6 Heading

Content under H6.

## Dataview

Due:: 2026-05-01
(Owner:: anthony)

```
Fenced:: not-a-field
- [ ] not a real task
```

## Related

- [[ExistingOne]]
