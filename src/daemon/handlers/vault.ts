import type { VaultAdapter } from "../../adapters/vaultAdapter";

export interface VaultHandlerDeps {
  vault: Pick<VaultAdapter, "list">;
}

export interface VaultHandlers {
  list: (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ) => Promise<{ ok: boolean; paths: string[] }>;
}

const HARD_CAP = 200;
const ROOT_EXCLUDES = new Set([".notient", "Notient"]);

export function makeVaultHandlers(deps: VaultHandlerDeps): VaultHandlers {
  return {
    list: async (params) => {
      const folder = typeof params.folder === "string" ? params.folder : "";
      const filter = typeof params.filter === "string" ? params.filter : "";
      const limit = typeof params.limit === "number" ? Math.min(params.limit, HARD_CAP) : HARD_CAP;
      const listing = await deps.vault.list(folder);
      const folderEntries = listing.folders
        .filter((name) => !(folder === "" && ROOT_EXCLUDES.has(name)))
        .filter((name) => name.startsWith(filter))
        .map((name) => `${name}/`);
      const fileEntries = listing.files
        .filter((name) => !(folder === "" && name.startsWith("Notient/")))
        .filter((name) => !(folder === "" && name.startsWith(".notient/")))
        .filter((name) => name.startsWith(filter));
      const paths = [...folderEntries, ...fileEntries].sort().slice(0, limit);
      return { ok: true, paths };
    },
  };
}
