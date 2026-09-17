import { jobResultSchema } from "../../api/pipelines";
import { NoteApiError } from "../../api/schema";
import type { JobService } from "../../core/pipelines/jobService";
import { RpcError, type RpcRequestContext } from "../rpc";

export function makeJobHandlers(jobs: Pick<JobService, "list" | "get" | "control">) {
  const call =
    <T>(action: (request: RpcRequestContext) => Promise<T>) =>
    async (request: RpcRequestContext) => {
      try {
        return await action(request);
      } catch (error) {
        if (error instanceof NoteApiError) throw new RpcError(error.code, error.message);
        throw error;
      }
    };
  return {
    list: call(({ params, principal }) => jobs.list(params, principal)),
    get: call(({ params, principal }) => jobs.get(params, principal)),
    control: call(async ({ params, principal, signal }) =>
      jobResultSchema.parse({ ok: true, job: await jobs.control(params, principal, signal) }),
    ),
  };
}
