The Bun patch for `surrealdb@2.0.3` changes its CBOR string decoder to preserve
U+FEFF (`new TextDecoder("utf-8", { ignoreBOM: true })`). CBOR text strings
contain text, not a byte-order signature. The SDK's default decoder silently
removed an authored leading BOM from persisted before/after snapshots, breaking
durable note-write identity and recovery. Both ESM and CommonJS bundles receive
the same two-line correction. No storage format or existing history is migrated.

The real-SurrealDB durable-writer integration tests cover BOM/CRLF persistence,
structural edits, move history and retry after service reconstruction. The CLI
build bundles the corrected SDK. Keep this patch until an upstream SDK release
preserves CBOR strings and the same regression tests pass without it.
