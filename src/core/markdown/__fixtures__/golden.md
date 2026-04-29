---
title: Golden Fixture
tags:
  - testing
  - markdown
related: "[[other-note]]"
notient:
  contradicts:
    - "[[contradicting]]"
---

# Heading One

Top paragraph with a [[plain-link]] and an aliased [[other|alias label]] link.

## Heading Two

Paragraph with heading qualifier [[note#Section Title]] and block qualifier [[note#^para-1]]. ^anchor-id

### Heading Three

An embed: ![[embedded-note]]

A list with a tag and a block id:

- First item with #concept tag
- Second item ^list-item-id
- Third item with nested #concept/auth/oauth

#### Heading Four (rolls into H3)

Content under H4 belongs to the H3 ancestor block.

##### Heading Five (also rolls in)

```
Code block with [[not-a-link]] and #not-a-tag inside.
```

A paragraph with `inline code [[also-not-a-link]]` should not parse.

###### Heading Six

Plain text after H6.
