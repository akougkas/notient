import { methodologySuggestionResultSchema } from "../../api/methodology";
import { NoteApiError } from "../../api/schema";
import type { MethodologySuggestionService } from "../../core/methodology/suggestionService";
import { RpcError, type RpcRequestContext } from "../rpc";

export function makeMethodologySuggestionHandler(deps: {
  service: MethodologySuggestionService;
  authorizeCaller: (context: RpcRequestContext) => void;
}) {
  return async (context: RpcRequestContext) => {
    const { principal, params, signal } = context;
    try {
      return methodologySuggestionResultSchema.parse(
        await deps.service.suggest(params, principal, signal, () => deps.authorizeCaller(context)),
      );
    } catch (error) {
      if (error instanceof NoteApiError) throw new RpcError(error.code, error.message);
      if (error instanceof Error && error.name === "ZodError")
        throw new RpcError("INVALID_PARAMS", error.message);
      if (error instanceof Error && error.name === "EditedIntelligenceRecordError")
        throw new RpcError("CONFLICT", error.message);
      throw error;
    }
  };
}
