# Agentic UI Action Flows

This directory contains complete flow documentation for all agentic UI actions in Notient. Each file documents the end-to-end journey from user interaction to system completion.

## Quick Actions

These are the primary action buttons in the sidebar's Quick Actions section:

- **[Enhance](./note-enhance.md)** - Enrich and expand a note with additional context and insights
- **[Link](./note-link.md)** - Find and link related notes
- **[Move](./note-move.md)** - Suggest and move note to appropriate folder/category

## Intelligence Suggestions

These are AI-generated suggestions displayed in the Intelligence section:

- **[Add Tag](./intelligence-add-tag.md)** - Apply a suggested tag from intelligence
- **[Add Link](./intelligence-add-link.md)** - Apply a suggested link to another note
- **[Triage Action](./intelligence-triage.md)** - Apply inbox triage action (move/tag)

## Intelligence Actions

Actions triggered from the Intelligence section:

- **[Generate Summary](./generate-summary.md)** - Manually trigger summary generation for a note

## Metric Interactions

Clicking on note vitals metrics triggers analysis:

- **[Metric Click](./metric-click.md)** - Analyze health, links, or freshness metrics

## Commands

Text-based commands entered in the omnibar:

- **[Slash Commands](./slash-command.md)** - Bulk workflows: `/enrich`, `/link`, `/classify`
- **[Agent Commands](./agent-command.md)** - Direct agent tasks: `@chat`, `@search`

## Workflow Management

Actions for managing bulk workflows:

- **[Workflow Cancel](./workflow-cancel.md)** - Cancel an active or queued workflow

## Dashboard Actions

Actions available in the Dashboard view:

- **[Dashboard Review](./dashboard-review.md)** - Apply or dismiss actions from review queue

## Task Modal Actions

Actions available in the Task Modal:

- **[Task Modal Apply](./task-modal-apply.md)** - Apply a proposed action from task modal
- **[Task Modal Undo](./task-modal-undo.md)** - Undo a previously applied action

## Flow Structure

Each flow document follows this structure:

1. **Trigger** - User action that initiates the flow
2. **Agent Execution** - LLM calls, context retrieval, action generation
3. **UI Display** - How results are shown to the user
4. **Action Execution** - How proposed actions are applied
5. **Re-indexing** - Automatic background updates
6. **Intelligence Regeneration** - Background intelligence updates
7. **Completion** - Final state

## Common Patterns

### Agent Execution Pattern

Most agentic actions follow this pattern:

1. Task inference (determine task type)
2. Load current note
3. Search for context (RAG)
4. Build system prompt
5. Stream LLM response
6. Generate action plan (for agentic tasks)
7. Validate actions
8. Return result

### Action Application Pattern

All actions follow this pattern:

1. Trust evaluation
2. Validation
3. File read/modify
4. Write updated file
5. Record in action history
6. Trigger re-indexing
7. Regenerate intelligence

### Re-indexing Pattern

After any file modification:

1. File watcher detects change (debounced 5s)
2. Re-chunk note (TSI v2)
3. Re-embed chunks (Ollama)
4. Update vector store

### Intelligence Regeneration Pattern

After content changes:

1. Detect content/path hash mismatch
2. Regenerate summary (LLM)
3. Regenerate entities & tags (LLM)
4. Regenerate link suggestions (vector search)
5. Recalculate health score
6. Update intelligence DB

## Related Documentation

- [Note Journey Flowchart](../NOTE_JOURNEY_FLOWCHART.md) - Overall note lifecycle
- [AI Architecture](../AI_ARCHITECTURE.md) - System architecture details
- [PRD](../../planning/PRD.md) - Product requirements
