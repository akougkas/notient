import { describe, expect, test } from "bun:test";
import {
  type ToolDefinition,
  ToolRegistry,
  ToolValidationError,
  UnknownToolError,
  isObject,
  optionalPositiveInt,
  requireString,
} from "../../../../../src/core/chat/tools/registry";

interface DemoArgs {
  name: string;
  count?: number;
}

const TEST_CONTEXT = { clientIdentity: "human" } as const;

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

  test("rejects duplicate tool registration", () => {
    const registry = new ToolRegistry();
    const record = { invocations: [] as DemoArgs[] };
    registry.register(makeDemoTool(record));
    expect(() => registry.register(makeDemoTool(record))).toThrow("already contains demo.echo");
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
      TEST_CONTEXT,
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
      await registry.invoke("demo.echo", { name: "" }, new AbortController().signal, TEST_CONTEXT);
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
      await registry.invoke("missing.tool", {}, new AbortController().signal, TEST_CONTEXT);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UnknownToolError);
    expect((error as UnknownToolError).toolName).toBe("missing.tool");
  });

  test("invoke rejects an empty client identity before dispatch", async () => {
    const registry = new ToolRegistry();
    const record = { invocations: [] as DemoArgs[] };
    registry.register(makeDemoTool(record));

    await expect(
      registry.invoke("demo.echo", { name: "alpha" }, new AbortController().signal, {
        clientIdentity: "",
      }),
    ).rejects.toThrow("authenticated clientIdentity");
    await expect(
      registry.invoke("demo.echo", { name: "alpha" }, new AbortController().signal, {
        clientIdentity: " padded ",
      }),
    ).rejects.toThrow("authenticated clientIdentity");
    expect(record.invocations).toEqual([]);
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

  test("optionalPositiveInt accepts only canonical positive safe integers", () => {
    expect(optionalPositiveInt(undefined, "n")).toBeUndefined();
    expect(optionalPositiveInt(3, "n")).toBe(3);
    for (const invalid of [null, 3.7, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => optionalPositiveInt(invalid, "n")).toThrow("positive safe integer");
    }
  });
});
