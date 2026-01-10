/**
 * Action Applier Service
 *
 * Applies proposed actions to notes with validation and undo support.
 */

import { normalizePath } from "obsidian";
import type { ObsidianFacade } from "../../adapters/obsidianFacade";
import type { Kernel } from "../kernel";
import { createUnifiedDiff, type ActionHistory } from "./actionHistory";
import type { TrustLevelManager } from "./trustLevelManager";
import {
  type AppendReviewSectionAction,
  type BatchAppendLinksAction,
  type BatchCreateNotesAction,
  type CreateNoteAction,
  type CreateSynthesisNoteAction,
  type CreateTaskNoteAction,
  type DiffUndoPayload,
  INTELLIGENCE_2_ACTION_TYPES,
  type ProposedAction,
  type RenameBackUndo,
  type RestoreContentUndo,
  type RestructureNoteAction,
} from "./types";

/** Result of applying an action */
export interface ApplyResult {
  success: boolean;
  recordId?: string;
  error?: string;
  requiresConfirmation?: boolean;
}

/** Context for applying an action with diff-based undo */
interface ApplyContext {
  action: ProposedAction;
  taskId?: string;
  workflowId?: string;
  reasoning?: string;
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
   * Apply a file modification with diff-based undo recording.
   * Common pattern for frontmatter_set, frontmatter_add_tags, append_section, etc.
   */
  private async applyWithDiffUndo(
    context: ApplyContext,
    targetPath: string,
    modifier: (content: string) => string | Promise<string>,
  ): Promise<ApplyResult> {
    const beforeContent = await this.obsidian.readFileByPath(targetPath);
    if (beforeContent === null) {
      return { success: false, error: `Could not read file: ${targetPath}` };
    }

    const newContent = await modifier(beforeContent);
    const result = await this.obsidian.modifyFile(targetPath, newContent);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const afterContent = await this.obsidian.readFileByPath(targetPath);
    if (afterContent === null) {
      return { success: false, error: `Could not read file after modification: ${targetPath}` };
    }

    const diff = createUnifiedDiff(afterContent, beforeContent, targetPath);
    const undoPayload: DiffUndoPayload = {
      type: "diff",
      patches: [{ path: targetPath, diff }],
    };

    const record = this.actionHistory.addRecord(
      context.action,
      undoPayload,
      [targetPath],
      context.reasoning ?? context.action.reason,
      context.workflowId,
      context.taskId,
    );

    return { success: true, recordId: record.id };
  }

  /**
   * Apply a frontmatter modification with diff-based undo recording.
   */
  private async applyFrontmatterWithDiffUndo(
    context: ApplyContext,
    targetPath: string,
    updater: (frontmatter: Record<string, unknown>) => void,
  ): Promise<ApplyResult> {
    const beforeContent = await this.obsidian.readFileByPath(targetPath);
    if (beforeContent === null) {
      return { success: false, error: `Could not read file: ${targetPath}` };
    }

    const result = await this.obsidian.processFrontMatter(targetPath, updater);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const afterContent = await this.obsidian.readFileByPath(targetPath);
    if (afterContent === null) {
      return { success: false, error: `Could not read file after modification: ${targetPath}` };
    }

    const diff = createUnifiedDiff(afterContent, beforeContent, targetPath);
    const undoPayload: DiffUndoPayload = {
      type: "diff",
      patches: [{ path: targetPath, diff }],
    };

    const record = this.actionHistory.addRecord(
      context.action,
      undoPayload,
      [targetPath],
      context.reasoning ?? context.action.reason,
      context.workflowId,
      context.taskId,
    );

    return { success: true, recordId: record.id };
  }

  /**
   * Apply a single action to a note
   * @param action - The proposed action to apply
   * @param taskId - Optional task ID that produced this action
   * @param workflowId - Optional workflow ID this action belongs to
   * @param skipConfirmation - Skip confirmation check (used after user approves)
   * @param reasoning - Why the agent made this decision (Phase 5)
   */
  async apply(
    action: ProposedAction,
    taskId?: string,
    workflowId?: string,
    skipConfirmation = false,
    reasoning = "Action applied by agent",
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
      const result = await this.applyAction(action, taskId, workflowId, reasoning);
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
    reasoning = "Action approved by user",
  ): Promise<ApplyResult> {
    return this.apply(action, taskId, workflowId, true, reasoning);
  }

