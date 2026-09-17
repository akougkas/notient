import type { BackgroundSettings } from "../../api/background";
import { operationInputs, pipelineIdSchema } from "../../api/operations";
import { PIPELINE_CATALOG, pipelineListSchema } from "../../api/pipelineCatalog";
import { jobResultSchema } from "../../api/pipelines";
import { validatePipelinePolicy } from "../../api/policyValidation";
import { NoteApiError } from "../../api/schema";
import type { Coordinator } from "../../core/coordinator/coordinator";
import type { JobService } from "../../core/pipelines/jobService";
import type { SettingsChangeJournal } from "../../core/settings/changeJournal";
import type { SettingsService } from "../../core/settings/settingsService";
import { RpcError, type RpcRequestContext } from "../rpc";

export function makePipelineHandlers(options: {
  jobs: JobService;
  settings: SettingsService;
  coordinator: Coordinator;
  journal: SettingsChangeJournal;
  authorize: (request: RpcRequestContext) => void;
}) {
  const update =
    (name: "pipelines.configure" | "background.pause") => async (context: RpcRequestContext) => {
      const { principal, params, signal } = context;
      const authorize = () => {
        signal?.throwIfAborted();
        if (principal.kind !== "human" || !principal.scopes.includes("admin"))
          throw new NoteApiError(
            "FORBIDDEN",
            "Saving background permissions requires a human administrator.",
          );
        options.authorize(context);
      };
      try {
        authorize();
        const request = operationInputs[name].parse(params);
        if ("pipeline" in request) {
          const validation = validatePipelinePolicy(request.pipeline, request.policy);
          if (!validation.valid)
            throw new NoteApiError(
              "INVALID_PARAMS",
              validation.issues
                .filter((i) => i.severity === "error")
                .map((i) => `${i.path}: ${i.message}`)
                .join("\n"),
            );
        }
        return await options.settings.updateBackground(
          (current: BackgroundSettings) => {
            const next = structuredClone(current);
            if ("pipeline" in request) next.pipelines[request.pipeline] = request.policy;
            else next.paused = request.paused;
            return next;
          },
          request.revision,
          {
            journal: options.journal,
            caller: principal,
            key: request.idempotencyKey,
            request: { name, ...request },
            authorize,
          },
        );
      } catch (error) {
        if (error instanceof NoteApiError) throw new RpcError(error.code, error.message);
        if (error instanceof Error && error.name === "ZodError")
          throw new RpcError("INVALID_PARAMS", error.message);
        throw error;
      }
    };
  return {
    configure: update("pipelines.configure"),
    pause: update("background.pause"),
    validate: async ({ params, principal }: RpcRequestContext) => {
      if (!principal.scopes.includes("read"))
        throw new RpcError("FORBIDDEN", "Policy validation requires read scope.");
      const parsed = operationInputs["pipelines.validate"].safeParse(params);
      if (!parsed.success) throw new RpcError("INVALID_PARAMS", parsed.error.message);
      return validatePipelinePolicy(parsed.data.pipeline, parsed.data.policy);
    },
    list: async ({ params, principal }: RpcRequestContext) => {
      if (!principal.scopes.includes("read"))
        throw new RpcError("FORBIDDEN", "pipeline inspection requires read scope");
      const parsed = operationInputs["pipelines.list"].safeParse(params);
      if (!parsed.success) throw new RpcError("INVALID_PARAMS", parsed.error.message);
      await options.settings.refreshBackground();
      const configuration = options.settings.background();
      return pipelineListSchema.parse({
        ok: true,
        revision: configuration.revision,
        paused: configuration.settings.paused,
        pipelines: pipelineIdSchema.options.map((id) => ({
          id,
          ...PIPELINE_CATALOG[id],
          policy: configuration.settings.pipelines[id],
          schedule: options.coordinator.schedule(id),
        })),
      });
    },
    run: async ({ params, principal, signal }: RpcRequestContext) => {
      try {
        return jobResultSchema.parse({
          ok: true,
          job: await options.jobs.run(params, principal, undefined, signal),
        });
      } catch (error) {
        if (error instanceof NoteApiError) throw new RpcError(error.code, error.message);
        throw error;
      }
    },
  };
}
