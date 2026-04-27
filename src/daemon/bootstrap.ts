import { Linker } from "../core/agents/linker";
import { MaturityAdvancer } from "../core/agents/maturityAdvancer";
import { ContradictionHunter } from "../core/agents/contradictionHunter";
import { Synthesizer } from "../core/agents/synthesizer";
import { Coordinator } from "../core/coordinator/coordinator";
import { ReasoningMutex } from "../core/coordinator/reasoningMutex";
import { Database } from "../core/db/database";
import { EventBus } from "../core/events/eventBus";
import { GraphStore } from "../core/graph/graphStore";
import { Embedder } from "../core/indexer/embedder";
import { Extractor } from "../core/indexer/extractor";
import { HnswVectorIndex } from "../core/indexer/hnswVectorIndex";
import { IndexerQueue } from "../core/indexer/indexerQueue";
import { indexNote } from "../core/indexer/indexNote";
import { Kernel } from "../core/kernel";
import { LMStudioProvider } from "../core/llm/lmStudioProvider";
import { Reranker } from "../core/search/reranker";
import { SavedQueries } from "../core/search/savedQueries";
import { SearchHistory } from "../core/search/searchHistory";
import { SearchPipeline } from "../core/search/searchPipeline";
import { EchoGuard } from "../core/services/echoGuard";
import { HealthMonitor } from "../core/services/healthMonitor";
import { IdleDetector } from "../core/services/idleDetector";
import { VaultBootstrap } from "../core/services/vaultBootstrap";
import { VaultLock, type VaultLockHandle } from "../core/services/vaultLock";
import { type ConfigStore, SettingsService } from "../core/settings/settingsService";
import { VitalsService } from "../core/vitals/vitalsService";
import { FsVault } from "../adapters/fsVault";

export interface BootstrapOptions {
  vaultPath: string;
  /** Override for LM Studio base URL when testing. Defaults to settings. */
  baseUrlOverride?: string;
  /** When true, seal kernel with phase: "A". Default phase: "B". */
  phaseA?: boolean;
}

export interface BootstrapResult {
  kernel: Kernel;
  close: () => Promise<void>;
}

const NOTIENT_DIR = ".notient";
const DB_PATH = `${NOTIENT_DIR}/notient.db`;
const WASM_PATH = `${NOTIENT_DIR}/sql-wasm.wasm`;
const LOCK_PATH = `${NOTIENT_DIR}/notient.lock`;
const VECTOR_PATH = `${NOTIENT_DIR}/vectors.bin`;
const CONFIG_PATH = `${NOTIENT_DIR}/config.json`;

