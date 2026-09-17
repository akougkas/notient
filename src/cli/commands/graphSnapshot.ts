import { FsVault } from "../../adapters/fsVault";
import { connect } from "../../core/db/surreal";
import { makeExclusionPredicate } from "../../core/indexer/excludePaths";
import { reconcileRestoredNotes } from "../../core/services/reconcileRestoredNotes";
import {
  RESTORE_IMPORT_ORPHAN_REASON,
  reconcileRunOrphans,
} from "../../core/services/reconcileRunOrphans";
import { type ConfigSource, loadNotientConfig } from "../../core/settings/configSchema";
import { readEmbeddingSnapshot } from "./embeddingSnapshot";
import type { BackupEmbeddingManifest } from "./surrealBackupFormat";

/**
 * Verify the exact public Markdown/index generation contract on a running
 * graph store. Restore additionally asks this boundary to close imported
 * process-owned run states.
 */
export async function verifyGraphSnapshot(options: {
  vaultPath: string;
  port: number;
  secret: string;
  recoverImportedRuns: boolean;
}): Promise<BackupEmbeddingManifest> {
  const vault = await configuredPublicVault(options.vaultPath);
  const connection = await connect({
    url: `ws://127.0.0.1:${options.port}/rpc`,
    user: "root",
    pass: options.secret,
    namespace: "notient",
    database: "vault",
  });
  let failure: unknown;
  let embedding: BackupEmbeddingManifest | undefined;
  try {
    await reconcileRestoredNotes(connection.db, vault);
    const [writeIntents] = await connection.db
      .query<[unknown]>("SELECT id FROM note_write_intent LIMIT 1;")
      .collect<[unknown]>();
    if (!Array.isArray(writeIntents)) {
      throw new Error("note write intent check returned an invalid result");
    }
    if (writeIntents.length > 0) {
      throw new Error("snapshot has an unresolved note write intent");
    }
    embedding = await readEmbeddingSnapshot(connection.db);
    if (options.recoverImportedRuns) {
      await reconcileRunOrphans(connection.db, { reason: RESTORE_IMPORT_ORPHAN_REASON });
    }
  } catch (error) {
    failure = error;
  }
  try {
    await connection.close();
  } catch (error) {
    if (failure === undefined) {
      failure = new Error(`database connection close failed: ${formatError(error)}`);
    }
  }
  if (failure !== undefined) throw failure;
  if (embedding === undefined)
    throw new Error("embedding snapshot verification produced no result");
  return embedding;
}

async function configuredPublicVault(vaultPath: string): Promise<FsVault> {
  const internalVault = new FsVault(vaultPath, { allowHiddenPaths: true });
  const configSource: ConfigSource = {
    path: `${vaultPath}/.notient/config.json`,
    load: async () => {
      try {
        return await internalVault.read(".notient/config.json");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
  const config = await loadNotientConfig(configSource);
  const vault = new FsVault(vaultPath);
  vault.setExclusion(
    makeExclusionPredicate({
      excludePaths: config.indexer.excludePaths,
      excludeGlobs: config.indexer.excludeGlobs,
    }),
  );
  return vault;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
