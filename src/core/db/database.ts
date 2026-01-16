/**
 * SQLite wrapper using sql.js
 * Source of truth: .planning/PHASE-GALAXY.md
 */

import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { SCHEMA_SQL } from "./schema";

/**
 * Minimal adapter interface for file operations.
 * Compatible with Obsidian's DataAdapter (vault.adapter).
 */
export interface StorageAdapter {
  exists(path: string): Promise<boolean>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
}

/**
 * Configuration for database initialization.
 */
export interface DatabaseConfig {
  /** Path to the database file (relative to vault root) */
  dbPath: string;
  /** Path to sql-wasm.wasm (relative to vault root) */
  wasmPath: string;
}

/**
 * SQLite database wrapper with async init pattern.
 * Uses sql.js (WASM) for in-browser SQLite.
 */
export class Database {
  private db: SqlJsDatabase | null = null;
  private adapter: StorageAdapter | null = null;
  private config: DatabaseConfig | null = null;

  /**
   * Initialize the database.
   * Loads WASM, opens/creates DB file, applies schema.
   */
  async init(adapter: StorageAdapter, config: DatabaseConfig): Promise<void> {
    if (this.db) return;

    this.adapter = adapter;
    this.config = config;

    // Load WASM binary via adapter
    const wasmBuffer = await adapter.readBinary(config.wasmPath);
    const SQL = await initSqlJs({ wasmBinary: wasmBuffer });

    // Load existing DB or create new
    let buffer: ArrayBuffer | null = null;
    if (await adapter.exists(config.dbPath)) {
      buffer = await adapter.readBinary(config.dbPath);
    }

    this.db = new SQL.Database(buffer ? new Uint8Array(buffer) : undefined);

    // Enable foreign keys
    this.db.run("PRAGMA foreign_keys = ON;");

    // Apply schema (idempotent with IF NOT EXISTS)
    this.db.run(SCHEMA_SQL);
  }

  /**
   * Close the database and release resources.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.adapter = null;
    this.config = null;
  }

  /**
   * Save the database to disk.
   * Call after mutations to persist changes.
   */
  async save(): Promise<void> {
    if (!this.db || !this.adapter || !this.config) {
      throw new Error("Database not initialized");
    }

    const data = this.db.export();
    const buffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(buffer).set(data);
    await this.adapter.writeBinary(this.config.dbPath, buffer);
  }

  /**
   * Execute SQL that returns no results.
   * Use for CREATE, INSERT, UPDATE, DELETE statements.
   */
  exec(sql: string): void {
    if (!this.db) throw new Error("Database not initialized");
    this.db.run(sql);
  }

  /**
   * Execute parameterized SQL that modifies data.
   * Use for INSERT, UPDATE, DELETE with parameters.
   *
   * @param sql - SQL with ? placeholders
   * @param params - Parameter values in order
   */
  run(sql: string, params: unknown[] = []): void {
    if (!this.db) throw new Error("Database not initialized");
    this.db.run(sql, params as (string | number | Uint8Array | null)[]);
  }

  /**
   * Execute parameterized SQL and return first row.
   * Use for SELECT queries expecting one result.
   *
   * @param sql - SQL with ? placeholders
   * @param params - Parameter values in order
   * @returns First row as object, or undefined if no results
   */
  get<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): T | undefined {
    if (!this.db) throw new Error("Database not initialized");

    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as (string | number | Uint8Array | null)[]);
      if (stmt.step()) {
        return stmt.getAsObject() as T;
      }
      return undefined;
    } finally {
      stmt.free();
    }
  }

  /**
   * Execute parameterized SQL and return all rows.
   * Use for SELECT queries expecting multiple results.
   *
   * @param sql - SQL with ? placeholders
   * @param params - Parameter values in order
   * @returns Array of row objects
   */
  all<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): T[] {
    if (!this.db) throw new Error("Database not initialized");

    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as (string | number | Uint8Array | null)[]);
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }
}
