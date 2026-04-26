import type { Database } from "sql.js";
import { SCHEMA_V1 } from "./schema";

export const CURRENT_VERSION = 1;

export function applyMigrations(db: Database): number {
  db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);");
  const result = db.exec("SELECT version FROM schema_version LIMIT 1;");
  const current = result[0]?.values[0]?.[0] as number | undefined;
  const startFrom = current ?? 0;

  if (startFrom < 1) {
    for (const stmt of SCHEMA_V1) {
      db.run(stmt);
    }
    if (current === undefined) {
      db.run("INSERT INTO schema_version (version) VALUES (?);", [CURRENT_VERSION]);
    } else {
      db.run("UPDATE schema_version SET version = ?;", [CURRENT_VERSION]);
    }
  }

  return CURRENT_VERSION;
}
