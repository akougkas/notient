import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NotientClient } from "../../../src/api/client";
import { contentRevision } from "../../../src/api/notes";
import { pipelineIdSchema } from "../../../src/api/operations";
import { jobResultSchema } from "../../../src/api/pipelines";
import type { ClientHandle } from "../../../src/cli/client";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";
import {
  AGED_NOTES,
  EVALUATION_CASES,
  EVALUATION_NOTES,
  type EvaluationCase,
} from "../../evaluation/v0.1.0/pack";

/**
 * Deterministic half of the v0.1.0 evaluation pack: every case runs through a
 * real daemon with scripted structured output. It proves evidence resolution,
 * abstention, fault handling and byte preservation. It says nothing about
 * model quality; `tools/evaluate-pack.ts` records that separately.
 */
type Job = ReturnType<typeof jobResultSchema.parse>["job"];
const SETTLED = ["completed", "awaiting-approval", "cancelled", "failed", "partial"];
const smoke = process.env.NOTIENT_SMOKE === "1";

let root = "";
let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let active: EvaluationCase | undefined;
let outage = false;
let calls = 0;
let scriptFailure: string | undefined;
let onModelCall: (() => Promise<void>) | undefined;

async function vaultBytes(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.name === ".notient" || path === "Notient") continue;
      if (entry.isDirectory()) await walk(path);
      else files.set(path, contentRevision(await readFile(join(root, path), "utf8")));
    }
  };
  await walk("");
  return files;
}

async function age(path: string): Promise<void> {
  const old = new Date(Date.now() - 90 * 86400000);
  await utimes(join(root, path), old, old);
}

async function references(paths: string[]) {
  return Promise.all(
    paths.map(async (path) => ({
      path,
      revision: contentRevision(await readFile(join(root, path), "utf8")),
    })),
  );
}

async function settle(id: string, until: string[] = SETTLED): Promise<Job> {
  if (!daemon) throw new Error("daemon is not running");
  const deadline = performance.now() + 30000;
  let last: Job | undefined;
  while (performance.now() < deadline) {
    last = jobResultSchema.parse(await daemonResult(daemon.client, "jobs.get", { id })).job;
    if (until.includes(last.state)) return last;
    await Bun.sleep(20);
  }
  throw new Error(`job did not reach ${until.join("/")}: ${last?.state} ${last?.failure?.message}`);
}

/** Every cited passage must resolve, byte for byte, in the recorded source revision. */
async function expectResolvableEvidence(job: Job): Promise<void> {
  const recorded = new Map(job.sourceRevisions.map((source) => [source.path, source.revision]));
  for (const source of job.plan?.sources ?? []) recorded.set(source.path, source.revision);
  for (const finding of job.plan?.findings ?? []) {
    expect(finding.evidence.length).toBeGreaterThan(0);
    for (const entry of finding.evidence) {
      const body = await readFile(join(root, entry.path), "utf8");
      expect(contentRevision(body)).toBe(entry.revision);
      expect(recorded.get(entry.path)).toBe(entry.revision);
      expect(body.slice(entry.range.start, entry.range.end)).toBe(entry.quote);
    }
  }
}

function expectOutcome(job: Job, item: EvaluationCase): void {
  const plan = job.plan;
  if (!plan) throw new Error(`${item.id} produced no plan: ${job.failure?.message}`);
  const { expect: wanted } = item;
  if (wanted.abstained !== undefined) expect(plan.abstained).toBe(wanted.abstained);
  if (wanted.abstained) expect(plan.summary.length).toBeGreaterThan(0);
  if (wanted.changes)
    expect(plan.changes.map((change): string => change.kind)).toEqual(wanted.changes);
  if (wanted.findingKinds)
    expect([...new Set(plan.findings.map((finding): string => finding.kind))]).toEqual(
      wanted.findingKinds,
    );
  if (wanted.relationships)
    expect(
      plan.relationships.map((edge) => ({
        relation: edge.relation as string,
        source: edge.source.path,
        target: edge.target.path,
      })),
    ).toEqual(wanted.relationships);
  const cited = plan.findings.flatMap((finding) => finding.evidence);
  for (const needed of wanted.evidence ?? [])
    expect(
      cited.some((entry) => entry.path === needed.path && entry.quote.includes(needed.quote)),
    ).toBe(true);
  for (const path of wanted.unrelatedPaths ?? []) {
    expect(cited.some((entry) => entry.path === path)).toBe(false);
    expect(
      plan.relationships.some((edge) => edge.source.path === path || edge.target.path === path),
    ).toBe(false);
  }
  const effectful = plan.changes.length + plan.relationships.length > 0;
  expect(job.state).toBe(effectful ? "awaiting-approval" : "completed");
  expect(job.proposalIds.length).toBe(effectful ? 1 : 0);
  expect(job.effects).toBeNull();
}

