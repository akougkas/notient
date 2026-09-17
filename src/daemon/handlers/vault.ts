import { type VaultAdapter, type VaultListing, VaultPathError } from "../../adapters/vaultAdapter";
import {
  isCanonicalPublicFolderPath,
  isCanonicalPublicNotePath,
  isNotientOwnedArtifactPath,
} from "../../core/vault/publicPath";
import { RpcError, type RpcRequestContext } from "../rpc";

export interface VaultHandlerDeps {
  vault: Pick<VaultAdapter, "exists" | "list">;
}

export interface VaultHandlers {
  list: (request: RpcRequestContext) => Promise<{ ok: boolean; paths: string[] }>;
}

const HARD_CAP = 200;
const ROOT_EXCLUDES = new Set([".notient", "Notient"]);

function parseListLimit(raw: unknown): number {
  if (raw === undefined) return HARD_CAP;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new RpcError("INVALID_PARAMS", "limit must be a positive safe integer");
  }
  if (raw > HARD_CAP) {
    throw new RpcError("INVALID_PARAMS", `limit must not exceed ${HARD_CAP}`);
  }
  return raw;
}

interface ListedCandidate {
  fullPath: string;
  name: string;
  rendered: string;
}

function directChildName(fullPath: string, folder: string): string | null {
  const prefix = folder === "" ? "" : `${folder}/`;
  if (!fullPath.startsWith(prefix)) return null;
  const name = fullPath.slice(prefix.length);
  return name.length > 0 && !name.includes("/") ? name : null;
}

function folderCandidate(fullPath: unknown, folder: string): ListedCandidate | null {
  if (!isCanonicalPublicFolderPath(fullPath) || isNotientOwnedArtifactPath(fullPath)) return null;
  const name = directChildName(fullPath, folder);
  if (name === null || (folder === "" && ROOT_EXCLUDES.has(name))) return null;
  return { fullPath, name, rendered: `${name}/` };
}

function fileCandidate(fullPath: unknown, folder: string): ListedCandidate | null {
  if (!isCanonicalPublicNotePath(fullPath) || isNotientOwnedArtifactPath(fullPath)) return null;
  const name = directChildName(fullPath, folder);
  return name === null ? null : { fullPath, name, rendered: name };
}

function compareCandidates(left: ListedCandidate, right: ListedCandidate): number {
  if (left.rendered === right.rendered) return 0;
  return left.rendered < right.rendered ? -1 : 1;
}

async function isAccessible(
  vault: Pick<VaultAdapter, "exists">,
  fullPath: string,
): Promise<boolean> {
  try {
    return await vault.exists(fullPath);
  } catch (error) {
    if (error instanceof VaultPathError) return false;
    throw error;
  }
}

function parseListFolder(raw: unknown): string {
  const folder = raw === undefined ? "" : raw;
  if (!isCanonicalPublicFolderPath(folder) || isNotientOwnedArtifactPath(folder)) {
    throw new RpcError(
      "INVALID_PARAMS",
      "folder must be an exact ordinary public vault-relative folder path",
    );
  }
  return folder;
}

async function readListing(
  vault: Pick<VaultAdapter, "list">,
  folder: string,
): Promise<VaultListing> {
  try {
    return await vault.list(folder);
  } catch (error) {
    if (error instanceof VaultPathError) {
      throw new RpcError("INVALID_PARAMS", error.message);
    }
    throw error;
  }
}

function listCandidates(listing: VaultListing, folder: string, filter: string): ListedCandidate[] {
  const candidates = [
    ...listing.folders.map((path) => folderCandidate(path, folder)),
    ...listing.files.map((path) => fileCandidate(path, folder)),
  ].filter((candidate): candidate is ListedCandidate => candidate !== null);
  const unique = new Map(
    candidates
      .filter((candidate) => candidate.name.startsWith(filter))
      .map((candidate) => [candidate.rendered, candidate] as const),
  );
  return [...unique.values()].sort(compareCandidates);
}

async function collectAccessiblePaths(
  vault: Pick<VaultAdapter, "exists">,
  candidates: readonly ListedCandidate[],
  limit: number,
): Promise<string[]> {
  const paths: string[] = [];
  for (const candidate of candidates) {
    if (!(await isAccessible(vault, candidate.fullPath))) continue;
    paths.push(candidate.rendered);
    if (paths.length === limit) break;
  }
  return paths;
}

export function makeVaultHandlers(deps: VaultHandlerDeps): VaultHandlers {
  return {
    list: async ({ params }) => {
      const folder = parseListFolder(params.folder);
      const filter = typeof params.filter === "string" ? params.filter : "";
      const limit = parseListLimit(params.limit);
      const listing = await readListing(deps.vault, folder);
      const candidates = listCandidates(listing, folder, filter);
      const paths = await collectAccessiblePaths(deps.vault, candidates, limit);
      return { ok: true, paths };
    },
  };
}
