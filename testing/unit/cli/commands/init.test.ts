import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../../src/cli/commands/init";
import { makeEmitter } from "../../../../src/cli/output";
import { DEFAULT_NOTIENT_CONFIG } from "../../../../src/core/settings/types";

describe("notient init", () => {
  let root: string;
  let vaultPath: string;
  let stateFilePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-init-"));
    vaultPath = join(root, "vault");
    stateFilePath = join(root, "state", "state.json");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("writes the sole canonical configuration file on first initialization", async () => {
    const events: Array<Record<string, unknown>> = [];

    await runInit({
      vaultPathArg: vaultPath,
      cwd: root,
      emitter: makeEmitter({
        mode: "json",
        write: (line) => events.push(JSON.parse(line) as Record<string, unknown>),
      }),
      stateFilePath,
    });

    expect(JSON.parse(await readFile(join(vaultPath, ".notient", "config.json"), "utf8"))).toEqual(
      DEFAULT_NOTIENT_CONFIG,
    );
    expect(events.map((event) => event.type)).toEqual(["init:config_written", "init:done"]);
  });

  test("a repeated initialization preserves operator config.json byte for byte", async () => {
    const options = {
      vaultPathArg: vaultPath,
      cwd: root,
      emitter: makeEmitter({ mode: "json" as const, write: () => {} }),
      stateFilePath,
    };
    await runInit(options);
    const settingsPath = join(vaultPath, ".notient", "config.json");
    const customSettings = '{\n  "search": { "defaultMode": "deep" }\n}\n';
    await writeFile(settingsPath, customSettings, "utf8");

    await runInit(options);

    expect(await readFile(settingsPath, "utf8")).toBe(customSettings);
  });
});
