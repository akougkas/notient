import type { OperationInput } from "../../../api/operations";
import { assertInferenceBudgetAvailable } from "../../llm/executionBudget";
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

/**
 * Per-invocation context the registry threads to a tool's `invoke`. The
 * authenticated identity is required even when the tool itself does not
 * inspect it, so every dispatch remains attributable.
 */
export interface ToolInvokeContext {
  clientIdentity: string;
  /** Trusted caller scope, never model arguments. */
  noteScope?: OperationInput<"ask.run">["scope"];
  /**
   * Approval call id chosen by the caller for this one invocation. A caller
   * that must recognise its own gate entry before the tool returns (the
   * `notes.write` RPC handler) supplies it here. The chat loop omits it and
   * the tool generates an internal call id.
   */
  callId?: string;
}

export interface ToolDefinition<Args, Result> {
  name: string;
  description: string;
  schema: ToolJsonSchema;
  validate: (args: unknown) => Args;
  invoke: (args: Args, signal: AbortSignal, context: ToolInvokeContext) => Promise<Result>;
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
    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRegistry already contains ${tool.name}`);
    }
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
   * predicate. Used by `ask.run` to build a read-only allowlist subset.
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

  async invoke(
    name: string,
    args: unknown,
    signal: AbortSignal,
    context: ToolInvokeContext,
  ): Promise<unknown> {
    assertInvokeContext(context);
    signal.throwIfAborted();
    assertInferenceBudgetAvailable();
    const tool = this.tools.get(name);
    if (!tool) throw new UnknownToolError(name);
    let validated: unknown;
    try {
      validated = tool.validate(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolValidationError(name, message);
    }
    return tool.invoke(validated, signal, context);
  }

  /** Validate an entire model batch before any member can perform an effect. */
  validate(name: string, args: unknown): void {
    const tool = this.tools.get(name);
    if (!tool) throw new UnknownToolError(name);
    try {
      tool.validate(args);
    } catch (error) {
      throw new ToolValidationError(name, error instanceof Error ? error.message : String(error));
    }
  }
}

function assertInvokeContext(context: ToolInvokeContext): void {
  if (
    context === undefined ||
    typeof context.clientIdentity !== "string" ||
    context.clientIdentity.length === 0 ||
    context.clientIdentity.trim() !== context.clientIdentity
  ) {
    throw new Error("tool invocation requires an authenticated clientIdentity");
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

export function optionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}
