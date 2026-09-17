import { briefResultSchema } from "../api/brief";
import { briefMarkdown } from "../api/briefMarkdown";
import { comparisonResultSchema } from "../api/comparison";
import { comparisonMarkdown } from "../api/comparisonMarkdown";
import { historyEntrySchema } from "../api/history";
import { type DoctorReport, formatDoctorReport } from "./commands/doctor";
import { type SetupReport, formatSetupReport } from "./commands/setup";

export type EmitterMode = "json" | "ndjson" | "pretty";

export interface StructuredEvent {
  type: string;
  [key: string]: unknown;
}

export interface EmitterOptions {
  mode: EmitterMode;
  write?: (line: string) => void;
}

export interface Emitter {
  emit: (event: StructuredEvent) => void;
}

export function makeEmitter(options: EmitterOptions): Emitter {
  const write =
    options.write ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });

  if (options.mode === "ndjson") {
    return {
      emit: (event) => {
        write(JSON.stringify(event));
      },
    };
  }

  if (options.mode === "json") {
    return {
      emit: (event) => {
        write(JSON.stringify(event));
      },
    };
  }

  return {
    emit: (event) => {
      if (event.type === "doctor") {
        write(formatDoctorReport(event as DoctorReport));
        return;
      }
      if (event.type === "setup") {
        write(formatSetupReport(event as SetupReport, formatDoctorReport));
        return;
      }
      if (event.type === "brief:done") {
        write(briefMarkdown(briefResultSchema.parse(event)));
        return;
      }
      if (event.type === "analysis:done") {
        write(comparisonMarkdown(comparisonResultSchema.parse(event)));
        return;
      }
      if (event.type === "history:entry") {
        const { type: _type, ...data } = event;
        const entry = historyEntrySchema.parse(data);
        const state =
          entry.undo?.completedAt != null
            ? "undone"
            : entry.undo
              ? "undo interrupted"
              : entry.kind.replace(/^notes?\./, "").replaceAll("_", " ");
        write(
          `${new Date(entry.createdAt).toLocaleString()}  ${entry.target}  · ${state}\n  ${entry.id} · ${entry.clientIdentity}`,
        );
        return;
      }
      if (event.type === "history:undone") {
        const entry = historyEntrySchema.parse(event.entry);
        write(`Restored ${entry.target}. The original change remains in history.`);
        return;
      }
      const detail = Object.entries(event)
        .filter(([key]) => key !== "type")
        .map(([key, value]) => `${key}=${formatValue(value)}`)
        .join(" ");
      write(detail.length > 0 ? `${event.type} ${detail}` : event.type);
    },
  };
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function defaultMode(isTty: boolean): EmitterMode {
  return isTty ? "pretty" : "json";
}
