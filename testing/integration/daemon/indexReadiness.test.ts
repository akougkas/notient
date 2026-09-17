import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsVault } from "../../../src/adapters/fsVault";
import { ReasoningScheduler } from "../../../src/core/coordinator/reasoningScheduler";
import { applySchema } from "../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../src/core/db/surreal";
import { EventBus } from "../../../src/core/events/eventBus";
import { Embedder } from "../../../src/core/indexer/embedder";
import { Extractor } from "../../../src/core/indexer/extractor";
import { indexNote } from "../../../src/core/indexer/indexNote";
import { IndexerQueue } from "../../../src/core/indexer/indexerQueue";
import type { LLMProvider } from "../../../src/core/llm/provider";
import { Reranker } from "../../../src/core/search/reranker";
import { SearchPipeline } from "../../../src/core/search/searchPipeline";
import { DaemonMutationJournal } from "../../../src/core/vault/daemonMutationJournal";
import { type SurrealServerHandle, startSurreal } from "../../../src/daemon/surrealServer";
import { VaultWatcher } from "../../../src/daemon/watcher";

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] readiness follows durable lexical commits, failures, retries and restart",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-readiness-"));
    const vaultPath = join(root, "vault");
    await mkdir(vaultPath);
    await writeFile(
      join(vaultPath, "SWMR.md"),
      "# SWMR\n\nDurability requires the writer to flush.\n",
    );
    let server: SurrealServerHandle | undefined;
    let db: SurrealConnection | undefined;
    let watcher: VaultWatcher | undefined;
    let queue: IndexerQueue | undefined;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    let inferenceCalls = 0;
    const forbidden = async (): Promise<never> => {
      inferenceCalls++;
      throw new Error("Structural indexing must not invoke inference");
    };
    const provider: LLMProvider = {
      isAvailable: async () => false,
      chat: forbidden,
      chatJson: forbidden,
      embed: forbidden,
      chatStream: async function* () {
        yield await forbidden();
      },
    };
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    const bus = new EventBus();
    try {
      server = await startSurreal({
        dataDir: join(root, "db"),
        secret: "readiness-test",
        portFile: join(root, "port"),
        pidFile: join(root, "pid"),
        logLevel: "warn",
        hnswCacheMib: 64,
      });
      db = await connect({
        url: server.url,
        user: "root",
        pass: "readiness-test",
        namespace: "notient",
        database: "vault",
      });
      const connection = db;
      await applySchema(db.db, "readiness-test", { embedDim: 768, embedModel: "unused" });
      const createQueue = () =>
        new IndexerQueue({
          bus,
          debounceMs: 1,
          isExcluded: () => false,
          indexNote: async (path) => {
            attempts++;
            await gate;
            return indexNote({
              notePath: path,
              noteBody: await readFile(join(vaultPath, path), "utf8"),
              surrealDb: connection,
              bus,
              tierFilter: [1],
              vaultPaths: ["SWMR.md"],
              chunkSizes: { targetTokens: 320, maxTokens: 480 },
              embedder: new Embedder(provider, {
                identity: { model: "unused", dimension: 768 },
                concurrency: 1,
              }),
              extractor: new Extractor(provider, { model: "unused", scheduler, concurrency: 1 }),
              runLinker: { agentName: "linker", execute: forbidden },
            });
          },
        });
      const createWatcher = (indexer: IndexerQueue) =>
        new VaultWatcher({
          root: vaultPath,
          surrealDb: connection,
          bus,
          readiness: indexer.readiness,
          enqueue: (path) => indexer.enqueue(path),
          forcePolling: true,
          pollingInterval: 25,
          activity: { recordHumanActivity: () => {}, recordDeletion: () => {} },
          mutationJournal: new DaemonMutationJournal(),
          approvalIntents: { cancelForNoteDeletion: async () => ({ cancelled: 0, failed: 0 }) },
          isExcluded: () => false,
        });
      queue = createQueue();
      watcher = createWatcher(queue);
      const pipeline = new SearchPipeline({
        db: db.db,
        vault: new FsVault(vaultPath),
        indexing: () => {
          if (!queue) throw new Error("indexer not initialized");
          return queue.readiness.snapshot();
        },
        provider,
        reasoningModel: "unused",
        scheduler,
        embed: forbidden,
        reranker: new Reranker({ provider, model: "unused", bus }),
        settings: () => ({
          balanced: { topK: 10, rerankTopN: 10 },
          deep: { synthesisEnabled: false },
        }),
      });
      const search = () =>
        pipeline.retrieve(
          { query: "Durability", mode: "lexical", scope: {}, limit: 10 },
          new AbortController().signal,
        );
      expect(queue.readiness.snapshot().state).toBe("scanning");
      await watcher.start();
      expect(queue.readiness.snapshot()).toMatchObject({
        state: "indexing",
        total: 1,
        current: 0,
        pending: 1,
      });
      const early = await search();
      expect(early.hits).toEqual([]);
      expect(early.coverage.state).toBe("incomplete");
      release();
      await queue.drain();
      expect(queue.readiness.snapshot()).toMatchObject({
        state: "current",
        current: 1,
        pending: 0,
      });
      const indexed = await search();
      expect(indexed.hits.map((hit) => hit.note.path)).toEqual(["SWMR.md"]);
      expect(indexed.coverage.state).toBe("current");

      // Fail inside the actual lexical-chunk transaction, after Tier 1 structure.
      await db.db
        .query(
          'DEFINE EVENT readiness_failure ON chunk WHEN $event = "CREATE" THEN { THROW "injected lexical commit failure"; };',
        )
        .collect();
      const priorAttempts = attempts;
      await writeFile(
        join(vaultPath, "SWMR.md"),
        "# SWMR\n\nDurability requires readers to refresh after a flush.\n",
      );
      const deadline = performance.now() + 5000;
      while (attempts === priorAttempts && performance.now() < deadline) await Bun.sleep(25);
      expect(attempts).toBeGreaterThan(priorAttempts);
      await watcher.drain();
      await queue.drain();
      expect(queue.pendingCount()).toBe(0);
      expect(queue.readiness.snapshot()).toMatchObject({ state: "failed", failed: 1, current: 0 });
      expect(queue.readiness.snapshot().failures[0]?.message).toContain("failed transaction");
      expect((await search()).coverage.state).toBe("incomplete");
      await db.db.query("REMOVE EVENT readiness_failure ON chunk;").collect();
      queue.enqueue("SWMR.md");
      await queue.drain();
      expect(queue.readiness.snapshot()).toMatchObject({ state: "current", current: 1, failed: 0 });
      expect((await search()).hits[0]?.evidence?.quote).toContain("refresh");

      // A transient failure after a valid receipt recovers even if Tier 1 is skipped.
      queue.readiness.failed("SWMR.md", "temporary read failure");
      queue.enqueue("SWMR.md");
      await queue.drain();
      expect(queue.readiness.snapshot().state).toBe("current");
      await watcher.stop();
      expect(queue.readiness.snapshot().state).toBe("paused");
      queue.dispose();
      queue = createQueue();
      watcher = createWatcher(queue);
      const beforeRestart = attempts;
      await watcher.start();
      await queue.drain();
      expect(attempts).toBe(beforeRestart);
      expect(queue.readiness.snapshot()).toMatchObject({ state: "current", total: 1, current: 1 });
      for await (const event of pipeline.run(
        { query: "Durability", mode: "quick", limit: 10 },
        new AbortController().signal,
      )) {
        if (event.type === "search:error") throw new Error(event.message);
        if (event.type === "search:done") {
          expect(event.result.hits[0]?.notePath).toBe("SWMR.md");
          expect(event.result.coverage.state).toBe("current");
        }
      }
      expect(inferenceCalls).toBe(0);
    } finally {
      release();
      await watcher?.stop();
      await queue?.drain();
      queue?.dispose();
      await db?.close();
      await server?.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
