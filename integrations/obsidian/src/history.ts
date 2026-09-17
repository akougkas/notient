import type { NotientClient } from "../../../src/api/client";
import type { HistoryDetail } from "../../../src/api/history";

/** Saved snapshots and undo belong to the daemon; Markdown rendering belongs to Obsidian. */
export function renderHistory(options: {
  parent: HTMLElement;
  client: NotientClient;
  signal: AbortSignal;
  markdown: (parent: HTMLElement, body: string, path: string) => Promise<void>;
}): void {
  const { parent, client, signal } = options;
  const root = parent.createDiv({ cls: "notient-history" });
  const status = root.createEl("p", { cls: "notient-muted", attr: { role: "status" } });
  const content = root.createDiv();
  let busy = false;
  let pageCursor: string | undefined;
  const pages: Array<string | undefined> = [];
  const buttons = new Set<HTMLButtonElement>();
  const run = async (work: () => Promise<void>) => {
    if (busy || signal.aborted) return;
    busy = true;
    const previousStatus = status.textContent ?? "";
    status.removeClass("notient-error");
    status.setText("Working…");
    for (const button of buttons) button.disabled = true;
    try {
      await work();
      if (!signal.aborted && status.textContent === "Working…") status.setText(previousStatus);
    } catch (error) {
      if (!signal.aborted) {
        status.setText(error instanceof Error ? error.message : String(error));
        status.addClass("notient-error");
      }
    } finally {
      busy = false;
      if (!signal.aborted) for (const button of buttons) button.disabled = false;
    }
  };
  const button = (at: HTMLElement, label: string, work: () => Promise<void>) => {
    const el = at.createEl("button", { text: label });
    buttons.add(el);
    el.disabled = busy;
    el.addEventListener("click", () => {
      void run(work);
    });
    return el;
  };
  const reset = () => {
    signal.throwIfAborted();
    content.empty();
    buttons.clear();
  };
  const list = async (cursor?: string) => {
    const result = await client.call("history.list", { limit: 30, cursor }, signal);
    reset();
    pageCursor = cursor;
    content.createEl("h3", { text: "Your change history" });
    status.setText("Inspect saved versions before undoing a change. Newer edits are protected.");
    const actions = content.createDiv({ cls: "notient-actions" });
    button(actions, "Refresh", async () => {
      const previous = pages.splice(0);
      try {
        await list();
      } catch (error) {
        pages.push(...previous);
        throw error;
      }
    });
    if (pages.length)
      button(actions, "Previous page", async () => {
        const previous = pages.pop();
        try {
          await list(previous);
        } catch (error) {
          pages.push(previous);
          throw error;
        }
      });
    if (result.nextCursor)
      button(actions, "Next page", async () => {
        const previous = pageCursor;
        pages.push(previous);
        try {
          await list(result.nextCursor ?? undefined);
        } catch (error) {
          pages.pop();
          throw error;
        }
      });
    if (!result.entries.length)
      content.createEl("p", {
        text: "Your first saved thought will appear here.",
        cls: "notient-muted",
      });
    for (const entry of result.entries) {
      const card = content.createDiv({ cls: "notient-card" });
      button(card, entry.target, async () =>
        show(await client.call("history.get", { id: entry.id }, signal)),
      ).addClass("notient-card-title");
      card.createEl("p", {
        text: `${new Date(entry.createdAt).toLocaleString()} · ${entry.undo?.completedAt != null ? "undone" : entry.undo ? "undo interrupted" : entry.kind.replace(/^notes?\./, "").replaceAll("_", " ")}`,
        cls: "notient-muted",
      });
    }
  };
  const show = async (detail: HistoryDetail) => {
    reset();
    button(content, "← Change history", () => list(pageCursor));
    content.createEl("h3", { text: detail.entry.target });
    content.createEl("p", {
      text: `${detail.entry.kind.replace(/^notes?\./, "").replaceAll("_", " ")} · ${new Date(detail.entry.createdAt).toLocaleString()}`,
      cls: "notient-muted",
    });
    status.setText(
      detail.entry.undo?.completedAt != null
        ? "Undone · the original change and undo receipt remain in your history."
        : detail.entry.undo
          ? "This undo was interrupted. Inspect the snapshots before resuming the guarded operation."
          : "Compare the saved versions. Nothing changes until you confirm.",
    );
    for (const [title, body, path] of [
      ["Earlier version", detail.before, detail.entry.target],
      ["Recorded change", detail.after, detail.destination ?? detail.entry.target],
    ] as const) {
      const version = content.createEl("details", { cls: "notient-card notient-history-version" });
      version.createEl("summary", { text: title });
      version.open = title === "Earlier version";
      if (detail.destination) version.createEl("p", { text: path, cls: "notient-path" });
      if (body === null)
        version.createEl("p", {
          text:
            title === "Earlier version" && detail.sources.length > 0
              ? "This note did not exist before the change."
              : "This audit event has no note-body snapshot.",
          cls: "notient-muted",
        });
      else {
        await options.markdown(version.createDiv({ cls: "notient-markdown" }), body, path);
        signal.throwIfAborted();
        const raw = version.createEl("details");
        raw.createEl("summary", { text: "Exact Markdown" });
        raw.createEl("pre").createEl("code", { text: body });
      }
    }
    if (
      !detail.entry.reversible ||
      !detail.sources.length ||
      detail.entry.undo?.completedAt != null
    )
      return;
    const actions = content.createDiv({ cls: "notient-actions" });
    const confirmation = content.createDiv({ cls: "notient-card" });
    confirmation.hidden = true;
    const action = detail.destination
      ? `Move back to ${detail.entry.target}`
      : detail.before === null
        ? "Remove this created note"
        : "Restore the earlier version";
    button(actions, "Review undo", async () => {
      confirmation.hidden = false;
      actions.hidden = true;
    });
    confirmation.createEl("h4", { text: action });
    confirmation.createEl("p", {
      text: "Notient checks the saved revision and connected editors immediately before the change. A newer edit or unsaved buffer prevents undo.",
    });
    button(confirmation, "Keep current note", async () => {
      confirmation.hidden = true;
      actions.hidden = false;
    });
    button(confirmation, "Confirm undo", async () => {
      const result = await client.call(
        "history.undo",
        { id: detail.entry.id, sources: detail.sources, idempotencyKey: `undo:${detail.entry.id}` },
        signal,
      );
      signal.throwIfAborted();
      await show({ ...detail, entry: result.entry });
    }).addClass("mod-cta");
  };
  void run(() => list());
}
