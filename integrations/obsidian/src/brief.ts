import { briefLabels } from "../../../src/api/briefMarkdown";
import type { NotientClient } from "../../../src/api/client";
import type { SourceReference } from "../../../src/api/schema";
import type { SelectionTarget } from "./selection";

export function renderBriefPanel(options: {
  parent: HTMLElement;
  initialPath: string;
  client: NotientClient;
  signal: AbortSignal;
  focus?: SelectionTarget;
  verify?: (target: SelectionTarget) => Promise<void>;
  markdown: (parent: HTMLElement, body: string, path: string) => Promise<void>;
  source: (parent: HTMLElement, source: SourceReference) => void;
}): void {
  const { parent, signal } = options;
  parent.createEl("h3", { text: "A little clarity", cls: "notient-ask-title" });
  parent.createEl("p", {
    text: "A concise brief, grounded in your saved notes. Unsaved editor text is excluded.",
    cls: "notient-muted",
  });
  const form = parent.createEl("form");
  const mode = form.createEl("select", { attr: { "aria-label": "Brief source" } });
  mode.createEl("option", { value: "topic", text: "Topic" });
  if (options.initialPath) mode.createEl("option", { value: "note", text: "Current saved note" });
  const topic = form.createEl("input", {
    type: "text",
    placeholder: "What would you like to get up to speed on?",
    attr: { "aria-label": "Brief topic", maxlength: "8192" },
    cls: "notient-analysis-question",
  });
  const note = form.createDiv();
  note.createEl("p", { text: options.initialPath, cls: "notient-path" });
  if (options.focus) {
    note.createEl("div", { text: "Focused on the selected passage", cls: "notient-muted" });
    note.createEl("pre", { text: options.focus.text, cls: "notient-selection" });
  }
  mode.value = options.initialPath ? "note" : "topic";
  topic.hidden = mode.value === "note";
  note.hidden = !topic.hidden;
  mode.addEventListener("change", () => {
    topic.hidden = mode.value === "note";
    note.hidden = !topic.hidden;
    if (!topic.hidden) topic.focus();
  });
  const actions = form.createDiv({ cls: "notient-actions" });
  const submit = actions.createEl("button", {
    text: "Prepare brief",
    type: "submit",
    cls: "mod-cta",
  });
  const stop = actions.createEl("button", { text: "Stop", type: "button" });
  stop.hidden = true;
  const edit = parent.createEl("button", {
    text: "New brief",
    type: "button",
    cls: "notient-quiet",
  });
  edit.hidden = true;
  edit.addEventListener("click", () => {
    form.hidden = false;
    edit.hidden = true;
    topic.focus();
  });
  const status = parent.createEl("p", {
    cls: "notient-muted",
    attr: { role: "status", "aria-live": "polite" },
  });
  const results = parent.createDiv({ cls: "notient-analysis-result" });
  let active: AbortController | null = null;
  stop.addEventListener("click", () => active?.abort());
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (active || signal.aborted) return;
    const query = topic.value.trim();
    const fromNote = mode.value === "note";
    if (!fromNote && !query) {
      status.setText("Enter a topic to explore.");
      topic.focus();
      return;
    }
    const controller = new AbortController();
    active = controller;
    const requestSignal = AbortSignal.any([signal, controller.signal]);
    submit.disabled = mode.disabled = topic.disabled = true;
    stop.hidden = false;
    results.empty();
    status.removeClass("notient-error");
    const started = performance.now();
    const waiting = () =>
      status.setText(
        `Reading current sources and preparing your brief… ${Math.floor((performance.now() - started) / 1000)}s`,
      );
    waiting();
    const timer = setInterval(waiting, 1000);
    const cleanup = () => {
      clearInterval(timer);
      signal.removeEventListener("abort", cleanup);
    };
    signal.addEventListener("abort", cleanup, { once: true });
    void (async () => {
      try {
        // A selection stays bound to the revision it was taken from. A changed
        // note is a conflict here and at the daemon, never a silent re-read.
        const focus = fromNote ? options.focus : undefined;
        if (focus) await options.verify?.(focus);
        const source = focus
          ? { path: focus.path, revision: focus.revision }
          : fromNote
            ? (
                await options.client.call(
                  "notes.read",
                  { path: options.initialPath },
                  requestSignal,
                )
              ).note
            : undefined;
        const result = await options.client.call(
          "brief.run",
          {
            query: fromNote ? undefined : query,
            source,
            focus: focus && { start: focus.start, end: focus.end },
            scope: {},
            limit: 8,
          },
          requestSignal,
        );
        requestSignal.throwIfAborted();
        cleanup();
        form.hidden = true;
        edit.hidden = false;
        status.setText(
          `${result.sources.length} ${result.sources.length === 1 ? "source" : "sources"} checked · ${(result.durationMs / 1000).toFixed(1)}s`,
        );
        results.createEl("h4", { text: result.topic });
        if (result.abstained)
          results.createEl("p", { text: result.reason ?? "Insufficient evidence." });
        if (result.coverage.state !== "current")
          results.createEl("p", {
            text: result.coverage.message ?? "Retrieval coverage is incomplete.",
            cls: "notient-warning",
          });
        const statements = [
          ...(result.summary ? [{ ...result.summary, label: "Overview" }] : []),
          ...result.findings.map((finding) => ({ ...finding, label: briefLabels[finding.kind] })),
        ];
        for (const statement of statements) {
          const card = results.createDiv({ cls: "notient-card" });
          card.createEl("h4", { text: statement.label });
          await options.markdown(
            card.createDiv({ cls: "notient-markdown" }),
            statement.text,
            statement.evidence[0].path,
          );
          requestSignal.throwIfAborted();
          for (const source of statement.evidence) {
            options.source(card, source);
            await options.markdown(
              card.createDiv({ cls: "notient-markdown" }),
              source.quote
                .split("\n")
                .map((line) => `> ${line}`)
                .join("\n"),
              source.path,
            );
            requestSignal.throwIfAborted();
          }
        }
        for (const text of result.limitations)
          results.createEl("p", { text, cls: "notient-muted" });
      } catch (error) {
        if (!signal.aborted) {
          status.setText(
            controller.signal.aborted
              ? "Stopped. Your notes are unchanged."
              : error instanceof Error
                ? error.message
                : String(error),
          );
          status.toggleClass("notient-error", !controller.signal.aborted);
        }
      } finally {
        cleanup();
        active = null;
        if (!signal.aborted) {
          submit.disabled = mode.disabled = topic.disabled = false;
          stop.hidden = true;
        }
      }
    })();
  });
}
