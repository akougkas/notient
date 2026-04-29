import type { Database } from "sql.js";
import { SCHEMA } from "./schema";

export function applySchema(database: Database): void {
  for (const statement of SCHEMA) database.run(statement);
}