  /**
   * Validate an action before applying
   */
  private validateAction(action: ProposedAction): string | null {
    // Validate target path
    const normalizedTarget = normalizePath(action.target);

    // Intelligence 2.0 actions that create new notes don't require existing target
    const creationActions = [
      "create_note",
      "batch_create_notes",
      "create_task_note",
      "create_synthesis_note",
    ];

    if (!creationActions.includes(action.type)) {
      // Check file exists
      if (!this.obsidian.getFileByPath(normalizedTarget)) {
        return `Target file not found: ${normalizedTarget}`;
      }

      // Check it's a markdown file
      if (!normalizedTarget.endsWith(".md")) {
        return `Target must be a markdown file: ${normalizedTarget}`;
      }
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

      // Intelligence 2.0 action types
      case "create_note":
        if (!action.payload.path || typeof action.payload.path !== "string") {
          return "create_note requires a valid path";
        }
        if (typeof action.payload.content !== "string") {
          return "create_note requires content";
        }
        // Check destination doesn't already exist
        if (this.obsidian.getFileByPath(normalizePath(action.payload.path))) {
          return `Note already exists: ${action.payload.path}`;
        }
        break;

      case "batch_create_notes":
        if (!Array.isArray(action.payload.notes) || action.payload.notes.length === 0) {
          return "batch_create_notes requires at least one note";
        }
        for (const note of action.payload.notes) {
          if (!note.path || !note.content) {
            return "Each note in batch must have path and content";
          }
          if (this.obsidian.getFileByPath(normalizePath(note.path))) {
            return `Note already exists: ${note.path}`;
          }
        }
        break;

      case "restructure_note":
        if (typeof action.payload.content !== "string") {
          return "restructure_note requires content";
        }
        break;

      case "create_task_note":
        if (!action.payload.path || typeof action.payload.path !== "string") {
          return "create_task_note requires a valid path";
        }
        if (!Array.isArray(action.payload.tasks) || action.payload.tasks.length === 0) {
          return "create_task_note requires at least one task";
        }
        break;

      case "create_synthesis_note":
        if (!action.payload.path || typeof action.payload.path !== "string") {
          return "create_synthesis_note requires a valid path";
        }
        if (typeof action.payload.content !== "string") {
          return "create_synthesis_note requires content";
        }
        break;

      case "append_review_section":
        if (typeof action.payload.score !== "number") {
          return "append_review_section requires a score";
        }
        if (!action.payload.findings) {
          return "append_review_section requires findings";
        }
        break;

      case "batch_append_links":
        if (!Array.isArray(action.payload.linkPairs) || action.payload.linkPairs.length === 0) {
          return "batch_append_links requires at least one link pair";
        }
        break;

      case "highlight_text_issues":
        if (!Array.isArray(action.payload.issues) || action.payload.issues.length === 0) {
          return "highlight_text_issues requires at least one issue";
        }
        break;

      case "extract_to_calendar":
        if (!action.payload.task || !action.payload.deadline) {
          return "extract_to_calendar requires task and deadline";
        }
        break;

      default:
        // Check if it's a reserved action type
        if (!INTELLIGENCE_2_ACTION_TYPES.includes(action.type)) {
          return `Unsupported action type: ${action.type}`;
        }
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
    reasoning?: string,
  ): Promise<ApplyResult> {
    switch (action.type) {
      // Phase 2 actions
      case "frontmatter_set":
        return this.applyFrontmatterSet(action, taskId, workflowId, reasoning);

      case "frontmatter_add_tags":
        return this.applyFrontmatterAddTags(action, taskId, workflowId, reasoning);

      case "append_section":
        return this.applyAppendSection(action, taskId, workflowId, reasoning);

      case "append_related_links":
        return this.applyAppendRelatedLinks(action, taskId, workflowId, reasoning);

      case "move_note":
        return this.applyMoveNote(action, taskId, workflowId, reasoning);

      // Intelligence 2.0 actions
      case "create_note":
        return this.applyCreateNote(action as CreateNoteAction, taskId, workflowId, reasoning);

      case "batch_create_notes":
        return this.applyBatchCreateNotes(action as BatchCreateNotesAction, taskId, workflowId, reasoning);

      case "restructure_note":
        return this.applyRestructureNote(action as RestructureNoteAction, taskId, workflowId, reasoning);

      case "create_task_note":
        return this.applyCreateTaskNote(action as CreateTaskNoteAction, taskId, workflowId, reasoning);

      case "create_synthesis_note":
        return this.applyCreateSynthesisNote(
          action as CreateSynthesisNoteAction,
          taskId,
          workflowId,
          reasoning,
        );

      case "append_review_section":
        return this.applyAppendReviewSection(
          action as AppendReviewSectionAction,
          taskId,
          workflowId,
          reasoning,
        );

      case "batch_append_links":
        return this.applyBatchAppendLinks(action as BatchAppendLinksAction, taskId, workflowId, reasoning);

      case "highlight_text_issues":
        console.warn("[ActionApplier] Action type 'highlight_text_issues' is not yet implemented");
        return {
          success: false,
          error: "Action type 'highlight_text_issues' is not yet implemented",
        };

      case "extract_to_calendar":
        console.warn("[ActionApplier] Action type 'extract_to_calendar' is not yet implemented");
        return {
          success: false,
          error: "Action type 'extract_to_calendar' is not yet implemented",
        };

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
    reasoning?: string,
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

    // Read after content for diff
    const afterContent = await this.obsidian.readFileByPath(target);
    if (afterContent === null) {
      return { success: false, error: `Could not read file after modification: ${target}` };
    }

    // Generate diff-based undo
    const diff = createUnifiedDiff(afterContent, beforeContent, target);
    const undoPayload: DiffUndoPayload = {
      type: "diff",
      patches: [{ path: target, diff }],
    };

    // Record for undo with new signature
    const record = this.actionHistory.addRecord(
      action,
      undoPayload,
      [target],
      reasoning ?? action.reason,
      workflowId,
      taskId,
    );

    return { success: true, recordId: record.id };
  }

  /**
   * Add tags to frontmatter
   */
  private async applyFrontmatterAddTags(
    action: ProposedAction & { type: "frontmatter_add_tags" },
    taskId?: string,
    workflowId?: string,
    reasoning?: string,
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

    // Read after content for diff
    const afterContent = await this.obsidian.readFileByPath(target);
    if (afterContent === null) {
      return { success: false, error: `Could not read file after modification: ${target}` };
    }

    // Generate diff-based undo
    const diff = createUnifiedDiff(afterContent, beforeContent, target);
    const undoPayload: DiffUndoPayload = {
      type: "diff",
      patches: [{ path: target, diff }],
    };

    // Record for undo
    const record = this.actionHistory.addRecord(
      action,
      undoPayload,
      [target],
      reasoning ?? action.reason,
      workflowId,
      taskId,
    );

    return { success: true, recordId: record.id };
  }

  /**
   * Append a section to the note
   */
  private async applyAppendSection(
    action: ProposedAction & { type: "append_section" },
    taskId?: string,
    workflowId?: string,
    reasoning?: string,
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

    // Read after content for diff
    const afterContent = await this.obsidian.readFileByPath(target);
    if (afterContent === null) {
      return { success: false, error: `Could not read file after modification: ${target}` };
    }

    // Generate diff-based undo
    const diff = createUnifiedDiff(afterContent, beforeContent, target);
    const undoPayload: DiffUndoPayload = {
      type: "diff",
      patches: [{ path: target, diff }],
    };

    // Record for undo
    const record = this.actionHistory.addRecord(
      action,
      undoPayload,
      [target],
      reasoning ?? action.reason,
      workflowId,
      taskId,
    );

    return { success: true, recordId: record.id };
  }

  /**
   * Append a "Related Notes" section with links
   */
  private async applyAppendRelatedLinks(
    action: ProposedAction & { type: "append_related_links" },
    taskId?: string,
    workflowId?: string,
    reasoning?: string,
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

    // Read after content for diff
    const afterContent = await this.obsidian.readFileByPath(target);
    if (afterContent === null) {
      return { success: false, error: `Could not read file after modification: ${target}` };
    }

    // Generate diff-based undo
    const diff = createUnifiedDiff(afterContent, beforeContent, target);
    const undoPayload: DiffUndoPayload = {
      type: "diff",
      patches: [{ path: target, diff }],
    };

    // Record for undo
    const record = this.actionHistory.addRecord(
      action,
      undoPayload,
      [target],
      reasoning ?? action.reason,
      workflowId,
      taskId,
    );

    return { success: true, recordId: record.id };
  }

  /**
   * Move a note to a different location
   */
  private async applyMoveNote(
    action: ProposedAction & { type: "move_note" },
    taskId?: string,
    workflowId?: string,
    reasoning?: string,
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
    const undoPayload: RenameBackUndo = {
      type: "rename_back",
      from: to, // Current location (after move)
      to: from, // Original location (to restore)
    };

    const record = this.actionHistory.addRecord(
      action,
      undoPayload,
      [from, to],
      reasoning ?? action.reason,
      workflowId,
      taskId,
    );

    return { success: true, recordId: record.id };
  }

  // =============================================================================
  // Intelligence 2.0 Action Implementations
  // =============================================================================

  /**
   * Create a new note with content
   */
  private async applyCreateNote(
    action: CreateNoteAction,
    taskId?: string,
    workflowId?: string,
    reasoning?: string,
  ): Promise<ApplyResult> {
    const { payload } = action;
    const notePath = normalizePath(payload.path);

    // Ensure parent folder exists
    const parentPath = this.obsidian.getParentFolderPath(notePath);
    if (parentPath) {
      const folderResult = await this.obsidian.createFolderIfNeeded(parentPath);
      if (!folderResult.success) {
        return {
          success: false,
          error: `Failed to create folder ${parentPath}: ${folderResult.error}`,
        };
      }
    }

    // Build content with frontmatter
    let content = "";
    if (payload.frontmatter && Object.keys(payload.frontmatter).length > 0) {
      content += "---\n";
      for (const [key, value] of Object.entries(payload.frontmatter)) {
        if (Array.isArray(value)) {
          content += `${key}:\n${value.map((v) => `  - ${v}`).join("\n")}\n`;
        } else {
          content += `${key}: ${JSON.stringify(value)}\n`;
        }
      }
      content += "---\n\n";
    }
    content += payload.content;

    // Create the file
    const result = await this.obsidian.createFile(notePath, content);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Record for undo (delete the created file - use RestoreContentUndo with empty before)
    const undoPayload: RestoreContentUndo = {
      type: "restore_content",
      files: [{ path: notePath, before: "" }], // Empty = file didn't exist
    };

    const record = this.actionHistory.addRecord(
      action,
      undoPayload,
      [notePath],
      reasoning ?? action.reason,
      workflowId,
      taskId,
    );

    return { success: true, recordId: record.id };
  }

  /**
   * Create multiple notes in batch
   */
  private async applyBatchCreateNotes(
    action: BatchCreateNotesAction,
    taskId?: string,
    workflowId?: string,
    reasoning?: string,
  ): Promise<ApplyResult> {
    const { payload } = action;
    const createdPaths: string[] = [];
    const errors: string[] = [];

    for (const note of payload.notes) {
      const notePath = normalizePath(note.path);

      // Ensure parent folder exists
      const parentPath = this.obsidian.getParentFolderPath(notePath);
      if (parentPath) {
        const folderResult = await this.obsidian.createFolderIfNeeded(parentPath);
        if (!folderResult.success) {
          errors.push(`Failed to create folder ${parentPath}: ${folderResult.error}`);
          continue;
        }
      }

      // Build content with frontmatter
      let content = "";
      if (note.frontmatter && Object.keys(note.frontmatter).length > 0) {
        content += "---\n";
        for (const [key, value] of Object.entries(note.frontmatter)) {
          if (Array.isArray(value)) {
            content += `${key}:\n${value.map((v) => `  - ${v}`).join("\n")}\n`;
          } else {
            content += `${key}: ${JSON.stringify(value)}\n`;
          }
        }
        content += "---\n\n";
      }
      content += note.content;

      // Create the file
      const result = await this.obsidian.createFile(notePath, content);
      if (!result.success) {
        errors.push(`Failed to create ${notePath}: ${result.error}`);
        continue;
      }

      createdPaths.push(notePath);
    }

    if (createdPaths.length === 0) {
      return { success: false, error: errors.join("; ") };
    }

    // Record for undo
    const undoPayload: RestoreContentUndo = {
      type: "restore_content",
      files: createdPaths.map((p) => ({ path: p, before: "" })),
    };

    const record = this.actionHistory.addRecord(
      action,
      undoPayload,
      createdPaths,
      reasoning ?? action.reason,
      workflowId,
      taskId,
    );

    if (errors.length > 0) {
      return {
        success: true,
        recordId: record.id,
        error: `Created ${createdPaths.length}/${payload.notes.length} notes. Errors: ${errors.join("; ")}`,
      };
    }

    return { success: true, recordId: record.id };
  }

  /**
   * Restructure an existing note
   */
  private async applyRestructureNote(
    action: RestructureNoteAction,
    taskId?: string,
    workflowId?: string,
    reasoning?: string,
  ): Promise<ApplyResult> {
    const { target, payload } = action;

    // Read before content for undo
    const beforeContent = await this.obsidian.readFileByPath(target);
    if (beforeContent === null) {
      return { success: false, error: `Could not read file: ${target}` };
    }

    // Build links to extracted sections
    let newContent = payload.content;
    if (payload.extractedSections.length > 0) {
      newContent += "\n\n## Extracted Sections\n\n";
      for (const section of payload.extractedSections) {
        const noteName = section.newNotePath.replace(/\.md$/, "").split("/").pop();
        newContent += `- [[${noteName}]] (${section.heading})\n`;
      }
    }

    // Apply the change
    const result = await this.obsidian.processFile(target, () => newContent);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Read after content for diff
    const afterContent = await this.obsidian.readFileByPath(target);
    if (afterContent === null) {
      return { success: false, error: `Could not read file after modification: ${target}` };
    }

    // Generate diff-based undo
    const diff = createUnifiedDiff(afterContent, beforeContent, target);
    const undoPayload: DiffUndoPayload = {
      type: "diff",
      patches: [{ path: target, diff }],
    };

    // Record for undo
    const record = this.actionHistory.addRecord(
      action,
      undoPayload,
      [target],
      reasoning ?? action.reason,
      workflowId,
      taskId,
    );

    return { success: true, recordId: record.id };
  }

  /**
   * Create a task note with structured task list
   */
  private async applyCreateTaskNote(
    action: CreateTaskNoteAction,
    taskId?: string,
    workflowId?: string,
    reasoning?: string,
  ): Promise<ApplyResult> {
    const { payload } = action;
    const notePath = normalizePath(payload.path);

    // Ensure parent folder exists
    const parentPath = this.obsidian.getParentFolderPath(notePath);
    if (parentPath) {
      const folderResult = await this.obsidian.createFolderIfNeeded(parentPath);
      if (!folderResult.success) {
        return {
          success: false,
          error: `Failed to create folder ${parentPath}: ${folderResult.error}`,
        };
      }
    }

    // Build task note content
    const today = new Date().toISOString().split("T")[0];
    let content = `---
created: ${today}
tags: [tasks]
type: task-list
---

# Tasks

`;

    // Group tasks by category
    const categories = ["immediate", "planned", "backlog", "blocked"] as const;
    for (const category of categories) {
      const categoryTasks = payload.tasks.filter((t) => t.category === category);
      if (categoryTasks.length > 0) {
        content += `## ${category.charAt(0).toUpperCase() + category.slice(1)}\n\n`;
        for (const task of categoryTasks) {
          content += `- [ ] ${task.text}`;
          if (task.deadline) {
            content += ` (Due: ${task.deadline})`;
          }
          if (task.project) {
            content += ` #${task.project.replace(/[^a-zA-Z0-9-]/g, "-")}`;
          }
          content += "\n";
        }
        content += "\n";
      }
    }

    // Add decisions if present
    if (payload.decisions && payload.decisions.length > 0) {
      content += "## Decisions\n\n";
      for (const decision of payload.decisions) {
        content += `**${decision.date || today}: ${decision.decision}**\n`;
        content += `- Rationale: ${decision.rationale}\n\n`;
      }
    }

    // Create the file
    const result = await this.obsidian.createFile(notePath, content);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Record for undo (delete the created file)
    const undoPayload: RestoreContentUndo = {
      type: "restore_content",
      files: [{ path: notePath, before: "" }],
    };

    const record = this.actionHistory.addRecord(
      action,
      undoPayload,
      [notePath],
      reasoning ?? action.reason,
      workflowId,
      taskId,
    );

    return { success: true, recordId: record.id };
  }

  /**
   * Create a synthesis note
   */
  private async applyCreateSynthesisNote(
    action: CreateSynthesisNoteAction,
    taskId?: string,
    workflowId?: string,
    reasoning?: string,
  ): Promise<ApplyResult> {
    const { payload } = action;
    const notePath = normalizePath(payload.path);

    // Ensure parent folder exists
    const parentPath = this.obsidian.getParentFolderPath(notePath);
    if (parentPath) {
      const folderResult = await this.obsidian.createFolderIfNeeded(parentPath);
      if (!folderResult.success) {
        return {
          success: false,
          error: `Failed to create folder ${parentPath}: ${folderResult.error}`,
        };
      }
    }

    // Build content with frontmatter
    let content = "";
    const frontmatter = payload.frontmatter || {
      created: new Date().toISOString().split("T")[0],
      tags: ["synthesis"],
      type: "synthesis",
    };

    content += "---\n";
    for (const [key, value] of Object.entries(frontmatter)) {
      if (Array.isArray(value)) {
        content += `${key}:\n${value.map((v) => `  - ${v}`).join("\n")}\n`;
      } else {
        content += `${key}: ${JSON.stringify(value)}\n`;
      }
    }
    content += "---\n\n";
    content += payload.content;

    // Add source notes if present
    if (payload.sourceNotes && payload.sourceNotes.length > 0) {
      content += "\n\n## Source Notes\n\n";
      for (const source of payload.sourceNotes) {
        content += `- [[${source}]]\n`;
      }
    }

    // Create the file
    const result = await this.obsidian.createFile(notePath, content);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Record for undo (delete the created file)
    const undoPayload: RestoreContentUndo = {
      type: "restore_content",
      files: [{ path: notePath, before: "" }],
    };

    const record = this.actionHistory.addRecord(
      action,
      undoPayload,
      [notePath],
      reasoning ?? action.reason,
      workflowId,
      taskId,
    );

    return { success: true, recordId: record.id };
  }

  /**
   * Append a review section to a note
   */
  private async applyAppendReviewSection(
    action: AppendReviewSectionAction,
    taskId?: string,
    workflowId?: string,
    reasoning?: string,
  ): Promise<ApplyResult> {
    const { target, payload } = action;

    // Read before content for undo
    const beforeContent = await this.obsidian.readFileByPath(target);
    if (beforeContent === null) {
      return { success: false, error: `Could not read file: ${target}` };
    }

    // Build the review section
    let sectionContent = `\n\n## ${payload.reviewType.charAt(0).toUpperCase() + payload.reviewType.slice(1)} Review\n\n`;
    sectionContent += `**Score:** ${payload.score}/10\n`;
    sectionContent += `**Date:** ${payload.date}\n\n`;

    if (payload.findings.strengths.length > 0) {
      sectionContent += "### Strengths\n\n";
      for (const s of payload.findings.strengths) {
        sectionContent += `- ${s}\n`;
      }
      sectionContent += "\n";
    }

    if (payload.findings.concerns.length > 0) {
      sectionContent += "### Concerns\n\n";
      for (const c of payload.findings.concerns) {
        sectionContent += `- ${c}\n`;
      }
      sectionContent += "\n";
    }

    if (payload.findings.suggestions.length > 0) {
      sectionContent += "### Suggestions\n\n";
      for (const s of payload.findings.suggestions) {
        sectionContent += `- ${s}\n`;
      }
    }

    // Apply the change
    const result = await this.obsidian.processFile(target, (content) => {
      return content.trimEnd() + sectionContent;
    });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Read after content for diff
    const afterContent = await this.obsidian.readFileByPath(target);
    if (afterContent === null) {
      return { success: false, error: `Could not read file after modification: ${target}` };
    }

    // Generate diff-based undo
    const diff = createUnifiedDiff(afterContent, beforeContent, target);
    const undoPayload: DiffUndoPayload = {
      type: "diff",
      patches: [{ path: target, diff }],
    };

    // Record for undo
    const record = this.actionHistory.addRecord(
      action,
      undoPayload,
      [target],
      reasoning ?? action.reason,
      workflowId,
      taskId,
    );

    return { success: true, recordId: record.id };
  }

  /**
   * Batch append links to multiple notes
   */
  private async applyBatchAppendLinks(
    action: BatchAppendLinksAction,
    taskId?: string,
    workflowId?: string,
    reasoning?: string,
  ): Promise<ApplyResult> {
    const { payload } = action;
    const changedPaths: string[] = [];
    const patches: Array<{ path: string; diff: string }> = [];
    const errors: string[] = [];

    // Group link pairs by source note
    const linksBySource = new Map<string, Array<{ toNote: string; context: string }>>();
    for (const pair of payload.linkPairs) {
      const fromPath = normalizePath(pair.fromNote);
      if (!linksBySource.has(fromPath)) {
        linksBySource.set(fromPath, []);
      }
      linksBySource.get(fromPath)?.push({ toNote: pair.toNote, context: pair.context });
    }

    // Apply links to each source note
    for (const [fromPath, links] of linksBySource) {
      const beforeContent = await this.obsidian.readFileByPath(fromPath);
      if (beforeContent === null) {
        errors.push(`Could not read file: ${fromPath}`);
        continue;
      }

      // Build links section
      const linksList = links.map((l) => `- [[${l.toNote}]] - ${l.context}`).join("\n");
      const sectionContent = `\n\n## Related Notes\n\n${linksList}`;

      const result = await this.obsidian.processFile(fromPath, (content) => {
        return content.trimEnd() + sectionContent;
      });

      if (!result.success) {
        errors.push(`Failed to update ${fromPath}: ${result.error}`);
        continue;
      }

      // Read after content for diff
      const afterContent = await this.obsidian.readFileByPath(fromPath);
      if (afterContent !== null) {
        const diff = createUnifiedDiff(afterContent, beforeContent, fromPath);
        patches.push({ path: fromPath, diff });
      }

      changedPaths.push(fromPath);
    }

    if (changedPaths.length === 0) {
      return { success: false, error: errors.join("; ") };
    }

    // Record for undo with diff patches
    const undoPayload: DiffUndoPayload = {
      type: "diff",
      patches,
    };

    const record = this.actionHistory.addRecord(
      action,
      undoPayload,
      changedPaths,
      reasoning ?? action.reason,
      workflowId,
      taskId,
    );

    if (errors.length > 0) {
      return {
        success: true,
        recordId: record.id,
        error: `Updated ${changedPaths.length} notes. Errors: ${errors.join("; ")}`,
      };
    }

    return { success: true, recordId: record.id };
  }
}
