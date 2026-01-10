/**
 * Profile Edit Modal
 *
 * Simple modal for manually creating or editing a user profile.
 */

import { type App, Modal, Setting } from "obsidian";
import { type UserProfile, createEmptyProfile } from "../../types/profile";

/**
 * Modal for manually entering/editing profile
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

    // Domain section
    this.renderDomainSection(contentEl);

    // Buttons
    this.renderButtons(contentEl);
  }

  private renderDomainSection(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: "notient-profile-section" });

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
  }

  private renderButtons(containerEl: HTMLElement): void {
    const buttonContainer = containerEl.createDiv({ cls: "modal-button-container" });

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
