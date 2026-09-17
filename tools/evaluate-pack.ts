#!/usr/bin/env bun
/**
 * Real-model half of the v0.1.0 evaluation pack.
 *
 *   bun tools/evaluate-pack.ts --env-file /private/vault/.notient/.env --out /private/dir \
 *     [--cases enrich/,relate/positive] [--timeout-seconds 300] [--generation-tokens 16384]
 *
 * Builds a disposable vault from the evaluation fixture, copies only the
 * reasoning-model lines of the private env file into it, and runs the selected
 * positive and abstention cases strictly one at a time through a real daemon.
 * It records what the model did; it does not judge usefulness. Embedding
 * settings are not copied, so the probe sends no embedding traffic. Output
 * stays in --out, which must be outside the repository.
 */
import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { contentRevision } from "../src/api/notes";
import { pipelineIdSchema } from "../src/api/operations";
import { jobResultSchema } from "../src/api/pipelines";
import { DEFAULT_NOTIENT_CONFIG } from "../src/core/settings/types";
import { vaultStateDir } from "../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../testing/daemonHarness";
import { AGED_NOTES, EVALUATION_CASES, EVALUATION_NOTES } from "../testing/evaluation/v0.1.0/pack";

const { values } = parseArgs({
  options: {
    "env-file": { type: "string" },
    out: { type: "string" },
    cases: { type: "string" },
    "timeout-seconds": { type: "string", default: "300" },
    "generation-tokens": { type: "string" },
  },
});
const envFile = values["env-file"];
const out = values.out ? resolve(values.out) : undefined;
if (!envFile || !out) throw new Error("--env-file and --out are required");
if (out.startsWith(resolve(import.meta.dir, "..")))
  throw new Error("--out must be outside the repository");
const timeoutMs = Number(values["timeout-seconds"]) * 1000;
const filters = values.cases?.split(",").filter(Boolean);
const selected = EVALUATION_CASES.filter(
  (item) =>
    (item.kind === "positive" || item.kind === "abstain") &&
    !item.scriptedOnly &&
    (!filters || filters.some((filter) => item.id.startsWith(filter))),
);
if (!selected.length) throw new Error("no positive or abstention case matches --cases");

const reasoning = (await readFile(envFile, "utf8"))
  .split(/\r?\n/)
  .filter((line) => /^NOTIENT_(LLM_|CONTEXT_TOKENS=)/.test(line));
const setting = (name: string) =>
  reasoning.find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
if (!setting("NOTIENT_LLM_BASE_URL") || !setting("NOTIENT_LLM_MODEL"))
  throw new Error("the env file names no reasoning endpoint and model");

const root = await mkdtemp(join(tmpdir(), "notient-evaluation-real-"));
await cp(resolve(import.meta.dir, "../testing/fixtures/v0.1.0/"), root, { recursive: true });
for (const [path, body] of Object.entries(EVALUATION_NOTES)) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), body);
}
const old = new Date(Date.now() - 90 * 86400000);
for (const path of AGED_NOTES) await utimes(join(root, path), old, old);
await mkdir(join(root, ".notient"), { mode: 0o700 });
// One request at a time, whatever capacity the private deployment advertises.
await writeFile(
  join(root, ".notient/.env"),
  `${reasoning.join("\n")}\nNOTIENT_REASONING_SLOTS=1\n`,
  {
    mode: 0o600,
  },
);

// An explicit ceiling is an experiment on the shared reasoning/answer budget.
// Without the flag every pipeline runs with its shipped default policy.
const generationTokens = values["generation-tokens"] ? Number(values["generation-tokens"]) : null;
if (generationTokens !== null) {
  if (
    !Number.isSafeInteger(generationTokens) ||
    generationTokens < 4096 ||
    generationTokens > 32768
  )
    throw new Error("--generation-tokens must be an integer from 4096 to 32768");
  const config = structuredClone(DEFAULT_NOTIENT_CONFIG);
  for (const id of pipelineIdSchema.options)
    config.background.pipelines[id].budget.generationTokens = generationTokens;
  await writeFile(join(root, ".notient/config.json"), JSON.stringify(config), { mode: 0o600 });
}

