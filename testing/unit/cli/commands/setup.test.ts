import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoctorReport } from "../../../../src/cli/commands/doctor";
import {
  type SetupReport,
  mergeEnvText,
  runSetupCommand,
} from "../../../../src/cli/commands/setup";
import type { EndpointModelCatalog } from "../../../../src/core/llm/modelSelection";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const catalog: EndpointModelCatalog = {
  source: "openai-compatible",
  models: [
    { id: "reasoner", type: "chat", state: "loaded", loadedContextLength: 65536 },
    { id: "spare", type: "chat", state: "not-loaded", loadedContextLength: null },
    { id: "embedder", type: "embedding", state: "loaded", loadedContextLength: 2048 },
  ],
};

async function harness(answers: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "notient-setup-"));
  roots.push(root);
  const vault = join(root, "vault");
  await mkdir(vault);
  const events: SetupReport[] = [];
  const requested: string[] = [];
  const asked: string[] = [];
  const doctor = (status: DoctorReport["status"]): DoctorReport => ({
    type: "doctor",
    vault,
    status,
    checks: [],
    note: "",
  });
  const run = (extra: Partial<Parameters<typeof runSetupCommand>[0]> = {}) =>
    runSetupCommand({
      vaultPathArg: vault,
      cwd: root,
      emitter: { emit: (event) => events.push(event as SetupReport) },
      stateFilePath: join(root, "state.json"),
      fetchCatalog: async ({ baseUrl }) => {
        requested.push(baseUrl);
        return catalog;
      },
      inspect: async () => doctor("ready"),
      ...extra,
    });
  const ask = async (question: string) => {
    asked.push(question);
    return answers.shift() ?? "";
  };
  return { root, vault, events, requested, asked, ask, run, doctor };
}

test("flags configure the single loaded model privately without prompting", async () => {
  const { vault, events, run } = await harness();
  expect(await run({ endpoint: "http://127.0.0.1:1234/v1" })).toBe(0);
  const env = join(vault, ".notient/.env");
  expect(await readFile(env, "utf8")).toBe(
    "NOTIENT_LLM_BASE_URL=http://127.0.0.1:1234/v1\nNOTIENT_LLM_MODEL=reasoner\nNOTIENT_CONTEXT_TOKENS=16384\nNOTIENT_EMBED_BASE_URL=http://127.0.0.1:1234/v1\nNOTIENT_EMBED_MODEL=embedder\n",
  );
  expect((await stat(env)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(vault, ".notient/config.json"), "utf8"))).toBeDefined();
  expect(events[0].next[0]).toContain(`notient --vault "${vault}"`);
  expect(events[0].steps.join(" ")).toContain("No generation request was sent");
});

test("a saved deployment, its credential and comments survive a second run", async () => {
  const { vault, requested, run } = await harness();
  await mkdir(join(vault, ".notient"));
  const saved =
    "# private\nNOTIENT_LLM_BASE_URL=http://old/v1\nNOTIENT_LLM_MODEL=old-model\nNOTIENT_LLM_API_KEY=secret\n";
  await writeFile(join(vault, ".notient/.env"), saved, { mode: 0o600 });
  expect(await run()).toBe(0);
  expect(requested).toEqual([]);
  expect(await readFile(join(vault, ".notient/.env"), "utf8")).toBe(saved);
  // Naming a new model changes only that key.
  expect(await run({ model: "reasoner" })).toBe(0);
  expect(requested).toEqual(["http://old/v1"]);
  const updated = await readFile(join(vault, ".notient/.env"), "utf8");
  expect(updated).toContain(
    "# private\nNOTIENT_LLM_BASE_URL=http://old/v1\nNOTIENT_LLM_MODEL=reasoner\n",
  );
  expect(updated).toContain("NOTIENT_LLM_API_KEY=secret");
});

test("prompts choose among several models and a blank endpoint is a valid core-only setup", async () => {
  const several = await harness(["http://127.0.0.1:9/v1", "2"]);
  await several.run({
    ask: several.ask,
    fetchCatalog: async () => ({
      source: "openai-compatible",
      models: catalog.models.map((entry) => ({ ...entry, state: "loaded" as const })),
    }),
  });
  expect(several.asked[1]).toContain("1. reasoner\n  2. spare");
  expect(await readFile(join(several.vault, ".notient/.env"), "utf8")).toContain(
    "NOTIENT_LLM_MODEL=spare",
  );

  const core = await harness([""]);
  expect(await core.run({ ask: core.ask })).toBe(0);
  expect(await Bun.file(join(core.vault, ".notient/.env")).exists()).toBe(false);
  expect(core.events[0].steps.join(" ")).toContain("No model endpoint yet");
});

test("without prompts an ambiguous model is an explicit error, and a blocked doctor fails setup", async () => {
  const ambiguous = await harness();
  await expect(
    ambiguous.run({
      endpoint: "http://127.0.0.1:9/v1",
      fetchCatalog: async () => ({
        source: "openai-compatible",
        models: catalog.models.map((entry) => ({ ...entry, state: "unknown" as const })),
      }),
    }),
  ).rejects.toThrow("--model");
  expect(await Bun.file(join(ambiguous.vault, ".notient/.env")).exists()).toBe(false);

  const blocked = await harness();
  expect(await blocked.run({ inspect: async () => blocked.doctor("blocked") })).toBe(1);
  await expect(blocked.run({ vaultPathArg: join(blocked.root, "missing") })).rejects.toThrow(
    "is not a folder",
  );
});

test("merging keeps unrelated lines and replaces a key in place", () => {
  expect(mergeEnvText("# c\nA=1\n\nB=2\n", { A: "9", C: "3" })).toBe("# c\nA=9\n\nB=2\nC=3\n");
  expect(mergeEnvText("", { A: "1" })).toBe("A=1\n");
});
