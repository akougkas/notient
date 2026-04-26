import initSqlJs, { type Database as SqlDatabase } from "sql.js";
import { CURRENT_VERSION, applyMigrations } from "./migrations";

export interface DatabaseAdapter {
  readBinary(path: string): Promise<ArrayBuffer | null>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
}

export interface DatabaseConfig {
  dbPath: string;
  wasmPath: string;
}

export class Database {
  private db: SqlDatabase | null = null;
  private dirty = false;

  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly config: DatabaseConfig,
  ) {}

  async init(): Promise<void> {
    const wasmBinary = (await this.adapter.readBinary(this.config.wasmPath)) ?? undefined;
    if (!wasmBinary) {
      throw new Error(`sql.js wasm missing at ${this.config.wasmPath}`);
    }
    const SQL = await initSqlJs({ wasmBinary });
    const existing = await this.adapter.readBinary(this.config.dbPath);
    this.db = existing ? new SQL.Database(new Uint8Array(existing)) : new SQL.Database();
    applyMigrations(this.db);
    if (!existing) {
      await this.persist();
    }
  }

  run(sql: string, params: unknown[] = []): void {
    this.requireDb().run(sql, params as never);
    this.dirty = true;
  }

  exec(sql: string): { columns: string[]; values: unknown[][] }[] {
    return this.requireDb().exec(sql);
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.requireDb().prepare(sql);
    try {
      stmt.bind(params as never);
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  transaction<T>(fn: () => T): T {
    this.requireDb().run("BEGIN;");
    try {
      const result = fn();
      this.requireDb().run("COMMIT;");
      this.dirty = true;
      return result;
    } catch (error) {
      try {
        this.requireDb().run("ROLLBACK;");
      } catch {
        // ignore — primary error wins
      }
      throw error;
    }
  }

  async persist(): Promise<void> {
    if (!this.dirty && (await this.adapter.readBinary(this.config.dbPath))) return;
    const data = this.requireDb().export();
    const buffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
    await this.adapter.writeBinary(this.config.dbPath, buffer);
    this.dirty = false;
  }

  async close(): Promise<void> {
    if (this.db && this.dirty) {
      await this.persist();
    }
    this.db?.close();
    this.db = null;
  }

  version(): number {
    const rows = this.query<{ version: number }>("SELECT version FROM schema_version;");
    return rows[0]?.version ?? 0;
  }

  static get currentSchemaVersion(): number {
    return CURRENT_VERSION;
  }

  private requireDb(): SqlDatabase {
    if (!this.db) throw new Error("Database not initialized. Call init() first.");
    return this.db;
  }
}
