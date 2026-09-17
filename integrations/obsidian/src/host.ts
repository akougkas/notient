import { EditorState, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import {
  type App,
  type Editor,
  MarkdownView,
  Notice,
  type Plugin,
  TFile,
  editorInfoField,
} from "obsidian";
import { NotientApiError, type NotientClient } from "../../../src/api/client";
import type { HostCommand, HostReply } from "../../../src/api/host";
import type { SourceReference } from "../../../src/api/schema";
import { isCanonicalOrdinaryNotePath } from "../../../src/core/vault/publicPath";
import { type SelectionGate, gateSelection } from "./selection";

export const normalized = (value: string) => value.replace(/^\ufeff/, "").replaceAll("\r\n", "\n");
/** The saved text exactly as the daemon reads it. `Vault.read` drops a leading
 * BOM, which would shift every source offset and change the revision hash. */
export async function readSaved(app: App, file: TFile): Promise<string> {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await app.vault.readBinary(file));
}
export async function revision(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Obsidian owns editor state, rendering and navigation. No model-supplied code
 * reaches this host. The finite command union is decoded by the shared SDK. */
export class ObsidianHost {
  private sessionId: string | null = null;
  private controller = new AbortController();
  private guards = new Map<string, string[]>();
  private handled = new Map<string, HostReply>();
  private views = new Set<EditorView>();
  private task: Promise<void> | null = null;
  private lastNotice = 0;
  constructor(
    private readonly app: App,
    plugin: Plugin,
    private client: NotientClient,
    private instanceId: string,
    private readonly report: (text: string) => void,
  ) {
    const views = this.views;
    const locked = StateField.define<boolean>({
      create: (state) => {
        const path = state.field(editorInfoField, false)?.file?.path;
        return !!path && this.protects(path);
      },
      update: (_value, transaction) => {
        const path = transaction.startState.field(editorInfoField, false)?.file?.path;
        return !!path && this.protects(path);
      },
    });
    plugin.registerEditorExtension([
      locked,
      EditorState.readOnly.from(locked),
      EditorView.editable.from(locked, (value) => !value),
      ViewPlugin.fromClass(
        class {
          constructor(readonly view: EditorView) {
            views.add(view);
          }
          destroy() {
            views.delete(this.view);
          }
        },
      ),
      EditorState.transactionFilter.of((transaction) => {
        // Host file refreshes remain allowed. Standard editing commands are also
        // disabled by readOnly/editable while this finite guard is held.
        if (
          !transaction.docChanged ||
          !["input", "delete", "undo", "redo"].some((event) => transaction.isUserEvent(event))
        )
          return transaction;
        const path = transaction.startState.field(editorInfoField, false)?.file?.path;
        if (!path || !this.protects(path)) return transaction;
        if (Date.now() - this.lastNotice > 1500) {
          this.lastNotice = Date.now();
          new Notice(
            "Notient is finishing a reviewed change to this note. Wait for it to finish, then retry your edit.",
          );
        }
        return [];
      }),
    ]);
  }
  start(): void {
    if (!this.task) this.task = this.loop();
  }
  stop(): void {
    this.controller.abort();
  }
  get hasPendingWrites(): boolean {
    return this.guards.size > 0;
  }
  async reconnect(client: NotientClient, instanceId: string): Promise<void> {
    this.stop();
    await this.task;
    this.client = client;
    this.instanceId = instanceId;
    this.controller = new AbortController();
    this.sessionId = null;
    this.task = null;
    this.start();
  }
  private protects(path: string): boolean {
    return [...this.guards.values()].some((paths) => paths.includes(path));
  }
  private async loop(): Promise<void> {
    const signal = this.controller.signal;
    while (!signal.aborted) {
      try {
        if (!this.sessionId) {
          const attached = await this.client.call(
            "host.attach",
            { instanceId: this.instanceId, label: `Obsidian · ${this.app.vault.getName()}` },
            AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          );
          this.sessionId = attached.sessionId;
        }
        const page = await this.client.call(
          "host.poll",
          { sessionId: this.sessionId },
          AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        );
        // Only an authenticated current daemon response can release a guard.
        const retained = new Set(page.guards.map((g) => g.id));
        let released = false;
        for (const id of this.guards.keys())
          if (!retained.has(id)) {
            this.guards.delete(id);
            released = true;
          }
        if (released) this.updateLocks();
        for (const id of this.handled.keys())
          if (!page.commands.some((c) => c.id === id) && !retained.has(id)) this.handled.delete(id);
        for (const command of page.commands) {
          signal.throwIfAborted();
          let result = this.handled.get(command.id);
          if (!result) {
            try {
              result = await this.execute(command);
            } catch (error) {
              result = { kind: "error", message: message(error).slice(0, 2000) };
              this.guards.delete(command.id);
              this.updateLocks();
            }
            this.handled.set(command.id, result);
          }
          await this.client.call(
            "host.reply",
            { sessionId: this.sessionId, commandId: command.id, result },
            AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          );
        }
        this.report(
          this.guards.size
            ? "Finishing a reviewed change…"
            : "Connected · editor protection active",
        );
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof NotientApiError && error.code === "CONFLICT") this.sessionId = null;
        this.report(
          `${message(error)}${this.guards.size ? " · Pending editor locks retained until reconnection." : ""}`,
        );
      }
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 500);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
    }
  }
  private async execute(command: HostCommand): Promise<HostReply> {
    if (command.kind === "context") return { kind: "context", context: await this.context() };
    if (command.kind === "open") {
      await this.open(command.source);
      return { kind: "open", opened: true, reason: null };
    }
    this.guards.set(command.id, command.paths);
    this.updateLocks();
    for (const path of command.paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      const editors = [...this.views].filter(
        (v) => v.state.field(editorInfoField, false)?.file?.path === path,
      );
      if (!editors.length) continue;
      if (!(file instanceof TFile))
        throw new Error(
          `Open editor for missing file ${path}; save or close it before changing the vault.`,
        );
      const saved = normalized(await readSaved(this.app, file));
      if (editors.some((v) => v.state.doc.toString() !== saved)) {
        this.guards.delete(command.id);
        this.updateLocks();
        return {
          kind: "guard",
          allowed: false,
          reason: `Unsaved Obsidian edits in ${path}. Save or close that editor, then review the current revision.`,
        };
      }
    }
    return { kind: "guard", allowed: true, reason: null };
  }
  private updateLocks(): void {
    for (const view of this.views) view.dispatch({});
  }
  private contextEditor() {
    const active = this.app.workspace.activeEditor;
    // Obsidian can retain the MarkdownView's editor after switching that view
    // to Reading mode. Its old selection is not active user context anymore.
    if (active?.editor && (!(active instanceof MarkdownView) || active.getMode() === "source"))
      return active;
    // Public Obsidian API specifically preserves main-editor context while a
    // sidebar owns focus. Never choose an arbitrary open Markdown leaf.
    const leaf = this.app.workspace.getMostRecentLeaf();
    return leaf?.view instanceof MarkdownView && leaf.view.getMode() === "source"
      ? leaf.view
      : null;
  }
  private async savedContext() {
    const leaf = this.app.workspace.getMostRecentLeaf();
    const view = leaf?.view;
    if (
      !(view instanceof MarkdownView) ||
      !view.file ||
      !isCanonicalOrdinaryNotePath(view.file.path)
    )
      return null;
    const file = view.file;
    const saved = await readSaved(this.app, file);
    const savedRevision = await revision(saved);
    if (this.app.workspace.getMostRecentLeaf() !== leaf || view.file?.path !== file.path)
      throw new Error("Active note changed; request context again.");
    const dirty = [...this.views].some(
      (editor) =>
        editor.state.field(editorInfoField, false)?.file?.path === file.path &&
        editor.state.doc.toString() !== normalized(saved),
    );
    return { path: file.path, savedRevision, bufferRevision: null, dirty, selection: null };
  }
  async context() {
    const active = this.contextEditor();
    if (!active?.file || !active.editor || !isCanonicalOrdinaryNotePath(active.file.path))
      return this.savedContext();
    const { file, editor } = active;
    const body = editor.getValue();
    const selection = editor.getSelection();
    const start = editor.posToOffset(editor.getCursor("from"));
    const end = editor.posToOffset(editor.getCursor("to"));
    if (selection.length > 16000)
      throw new Error("Selection exceeds 16,000 characters; choose a smaller passage.");
    if (body.slice(start, end) !== selection)
      throw new Error("Editor selection changed; request context again.");
    const saved = await readSaved(this.app, file);
    const [savedRevision, bufferRevision] = await Promise.all([revision(saved), revision(body)]);
    // Do not label a later active note with an earlier editor's result.
    if (
      this.contextEditor()?.editor !== editor ||
      active.file?.path !== file.path ||
      editor.getValue() !== body
    )
      throw new Error("Active note changed; request context again.");
    return {
      path: file.path,
      savedRevision,
      bufferRevision,
      dirty: body !== normalized(saved),
      selection: selection
        ? {
            start,
            end,
            text: selection,
          }
        : null,
    };
  }
  /** Bind the editor's selection to the saved revision, or explain why not. */
  async selection(editor: Editor, file: TFile | null, connected: boolean): Promise<SelectionGate> {
    const buffer = editor.getValue();
    const from = editor.posToOffset(editor.getCursor("from"));
    const to = editor.posToOffset(editor.getCursor("to"));
    const saved = file ? await readSaved(this.app, file) : null;
    const gate = await gateSelection({
      connected,
      path: file?.path ?? null,
      saved,
      buffer,
      from,
      to,
      revision,
    });
    if (gate.ok && editor.getValue() !== buffer)
      return { ok: false, notice: "The note changed while reading the selection. Select again." };
    return gate;
  }
  /** A bound selection is only usable while its note is saved at that revision.
   * A changed or dirty note is a conflict; the selection is never recomputed. */
  async verify(target: { path: string; revision: string }): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(target.path);
    if (!(file instanceof TFile)) throw new Error("The selected note no longer exists.");
    const saved = await readSaved(this.app, file);
    if ((await revision(saved)) !== target.revision)
      throw new Error("The note changed after this passage was selected. Select it again.");
    const dirty = [...this.views].some(
      (view) =>
        view.state.field(editorInfoField, false)?.file?.path === target.path &&
        view.state.doc.toString() !== normalized(saved),
    );
    if (dirty)
      throw new Error("This note has unsaved edits. Save it, then select the passage again.");
  }
  async open(source: SourceReference): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(source.path);
    if (!(file instanceof TFile))
      throw new Error("Source note no longer exists in this Obsidian vault.");
    const body = await readSaved(this.app, file);
    if (
      (await revision(body)) !== source.revision ||
      body.slice(source.range.start, source.range.end) !== source.quote
    )
      throw new Error("Source changed since retrieval. Refresh the result before navigating.");
    const open = this.app.workspace
      .getLeavesOfType("markdown")
      .find((leaf) => leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path);
    if (
      open?.view instanceof MarkdownView &&
      open.view.getMode() === "source" &&
      open.view.editor.getValue() !== normalized(body)
    )
      throw new Error(
        "This note has unsaved edits. Save it before opening a revision-bound source.",
      );
    const leaf = open ?? this.app.workspace.getLeaf("tab");
    await leaf.openFile(file, { active: true, eState: { line: source.range.startLine - 1 } });
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof MarkdownView && leaf.view.getMode() === "source") {
      const editor = leaf.view.editor;
      if (editor.getValue() !== normalized(body))
        throw new Error("Editor changed while navigating; the source selection was not applied.");
      const anchor = normalized(body.slice(0, source.range.start)).length;
      const head = normalized(body.slice(0, source.range.end)).length;
      editor.setSelection(editor.offsetToPos(anchor), editor.offsetToPos(head));
      editor.scrollIntoView({ from: editor.getCursor("from"), to: editor.getCursor("to") }, true);
      if (editor.getSelection() !== normalized(source.quote)) {
        const view = [...this.views].find(
          (view) => view.state.field(editorInfoField, false)?.editor === editor,
        );
        if (!view || view.state.doc.toString() !== normalized(body))
          throw new Error("The source is open, but its exact selection is unavailable.");
        // Obsidian's Properties widget clips selections that include frontmatter.
        // This finite selection-only transaction preserves exact source offsets;
        // it contains no document changes and cannot bypass a mutation guard.
        view.dispatch({ selection: { anchor, head }, filter: false, scrollIntoView: true });
        if (editor.getSelection() !== normalized(source.quote))
          throw new Error(
            "The source is open, but Obsidian could not select the complete passage.",
          );
      }
    }
  }
}
export const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
