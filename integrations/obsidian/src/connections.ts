import type { NotientClient } from "../../../src/api/client";
import type { SourceReference } from "../../../src/api/schema";

/** Daemon owns graph/evidence; the host alone opens files and saved-source ranges. */
export async function renderConnections(options: {
  parent: HTMLElement;
  path: string;
  client: NotientClient;
  signal: AbortSignal;
  open: (path: string) => Promise<void>;
  source: (parent: HTMLElement, source: SourceReference) => void;
  markdown: (parent: HTMLElement, body: string, path: string) => Promise<void>;
  refresh: () => Promise<void>;
}): Promise<void> {
  const { parent, signal } = options;
  const heading = parent.createDiv({ cls: "notient-section-heading" });
  heading.createEl("h4", { text: "Connections" });
  const refresh = heading.createEl("button", {
    text: "Refresh",
    attr: { "aria-label": "Refresh saved note and connections" },
  });
  refresh.addEventListener("click", () => {
    if (signal.aborted) return;
    refresh.disabled = true;
    void options
      .refresh()
      .catch((error) => {
        if (!signal.aborted) {
          status.setText(error instanceof Error ? error.message : String(error));
          status.addClass("notient-error");
        }
      })
      .finally(() => {
        refresh.disabled = false;
      });
  });
  const status = parent.createEl("p", {
    text: "Checking saved connections…",
    cls: "notient-muted",
    attr: { role: "status" },
  });
  try {
    const result = await options.client.call(
      "graph.neighbors",
      { path: options.path, includeProposed: true, limit: 50 },
      signal,
    );
    signal.throwIfAborted();
    status.setText(
      result.coverage.state !== "current"
        ? (result.coverage.message ?? "Index coverage is unknown.")
        : result.truncated
          ? "Showing up to 50 connections; more may exist."
          : `${result.connections.length} connection${result.connections.length === 1 ? "" : "s"} · checked against saved files`,
    );
    status.toggleClass("notient-warning", result.coverage.state !== "current" || result.truncated);
    if (!result.connections.length) {
      parent.createEl("p", {
        text:
          result.coverage.state === "current"
            ? "No authored links or reviewed relationships for this note yet."
            : "No verified connections available yet. Refresh after indexing catches up.",
        cls: "notient-muted",
      });
      return;
    }
    for (const edge of result.connections) {
      signal.throwIfAborted();
      const card = parent.createDiv({ cls: "notient-card notient-connection" });
      const relation =
        edge.relation === "wikilink"
          ? "link"
          : edge.relation === "frontmatter_ref"
            ? "property"
            : edge.relation.replaceAll("_", " ");
      card.createEl("div", {
        text: `${edge.direction === "incoming" ? "Backlink" : "Outgoing"} · ${relation} · ${edge.state}`,
        cls: "notient-muted",
      });
      const title = card.createEl("button", {
        text: edge.note.path.split("/").pop()?.replace(/\.md$/, "") ?? edge.note.path,
        cls: "notient-card-title",
        attr: { title: edge.note.path },
      });
      title.addEventListener("click", () => {
        if (signal.aborted) return;
        title.disabled = true;
        void options
          .open(edge.note.path)
          .catch((error) => {
            card.createEl("p", {
              text: error instanceof Error ? error.message : String(error),
              cls: "notient-error",
              attr: { role: "alert" },
            });
          })
          .finally(() => {
            title.disabled = false;
          });
      });
      card.createEl("div", { text: edge.note.path, cls: "notient-path" });
      if (edge.rationale) await options.markdown(card.createDiv(), edge.rationale, options.path);
      signal.throwIfAborted();
      if (edge.state === "authored") continue;
      card.createEl("p", {
        text:
          edge.evidenceState === "stale"
            ? "The evidence has changed since this relationship was assessed. Review it before relying on the claim."
            : edge.evidenceState === "unavailable"
              ? "Revision-bound evidence is unavailable for this relationship."
              : `${edge.evidence.length} current evidence passage(s)`,
        cls: edge.evidenceState === "stale" ? "notient-warning" : "notient-muted",
      });
      if (edge.assessment !== null)
        card.createEl("p", {
          text: `Model assessment ${edge.assessment.toFixed(2)} · ${edge.author}`,
          cls: "notient-muted",
        });
      for (const source of edge.evidence) options.source(card, source);
    }
  } catch (error) {
    if (signal.aborted) return;
    status.setText(error instanceof Error ? error.message : String(error));
    status.addClass("notient-error");
  }
}
