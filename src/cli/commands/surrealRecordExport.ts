import { BACKUP_TABLES, BACKUP_TABLE_SET, RESTORE_EMPTY_TABLES } from "../../core/db/backupTables";

const SECTION_RULE = "-- ------------------------------";
const DATA_PREFIX = `\n${SECTION_RULE}\n-- TABLE DATA: `;
const DATA_HEADER_SUFFIX = `\n${SECTION_RULE}\n\n`;
const NEXT_TABLE_PREFIX = `\n${SECTION_RULE}\n-- TABLE: `;

export interface TextSink {
  write(text: string): Promise<unknown>;
}

/**
 * Strip every schema section from SurrealDB's selected-table export stream.
 *
 * SurrealDB 3.0 requires `tables` to be enabled before it traverses table
 * records, and enabling it also emits table DDL even with `--only --records`.
 * The exporter groups each record payload under an exact `TABLE DATA` header.
 * This bounded-buffer transform copies only those allowlisted data sections;
 * record arrays can be arbitrarily large without being held in memory.
 */
export async function writeRecordsOnlyExport(
  source: ReadableStream<Uint8Array>,
  sink: TextSink,
): Promise<void> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const seen = new Set<string>();
  let buffer = "";
  let mode: "search" | "data" = "search";

  await sink.write(restoreTransactionHeader());
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      ({ buffer, mode } = await consumeBuffer(buffer, mode, seen, sink, false));
    }
    buffer += decoder.decode();
    ({ buffer, mode } = await consumeBuffer(buffer, mode, seen, sink, true));
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (mode === "data" || buffer.length > 0) {
    throw new Error("SurrealDB export ended inside an incomplete table section");
  }
  const missing = BACKUP_TABLES.filter((table) => !seen.has(table));
  if (missing.length > 0) {
    throw new Error(`SurrealDB export omitted selected table data: ${missing.join(",")}`);
  }
  await sink.write("\nCOMMIT TRANSACTION;\n");
}

function restoreTransactionHeader(): string {
  const occupied = RESTORE_EMPTY_TABLES.map(
    (table) => `array::len((SELECT id FROM ${table} LIMIT 1)) > 0`,
  ).join(" OR\n  ");
  return `OPTION IMPORT;\n\nBEGIN TRANSACTION;\nIF ${occupied} {\n  THROW 'notient_restore_target_not_empty';\n};\n\n`;
}

async function consumeBuffer(
  initial: string,
  initialMode: "search" | "data",
  seen: Set<string>,
  sink: TextSink,
  eof: boolean,
): Promise<{ buffer: string; mode: "search" | "data" }> {
  let buffer = initial;
  let mode = initialMode;
  for (;;) {
    const step =
      mode === "search"
        ? await consumeSearchBuffer(buffer, seen, sink, eof)
        : await consumeDataBuffer(buffer, sink, eof);
    if (step.done) return { buffer: step.buffer, mode: step.mode };
    buffer = step.buffer;
    mode = step.mode;
  }
}

type ConsumeStep =
  | { done: true; buffer: string; mode: "search" | "data" }
  | { done: false; buffer: string; mode: "search" | "data" };

async function consumeSearchBuffer(
  input: string,
  seen: Set<string>,
  sink: TextSink,
  eof: boolean,
): Promise<ConsumeStep> {
  const dataStart = input.indexOf(DATA_PREFIX);
  if (dataStart === -1) {
    return {
      done: true,
      buffer: eof ? "" : retainDelimiterTail(input, DATA_PREFIX.length),
      mode: "search",
    };
  }

  const afterPrefix = input.slice(dataStart + DATA_PREFIX.length);
  const headerEnd = afterPrefix.indexOf(DATA_HEADER_SUFFIX);
  if (headerEnd === -1) {
    if (eof) throw new Error("SurrealDB export ended inside a table-data header");
    return { done: true, buffer: `${DATA_PREFIX}${afterPrefix}`, mode: "search" };
  }

  const table = afterPrefix.slice(0, headerEnd);
  assertNewSelectedTable(table, seen);
  await sink.write(`${SECTION_RULE}\n-- TABLE DATA: ${table}\n${SECTION_RULE}\n\n`);
  return {
    done: false,
    buffer: afterPrefix.slice(headerEnd + DATA_HEADER_SUFFIX.length),
    mode: "data",
  };
}

function assertNewSelectedTable(table: string, seen: Set<string>): void {
  if (!BACKUP_TABLE_SET.has(table)) {
    throw new Error(`SurrealDB export returned unselected table '${table}'`);
  }
  if (seen.has(table)) {
    throw new Error(`SurrealDB export repeated table data '${table}'`);
  }
  seen.add(table);
}

async function consumeDataBuffer(
  buffer: string,
  sink: TextSink,
  eof: boolean,
): Promise<ConsumeStep> {
  const nextTable = buffer.indexOf(NEXT_TABLE_PREFIX);
  if (nextTable !== -1) {
    await writeData(sink, buffer.slice(0, nextTable));
    await sink.write("\n\n");
    return { done: false, buffer: buffer.slice(nextTable), mode: "search" };
  }
  if (eof) {
    await writeData(sink, buffer);
    await sink.write("\n");
    return { done: true, buffer: "", mode: "search" };
  }
  const retained = retainDelimiterTail(buffer, NEXT_TABLE_PREFIX.length);
  const writableLength = buffer.length - retained.length;
  if (writableLength > 0) await writeData(sink, buffer.slice(0, writableLength));
  return { done: true, buffer: retained, mode: "data" };
}

async function writeData(sink: TextSink, text: string): Promise<void> {
  await sink.write(text);
}

function retainDelimiterTail(value: string, delimiterLength: number): string {
  return value.slice(Math.max(0, value.length - delimiterLength + 1));
}
