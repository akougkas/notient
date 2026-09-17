import type { ClientHandle } from "../../../cli/client";

export interface ProposalListItem {
  id: string;
  table: string;
  source: string | null;
  target: string | null;
  agent: string | null;
  confidence: number;
  reasoning?: string;
}

export interface ProposalActions {
  list(): Promise<ProposalListItem[]>;
  approve(id: string): Promise<ProposalDecision>;
  reject(id: string, reason?: string): Promise<ProposalDecision>;
}

export interface ProposalDecision {
  readonly message: string;
  readonly state: "resolved" | "uncertain";
}

export interface PendingTransition {
  readonly id: string;
  readonly state: "resolved" | "uncertain";
}

export interface SlashContext {
  readonly client: ClientHandle;
  readonly vaultPath: string;
  readonly proposals?: ProposalActions;
  readonly getLastAssistant?: () => string | null;
  readonly openConversations?: () => Promise<void>;
  readonly newConversation?: () => Promise<void>;
}

export interface SlashOutcome {
  readonly message: string;
  readonly resetTranscript?: boolean;
  readonly exit?: boolean;
  readonly proposalItems?: ProposalListItem[];
  /** Exact approval or edge transition that must be reconciled with daemon state. */
  readonly pendingTransition?: PendingTransition;
}

export type SlashHandler = (rest: string, context: SlashContext) => Promise<SlashOutcome>;
