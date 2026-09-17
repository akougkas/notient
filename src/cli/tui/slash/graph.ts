import type { NeighborWire } from "../../../daemon/wire";
import { createRpc } from "../rpc";
import { formatError } from "./rpc";
import type { SlashContext, SlashOutcome } from "./types";

export type NeighborEntry = NeighborWire;

export async function fetchNeighbors(
  context: SlashContext,
  notePath: string,
): Promise<NeighborEntry[]> {
  const result = await createRpc(context.client).neighbors(notePath);
  if (result.truncated || result.omitted || result.coverage.state !== "current")
    throw new Error(
      result.coverage.message ??
        "Connection results are incomplete; open the note’s Links view for details.",
    );
  return result.connections.map((row) => ({
    notePath: row.note.path,
    table: row.relation,
    direction: row.direction,
    confidence: row.assessment ?? 1,
    agent: row.author,
    proposed: row.state === "proposed",
  }));
}

export async function rpcGraph(context: SlashContext, rest: string): Promise<SlashOutcome> {
  let parts: string[];
  try {
    parts = parsePaths(rest);
  } catch (error) {
    return { message: `graph: ${formatError(error)}` };
  }
  if (parts.length === 0) return { message: "/graph needs <fromPath> [toPath]" };
  if (parts.length > 2) return { message: "/graph accepts only <fromPath> [toPath]" };
  const fromPath = parts[0];
  const toPath = parts[1];
  if (fromPath === undefined) return { message: "/graph needs <fromPath> [toPath]" };

  if (toPath === undefined) {
    try {
      const neighbors = await fetchNeighbors(context, fromPath);
      if (neighbors.length === 0)
        return { message: `No authored links or reviewed relationships for ${fromPath}.` };
      return {
        message: [
          `Connections for ${fromPath}:`,
          ...neighbors.map(
            (neighbor) =>
              `- ${neighbor.direction === "outgoing" ? "→" : "←"} ${neighbor.table} ${neighbor.notePath}`,
          ),
        ].join("\n"),
      };
    } catch (error) {
      return { message: `graph error: ${formatError(error)}` };
    }
  }

  try {
    const result = await createRpc(context.client).findPath(fromPath, toPath);
    if (result.outcome === "incomplete")
      return {
        message: `graph: search incomplete; ${result.coverage.message ?? "traversal limits reached"}`,
      };
    if (result.path.length === 0) {
      return { message: `graph: no path found between ${fromPath} and ${toPath}` };
    }
    return {
      message: `graph path (${result.steps.length} hops):\n${result.path.map((note) => note.path).join(" → ")}`,
    };
  } catch (error) {
    return { message: `graph error: ${formatError(error)}` };
  }
}

/** Quoting is only for path boundaries; this never invokes a shell or expands
 * variables. Apostrophes inside unquoted filenames remain literal. */
function parsePaths(input: string): string[] {
  const paths: string[] = [];
  let remaining = input.trim();
  while (remaining) {
    const quote = remaining[0];
    if (quote !== '"' && quote !== "'") {
      const path = remaining.match(/^\S+/)?.[0] ?? "";
      paths.push(path);
      remaining = remaining.slice(path.length).trimStart();
      continue;
    }
    let path = "";
    let index = 1;
    for (; index < remaining.length && remaining[index] !== quote; index++) {
      if (remaining[index] === "\\" && remaining[index + 1] === quote) index++;
      path += remaining[index];
    }
    if (index === remaining.length || (remaining[index + 1] && !/\s/.test(remaining[index + 1])))
      throw new Error(
        'Quote each path completely, for example /graph "Project notes.md" "Next steps.md".',
      );
    if (!path) throw new Error("A note path cannot be empty.");
    paths.push(path);
    remaining = remaining.slice(index + 1).trimStart();
  }
  return paths;
}

export async function rpcPulse(context: SlashContext, path: string): Promise<SlashOutcome> {
  const rpc = createRpc(context.client);
  try {
    const [vitals, neighbors] = await Promise.all([
      rpc.vitals(path),
      fetchNeighbors(context, path),
    ]);
    const snapshot = vitals.snapshot;
    return {
      message: [
        `pulse: ${path}`,
        `maturity:     ${snapshot.maturity}`,
        `health:       ${snapshot.health.toFixed(2)}`,
        `connectivity: ${snapshot.connectivityTier} (${neighbors.length} approved neighbors)`,
        neighbors.length === 0
          ? "next: run /awaken so the linker can propose semantic edges."
          : "next: /graph to inspect the edges, /proposals to review pending ones.",
      ].join("\n"),
    };
  } catch (error) {
    return { message: `pulse error: ${formatError(error)}` };
  }
}
