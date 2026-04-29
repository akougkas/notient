// PHASE-1-SHIM
//
// The real EchoGuard is gone. Phase 4 will replace its responsibility with the
// SurrealDB `daemon_write` table once the write-back AST lands. Until then,
// every consumer call site (~25 of them across the chat tools, inverters, the
// vitals service, the maturity advancer, the native graph bridge, and the
// daemon bootstrap) keeps compiling against this shim. The methods do nothing
// observable: `mark` discards its arguments and `take` always returns false.
// Phase 4 deletes this file AND every call site simultaneously.

export interface EchoGuardOptions {
  ttlMs?: number;
  maxEntries?: number;
}

export class EchoGuard {
  // biome-ignore lint/complexity/noUselessConstructor: PHASE-1-SHIM preserves the public constructor signature for ~25 consumer call sites; Phase 4 restores real initialization.
  constructor(_options: EchoGuardOptions = {}) {}

  mark(_path: string, _sha: string): void {
    // No-op until Phase 4 writes provenance to SurrealDB's daemon_write table.
  }

  take(_path: string, _sha: string): boolean {
    return false;
  }
}
