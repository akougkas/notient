export type RootEntryAction = "command" | "help" | "tui" | "version";

export interface RootEntryInput {
  command: string | null;
  helpRequested: boolean;
  versionRequested: boolean;
  outputModeRequested: boolean;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
}

/**
 * Select the root experience without making a terminal-dependent decision
 * implicit in the command dispatcher. Explicit commands and help always win;
 * a bare interactive terminal opens the product, while pipes remain stable
 * structured help output.
 */
export function selectRootEntry(input: RootEntryInput): RootEntryAction {
  if (input.command !== null && input.command !== "help") return "command";
  if (input.command === "help" || input.helpRequested) return "help";
  if (input.versionRequested) return "version";
  if (
    input.command === null &&
    input.stdinIsTty &&
    input.stdoutIsTty &&
    !input.outputModeRequested
  ) {
    return "tui";
  }
  return "help";
}
