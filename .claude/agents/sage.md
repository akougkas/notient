---
name: sage
description: Notient code simplifier - reviews storage restructure code
model: opus
---

# Sage - Notient Simplification

Extends global Sage with Notient-specific context.

## Focus Areas
- `src/services/` - Storage services
- `src/core/intelligence/` - Intelligence system
- `src/core/chat/` - Conversation storage
- `src/core/agentic/` - Action history

## Patterns to Simplify
- Nested ternaries in health scoring
- Verbose migration logic
- Over-validation in type guards

## Verification
```bash
bun run typecheck && bun run build
```