const NOTIENT_FOLDER = "Notient";
const CONVERSATIONS_FOLDER = `${NOTIENT_FOLDER}/conversations`;
const PROPOSALS_FOLDER = `${NOTIENT_FOLDER}/proposals`;
const SAVED_QUERIES_FOLDER = `${NOTIENT_FOLDER}/searches`;
const SIDECAR_PATH = `${NOTIENT_FOLDER}/.index.json`;

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const vault = new FsVault(options.vaultPath);
  const bus = new EventBus();
  const echoGuard = new EchoGuard();

  const configStore: ConfigStore = {
    load: async () => {
      const raw = await vault.read(CONFIG_PATH).catch(() => null);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    },
    save: async (value) => {
      await vault.write(CONFIG_PATH, JSON.stringify(value, null, 2));
    },
  };
  const settings = new SettingsService(configStore, bus);
  await settings.load();
  const current = settings.get();

  const lockFs = {
    exists: (path: string) => vault.exists(path),
    read: (path: string) => vault.read(path),
    writeBinary: (path: string, data: ArrayBuffer) => vault.writeBinary(path, data),
    remove: (path: string) => vault.remove(path),
  };
  const lock = new VaultLock(
    lockFs,
    LOCK_PATH,
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const lockHandle: VaultLockHandle = await lock.acquire();

  const database = new Database(
    {
      readBinary: (path) => vault.readBinary(path),
      writeBinary: (path, data) => vault.writeBinary(path, data),
    },
    { dbPath: DB_PATH, wasmPath: WASM_PATH },
  );
  await database.init();
  const graph = new GraphStore(database);

  const baseUrl = options.baseUrlOverride ?? current.primary.baseUrl;
  const primaryLLM = new LMStudioProvider({ baseUrl });
  const deepLLM = new LMStudioProvider({ baseUrl: current.deep.baseUrl });
  const embeddingLLM = new LMStudioProvider({ baseUrl: current.embedding.baseUrl });

  const health = new HealthMonitor(
    [
      { label: "primary", baseUrl, provider: primaryLLM },
      { label: "deep", baseUrl: current.deep.baseUrl, provider: deepLLM },
      { label: "embedding", baseUrl: current.embedding.baseUrl, provider: embeddingLLM },
    ],
    bus,
    { intervalMs: 30_000 },
  );

  const phaseA = options.phaseA === true;

  // Phase A registers and seals here.
  const kernel = new Kernel();
  kernel.register("bus", bus);
  kernel.register("settings", settings);
  kernel.register("vault", vault);
  kernel.register("database", database);
  kernel.register("graph", graph);
  kernel.register("primaryLLM", primaryLLM);
  kernel.register("deepLLM", deepLLM);
  kernel.register("embeddingLLM", embeddingLLM);
  kernel.register("health", health);
  kernel.register("lock", lockHandle);
  kernel.register("echoGuard", echoGuard);

  if (phaseA) {
    kernel.seal({ phase: "A" });
    health.start();
    return {
      kernel,
      close: makeClose({ database, lockHandle, health, vectorIndex: null, vault, vectorPath: VECTOR_PATH }),
    };
  }

  // Phase B additions.
  const vectorIndex = new HnswVectorIndex({});
  const existingVectorBytes = await vault.readBinary(VECTOR_PATH);
  if (existingVectorBytes) {
    await vectorIndex.load(existingVectorBytes);
  }

  const embedder = new Embedder(embeddingLLM, { model: current.embedding.model });
  const extractor = new Extractor(deepLLM, { model: current.deep.reasoningModel });

  const indexer = new IndexerQueue({
    bus,
    indexNote: async (path) => {
      const body = await vault.read(path);
      return await indexNote({
        notePath: path,
        noteBody: body,
        database,
        graph,
        vectorIndex,
        embedder,
        extractor,
        bus,
      });
    },
  });

  const vaultBootstrap = new VaultBootstrap({
    facade: {
      exists: (path) => vault.exists(path),
      createFolder: (path) => vault.createFolder(path),
    },
  });
  await vaultBootstrap.run({
    conversationsFolder: CONVERSATIONS_FOLDER,
    proposalsFolder: PROPOSALS_FOLDER,
    savedQueriesFolder: SAVED_QUERIES_FOLDER,
  });

  const idleDetector = new IdleDetector(bus, {});
  const reasoningMutex = new ReasoningMutex();

  const reranker = new Reranker({
    provider: deepLLM,
    model: current.deep.rerankerModel,
  });

  const searchPipeline = new SearchPipeline({
    db: database,
    vectorIndex,
    reranker,
    embed: async (text, signal) => {
      const vectors = await embedder.embed([text], signal);
      return vectors.length > 0 ? new Float32Array(vectors[0]) : null;
    },
    provider: deepLLM,
    reasoningModel: current.deep.reasoningModel,
    settings: () => current.search,
  });

  const savedQueries = new SavedQueries({
    facade: {
      list: (folder) => vault.list(folder).then((listing) => listing.files),
      read: (path) => vault.read(path),
      write: (path, content) => vault.write(path, content),
      delete: (path) => vault.remove(path),
    },
    folder: SAVED_QUERIES_FOLDER,
    now: () => Date.now(),
  });

  const searchHistory = new SearchHistory({
    facade: {
      readSidecar: async () => {
        const raw = await vault.read(SIDECAR_PATH).catch(() => null);
        if (raw === null) return null;
        try {
          return JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return null;
        }
      },
      writeSidecar: async (value) => {
        await vault.write(SIDECAR_PATH, JSON.stringify(value, null, 2));
      },
    },
    maxQueries: current.search.history.maxQueries,
  });

  const vitalsService = new VitalsService({
    db: database,
    now: () => Date.now(),
    settings: () => current.vitals,
    facade: {
      updateFrontmatter: (path, patch) => vault.updateFrontmatter(path, patch),
      readNote: (path) => vault.read(path),
      writeNote: (path, content) => vault.write(path, content),
    },
    echoGuard: { mark: (path, sha) => echoGuard.mark(path, sha) },
  });

  const linker = new Linker({
    db: database,
    provider: deepLLM,
    reasoningModel: current.deep.reasoningModel,
    neighborhood: async (notePath, opts) => {
      return [];
    },
  });
  const synthesizer = new Synthesizer({
    db: database,
    provider: deepLLM,
    reasoningModel: current.deep.reasoningModel,
    epsilon: 0.35,
    minClusterSize: 3,
    sinceMs: 7 * 24 * 60 * 60 * 1000,
  });
  const contradictionHunter = new ContradictionHunter({
    db: database,
    provider: deepLLM,
    reasoningModel: current.deep.reasoningModel,
    neighbors: async (claimIds, opts) => {
      return [];
    },
    maxPairs: 5,
  });
  const maturityAdvancer = new MaturityAdvancer({
    db: database,
    facade: {
      read: (path) => vault.read(path),
      write: (path, content) => vault.write(path, content),
    },
    echoGuard,
    hash: async (input) => {
      const buffer = new TextEncoder().encode(input);
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    },
  });

  const coordinator = new Coordinator({
    bus,
    db: database,
    mutex: reasoningMutex,
    agents: {
      linker,
      synthesizer,
      contradictionHunter,
      maturityAdvancer,
    },
  });

  kernel.register("indexer", indexer);
  kernel.register("vectorIndex", vectorIndex);
  kernel.register("embedder", embedder);
  kernel.register("extractor", extractor);
  kernel.register("vaultBootstrap", vaultBootstrap);
  kernel.register("idleDetector", idleDetector);
  kernel.register("reasoningMutex", reasoningMutex);
  kernel.register("searchPipeline", searchPipeline);
  kernel.register("savedQueries", savedQueries);
  kernel.register("searchHistory", searchHistory);
  kernel.register("vitalsService", vitalsService);
  kernel.register("coordinator", coordinator);
  kernel.seal({ phase: "B" });

  health.start();
  idleDetector.start();

  return {
    kernel,
    close: makeClose({ database, lockHandle, health, vectorIndex, vault, vectorPath: VECTOR_PATH }),
  };
}

interface CloseDeps {
  database: Database;
  lockHandle: VaultLockHandle;
  health: HealthMonitor;
  vectorIndex: HnswVectorIndex | null;
  vault: FsVault;
  vectorPath: string;
}

function makeClose(deps: CloseDeps): () => Promise<void> {
  return async (): Promise<void> => {
    deps.health.stop();
    if (deps.vectorIndex) {
      try {
        const bytes = await deps.vectorIndex.persist();
        await deps.vault.writeBinary(deps.vectorPath, bytes);
      } catch (error) {
        // Vector persistence is best-effort: a failure here must not block the
        // database flush or the lock release. Surface to the daemon's stderr
        // emitter via a thrown re-attempt in Phase E if we want to escalate.
        process.stderr.write(
          `${JSON.stringify({ type: "daemon:vector_persist_failed", message: error instanceof Error ? error.message : String(error) })}\n`,
        );
      }
    }
    await deps.database.persist();
    await deps.database.close();
    await deps.lockHandle.release();
  };
}
