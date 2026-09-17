import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsVault } from "../../../../src/adapters/fsVault";
import { VaultMutationBlockedError } from "../../../../src/adapters/vaultAdapter";
import { contentRevision } from "../../../../src/api/notes";
import type { PipelineJob } from "../../../../src/api/pipelines";
import { ApprovalService } from "../../../../src/core/approvals/approvalService";
import { ReasoningScheduler } from "../../../../src/core/coordinator/reasoningScheduler";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { DurableNoteWriter } from "../../../../src/core/history/durableNoteWriter";
import { Embedder } from "../../../../src/core/indexer/embedder";
import { Extractor } from "../../../../src/core/indexer/extractor";
import { createEmbeddingIdentity } from "../../../../src/core/llm/embeddingIdentity";
import { LMStudioProvider } from "../../../../src/core/llm/lmStudioProvider";
import { JobStore } from "../../../../src/core/pipelines/jobStore";
import { Reranker } from "../../../../src/core/search/reranker";
import { SearchPipeline } from "../../../../src/core/search/searchPipeline";
import { SentienceActivity } from "../../../../src/core/services/sentienceActivity";
import { resolveSettings } from "../../../../src/core/settings/envOverrides";
import { SettingsService } from "../../../../src/core/settings/settingsService";
import { DEFAULT_NOTIENT_CONFIG } from "../../../../src/core/settings/types";
import { makePipelineServices } from "../../../../src/daemon/pipelines";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import { pipelineJobFixture } from "../../../pipelineJobFixture";

const enabled = process.env.NOTIENT_SMOKE === "1";
const human = { id: "human", kind: "human" as const, scopes: ["read", "write", "admin"] };
const body =
  "# Durable storage\n\nWrite-ahead logging preserves committed transactions after a crash.\n";

