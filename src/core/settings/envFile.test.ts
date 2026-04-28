import { describe, expect, test } from "bun:test";
import { parseEnvFile } from "./envFile";

describe("parseEnvFile", () => {
  test("empty input returns an empty record", () => {
    expect(parseEnvFile("")).toEqual({});
  });

  test("parses simple KEY=value pairs", () => {
    expect(parseEnvFile("FOO=bar\nBAZ=qux")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("ignores comment lines and blank lines", () => {
    const text = `# this is a comment
FOO=bar

# another
BAZ=qux
`;
    expect(parseEnvFile(text)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("strips matching double quotes", () => {
    expect(parseEnvFile('FOO="hello world"')).toEqual({ FOO: "hello world" });
  });

  test("strips matching single quotes", () => {
    expect(parseEnvFile("FOO='hello world'")).toEqual({ FOO: "hello world" });
  });

  test("preserves quotes when they do not match", () => {
    expect(parseEnvFile("FOO=\"unbalanced'")).toEqual({ FOO: "\"unbalanced'" });
  });

  test("treats KEY= as empty string", () => {
    expect(parseEnvFile("FOO=")).toEqual({ FOO: "" });
  });

  test("ignores keys that start with a digit", () => {
    expect(parseEnvFile("9FOO=bar\nFOO=baz")).toEqual({ FOO: "baz" });
  });

  test("ignores keys with hyphens or spaces", () => {
    expect(parseEnvFile("MY-KEY=bar\nMY KEY=bar2\nMY_KEY=bar3")).toEqual({ MY_KEY: "bar3" });
  });

  test("preserves later values when the same key appears twice", () => {
    expect(parseEnvFile("FOO=first\nFOO=second")).toEqual({ FOO: "second" });
  });

  test("trims whitespace around the key", () => {
    expect(parseEnvFile("  FOO  =bar")).toEqual({ FOO: "bar" });
  });

  test("preserves embedded equals signs in the value", () => {
    expect(parseEnvFile("URL=http://host:1234/v1?q=1&r=2")).toEqual({
      URL: "http://host:1234/v1?q=1&r=2",
    });
  });

  test("ignores lines without an equals sign", () => {
    expect(parseEnvFile("not an env line\nFOO=bar")).toEqual({ FOO: "bar" });
  });
});
