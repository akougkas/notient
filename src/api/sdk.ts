/**
 * Public typed SDK entry, published as `notient/sdk`.
 *
 * A fetch-only client for the paired loopback HTTP API plus the runtime
 * schemas it validates with. It runs in Bun, Node 20+ and browsers, and has
 * no dependency on the daemon, the CLI or the vault filesystem.
 */
export {
  NotientApiError,
  NotientClient,
  type NotientClientOptions,
  pairingResultSchema,
} from "./client";
export {
  type ChangeSet,
  type OperationInput,
  type OperationName,
  type PipelineId,
  type PipelinePolicy,
  operationInputs,
} from "./operations";
export {
  type ImplementedOperation,
  type OperationResult,
  capabilitiesSchema,
  eventSchema,
  operationOutputs,
} from "./results";
export {
  type ApiErrorCode,
  type NoteReadResult,
  type NoteReference,
  type NoteSelector,
  type NoteStructure,
  type SourceRange,
  type SourceReference,
  apiErrorCodeSchema,
} from "./schema";
