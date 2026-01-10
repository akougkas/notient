/**
 * Command Parser
 *
 * Parses omnibar slash commands for:
 * 1. Single-note operations (current note): /enhance, /connect, /atomize, etc.
 * 2. Bulk workflow operations: /enrich folder:inbox, /classify vault
 */

import { normalizePath } from "obsidian";
import type { ObsidianFacade } from "../../adapters/obsidianFacade";
import type { IntelligenceActionType } from "../intelligence/prompts";
import type { WorkflowScope } from "./types";

/**
 * Single-note commands that map to IntelligenceActionType
 * These run on the CURRENT note only
 */
export type SingleNoteCommand =
  | "enhance" // → "enhance" action
  | "connect" // → "connection" action
  | "atomize" // → "atomic" action
  | "synthesize" // → "synthesis" action
  | "tasks" // → "task" action
  | "brand" // → "brand" action
  | "clipping" // → "clipping" action
  | "challenge"; // → "antagonist" action

/**
 * Bulk workflow commands (vault/folder scope)
 */
export type BulkCommand = "enrich" | "link" | "classify";

/**
 * All supported slash commands
 */
export type SlashCommand = SingleNoteCommand | BulkCommand;

/**
 * Command mode - single note or bulk
 */
export type CommandMode = "single" | "bulk";

/**
 * Parsed command result
 */
export interface ParsedCommand {
  command: SlashCommand;
  mode: CommandMode;
  /** For bulk: vault/folder scope */
  scope?: WorkflowScope;
  /** For bulk: folder path (normalized) for folder scope, empty for vault scope */
  target?: string;
  /** For single: the IntelligenceActionType to execute */
  actionType?: IntelligenceActionType;
}

/**
 * Parse error result
 */
export interface ParseError {
  type:
    | "unknown_command"
    | "invalid_syntax"
    | "folder_not_found"
    | "empty_folder"
    | "no_active_note";
  message: string;
}

/**
 * Result of parsing a command
 */
export type ParseResult =
  | { success: true; parsed: ParsedCommand }
  | { success: false; error: ParseError };

/**
 * Single-note commands (run on current note)
 */
const SINGLE_NOTE_COMMANDS: SingleNoteCommand[] = [
  "enhance",
  "connect",
  "atomize",
  "synthesize",
  "tasks",
  "brand",
  "clipping",
  "challenge",
];

/**
 * Map single-note commands to IntelligenceActionType
 */
const COMMAND_TO_ACTION: Record<SingleNoteCommand, IntelligenceActionType> = {
  enhance: "enhance",
  connect: "connection",
  atomize: "atomic",
  synthesize: "synthesis",
  tasks: "task",
  brand: "brand",
  clipping: "clipping",
  challenge: "antagonist",
};

/**
 * Bulk workflow commands (run on folder/vault)
 */
const BULK_COMMANDS: BulkCommand[] = ["enrich", "link", "classify"];

/**
 * All valid command names
 */
const ALL_COMMANDS: SlashCommand[] = [...SINGLE_NOTE_COMMANDS, ...BULK_COMMANDS];

/**
 * Parse a slash command string
 *
 * Single-note syntax (current note):
 * - /enhance - enhance the current note
 * - /connect - find connections for current note
 * - /atomize - split current note into atomic concepts
 * - /tasks - extract tasks from current note
 *
 * Bulk workflow syntax:
 * - /enrich vault - run enrich on entire vault
 * - /enrich folder:inbox - run enrich on folder "inbox"
 * - /classify vault - run classify on entire vault
 *
 * @param input - The raw input string from omnibar
 * @param obsidian - ObsidianFacade for validating folders
 * @returns Parse result with either parsed command or error
 */
export function parseSlashCommand(input: string, obsidian: ObsidianFacade): ParseResult {
  const trimmed = input.trim();

  // Must start with /
  if (!trimmed.startsWith("/")) {
    return {
      success: false,
      error: {
        type: "invalid_syntax",
        message: "Command must start with /",
      },
    };
  }

  // Split into parts: /command [scope:target]
  const withoutSlash = trimmed.slice(1);
  const parts = withoutSlash.split(/\s+/);

  if (parts.length === 0 || !parts[0]) {
    return {
      success: false,
      error: {
        type: "invalid_syntax",
        message: "No command provided",
      },
    };
  }

  const commandName = parts[0].toLowerCase();

  // Check if it's a single-note command
  if (SINGLE_NOTE_COMMANDS.includes(commandName as SingleNoteCommand)) {
    const singleCmd = commandName as SingleNoteCommand;
    return {
      success: true,
      parsed: {
        command: singleCmd,
        mode: "single",
        actionType: COMMAND_TO_ACTION[singleCmd],
      },
    };
  }

  // Check if it's a bulk command
  if (BULK_COMMANDS.includes(commandName as BulkCommand)) {
    const bulkCmd = commandName as BulkCommand;
    return parseBulkCommand(bulkCmd, parts.slice(1), obsidian);
  }

  // Unknown command
  return {
    success: false,
    error: {
      type: "unknown_command",
      message: `Unknown command: ${commandName}. Try: ${ALL_COMMANDS.join(", ")}`,
    },
  };
}

/**
 * Parse bulk command arguments (scope/target)
 */
