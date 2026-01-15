import type { HierarchicalNSW, HnswlibModule } from "hnswlib-wasm";
import type { HNSWConfig, VectorCommand, VectorResult } from "../core/vector/workerBridge";

let lib: HnswlibModule | null = null;
let index: HierarchicalNSW | null = null;

// Mapping management
const idToLabel = new Map<string, number>();
const labelToId = new Map<number, string>();
let nextLabel = 0;
const deletedLabels = new Set<number>();
let globalConfig: HNSWConfig | null = null;
let currentDimension = 0;

// HNSW index filename (stored in IDBFS)
const HNSW_FILENAME = "notient_hnsw.bin";

// Initialize WASM with IDBFS support
const initPromise = (async () => {
  try {
    const { loadHnswlib, waitForFileSystemInitalized } = await import("hnswlib-wasm");
    lib = await loadHnswlib("IDBFS");
    await waitForFileSystemInitalized();
  } catch (err) {
    postResult({ type: "error", message: `Failed to load hnswlib: ${err}` });
  }
})();

function postResult(result: VectorResult) {
  self.postMessage(result);
}

self.onmessage = async (e: MessageEvent<VectorCommand>) => {
  await initPromise;
  if (!lib) return;

  const cmd = e.data;

  try {
    switch (cmd.type) {
      case "init":
        handleInit(cmd.config);
        break;
      case "search":
        handleSearch(cmd.embedding, cmd.k, cmd.requestId);
        break;
      case "addItems":
        handleAddItems(cmd.items);
        break;
      case "markDeleted":
        handleMarkDeleted(cmd.ids);
        break;
      case "save":
        await handleSave();
        break;
      case "load":
        await handleLoad(cmd.data);
        break;
      case "getCount":
        handleGetCount(cmd.requestId);
        break;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    postResult({ type: "error", message });
  }
};

function handleInit(config: HNSWConfig) {
  globalConfig = config;
  postResult({ type: "ready" });
}

function ensureIndex(dimension: number) {
  if (!lib || !globalConfig) throw new Error("Not initialized");
  if (index && currentDimension === dimension) return;
  // Note: HierarchicalNSW doesn't have a free() method, just reassign

  currentDimension = dimension;
  // HierarchicalNSW requires (spaceName, numDimensions, autoSaveFilename)
  index = new lib.HierarchicalNSW(globalConfig.metric, dimension, "");
  index.initIndex(
    globalConfig.initialMaxElements,
    globalConfig.M,
    globalConfig.efConstruction,
    100, // random seed
  );
  index.setEfSearch(globalConfig.efSearch);
}

function handleSearch(embedding: Float32Array, k: number, requestId: string) {
  if (!index) {
    postResult({ type: "searchResult", requestId, results: [] });
    return;
  }

  try {
    const result = index.searchKnn(embedding, k, (label) => !deletedLabels.has(label));

    const mappedResults: { id: string; score: number }[] = [];
    for (let i = 0; i < result.neighbors.length; i++) {
      const label = result.neighbors[i];
      const distance = result.distances[i];
      const id = labelToId.get(label);
      if (id) {
        mappedResults.push({ id, score: 1 - distance });
      }
    }

    postResult({ type: "searchResult", requestId, results: mappedResults });
  } catch (err) {
    console.warn("Search failed", err);
    postResult({ type: "searchResult", requestId, results: [] });
  }
}

function handleAddItems(items: Array<{ id: string; embedding: Float32Array }>) {
  if (items.length === 0) {
    postResult({ type: "addComplete", count: 0 });
    return;
  }

  const dimension = items[0].embedding.length;
  ensureIndex(dimension);
  if (!index) return;

  // Resize if needed
  const currentMax = index.getMaxElements();
  const needed = index.getCurrentCount() + items.length;
  if (needed > currentMax) {
    index.resizeIndex(Math.max(needed * 2, currentMax * 2));
  }

  const embeddings: Float32Array[] = [];
  const labels: number[] = [];

  for (const item of items) {
    let label = idToLabel.get(item.id);
    if (label === undefined) {
      label = nextLabel++;
      idToLabel.set(item.id, label);
      labelToId.set(label, item.id);
    }
    // If it was deleted, un-delete it
    deletedLabels.delete(label);

    labels.push(label);
    embeddings.push(item.embedding);
  }

  for (let i = 0; i < items.length; i++) {
    // addPoint requires (point, label, replaceDeleted)
    index.addPoint(embeddings[i], labels[i], false);
  }

  postResult({ type: "addComplete", count: items.length });
}

function handleMarkDeleted(ids: string[]) {
  if (!index) return;
  for (const id of ids) {
    const label = idToLabel.get(id);
    if (label !== undefined) {
      try {
        index.markDelete(label);
        deletedLabels.add(label);
      } catch (e) {
        // ignore
      }
    }
  }
}

function handleGetCount(requestId: string) {
  const count = index ? index.getCurrentCount() : 0;
  postResult({ type: "countResult", requestId, count });
}

async function handleSave() {
  if (!lib || !index) {
    throw new Error("No index to save");
  }

  // Write index to Emscripten virtual filesystem
  await index.writeIndex(HNSW_FILENAME);

  // Sync to IndexedDB (IDBFS)
  await new Promise<void>((resolve) => {
    lib?.EmscriptenFileSystemManager.syncFS(false, () => {
      resolve();
    });
  });

  // Build mapping JSON to return (caller stores this alongside the fact that IDBFS has the index)
  const mapping = {
    nextLabel,
    currentDimension,
    idToLabel: Array.from(idToLabel.entries()),
    deletedLabels: Array.from(deletedLabels),
  };

  postResult({ type: "saveComplete", mapping: JSON.stringify(mapping) });
}

async function handleLoad(data: { mapping?: string }) {
  if (!lib || !globalConfig) return;

  // Sync from IndexedDB to get persisted index (if it exists)
  await new Promise<void>((resolve) => {
    lib?.EmscriptenFileSystemManager.syncFS(true, () => {
      resolve();
    });
  });

  // Load mapping if provided
  if (data.mapping) {
    const mapping = JSON.parse(data.mapping);
    nextLabel = mapping.nextLabel ?? 0;
    currentDimension = mapping.currentDimension ?? 0;

    idToLabel.clear();
    labelToId.clear();
    deletedLabels.clear();

    for (const [id, label] of mapping.idToLabel ?? []) {
      idToLabel.set(id, label);
      labelToId.set(label, id);
    }
    for (const label of mapping.deletedLabels ?? []) {
      deletedLabels.add(label);
    }
  }

  // Check if HNSW index exists in IDBFS
  const indexExists = lib.EmscriptenFileSystemManager.checkFileExists(HNSW_FILENAME);

  if (indexExists && currentDimension > 0) {
    ensureIndex(currentDimension);
    if (index) {
      const maxElements = Math.max(globalConfig.initialMaxElements, idToLabel.size + 1000);
      await index.readIndex(HNSW_FILENAME, maxElements);
    }
    postResult({ type: "loadComplete", count: index?.getCurrentCount() ?? 0 });
  } else {
    // No persisted index, signal that rehydration is needed
    postResult({ type: "loadComplete", count: 0, needsRehydration: true });
  }
}
