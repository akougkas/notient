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
