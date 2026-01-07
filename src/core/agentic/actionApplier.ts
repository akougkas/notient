/**
 * Action Applier Service
 *
 * Applies proposed actions to notes, enforcing validation and write-lock.
 * Records undo data for all applied actions.
 */

import { normalizePath } from "obsidian";
import type { ObsidianFacade } from "../../adapters/obsidianFacade";
import type { Kernel } from "../kernel";
import type { ActionHistory } from "./actionHistory";
import type { TrustLevelManager } from "./trustLevelManager";
import type {
  AppliedActionRecord,
  ProposedAction,
  RenameBackUndo,
  RestoreContentUndo,
} from "./types";

/**
 * Result of applying an action
 */
export interface ApplyResult {
  success: boolean;
  recordId?: string;
  error?: string;
  requiresConfirmation?: boolean;
}

/**
 * Applies proposed actions to notes with validation and undo support
 */
export class ActionApplier {
  constructor(
    private kernel: Kernel,
    private obsidian: ObsidianFacade,
    private actionHistory: ActionHistory,
    private trustManager: TrustLevelManager,
  ) {}

  /**
   * Apply a single action to a note
   * @param action - The proposed action to apply
   * @param taskId - Optional task ID that produced this action
   * @param workflowId - Optional workflow ID this action belongs to
   * @param skipConfirmation - Skip confirmation check (used after user approves)
   */
  async apply(
    action: ProposedAction,
    taskId?: string,
    workflowId?: string,
    skipConfirmation = false,
  ): Promise<ApplyResult> {
    // 1. Check write lock
    if (!this.kernel.hasWriteLock) {
      return {
        success: false,
        error: "Cannot apply action: write lock not held. Another instance may be editing.",
      };
    }

    // 2. Check trust decision
    if (!skipConfirmation) {
      const trustDecision = this.trustManager.evaluate(action);
      if (!trustDecision.allowed) {
        return {
          success: false,
          error: trustDecision.reason || "Action not allowed by trust policy",
        };
      }
      if (trustDecision.requiresConfirmation) {
        return {
          success: false,
          requiresConfirmation: true,
          error: "Action requires user confirmation",
        };
      }
    }

    // 3. Validate the action
    const validationError = this.validateAction(action);
    if (validationError) {
      return { success: false, error: validationError };
    }

    // 4. Apply based on action type
    try {
      const result = await this.applyAction(action, taskId, workflowId);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ActionApplier] Apply failed:", message);
      return { success: false, error: message };
    }
  }

  /**
   * Apply an action after user confirmation (skips confirmation check)
   */
  async applyConfirmed(
    action: ProposedAction,
    taskId?: string,
    workflowId?: string,
  ): Promise<ApplyResult> {
    return this.apply(action, taskId, workflowId, true);
  }

  /**
   * Validate an action before applying
   */
  private validateAction(action: ProposedAction): string | null {
    // Validate target path
    const normalizedTarget = normalizePath(action.target);

    // Check file exists
    if (!this.obsidian.getFileByPath(normalizedTarget)) {
      return `Target file not found: ${normalizedTarget}`;
    }

    // Check it's a markdown file
    if (!normalizedTarget.endsWith(".md")) {
      return `Target must be a markdown file: ${normalizedTarget}`;
    }

    // Check not in excluded folders
    const settings = this.kernel.settings;
    const excludedFolders = settings.indexing.excludedFolders || [];
    for (const excluded of excludedFolders) {
      if (normalizedTarget.startsWith(`${excluded}/`) || normalizedTarget === excluded) {
        return `Target is in excluded folder: ${excluded}`;
      }
    }

    // Type-specific validation
    switch (action.type) {
      case "frontmatter_set":
        if (!action.payload.key || typeof action.payload.key !== "string") {
          return "frontmatter_set requires a valid key";
        }
        break;

      case "frontmatter_add_tags":
        if (!Array.isArray(action.payload.tags) || action.payload.tags.length === 0) {
          return "frontmatter_add_tags requires at least one tag";
        }
        break;

      case "append_section":
        if (typeof action.payload.content !== "string") {
          return "append_section requires content";
        }
        break;

      case "append_related_links":
        if (!Array.isArray(action.payload.links) || action.payload.links.length === 0) {
          return "append_related_links requires at least one link";
        }
        break;

      case "move_note":
        if (!action.payload.to || typeof action.payload.to !== "string") {
          return "move_note requires a destination path";
        }
        // Check destination doesn't already exist
        if (this.obsidian.getFileByPath(normalizePath(action.payload.to))) {
          return `Destination already exists: ${action.payload.to}`;
        }
        break;

      default:
        return `Unsupported action type: ${action.type}`;
    }

    return null;
  }

  /**
   * Apply the action and record undo data
   */
  private async applyAction(
    action: ProposedAction,
    taskId?: string,
    workflowId?: string,
  ): Promise<ApplyResult> {
    switch (action.type) {
      case "frontmatter_set":
        return this.applyFrontmatterSet(action, taskId, workflowId);

      case "frontmatter_add_tags":
        return this.applyFrontmatterAddTags(action, taskId, workflowId);

      case "append_section":
        return this.applyAppendSection(action, taskId, workflowId);

      case "append_related_links":
        return this.applyAppendRelatedLinks(action, taskId, workflowId);

      case "move_note":
        return this.applyMoveNote(action, taskId, workflowId);

      default:
        return { success: false, error: `Unsupported action type: ${action.type}` };
    }
  }

  /**
   * Set a frontmatter field
   */
  private async applyFrontmatterSet(
    action: ProposedAction & { type: "frontmatter_set" },
    taskId?: string,
    workflowId?: string,
  ): Promise<ApplyResult> {
    const { target, payload } = action;

    // Read before content for undo
    const beforeContent = await this.obsidian.readFileByPath(target);
    if (beforeContent === null) {
      return { success: false, error: `Could not read file: ${target}` };
    }

    // Apply the change
    const result = await this.obsidian.processFrontMatter(target, (fm) => {
      fm[payload.key] = payload.value;
    });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Record for undo
    const record = this.createRecord(
      action,
      [target],
      {
        type: "restore_content",
        files: [{ path: target, before: beforeContent }],
      },
      taskId,
      workflowId,
    );

    this.actionHistory.addRecord(record);
    return { success: true, recordId: record.id };
  }

  /**
   * Add tags to frontmatter
   */
  private async applyFrontmatterAddTags(
    action: ProposedAction & { type: "frontmatter_add_tags" },
    taskId?: string,
    workflowId?: string,
  ): Promise<ApplyResult> {
    const { target, payload } = action;

    // Read before content for undo
    const beforeContent = await this.obsidian.readFileByPath(target);
    if (beforeContent === null) {
      return { success: false, error: `Could not read file: ${target}` };
    }

    // Apply the change
    const result = await this.obsidian.processFrontMatter(target, (fm) => {
      const existingTags = Array.isArray(fm.tags) ? fm.tags : [];
      const newTags = [...new Set([...existingTags, ...payload.tags])];
      fm.tags = newTags;
    });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Record for undo
    const record = this.createRecord(
      action,
      [target],
      {
        type: "restore_content",
        files: [{ path: target, before: beforeContent }],
      },
      taskId,
      workflowId,
    );

    this.actionHistory.addRecord(record);
    return { success: true, recordId: record.id };
  }

  /**
   * Append a section to the note
   */
  private async applyAppendSection(
    action: ProposedAction & { type: "append_section" },
    taskId?: string,
    workflowId?: string,
  ): Promise<ApplyResult> {
    const { target, payload } = action;

    // Read before content for undo
    const beforeContent = await this.obsidian.readFileByPath(target);
    if (beforeContent === null) {
      return { success: false, error: `Could not read file: ${target}` };
    }

    // Build the section to append
    let sectionContent = "\n\n";
    if (payload.heading) {
      sectionContent += `## ${payload.heading}\n\n`;
    }
    sectionContent += payload.content;

    // Apply the change
    const result = await this.obsidian.processFile(target, (content) => {
      return content.trimEnd() + sectionContent;
    });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Record for undo
    const record = this.createRecord(
      action,
      [target],
      {
        type: "restore_content",
        files: [{ path: target, before: beforeContent }],
      },
      taskId,
      workflowId,
    );

    this.actionHistory.addRecord(record);
    return { success: true, recordId: record.id };
  }

  /**
   * Append a "Related Notes" section with links
   */
  private async applyAppendRelatedLinks(
    action: ProposedAction & { type: "append_related_links" },
    taskId?: string,
    workflowId?: string,
  ): Promise<ApplyResult> {
    const { target, payload } = action;

    // Read before content for undo
    const beforeContent = await this.obsidian.readFileByPath(target);
    if (beforeContent === null) {
      return { success: false, error: `Could not read file: ${target}` };
    }

    // Build the links section
    const linksList = payload.links.map((link) => `- [[${link}]]`).join("\n");
    const sectionContent = `\n\n## Related Notes\n\n${linksList}`;

    // Apply the change
    const result = await this.obsidian.processFile(target, (content) => {
      return content.trimEnd() + sectionContent;
    });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Record for undo
    const record = this.createRecord(
      action,
      [target],
      {
        type: "restore_content",
        files: [{ path: target, before: beforeContent }],
      },
      taskId,
      workflowId,
    );

    this.actionHistory.addRecord(record);
    return { success: true, recordId: record.id };
  }

  /**
   * Move a note to a different location
   */
  private async applyMoveNote(
    action: ProposedAction & { type: "move_note" },
    taskId?: string,
    workflowId?: string,
  ): Promise<ApplyResult> {
    const { target, payload } = action;
    const from = normalizePath(target);
    const to = normalizePath(payload.to);

    // Ensure destination folder exists
    const parentPath = this.obsidian.getParentFolderPath(to);
    if (parentPath) {
      const folderResult = await this.obsidian.createFolderIfNeeded(parentPath);
      if (!folderResult.success) {
        return {
          success: false,
          error: `Failed to create folder ${parentPath}: ${folderResult.error}`,
        };
      }
    }

    // Apply the move
    const result = await this.obsidian.renameFile(from, to);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Record for undo (rename back)
    const record = this.createRecord(
      action,
      [from, to],
      {
        type: "rename_back",
        from: to, // Current location (after move)
        to: from, // Original location (to restore)
      } as RenameBackUndo,
      taskId,
      workflowId,
    );

    this.actionHistory.addRecord(record);
    return { success: true, recordId: record.id };
  }

  /**
   * Create an applied action record
   */
  private createRecord(
    action: ProposedAction,
    changedPaths: string[],
    undo: RestoreContentUndo | RenameBackUndo,
    taskId?: string,
    workflowId?: string,
  ): AppliedActionRecord {
    return {
      id: `applied-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      workflowId,
      taskId,
      action,
      changedPaths,
      undo,
    };
  }
}
