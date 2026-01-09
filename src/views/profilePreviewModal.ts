/**
 * Profile Preview Modal
 *
 * Displays inferred profile for user review and editing before saving.
 */

import { type App, Modal, Setting } from "obsidian";
import { type UserProfile, createEmptyProfile } from "../types/profile";

/**
 * Modal for previewing and editing inferred profile
 */
export class ProfilePreviewModal extends Modal {
  private editedProfile: UserProfile;
  private resolved = false;
  private resolvePromise: ((profile: UserProfile | null) => void) | null = null;

  constructor(
    app: App,
    private initialProfile: UserProfile,
  ) {
    super(app);
    // Clone the profile for editing
    this.editedProfile = JSON.parse(JSON.stringify(initialProfile));
  }

  /**
   * Run the modal and return the edited profile (or null if cancelled)
   */
  async run(): Promise<UserProfile | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("notient-profile-preview-modal");

    // Title
    contentEl.createEl("h2", { text: "Review Inferred Profile" });

    // Description
    contentEl.createEl("p", {
      text: "Notient analyzed your vault and detected the following. Edit if needed, then click Save.",
      cls: "setting-item-description",
    });

    // Domain section
    this.renderDomainSection(contentEl);

    // PARA section
    this.renderParaSection(contentEl);

    // Preferences section
    this.renderPreferencesSection(contentEl);

