/**
 * Chat tool registry. Each tool exposes a JSON Schema describing its
 * arguments so the LLM can call it via OpenAI function-calling, plus a
 * runtime validator and an async `invoke`. The registry also flags which
 * tools require approval-gated writes; read-only tools execute immediately.
 */

export interface ToolJsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition<Args, Result> {
  name: string;
  description: string;
  schema: ToolJsonSchema;
  validate: (args: unknown) => Args;
  invoke: (args: Args, signal: AbortSignal) => Promise<Result>;
  writeGated: boolean;
}

export interface ToolListEntry {
  name: string;
  description: string;
  schema: ToolJsonSchema;
  writeGated: boolean;
}

export interface OpenAIToolEntry {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolJsonSchema;
  };
}

export class ToolValidationError extends Error {
  constructor(
    readonly toolName: string,
    message: string,
  ) {
    super(`Tool "${toolName}" validation failed: ${message}`);
    this.name = "ToolValidationError";
  }
}

export class UnknownToolError extends Error {
  constructor(readonly toolName: string) {
    super(`Unknown tool: ${toolName}`);
    this.name = "UnknownToolError";
  }
}

// The registry stores type-erased tools so heterogeneous definitions can live
// in a single Map. The `register` overload preserves caller-side typing.
type ErasedTool = ToolDefinition<unknown, unknown>;

export class ToolRegistry {
  private readonly tools = new Map<string, ErasedTool>();

  register<Args, Result>(tool: ToolDefinition<Args, Result>): void {
    this.tools.set(tool.name, tool as unknown as ErasedTool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ErasedTool | undefined {
    return this.tools.get(name);
  }

  list(): ToolListEntry[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
      writeGated: tool.writeGated,
    }));
  }

  /**
   * Returns a new ToolRegistry containing only tools whose names satisfy the
   * predicate. Used by `agent.ask` to build a read-only allowlist subset.
   */
  withFilter(predicate: (toolName: string) => boolean): ToolRegistry {
    const next = new ToolRegistry();
    for (const [name, tool] of this.tools) {
      if (predicate(name)) next.tools.set(name, tool);
    }
    return next;
  }

  exportToolsForOpenAI(): OpenAIToolEntry[] {
    return Array.from(this.tools.values()).map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.schema,
      },
    }));
  }

  isWriteGated(name: string): boolean {
    return this.tools.get(name)?.writeGated ?? false;
  }

  async invoke(name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new UnknownToolError(name);
    let validated: unknown;
    try {
      validated = tool.validate(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolValidationError(name, message);
    }
    return tool.invoke(validated, signal);
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

export function optionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return Math.floor(value);
}

export function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings`);
  for (const entry of value) {
    if (typeof entry !== "string") throw new Error(`${field} must be an array of strings`);
  }
  return value as string[];
}
