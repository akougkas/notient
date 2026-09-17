import { describe, expect, test } from "bun:test";
import { type RootEntryInput, selectRootEntry } from "../../../src/cli/rootEntry";

const ROOT: RootEntryInput = {
  command: null,
  helpRequested: false,
  versionRequested: false,
  outputModeRequested: false,
  stdinIsTty: true,
  stdoutIsTty: true,
};

describe("selectRootEntry", () => {
  test("opens the TUI for a bare interactive terminal", () => {
    expect(selectRootEntry(ROOT)).toBe("tui");
  });

  test("keeps bare piped invocations as structured help", () => {
    expect(selectRootEntry({ ...ROOT, stdinIsTty: false, stdoutIsTty: false })).toBe("help");
  });

  test("honors explicit help, version, output modes, and commands", () => {
    expect(selectRootEntry({ ...ROOT, helpRequested: true })).toBe("help");
    expect(selectRootEntry({ ...ROOT, command: "help", versionRequested: true })).toBe("help");
    expect(selectRootEntry({ ...ROOT, versionRequested: true })).toBe("version");
    expect(selectRootEntry({ ...ROOT, outputModeRequested: true })).toBe("help");
    expect(selectRootEntry({ ...ROOT, command: "search" })).toBe("command");
  });
});
