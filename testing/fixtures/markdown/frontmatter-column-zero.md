---
# Keep this leading comment exactly.
title: "Quoted title" # Keep this trailing comment.
aliases:
- alpha
- 'beta value'
flow: [one,two, "three words"] # Deliberately compact.
created: 2026-08-29
literal: |-
  First literal line.
  Second literal line with # text.
folded: >
  First folded line.
  Second folded line.
anchored: &shared 'anchored value'
copied: *shared
status: 'draft' # This is the scalar the tests replace.
---
# Fixture body

The body must remain byte-identical.
