import {
  AGENT_SCOPES,
  HUMAN_SCOPES,
  type Principal,
  type RpcRequestContext,
} from "../src/daemon/rpc";

export function humanPrincipal(id = "human"): Principal {
  return { id, kind: "human", scopes: [...HUMAN_SCOPES] };
}

export function agentPrincipal(id = "claude-code"): Principal {
  return { id, kind: "agent", scopes: [...AGENT_SCOPES] };
}

export function rpcRequest(
  params: Record<string, unknown> = {},
  overrides: Partial<Omit<RpcRequestContext, "params">> = {},
): RpcRequestContext {
  return {
    params,
    emit: () => {},
    requestId: "req-1",
    principal: humanPrincipal(),
    connectionId: "conn-1",
    ...overrides,
  };
}