async function run(
  item: EvaluationCase,
  client: ClientHandle | NotientClient | undefined = daemon?.client,
  key = item.id,
) {
  if (!client) throw new Error("daemon is not running");
  active = item;
  const input = {
    pipeline: item.pipeline,
    sources: await references(item.sources),
    idempotencyKey: key,
    preview: false,
  };
  const started =
    client instanceof NotientClient
      ? await client.call("pipelines.run", input)
      : await daemonResult(client, "pipelines.run", input);
  return jobResultSchema.parse(started).job;
}

beforeAll(async () => {
  if (!smoke) return;
  root = await mkdtemp(join(tmpdir(), "notient-evaluation-"));
  await cp(new URL("../../fixtures/v0.1.0/", import.meta.url), root, { recursive: true });
  for (const [path, body] of Object.entries(EVALUATION_NOTES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  }
  for (const path of AGED_NOTES) await age(path);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.method === "GET")
        return Response.json({ data: [{ id: "evaluation-script", state: "loaded" }] });
      const input = (await request.json()) as {
        response_format?: { json_schema?: { name?: string } };
        messages: Array<{ role: string; content: string }>;
      };
      calls++;
      if (outage) return new Response("upstream unavailable", { status: 503 });
      const pending = onModelCall;
      onModelCall = undefined;
      await pending?.();
      const stage = input.response_format?.json_schema?.name ?? "";
      // Correction rounds append prose; the document payload stays in an earlier turn.
      const documents =
        input.messages
          .filter((message) => message.role === "user")
          .flatMap((message) => {
            try {
              return [JSON.parse(message.content) as { documents?: Array<{ path: string }> }];
            } catch {
              return [];
            }
          })[0]?.documents ?? [];
      const at = (path: string) => {
        const index = documents.findIndex((document) => document.path === path);
        if (index < 0) throw new Error(`${path} was not supplied to ${stage}`);
        return index;
      };
      let content: unknown;
      try {
        if (!active) throw new Error("model call outside an evaluation case");
        content = active.script(stage, at);
      } catch (error) {
        scriptFailure = `${active?.id}: ${error instanceof Error ? error.message : String(error)}`;
        return new Response(scriptFailure, { status: 400 });
      }
      return Response.json({
        choices: [
          {
            message: { role: "assistant", content: JSON.stringify(content) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });
    },
  });
  await mkdir(join(root, ".notient"), { mode: 0o700 });
  await writeFile(
    join(root, ".notient/.env"),
    `NOTIENT_LLM_BASE_URL=http://127.0.0.1:${server.port}/v1\nNOTIENT_LLM_MODEL=evaluation-script\n`,
    { mode: 0o600 },
  );
  daemon = await startTestDaemon(root);
}, 60000);

