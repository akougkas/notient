import type { EndpointModelCatalog } from "../core/llm/modelSelection";
import type { DaemonModelProbeWire } from "./wire";

interface Input {
  endpoint: string;
  fetchCatalog: () => Promise<EndpointModelCatalog>;
  configuredModel: string;
  configuredContextTokens: number;
  parallelSlots: number;
}

/** Catalog availability, known load state and context fit are different facts.
 * Inspection never loads a model or substitutes another advertised model. */
export async function probeDaemonModel(input: Input): Promise<DaemonModelProbeWire> {
  const result: DaemonModelProbeWire = {
    endpoint: input.endpoint,
    configuredModel: input.configuredModel,
    configuredContextTokens: input.configuredContextTokens,
    parallelSlots: input.parallelSlots,
    requestedTotalContextTokens: input.configuredContextTokens * input.parallelSlots,
    loadedModel: null,
    loadedContextLength: null,
    status: "unconfigured",
    message: "No reasoning model configured. Reading, writing and lexical search remain available.",
  };
  if (!input.configuredModel) return result;
  let catalog: EndpointModelCatalog;
  try {
    catalog = await input.fetchCatalog();
  } catch (error) {
    return {
      ...result,
      status: "unavailable",
      message: `Model status unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const model = catalog.models.find(
    (model) => model.id === input.configuredModel && model.type !== "embedding",
  );
  if (!model)
    return {
      ...result,
      status: "mismatch",
      message: `Configured reasoning model ${input.configuredModel} is not advertised by this endpoint.`,
    };
  if (model.state === "not-loaded")
    return {
      ...result,
      status: "not-loaded",
      message: `${model.id} is available but not loaded. The provider may load it when inference is requested.`,
    };
  if (model.state === "unknown")
    return {
      ...result,
      status: "available",
      message: `${model.id} is advertised; the provider does not report its load state or active context capacity.`,
    };
  result.loadedModel = model.id;
  result.loadedContextLength = model.loadedContextLength;
  if (
    model.loadedContextLength !== null &&
    result.requestedTotalContextTokens > model.loadedContextLength
  )
    return {
      ...result,
      status: "mismatch",
      message: `Context mismatch: configured ${input.configuredContextTokens.toLocaleString()} × ${input.parallelSlots} slots = ${result.requestedTotalContextTokens.toLocaleString()}; loaded ${model.loadedContextLength.toLocaleString()}.`,
    };
  return {
    ...result,
    status: "ok",
    message: `${model.id} is loaded${model.loadedContextLength === null ? "; active context capacity is not reported" : ` · ${model.loadedContextLength.toLocaleString()} total context tokens`}.`,
  };
}
