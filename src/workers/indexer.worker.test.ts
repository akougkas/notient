/**
 * Tests for the IndexerWorkerClient message protocol.
 *
 * Uses a fake worker (manual postMessage stub) rather than spawning the real
 * Worker so tests stay hermetic and fast. Verifies correlation IDs, error
 * surfacing, cancellation, and disposal behaviour.
 */

import { describe, expect, test } from "bun:test";
import { IndexerWorkerClient, type WorkerLike } from "../core/indexer/indexerWorkerClient";
import type { Chunk, Extraction } from "../core/indexer/types";

interface IncomingRun {
  type: "run";
  id: string;
  notePath: string;
  noteBody: string;
  embedConfig: { baseUrl: string; model: string; batchSize?: number };
  extractConfig: { baseUrl: string; model: string; concurrency?: number };
}

interface IncomingCancel {
  type: "cancel";
  id: string;
}

type IncomingMessage = IncomingRun | IncomingCancel;

class FakeWorker implements WorkerLike {
  posted: IncomingMessage[] = [];
  onmessage: WorkerLike["onmessage"] = null;
  onerror: WorkerLike["onerror"] = null;
  terminated = false;

  postMessage(message: IncomingMessage): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Test helper: simulate a successful result for a given correlation id. */
  emitSuccess(id: string, chunks: Chunk[], vectors: number[][], extraction: Extraction): void {
    if (!this.onmessage) return;
    this.onmessage({
      data: { type: "result", id, ok: true, chunks, vectors, extraction },
    });
  }

  emitFailure(id: string, message: string): void {
    if (!this.onmessage) return;
    this.onmessage({ data: { type: "result", id, ok: false, message } });
  }
}

function makeChunk(id: string, ord: number, text: string): Chunk {
  return { id, notePath: "/n.md", ord, text, sha: "sha", tokenEstimate: 1 };
}

const ARGS = {
  notePath: "/n.md",
  noteBody: "hello world",
  embedConfig: { baseUrl: "http://x/v1", model: "embed", batchSize: 4 },
  extractConfig: { baseUrl: "http://x/v1", model: "reason", concurrency: 2 },
};

describe("IndexerWorkerClient", () => {
  test("posts a run message with a correlation id", async () => {
    const fake = new FakeWorker();
    const client = new IndexerWorkerClient(() => fake);
    const promise = client.run(ARGS);
    expect(fake.posted).toHaveLength(1);
    const sent = fake.posted[0] as IncomingRun;
    expect(sent.type).toBe("run");
    expect(sent.notePath).toBe("/n.md");
    expect(sent.embedConfig.model).toBe("embed");
    expect(typeof sent.id).toBe("string");

    fake.emitSuccess(sent.id, [makeChunk("c0", 0, "hello")], [[0.1, 0.2]], {
      entities: [],
      claims: [],
      questions: [],
    });
    const result = await promise;
    expect(result.chunks).toHaveLength(1);
    expect(result.vectors[0]).toEqual([0.1, 0.2]);
    client.dispose();
  });

  test("correlates results across multiple in-flight runs", async () => {
    const fake = new FakeWorker();
    const client = new IndexerWorkerClient(() => fake);
    const p1 = client.run({ ...ARGS, notePath: "/a.md" });
    const p2 = client.run({ ...ARGS, notePath: "/b.md" });
    expect(fake.posted).toHaveLength(2);
    const id1 = (fake.posted[0] as IncomingRun).id;
    const id2 = (fake.posted[1] as IncomingRun).id;
    expect(id1).not.toBe(id2);

    // Resolve out of order to prove correlation works.
    fake.emitSuccess(id2, [makeChunk("c-b", 0, "b")], [[0.4]], {
      entities: ["B"],
      claims: [],
      questions: [],
    });
    fake.emitSuccess(id1, [makeChunk("c-a", 0, "a")], [[0.3]], {
      entities: ["A"],
      claims: [],
      questions: [],
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.extraction.entities).toEqual(["A"]);
    expect(r2.extraction.entities).toEqual(["B"]);
    client.dispose();
  });

  test("surfaces worker error payloads as rejected promises", async () => {
    const fake = new FakeWorker();
    const client = new IndexerWorkerClient(() => fake);
    const promise = client.run(ARGS);
    const id = (fake.posted[0] as IncomingRun).id;
    fake.emitFailure(id, "embed 503 Service Unavailable");
    await expect(promise).rejects.toThrow(/embed 503/);
    client.dispose();
  });

  test("forwards AbortSignal as a cancel postMessage", async () => {
    const fake = new FakeWorker();
    const client = new IndexerWorkerClient(() => fake);
    const controller = new AbortController();
    const promise = client.run({ ...ARGS, signal: controller.signal });
    const id = (fake.posted[0] as IncomingRun).id;
    controller.abort();
    expect(fake.posted).toHaveLength(2);
    const cancel = fake.posted[1] as IncomingCancel;
    expect(cancel.type).toBe("cancel");
    expect(cancel.id).toBe(id);

    // Simulate the worker honouring the cancel by emitting an error.
    fake.emitFailure(id, "Aborted");
    await expect(promise).rejects.toThrow(/Aborted/);
    client.dispose();
  });

  test("rejects immediately when signal is already aborted", async () => {
    const fake = new FakeWorker();
    const client = new IndexerWorkerClient(() => fake);
    const controller = new AbortController();
    controller.abort();
    await expect(client.run({ ...ARGS, signal: controller.signal })).rejects.toThrow();
    expect(fake.posted).toHaveLength(0);
    client.dispose();
  });

  test("dispose terminates the worker and rejects pending runs", async () => {
    const fake = new FakeWorker();
    const client = new IndexerWorkerClient(() => fake);
    const promise = client.run(ARGS);
    client.dispose();
    expect(fake.terminated).toBe(true);
    await expect(promise).rejects.toThrow(/disposed/);
  });

  test("rejects new runs after dispose", async () => {
    const fake = new FakeWorker();
    const client = new IndexerWorkerClient(() => fake);
    client.dispose();
    await expect(client.run(ARGS)).rejects.toThrow(/disposed/);
  });

  test("ignores result messages with unknown ids", async () => {
    const fake = new FakeWorker();
    const client = new IndexerWorkerClient(() => fake);
    const promise = client.run(ARGS);
    const id = (fake.posted[0] as IncomingRun).id;
    fake.emitSuccess("unrelated-id", [makeChunk("c", 0, "x")], [[0.1]], {
      entities: [],
      claims: [],
      questions: [],
    });
    fake.emitSuccess(id, [makeChunk("c0", 0, "real")], [[0.5]], {
      entities: ["R"],
      claims: [],
      questions: [],
    });
    const result = await promise;
    expect(result.extraction.entities).toEqual(["R"]);
    client.dispose();
  });
});
