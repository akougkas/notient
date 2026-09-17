import type { EndpointHealthWire } from "../../../daemon/wire";
import { createRpc } from "../rpc";
import { formatError } from "./rpc";
import type { SlashContext, SlashOutcome } from "./types";

function formatEndpoints(endpoints: ReadonlyArray<EndpointHealthWire>): string {
  if (endpoints.length === 0) return "none configured";
  return endpoints.map((endpoint) => `${endpoint.label}:${endpoint.ok ? "ok" : "down"}`).join(" ");
}

/** Report the current substrate and the note swarm's persisted, attributable state. */
export async function rpcSentient(context: SlashContext): Promise<SlashOutcome> {
  const rpc = createRpc(context.client);
  try {
    const [health, status, active] = await Promise.all([
      rpc.health(),
      rpc.status(),
      rpc.activeNote(),
    ]);
    return {
      message: [
        "sentient:",
        `daemon:      pid ${status.pid} ${status.sealed ? "sealed" : "starting"}`,
        `endpoints:   ${formatEndpoints(health.endpoints)}`,
        `vision:      ${status.visionReady ? "ready" : "off"}`,
        `active note: ${active.notePath ?? "(none edited yet)"}`,
        `neighbors:   ${active.neighbors.length} approved`,
        "swarm:",
        ...active.swarm.map(
          (agent) => `  ${agent.agent.padEnd(20)} ${agent.state} (${agent.proposals} proposals)`,
        ),
      ].join("\n"),
    };
  } catch (error) {
    return { message: `sentient integrity error: ${formatError(error)}` };
  }
}

export async function rpcVitals(context: SlashContext, path: string): Promise<SlashOutcome> {
  try {
    const snapshot = (await createRpc(context.client).vitals(path)).snapshot;
    return {
      message: [
        `vitals for ${path}:`,
        `- wordCount:       ${snapshot.wordCount}`,
        `- approvedEdges:   ${snapshot.connectivityCount}`,
        `- connectivity:    ${snapshot.connectivityTier}`,
        `- maturity:        ${snapshot.maturity}`,
        `- health:          ${snapshot.health.toFixed(2)}`,
        `- freshness:       ${snapshot.freshness.toFixed(2)}`,
        `- computedAt:      ${new Date(snapshot.computedAt).toISOString()}`,
      ].join("\n"),
    };
  } catch (error) {
    return { message: `vitals error: ${formatError(error)}` };
  }
}

export async function rpcHealth(context: SlashContext): Promise<SlashOutcome> {
  const rpc = createRpc(context.client);
  try {
    const [health, status] = await Promise.all([rpc.health(), rpc.status()]);
    return {
      message: [
        "notient health:",
        `- daemon:    pid ${status.pid} (${status.version})`,
        `- endpoints: ${formatEndpoints(health.endpoints)}`,
      ].join("\n"),
    };
  } catch (error) {
    return { message: `health error: ${formatError(error)}` };
  }
}
