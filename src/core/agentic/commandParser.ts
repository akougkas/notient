/**
 * Command Parser
 *
 * Parses omnibar slash commands for bulk workflow operations.
 * Supports commands like:
 * - /enrich folder:inbox
 * - /classify vault
 * - /link folder:0-inbox
 */

import { normalizePath } from "obsidian";
import type { ObsidianFacade } from "../../adapters/obsidianFacade";
import type { WorkflowScope } from "./types";

/**
 * Supported slash commands
 */
export type SlashCommand = "enrich" | "link" | "classify";

/**
 * Parsed command result
 */
export interface ParsedCommand {
  command: SlashCommand;
  scope: WorkflowScope;
  /** Folder path (normalized) for folder scope, empty for vault scope */
  target: string;
}

/**
 * Parse error result
 */
export interface ParseError {
  type: "unknown_command" | "invalid_syntax" | "folder_not_found" | "empty_folder";
  message: string;
}

/**
 * Result of parsing a command
 */
export type ParseResult =
  | { success: true; parsed: ParsedCommand }
  | { success: false; error: ParseError };

/**
 * Valid command names
 */
const VALID_COMMANDS: SlashCommand[] = ["enrich", "link", "classify"];

/**
 * Parse a slash command string
 *
 * Syntax:
 * - /enrich vault - run enrich on entire vault
 * - /enrich folder:inbox - run enrich on folder "inbox"
 * - /classify folder:1-projects - run classify on folder "1-projects"
 * - /link vault - run link suggestions on entire vault
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

  const commandName = parts[0].toLowerCase() as SlashCommand;

  // Validate command
  if (!VALID_COMMANDS.includes(commandName)) {
    return {
      success: false,
      error: {
        type: "unknown_command",
        message: `Unknown command: ${commandName}. Valid commands: ${VALID_COMMANDS.join(", ")}`,
      },
    };
  }

  // Parse scope/target
  // If no second part, default to vault scope
  if (parts.length === 1) {
    return {
      success: true,
      parsed: {
        command: commandName,
        scope: "vault",
        target: "",
      },
    };
  }

  const scopePart = parts[1].toLowerCase();

  // Handle "vault" keyword
  if (scopePart === "vault") {
    return {
      success: true,
      parsed: {
        command: commandName,
        scope: "vault",
        target: "",
      },
    };
  }

  // Handle "folder:path" syntax
  if (scopePart.startsWith("folder:")) {
    const folderPath = parts.slice(1).join(" ").slice(7); // Remove "folder:" prefix and rejoin for paths with spaces
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
        command: commandName,
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
        command: commandName,
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
 * Get command suggestions for autocomplete
 */
export function getCommandSuggestions(): string[] {
  return [
    "/enrich vault",
    "/enrich folder:",
    "/classify vault",
    "/classify folder:",
    "/link vault",
    "/link folder:",
  ];
}

/**
 * Get human-readable description for a command
 */
export function getCommandDescription(command: SlashCommand): string {
  switch (command) {
    case "enrich":
      return "Add metadata, tags, and related content to notes";
    case "classify":
      return "Suggest PARA category and folder placement";
    case "link":
      return "Find and suggest related note links";
  }
}
