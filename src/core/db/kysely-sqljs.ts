import { CompiledQuery, type DatabaseConnection, type Driver, type QueryResult } from "kysely";
import type { Database as SqlJsDatabase } from "sql.js";

export class SqlJsDriver implements Driver {
  readonly #db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.#db = db;
  }

  async init(): Promise<void> {
    // Nothing to do
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return new SqlJsConnection(this.#db);
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("BEGIN"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("COMMIT"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("ROLLBACK"));
  }

  async releaseConnection(_connection: DatabaseConnection): Promise<void> {
    // Nothing to do
  }

  async destroy(): Promise<void> {
    // Nothing to do
  }
}

class SqlJsConnection implements DatabaseConnection {
  readonly #db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.#db = db;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;

    // Bind parameters
    // sql.js exec takes sql string and optional params array/object
    // Kysely parameters are unknown[], sql.js expects valid bindable types

    // We use db.exec() for statements that return rows (SELECT) and those that don't (INSERT/UPDATE/DELETE)
    // BUT db.exec() returns generic objects.
    // db.prepare() + stmt.step() is more robust for binding.

    const stmt = this.#db.prepare(sql);
    try {
      // biome-ignore lint/suspicious/noExplicitAny: sql.js API needs explicit any or looser typing than Kysely
      stmt.bind(parameters as any[]);

      const rows: R[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as unknown as R);
      }

      // Check for changes (INSERT/UPDATE/DELETE)
      // sql.js doesn't easily give "rows affected" or "insertId" directly from stmt object in a standardized way matching Kysely expectations for all cases without some tricks.
      // But for SELECT, we have rows.

      // For INSERT, we might need `db.run(sql, params)` which returns void but might update `db.getRowsModified()`.
      // Actually `stmt.run()` is alias for `bind` + `step`.

      // Let's use low-level execution for better control if needed, but `getAsObject` is convenient.

      // To get numUpdatedOrDeletedRows:
      // sql.js doesn't track this per statement easily unless we use `db.getRowsModified()` immediately after?
      // Documentation says `db.getRowsModified()` returns the number of rows modified by the last statement.

      const numAffected = this.#db.getRowsModified();

      // To get insertId (last_insert_rowid):
      // We can run `SELECT last_insert_rowid()` or generic approach.
      // Kysely expects `insertId` on result.

      let insertId: bigint | undefined;
      if (sql.trim().toUpperCase().startsWith("INSERT")) {
        // This is a bit hacky, but sqlite has `last_insert_rowid()`
        const idRes = this.#db.exec("SELECT last_insert_rowid() as id")[0];
        if (idRes?.values[0]) {
          insertId = BigInt(idRes.values[0][0] as number);
        }
      }

      return {
        rows,
        numAffectedRows: BigInt(numAffected),
        insertId,
      };
    } finally {
      stmt.free();
    }
  }

  // biome-ignore lint/correctness/useYield: Generator required by interface but strict mode forbids empty generator
  async *streamQuery<R>(
    _compiledQuery: CompiledQuery,
    _chunkSize: number,
  ): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("Streaming not supported by SqlJsDriver");
  }
}
