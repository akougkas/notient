/**
 * Profile Manager
 *
 * Manages user profile for the identity system.
 * Handles profile CRUD operations and inference from vault embeddings.
 */

import * as fs from "node:fs";
import type { TFolder, Vault } from "obsidian";
import {
  type DomainInferenceResult,
  type ProfileInferenceCallback,
  type ProfileInferenceStatus,
  type ProfileValidationResult,
  type UserProfile,
  createEmptyProfile,
} from "../../types/profile";
import { atomicWriteFile } from "../../utils/atomicWrite";
import type { Kernel } from "../kernel";
import type { LLMProvider } from "../llm/provider";

/** Schema version for profile migrations */
const PROFILE_VERSION = "1.0" as const;

/** Inference timeout in milliseconds */
const INFERENCE_TIMEOUT_MS = 30000;

/** Maximum notes to sample for domain inference */
const MAX_NOTES_FOR_INFERENCE = 50;

/**
 * ProfileManager handles user profile persistence and inference
 */
export class ProfileManager {
  private profile: UserProfile | undefined;
  private loaded = false;

  constructor(
    private vault: Vault,
    private kernel: Kernel,
  ) {}

  /**
   * Get the profile file path from storage paths
   */
  private get profilePath(): string {
    return this.kernel.storagePaths.profile;
  }

  /**
   * Load profile from disk (or return undefined if not exists)
   */
  async load(): Promise<UserProfile | undefined> {
    if (this.loaded && this.profile) {
      return this.profile;
    }

    try {
      const exists = await this.fileExists(this.profilePath);
      if (!exists) {
        this.loaded = true;
        return undefined;
      }

      const content = await fs.promises.readFile(this.profilePath, "utf-8");
      const data = JSON.parse(content) as UserProfile;

      // Validate the loaded profile
      const validation = this.validate(data);
      if (!validation.valid) {
        console.warn("[ProfileManager] Invalid profile, ignoring:", validation.errors);
        this.loaded = true;
        return undefined;
      }

      this.profile = data;
      this.loaded = true;
      console.log("[ProfileManager] Loaded profile:", data.domain?.primary || "(no domain)");
      return this.profile;
    } catch (error) {
      console.error("[ProfileManager] Failed to load profile:", error);
      this.loaded = true;
      return undefined;
    }
  }

  /**
   * Save profile to disk
   */
  async save(profile: UserProfile): Promise<void> {
    // Validate before saving
    const validation = this.validate(profile);
    if (!validation.valid) {
      throw new Error(`Invalid profile: ${validation.errors.join(", ")}`);
    }

    try {
      await atomicWriteFile(this.profilePath, JSON.stringify(profile, null, 2));
      this.profile = profile;
      console.log("[ProfileManager] Saved profile:", profile.domain?.primary || "(no domain)");
    } catch (error) {
      console.error("[ProfileManager] Failed to save profile:", error);
      throw error;
    }
  }

  /**
   * Infer profile from vault embeddings
   * @param onProgress - Optional callback for status updates
   * @returns Inferred UserProfile
   */
  async infer(onProgress?: ProfileInferenceCallback): Promise<UserProfile> {
    const report = (status: ProfileInferenceStatus, message: string) => {
      console.log(`[ProfileManager] Inference: ${status} - ${message}`);
      onProgress?.(status, message);
    };

    report("checking_index", "Checking if vault index exists...");

    // Check if vector index exists
    const indexManager = this.kernel.getService<{
      getIndexedCount(): number;
    }>("indexManager");

    if (!indexManager) {
      throw new Error("Index manager not available");
    }

    const indexedCount = indexManager.getIndexedCount();
    if (indexedCount === 0) {
      throw new Error("Please build the vault index first (Settings > Index > Rebuild)");
    }

    report("clustering", `Analyzing ${indexedCount} indexed notes...`);

    // Get sample notes for inference
    const sampleNotes = await this.getSampleNotesForInference();
    if (sampleNotes.length === 0) {
      throw new Error("No notes available for inference");
    }

    report("analyzing", "Detecting your domain expertise...");

    // Run LLM inference with timeout
    let domainResult: DomainInferenceResult;
    try {
      domainResult = await this.runDomainInference(sampleNotes);
    } catch (error) {
      console.error("[ProfileManager] Domain inference failed:", error);
      // Fallback to manual entry
      report("error", "Domain detection failed. Please enter manually.");
      throw new Error("Domain inference failed. Please configure your profile manually.");
    }

    report("detecting_para", "Detecting PARA folder structure...");

    // Detect PARA folders
    const paraFolders = await this.detectPARAFolders();

    report("complete", "Profile inference complete!");

    // Construct profile
    const profile: UserProfile = {
      version: PROFILE_VERSION,
      domain: domainResult,
      para: paraFolders,
      preferences: {
        citationStyle: "wikilink",
        formality: "formal",
      },
    };

    return profile;
  }

  /**
   * Validate profile structure
   */
  validate(profile: UserProfile): ProfileValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check required fields
    if (!profile.version) {
      errors.push("Missing version field");
    } else if (profile.version !== PROFILE_VERSION) {
      warnings.push(`Profile version ${profile.version} may need migration`);
    }

    if (!profile.domain) {
      errors.push("Missing domain field");
    } else if (!profile.domain.primary && !profile.domain.secondary?.length) {
      warnings.push("Profile has no domain expertise configured");
    }

