import { chatConfigureResultSchema, chatSettingsResultSchema } from "../../api/chat";
import { operationInputs } from "../../api/operations";
import { NoteApiError } from "../../api/schema";
import type { SettingsChangeJournal } from "../../core/settings/changeJournal";
import type { SettingsService } from "../../core/settings/settingsService";
import { RpcError, type RpcRequestContext } from "../rpc";

/** Chat resource limits use the same journaled configuration authority as
 * background policy; only a live human administrator may change them. */
export function makeChatSettingsHandlers(options: {
  settings: SettingsService;
  journal: SettingsChangeJournal;
  authorize: (request: RpcRequestContext) => void;
}) {
  const typed = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof NoteApiError) throw new RpcError(error.code, error.message);
      throw error;
    }
  };
  return {
    get: ({ params, principal }: RpcRequestContext) =>
      typed(async () => {
        if (!principal.scopes.includes("read"))
          throw new NoteApiError("FORBIDDEN", "chat settings require read scope");
        const parsed = operationInputs["chat.settings"].safeParse(params);
        if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
        await options.settings.refreshChatBudget();
        return chatSettingsResultSchema.parse({ ok: true, ...options.settings.chatBudget() });
      }),
    configure: (context: RpcRequestContext) =>
      typed(async () => {
        const { principal, params, signal } = context;
        const authorize = () => {
          signal?.throwIfAborted();
          if (principal.kind !== "human" || !principal.scopes.includes("admin"))
            throw new NoteApiError(
              "FORBIDDEN",
              "Changing chat resource limits requires a human administrator.",
            );
          options.authorize(context);
        };
        authorize();
        const parsed = operationInputs["chat.configure"].safeParse(params);
        if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
        const request = parsed.data;
        return chatConfigureResultSchema.parse(
          await options.settings.updateChatBudget(request.budget, request.revision, {
            journal: options.journal,
            caller: principal,
            key: request.idempotencyKey,
            request: { name: "chat.configure", ...request },
            authorize,
          }),
        );
      }),
  };
}
