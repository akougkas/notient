import { type App, FuzzySuggestModal, type TFile } from "obsidian";
import type { NotientClient } from "../../../src/api/client";
import { comparisonLabels } from "../../../src/api/comparisonMarkdown";
import type { SourceReference } from "../../../src/api/schema";
import { isCanonicalOrdinaryNotePath } from "../../../src/core/vault/publicPath";
import type { SelectionTarget } from "./selection";

export function chooseAnalysisNote(app: App, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    class Picker extends FuzzySuggestModal<TFile> {
      getItems() {
        return app.vault
          .getMarkdownFiles()
          .filter((file) => isCanonicalOrdinaryNotePath(file.path));
      }
      getItemText(file: TFile) {
        return file.path;
      }
      onChooseItem(file: TFile) {
        resolve(file.path);
      }
      onClose() {
        signal.removeEventListener("abort", abort);
        setTimeout(() => resolve(null), 0);
      }
    }
    const picker = new Picker(app);
    picker.setPlaceholder("Choose a saved note to compare");
    const abort = () => picker.close();
    if (signal.aborted) {
      resolve(null);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    picker.open();
  });
}

export function renderAnalysisPanel(options: {
  parent: HTMLElement;
  kind: "compare" | "correlate";
  initialPath: string;
  client: NotientClient;
  signal: AbortSignal;
  focus?: SelectionTarget;
  verify?: (target: SelectionTarget) => Promise<void>;
  choose: () => Promise<string | null>;
  markdown: (parent: HTMLElement, body: string, path: string) => Promise<void>;
  source: (parent: HTMLElement, source: SourceReference) => void;
}): void {
  const { parent, kind, signal } = options;
  parent.createEl("h3", {
    text: kind === "compare" ? "Think across your notes" : "Find a useful connection",
    cls: "notient-ask-title",
  });
  parent.createEl("p", {
    text: "Compare saved notes with source quotations. Unsaved editor text is excluded.",
    cls: "notient-muted",
  });
  const paths = [options.initialPath, ""];
  let active: AbortController | null = null;
  const selectors: HTMLButtonElement[] = [];
  const form = parent.createEl("form");
  const edit = parent.createEl("button", {
    text: "Change selection",
    type: "button",
    cls: "notient-quiet",
  });
  edit.hidden = true;
  edit.addEventListener("click", () => {
    form.hidden = false;
    edit.hidden = true;
    question.focus();
  });
  for (let index = 0; index < (kind === "compare" ? 2 : 1); index++) {
    const row = form.createDiv({ cls: "notient-capture-destination" });
    row.createEl("span", { text: index ? "Compare with" : "Source note", cls: "notient-muted" });
    const button = row.createEl("button", {
      text: paths[index] || "Choose a note…",
      type: "button",
      cls: "notient-outline",
    });
    selectors.push(button);
    button.addEventListener("click", () => {
      if (active || signal.aborted) return;
      button.disabled = true;
      void options
        .choose()
        .then((path) => {
          if (path && !signal.aborted) {
            paths[index] = path;
            button.setText(path);
          }
        })
        .catch((error) => {
          if (!signal.aborted) {
            status.setText(String(error));
            status.addClass("notient-error");
          }
        })
        .finally(() => {
          button.disabled = !!active;
        });
    });
  }
  if (options.focus && kind === "correlate") {
    form.createEl("div", { text: "Connections for the selected passage", cls: "notient-muted" });
    form.createEl("pre", { text: options.focus.text, cls: "notient-selection" });
  }
  const question = form.createEl("textarea", {
    placeholder: "Optional · what would you like to understand?",
    cls: "notient-analysis-question",
    attr: { "aria-label": "Comparison question", rows: "2", maxlength: "8192" },
  });
  question.hidden = kind !== "compare";
  const actions = form.createDiv({ cls: "notient-actions" });
  const submit = actions.createEl("button", {
    text: kind === "compare" ? "Compare notes" : "Find connections",
    type: "submit",
    cls: "mod-cta",
  });
  const stop = actions.createEl("button", { text: "Stop", type: "button" });
  stop.hidden = true;
  stop.addEventListener("click", () => active?.abort());
  const status = parent.createEl("p", {
    attr: { role: "status", "aria-live": "polite" },
    cls: "notient-muted",
  });
  const results = parent.createDiv({ cls: "notient-analysis-result" });
  question.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (active || signal.aborted) return;
    if (!paths[0] || (kind === "compare" && (!paths[1] || paths[0] === paths[1]))) {
      status.setText("Choose different saved notes before comparing.");
      return;
    }
    const controller = new AbortController();
    active = controller;
    const requestSignal = AbortSignal.any([signal, controller.signal]);
    const selected = kind === "compare" ? [...paths] : [paths[0]];
    submit.disabled = true;
    question.disabled = true;
    stop.hidden = false;
    for (const button of selectors) button.disabled = true;
    results.empty();
    status.removeClass("notient-error");
    const started = performance.now();
    const waiting = () =>
      status.setText(
        `Reading saved revisions and comparing their evidence… ${Math.floor((performance.now() - started) / 1000)}s`,
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
        // The selection applies only while its own note is still the source.
        const focus =
          kind === "correlate" && options.focus?.path === selected[0] ? options.focus : undefined;
        if (focus) await options.verify?.(focus);
        const sources = [];
        for (const path of selected)
          sources.push(
            focus
              ? { path: focus.path, revision: focus.revision }
              : (await options.client.call("notes.read", { path }, requestSignal)).note,
          );
        const result =
          kind === "compare"
            ? await options.client.call(
                "notes.compare",
                { sources, question: question.value.trim() || undefined },
                requestSignal,
              )
            : await options.client.call(
                "notes.correlate",
                {
                  source: sources[0],
                  focus: focus && { start: focus.start, end: focus.end },
                  scope: {},
                  limit: 6,
                },
                requestSignal,
              );
        requestSignal.throwIfAborted();
        cleanup();
        form.hidden = true;
        edit.hidden = false;
        status.setText(
          result.abstained
            ? (result.reason ?? "Evidence is insufficient.")
            : `${result.comparisons.length} ${result.comparisons.length === 1 ? "comparison" : "comparisons"} · ${result.sources.length} sources checked · ${(result.durationMs / 1000).toFixed(1)}s`,
        );
        if (result.coverage && result.coverage.state !== "current")
          results.createEl("p", {
            text: result.coverage.message ?? "Retrieval coverage is incomplete.",
            cls: "notient-warning",
          });
        for (const item of result.comparisons) {
          const card = results.createDiv({ cls: "notient-card" });
          card.createEl("h4", { text: comparisonLabels[item.judgment] });
          card.createEl("p", {
            text: `${item.source.path} → ${item.target.path}`,
            cls: "notient-path",
          });
          await options.markdown(
            card.createDiv({ cls: "notient-markdown" }),
            item.explanation,
            item.source.path,
          );
          requestSignal.throwIfAborted();
          for (const source of item.evidence) {
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
          submit.disabled = false;
          question.disabled = false;
          stop.hidden = true;
          for (const button of selectors) button.disabled = false;
        }
      }
    })();
  });
}
