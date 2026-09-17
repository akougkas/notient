import type { CaptureDraft } from "./captureDraft";
import { message } from "./host";

interface CapturePanelOptions {
  parent: HTMLElement;
  session: CaptureDraft;
  signal: AbortSignal;
  markdown: (parent: HTMLElement, body: string, path: string) => Promise<void>;
  open: (path: string) => Promise<void>;
}

export function renderCapturePanel(options: CapturePanelOptions): void {
  const { parent, session, signal } = options;
  parent.createEl("h3", { text: "Make room for a thought", cls: "notient-ask-title" });
  parent.createEl("p", {
    text: "Catch it while it’s here. A few words, a question, the beginning of something.",
    cls: "notient-muted",
  });
  const editor = parent.createDiv();
  const form = editor.createEl("form", { cls: "notient-composer notient-capture" });
  const input = form.createEl("textarea", {
    text: session.record.draft.body,
    placeholder: "What’s on your mind?\n\nMarkdown, links and unfinished ideas welcome.",
    attr: { "aria-label": "Thought to capture", rows: "10", maxlength: "48000" },
  });
  const controls = form.createDiv({ cls: "notient-composer-controls" });
  const count = controls.createEl("span", { cls: "notient-muted notient-word-count" });
  const preview = controls.createEl("button", {
    text: "Review note",
    type: "submit",
    cls: "mod-cta",
  });
  form.createEl("span", {
    text: "Ctrl / ⌘ Enter to review",
    cls: "notient-muted notient-composer-hint",
  });
  const pathLabel = editor.createEl("label", { cls: "notient-capture-destination" });
  pathLabel.createEl("span", { text: "Save to", cls: "notient-muted" });
  const path = pathLabel.createEl("input", {
    value: session.record.draft.path,
    attr: { "aria-label": "Note destination", spellcheck: "false", maxlength: "1024" },
  });
  const review = parent.createDiv({ cls: "notient-capture-review" });
  const reviewTitle = review.createEl("p", { cls: "notient-answer-scope" });
  const rendered = review.createDiv({ cls: "notient-markdown" });
  const source = review.createEl("details", { cls: "notient-card" });
  source.createEl("summary", { text: "Exact Markdown" });
  const raw = source.createEl("pre");
  const actions = review.createDiv({ cls: "notient-actions" });
  const save = actions.createEl("button", { text: "Save note", cls: "mod-cta" });
  const back = actions.createEl("button", { text: "Keep writing" });
  const open = actions.createEl("button", { text: "Open note", cls: "mod-cta" });
  const another = actions.createEl("button", { text: "Capture another" });
  const status = parent.createEl("p", {
    cls: "notient-muted",
    attr: { role: "status", "aria-live": "polite" },
  });
  const error = parent.createEl("p", { cls: "notient-error", attr: { role: "alert" } });
  const discard = parent.createEl("button", { text: "Discard draft", cls: "notient-quiet" });
  const discardConfirm = parent.createDiv({ cls: "notient-card" });
  discardConfirm.hidden = true;
  discardConfirm.createEl("p", {
    text: "Discard this local draft? It hasn’t been saved to your vault.",
  });
  const confirm = discardConfirm.createEl("button", { text: "Discard draft" });
  const keep = discardConfirm.createEl("button", { text: "Keep it" });
  let editing = !session.record.draft.preview;
  let observedPreview = session.record.draft.preview?.previewId;
  let renderedRevision = "";
  const refresh = () => {
    if (signal.aborted) return;
    const { draft, saveStarted, receipt } = session.record;
    if (draft.preview?.previewId !== observedPreview) {
      observedPreview = draft.preview?.previewId;
      editing = !draft.preview;
    }
    const saved = receipt?.state === "applied";
    const reviewing = !!draft.preview && (!editing || saveStarted || saved);
    editor.hidden = reviewing;
    review.hidden = !reviewing;
    input.disabled = path.disabled = session.busy || saveStarted || saved;
    if (input.value !== draft.body) input.value = draft.body;
    if (path.value !== draft.path) path.value = draft.path;
    const words = draft.body.trim() ? draft.body.trim().split(/\s+/).length : 0;
    count.setText(`${words} word${words === 1 ? "" : "s"}`);
    preview.disabled = session.busy || !draft.body.trim();
    save.hidden = saved;
    save.disabled = back.disabled = another.disabled = open.disabled = session.busy;
    save.setText(saveStarted ? "Retry reviewed save" : "Save note");
    back.hidden = saved || saveStarted;
    open.hidden = another.hidden = !saved;
    reviewTitle.setText(`${saved ? "Saved" : "New note"} · ${draft.path}`);
    if (draft.preview && draft.preview.revision !== renderedRevision) {
      renderedRevision = draft.preview.revision;
      const body = draft.preview.effects[0]?.after ?? draft.body;
      rendered.empty();
      raw.setText(body);
      // Each render gets its own element, so an old asynchronous renderer cannot
      // append stale text to a newer draft after navigation.
      const content = rendered.createDiv();
      void options.markdown(content, body, draft.path).catch((cause) => {
        if (!signal.aborted && content.isConnected) error.setText(message(cause));
      });
    }
    status.setText(
      session.busy
        ? saveStarted
          ? "Saving your reviewed note…"
          : "Preparing your note for review…"
        : saved
          ? "Saved to your vault with a history receipt."
          : saveStarted
            ? "The save outcome is unconfirmed. Retry this exact reviewed save to retrieve its receipt or finish it once."
            : !session.persisted
              ? "This draft could not be kept locally. Keep this view open until storage is available."
              : reviewing
                ? "This is the exact content to save. Your vault is unchanged until you save."
                : "Draft kept on this device · no model needed",
    );
    status.toggleClass("notient-success", saved);
    error.setText(session.error ?? "");
    error.hidden = !session.error;
    discard.hidden = session.busy || saveStarted || saved || !draft.body.trim();
  };
  const unsubscribe = session.subscribe(refresh);
  signal.addEventListener("abort", unsubscribe, { once: true });
  input.addEventListener("input", () => session.edit({ body: input.value }));
  path.addEventListener("input", () => session.edit({ path: path.value }));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (session.busy) return;
    discardConfirm.hidden = true;
    void session.preview().then(() => {
      editing = !session.record.draft.preview;
      refresh();
    });
  });
  save.addEventListener("click", () => {
    void session.save();
  });
  back.addEventListener("click", () => {
    editing = true;
    refresh();
    input.focus();
  });
  another.addEventListener("click", () => {
    session.reset();
    editing = true;
    refresh();
    input.focus();
  });
  open.addEventListener("click", () => {
    void options.open(session.record.draft.path).catch((cause) => {
      if (!signal.aborted) {
        error.setText(message(cause));
        error.hidden = false;
      }
    });
  });
  discard.addEventListener("click", () => {
    discardConfirm.hidden = false;
  });
  keep.addEventListener("click", () => {
    discardConfirm.hidden = true;
  });
  confirm.addEventListener("click", () => {
    session.reset();
    editing = true;
    discardConfirm.hidden = true;
    refresh();
    input.focus();
  });
  refresh();
}