afterAll(async () => {
  await daemon?.stop();
  await server?.stop(true);
  if (root) {
    await rm(vaultStateDir(root), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

describe.skipIf(!smoke)("[smoke] v0.1.0 evaluation pack, deterministic", () => {
  test("covers every pipeline with two positive, two abstention, one failure and one stale or permission case", () => {
    for (const pipeline of pipelineIdSchema.options) {
      const kinds = EVALUATION_CASES.filter((item) => item.pipeline === pipeline).map(
        (item) => item.kind,
      );
      expect(kinds.filter((kind) => kind === "positive").length).toBeGreaterThanOrEqual(2);
      expect(kinds.filter((kind) => kind === "abstain").length).toBeGreaterThanOrEqual(2);
      expect(
        kinds.filter((kind) => kind === "provider-failure" || kind === "interruption").length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        kinds.filter((kind) => kind === "stale-source" || kind === "permission-change").length,
      ).toBeGreaterThanOrEqual(1);
    }
    expect(new Set(EVALUATION_CASES.map((item) => item.id)).size).toBe(EVALUATION_CASES.length);
  });

  for (const item of EVALUATION_CASES) {
    test(item.id, async () => {
      const before = await vaultBytes();
      scriptFailure = undefined;
      await RUNNERS[item.kind](item);
      expect(scriptFailure).toBeUndefined();
      // No case applies anything: authored bytes are exactly as before.
      expect(await vaultBytes()).toEqual(before);
    }, 60000);
  }
});

function operator(): ClientHandle {
  if (!daemon) throw new Error("daemon is not running");
  return daemon.client;
}

async function runOutcome(item: EvaluationCase): Promise<void> {
  const priorCalls = calls;
  const job = await settle((await run(item)).id);
  expect(scriptFailure).toBeUndefined();
  expectOutcome(job, item);
  await expectResolvableEvidence(job);
  if (item.expect.modelCalls !== undefined) expect(calls - priorCalls).toBe(item.expect.modelCalls);
}

async function runProviderFailure(item: EvaluationCase): Promise<void> {
  outage = true;
  let started: Job;
  try {
    started = await run(item);
    const deferred = await settle(started.id, ["waiting-inference", ...SETTLED]);
    expect(deferred.state).toBe("waiting-inference");
    expect(deferred.failure).not.toBeNull();
    expect(deferred.plan).toBeNull();
    expect(deferred.proposalIds).toEqual([]);
    // Restored inference completes the same job once, without duplicates.
    outage = false;
    await daemonResult(operator(), "jobs.control", {
      id: started.id,
      action: "retry",
      revision: deferred.revision,
      idempotencyKey: `${item.id}-retry`,
    });
  } finally {
    outage = false;
  }
  const recovered = await settle(started.id);
  expect(recovered.plan?.abstained).toBe(false);
  expect(recovered.proposalIds.length).toBeLessThanOrEqual(1);
  await expectResolvableEvidence(recovered);
  expect((await run(item)).id).toBe(started.id);
}

async function runInterruption(item: EvaluationCase): Promise<void> {
  const priorCalls = calls;
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  onModelCall = () => held;
  try {
    const started = await run(item);
    while (calls === priorCalls) await Bun.sleep(10);
    const running = await settle(started.id, ["running"]);
    await daemonResult(operator(), "jobs.control", {
      id: started.id,
      action: "cancel",
      revision: running.revision,
      idempotencyKey: `${item.id}-cancel`,
    });
    release();
    const cancelled = await settle(started.id);
    expect(cancelled).toMatchObject({ state: "cancelled", proposalIds: [], effects: null });
  } finally {
    release();
  }
}

async function runStaleSource(item: EvaluationCase): Promise<void> {
  const path = item.sources[0];
  const original = await readFile(join(root, path), "utf8");
  const edited = `${original}\nEdited during analysis.\n`;
  onModelCall = () => writeFile(join(root, path), edited);
  try {
    const stale = await settle((await run(item)).id);
    expect(stale.state).toBe("failed");
    expect(stale.failure?.code).toBe("CONFLICT");
    expect(stale.proposalIds).toEqual([]);
    expect(stale.previewId).toBeNull();
    expect(await readFile(join(root, path), "utf8")).toBe(edited);
  } finally {
    await writeFile(join(root, path), original);
    if (AGED_NOTES.includes(path)) await age(path);
  }
}

async function runPermissionChange(item: EvaluationCase): Promise<void> {
  const pending = await daemonResult(operator(), "pairing.create", {
    label: item.id,
    kind: "agent",
    scopes: ["read", "write"],
  });
  const credential = await NotientClient.pair(
    String(pending.endpoint),
    String(pending.code),
    String(pending.vaultId),
  );
  const writer = new NotientClient({
    endpoint: String(pending.endpoint),
    token: credential.token,
    vaultId: credential.vaultId,
  });
  onModelCall = async () => {
    await daemonResult(operator(), "pairing.revoke", { id: credential.credentialId });
  };
  const revoked = await settle((await run(item, writer)).id);
  expect(revoked).toMatchObject({ state: "cancelled", proposalIds: [], effects: null });
  await expect(run(item, writer, `${item.id}-after-revocation`)).rejects.toThrow();
}

const RUNNERS: Record<EvaluationCase["kind"], (item: EvaluationCase) => Promise<void>> = {
  positive: runOutcome,
  abstain: runOutcome,
  "provider-failure": runProviderFailure,
  interruption: runInterruption,
  "stale-source": runStaleSource,
  "permission-change": runPermissionChange,
};
