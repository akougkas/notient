export type Section = "summary" | "implies" | "connects";

export interface PanelState {
  notePath: string | null;
  status: "idle" | "streaming" | "done" | "error" | "cancelled";
  sections: Record<Section, string>;
  errorMessage?: string;
}

export class CoAuthorPanelModel {
  private state: PanelState = {
    notePath: null,
    status: "idle",
    sections: { summary: "", implies: "", connects: "" },
  };
  private listeners = new Set<() => void>();

  snapshot(): PanelState {
    return {
      ...this.state,
      sections: { ...this.state.sections },
    };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  startStream(notePath: string): void {
    this.state = {
      notePath,
      status: "streaming",
      sections: { summary: "", implies: "", connects: "" },
    };
    this.emit();
  }

  appendSection(section: Section, delta: string): void {
    this.state.sections[section] += delta;
    this.emit();
  }

  appendSectionForNote(notePath: string, section: Section, delta: string): void {
    if (this.state.notePath !== notePath || this.state.status === "idle") {
      this.startStream(notePath);
    }
    this.appendSection(section, delta);
  }

  finish(ok: boolean, error?: string): void {
    this.state.status = ok ? "done" : "error";
    this.state.errorMessage = error;
    this.emit();
  }

  cancel(): void {
    this.state.status = "cancelled";
    this.emit();
  }

  reset(): void {
    this.state = {
      notePath: null,
      status: "idle",
      sections: { summary: "", implies: "", connects: "" },
    };
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export interface RenderHandlers {
  onCancel?: () => void;
}

export function renderCoAuthorPanel(
  root: HTMLElement,
  model: CoAuthorPanelModel,
  handlers: RenderHandlers = {},
): void {
  const state = model.snapshot();
  root.innerHTML = "";
  root.classList.add("notient-co-author");
  if (state.status === "idle") {
    const empty = document.createElement("div");
    empty.className = "notient-co-author__empty";
    empty.textContent = "Open a note longer than 100 words to wake the Co-author.";
    root.append(empty);
    return;
  }
  const header = document.createElement("div");
  header.className = "notient-co-author__header";
  const title = document.createElement("strong");
  title.textContent = state.notePath ?? "";
  header.append(title);
  if (state.status === "streaming") {
    const cancel = document.createElement("button");
    cancel.className = "notient-co-author__cancel";
    cancel.textContent = "cancel";
    cancel.addEventListener("click", () => handlers.onCancel?.());
    header.append(cancel);
  }
  root.append(header);

  if (state.status === "streaming" && allEmpty(state.sections)) {
    const skel = document.createElement("div");
    skel.className = "notient-co-author__skeleton";
    skel.textContent = "thinking...";
    root.append(skel);
    return;
  }

  for (const section of ["summary", "implies", "connects"] as Section[]) {
    const block = document.createElement("section");
    block.className = `notient-co-author__section notient-co-author__section--${section}`;
    const heading = document.createElement("h4");
    heading.textContent = section.toUpperCase();
    const body = document.createElement("div");
    body.className = "notient-co-author__body";
    body.textContent = state.sections[section];
    block.append(heading, body);
    root.append(block);
  }
  if (state.status === "error") {
    const err = document.createElement("div");
    err.className = "notient-co-author__error";
    err.textContent = state.errorMessage ?? "stream failed";
    root.append(err);
  } else if (state.status === "cancelled") {
    const c = document.createElement("div");
    c.className = "notient-co-author__cancelled";
    c.textContent = "cancelled";
    root.append(c);
  }
}

function allEmpty(sections: PanelState["sections"]): boolean {
  return Object.values(sections).every((v) => v.length === 0);
}
