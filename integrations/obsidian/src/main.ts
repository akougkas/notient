import {
  type Editor,
  FileSystemAdapter,
  type MarkdownFileInfo,
  type MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { NotientClient } from "../../../src/api/client";
import { isCanonicalOrdinaryNotePath } from "../../../src/core/vault/publicPath";
import { CaptureDraft } from "./captureDraft";
import { ObsidianHost, message, readSaved, revision } from "./host";
import type { SelectionTarget } from "./selection";
import { NotientView, VIEW_TYPE } from "./view";
import { WorkflowSettings } from "./workflowSettings";

interface LocalConnection {
  endpoint: string;
  vaultId: string;
  secretId: string;
  localPath: string;
  instanceId: string;
}
const STORAGE = "notient-desktop-connection";
export default class NotientPlugin extends Plugin {
  client: NotientClient | null = null;
  host: ObsidianHost | null = null;
  status = "Pair this vault with its local Notient daemon";
  private listeners = new Set<() => void>();
  private disposed = false;
  private connecting = false;
  private captureDraft: CaptureDraft | null = null;
  capture(): CaptureDraft {
    this.captureDraft ??= new CaptureDraft(
      {
        read: () => this.app.loadLocalStorage("notient-capture-draft"),
        write: (record) => this.app.saveLocalStorage("notient-capture-draft", record),
      },
      () => {
        const local = this.local();
        return this.client && local ? { client: this.client, vaultId: local.vaultId } : null;
      },
    );
    return this.captureDraft;
  }
  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE, (leaf) => new NotientView(leaf, this));
    this.addSettingTab(new ConnectionSettings(this));
    this.addRibbonIcon("sprout", "Open Notient", () => {
      void this.open();
    });
    for (const [id, name, destination] of [
      ["open", "Open knowledge workspace", "note"],
      ["search", "Search your notes", "search"],
      ["ask", "Ask your notes", "ask"],
      ["capture", "Capture a thought", "capture"],
      ["review", "Review suggested changes", "review"],
      ["activity", "Show activity and job controls", "activity"],
    ] as const) {
      this.addCommand({
        id,
        name,
        callback: () => {
          void this.open(destination);
        },
      });
    }
    this.addCommand({
      id: "capture-selection",
      name: "Capture the selected text",
      editorCheckCallback: (checking, editor) => {
        const text = editor.getSelection();
        if (!text.trim() || text.length > 48000) return false;
        if (!checking) {
          try {
            if (!this.capture().seed(text))
              new Notice(
                "Your unfinished capture is kept. Save or discard it before starting another.",
              );
            void this.open("capture");
          } catch (error) {
            new Notice(message(error));
          }
        }
        return true;
      },
    });
    this.addCommand({
      id: "understand-note",
      name: "Understand the active note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.client || !isCanonicalOrdinaryNotePath(file.path)) return false;
        if (!checking)
          void this.open("note")
            .then((view) => view?.runPipeline("index-extract"))
            .catch((error) => new Notice(message(error)));
        return true;
      },
    });
    // Selection commands stay listed and explain themselves when they cannot run:
    // whether the note is saved is only known after reading the file.
    const selectionCommands = [
      ["ask-selection", "Ask about selection", "message-circle-question"],
      ["brief-selection", "Brief from selection", "scroll-text"],
      ["connect-selection", "Find connections for selection", "waypoints"],
      ["edit-selection", "Propose an edit to the selection", "pencil-line"],
    ] as const;
    for (const [id, name, icon] of selectionCommands) {
      this.addCommand({
        id,
        name,
        icon,
        editorCallback: (editor, context) => void this.withSelection(id, editor, context),
      });
    }
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, context) => {
        for (const [id, name, icon] of selectionCommands)
          menu.addItem((item) =>
            item
              .setSection("notient")
              .setTitle(`Notient: ${name}`)
              .setIcon(icon)
              .onClick(() => void this.withSelection(id, editor, context)),
          );
      }),
    );
    this.registerEvent(this.app.workspace.on("file-open", () => this.changed()));
    this.registerEvent(this.app.workspace.on("editor-change", () => this.changed()));
    this.registerEvent(this.app.vault.on("modify", () => this.changed()));
    this.app.workspace.onLayoutReady(() => {
      if (!this.disposed) void this.connect();
    });
  }
  onunload(): void {
    this.disposed = true;
    this.host?.stop();
    this.captureDraft?.close();
    this.listeners.clear();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  report(value: string): void {
    if (this.status !== value) {
      this.status = value;
      this.changed();
    }
  }
  local(): LocalConnection | null {
    const raw: unknown = this.app.loadLocalStorage(STORAGE);
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Partial<LocalConnection>;
    return [value.endpoint, value.vaultId, value.secretId, value.localPath, value.instanceId].every(
      (v) => typeof v === "string",
    )
      ? (value as LocalConnection)
      : null;
  }
  private path(): string {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter))
      throw new Error("Notient requires an Obsidian desktop filesystem vault.");
    return this.app.vault.adapter.getBasePath();
  }
  async pair(endpoint: string, vaultId: string, code: string): Promise<void> {
    if (this.host?.hasPendingWrites)
      throw new Error("Reconnect and finish the pending editor write before changing pairing.");
    const localPath = this.path();
    const result = await NotientClient.pair(
      endpoint.trim(),
      code.trim(),
      vaultId.trim(),
      AbortSignal.timeout(10000),
    );
    if (
      result.principal.kind !== "human" ||
      !["read", "host"].every((scope) => result.principal.scopes.includes(scope))
    )
      throw new Error(
        "Pair the official plugin as a human client with read and host scopes. Add write for reviewed changes and jobs.",
      );
    const client = new NotientClient({ endpoint, vaultId, token: result.token });
    await client.connect(AbortSignal.timeout(10000));
    // A Windows path is never sent as a Linux vault path. Validate an existing
    // local note against the paired daemon before saving this local mapping.
    const sample = this.app.vault
      .getMarkdownFiles()
      .find((file) => isCanonicalOrdinaryNotePath(file.path));
    if (sample) {
      const note = await client.call(
        "notes.read",
        { path: sample.path },
        AbortSignal.timeout(10000),
      );
      if (note.note.revision !== (await revision(await readSaved(this.app, sample))))
        throw new Error(
          "The paired daemon's note differs from this local vault. Check the vault mapping before pairing again.",
        );
    }
    const secretId = `notient-${result.credentialId}`;
    this.app.secretStorage.setSecret(secretId, result.token);
    this.app.saveLocalStorage(STORAGE, {
      endpoint: client.endpoint,
      vaultId: result.vaultId,
      secretId,
      localPath,
      instanceId: crypto.randomUUID(),
    } satisfies LocalConnection);
    await this.connect();
  }
  async connect(): Promise<void> {
    if (this.disposed || this.connecting) return;
    this.connecting = true;
    try {
      const local = this.local();
      if (!local) {
        this.report("Pair this vault with its local Notient daemon");
        return;
      }
      if (local.localPath !== this.path())
        throw new Error(
          "The local vault path changed. Pair this vault again to confirm its mapping.",
        );
      const token = this.app.secretStorage.getSecret(local.secretId);
      if (!token)
        throw new Error("Pairing credential is missing from Obsidian Secret Storage. Pair again.");
      const client = new NotientClient({ endpoint: local.endpoint, vaultId: local.vaultId, token });
      await client.connect(AbortSignal.timeout(10000));
      if (this.disposed) return;
      this.client = client;
      if (this.host) await this.host.reconnect(client, local.instanceId);
      else {
        this.host = new ObsidianHost(this.app, this, client, local.instanceId, (text) =>
          this.report(text),
        );
        this.host.start();
      }
      this.report("Connected · attaching editor protection…");
    } catch (error) {
      this.report(message(error));
    } finally {
      this.connecting = false;
    }
  }
  private async withSelection(
    command: "ask-selection" | "brief-selection" | "connect-selection" | "edit-selection",
    editor: Editor,
    context: MarkdownView | MarkdownFileInfo,
  ): Promise<void> {
    try {
      if (!this.host || !this.client) {
        new Notice("Reconnect Notient before working with a selection.");
        return;
      }
      const gate = await this.host.selection(editor, context.file, true);
      if (!gate.ok) {
        new Notice(gate.notice, 8000);
        return;
      }
      const target: SelectionTarget = gate.target;
      const view = await this.open(command === "ask-selection" ? "ask" : "note");
      if (!view) throw new Error("The Notient workspace could not be opened.");
      if (command === "ask-selection") view.askSelection(target);
      else if (command === "brief-selection") await view.openAnalysis("brief", target.path, target);
      else if (command === "connect-selection")
        await view.openAnalysis("correlate", target.path, target);
      else await view.proposeEdit(target);
    } catch (error) {
      new Notice(message(error), 10000);
    }
  }
  async open(destination: NotientView["destination"] = "note"): Promise<NotientView | null> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof NotientView) {
      leaf.view.select(destination);
      return leaf.view;
    }
    return null;
  }
}

