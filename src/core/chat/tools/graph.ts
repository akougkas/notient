import type { GraphPath } from "../../../api/graph";
import type { GraphService } from "../../graph/graphService";
import { isCanonicalOrdinaryNotePath } from "../../vault/publicPath";
import { type ToolDefinition, isObject, optionalPositiveInt, requireString } from "./registry";

export interface GraphFindPathArgs {
  fromNotePath: string;
  toNotePath: string;
  maxHops?: number;
}

const DEFAULT_MAX_HOPS = 3;
const HARD_MAX_HOPS = 6;
const GRAPH_FIND_PATH_FIELDS = ["fromNotePath", "toNotePath", "maxHops"] as const;

export function makeFindPathTool(
  graph: Pick<GraphService, "path">,
): ToolDefinition<GraphFindPathArgs, GraphPath> {
  return {
    name: "graph.find_path",
    description:
      "Find a bounded, revision-checked route through authored links and approved relationships. An incomplete search does not establish that no route exists.",
    schema: {
      type: "object",
      properties: {
        fromNotePath: { type: "string" },
        toNotePath: { type: "string" },
        maxHops: { type: "number", description: "Hop cap. Defaults to 3. Hard max is 6." },
      },
      required: ["fromNotePath", "toNotePath"],
    },
    validate: (raw) => {
      if (!isObject(raw)) throw new Error("expected object");
      if (!Object.keys(raw).every((key) => GRAPH_FIND_PATH_FIELDS.includes(key as never))) {
        throw new Error("graph.find_path received an unknown argument");
      }
      const fromNotePath = requireString(raw.fromNotePath, "fromNotePath");
      const toNotePath = requireString(raw.toNotePath, "toNotePath");
      assertOrdinaryNotePath(fromNotePath, "fromNotePath");
      assertOrdinaryNotePath(toNotePath, "toNotePath");
      const maxHopsRaw = optionalPositiveInt(raw.maxHops, "maxHops");
      if (maxHopsRaw !== undefined && maxHopsRaw > HARD_MAX_HOPS) {
        throw new Error(`maxHops must not exceed ${HARD_MAX_HOPS}`);
      }
      const maxHops = maxHopsRaw === undefined ? DEFAULT_MAX_HOPS : maxHopsRaw;
      return { fromNotePath, toNotePath, maxHops };
    },
    invoke: async (args, signal) =>
      graph.path(
        { from: args.fromNotePath, to: args.toNotePath, maxHops: args.maxHops ?? DEFAULT_MAX_HOPS },
        signal,
      ),
    writeGated: false,
  };
}

function assertOrdinaryNotePath(raw: string, label: string): void {
  if (!isCanonicalOrdinaryNotePath(raw)) {
    throw new Error(`${label} must be an exact ordinary public vault-relative Markdown note path`);
  }
}
