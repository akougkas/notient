import { Notice, Plugin, TFile } from "obsidian";
import { ObsidianFacade } from "./adapters/obsidianFacade";
import { ContradictionHunter } from "./core/agents/contradictionHunter";
import { Linker } from "./core/agents/linker";
import { MaturityAdvancer } from "./core/agents/maturityAdvancer";
import { Synthesizer } from "./core/agents/synthesizer";
import { ApprovalService } from "./core/approvals/approvalService";
import { CoAuthorService } from "./core/coAuthor/chatStream";
import { Coordinator } from "./core/coordinator/coordinator";
import { ReasoningMutex } from "./core/coordinator/reasoningMutex";
import { Database } from "./core/db/database";
import { EventBus } from "./core/events/eventBus";
import { GraphStore } from "./core/graph/graphStore";
import { Embedder } from "./core/indexer/embedder";
import { Extractor } from "./core/indexer/extractor";
import { HnswVectorIndex } from "./core/indexer/hnswVectorIndex";
import { indexNote } from "./core/indexer/indexNote";
import { IndexerQueue } from "./core/indexer/indexerQueue";
import {
  IndexerWorkerClient,
  type IndexerWorkerEmbedConfig,
  type IndexerWorkerExtractConfig,
} from "./core/indexer/indexerWorkerClient";
import { Kernel } from "./core/kernel";
import { LMStudioProvider } from "./core/llm/lmStudioProvider";
import { EchoGuard } from "./core/services/echoGuard";
import { HealthMonitor } from "./core/services/healthMonitor";
import { IdleDetector } from "./core/services/idleDetector";
import { VaultLock, type VaultLockHandle } from "./core/services/vaultLock";
import { NotientSettingsTab } from "./core/settings/SettingsTab";
import { SettingsService } from "./core/settings/settingsService";
import { ApprovalsView, VIEW_TYPE_NOTIENT_APPROVALS } from "./ui/approvals/ApprovalsView";
import { CoAuthorView, VIEW_TYPE_NOTIENT_CO_AUTHOR } from "./ui/coAuthor/CoAuthorView";
import { AwakenVaultModal } from "./ui/onboarding/AwakenVaultModal";
import { AwakenRunner } from "./ui/onboarding/awakenRunner";
import { GraphCanvasModel } from "./ui/onboarding/graphCanvas";
import { NotientSidebarView, VIEW_TYPE_NOTIENT } from "./ui/sidebar/SidebarView";

const PLUGIN_DIR = ".obsidian/plugins/notient";
const DB_PATH = `${PLUGIN_DIR}/notient.db`;
const WASM_PATH = `${PLUGIN_DIR}/sql-wasm.wasm`;
const LOCK_PATH = `${PLUGIN_DIR}/notient.lock`;
const VECTOR_PATH = `${PLUGIN_DIR}/vectors.bin`;
const INDEXER_WORKER_PATH = `${PLUGIN_DIR}/indexer.worker.js`;

export default class NotientPlugin extends Plugin {
  kernel = new Kernel();
  bus = new EventBus();
  settings!: SettingsService;
  private lockHandle: VaultLockHandle | null = null;
  echoGuard = new EchoGuard();
  indexOne!: (path: string) => Promise<unknown>;
  private indexerWorkerClient: IndexerWorkerClient | null = null;