function parseBulkCommand(
  command: BulkCommand,
  args: string[],
  obsidian: ObsidianFacade,
): ParseResult {
  // If no args, default to vault scope
  if (args.length === 0) {
    return {
      success: true,
      parsed: {
        command,
        mode: "bulk",
        scope: "vault",
        target: "",
      },
    };
  }

  const scopePart = args[0].toLowerCase();

  // Handle "vault" keyword
  if (scopePart === "vault") {
    return {
      success: true,
      parsed: {
        command,
        mode: "bulk",
        scope: "vault",
        target: "",
      },
    };
  }

  // Handle "folder:path" syntax
  if (scopePart.startsWith("folder:")) {
    const folderPath = args.join(" ").slice(7); // Remove "folder:" prefix
    const normalizedPath = normalizePath(folderPath);

    // Validate folder exists
    const folder = obsidian.getFolderByPath(normalizedPath);
    if (!folder) {
      return {
        success: false,
        error: {
          type: "folder_not_found",
          message: `Folder not found: ${normalizedPath}`,
        },
      };
    }

    return {
      success: true,
      parsed: {
        command,
        mode: "bulk",
        scope: "folder",
        target: normalizedPath,
      },
    };
  }

  // Try to interpret as a folder path without prefix
  const normalizedPath = normalizePath(scopePart);
  const folder = obsidian.getFolderByPath(normalizedPath);

  if (folder) {
    return {
      success: true,
      parsed: {
        command,
        mode: "bulk",
        scope: "folder",
        target: normalizedPath,
      },
    };
  }

  // Invalid scope
  return {
    success: false,
    error: {
      type: "invalid_syntax",
      message: `Invalid scope: "${scopePart}". Use "vault" or "folder:path"`,
    },
  };
}

/**
 * Check if input looks like a slash command (starts with /)
 */
export function isSlashCommand(input: string): boolean {
  return input.trim().startsWith("/");
}

/**
 * Get command suggestions for autocomplete based on partial input
 */
export function getCommandSuggestions(partial?: string): CommandSuggestion[] {
  const all: CommandSuggestion[] = [
    // Single-note commands (current note)
    {
      command: "/enhance",
      label: "Enhance Note",
      description: "Add structure, depth, and polish to this note",
      icon: "sparkles",
      mode: "single",
    },
    {
      command: "/connect",
      label: "Find Connections",
      description: "Discover semantic links to other notes",
      icon: "link",
      mode: "single",
    },
    {
      command: "/atomize",
      label: "Atomize Note",
      description: "Split into atomic concepts (100-300 words each)",
      icon: "split",
      mode: "single",
    },
    {
      command: "/synthesize",
      label: "Create Synthesis",
      description: "Create synthesis note from related notes",
      icon: "network",
      mode: "single",
    },
    {
      command: "/tasks",
      label: "Extract Tasks",
      description: "Find actions, decisions, and deadlines",
      icon: "check-square",
      mode: "single",
    },
    {
      command: "/brand",
      label: "Brand Check",
      description: "Verify brand voice and tone alignment",
      icon: "shield",
      mode: "single",
    },
    {
      command: "/clipping",
      label: "Process Clipping",
      description: "Transform web clipping into structured notes",
      icon: "clipboard",
      mode: "single",
    },
    {
      command: "/challenge",
      label: "Challenge Ideas",
      description: "Get counterpoints from Antagonist Agent",
      icon: "flame",
      mode: "single",
    },

    // Bulk workflow commands
    {
      command: "/enrich vault",
      label: "Enrich Vault",
      description: "Add metadata and tags to all notes",
      icon: "folder",
      mode: "bulk",
    },
    {
      command: "/enrich folder:",
      label: "Enrich Folder",
      description: "Add metadata and tags to folder notes",
      icon: "folder-open",
      mode: "bulk",
    },
    {
      command: "/classify vault",
      label: "Classify Vault",
      description: "Suggest PARA categories for all notes",
      icon: "folder-tree",
      mode: "bulk",
    },
    {
      command: "/classify folder:",
      label: "Classify Folder",
      description: "Suggest PARA categories for folder notes",
      icon: "folder-tree",
      mode: "bulk",
    },
    {
      command: "/link vault",
      label: "Link Vault",
      description: "Find connections across all notes",
      icon: "link-2",
      mode: "bulk",
    },
    {
      command: "/link folder:",
      label: "Link Folder",
      description: "Find connections in folder notes",
      icon: "link-2",
      mode: "bulk",
    },
  ];

  if (!partial) return all;

  const q = partial.toLowerCase();
  return all.filter(
    (s) =>
      s.command.toLowerCase().startsWith(q) ||
      s.label.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q),
  );
}

/**
 * Command suggestion for autocomplete
 */
export interface CommandSuggestion {
  command: string;
  label: string;
  description: string;
  icon: string;
  mode: CommandMode;
}

/**
 * Get human-readable description for a command
 */
export function getCommandDescription(command: SlashCommand): string {
  switch (command) {
    // Single-note commands
    case "enhance":
      return "Add structure, depth, and polish to this note";
    case "connect":
      return "Discover semantic links to other notes";
    case "atomize":
      return "Split into atomic concepts (100-300 words each)";
    case "synthesize":
      return "Create synthesis note from related notes";
    case "tasks":
      return "Find actions, decisions, and deadlines";
    case "brand":
      return "Verify brand voice and tone alignment";
    case "clipping":
      return "Transform web clipping into structured notes";
    case "challenge":
      return "Get counterpoints from Antagonist Agent";
    // Bulk commands
    case "enrich":
      return "Add metadata, tags, and related content to notes";
    case "classify":
      return "Suggest PARA category and folder placement";
    case "link":
      return "Find and suggest related note links";
  }
}

/**
 * Check if a command is a single-note command
 */
export function isSingleNoteCommand(command: SlashCommand): command is SingleNoteCommand {
  return SINGLE_NOTE_COMMANDS.includes(command as SingleNoteCommand);
}

/**
 * Check if a command is a bulk command
 */
export function isBulkCommand(command: SlashCommand): command is BulkCommand {
  return BULK_COMMANDS.includes(command as BulkCommand);
}
