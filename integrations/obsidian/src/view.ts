import { Component, ItemView, MarkdownRenderer, Notice, type WorkspaceLeaf } from "obsidian";
import type { ChangePreview } from "../../../src/api/changes";
import { NotientApiError, type NotientClient } from "../../../src/api/client";
import type { PipelineId } from "../../../src/api/operations";
import { type ReviewProposal, reviewTitle } from "../../../src/api/proposals";
import type { SourceReference } from "../../../src/api/schema";
import { isCanonicalOrdinaryNotePath } from "../../../src/core/vault/publicPath";
import { chooseAnalysisNote, renderAnalysisPanel } from "./analysis";
import { type AskState, renderAskPanel } from "./ask";
import { renderBriefPanel } from "./brief";
import { renderCapturePanel } from "./capture";
import { renderConnections } from "./connections";
import { renderHistory } from "./history";
import { message, readSaved } from "./host";
import type NotientPlugin from "./main";
import { type SelectionTarget, editChangeSet, replacementFor } from "./selection";

export const VIEW_TYPE = "notient-workspace";
const titles: Record<PipelineId, string> = {
  "index-extract": "Understand this note",
  enrich: "Suggest refinements",
  relate: "Find connections",
  contradictions: "Check competing claims",
  synthesize: "Draft a synthesis",
  inbox: "Organize this note",
  archive: "Review for archive",
};
export class NotientView extends ItemView {
  destination: "note" | "ask" | "capture" | "search" | "review" | "activity" = "note";
  private content!: HTMLElement;
  private status!: HTMLElement;
  private tabs!: HTMLElement;
  private controller = new AbortController();
  private renderId = 0;
  private markdown = new Component();
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private query = "";
  private reviewHistory = false;
  private analysisActive = false;
  private renderedClient: NotientClient | null = null;
  private askState: AskState = {
    question: "",
    scope: "vault",
    result: null,
    answeredQuestion: "",
    answeredScope: "",
    focus: null,
  };
  constructor(
    leaf: WorkspaceLeaf,
    readonly plugin: NotientPlugin,
  ) {
    super(leaf);
  }
  private get client() {
    if (!this.plugin.client) throw new Error("Reconnect Notient before continuing.");
    return this.plugin.client;
  }
  private get host() {
    if (!this.plugin.host)
      throw new Error("The native editor connection is unavailable. Reconnect Notient.");
    return this.plugin.host;
  }
  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Notient";
  }
  getIcon(): string {
    return "sprout";
  }
  async onOpen(): Promise<void> {
    this.containerEl.children[1].empty();
    const root = this.containerEl.children[1] as HTMLElement;
    root.addClass("notient-workspace");
    const header = root.createDiv({ cls: "notient-header" });
    header.createEl("h2", { text: "notient" });
    header.createEl("span", { text: "Grow what you know", cls: "notient-muted" });
    this.status = root.createDiv({ cls: "notient-status", attr: { role: "status" } });
    this.tabs = root.createDiv({
      cls: "notient-tabs",
      attr: { role: "tablist", "aria-label": "Knowledge workspace" },
    });
    this.content = root.createDiv({ cls: "notient-content" });
    this.register(
      this.plugin.subscribe(() => {
        this.status.setText(this.plugin.status);
        if (this.plugin.client !== this.renderedClient) {
          void this.render();
          return;
        }
        if (this.destination !== "note" || this.analysisActive) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          if (this.destination === "note") void this.render();
        }, 350);
      }),
    );
    this.addChild(this.markdown);
    this.select(this.destination);
  }
  async onClose(): Promise<void> {
    this.controller.abort();
    if (this.debounce) clearTimeout(this.debounce);
  }
  select(destination: NotientView["destination"]): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = null;
    }
    this.destination = destination;
    if (!this.tabs) return;
    this.tabs.empty();
    for (const [id, title] of [
      ["note", "Note"],
      ["ask", "Ask"],
      ["capture", "Write"],
      ["search", "Search"],
      ["review", "Review"],
      ["activity", "Activity"],
    ] as const) {
      const button = this.tabs.createEl("button", {
        text: title,
        attr: { role: "tab", "aria-selected": String(id === destination) },
      });
      button.toggleClass("is-active", id === destination);
      button.addEventListener("click", () => this.select(id));
    }
    void this.render();
  }
  private async render(): Promise<void> {
    this.analysisActive = false;
    const id = ++this.renderId;
    this.controller.abort();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.removeChild(this.markdown);
    this.markdown = new Component();
    this.addChild(this.markdown);
    this.content.empty();
    this.status.setText(this.plugin.status);
    this.renderedClient = this.plugin.client;
    if (!this.plugin.client && this.destination !== "capture") {
      this.content.createEl("h3", { text: "Your knowledge stays here" });
      this.content.createEl("p", {
        text: "Connect the Notient daemon for this vault in Settings → Notient. Your notes remain editable while it is offline.",
      });
      this.button(this.content, "Reconnect", () => this.plugin.connect().then(() => this.render()));
      return;
    }
    const loading = this.content.createEl("p", { text: "Loading…", cls: "notient-muted" });
    try {
      if (this.destination === "note") await this.renderNote(signal);
      else if (this.destination === "capture")
        renderCapturePanel({
          parent: this.content,
          session: this.plugin.capture(),
          signal,
          markdown: (parent, body, path) => this.renderMarkdown(parent, body, path),
          open: async (path) => {
            const file = this.app.vault.getFileByPath(path);
            if (!file)
              throw new Error(
                "The saved note has not appeared in Obsidian yet. Wait a moment, then open it again.",
              );
            await this.app.workspace.getLeaf(false).openFile(file);
          },
        });
      else if (this.destination === "search") this.renderSearch();
      else if (this.destination === "ask")
        renderAskPanel({
          parent: this.content,
          state: this.askState,
          client: this.client,
          signal,
          active: async () => {
            const context = await this.host.context();
            if (!context) throw new Error("No active native editor is available.");
            return { path: context.path, dirty: context.dirty };
          },
          verify: (target) => this.host.verify(target),
          markdown: (parent, text, path) => this.renderMarkdown(parent, text, path),
          source: (parent, evidence) => this.source(parent, evidence),
        });
      else if (this.destination === "review") {
        const actions = this.content.createDiv({ cls: "notient-actions" });
        for (const [history, label] of [
          [false, "Suggestions"],
          [true, "Change history"],
        ] as const) {
          const button = this.button(actions, label, async () => {
            this.reviewHistory = history;
            await this.render();
          });
          button.setAttribute("aria-pressed", String(history === this.reviewHistory));
          button.toggleClass("mod-cta", history === this.reviewHistory);
        }
        if (this.reviewHistory)
          renderHistory({
            parent: this.content,
            client: this.client,
            signal,
            markdown: (parent, body, path) => this.renderMarkdown(parent, body, path),
          });
        else await this.renderReviews(signal);
      } else await this.renderJobs(signal);
    } catch (error) {
      if (id === this.renderId && !signal.aborted)
        this.content.createEl("p", {
          text: message(error),
          cls: "notient-error",
          attr: { role: "alert" },
        });
    } finally {
      loading.remove();
    }
  }
  private async renderNote(signal: AbortSignal): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || !isCanonicalOrdinaryNotePath(file.path)) {
      this.content.createEl("p", {
        text: "Open a Markdown note to explore its structure and possible next steps.",
      });
      return;
    }
    const note = await this.client.call("notes.read", { path: file.path }, signal);
    signal.throwIfAborted();
    if (this.app.workspace.getActiveFile()?.path !== note.note.path) return;
    this.content.createEl("h3", { text: file.basename });
    this.content.createEl("p", { text: note.note.path, cls: "notient-path" });
    const context = await this.plugin.host?.context();
    signal.throwIfAborted();
    if (context?.dirty)
      this.content.createEl("p", {
        text: "You have unsaved edits. The information below describes the saved note; save before running a workflow.",
        cls: "notient-warning",
      });
    this.content.createEl("p", {
      text: `Index ${note.freshness.state} · ${note.structure.tasks.filter((t) => !t.checked).length} open tasks`,
      cls: "notient-muted",
    });
    const actions = this.content.createDiv({ cls: "notient-actions" });
    const choose = actions.createEl("select", { attr: { "aria-label": "Note workflow" } });
    for (const [value, text] of Object.entries(titles)) choose.createEl("option", { value, text });
    this.button(actions, "Preview", () => this.runPipeline(choose.value as PipelineId), true);
    this.content.createEl("p", {
      text: "Preview uses your configured model and budgets. It does not apply changes to authored notes.",
      cls: "notient-muted",
    });
    const properties = Object.entries(note.structure.frontmatter.properties ?? {});
    if (properties.length) {
      this.content.createEl("h4", { text: "Properties" });
      const list = this.content.createEl("dl", { cls: "notient-properties" });
      for (const [key, value] of properties) {
        list.createEl("dt", { text: key });
        list.createEl("dd", {
          text:
            typeof value === "string"
              ? value
              : Array.isArray(value)
                ? value.join(", ")
                : JSON.stringify(value),
        });
      }
    }
    this.content.createEl("h4", { text: "On this note" });
    for (const heading of note.structure.headings) {
      const button = this.button(this.content, heading.text, async () => {
        const read = await this.client.call("notes.read", {
          ...note.note,
          selector: { kind: "heading", text: heading.text, occurrence: heading.occurrence },
        });
        if (read.selected) await this.plugin.host?.open(read.selected);
      });
      button.addClass("notient-outline");
      button.style.paddingInlineStart = `${Math.min(3, heading.level - 1) * 12 + 8}px`;
    }
    for (const block of note.structure.blocks)
      this.button(this.content, `^${block.id}`, () =>
        this.host.open({
          ...note.note,
          range: block.range,
          quote: note.body.slice(block.range.start, block.range.end),
        }),
      ).addClass("notient-outline");
    if (!note.structure.headings.length && !note.structure.blocks.length)
      this.content.createEl("p", {
        text: "No headings or explicit blocks yet.",
        cls: "notient-muted",
      });
    const analysis = this.content.createDiv({ cls: "notient-actions" });
    this.button(analysis, "Brief me", () => this.openAnalysis("brief", note.note.path));
    this.button(analysis, "Compare with…", () => this.openAnalysis("compare", note.note.path));
    this.button(analysis, "Explore connections", () =>
      this.openAnalysis("correlate", note.note.path),
    );
    await renderConnections({
      parent: this.content,
      path: note.note.path,
      client: this.client,
      signal,
      refresh: () => this.render(),
      markdown: (parent, body, path) => this.renderMarkdown(parent, body, path),
      source: (parent, source) => this.source(parent, source),
      open: async (path) => {
        const target = this.app.vault.getFileByPath(path);
        if (!target)
          throw new Error(
            "This note is not available in the local Obsidian vault. Refresh after synchronization.",
          );
        await this.app.workspace.getLeaf(false).openFile(target);
      },
    });
  }
  async runPipeline(pipeline: PipelineId): Promise<void> {
    const client = this.plugin.client;
    const file = this.app.workspace.getActiveFile();
    if (!client || !file || !isCanonicalOrdinaryNotePath(file.path))
      throw new Error("Open an ordinary Markdown note first.");
    const note = await client.call("notes.read", { path: file.path }, AbortSignal.timeout(10000));
    const context = await this.plugin.host?.context();
    if (this.app.workspace.getActiveFile()?.path !== note.note.path)
      throw new Error("Active note changed; choose the workflow again.");
    if (context?.dirty && context.path === note.note.path)
      throw new Error("Save the current note before previewing a workflow.");
    const key = "notient-pending-workflow";
    if (this.app.loadLocalStorage(key))
      throw new Error(
        "A previous workflow submission has an unknown outcome. Open Activity and check that submission before starting another.",
      );
    const input = {
      pipeline,
      sources: [note.note],
      preview: true,
      idempotencyKey: crypto.randomUUID(),
    };
    this.app.saveLocalStorage(key, input);
    try {
      const { job } = await client.call("pipelines.run", input, AbortSignal.timeout(15000));
      this.app.saveLocalStorage(key, null);
      this.select("activity");
      new Notice(`${titles[pipeline]} · ${job.state}`);
    } catch (error) {
      if (!(error instanceof NotientApiError && error.outcomeMayBeUnknown))
        this.app.saveLocalStorage(key, null);
      throw error;
    }
  }
  private renderSearch(): void {
    const form = this.content.createEl("form", { cls: "notient-search" });
    const input = form.createEl("input", {
      type: "search",
      value: this.query,
      placeholder: "Find a thought, phrase or question…",
      attr: { "aria-label": "Search vault" },
    });
    form.createEl("button", { text: "Search", type: "submit", cls: "mod-cta" });
    const result = this.content.createDiv();
    let request = 0;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.query = input.value.trim();
      if (!this.query) return;
      const current = ++request;
      result.empty();
      result.createEl("p", { text: "Finding saved evidence…" });
      const signal = this.controller.signal;
      void this.plugin
        .client!.call(
          "search.run",
          { query: this.query, mode: "lexical", limit: 12, scope: {} },
          signal,
        )
        .then(async (data) => {
          if (signal.aborted || current !== request) return;
          result.empty();
          result.createEl("p", {
            text: `${data.hits.length} sources · ${Math.round(data.durationMs)} ms`,
            cls: "notient-muted",
          });
          if (data.coverage.message)
            result.createEl("p", { text: data.coverage.message, cls: "notient-warning" });
          if (!data.hits.length)
            result.createEl("p", {
              text: "No matching saved evidence. Try a distinctive word or a shorter phrase.",
            });
          for (const hit of data.hits) {
            const card = result.createDiv({ cls: "notient-card" });
            if (hit.evidence) this.source(card, hit.evidence);
            else
              card.createEl("p", {
                text: `${hit.note.path} · evidence is unavailable`,
                cls: "notient-muted",
              });
            if (hit.evidence) await this.renderMarkdown(card, hit.evidence.quote, hit.note.path);
            if (signal.aborted || current !== request) return;
          }
        })
        .catch((error) => {
          if (!signal.aborted && current === request) {
            result.empty();
            result.createEl("p", { text: message(error), cls: "notient-error" });
          }
        });
    });
    input.focus();
  }
  private async renderJobs(signal: AbortSignal): Promise<void> {
    const client = this.client;
    const [page, pipelines] = await Promise.all([
      client.call("jobs.list", { limit: 40 }, signal),
      client.call("pipelines.list", {}, signal),
    ]);
    signal.throwIfAborted();
    const enabled = pipelines.pipelines.filter((p) => p.policy.enabled).length;
    this.content.createEl("p", {
      text: pipelines.paused
        ? "AI background work is paused"
        : enabled
          ? `${enabled} workflows explicitly enabled for background work`
          : "AI background work is off · structural indexing continues",
      cls: "notient-muted",
    });
    this.button(this.content, "Refresh", () => this.render());
    const pending: unknown = this.app.loadLocalStorage("notient-pending-workflow");
    if (pending)
      this.button(this.content, "Check previous submission", async () => {
        // Runtime validation belongs to the SDK; the exact persisted key is reused
        // only when the operator explicitly checks this ambiguous admission.
        const result = await client.call(
          "pipelines.run",
          pending as Parameters<typeof client.call<"pipelines.run">>[1],
        );
        this.app.saveLocalStorage("notient-pending-workflow", null);
        await this.inspectJob(result.job.id);
      });
    const jobs = page.jobs;
    if (!jobs.length)
      this.content.createEl("p", {
        text:
          this.destination === "review"
            ? "No suggested changes in the latest work. Preview a note workflow to inspect its evidence and proposed effects."
            : "No work yet. Open a note and preview a workflow when you need it.",
      });
    for (const job of jobs) {
      const card = this.content.createDiv({ cls: "notient-card" });
      this.button(card, titles[job.pipeline], () => this.inspectJob(job.id)).addClass(
        "notient-card-title",
      );
      card.createEl("p", {
        text: `${job.state} · ${job.progress.completed}/${job.progress.total} notes · ${job.modelCalls} model calls`,
        cls: "notient-muted",
      });
      card.createEl("p", { text: job.reason });
      if (job.failure) card.createEl("p", { text: job.failure.message, cls: "notient-error" });
    }
    const nextCursor = page.nextCursor;
    if (nextCursor)
      this.content.createEl("p", {
        text: "Showing the latest 40 jobs. Older work remains in daemon history.",
        cls: "notient-muted",
      });
  }
  /** Ask keeps the person's question; the bound passage rides along as its focus. */
  askSelection(target: SelectionTarget): void {
    this.askState.focus = target;
    this.askState.scope = "note";
    this.select("ask");
  }
  /** A person's own range edit becomes an ordinary preview. Nothing is written here. */
  async proposeEdit(target: SelectionTarget): Promise<void> {
    const signal = this.takeOver();
    this.button(this.content, "← Current note", () => this.render());
    this.content.createEl("h3", { text: "Propose an edit", cls: "notient-ask-title" });
    this.content.createEl("p", {
      text: `${target.path} · the saved revision you selected from. You review the exact change before anything is written.`,
      cls: "notient-muted",
    });
    this.content.createEl("h5", { text: "Selected passage" });
    this.content.createEl("pre", { text: target.text, cls: "notient-selection" });
    const input = this.content.createEl("textarea", {
      text: target.text,
      cls: "notient-analysis-question",
      attr: { "aria-label": "Replacement text", rows: "8", maxlength: "1048576" },
    });
    const result = this.content.createDiv();
    this.button(
      this.content,
      "Preview this edit",
      async () => {
        if (input.value === target.text) throw new Error("Change the text before previewing.");
        await this.host.verify(target);
        const file = this.app.vault.getFileByPath(target.path);
        if (!file) throw new Error("The selected note no longer exists.");
        const preview = await this.client.call(
          "changes.preview",
          editChangeSet(
            target,
            replacementFor(await readSaved(this.app, file), input.value),
            crypto.randomUUID(),
          ),
          signal,
        );
        signal.throwIfAborted();
        result.empty();
        await this.review(preview, undefined, result);
      },
      true,
    );
    this.content.appendChild(result);
    input.focus();
  }
  private takeOver(): AbortSignal {
    ++this.renderId;
    this.analysisActive = true;
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = null;
    }
    this.controller.abort();
    this.controller = new AbortController();
    this.removeChild(this.markdown);
    this.markdown = new Component();
    this.addChild(this.markdown);
    this.content.empty();
    return this.controller.signal;
  }
  async openAnalysis(
    kind: "compare" | "correlate" | "brief",
    path: string,
    focus?: SelectionTarget,
  ): Promise<void> {
    const signal = this.takeOver();
    this.button(this.content, "← Current note", () => this.render());
    const selection = focus && {
      focus,
      verify: (target: SelectionTarget) => this.host.verify(target),
    };
    if (kind === "brief") {
      renderBriefPanel({
        parent: this.content,
        initialPath: path,
        client: this.client,
        signal,
        ...selection,
        markdown: (parent, body, notePath) => this.renderMarkdown(parent, body, notePath),
        source: (parent, source) => this.source(parent, source),
      });
      return;
    }
    renderAnalysisPanel({
      parent: this.content,
      kind,
      initialPath: path,
      client: this.client,
      signal,
      ...selection,
      choose: () => chooseAnalysisNote(this.app, signal),
      markdown: (parent, body, notePath) => this.renderMarkdown(parent, body, notePath),
      source: (parent, source) => this.source(parent, source),
    });
  }

  private async renderReviews(signal: AbortSignal, cursor?: string): Promise<void> {
    const page = await this.client.call("proposals.list", { limit: 30, cursor }, signal);
    signal.throwIfAborted();
    this.content.createEl("h3", { text: "Thoughtful changes, your decision" });
    this.content.createEl("p", {
      text: "Review the evidence and exact Markdown before anything changes. Rejected suggestions remain recorded.",
      cls: "notient-muted",
    });
    this.button(this.content, "Refresh", () => this.render());
    if (!page.proposals.length)
      this.content.createEl("p", {
        text: "No suggestions on this page. Explore a note to prepare a review without changing its Markdown.",
      });
    for (const proposal of page.proposals) {
      const card = this.content.createDiv({ cls: "notient-card" });
      this.button(card, reviewTitle(proposal.provenance, titles), () =>
        this.inspectProposal(proposal.id),
      ).addClass("notient-card-title");
      card.createEl("p", {
        text: `${proposal.state}${proposal.appliedHistory.length ? ` · ${proposal.appliedHistory.length} effects recorded` : ""} · ${new Date(proposal.createdAt).toLocaleString()}`,
        cls: "notient-muted",
      });
      card.createEl("p", {
        text: proposal.provenance.sources.map((source) => source.path).join(" · "),
        cls: "notient-path",
      });
      card.createEl("p", { text: proposal.provenance.rationale.slice(0, 320) });
    }
    const nextCursor = page.nextCursor;
    if (nextCursor)
      this.button(this.content, "Next page", async () => {
        this.content.empty();
        await this.renderReviews(signal, nextCursor);
      });
  }
  private async inspectProposal(id: string): Promise<void> {
    ++this.renderId;
    this.controller.abort();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const { proposal } = await this.client.call("proposals.get", { id }, signal);
    const preview = await this.client.call(
      "changes.get",
      { previewId: proposal.previewId },
      signal,
    );
    signal.throwIfAborted();
    this.content.empty();
    this.button(this.content, "← Review queue", () => this.render());
    this.content.createEl("h3", { text: reviewTitle(proposal.provenance, titles) });
    this.content.createEl("p", { text: proposal.state, cls: "notient-muted" });
    await this.renderMarkdown(
      this.content,
      proposal.provenance.rationale,
      proposal.provenance.sources[0]?.path ?? "",
    );
    signal.throwIfAborted();
    for (const source of proposal.provenance.evidence) this.source(this.content, source);
    if (proposal.state === "stale")
      this.content.createEl("p", {
        text: proposal.appliedHistory.length
          ? "Some effects are already recorded. Continuing checks all remaining evidence and file revisions again."
          : "Source evidence has changed. Inspect the current note and prepare a fresh suggestion before applying.",
        cls: "notient-warning",
      });
    await this.review(preview, proposal);
  }
  private async inspectJob(id: string): Promise<void> {
    ++this.renderId;
    this.controller.abort();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const { job } = await this.client.call("jobs.get", { id }, signal);
    signal.throwIfAborted();
    this.content.empty();
    this.button(this.content, "← All work", () => this.render());
    this.content.createEl("h3", { text: titles[job.pipeline] });
    this.content.createEl("p", {
      text: `${job.state} · ${job.stage} · ${Math.round(job.activeDurationMs / 1000)} seconds`,
      cls: "notient-muted",
    });
    const actions = this.content.createDiv({ cls: "notient-actions" });
    this.button(actions, "Refresh", () => this.inspectJob(id));
    const control = async (action: "cancel" | "pause" | "resume" | "retry") => {
      await this.client.call("jobs.control", {
        id,
        revision: job.revision,
        action,
        idempotencyKey: `${job.revision}:${action}`,
      });
      await this.inspectJob(id);
    };
    if (
      ["queued", "running", "waiting-inference", "paused", "awaiting-approval"].includes(job.state)
    )
      this.button(actions, "Cancel", () => control("cancel"));
    if (["queued", "running", "waiting-inference"].includes(job.state))
      this.button(actions, "Pause", () => control("pause"));
    if (job.state === "paused") this.button(actions, "Resume", () => control("resume"));
    if (job.state === "failed") this.button(actions, "Retry", () => control("retry"));
    if (job.failure)
      this.content.createEl("p", { text: job.failure.message, cls: "notient-error" });
    if (job.plan) {
      await this.renderMarkdown(this.content, job.plan.summary, "");
      signal.throwIfAborted();
      if (job.plan.abstained)
        this.content.createEl("p", {
          text: job.plan.reason ?? "The evidence does not support a useful change.",
          cls: "notient-muted",
        });
      for (const finding of job.plan.findings) {
        const card = this.content.createDiv({ cls: "notient-card" });
        card.createEl("h4", { text: finding.title });
        await this.renderMarkdown(card, finding.explanation, finding.evidence[0]?.path ?? "");
        signal.throwIfAborted();
        for (const source of finding.evidence) this.source(card, source);
      }
    }
    if (job.previewId) {
      const preview = await this.client.call("changes.get", { previewId: job.previewId }, signal);
      signal.throwIfAborted();
      const proposalId = job.proposalIds[0];
      const proposal = proposalId
        ? (await this.client.call("proposals.get", { id: proposalId }, signal)).proposal
        : undefined;
      signal.throwIfAborted();
      await this.review(preview, proposal);
    }
  }
  private async review(
    preview: ChangePreview,
    proposal?: ReviewProposal,
    container: HTMLElement = this.content,
  ): Promise<void> {
    const parent = container.createDiv({ cls: "notient-review" });
    parent.createEl("h4", { text: `Review ${preview.effects.length} file effects` });
    for (const conflict of preview.conflicts)
      parent.createEl("p", { text: `${conflict.path}: ${conflict.reason}`, cls: "notient-error" });
    for (const effect of preview.effects) {
      const card = parent.createEl("details", { cls: "notient-card" });
      card.createEl("summary", {
        text: `${effect.reason} · ${effect.path}${effect.destination ? ` → ${effect.destination}` : ""}`,
      });
      card.createEl("h5", { text: "Before · exact Markdown" });
      card.createEl("pre", { text: effect.before ?? "New note" });
      card.createEl("h5", { text: "After" });
      await this.renderMarkdown(card, effect.after, effect.destination ?? effect.path);
      const raw = card.createEl("details");
      raw.createEl("summary", { text: "Exact Markdown after this change" });
      raw.createEl("pre", { text: effect.after });
    }
    const decided = proposal?.state === "approved" || proposal?.state === "rejected";
    if (decided)
      parent.createEl("p", {
        text: `${proposal.state} · ${proposal.decidedBy ?? "operator"}${proposal.appliedHistory.length ? ` · ${proposal.appliedHistory.length} effects recorded in history` : ""}`,
        cls: "notient-muted",
      });
    if (
      preview.effects.length &&
      !preview.conflicts.length &&
      !decided &&
      (proposal?.state !== "stale" || proposal.appliedHistory.length)
    )
      this.button(
        parent,
        "Apply these reviewed changes",
        async () => {
          const request = {
            previewId: preview.previewId,
            previewRevision: preview.revision,
            idempotencyKey: `obsidian-apply-${preview.previewId}`,
          };
          const result = proposal
            ? await this.client.call("proposals.approve", { ...request, id: proposal.id })
            : await this.client.call("changes.apply", request);
          parent.createEl("p", {
            text: result.state,
            cls: result.ok ? "notient-success" : "notient-error",
          });
          for (const effect of result.effects)
            if (effect.message) parent.createEl("p", { text: `${effect.path}: ${effect.message}` });
          if (proposal && result.state === "applied") await this.inspectProposal(proposal.id);
        },
        true,
      );
    if (proposal && !decided)
      this.button(
        parent,
        proposal.appliedHistory.length ? "Reject remaining changes" : "Reject suggestion",
        async () => {
          await this.client.call("proposals.reject", {
            id: proposal.id,
            revision: proposal.revision,
            idempotencyKey: `obsidian-reject-${proposal.id}-${proposal.revision.slice(0, 12)}`,
          });
          await this.inspectProposal(proposal.id);
        },
      );
  }
  private source(parent: HTMLElement, source: SourceReference): void {
    this.button(parent, `${source.path} · line ${source.range.startLine}`, () =>
      this.host.open(source),
    ).addClass("notient-source");
  }
  private async renderMarkdown(parent: HTMLElement, text: string, path: string): Promise<void> {
    const rendered = parent.createDiv({ cls: "notient-markdown" });
    await MarkdownRenderer.render(this.app, text, rendered, path, this.markdown);
    // These are saved evidence or reviewed future bytes, not the native editor.
    // A task toggle must never edit a source through a preview's line offsets.
    for (const checkbox of rendered.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      checkbox.disabled = true;
  }
  private button(
    parent: HTMLElement,
    text: string,
    action: () => Promise<unknown>,
    primary = false,
  ): HTMLButtonElement {
    const button = parent.createEl("button", { text, cls: primary ? "mod-cta" : "" });
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await action();
      } catch (error) {
        new Notice(message(error), 10000);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }
}
