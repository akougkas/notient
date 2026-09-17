import type { EndpointModel } from "../../../core/llm/modelSelection";
import type { NotientSettings } from "../../../core/settings/types";
import { type ModelInfo, buildModelView, formatModelList, formatModelView } from "../modelVerb";
import { createRpc } from "../rpc";
import { formatError } from "./rpc";
import type { SlashContext, SlashOutcome } from "./types";

export async function modelVerb(rest: string, context: SlashContext): Promise<SlashOutcome> {
  const space = rest.indexOf(" ");
  const sub = (space < 0 ? rest : rest.slice(0, space)).trim();

  if (sub.length === 0 || sub === "show") return modelShow(context);
  if (sub === "list") return modelList(context);
  return { message: `/model: unknown action '${sub}' (available: show, list)` };
}

async function modelShow(context: SlashContext): Promise<SlashOutcome> {
  try {
    const settings = await fetchSettings(context);
    return { message: formatModelView(buildModelView(settings)) };
  } catch (error) {
    return { message: `/model error: ${formatError(error)}` };
  }
}

/** List the same validated catalog the daemon uses during boot. */
async function modelList(context: SlashContext): Promise<SlashOutcome> {
  try {
    const catalog = await createRpc(context.client).modelCatalog();
    return { message: formatModelList(catalog.models.map(toModelInfo)) };
  } catch (error) {
    return { message: `/model list: catalog failure: ${formatError(error)}` };
  }
}

function toModelInfo(model: EndpointModel): ModelInfo {
  return {
    id: model.id,
    type: model.type,
    state: model.state,
    ...(model.loadedContextLength === null
      ? {}
      : { loadedContextLength: model.loadedContextLength }),
    ...(model.maxContextLength === undefined ? {} : { maxContextLength: model.maxContextLength }),
    ...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
  };
}

async function fetchSettings(context: SlashContext): Promise<NotientSettings> {
  return (await createRpc(context.client).config()).config;
}