describe.skipIf(!enabled)("[smoke] finite durable pipeline execution", () => {
  let root: string;
  let db: SurrealConnection;
  let database: SurrealServerHandle;
  let server: ReturnType<typeof Bun.serve>;
  let available = true;
  let calls = 0;
  let invalidResponses = 0;
  let structuredResponse: unknown = null;
  let finishReason = "stop";
  let modelRequests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  let hold: Promise<void> | null = null;
  let release: (() => void) | null = null;
  let availabilityHold: Promise<void> | null = null;
  let releaseAvailability: (() => void) | null = null;
  let availabilityRequested = false;
  let services: ReturnType<typeof makePipelineServices> | null = null;
  let activity: SentienceActivity | null = null;
  let vaultRoot: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-pipelines-test-"));
    database = await startSurreal({
      dataDir: join(root, "data"),
      secret: "pipeline-test",
      portFile: join(root, "port"),
      pidFile: join(root, "pid"),
      logLevel: "warn",
      hnswCacheMib: 64,
    });
    db = await connect({
      url: database.url,
      user: "root",
      pass: "pipeline-test",
      namespace: "notient",
      database: "vault",
    });
    await applySchema(db.db, "pipeline-test", { embedDim: null, embedModel: null });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (new URL(request.url).pathname.endsWith("/models")) {
          availabilityRequested = true;
          if (availabilityHold) await availabilityHold;
          return Response.json({ data: [{ id: "test-model" }] }, { status: available ? 200 : 503 });
        }
        calls++;
        modelRequests.push(
          (await request.json()) as { messages: Array<{ role: string; content: string }> },
        );
        const invalid = invalidResponses-- > 0;
        if (hold) await hold;
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  finishReason === "length"
                    ? ""
                    : JSON.stringify(
                        structuredResponse ?? {
                          suggestions: [
                            {
                              note: 0,
                              summary: "",
                              tags: [invalid ? "file reconciliation" : "durability"],
                              aliases: ["Crash recovery"],
                              reason:
                                "The note explains transaction recovery using a write-ahead log.",
                              evidence: [
                                {
                                  note: 0,
                                  quote:
                                    "Write-ahead logging preserves committed transactions after a crash.",
                                },
                              ],
                            },
                          ],
                          abstention: null,
                        },
                      ),
                reasoning_content: "Private synthetic reasoning.",
              },
              finish_reason: finishReason,
            },
          ],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 350,
            total_tokens: 550,
            completion_tokens_details: { reasoning_tokens: 250 },
          },
        });
      },
    });
  }, 30000);
  afterEach(async () => {
    release?.();
    release = null;
    hold = null;
    releaseAvailability?.();
    releaseAvailability = null;
    availabilityHold = null;
    availabilityRequested = false;
    services?.coordinator.stop();
    await services?.jobs.stop();
    services = null;
    activity?.stop();
    activity = null;
    await db.db
      .query(
        "DELETE pipeline_job; DELETE job_control_receipt; DELETE proposal_review; DELETE change_preview; DELETE history; DELETE note_write_intent;",
      )
      .collect();
    if (vaultRoot) await rm(vaultRoot, { recursive: true, force: true });
    calls = 0;
    invalidResponses = 0;
    structuredResponse = null;
    finishReason = "stop";
    modelRequests = [];
    available = true;
  });
  afterAll(async () => {
    await server?.stop(true);
    await db?.close();
    await database?.stop();
    await rm(root, { recursive: true, force: true });
  });
  async function fixture(beforeMutation?: () => Promise<undefined>) {
    vaultRoot = await mkdtemp(join(root, "vault-"));
    await writeFile(join(vaultRoot, "Storage.md"), body);
    const vault = new FsVault(vaultRoot, {
      recoveryDir: join(vaultRoot, ".recovery"),
      beforeMutation,
    });
    const config = structuredClone(DEFAULT_NOTIENT_CONFIG);
    let persisted = JSON.stringify(config);
    const settings = new SettingsService(
      resolveSettings(config, {
        NOTIENT_LLM_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
        NOTIENT_LLM_MODEL: "test-model",
      }),
      {
        config,
        load: async () => persisted,
        compareAndSwap: async (before, after) => {
          if (before !== persisted) return false;
          persisted = after;
          return true;
        },
      },
    );
    const bus = new EventBus();
    const provider = new LMStudioProvider({ baseUrl: `http://127.0.0.1:${server.port}/v1` });
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    const writer = new DurableNoteWriter({
      db: db.db,
      vault,
      hash: async (value) => contentRevision(value),
      authorizeRecovery: async (intent) => {
        if (intent.previewId && services)
          await services.changes.authorizeRecoveredEffect({ previewId: intent.previewId }, intent);
      },
    });
    const approvals = new ApprovalService({
      db: db.db,
      vault,
      bus,
      hash: async (value) => contentRevision(value),
      pruneHistory: async () => {},
    });
    const embedder = new Embedder(provider, {
      identity: createEmbeddingIdentity("", null),
      concurrency: 1,
    });
    const extractor = new Extractor(provider, { model: "test-model", concurrency: 1, scheduler });
    const search = new SearchPipeline({
      db: db.db,
      vault,
      provider,
      reasoningModel: "test-model",
      scheduler,
      embed: async () => null,
      reranker: new Reranker({ provider, model: "test-model", bus }),
      settings: () => settings.get().search,
    });
    activity = new SentienceActivity(bus, { loadActiveNote: async () => null });
    await activity.start();
    services = makePipelineServices({
      db: db.db,
      vault,
      settings,
      bus,
      writer,
      approvals,
      embedder,
      extractor,
      scheduler,
      search,
      provider,
      activity,
    });
    return { ...services, settings, approvals, vault, bus, writer };
  }
  async function settled(
    id: string,
    states = ["completed", "awaiting-approval", "failed", "cancelled", "partial"],
  ): Promise<PipelineJob> {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const job = await services?.jobs.options.store.get(id);
      if (job && states.includes(job.state)) return job;
      await Bun.sleep(10);
    }
    throw new Error(
      `job did not settle: ${JSON.stringify(await services?.jobs.options.store.get(id))}`,
    );
  }
  const input = (key: string) => ({
    pipeline: "enrich",
    sources: [{ path: "Storage.md", revision: contentRevision(body) }],
    preview: false,
    idempotencyKey: key,
  });

  test("fresh configuration and old idle ladder cause no AI work", async () => {
    const f = await fixture();
    f.coordinator.start();
    f.bus.emit({
      type: "sentience:idle",
      epoch: 1,
      rung: "mature",
      idleForMs: 9999999,
      activeNotePath: "Storage.md",
    });
    f.bus.emit({
      type: "sentience:activity",
      epoch: 2,
      source: "vault:change",
      activeNotePath: "Storage.md",
    });
    await f.coordinator.tick();
    expect(await f.jobs.options.store.list()).toEqual([]);
    expect(calls).toBe(0);
  });
  test("concurrent live submissions bind a key to one request and one provider execution", async () => {
    const f = await fixture();
    await expect(
      f.jobs.run(input("readonly"), { ...human, scopes: ["read"] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      f.jobs.run(
        { ...input("stale"), sources: [{ path: "Storage.md", revision: "0".repeat(64) }] },
        human,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const submitted = await Promise.all([
      f.jobs.run(input("same"), human),
      f.jobs.run(input("same"), human),
    ]);
    expect(submitted[0].id).toBe(submitted[1].id);
    await settled(submitted[0].id);
    expect(calls).toBe(1);
    const conflicting = await Promise.allSettled([
      f.jobs.run(input("different"), human),
      f.jobs.run({ ...input("different"), preview: true }, human),
    ]);
    expect(conflicting.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(conflicting.find((item) => item.status === "rejected")).toMatchObject({
      reason: { code: "CONFLICT" },
    });
  });
  test("schema correction is bounded, charged and excludes hidden reasoning", async () => {
    const f = await fixture();
    invalidResponses = 1;
    const job = await settled((await f.jobs.run(input("schema-correction"), human)).id);
    expect(job.state).toBe("awaiting-approval");
    expect(calls).toBe(2);
    expect(job.runAttempts).toBe(1);
    expect(job.attempts.map((attempt) => attempt.chargedTokens)).toEqual([550, 550]);
    expect(modelRequests[1].messages.at(-1)?.content).toContain("failed runtime validation");
    expect(modelRequests[1].messages.at(-2)?.role).toBe("assistant");
    expect(JSON.stringify(modelRequests[1])).not.toContain("Private synthetic reasoning");
    expect(await f.vault.read("Storage.md")).toBe(body);
  });
  test("a retry resumes after fractional active time without resetting charged usage", async () => {
    const f = await fixture();
    invalidResponses = 2;
    const queued = await f.jobs.run(input("fractional-retry"), human);
    const waiting = await settled(queued.id, ["waiting-inference"]);
    await f.jobs.idle();
    expect(waiting.attempts).toHaveLength(2);
    expect(waiting.runAttempts).toBe(1);
    await f.jobs.options.store.update(queued.id, (draft) => {
      draft.activeDurationMs = Math.floor(draft.activeDurationMs) + 0.5;
      draft.nextAttemptAt = 0;
    });
    await f.jobs.pump();
    const retried = await settled(queued.id);
    expect(retried.state).toBe("awaiting-approval");
    expect(retried.runAttempts).toBe(2);
    expect(retried.attempts.map((attempt) => attempt.chargedTokens)).toEqual([550, 550, 550]);
    expect(calls).toBe(3);
    expect(await f.vault.read("Storage.md")).toBe(body);
  });
  test("retrying an exhausted duration fails before another provider call", async () => {
    const f = await fixture();
    const configuration = f.settings.background();
    const policy = configuration.settings.pipelines.enrich;
    const failed = await f.jobs.options.store.create(
      pipelineJobFixture({
        id: randomUUID(),
        caller: human,
        policy,
        configurationRevision: configuration.revision,
        activeDurationMs: policy.budget.durationMs,
        sourceRevisions: input("duration").sources,
      }),
    );
    await f.jobs.control(
      {
        id: failed.id,
        action: "retry",
        revision: failed.revision,
        idempotencyKey: "duration-retry",
      },
      human,
    );
    const exhausted = await settled(failed.id);
    expect(exhausted).toMatchObject({ state: "failed", failure: { code: "LIMIT_EXCEEDED" } });
    expect(calls).toBe(0);
    expect(exhausted.attempts).toEqual([]);
  });
  test("an active inference deadline is a terminal budget failure with reserved usage and no effects", async () => {
    const f = await fixture();
    const before = f.settings.background();
    const next = structuredClone(before.settings);
    next.pipelines.enrich.budget.durationMs = 1000;
    next.pipelines.enrich.budget.retries = 2;
    await f.settings.updateBackground(next, before.revision);
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = await f.jobs.run(input("active-duration"), human);
    const exhausted = await settled(queued.id);
    expect(exhausted).toMatchObject({
      state: "failed",
      failure: { code: "LIMIT_EXCEEDED", message: "inference duration budget exhausted" },
      effects: null,
      proposalIds: [],
      nextAttemptAt: null,
    });
    expect(calls).toBe(1);
    expect(exhausted.runAttempts).toBe(1);
    expect(exhausted.attempts[0].accounting).toBe("reserved-estimate");
    expect(exhausted.attempts[0].chargedTokens).toBeGreaterThan(0);
    expect(await f.vault.read("Storage.md")).toBe(body);
  });
  test("a truncated reasoning response retains measured usage without identical automatic replay", async () => {
    const f = await fixture();
    finishReason = "length";
    const exhausted = await settled((await f.jobs.run(input("reasoning-truncated"), human)).id);
    expect(exhausted).toMatchObject({
      state: "failed",
      failure: { code: "LIMIT_EXCEEDED" },
      effects: null,
      proposalIds: [],
      nextAttemptAt: null,
      runAttempts: 1,
    });
    expect(exhausted.failure?.message).toContain("reasoning and final output");
    expect(calls).toBe(1);
    expect(exhausted.attempts).toHaveLength(1);
    expect(exhausted.attempts[0]).toMatchObject({
      accounting: "provider-total",
      chargedTokens: 550,
    });
    expect(await f.vault.read("Storage.md")).toBe(body);
  });
  test("comparison abstention retains its source-specific explanation without staging effects", async () => {
    const f = await fixture();
    const historical =
      "# Historical storage\n\nThe 2024 prototype did not use write-ahead logging.\n";
    await writeFile(join(vaultRoot, "Historical.md"), historical);
    structuredResponse = {
      comparisons: [
        {
          source: 0,
          target: 1,
          judgment: "insufficient",
          assessment: 0,
          explanation:
            "The 2024 prototype and the current storage design have different time scopes; these passages do not establish a same-time conflict.",
          evidence: [
            {
              note: 0,
              quote: "Write-ahead logging preserves committed transactions after a crash.",
            },
            { note: 1, quote: "The 2024 prototype did not use write-ahead logging." },
          ],
        },
      ],
      abstention: null,
    };
    const job = await settled(
      (
        await f.jobs.run(
          {
            pipeline: "contradictions",
            sources: [
              { path: "Storage.md", revision: contentRevision(body) },
              { path: "Historical.md", revision: contentRevision(historical) },
            ],
            idempotencyKey: "qualified-comparison",
          },
          human,
        )
      ).id,
    );
    expect(job.state).toBe("completed");
    expect(job.plan?.abstained).toBe(true);
    expect(job.plan?.reason).toContain("different time scopes");
    expect(job.plan?.reason).toContain("Historical.md");
    expect(job.proposalIds).toEqual([]);
    expect(job.effects).toBeNull();
  });
  test.each(["no-retries", "one-call"])(
    "schema correction respects %s policy",
    async (constraint) => {
      const f = await fixture();
      const before = f.settings.background();
      const next = structuredClone(before.settings);
      if (constraint === "no-retries") next.pipelines.enrich.budget.retries = 0;
      else next.pipelines.enrich.budget.modelCalls = 1;
      await f.settings.updateBackground(next, before.revision);
      invalidResponses = 1;
      const job = await settled((await f.jobs.run(input(constraint), human)).id);
      expect(job.state).toBe("failed");
      expect(calls).toBe(1);
      expect(job.attempts).toHaveLength(1);
      expect(job.proposalIds).toEqual([]);
      expect(await f.vault.read("Storage.md")).toBe(body);
    },
  );
  test("recovered detached jobs recheck revoked caller authority before inference", async () => {
    const f = await fixture();
    const caller = {
      id: `paired-${randomUUID()}`,
      kind: "agent" as const,
      scopes: ["read", "write"],
    };
    f.jobs.options.authorizeCaller = () => {
      throw new Error("credential revoked");
    };
    const job = await f.jobs.options.store.create(
      pipelineJobFixture({ id: randomUUID(), state: "running", caller }),
    );
    await f.jobs.recover();
    await f.jobs.pump();
    const recovered = await f.jobs.options.store.get(job.id);
    expect(recovered).toMatchObject({
      state: "failed",
      failure: { code: "FORBIDDEN", message: "credential revoked" },
      proposalIds: [],
      effects: null,
    });
    expect(calls).toBe(0);
    expect(await f.vault.read("Storage.md")).toBe(body);
  });
  test("job controls are revision guarded, durable, exactly replayable and permission checked", async () => {
    const f = await fixture();
    f.jobs.suspend();
    const store = f.jobs.options.store;
    const queued = await store.create(pipelineJobFixture({ state: "queued" }));
    const owner = queued.caller;
    const request = {
      id: queued.id,
      action: "pause",
      revision: queued.revision,
      idempotencyKey: "pause-once",
    } as const;
    await expect(f.jobs.control(request, { ...owner, scopes: ["read"] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(f.jobs.control(request, { ...owner, id: "other-agent" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const [first, second] = await Promise.all([
      f.jobs.control(request, owner),
      f.jobs.control(request, owner),
    ]);
    expect(first.state).toBe("paused");
    expect(second).toEqual(first);
    expect(first.stage).toBe("paused");
    await expect(f.jobs.control({ ...request, action: "cancel" }, owner)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      f.jobs.control({ ...request, idempotencyKey: "stale" }, owner),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const cancelled = await f.jobs.control(
      { ...request, action: "cancel", revision: first.revision, idempotencyKey: "cancel-once" },
      owner,
    );
    expect(cancelled.state).toBe("cancelled");
    // Reconstruct the store: receipts survive process-local queues and later job changes.
    const replay = await new JobStore(db.db).control(owner, request, () => {
      throw new Error("must not replay transition");
    });
    expect(replay).toEqual({ job: first, replayed: true });
    expect((await store.get(queued.id))?.revision).toBe(cancelled.revision);
    await expect(f.jobs.control(request, { ...owner, scopes: ["read"] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const foreign = await store.create(
      pipelineJobFixture({ id: randomUUID(), state: "queued", background: true }),
    );
    await expect(
      f.jobs.control(
        { ...request, id: foreign.id, revision: foreign.revision, idempotencyKey: "background" },
        owner,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      f.jobs.control({ ...request, id: foreign.id, revision: foreign.revision }, human),
    ).resolves.toMatchObject({ state: "paused" });
  });
  test("job controls enforce the transition table without changing completed outcomes", async () => {
    const f = await fixture();
    f.jobs.suspend();
    const transitions = {
      pause: { queued: "paused", running: "paused", "waiting-inference": "paused" },
      cancel: {
        queued: "cancelled",
        running: "cancelled",
        "waiting-inference": "cancelled",
        paused: "cancelled",
      },
      resume: { paused: "queued" },
      retry: { failed: "queued", partial: "queued", "waiting-inference": "queued" },
    };
    for (const action of ["pause", "cancel", "resume", "retry"] as const) {
      for (const state of [
        "queued",
        "running",
        "paused",
        "waiting-inference",
        "completed",
        "awaiting-approval",
        "failed",
        "partial",
        "cancelled",
      ] as const) {
        const job = await f.jobs.options.store.create(
          pipelineJobFixture({ id: randomUUID(), state }),
        );
        const request = {
          id: job.id,
          action,
          revision: job.revision,
          idempotencyKey: `${action}-${state}`,
        };
        const expected = (transitions[action] as Partial<Record<string, PipelineJob["state"]>>)[
          state
        ];
        if (expected) expect((await f.jobs.control(request, human)).state).toBe(expected);
        else {
          await expect(f.jobs.control(request, human)).rejects.toMatchObject({ code: "CONFLICT" });
          expect(await f.jobs.options.store.get(job.id)).toEqual(job);
        }
      }
    }
    expect(calls).toBe(0);
  });
  test("concurrent control key reuse across jobs commits exactly one transition", async () => {
    const f = await fixture();
    f.jobs.suspend();
    const first = await f.jobs.options.store.create(
      pipelineJobFixture({ id: randomUUID(), state: "paused" }),
    );
    const second = await f.jobs.options.store.create(
      pipelineJobFixture({ id: randomUUID(), state: "paused" }),
    );
    const outcomes = await Promise.allSettled(
      [first, second].map((job) =>
        f.jobs.control(
          {
            id: job.id,
            action: "cancel",
            revision: job.revision,
            idempotencyKey: "shared-control-key",
          },
          human,
        ),
      ),
    );
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((item) => item.status === "rejected")).toMatchObject({
      reason: { code: "CONFLICT" },
    });
    const states = (await f.jobs.options.store.list()).map((job) => job.state).sort();
    expect(states).toEqual(["cancelled", "paused"]);
  });
  test.each([true, false])(
    "a paused job stays paused when a pending inference availability check returns %s",
    async (respondAvailable) => {
      const f = await fixture();
      availabilityHold = new Promise<void>((resolve) => {
        releaseAvailability = resolve;
      });
      available = respondAvailable;
      const queued = await f.jobs.run(input("pause-during-admission"), human);
      const deadline = performance.now() + 3000;
      while (!availabilityRequested && performance.now() < deadline) await Bun.sleep(5);
      expect(availabilityRequested).toBe(true);
      await f.jobs.control(
        { id: queued.id, action: "pause", revision: queued.revision, idempotencyKey: "pause" },
        human,
      );
      releaseAvailability?.();
      await f.jobs.idle();
      expect((await f.jobs.options.store.get(queued.id))?.state).toBe("paused");
      expect(calls).toBe(0);
    },
  );
  test("cancelling a running model call preserves its reserved charge and prevents proposals and effects", async () => {
    const f = await fixture();
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = await f.jobs.run(input("cancel-running"), human);
    const deadline = performance.now() + 3000;
    while (!calls && performance.now() < deadline) await Bun.sleep(5);
    expect(calls).toBe(1);
    const running = await f.jobs.options.store.get(queued.id);
    if (!running) throw new Error("job missing");
    const request = {
      id: queued.id,
      action: "cancel",
      revision: running.revision,
      idempotencyKey: "cancel",
    };
    const receipt = await f.jobs.control(request, human);
    await f.jobs.idle();
    const cancelled = await f.jobs.options.store.get(queued.id);
    expect(cancelled).toMatchObject({ state: "cancelled", effects: null, proposalIds: [] });
    expect(cancelled?.attempts[0].chargedTokens).toBeGreaterThan(0);
    expect(cancelled?.attempts[0].accounting).toBe("reserved-estimate");
    expect(await f.vault.read("Storage.md")).toBe(body);
    expect(await f.jobs.control(request, human)).toEqual(receipt);
  });
  test("live enrichment persists measured usage, exact preview and one applied receipt", async () => {
    const f = await fixture();
    const queued = await f.jobs.run(input("live"), human);
    const job = await settled(queued.id);
    expect(job.state).toBe("awaiting-approval");
    expect(job.attempts[0].chargedTokens).toBe(550);
    expect(job.attempts[0].completion?.usage.reasoningTokens).toBe(250);
    expect(job.attempts[0].completion?.usage.visibleAnswerTokens).toBe(null);
    expect(await f.vault.read("Storage.md")).toBe(body);
    if (!job.previewId || !job.previewRevision) throw new Error("missing exact preview");
    const request = {
      id: job.proposalIds[0],
      previewId: job.previewId,
      previewRevision: job.previewRevision,
      idempotencyKey: "reviewed",
    };
    const receipt = await f.approvals.applyReview(
      request,
      human,
      f.changes,
      new AbortController().signal,
    );
    expect(receipt.state).toBe("applied");
    expect(
      await f.approvals.applyReview(request, human, f.changes, new AbortController().signal),
    ).toEqual(receipt);
    expect(await f.vault.read("Storage.md")).toContain("durability");
    expect((await f.jobs.options.store.get(job.id))?.state).toBe("completed");
    expect((await f.jobs.run(input("live"), human)).id).toBe(job.id);
    expect(calls).toBe(1);
  });

  test("rejecting a partially applied review preserves receipts and prevents blocked writes on restart", async () => {
    const f = await fixture();
    await f.vault.createIfAbsent("Second.md", body);
    const sources = ["Storage.md", "Second.md"].map((path) => ({
      path,
      revision: contentRevision(body),
    }));
    const job = await f.jobs.options.store.create(
      pipelineJobFixture({
        id: randomUUID(),
        caller: human,
        state: "completed",
        preview: true,
        sourceRevisions: sources,
        failure: null,
      }),
    );
    const staged = await f.approvals.stagePipelinePlan(
      job,
      {
        pipeline: "enrich",
        summary: "A reviewed annotation.",
        abstained: false,
        reason: null,
        sources,
        extractions: [],
        relationships: [],
        findings: [
          {
            kind: "summary",
            title: "Recovery",
            explanation: "Keep the existing recovery evidence.",
            evidence: [
              {
                ...sources[0],
                quote: body,
                range: { start: 0, end: body.length, startLine: 1, endLine: 4 },
              },
            ],
          },
        ],
        changes: sources.map((source) => ({
          kind: "append",
          source,
          text: "\nReviewed annotation.\n",
        })),
      },
      f.changes,
      new AbortController().signal,
    );
    expect(staged.proposalIds).toHaveLength(1);
    await f.jobs.options.store.update(job.id, (draft) => Object.assign(draft, staged));
    const write = f.vault.writeIfUnchanged.bind(f.vault);
    f.vault.writeIfUnchanged = async (...args) => {
      if (args[0] === "Second.md") throw new VaultMutationBlockedError("Unsaved editor");
      return write(...args);
    };
    const result = await f.approvals.applyReview(
      {
        id: staged.proposalIds[0],
        previewId: staged.previewId!,
        previewRevision: staged.previewRevision!,
        idempotencyKey: "partial-review",
      },
      human,
      f.changes,
      new AbortController().signal,
    );
    expect(result.state).toBe("partial");
    const partial = await f.approvals.getReview(staged.proposalIds[0]);
    expect(partial.appliedHistory).toHaveLength(1);
    const rejected = await f.approvals.rejectReview(
      { id: partial.id, revision: partial.revision, idempotencyKey: "reject-remainder" },
      human,
    );
    expect(rejected.appliedHistory).toEqual(partial.appliedHistory);
    expect((await f.jobs.options.store.get(job.id))?.stage).toBe("remaining-changes-rejected");
    f.vault.writeIfUnchanged = write;
    const recovered = await new DurableNoteWriter({
      db: db.db,
      vault: f.vault,
      hash: async (value) => contentRevision(value),
    }).reconcilePendingWrites();
    expect(recovered).toEqual({ replayed: 0, abandoned: 1, failed: 0, deferred: 0 });
    expect(await f.vault.read("Storage.md")).toContain("Reviewed annotation.");
    expect(await f.vault.read("Second.md")).toBe(body);
    await expect(
      f.changes.apply(
        {
          previewId: staged.previewId!,
          previewRevision: staged.previewRevision!,
          idempotencyKey: "bypass-rejection",
        },
        human,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls).toBe(0);
  });
  test("cancellation racing with a committed effect retains the effect receipt", async () => {
    const f = await fixture();
    const before = f.settings.background();
    const next = structuredClone(before.settings);
    Object.assign(next.pipelines.enrich, {
      mode: "apply",
      effects: ["properties"],
      allowedSections: [],
    });
    await f.settings.updateBackground(next, before.revision);
    let effectCommitted = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const apply = f.jobs.options.apply;
    f.jobs.options.apply = async (...args) => {
      const receipt = await apply(...args);
      effectCommitted = true;
      await gate;
      return receipt;
    };
    const queued = await f.jobs.run(input("cancel-after-write"), human);
    const deadline = performance.now() + 3000;
    while (!effectCommitted && performance.now() < deadline) await Bun.sleep(5);
    expect(effectCommitted).toBe(true);
    const current = await f.jobs.options.store.get(queued.id);
    if (!current) throw new Error("missing job");
    // Approval reconciliation can finish the job as part of the effect commit.
    // A completed job cannot be relabelled cancelled; an in-flight one retains its receipt.
    const request = {
      id: current.id,
      action: "cancel",
      revision: current.revision,
      idempotencyKey: "after-write",
    };
    if (current.state === "completed")
      await expect(f.jobs.control(request, human)).rejects.toMatchObject({ code: "CONFLICT" });
    else await f.jobs.control(request, human);
    release?.();
    await f.jobs.idle();
    expect((await f.jobs.options.store.get(queued.id))?.effects?.state).toBe("applied");
    expect(await f.vault.read("Storage.md")).toContain("durability");
  });
  test("job inspection is bounded, revision-stable, permission checked and durable", async () => {
    const f = await fixture();
    const first = await f.jobs.run(input("inspection-one"), human);
    await settled(first.id);
    const second = await f.jobs.run(input("inspection-two"), human);
    await settled(second.id);
    const page = await f.jobs.list({ limit: 1, pipeline: "enrich" }, human);
    expect(page.jobs).toHaveLength(1);
    expect(page.jobs[0].modelCalls).toBe(1);
    expect(page.jobs[0].chargedTokens).toBe(550);
    expect(page.jobs[0]).not.toHaveProperty("plan");
    expect(page.jobs[0]).not.toHaveProperty("policy");
    expect(page.nextCursor).not.toBeNull();
    const next = await f.jobs.list(
      { limit: 1, pipeline: "enrich", cursor: page.nextCursor },
      human,
    );
    expect(next.jobs).toHaveLength(1);
    expect(next.jobs[0].id).not.toBe(page.jobs[0].id);
    expect(next.nextCursor).toBeNull();
    const detail = await f.jobs.get(
      { id: first.id },
      { id: "codex", kind: "agent", scopes: ["read"] },
    );
    expect(detail.job.plan?.findings.length).toBeGreaterThan(0);
    expect(detail.job.plan).not.toHaveProperty("extractions");
    expect(detail.job.attempts[0].completion?.usage.reasoningTokens).toBe(250);
    expect((await new JobStore(db.db).get(first.id))?.revision).toBe(detail.job.revision);
    await expect(f.jobs.list({}, { ...human, scopes: [] })).rejects.toThrow("read authority");
    await expect(f.jobs.get({ id: first.id }, { ...human, scopes: ["write"] })).rejects.toThrow(
      "read authority",
    );
    await expect(f.jobs.list({ cursor: "invalid" }, human)).rejects.toThrow("invalid jobs cursor");
    await expect(
      f.jobs.list({ pipeline: "archive", cursor: page.nextCursor }, human),
    ).rejects.toThrow("filters changed");
    await f.jobs.options.store.update(first.id, (job) => {
      job.stage = "observed-test-transition";
    });
    await expect(
      f.jobs.list({ pipeline: "enrich", cursor: page.nextCursor }, human),
    ).rejects.toThrow("inventory or filters changed");
    expect(calls).toBe(2);
  });
  test("explicit background metadata policy acts without a second approval and ignores derived save events", async () => {
    const f = await fixture();
    const before = f.settings.background();
    const next = structuredClone(before.settings);
    Object.assign(next.pipelines.enrich, {
      enabled: true,
      triggers: ["save"],
      debounceMs: 0,
      cooldownMs: 0,
      mode: "apply",
      effects: ["properties"],
    });
    next.pipelines.enrich.allowedSections = [];
    await f.settings.updateBackground(next, before.revision);
    f.coordinator.start();
    f.bus.emit({
      type: "sentience:activity",
      epoch: 2,
      source: "vault:change",
      activeNotePath: "Storage.md",
    });
    await f.coordinator.tick();
    const [queued] = await f.jobs.options.store.list();
    expect(queued?.background).toBe(true);
    const job = await settled(queued.id);
    expect(job.state).toBe("completed");
    expect(job.effects?.state).toBe("applied");
    f.bus.emit({
      type: "vault:note-saved",
      path: "Storage.md",
      sha: contentRevision(await f.vault.read("Storage.md")),
    });
    await f.coordinator.tick();
    expect(await f.jobs.options.store.list()).toHaveLength(1);
  });
  test("changing a running job's own policy revokes it before proposals or file effects", async () => {
    const f = await fixture();
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = await f.jobs.run(input("revocation"), human);
    const deadline = performance.now() + 3000;
    while (!calls && performance.now() < deadline) await Bun.sleep(5);
    expect(calls).toBe(1);
    const before = f.settings.background();
    const next = structuredClone(before.settings);
    next.pipelines.enrich.allowedProperties = [];
    await f.settings.updateBackground(next, before.revision);
    release?.();
    const job = await settled(queued.id);
    expect(job.state).toBe("cancelled");
    expect((await f.approvals.pageReview({}, new AbortController().signal)).proposals).toEqual([]);
    expect(await f.vault.read("Storage.md")).toBe(body);
    expect(job.attempts[0].chargedTokens).toBeGreaterThan(0);
  });
  test("background pause leaves a manual run intact but stops an explicitly enabled background run", async () => {
    const f = await fixture();
    let before = f.settings.background();
    let next = structuredClone(before.settings);
    next.pipelines.enrich.enabled = true;
    next.pipelines.enrich.triggers = ["save"];
    await f.settings.updateBackground(next, before.revision);
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manual = await f.jobs.run(input("manual-during-pause"), human);
    const deadline = performance.now() + 3000;
    while (!calls && performance.now() < deadline) await Bun.sleep(5);
    expect(calls).toBe(1);
    before = f.settings.background();
    next = structuredClone(before.settings);
    next.paused = true;
    await f.settings.updateBackground(next, before.revision);
    release?.();
    expect((await settled(manual.id)).state).toBe("awaiting-approval");
    before = f.settings.background();
    next = structuredClone(before.settings);
    next.paused = false;
    await f.settings.updateBackground(next, before.revision);
    calls = 0;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const background = await f.jobs.run(input("background-during-pause"), human, {
      reason: "explicit test trigger",
      key: "background-pause",
    });
    const until = performance.now() + 3000;
    while (!calls && performance.now() < until) await Bun.sleep(5);
    expect(calls).toBe(1);
    before = f.settings.background();
    next = structuredClone(before.settings);
    next.paused = true;
    await f.settings.updateBackground(next, before.revision);
    release?.();
    expect((await settled(background.id)).state).toBe("cancelled");
    expect(await f.vault.read("Storage.md")).toBe(body);
  });
  test.each(["pause", "policy", "cancel"] as const)(
    "interrupted automatic effects honor durable %s before filesystem recovery",
    async (revocation) => {
      let blocked = true;
      const f = await fixture(async () => {
        if (blocked) throw new VaultMutationBlockedError("simulated disconnected host");
        return undefined;
      });
      let before = f.settings.background();
      let next = structuredClone(before.settings);
      next.pipelines.enrich.enabled = true;
      next.pipelines.enrich.triggers = ["save"];
      next.pipelines.enrich.mode = "apply";
      next.pipelines.enrich.effects = ["properties"];
      await f.settings.updateBackground(next, before.revision);
      const admitted = await f.jobs.run(input(`recovery-${revocation}`), human, {
        reason: "explicit fixture trigger",
        key: `recovery-${revocation}`,
      });
      const interrupted = await settled(admitted.id);
      expect(interrupted.proposalIds).toHaveLength(1);
      expect(await f.vault.read("Storage.md")).toBe(body);
      f.jobs.suspend();
      await f.jobs.idle();
      // Recreate the durable running state at a crash before the filesystem CAS.
      await f.jobs.options.store.update(admitted.id, (draft) => {
        draft.state = revocation === "cancel" ? "cancelled" : "running";
      });
      if (revocation !== "cancel") {
        before = f.settings.background();
        next = structuredClone(before.settings);
        if (revocation === "pause") next.paused = true;
        else next.pipelines.enrich.writeScope.folders = ["Elsewhere"];
        await f.settings.updateBackground(next, before.revision);
      }
      blocked = false;
      const recovered = await f.writer.reconcilePendingWrites();
      expect(recovered.abandoned).toBe(1);
      expect(recovered.failed).toBe(0);
      expect(await f.vault.read("Storage.md")).toBe(body);
      expect((await f.approvals.getReview(interrupted.proposalIds[0])).state).toBe("pending");
    },
  );
  test("outage waits durably without consuming model calls, then resumes", async () => {
    const f = await fixture();
    available = false;
    const queued = await f.jobs.run(input("outage"), human);
    const waiting = await settled(queued.id, ["waiting-inference"]);
    expect(waiting.attempts).toEqual([]);
    expect(calls).toBe(0);
    f.jobs.suspend();
    await f.jobs.idle();
    available = true;
    await f.jobs.options.store.update(waiting.id, (draft) => {
      draft.nextAttemptAt = 0;
    });
    f.jobs.resume();
    expect((await settled(queued.id)).state).toBe("awaiting-approval");
  });
  test("rejection suppresses unchanged evidence", async () => {
    const f = await fixture();
    const first = await settled((await f.jobs.run(input("reject-first"), human)).id);
    const proposal = await f.approvals.getReview(first.proposalIds[0]);
    await f.approvals.rejectReview(
      { id: proposal.id, revision: proposal.revision, idempotencyKey: "reject" },
      human,
    );
    const second = await settled((await f.jobs.run(input("reject-second"), human)).id);
    expect(second.proposalIds).toEqual([]);
    expect(await f.vault.read("Storage.md")).toBe(body);
  });
  test("a token ceiling smaller than the prompt prevents provider dispatch", async () => {
    const f = await fixture();
    const before = f.settings.background();
    const next = structuredClone(before.settings);
    next.pipelines.enrich.budget.tokens = 10;
    next.pipelines.enrich.budget.retries = 0;
    await f.settings.updateBackground(next, before.revision);
    const job = await settled((await f.jobs.run(input("small-budget"), human)).id);
    expect(job.state).toBe("failed");
    expect(calls).toBe(0);
    expect(await f.vault.read("Storage.md")).toBe(body);
  });
});
