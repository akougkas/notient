import { defaultPipelinePolicy } from "../src/api/background";
import type { PipelineJob } from "../src/api/pipelines";

export function pipelineJobFixture(overrides: Partial<PipelineJob> = {}): PipelineJob {
  return {
    id: "018f05cd-3f7b-7000-8000-000000000001",
    revision: "a".repeat(64),
    pipeline: "enrich",
    state: "failed",
    caller: { id: "codex", kind: "agent", scopes: ["read", "write"] },
    background: false,
    preview: true,
    reason: "Explicit live invocation",
    createdAt: 100,
    updatedAt: 101,
    sourceRevisions: [],
    configurationRevision: "b".repeat(64),
    policy: defaultPipelinePolicy("enrich"),
    attempts: [],
    runAttempts: 1,
    activeDurationMs: 10,
    stage: "failed",
    progress: { completed: 0, total: 1 },
    plan: null,
    previewId: null,
    previewRevision: null,
    proposalIds: [],
    effects: null,
    failure: { code: "INFERENCE_UNAVAILABLE", message: "Reasoning endpoint unreachable", at: 101 },
    nextAttemptAt: null,
    ...overrides,
  };
}