    if (!profile.para) {
      errors.push("Missing para field");
    }

    // Validate PARA paths exist in vault (warnings only)
    if (profile.para) {
      for (const projectPath of profile.para.projects) {
        if (!this.folderExists(projectPath)) {
          warnings.push(`Project folder not found: ${projectPath}`);
        }
      }
      for (const areaPath of profile.para.areas) {
        if (!this.folderExists(areaPath)) {
          warnings.push(`Area folder not found: ${areaPath}`);
        }
      }
      for (const resourcePath of profile.para.resources) {
        if (!this.folderExists(resourcePath)) {
          warnings.push(`Resource folder not found: ${resourcePath}`);
        }
      }
      for (const archivePath of profile.para.archives) {
        if (!this.folderExists(archivePath)) {
          warnings.push(`Archive folder not found: ${archivePath}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Reset to empty profile
   */
  async reset(): Promise<void> {
    try {
      const exists = await this.fileExists(this.profilePath);
      if (exists) {
        await fs.promises.unlink(this.profilePath);
      }
      this.profile = undefined;
      console.log("[ProfileManager] Profile reset");
    } catch (error) {
      console.error("[ProfileManager] Failed to reset profile:", error);
      throw error;
    }
  }

  /**
   * Check if profile exists
   */
  async exists(): Promise<boolean> {
    return this.fileExists(this.profilePath);
  }

  /**
   * Get current loaded profile (from cache)
   */
  get(): UserProfile | undefined {
    return this.profile;
  }

  // ============ Private Methods ============

  /**
   * Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if folder exists in vault
   */
  private folderExists(folderPath: string): boolean {
    const file = this.vault.getAbstractFileByPath(folderPath);
    return file !== null && "children" in file;
  }

  /**
   * Get sample note titles for domain inference
   * Uses a simple approach: get the most connected/important notes
   */
  private async getSampleNotesForInference(): Promise<string[]> {
    const files = this.vault.getMarkdownFiles();

    // Sort by modification time (most recent first) to get active notes
    const sortedFiles = files
      .slice()
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, MAX_NOTES_FOR_INFERENCE);

    return sortedFiles.map((f) => f.basename);
  }

  /**
   * Run LLM domain inference from note titles
   */
  private async runDomainInference(noteTitles: string[]): Promise<DomainInferenceResult> {
    const llmProvider = this.kernel.getService<LLMProvider>("llmProvider");
    if (!llmProvider) {
      throw new Error("LLM provider not available");
    }

    const inferencePrompt = `Analyze these note titles from a user's Obsidian vault and infer their primary domain of expertise.

NOTE TITLES:
${noteTitles.map((title) => `- ${title}`).join("\n")}

Return ONLY valid JSON with this schema (no markdown code fences):
{
  "primary": "The main field (e.g., 'High-Performance Computing', 'Law', 'Biology', 'Product Management')",
  "secondary": ["Related field 1", "Related field 2"],
  "keywords": ["domain term 1", "domain term 2", "domain term 3"]
}

Be specific. Use professional terminology. Detect the actual domain, not generic categories.
If the notes span multiple unrelated domains, pick the most prominent one as primary.`;

    // Create a timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Inference timeout")), INFERENCE_TIMEOUT_MS);
    });

    // Run inference with timeout
    const inferencePromise = llmProvider.complete([
      {
        role: "system",
        content:
          "You are a domain inference specialist. You detect user expertise from note collections. Output ONLY valid JSON.",
      },
      { role: "user", content: inferencePrompt },
    ]);

    const response = await Promise.race([inferencePromise, timeoutPromise]);

    // Parse JSON response
    try {
      // Clean up response (remove any markdown code fences)
      const cleaned = response.replace(/```json\n?|\n?```/g, "").trim();
      const result = JSON.parse(cleaned) as DomainInferenceResult;

      // Validate result structure
      if (!result.primary || typeof result.primary !== "string") {
        throw new Error("Invalid response: missing primary field");
      }

      return {
        primary: result.primary,
        secondary: Array.isArray(result.secondary) ? result.secondary : [],
        keywords: Array.isArray(result.keywords) ? result.keywords : [],
      };
    } catch (parseError) {
      console.error("[ProfileManager] Failed to parse inference response:", response);
      throw new Error("Failed to parse domain inference response");
    }
  }

  /**
   * Detect PARA folders heuristically from vault structure
   */
  private async detectPARAFolders(): Promise<UserProfile["para"]> {
    const allFolders = this.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => "children" in f)
      .map((f) => f.path);

    const para: UserProfile["para"] = {
      projects: [],
      areas: [],
      resources: [],
      archives: [],
    };

    // Heuristics for PARA detection
    const patterns = {
      projects: /^(1[0-9]?[ _-]?|project)/i,
      areas: /^(2[0-9]?[ _-]?|area)/i,
      resources: /^(3[0-9]?[ _-]?|resource)/i,
      archives: /^(4[0-9]?[ _-]?|archive)/i,
    };

    for (const folder of allFolders) {
      const folderName = folder.split("/").pop() || folder;

      if (patterns.projects.test(folderName)) {
        para.projects.push(folder);
      } else if (patterns.areas.test(folderName)) {
        para.areas.push(folder);
      } else if (patterns.resources.test(folderName)) {
        para.resources.push(folder);
      } else if (patterns.archives.test(folderName)) {
        para.archives.push(folder);
      }
    }

    return para;
  }
}
