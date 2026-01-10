# Faye Report
status: complete
commit: pending

## did
- src/ui/sidebar/components/QuickActions.tsx:145-169: Changed Summary and Tasks actions from sendToChat() to triggerAgent() with taskType "analyze"
- src/ui/sidebar/components/QuickActions.tsx:71-92: Updated interface and function comments to reflect all 6 actions are now agentic
- src/ui/sidebar/App.tsx:482-500: Removed synchronous activeAgents add from triggerAgenticAction()
- src/ui/sidebar/App.tsx:337-370: Modified "running" case in agent:task-update handler to add agents if not exists (single source of truth)

## verify
typecheck: pass
build: pass

## issues
none
