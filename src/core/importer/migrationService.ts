/**
 * Migration Service
 *
 * Orchestrates the "Expand Your Knowledge" flow:
 * 1. Import files from external source (normalize links)
 * 2. Trigger indexing for new notes
 * 3. Queue agent workflows for analysis
 *
 * Fire-and-forget: queues background work and returns immediately.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { normalizeMarkdownFile } from "../../../tools/import-bridge/normalizer";
import type { EventBus } from "../events/eventBus";
import { generateId } from "../ids";
import type { Kernel } from "../kernel";

/** Migration status for tracking */
export interface MigrationStatus {
  id: string;
  sourcePath: string;
  destFolder: string;
  status: "pending" | "importing" | "indexing" | "analyzing" | "complete" | "failed";
  progress: {
    filesTotal: number;
    filesImported: number;
    linksConverted: number;
  };
  startedAt: number;
  completedAt?: number;
  error?: string;
}

/**
 * MigrationService - orchestrates import → index → analyze flow
 */
export class MigrationService {
  private currentMigration: MigrationStatus | null = null;

  constructor(
    private kernel: Kernel,
    private eventBus: EventBus,
  ) {}

  /**
   * Start a migration (fire-and-forget)
   * Returns immediately after queueing the work
   */
  async startMigration(sourcePath: string, destFolder: string): Promise<void> {
    // Validate source path exists
    if (!existsSync(sourcePath)) {
      throw new Error(`Source folder not found: ${sourcePath}`);
    }

    const stat = statSync(sourcePath);
    if (!stat.isDirectory()) {
      throw new Error(`Source path is not a directory: ${sourcePath}`);
    }

    // Find markdown files
    const markdownFiles = this.findMarkdownFiles(sourcePath);
    if (markdownFiles.length === 0) {
      throw new Error("No markdown files found in source folder");
    }

    // Create migration status
    const migration: MigrationStatus = {
      id: generateId("mig"),
      sourcePath,
      destFolder: destFolder || "imports",
      status: "pending",
      progress: {
        filesTotal: markdownFiles.length,
        filesImported: 0,
        linksConverted: 0,
      },
      startedAt: Date.now(),
    };

    this.currentMigration = migration;

    // Emit start event
    this.eventBus.emit("migration:started", { migration });

    // Run migration in background (don't await)
    this.runMigration(migration, markdownFiles).catch((error) => {
      console.error("[MigrationService] Migration failed:", error);
      migration.status = "failed";
      migration.error = error instanceof Error ? error.message : String(error);
      this.eventBus.emit("migration:failed", { migration, error: migration.error });
    });

    console.log(`[MigrationService] Migration started: ${markdownFiles.length} files`);
  }

  /**
   * Get current migration status
   */
  getCurrentMigration(): MigrationStatus | null {
    return this.currentMigration;
  }

  /**
   * Import a single file into the vault.
   */
  private async importSingleFile(
    vault: import("obsidian").Vault,
    filePath: string,
    sourcePath: string,
    destFolder: string,
    migration: MigrationStatus,
  ): Promise<void> {
    const content = readFileSync(filePath, "utf-8");
    const result = normalizeMarkdownFile(content);

    const relativePath = relative(sourcePath, filePath);
    const targetPath = join(destFolder, relativePath).replace(/\\/g, "/");

    const parentPath = targetPath.split("/").slice(0, -1).join("/");
    if (parentPath && !vault.getAbstractFileByPath(parentPath)) {
      await vault.createFolder(parentPath);
    }

    const existing = vault.getAbstractFileByPath(targetPath);
    if (existing) {
      await vault.modify(existing as import("obsidian").TFile, result.normalized);
    } else {
      await vault.create(targetPath, result.normalized);
    }

    migration.progress.filesImported++;
    migration.progress.linksConverted += result.conversions.length;
  }

  /**
   * Phase 1: Import all files into the vault.
   */
  private async runImportPhase(migration: MigrationStatus, files: string[]): Promise<void> {
    const vault = this.kernel.obsidian.vault;
    const { sourcePath, destFolder } = migration;

    migration.status = "importing";
    this.eventBus.emit("migration:progress", { migration, phase: "importing" });

    const destExists = vault.getAbstractFileByPath(destFolder);
    if (!destExists) {
      await vault.createFolder(destFolder);
    }

    for (const filePath of files) {
      try {
        await this.importSingleFile(vault, filePath, sourcePath, destFolder, migration);

        if (migration.progress.filesImported % 10 === 0) {
          this.eventBus.emit("migration:progress", { migration, phase: "importing" });
        }
      } catch (error) {
        console.warn(`[MigrationService] Failed to import ${filePath}:`, error);
      }
    }

    this.eventBus.emit("migration:progress", { migration, phase: "importing" });
  }

  /**
   * Phase 2: Trigger indexing for imported files.
   */
  private async runIndexingPhase(migration: MigrationStatus): Promise<void> {
    migration.status = "indexing";
    this.eventBus.emit("migration:progress", { migration, phase: "indexing" });

    const indexer = this.kernel.getService<{
      syncVault(): Promise<{ added: number; updated: number }>;
    }>("indexer");

    if (!indexer) return;

    try {
      const indexResult = await indexer.syncVault();
      console.log(
        `[MigrationService] Indexed: ${indexResult.added} added, ${indexResult.updated} updated`,
      );
    } catch (error) {
      console.warn("[MigrationService] Indexing failed:", error);
    }
  }

  /**
   * Phase 3: Queue agent workflows for analysis.
   */
  private async runAnalysisPhase(migration: MigrationStatus): Promise<void> {
    const { destFolder } = migration;

    migration.status = "analyzing";
    this.eventBus.emit("migration:progress", { migration, phase: "analyzing" });

    const workflowRunner = this.kernel.getService<{
      startFromCommand(parsed: {
        command: string;
        mode: string;
        scope: string;
        target: string;
      }): Promise<{ success: boolean }>;
    }>("workflowRunner");

    if (!workflowRunner) return;

    try {
      await workflowRunner.startFromCommand({
        command: "connect",
        mode: "bulk",
        scope: "folder",
        target: destFolder,
      });
      console.log(`[MigrationService] Queued /connect for ${destFolder}`);

      await workflowRunner.startFromCommand({
        command: "tasks",
        mode: "bulk",
        scope: "folder",
        target: destFolder,
      });
      console.log(`[MigrationService] Queued /tasks for ${destFolder}`);
    } catch (error) {
      console.warn("[MigrationService] Failed to queue workflows:", error);
    }
  }

  /**
   * Run the migration pipeline
   */
  private async runMigration(migration: MigrationStatus, files: string[]): Promise<void> {
    await this.runImportPhase(migration, files);
    await this.runIndexingPhase(migration);
    await this.runAnalysisPhase(migration);

    migration.status = "complete";
    migration.completedAt = Date.now();
    this.eventBus.emit("migration:completed", { migration });

    console.log(
      `[MigrationService] Migration complete: ${migration.progress.filesImported} files, ${migration.progress.linksConverted} links converted`,
    );
  }

  /**
   * Recursively find all markdown files in a directory
   */
  private findMarkdownFiles(dir: string): string[] {
    const files: string[] = [];

    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        // Skip hidden folders
        if (!entry.startsWith(".")) {
          files.push(...this.findMarkdownFiles(fullPath));
        }
      } else if (stat.isFile() && entry.toLowerCase().endsWith(".md")) {
        files.push(fullPath);
      }
    }

    return files;
  }
}