class ConnectionSettings extends PluginSettingTab {
  private workflows: WorkflowSettings | null = null;
  hide(): void {
    this.workflows?.stop();
    this.workflows = null;
  }
  constructor(private readonly plugin: NotientPlugin) {
    super(plugin.app, plugin);
  }
  display(): void {
    this.workflows?.stop();
    const { containerEl: root } = this;
    root.empty();
    root.createEl("h2", { text: "Notient preferences" });
    const connection = root.createEl("details", { cls: "notient-card" });
    connection.open = !this.plugin.client;
    connection.createEl("summary", {
      text: this.plugin.client ? "Connection · this vault is paired" : "Connect your vault",
    });
    const el = connection.createDiv();
    el.createEl("h2", { text: "Your vault, your Notient" });
    el.createEl("p", {
      text: "Pair with the daemon for this vault. Windows Obsidian can use localhost to reach a WSL daemon. Credentials stay in Obsidian Secret Storage; the local vault mapping stays on this device.",
    });
    const local = this.plugin.local();
    let endpoint = local?.endpoint ?? "http://127.0.0.1:";
    let vaultId = local?.vaultId ?? "";
    let code = "";
    new Setting(el)
      .setName("Daemon endpoint")
      .setDesc("Use the endpoint printed by notient pair create.")
      .addText((input) =>
        input
          .setValue(endpoint)
          .setPlaceholder("http://127.0.0.1:45861")
          .onChange((v) => {
            endpoint = v;
          }),
      );
    new Setting(el).setName("Vault identity").addText((input) =>
      input.setValue(vaultId).onChange((v) => {
        vaultId = v;
      }),
    );
    new Setting(el)
      .setName("Single-use pairing code")
      .setDesc(
        "Create a human pairing with read, write and host scopes. Administration is optional and must be explicitly granted.",
      )
      .addText((input) => {
        input.inputEl.type = "password";
        input.onChange((v) => {
          code = v;
        });
      });
    new Setting(el)
      .setName("Connect this vault")
      .addButton((button) =>
        button
          .setButtonText("Pair")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.plugin.pair(endpoint, vaultId, code);
              new Notice("Notient paired with this vault.");
              this.display();
            } catch (error) {
              new Notice(message(error), 10000);
            } finally {
              button.setDisabled(false);
            }
          }),
      )
      .addButton((button) =>
        button.setButtonText("Reconnect").onClick(() => this.plugin.connect()),
      );
    el.createEl("p", { text: this.plugin.status, cls: "notient-muted" });
    el.createEl("p", {
      text: "While this host is attached, a disconnected editor blocks Notient file writes until reconnection. To deliberately stop this protection, revoke the plugin's pairing with notient pair revoke. Disabling the plugin does not silently release pending writes.",
    });
    if (this.plugin.client) {
      this.workflows = new WorkflowSettings(root.createDiv(), this.plugin);
      void this.workflows.load();
    }
  }
}
