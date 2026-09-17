import {
  type VaultAdapter,
  VaultPathError,
  VaultReadLimitError,
} from "../../adapters/vaultAdapter";
import { NoteReadService } from "../../api/notes";
import { NoteApiError, type NoteReadResult } from "../../api/schema";
import { RpcError, type RpcRequestContext } from "../rpc";

export interface NotesHandlerDeps {
  indexedRevision?: (path: string) => Promise<string | null>;
  vault: Pick<VaultAdapter, "read"> & Partial<Pick<VaultAdapter, "readBounded">>;
}

export interface NotesHandlers {
  read: (request: RpcRequestContext) => Promise<NoteReadResult>;
}

export function makeNotesHandlers(deps: NotesHandlerDeps): NotesHandlers {
  const notes = new NoteReadService(deps.vault, deps.indexedRevision);
  return {
    read: async ({ params }) => {
      try {
        return await notes.read(params);
      } catch (error) {
        if (error instanceof VaultReadLimitError)
          throw new RpcError("LIMIT_EXCEEDED", error.message);
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new RpcError("NOT_FOUND", "note does not exist");
        if (error instanceof NoteApiError) throw new RpcError(error.code, error.message);
        if (error instanceof VaultPathError) {
          throw new RpcError("INVALID_PARAMS", error.message);
        }
        throw error;
      }
    },
  };
}
