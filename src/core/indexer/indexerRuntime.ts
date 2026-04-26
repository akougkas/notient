export interface IndexerRuntimeConfig {
  mode: "inline";
  workerPath: null;
}

export function createIndexerRuntimeConfig(): IndexerRuntimeConfig {
  return {
    mode: "inline",
    workerPath: null,
  };
}
