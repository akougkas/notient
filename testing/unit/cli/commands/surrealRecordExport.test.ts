import { describe, expect, test } from "bun:test";
import { writeRecordsOnlyExport } from "../../../../src/cli/commands/surrealRecordExport";
import { BACKUP_TABLES, RESTORE_EMPTY_TABLES } from "../../../../src/core/db/backupTables";

const RULE = "-- ------------------------------";

function fixtureExport(tables: readonly string[] = BACKUP_TABLES): string {
  return [
    `${RULE}\n-- OPTION\n${RULE}\n\nOPTION IMPORT;\n`,
    ...tables.map(
      (table) =>
        `\n${RULE}\n-- TABLE: ${table}\n${RULE}\n\nDEFINE TABLE ${table};\n\n${RULE}\n-- TABLE DATA: ${table}\n${RULE}\n\nINSERT [ { id: ${table}:one, text: 'value; DEFINE ACCESS fake' } ];\n`,
    ),
  ].join("");
}

function chunkedStream(text: string, width: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += width) {
        controller.enqueue(bytes.slice(offset, offset + width));
      }
      controller.close();
    },
  });
}

async function filter(text: string, width = 17): Promise<string> {
  let result = "";
  await writeRecordsOnlyExport(chunkedStream(text, width), {
    write: async (chunk) => {
      result += chunk;
    },
  });
  return result;
}

describe("writeRecordsOnlyExport", () => {
  test("keeps every allowlisted record section and strips table definitions", async () => {
    const result = await filter(fixtureExport(), 3);

    expect(result).toStartWith("OPTION IMPORT;\n\nBEGIN TRANSACTION;\n");
    expect(result).toContain("THROW 'notient_restore_target_not_empty'");
    for (const table of RESTORE_EMPTY_TABLES) {
      expect(result).toContain(`SELECT id FROM ${table} LIMIT 1`);
    }
    expect(result).toEndWith("\nCOMMIT TRANSACTION;\n");
    expect(result).not.toMatch(/(?:^|\n)\s*DEFINE TABLE/m);
    for (const table of BACKUP_TABLES) {
      expect(result).toContain(`-- TABLE DATA: ${table}`);
      expect(result).toContain(`id: ${table}:one`);
    }
  });

  test("refuses an unselected or missing table section", async () => {
    const unselected = `${fixtureExport()}\n${RULE}\n-- TABLE: agent_session\n${RULE}\n\nDEFINE TABLE agent_session;\n\n${RULE}\n-- TABLE DATA: agent_session\n${RULE}\n\nINSERT [ { id: agent_session:one } ];\n`;
    await expect(filter(unselected)).rejects.toThrow("unselected table 'agent_session'");
    await expect(filter(fixtureExport(BACKUP_TABLES.slice(1)))).rejects.toThrow(
      "omitted selected table data",
    );
  });
});
