import { describe, expect, test } from "bun:test";
import {
  type ToolDefinition,
  ToolRegistry,
  ToolValidationError,
  UnknownToolError,
  isObject,
  optionalPositiveInt,
  optionalStringArray,
  requireString,
} from "./registry";

interface DemoArgs {
  name: string;
  count?: number;
}

function makeDemoTool(record: { invocations: DemoArgs[] }): ToolDefinition<DemoArgs, string> {
  return {
    name: "demo.echo",
    description: "Echo a name.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
      },
      required: ["name"],
    },
    validate: (args) => {
      if (!isObject(args)) throw new Error("expected object");
      const name = requireString(args.name, "name");
      const count = optionalPositiveInt(args.count, "count");
      return { name, count };
    },
    invoke: async (args) => {
      record.invocations.push(args);
      return `${args.name}:${args.count ?? 0}`;
    },
    writeGated: false,
  };
}

describe("ToolRegistry", () => {
  test("registers and retrieves tools by name", () => {
    const registry = new ToolRegistry();
    const record = { invocations: [] as DemoArgs[] };
    registry.register(makeDemoTool(record));
    expect(registry.has("demo.echo")).toBe(true);
    expect(registry.has("unknown")).toBe(false);
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("demo.echo");
    expect(list[0].writeGated).toBe(false);
    expect(list[0].schema.required).toEqual(["name"]);
  });

  test("exports OpenAI function-calling shape", () => {
    const registry = new ToolRegistry();
    const record = { invocations: [] as DemoArgs[] };
    registry.register(makeDemoTool(record));
    const exported = registry.exportToolsForOpenAI();
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      type: "function",
      function: {
        name: "demo.echo",
        description: "Echo a name.",
      },
    });
    expect(exported[0].function.parameters.type).toBe("object");
    expect(exported[0].function.parameters.required).toEqual(["name"]);
  });

  test("invoke validates and dispatches with parsed args", async () => {
    const registry = new ToolRegistry();
    const record = { invocations: [] as DemoArgs[] };
    registry.register(makeDemoTool(record));
    const result = await registry.invoke(
      "demo.echo",
      { name: "alpha", count: 3 },
      new AbortController().signal,
    );
    expect(result).toBe("alpha:3");
    expect(record.invocations).toEqual([{ name: "alpha", count: 3 }]);
  });

  test("invoke wraps validation failures in ToolValidationError", async () => {
    const registry = new ToolRegistry();
    const record = { invocations: [] as DemoArgs[] };
    registry.register(makeDemoTool(record));
    let error: unknown;
    try {
      await registry.invoke("demo.echo", { name: "" }, new AbortController().signal);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ToolValidationError);
    expect((error as ToolValidationError).toolName).toBe("demo.echo");
    expect(record.invocations).toEqual([]);
  });

  test("invoke on an unknown name throws UnknownToolError", async () => {
    const registry = new ToolRegistry();
    let error: unknown;
    try {
      await registry.invoke("missing.tool", {}, new AbortController().signal);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UnknownToolError);
    expect((error as UnknownToolError).toolName).toBe("missing.tool");
  });

  test("isWriteGated reflects the tool flag", () => {
    const registry = new ToolRegistry();
    const record = { invocations: [] as DemoArgs[] };
    registry.register(makeDemoTool(record));
    registry.register({
      ...makeDemoTool(record),
      name: "demo.write",
      writeGated: true,
    });
    expect(registry.isWriteGated("demo.echo")).toBe(false);
    expect(registry.isWriteGated("demo.write")).toBe(true);
    expect(registry.isWriteGated("nope")).toBe(false);
  });
});

describe("registry helpers", () => {
  test("requireString rejects empty and non-strings", () => {
    expect(() => requireString("", "x")).toThrow();
    expect(() => requireString(5, "x")).toThrow();
    expect(requireString("ok", "x")).toBe("ok");
  });

  test("optionalPositiveInt floors and rejects non-positive", () => {
    expect(optionalPositiveInt(undefined, "n")).toBeUndefined();
    expect(optionalPositiveInt(3.7, "n")).toBe(3);
    expect(() => optionalPositiveInt(0, "n")).toThrow();
    expect(() => optionalPositiveInt(-1, "n")).toThrow();
  });

  test("optionalStringArray validates element types", () => {
    expect(optionalStringArray(undefined, "x")).toBeUndefined();
    expect(optionalStringArray(["a", "b"], "x")).toEqual(["a", "b"]);
    expect(() => optionalStringArray(["a", 1], "x")).toThrow();
  });
});
