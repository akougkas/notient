/**
 * Factory that wires the existing ChatService with the substrate's chat
 * surface. Bootstrap calls this once at startup and registers the result in
 * the kernel under `chatService`. The factory is intentionally thin: it
 * mirrors `ChatServiceOptions` with no rewrite. Tier 1 identity is consumed
 * by the ContextManager that the bootstrap constructs separately.
 */

import { ChatService, type ChatServiceOptions } from "../core/chat/chatService";
import { TIER_1_IDENTITY } from "./identity";

export interface NotientAgentDeps extends ChatServiceOptions {}

export function buildNotientAgent(deps: NotientAgentDeps): ChatService {
  return new ChatService(deps);
}

export { TIER_1_IDENTITY };