    // Buttons
    this.renderButtons(contentEl);
  }

  private renderDomainSection(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: "notient-profile-section" });
    section.createEl("h3", { text: "Domain Expertise" });

    // Primary domain
    new Setting(section)
      .setName("Primary Domain")
      .setDesc("Your main field of expertise")
      .addText((text) =>
        text
          .setPlaceholder("e.g., High-Performance Computing")
          .setValue(this.editedProfile.domain.primary || "")
          .onChange((value) => {
            this.editedProfile.domain.primary = value;
          }),
      );

    // Secondary domains
    new Setting(section)
      .setName("Secondary Domains")
      .setDesc("Related fields (comma-separated)")
      .addText((text) =>
        text
          .setPlaceholder("e.g., AI/ML, Distributed Systems")
          .setValue(this.editedProfile.domain.secondary?.join(", ") || "")
          .onChange((value) => {
            this.editedProfile.domain.secondary = value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
          }),
      );

    // Keywords
    new Setting(section)
      .setName("Domain Keywords")
      .setDesc("Key concepts in your field (comma-separated)")
      .addText((text) =>
        text
          .setPlaceholder("e.g., NSF grants, supercomputing, MPI")
          .setValue(this.editedProfile.domain.keywords?.join(", ") || "")
          .onChange((value) => {
            this.editedProfile.domain.keywords = value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
          }),
      );
  }

  private renderParaSection(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: "notient-profile-section" });
    section.createEl("h3", { text: "PARA Folders (Detected)" });

    const paraTypes: Array<{ key: keyof UserProfile["para"]; label: string }> = [
      { key: "projects", label: "Projects" },
      { key: "areas", label: "Areas" },
      { key: "resources", label: "Resources" },
      { key: "archives", label: "Archives" },
    ];

    for (const { key, label } of paraTypes) {
      new Setting(section)
        .setName(label)
        .setDesc(`Detected ${label.toLowerCase()} folders`)
        .addText((text) =>
          text
            .setPlaceholder("Folder paths (comma-separated)")
            .setValue(this.editedProfile.para[key].join(", "))
            .onChange((value) => {
              this.editedProfile.para[key] = value
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
            }),
        );
    }
  }

  private renderPreferencesSection(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: "notient-profile-section" });
    section.createEl("h3", { text: "Preferences" });

    // Citation style
    new Setting(section)
      .setName("Citation Style")
      .setDesc("How Notient formats note references")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("wikilink", "Wiki-links [[Note]]")
          .addOption("markdown", "Markdown [Note](path)")
          .setValue(this.editedProfile.preferences?.citationStyle || "wikilink")
          .onChange((value) => {
            if (!this.editedProfile.preferences) {
              this.editedProfile.preferences = {};
            }
            this.editedProfile.preferences.citationStyle = value as "wikilink" | "markdown";
          });
      });

    // Formality
    new Setting(section)
      .setName("Response Formality")
      .setDesc("How formal Notient's responses should be")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("formal", "Formal (professional, detailed)")
          .addOption("balanced", "Balanced (clear, direct)")
          .addOption("casual", "Casual (concise, straightforward)")
          .setValue(this.editedProfile.preferences?.formality || "formal")
          .onChange((value) => {
            if (!this.editedProfile.preferences) {
              this.editedProfile.preferences = {};
            }
            this.editedProfile.preferences.formality = value as "formal" | "balanced" | "casual";
          });
      });
  }

  private renderButtons(containerEl: HTMLElement): void {
    const buttonContainer = containerEl.createDiv({ cls: "modal-button-container" });

    // Save button
    const saveBtn = buttonContainer.createEl("button", {
      text: "Save Profile",
      cls: "mod-cta",
    });
    saveBtn.addEventListener("click", () => {
      this.resolved = true;
      this.resolvePromise?.(this.editedProfile);
      this.close();
    });

    // Cancel button
    const cancelBtn = buttonContainer.createEl("button", {
      text: "Cancel",
    });
    cancelBtn.addEventListener("click", () => {
      this.resolved = true;
      this.resolvePromise?.(null);
      this.close();
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();

    // If closed without explicit action, treat as cancel
    if (!this.resolved) {
      this.resolvePromise?.(null);
    }
  }
}

/**
 * Simple modal for entering profile manually
 */
export class ProfileEditModal extends Modal {
  private editedProfile: UserProfile;
  private resolved = false;
  private resolvePromise: ((profile: UserProfile | null) => void) | null = null;

  constructor(
    app: App,
    private existingProfile?: UserProfile,
  ) {
    super(app);
    this.editedProfile = existingProfile
      ? JSON.parse(JSON.stringify(existingProfile))
      : createEmptyProfile();
  }

  /**
   * Run the modal and return the edited profile (or null if cancelled)
   */
  async run(): Promise<UserProfile | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("notient-profile-edit-modal");

    // Title
    contentEl.createEl("h2", {
      text: this.existingProfile ? "Edit Profile" : "Create Profile",
    });

    // Description
    contentEl.createEl("p", {
      text: "Configure your domain expertise to help Notient give better suggestions.",
      cls: "setting-item-description",
    });

    // Domain section (simplified)
    const section = contentEl.createDiv({ cls: "notient-profile-section" });

    new Setting(section)
      .setName("Primary Domain")
      .setDesc("Your main field of expertise")
      .addText((text) =>
        text
          .setPlaceholder("e.g., High-Performance Computing")
          .setValue(this.editedProfile.domain.primary || "")
          .onChange((value) => {
            this.editedProfile.domain.primary = value;
          }),
      );

    new Setting(section)
      .setName("Secondary Domains")
      .setDesc("Related fields (comma-separated)")
      .addText((text) =>
        text
          .setPlaceholder("e.g., AI/ML, Distributed Systems")
          .setValue(this.editedProfile.domain.secondary?.join(", ") || "")
          .onChange((value) => {
            this.editedProfile.domain.secondary = value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
          }),
      );

    // Buttons
    const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });

    const saveBtn = buttonContainer.createEl("button", {
      text: "Save",
      cls: "mod-cta",
    });
    saveBtn.addEventListener("click", () => {
      this.resolved = true;
      this.resolvePromise?.(this.editedProfile);
      this.close();
    });

    const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => {
      this.resolved = true;
      this.resolvePromise?.(null);
      this.close();
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();

    if (!this.resolved) {
      this.resolvePromise?.(null);
    }
  }
}
