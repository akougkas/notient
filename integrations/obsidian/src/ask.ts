import type { AskResult } from "../../../src/api/ask";
import type { NotientClient } from "../../../src/api/client";
import type { OperationInput } from "../../../src/api/operations";
import type { SourceReference } from "../../../src/api/schema";
import { isCanonicalOrdinaryNotePath } from "../../../src/core/vault/publicPath";
import { message } from "./host";
import { type SelectionTarget, askQuery } from "./selection";

export interface AskState {
  question: string;
  scope: "vault" | "folder" | "note";
  result: AskResult | null;
  answeredQuestion: string;
  answeredScope: string;
  /** A passage bound to a saved revision by an editor selection command. */
  focus: SelectionTarget | null;
}
interface AskPanelOptions {
  parent: HTMLElement;
  state: AskState;
  client: NotientClient;
  signal: AbortSignal;
  active: () => Promise<{ path: string | null; dirty: boolean }>;
  verify: (target: SelectionTarget) => Promise<void>;
  markdown: (parent: HTMLElement, text: string, path: string) => Promise<void>;
  source: (parent: HTMLElement, evidence: SourceReference) => void;
}

/** Native DOM and MarkdownRenderer are owned by the containing ItemView. */
export function renderAskPanel(options: AskPanelOptions): void {
  const { parent, state, signal } = options;
  parent.createEl("h3", { text: "Think with your notes", cls: "notient-ask-title" });
  parent.createEl("p", {
    text: "Find the thread between what you’ve written. Every answer brings you back to its sources.",
    cls: "notient-muted",
  });
  const form = parent.createEl("form", { cls: "notient-composer" });
  const input = form.createEl("textarea", {
    text: state.question,
    placeholder: "What would you like to understand?",
    attr: { "aria-label": "Question for your notes", rows: "4", maxlength: "8192" },
  });
  input.addEventListener("input", () => {
    state.question = input.value;
  });
  if (state.focus) {
    const focus = form.createDiv({ cls: "notient-card notient-selection-card" });
    focus.createEl("div", { text: `Selected passage · ${state.focus.path}`, cls: "notient-muted" });
    focus.createEl("pre", { text: state.focus.text, cls: "notient-selection" });
    const clear = focus.createEl("button", {
      text: "Ask without this passage",
      type: "button",
      cls: "notient-quiet",
    });
    clear.addEventListener("click", () => {
      state.focus = null;
      focus.remove();
      scope.disabled = false;
      input.placeholder = "What would you like to understand?";
    });
    input.placeholder = "What would you like to know about this passage?";
  }
  const controls = form.createDiv({ cls: "notient-composer-controls" });
  const scope = controls.createEl("select", { attr: { "aria-label": "Answer from" } });
  for (const [value, label] of [
    ["vault", "Whole vault"],
    ["folder", "Active folder"],
    ["note", "Active note"],
  ])
    scope.createEl("option", { value, text: label });
  scope.value = state.scope;
  scope.disabled = !!state.focus;
  scope.addEventListener("change", () => {
    state.scope = scope.value as AskState["scope"];
  });
  const submit = controls.createEl("button", {
    text: "Ask Notient",
    type: "submit",
    cls: "mod-cta",
  });
  const cancel = controls.createEl("button", { text: "Stop", type: "button" });
  cancel.hidden = true;
  form.createEl("span", {
    text: "Ctrl / ⌘ Enter to ask · saved notes only",
    cls: "notient-muted notient-composer-hint",
  });
  const suggestions = parent.createDiv({ cls: "notient-ask-suggestions" });
  for (const text of [
    "What ideas connect my recent work?",
    "Where do my notes disagree?",
    "What is still unresolved?",
  ]) {
    const button = suggestions.createEl("button", { text, type: "button" });
    button.addEventListener("click", () => {
      input.value = text;
      state.question = text;
      input.focus();
    });
  }
  const status = parent.createEl("p", {
    cls: "notient-muted",
    attr: { role: "status", "aria-live": "polite" },
  });
  const answer = parent.createDiv({ cls: "notient-answer" });
  if (state.result) void renderAnswer(options, answer, state.result);
  let active: AbortController | null = null;
  cancel.addEventListener("click", () => active?.abort());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (active || (!input.value.trim() && !state.focus) || signal.aborted) return;
    state.question = input.value.trim();
    const controller = new AbortController();
    active = controller;
    const requestSignal = AbortSignal.any([signal, controller.signal]);
    submit.disabled = true;
    input.disabled = true;
    scope.disabled = true;
    cancel.hidden = false;
    suggestions.hidden = true;
    status.removeClass("notient-error");
    answer.empty();
    const start = performance.now();
    const update = () =>
      status.setText(
        `Working with your notes · ${Math.floor((performance.now() - start) / 1000)}s`,
      );
    update();
    const timer = setInterval(update, 1000);
    // Component disposal aborts work and clears the timer even during transport shutdown.
    requestSignal.addEventListener("abort", () => clearInterval(timer), { once: true });
    void (async () => {
      try {
        const focus = state.focus;
        if (focus) await options.verify(focus);
        const selection = focus ? "note" : state.scope;
        const context = focus
          ? { path: focus.path, dirty: false }
          : selection === "vault"
            ? null
            : await options.active();
        if (context && (!context.path || !isCanonicalOrdinaryNotePath(context.path)))
          throw new Error("Open a Markdown note to use this scope.");
        if (context?.dirty)
          throw new Error(
            "Save the active note first. Unsaved editor text is not part of this answer.",
          );
        const path = context?.path ?? "";
        const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        const readScope: OperationInput<"ask.run">["scope"] =
          selection === "note"
            ? { paths: [path] }
            : selection === "folder"
              ? { folders: [folder] }
              : {};
        const query = focus ? askQuery(state.question, focus) : state.question;
        const answeredQuestion = state.question || "About the selected passage";
        const answeredScope = focus
          ? `${path} · selected passage`
          : selection === "note"
            ? path
            : selection === "folder"
              ? folder || "Vault root"
              : "Whole vault";
        const result = await options.client.call(
          "ask.run",
          { query, scope: readScope },
          requestSignal,
        );
        if (requestSignal.aborted) return;
        clearInterval(timer);
        state.result = result;
        state.answeredQuestion = answeredQuestion;
        state.answeredScope = answeredScope;
        status.setText(
          `${result.citations.length} verified source${result.citations.length === 1 ? "" : "s"} · ${(result.durationMs / 1000).toFixed(1)}s`,
        );
        await renderAnswer(options, answer, result);
      } catch (error) {
        if (!signal.aborted) {
          status.setText(
            controller.signal.aborted ? "Stopped. Your notes were not changed." : message(error),
          );
          status.toggleClass("notient-error", !controller.signal.aborted);
          if (state.result) await renderAnswer(options, answer, state.result);
        }
      } finally {
        clearInterval(timer);
        active = null;
        if (!signal.aborted) {
          submit.disabled = false;
          input.disabled = false;
          scope.disabled = !!state.focus;
          cancel.hidden = true;
          input.focus();
        }
      }
    })();
  });
}
async function renderAnswer(
  options: AskPanelOptions,
  parent: HTMLElement,
  result: AskResult,
): Promise<void> {
  const { state, signal } = options;
  parent.empty();
  parent.createEl("p", { text: state.answeredScope, cls: "notient-answer-scope" });
  parent.createEl("h3", { text: state.answeredQuestion });
  if (result.coverage.message)
    parent.createEl("p", { text: result.coverage.message, cls: "notient-warning" });
  await options.markdown(parent, result.answer, result.citations[0]?.path ?? "");
  if (signal.aborted) return;
  if (result.openQuestions.length) {
    parent.createEl("h4", { text: "Still worth exploring" });
    const list = parent.createEl("ul");
    for (const question of result.openQuestions) list.createEl("li", { text: question });
  }
  if (!result.citations.length) return;
  parent.createEl("h4", { text: "Return to the source" });
  for (const source of result.citations) {
    const card = parent.createEl("details", { cls: "notient-card notient-evidence" });
    card.createEl("summary", { text: source.path.replace(/\.md$/i, "") });
    options.source(card, source);
    await options.markdown(card, source.quote, source.path);
    if (signal.aborted) return;
  }
}
