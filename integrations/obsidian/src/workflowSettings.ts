import { Setting } from "obsidian";
import type { OperationInput, PipelinePolicy } from "../../../src/api/operations";
import {
  type PolicyField,
  type PolicySection,
  editPolicyField,
  policyFieldText,
  policyFields,
} from "../../../src/api/policyEditor";
import type { OperationResult } from "../../../src/api/results";
import { message } from "./host";
import type NotientPlugin from "./main";

/** Native settings, sharing policy fields and the daemon's durable configuration
 * authority with the terminal. Opening settings never enables background AI. */
export class WorkflowSettings {
  private controller = new AbortController();
  private catalog: OperationResult<"pipelines.list"> | null = null;
  private selected = 0;
  private busy = false;
  private dirty = false;
  private pending: OperationInput<"pipelines.configure"> | null = null;
  private pausePending: OperationInput<"background.pause"> | null = null;
  constructor(
    private readonly el: HTMLElement,
    private readonly plugin: NotientPlugin,
  ) {}
  stop(): void {
    this.controller.abort();
  }
  private get client() {
    if (!this.plugin.client) throw new Error("Connect Notient before changing workflow settings.");
    return this.plugin.client;
  }
  async load(): Promise<void> {
    try {
      this.catalog = await this.client.call("pipelines.list", {}, this.controller.signal);
      if (!this.controller.signal.aborted) {
        this.pending = null;
        this.pausePending = null;
        this.dirty = false;
        this.render();
      }
    } catch (error) {
      if (!this.controller.signal.aborted) {
        this.el.empty();
        this.el.createEl("p", { text: message(error), cls: "notient-error" });
      }
    }
  }
  private render(): void {
    if (!this.catalog) return;
    const catalog = this.catalog;
    this.el.empty();
    this.el.addClass("notient-settings");
    this.el.createEl("h2", { text: "Background intelligence" });
    this.el.createEl("p", {
      text: "Start with the notes and habits that matter to you. AI work stays off until you enable it; structural watching and manual requests remain available.",
      cls: "notient-muted",
    });
    const status = this.el.createEl("p", { cls: "notient-status", attr: { role: "status" } });
    status.setText(
      catalog.paused
        ? "Background work is paused."
        : "Only explicitly enabled workflows may run in the background.",
    );
    new Setting(this.el)
      .setName("All background work")
      .setDesc(
        "Pausing stops active background runs and prevents new ones. Your manually requested work continues.",
      )
      .addButton((button) =>
        button
          .setButtonText(catalog.paused ? "Resume enabled workflows" : "Pause background work")
          .onClick(async () => {
            if (this.busy) return;
            this.busy = true;
            button.setDisabled(true);
            try {
              this.pausePending ??= {
                paused: !catalog.paused,
                revision: catalog.revision,
                idempotencyKey: crypto.randomUUID(),
              };
              const result = await this.client.call(
                "background.pause",
                this.pausePending,
                this.controller.signal,
              );
              const current = await this.client.call("pipelines.list", {}, this.controller.signal);
              if (current.revision !== result.revision)
                throw new Error(
                  "That pause decision was saved, but settings changed again. Refresh current settings before another decision.",
                );
              catalog.paused = result.settings.paused;
              catalog.revision = result.revision;
              this.pausePending = null;
              button.setButtonText(
                catalog.paused ? "Resume enabled workflows" : "Pause background work",
              );
              status.setText(
                catalog.paused
                  ? "Background work is paused. Your unsaved preferences remain here."
                  : "Enabled background workflows may run. Your unsaved preferences remain here.",
              );
            } catch (error) {
              status.setText(
                `${message(error)} Reconnect or refresh to inspect the current state; the same button retries this exact request.`,
              );
            } finally {
              this.busy = false;
              button.setDisabled(false);
            }
          }),
      )
      .addButton((button) =>
        button.setButtonText("Discard edits & refresh").onClick(() => {
          if (!this.busy) void this.load();
        }),
      );
    new Setting(this.el).setName("Workflow").addDropdown((dropdown) => {
      for (const [i, entry] of catalog.pipelines.entries())
        dropdown.addOption(String(i), `${entry.title} · ${entry.policy.enabled ? "on" : "off"}`);
      dropdown.setValue(String(this.selected)).onChange((value) => {
        if (this.busy || this.pending || this.dirty) {
          dropdown.setValue(String(this.selected));
          status.setText("Save your changes or discard and refresh before switching workflows.");
          return;
        }
        this.selected = Number(value);
        this.render();
      });
    });
    const entry = catalog.pipelines[this.selected];
    this.el.createEl("p", { text: entry.description });
    this.el.createEl("p", { text: entry.schedule.reason, cls: "notient-muted" });
    let draft: PipelinePolicy = structuredClone(entry.policy);
    const invalid = new Map<string, string>();
    const form = this.el.createDiv();
    const review = this.el.createDiv({ cls: "notient-settings-review" });
    const sections = new Map<PolicySection, HTMLElement>();
    const fields = policyFields(entry.id);
    for (const field of fields) {
      let group = sections.get(field.section);
      if (!group) {
        const details = form.createEl("details", { cls: "notient-card" });
        details.open = field.section === "Basics";
        details.createEl("summary", { text: field.section });
        group = details.createDiv();
        sections.set(field.section, group);
      }
      const change = (value: string) => {
        if (this.busy || this.pending) return;
        review.empty();
        try {
          draft = editPolicyField(draft, field, value);
          invalid.delete(field.path);
          this.dirty = JSON.stringify(draft) !== JSON.stringify(entry.policy) || invalid.size > 0;
          status.setText("Unsaved settings. Review changes before saving.");
        } catch (error) {
          invalid.set(field.path, `${field.label}: ${message(error)}`);
          this.dirty = true;
          status.setText([...invalid.values()].join("\n"));
        }
      };
      this.field(group, field, policyFieldText(draft, field), change);
    }
    const disableForm = (disabled: boolean) => {
      for (const control of form.querySelectorAll<HTMLInputElement>("input,textarea,select,button"))
        control.disabled = disabled;
    };
    new Setting(this.el)
      .setName("Apply your preferences")
      .setDesc(
        "Saving changes future permissions immediately and stops runs whose own policy changed. Administration must be explicitly granted to this pairing.",
      )
      .addButton((button) =>
        button
          .setButtonText("Review changes")
          .setCta()
          .onClick(async () => {
            if (this.busy) return;
            if (invalid.size) {
              status.setText([...invalid.values()].join("\n"));
              return;
            }
            this.busy = true;
            button.setDisabled(true);
            disableForm(true);
            try {
              const validation = await this.client.call(
                "pipelines.validate",
                { pipeline: entry.id, policy: draft },
                this.controller.signal,
              );
              review.empty();
              review.createEl("h3", { text: "Review settings" });
              for (const field of fields) {
                const before = policyFieldText(entry.policy, field);
                const after = policyFieldText(draft, field);
                if (before === after) continue;
                const item = review.createDiv({ cls: "notient-card" });
                item.createEl("strong", { text: field.label });
                item.createEl("p", { text: `${before || "empty"} → ${after || "empty"}` });
              }
              for (const issue of validation.issues)
                review.createEl("p", {
                  text: issue.message,
                  cls: issue.severity === "error" ? "notient-error" : "notient-warning",
                });
              if (!validation.valid) return;
              const exact = structuredClone(draft);
              const save = review.createEl("button", {
                text: "Save these settings",
                cls: "mod-cta",
              });
              save.addEventListener("click", async () => {
                if (this.busy) return;
                this.busy = true;
                save.disabled = true;
                disableForm(true);
                try {
                  this.pending ??= {
                    pipeline: entry.id,
                    policy: exact,
                    revision: catalog.revision,
                    idempotencyKey: crypto.randomUUID(),
                  };
                  await this.client.call(
                    "pipelines.configure",
                    this.pending,
                    this.controller.signal,
                  );
                  await this.load();
                } catch (error) {
                  status.setText(
                    `${message(error)} Refresh to inspect current settings, or retry this exact save.`,
                  );
                  save.setText("Retry same save");
                } finally {
                  this.busy = false;
                  save.disabled = false;
                  disableForm(this.pending !== null);
                }
              });
              review.scrollIntoView({ block: "nearest" });
            } catch (error) {
              status.setText(message(error));
            } finally {
              this.busy = false;
              button.setDisabled(false);
              disableForm(this.pending !== null);
            }
          }),
      );
  }
  private field(
    el: HTMLElement,
    field: PolicyField,
    value: string,
    changed: (value: string) => void,
  ): void {
    const setting = new Setting(el).setName(field.label).setDesc(field.help);
    if (field.kind === "boolean")
      setting.addToggle((toggle) =>
        toggle.setValue(value === "true").onChange((value) => changed(String(value))),
      );
    else if (field.kind === "choice")
      setting.addDropdown((dropdown) => {
        for (const choice of field.choices ?? [])
          dropdown.addOption(
            choice,
            choice === "propose"
              ? "Review changes"
              : choice === "apply"
                ? "Apply allowed effects"
                : choice,
          );
        dropdown.setValue(value).onChange(changed);
      });
    else if (field.kind === "lines" || field.kind === "windows" || field.path.endsWith(".template"))
      setting.addTextArea((input) => {
        input.setValue(value).onChange(changed);
        input.inputEl.rows = field.path.endsWith(".template") ? 6 : 3;
        input.inputEl.setAttribute("aria-label", field.label);
      });
    else
      setting.addText((input) => {
        input.setValue(value).onChange(changed);
        input.inputEl.setAttribute("aria-label", field.label);
        if (field.kind === "number") input.inputEl.type = "number";
      });
  }
}