  async onload(): Promise<void> {
    console.log("[Notient] onload");

    this.settings = new SettingsService(this, this.bus);
    await this.settings.load();
    this.addSettingTab(new NotientSettingsTab(this.app, this, this.settings));

    const adapter = this.app.vault.adapter;
    const lock = new VaultLock(
      {
        exists: (path) => adapter.exists(path),
        read: (path) => adapter.read(path),
        writeBinary: (path, data) => adapter.writeBinary(path, data),
        remove: (path) => adapter.remove(path),
      },
      LOCK_PATH,
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );

    try {
      this.lockHandle = await lock.acquire();
    } catch (error) {
      new Notice(`Notient: ${(error as Error).message}`);
      throw error;
    }

    const database = new Database(
      {
        readBinary: async (path) =>
          (await adapter.exists(path)) ? await adapter.readBinary(path) : null,
        writeBinary: (path, data) => adapter.writeBinary(path, data),
      },
      { dbPath: DB_PATH, wasmPath: WASM_PATH },
    );
    await database.init();

    const facade = new ObsidianFacade(this.app);
    const graph = new GraphStore(database);

    const current = this.settings.get();
    const primaryLLM = new LMStudioProvider({ baseUrl: current.primary.baseUrl });
    const deepLLM = new LMStudioProvider({ baseUrl: current.deep.baseUrl });

    const vectorIndex = new HnswVectorIndex({ maxElements: 50_000 });
    if (await adapter.exists(VECTOR_PATH)) {
      const blob = await adapter.readBinary(VECTOR_PATH);
      await vectorIndex.load(blob);
    } else {
      await vectorIndex.init(768); // nomic-embed-text-v2-moe
    }

    const embedder = new Embedder(primaryLLM, {
      model: current.primary.embeddingModel,
      batchSize: 16,
    });
    const extractor = new Extractor(primaryLLM, {
      model: current.primary.fastModel,
      concurrency: 4,
    });

    let indexerWorkerClient: IndexerWorkerClient | null = null;
    try {
      const resourcePath = adapter.getResourcePath(INDEXER_WORKER_PATH);
      indexerWorkerClient = new IndexerWorkerClient(
        () => new Worker(resourcePath, { type: "module" }),
      );
    } catch (error) {
      console.warn("[Notient] indexer worker spawn failed, falling back to inline pipeline", error);
    }
    this.indexerWorkerClient = indexerWorkerClient;

    const workerEmbedConfig: IndexerWorkerEmbedConfig = {
      baseUrl: current.primary.baseUrl,
      model: current.primary.embeddingModel,
      batchSize: 16,
    };
    const workerExtractConfig: IndexerWorkerExtractConfig = {
      baseUrl: current.primary.baseUrl,
      model: current.primary.fastModel,
      concurrency: 4,
    };

    const indexOne = async (path: string): Promise<unknown> => {
      const body = await facade.read(path);
      const result = await indexNote({
        notePath: path,
        noteBody: body,
        database,
        graph,
        vectorIndex,
        embedder,
        extractor,
        bus: this.bus,
        workerClient: indexerWorkerClient ?? undefined,
        workerEmbedConfig: indexerWorkerClient ? workerEmbedConfig : undefined,
        workerExtractConfig: indexerWorkerClient ? workerExtractConfig : undefined,
      });
      await database.persist();
      await adapter.writeBinary(VECTOR_PATH, await vectorIndex.persist());
      return result;
    };
    // Expose indexOne on the plugin instance so the AwakenVaultModal (Task 12)
    // can drive it directly without going through the debouncer.
    this.indexOne = indexOne;

    const indexerQueue = new IndexerQueue({
      indexNote: indexOne,
      debounceMs: 500,
      bus: this.bus,
    });

    // -- Phase 3 Mind layer wiring --
    const reasoningMutex = new ReasoningMutex();
    const idleDetector = new IdleDetector(this.bus);

    const linker = new Linker({
      db: database,
      provider: primaryLLM,
      reasoningModel: current.primary.reasoningModel,
      neighborhood: async (notePath, options) => {
        const head = database.query<{ id: string; vector: Uint8Array; dim: number }>(
          `SELECT e.chunk_id AS id, e.vector AS vector, e.dim AS dim
           FROM embeddings e JOIN chunks c ON c.id = e.chunk_id
           WHERE c.note_path = ? ORDER BY c.ord LIMIT 1;`,
          [notePath],
        );
        if (head.length === 0) return [];
        const view = new Float32Array(
          head[0].vector.buffer,
          head[0].vector.byteOffset,
          head[0].dim,
        );
        const hits = vectorIndex.search(view, options.topK);
        const out: Array<{ notePath: string; chunkId: string; text: string; score: number }> = [];
        for (const hit of hits) {
          const meta = database.query<{ note_path: string; text: string }>(
            "SELECT note_path, text FROM chunks WHERE id = ?;",
            [hit.id],
          );
          if (meta.length === 0) continue;
          if (meta[0].note_path === notePath) continue;
          out.push({
            notePath: meta[0].note_path,
            chunkId: hit.id,
            text: meta[0].text,
            score: hit.score,
          });
        }
        return out;
      },
    });

    const synthesizer = new Synthesizer({
      db: database,
      provider: primaryLLM,
      reasoningModel: current.primary.reasoningModel,
      epsilon: 0.18,
      minClusterSize: 3,
      sinceMs: 24 * 60 * 60 * 1000,
    });

    const contradictionHunter = new ContradictionHunter({
      db: database,
      provider: primaryLLM,
      reasoningModel: current.primary.reasoningModel,
      neighbors: async (recentClaimIds, options) => {
        if (recentClaimIds.length === 0) return [];
        const probe = database.query<{ vector: Uint8Array; dim: number; chunk_id: string }>(
          `SELECT e.vector AS vector, e.dim AS dim, e.chunk_id AS chunk_id
           FROM graph_nodes n JOIN chunks c ON c.note_path = n.note_path
           JOIN embeddings e ON e.chunk_id = c.id
           WHERE n.id = ? LIMIT 1;`,
          [recentClaimIds[0]],
        );
        if (probe.length === 0) return [];
        const view = new Float32Array(
          probe[0].vector.buffer,
          probe[0].vector.byteOffset,
          probe[0].dim,
        );
        const hits = vectorIndex.search(view, options.topK);
        const out: Array<{ id: string; score: number; chunkIds: string[] }> = [];
        for (const hit of hits) {
          const claim = database.query<{ id: string }>(
            `SELECT id FROM graph_nodes WHERE type = 'claim' AND note_path = (
                SELECT note_path FROM chunks WHERE id = ?
             ) LIMIT 1;`,
            [hit.id],
          );
          if (claim.length === 0) continue;
          if (recentClaimIds.includes(claim[0].id)) continue;
          out.push({ id: claim[0].id, score: hit.score, chunkIds: [hit.id] });
        }
        return out;
      },
      maxPairs: 5,
    });

    const maturityAdvancer = new MaturityAdvancer({
      db: database,
      facade,
      echoGuard: this.echoGuard,
      hash: sha256,
    });

    const coordinator = new Coordinator({
      bus: this.bus,
      db: database,
      mutex: reasoningMutex,
      agents: { linker, synthesizer, contradictionHunter, maturityAdvancer },
    });

    const approvalService = new ApprovalService({
      db: database,
      bus: this.bus,
    });

    const coAuthor = new CoAuthorService({
      db: database,
      bus: this.bus,
      provider: primaryLLM,
      reasoningModel: current.primary.reasoningModel,
      readNote: async (path) => facade.read(path),
      neighbors: (path) => {
        const rows = database.query<{ target_id: string }>(
          "SELECT target_id FROM graph_edges WHERE source_id = ? AND approved = 1 LIMIT 10;",
          [`note:${path}`],
        );
        return rows.map((r) => ({
          path: r.target_id.replace(/^note:/, ""),
          title: r.target_id,
          summary: "",
        }));
      },
      minWords: current.coAuthor.minWords,
    });

    const health = new HealthMonitor(
      [
        { label: "primary", baseUrl: current.primary.baseUrl, provider: primaryLLM },
        { label: "deep", baseUrl: current.deep.baseUrl, provider: deepLLM },
      ],
      this.bus,
      { intervalMs: 30_000 },
    );

    this.kernel.register("bus", this.bus);
    this.kernel.register("settings", this.settings);
    this.kernel.register("facade", facade);
    this.kernel.register("database", database);
    this.kernel.register("graph", graph);
    this.kernel.register("primaryLLM", primaryLLM);
    this.kernel.register("deepLLM", deepLLM);
    this.kernel.register("health", health);
    this.kernel.register("lock", this.lockHandle);
    this.kernel.register("echoGuard", this.echoGuard);
    this.kernel.register("vectorIndex", vectorIndex);
    this.kernel.register("embedder", embedder);
    this.kernel.register("extractor", extractor);
    this.kernel.register("indexer", indexerQueue);
    this.kernel.register("reasoningMutex", reasoningMutex);
    this.kernel.register("idleDetector", idleDetector);
    this.kernel.register("coordinator", coordinator);
    this.kernel.register("approvalService", approvalService);
    this.kernel.register("coAuthor", coAuthor);
    this.kernel.seal();

    this.bus.on("llm:health", () => {
      NotientSidebarView.updateFooter(health.current(), facade.listMarkdown().length);
    });

    health.start();
    coordinator.start();
    idleDetector.start();

    let coAuthorAbort: AbortController | null = null;
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const file = this.app.workspace.getActiveFile();
        const path = file?.extension === "md" ? file.path : null;
        const wordRow = path
          ? database.query<{ word_count: number }>("SELECT word_count FROM notes WHERE path = ?;", [
              path,
            ])[0]
          : undefined;
        this.bus.emit({
          type: "active-leaf-change",
          notePath: path,
          wordCount: wordRow?.word_count ?? 0,
        });
        if (coAuthorAbort) coAuthorAbort.abort();
        if (!path) return;
        const ctrl = new AbortController();
        coAuthorAbort = ctrl;
        void reasoningMutex.runPriority("co-author", async (signal) => {
          const merged = mergeSignals(signal, ctrl.signal);
          await coAuthor.runFor(path, merged);
        });
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        idleDetector.recordActivity();
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!(file instanceof TFile)) return;
        if (!file.path.endsWith(".md")) return;
        try {
          const contents = await facade.read(file.path);
          const sha = await sha256(contents);
          if (this.echoGuard.take(file.path, sha)) return;
          this.bus.emit({ type: "vault:note-saved", path: file.path, sha });
          indexerQueue.enqueue(file.path);
        } catch (error) {
          console.error("[Notient] save handler error", error);
        }
      }),
    );

    const openAwakenModal = (): void => {
      const canvasModel = new GraphCanvasModel({ width: 720, height: 420 });
      let countersEl: HTMLElement | null = null;
      let canvasEl: HTMLCanvasElement | null = null;
      let rafHandle = 0;

      const renderCounters = (): void => {
        if (!countersEl) return;
        const c = canvasModel.counts();
        countersEl.empty();
        const pairs: Array<[string, number]> = [
          ["Notes", c.notes],
          ["Concepts", c.concepts],
          ["Claims", c.claims],
          ["Questions", c.questions],
          ["Edges", c.edges],
        ];
        for (const [label, value] of pairs) {
          const stat = countersEl.createDiv({ cls: "stat" });
          stat.createSpan({ cls: "label", text: label });
          stat.createSpan({ cls: "value", text: String(value) });
        }
      };

      const tick = (): void => {
        if (canvasEl) {
          const ctx = canvasEl.getContext("2d");
          if (ctx) canvasModel.draw(ctx, Date.now());
        }
        rafHandle = requestAnimationFrame(tick);
      };

      const nodeOff = this.bus.on("indexer:node-added", (event) => {
        canvasModel.addNode({
          id: event.nodeId,
          type: event.nodeType,
          label: event.label,
        });
        renderCounters();
      });
      const edgeOff = this.bus.on("indexer:edge-added", (event) => {
        canvasModel.addEdge({
          id: event.edgeId,
          sourceId: event.sourceId,
          targetId: event.targetId,
          type: event.edgeType,
        });
        renderCounters();
      });

      const runner = new AwakenRunner({
        listMarkdown: () => facade.listMarkdown(),
        indexNote: this.indexOne,
        batchSize: 10,
      });

      const modal = new AwakenVaultModal(this.app, {
        start: () =>
          runner.start({
            onProgress: () => renderCounters(),
            onComplete: async (c) => {
              const next = { ...this.settings.get(), awakenedAt: Date.now() };
              await this.settings.update(next);
              new Notice(
                `Notient awakened: ${c.totalIndexed} notes in ${(c.durationMs / 1000).toFixed(1)}s`,
              );
            },
            onError: (e) => console.warn("[Notient] awaken error", e),
          }),
        stop: () => runner.stop(),
        isRunning: () => runner.isRunning(),
        totalNotes: () => facade.listMarkdown().length,
        onAttachCanvas: (canvas) => {
          canvasEl = canvas;
          tick();
        },
        onAttachCounters: (el) => {
          countersEl = el;
          renderCounters();
        },
      });

      modal.onClose = ((original) =>
        function (this: AwakenVaultModal): void {
          cancelAnimationFrame(rafHandle);
          nodeOff();
          edgeOff();
          original.call(this);
        })(modal.onClose.bind(modal));

      modal.open();
    };

    this.addCommand({
      id: "awaken-vault",
      name: "Notient: Awaken Vault",
      callback: openAwakenModal,
    });

    if (current.awakenedAt === null) {
      // Defer to next tick so the workspace finishes loading.
      setTimeout(openAwakenModal, 800);
    }

    this.registerView(VIEW_TYPE_NOTIENT, (leaf) => new NotientSidebarView(leaf));
    this.registerView(
      VIEW_TYPE_NOTIENT_CO_AUTHOR,
      (leaf) =>
        new CoAuthorView(leaf, {
          bus: this.bus,
          onCancel: () => coAuthorAbort?.abort(),
        }),
    );
    this.registerView(
      VIEW_TYPE_NOTIENT_APPROVALS,
      (leaf) =>
        new ApprovalsView(leaf, {
          service: approvalService,
          bus: this.bus,
        }),
    );
    this.addRibbonIcon("brain-circuit", "Open Notient", async () => {
      const { workspace } = this.app;
      const existing = workspace.getLeavesOfType(VIEW_TYPE_NOTIENT);
      if (existing.length > 0) {
        workspace.revealLeaf(existing[0]);
        return;
      }
      const leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_NOTIENT, active: true });
        workspace.revealLeaf(leaf);
      }
    });

    NotientSidebarView.updateFooter(health.current(), facade.listMarkdown().length);
    console.log("[Notient] ready");
  }

  async onunload(): Promise<void> {
    console.log("[Notient] onunload");
    if (this.kernel.isSealed()) {
      try {
        this.kernel.get("coordinator").stop();
      } catch {
        // ignore
      }
      try {
        this.kernel.get("idleDetector").stop();
      } catch {
        // ignore
      }
      try {
        this.kernel.get("health").stop();
      } catch {
        // ignore
      }
      try {
        this.kernel.get("indexer").dispose();
      } catch {
        // ignore
      }
      try {
        await this.kernel.get("database").close();
      } catch {
        // ignore
      }
    }
    if (this.indexerWorkerClient) {
      try {
        this.indexerWorkerClient.dispose();
      } catch {
        // ignore
      }
      this.indexerWorkerClient = null;
    }
    if (this.lockHandle) {
      try {
        await this.lockHandle.release();
      } catch {
        // ignore
      }
    }
  }
}

async function sha256(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  else {
    a.addEventListener("abort", cancel, { once: true });
    b.addEventListener("abort", cancel, { once: true });
  }
  return controller.signal;
}