const observations: unknown[] = [];
const daemon = await startTestDaemon(root, 60000);
try {
  // Candidate retrieval depends on the lexical index; a warm-up race would
  // change what the model is shown and make runs incomparable.
  for (const deadline = performance.now() + 60000; ; await Bun.sleep(200)) {
    const search = await daemonResult(daemon.client, "search.run", {
      query: "storage",
      mode: "lexical",
      scope: {},
      limit: 1,
    });
    if ((search.coverage as { state?: string } | undefined)?.state === "current") break;
    if (performance.now() > deadline) throw new Error("the lexical index did not become current");
  }
  for (const item of selected) {
    const sources = await Promise.all(
      item.sources.map(async (path) => ({
        path,
        revision: contentRevision(await readFile(join(root, path), "utf8")),
      })),
    );
    const started = performance.now();
    process.stderr.write(`${item.id} … `);
    let job = jobResultSchema.parse(
      await daemonResult(daemon.client, "pipelines.run", {
        pipeline: item.pipeline,
        sources,
        idempotencyKey: `real-${item.id}-${Date.now()}`,
        preview: true,
      }),
    ).job;
    while (
      !["completed", "awaiting-approval", "cancelled", "failed", "partial"].includes(job.state)
    ) {
      if (performance.now() - started > timeoutMs) {
        job = jobResultSchema.parse(
          await daemonResult(daemon.client, "jobs.control", {
            id: job.id,
            action: "cancel",
            revision: job.revision,
            idempotencyKey: `real-cancel-${job.id}`,
          }),
        ).job;
        break;
      }
      await Bun.sleep(500);
      job = jobResultSchema.parse(
        await daemonResult(daemon.client, "jobs.get", { id: job.id }),
      ).job;
    }
    const plan = job.plan;
    const cited = plan?.findings.flatMap((finding) => finding.evidence) ?? [];
    const resolved = await Promise.all(
      cited.map(async (entry) => {
        const body = await readFile(join(root, entry.path), "utf8");
        return (
          contentRevision(body) === entry.revision &&
          body.slice(entry.range.start, entry.range.end) === entry.quote
        );
      }),
    );
    const expectedEvidence = (item.expect.evidence ?? []).map((needed) => ({
      ...needed,
      cited: cited.some(
        (entry) =>
          entry.path === needed.path &&
          (entry.quote.includes(needed.quote) || needed.quote.includes(entry.quote)),
      ),
    }));
    const changeKinds: string[] = plan?.changes.map((change) => change.kind) ?? [];
    const observation = {
      id: item.id,
      kind: item.kind,
      usefulnessCriterion: item.usefulness,
      state: job.state,
      failure: job.failure,
      seconds: Math.round((performance.now() - started) / 100) / 10,
      attempts: job.attempts,
      abstained: plan?.abstained ?? null,
      summary: plan?.summary ?? null,
      // Deterministic checks only. Usefulness is a person's judgment of the text below.
      checks: {
        citationsResolve: resolved.every(Boolean),
        citations: cited.length,
        expectedEvidence,
        expectedChangeKinds: item.expect.changes ?? null,
        changeKinds,
        // A real model may also add a grounded summary or tag the script omits.
        expectedChangeKindsPresent:
          item.expect.changes === undefined
            ? null
            : item.expect.changes.every((kind) => changeKinds.includes(kind)) &&
              (item.expect.changes.length > 0 || changeKinds.length === 0),
        unrelatedUntouched: (item.expect.unrelatedPaths ?? []).every(
          (path) =>
            !cited.some((entry) => entry.path === path) &&
            !(plan?.relationships ?? []).some(
              (edge) => edge.source.path === path || edge.target.path === path,
            ),
        ),
        expectedRelationships: item.expect.relationships ?? null,
        relationships:
          plan?.relationships.map((edge) => ({
            relation: edge.relation,
            source: edge.source.path,
            target: edge.target.path,
          })) ?? [],
        // Retrieved neighbours may be legitimately connected; then only
        // `unrelatedUntouched` decides an abstention case.
        abstentionMatches:
          item.expect.abstained === undefined || item.expect.unrelatedPaths
            ? null
            : plan?.abstained === item.expect.abstained,
        generationTokens,
      },
      findings: plan?.findings ?? [],
      changes: plan?.changes ?? [],
    };
    observations.push(observation);
    process.stderr.write(`${job.state} in ${observation.seconds}s\n`);
  }
} finally {
  await daemon.stop();
  await rm(vaultStateDir(root), { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
await mkdir(out, { recursive: true });
const file = join(out, `evaluation-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(
  file,
  `${JSON.stringify(
    {
      // Endpoint and model only; credentials never leave the private env file.
      endpoint: setting("NOTIENT_LLM_BASE_URL"),
      model: setting("NOTIENT_LLM_MODEL"),
      contextTokens: setting("NOTIENT_CONTEXT_TOKENS"),
      sequential: true,
      observations,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
process.stdout.write(`${file}\n`);
