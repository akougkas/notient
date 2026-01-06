/**
 * PARA Detection System
 * 
 * Detects note types based on folder paths following the PARA method.
 */

import type { NotientSettings } from "../../types/settings";
import type { ParaType } from "../../types/search";

/**
 * PARA note type detector
 */
export class ParaDetector {
  private settings: NotientSettings;

  constructor(settings: NotientSettings) {
    this.settings = settings;
  }

  /**
   * Update settings reference
   */
  updateSettings(settings: NotientSettings): void {
    this.settings = settings;
  }

  /**
   * Detect the PARA type of a note by its path
   */
  detectType(path: string): ParaType {
    const normalizedPath = path.toLowerCase();
    
    // Check each PARA type in order of specificity
    if (this.matchesAnyFolder(normalizedPath, this.settings.para.inbox)) {
      return "inbox";
    }
    
    if (this.matchesAnyFolder(normalizedPath, this.settings.para.projects)) {
      return "projects";
    }
    
    if (this.matchesAnyFolder(normalizedPath, this.settings.para.areas)) {
      return "areas";
    }
    
    if (this.matchesAnyFolder(normalizedPath, this.settings.para.resources)) {
      return "resources";
    }
    
    if (this.matchesAnyFolder(normalizedPath, this.settings.para.archive)) {
      return "archive";
    }

    return "unknown";
  }

  /**
   * Check if a path matches any of the specified folders
   */
  private matchesAnyFolder(path: string, folders: string[]): boolean {
    for (const folder of folders) {
      const normalizedFolder = folder.toLowerCase();
      
      // Match if path starts with the folder
      if (path.startsWith(normalizedFolder + "/")) {
        return true;
      }
      
      // Match if path is exactly the folder
      if (path === normalizedFolder) {
        return true;
      }
      
      // Also check for the folder appearing in the path
      if (path.includes("/" + normalizedFolder + "/")) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Get display name for a PARA type
   */
  static getDisplayName(type: ParaType): string {
    switch (type) {
      case "inbox": return "Inbox";
      case "projects": return "Projects";
      case "areas": return "Areas";
      case "resources": return "Resources";
      case "archive": return "Archive";
      default: return "Unknown";
    }
  }

  /**
   * Get icon for a PARA type (using text-based icons)
   */
  static getIcon(type: ParaType): string {
    switch (type) {
      case "inbox": return "📥";
      case "projects": return "🎯";
      case "areas": return "🏠";
      case "resources": return "📚";
      case "archive": return "📦";
      default: return "📄";
    }
  }

  /**
   * Get suggested actions for a PARA type
   */
  static getSuggestedActions(type: ParaType): string[] {
    switch (type) {
      case "inbox":
        return [
          "Classify this note",
          "Add tags",
          "Move to appropriate folder",
        ];
      case "projects":
        return [
          "Link to related resources",
          "Add timeline/deadline",
          "Check for action items",
        ];
      case "areas":
        return [
          "Update regularly",
          "Link to related areas",
          "Review completeness",
        ];
      case "resources":
        return [
          "Add related notes",
          "Improve tags",
          "Add source links",
        ];
      case "archive":
        return [
          "Check for duplicates",
          "Consider merging",
          "Verify archival date",
        ];
      default:
        return [
          "Add to PARA folder",
          "Classify this note",
        ];
    }
  }
}
