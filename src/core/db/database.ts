import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from "kysely";
import { type App, FileSystemAdapter } from "obsidian";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import type { StoragePaths } from "../../services/storagePaths";
import { migrateJsonToSqlite } from "./json-migration";
import { SqlJsDriver } from "./kysely-sqljs";
import { migrateToLatest } from "./migrations";
import type { Database } from "./schema";

export class DatabaseService {
  private _db: Kysely<Database> | null = null;
  private _sql: SqlJsDatabase | null = null;
  private adapter: FileSystemAdapter;
  private paths: StoragePaths;

  constructor(app: App, paths: StoragePaths) {
    const adapter = app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Notient requires desktop Obsidian with file system access");
    }
    this.adapter = adapter;
    this.paths = paths;
  }

  async init(): Promise<void> {
    if (this._db) return;

    // Initialize sql.js with WASM loaded via Obsidian adapter
    // (Obsidian blocks file:// URL fetches, so we read the binary directly)
    const wasmPath = `${this.paths.pluginRoot}/sql-wasm.wasm`;
    const wasmBuffer = await this.adapter.readBinary(wasmPath);
    const SQL = await initSqlJs({ wasmBinary: wasmBuffer });

    let buffer: ArrayBuffer | null = null;
    const dbPath = this.paths.dbFile;

    // Use Obsidian adapter for file operations
    if (await this.adapter.exists(dbPath)) {
      buffer = await this.adapter.readBinary(dbPath);
    }

    // Create DB instance (new or from buffer)
    this._sql = new SQL.Database(buffer ? new Uint8Array(buffer) : undefined);

    // Initialize Kysely
    this._db = new Kysely<Database>({
      dialect: {
        createAdapter: () => new SqliteAdapter(),
        // biome-ignore lint/style/noNonNullAssertion: Initialized before use
        createDriver: () => new SqlJsDriver(this._sql!),
        createIntrospector: (db) => new SqliteIntrospector(db),
        createQueryCompiler: () => new SqliteQueryCompiler(),
      },
    });

    // Run migrations
    await migrateToLatest(this._db);

    // Import legacy JSON data if needed
    await migrateJsonToSqlite(this._db, this.adapter, this.paths);
  }

  /**
   * Get the Kysely instance. Throws if not initialized.
   */
  get db(): Kysely<Database> {
    if (!this._db) throw new Error("Database not initialized");
    return this._db;
  }

  /**
   * Persist the database to disk via Obsidian adapter.
   */
  async save(): Promise<void> {
    if (!this._sql) return;
    const data = this._sql.export();
    // Create a proper ArrayBuffer copy (sql.js returns Uint8Array with ArrayBufferLike)
    const buffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(buffer).set(data);
    await this.adapter.writeBinary(this.paths.dbFile, buffer);
  }

  /**
   * Close the database.
   */
  close(): void {
    if (this._sql) {
      this._sql.close();
      this._sql = null;
    }
    this._db = null;
  }
}
