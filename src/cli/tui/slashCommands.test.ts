import { describe, expect, test } from "bun:test";
import { isSlashCommand, parseSlashCommand } from "./slashCommands";

describe("isSlashCommand", () => {
  test("matches lines beginning with /", () => {
    expect(isSlashCommand("/quit")).toBe(true);
    expect(isSlashCommand("hello")).toBe(false);
    expect(isSlashCommand(" /quit")).toBe(false);
  });
});

describe("parseSlashCommand", () => {
  test("splits verb and rest", () => {
    expect(parseSlashCommand("/search foo bar")).toEqual({
      verb: "search",
      rest: "foo bar",
    });
    expect(parseSlashCommand("/quit")).toEqual({ verb: "quit", rest: "" });
  });

  test("handles trailing whitespace", () => {
    expect(parseSlashCommand("/help   ")).toEqual({ verb: "help", rest: "" });
  });
});
