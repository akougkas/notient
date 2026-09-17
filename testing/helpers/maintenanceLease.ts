import type { ClientHandle, RpcResponseFrame } from "../../src/cli/client";
import type { GraphMaintenanceLease } from "../../src/cli/commands/maintenanceLease";

const unusedClient: ClientHandle = {
  principal: { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
  call: async function* () {
    yield await Promise.reject<RpcResponseFrame>(
      new Error("the direct SurrealDB smoke harness must not issue maintenance RPC calls"),
    );
  },
  close: async () => {},
};

/** Test seam for isolated SurrealDB command smokes that do not boot a daemon. */
export async function acquireNoopMaintenanceLease(): Promise<GraphMaintenanceLease> {
  return {
    client: unusedClient,
    release: async () => ({ vaultChanged: false }),
    poison: async () => {},
  };
}
