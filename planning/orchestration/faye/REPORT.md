# Faye Report
status: complete
commit: 1082ad4

## did
- src/ui/sidebar/context/KernelContext.tsx:73-96: Rewrote useService hook
  - Added useState to hold service reference (lazy init with kernel.getService)
  - Added useEffect to subscribe to "services:initialized" event
  - On event: re-fetches service from kernel, setService triggers re-render
  - Callbacks with service deps now get fresh refs after init

## verify
typecheck: fail (pre-existing error in taskQueue.ts:398 - Archie's domain)
build: pass

## issues
- taskQueue.ts:398 has uncommitted changes that made `agent` nullable but missed a null check in `executeTask()`. This blocks typecheck but is not Faye's code.
