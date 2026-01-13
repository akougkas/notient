import type { HnswlibModule, HierarchicalNSW } from "hnswlib-wasm";
import type { VectorCommand, VectorResult, HNSWConfig } from "../core/vector/workerBridge";

let lib: HnswlibModule | null = null;
let index: HierarchicalNSW | null = null;

// Mapping management
const idToLabel = new Map<string, number>();
const labelToId = new Map<number, string>();
let nextLabel = 0;
const deletedLabels = new Set<number>();
let globalConfig: HNSWConfig | null = null;
let currentDimension = 0;

// Initialize WASM
const initPromise = (async () => {
  try {
    const { loadHnswlib } = await import("hnswlib-wasm");
    lib = await loadHnswlib();
  } catch (err) {
    postResult({ type: "error", message: `Failed to load hnswlib: ${err}` });
  }
})();

function postResult(result: VectorResult) {
  if (result.type === "saveComplete" && result.data instanceof ArrayBuffer) {
    self.postMessage(result, [result.data]);
  } else {
    self.postMessage(result);
  }
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
    }
  } catch (err: any) {
    postResult({ type: "error", message: err.message || String(err) });
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
    100 // random seed
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

async function handleSave() {
  if (!lib || !index) {
    throw new Error("No index to save");
  }

  const filename = "temp_index.bin";
  index.writeIndex(filename);
  
  // @ts-ignore
  const fs = lib.FS;
  const indexData = fs.readFile(filename, { encoding: "binary" }) as Uint8Array;
  
  const mapping = {
    nextLabel,
    currentDimension,
    idToLabel: Array.from(idToLabel.entries()),
    deletedLabels: Array.from(deletedLabels)
  };
  const mappingJson = JSON.stringify(mapping);
  const mappingBytes = new TextEncoder().encode(mappingJson);
  
  const totalLength = 4 + mappingBytes.length + indexData.length;
  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);
  
  view.setUint32(0, mappingBytes.length, true);
  uint8.set(mappingBytes, 4);
  uint8.set(indexData, 4 + mappingBytes.length);
  
  try { fs.unlink(filename); } catch {}
  
  postResult({ type: "saveComplete", data: buffer });
}

async function handleLoad(data: ArrayBuffer) {
  if (!lib || !globalConfig) return;
  
  const view = new DataView(data);
  const uint8 = new Uint8Array(data);
  
  const mappingLen = view.getUint32(0, true);
  const mappingBytes = uint8.subarray(4, 4 + mappingLen);
  const mappingJson = new TextDecoder().decode(mappingBytes);
  const mapping = JSON.parse(mappingJson);
  
  nextLabel = mapping.nextLabel;
  currentDimension = mapping.currentDimension;
  
  idToLabel.clear();
  labelToId.clear();
  deletedLabels.clear();
  
  for (const [id, label] of mapping.idToLabel) {
    idToLabel.set(id, label);
    labelToId.set(label, id);
  }
  for (const label of mapping.deletedLabels) {
    deletedLabels.add(label);
  }
  
  const indexData = uint8.subarray(4 + mappingLen);
  const filename = "temp_load.bin";
  // @ts-ignore
  const fs = lib.FS;
  fs.writeFile(filename, indexData);
  
  ensureIndex(currentDimension);
  if (index) {
    // Note: readIndex arguments might vary by version, checking usage in HNSWVectorStore
    // It used: index.readIndex(hnswFilename, maxElements)
    const maxElements = Math.max(
      globalConfig.initialMaxElements, 
      idToLabel.size + 1000 // Ensure room
    );
    // Re-init with correct max elements before reading? 
    // Usually readIndex replaces the content, but the instance must be init'ed.
    // Let's use maxElements from mapping if we had it, or estimate.
    
    index.readIndex(filename, maxElements);
  }
  
  try { fs.unlink(filename); } catch {}
}