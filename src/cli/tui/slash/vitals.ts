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
        "workspace status (daemon and note agents; not a measure of understanding):",
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
    const conditions = [
      snapshot.connectivityCount === 0
        ? "No approved link connects this note to another."
        : null,
      snapshot.wordCount < 20
        ? "Under 20 words, so the structural proxies have little to measure. This says nothing about its value."
        : null,
      snapshot.freshness < 0.25
        ? `The note has not been edited for a long time. /read ${path} shows its current text.`
        : null,
    ].filter((line): line is string => line !== null);
    return {
      message: [
        `structure for ${path} (proxies from length, indexing and links; they do not measure understanding):`,
        `- words:           ${snapshot.wordCount}`,
        `- approved links:  ${snapshot.connectivityCount} (${snapshot.connectivityTier})`,
        `- edit recency:     ${snapshot.freshness.toFixed(2)} of 1 (decays with time since the last human edit)`,
        conditions.length ? "conditions:" : "conditions: none found in these proxies",
        ...conditions.map((line) => `  ${line}`),
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
        "service health (daemon and model endpoints only; says nothing about note quality):",
        `- daemon:    pid ${status.pid} (${status.version})`,
        `- endpoints: ${formatEndpoints(health.endpoints)}`,
      ].join("\n"),
    };
  } catch (error) {
    return { message: `health error: ${formatError(error)}` };
  }
}
