import type { NotientSurface, SurfaceEvidence, MapSurface, PlacesSurface } from "../../../src/api/surfaces";
import type { SourceReference } from "../../../src/api/schema";

let nextMapArrow = 0;

export interface SurfaceViewOptions {
  source: (parent: HTMLElement, evidence: SourceReference) => void;
  openNote?: (path: string) => Promise<void>;
  copy: (text: string, label: string) => boolean | void | Promise<boolean | void>;
  onError?: (error: unknown) => void;
}

export function createSurfaceViews(parent: HTMLElement, options: SurfaceViewOptions) {
  const doc = parent.ownerDocument;
  const records = new Map<string, { element: HTMLElement; fingerprint: string }>();
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
    const node = doc.createElement(tag);
    node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const action = (text: string, run: () => void | Promise<void>) => {
    const button = element("button", "notient-surface-action", text);
    button.type = "button";
    button.addEventListener("click", () => {
      try {
        Promise.resolve(run()).catch((error) => options.onError?.(error));
      } catch (error) {
        options.onError?.(error);
      }
    });
    return button;
  };
  const noteLink = (path: string, title: string) => {
    const button = action(title, () => options.openNote?.(path));
    button.classList.add("notient-surface-note");
    button.title = path;
    button.setAttribute("aria-label", `Open ${path}`);
    if (!options.openNote) button.disabled = true;
    return button;
  };
  const passage = (item: SurfaceEvidence) => {
    const row = element("article", "notient-evidence-item");
    row.append(noteLink(item.path, item.title));
    row.append(element("div", "notient-surface-path", item.path));
    if (item.retainedRecord) {
      const retained = element("div", "notient-surface-qualification",
        `Retained ${item.retainedRecord.kind ?? "understanding"}${item.retainedRecord.status ? ` · ${item.retainedRecord.status}` : ""}`);
      retained.dataset.recordId = item.retainedRecord.id;
      row.append(retained);
    }
    const status = item.freshness === "current" ? "Current at retrieval"
      : item.freshness === "lagging" ? "Index was behind this source" : "Freshness not rechecked";
    row.append(element("span", "notient-evidence-freshness", status));
    if (item.quote) {
      const quote = element("blockquote", "notient-surface-quote", item.quote);
      const compact = item.quote.length > 320;
      quote.classList.toggle("is-collapsed", compact);
      row.append(quote);
      const controls = element("div", "notient-surface-actions");
      const copy = action("Copy passage", async () => {
        const result = await options.copy(item.quote!, "Passage copied.");
        copy.textContent = result === false ? "Copy failed" : "Copied";
        (doc.defaultView ?? window).setTimeout(() => { copy.textContent = "Copy passage"; }, 2000);
      });
      controls.append(copy);
      if (compact) {
        const expand = action("Read full passage", () => {
          const collapsed = quote.classList.toggle("is-collapsed");
          expand.textContent = collapsed ? "Read full passage" : "Show less";
          expand.setAttribute("aria-expanded", String(!collapsed));
        });
        expand.setAttribute("aria-expanded", "false");
        controls.append(expand);
      }
      row.append(controls);
    }
    if (item.evidence) {
      const exact = element("details", "notient-surface-source");
      exact.append(element("summary", "", "Source location"));
      let mounted = false;
      exact.addEventListener("toggle", () => {
        if (exact.open && !mounted) {
          mounted = true;
          options.source(exact, item.evidence!);
        }
      });
      row.append(exact);
    }
    return row;
  };
  const tree = (target: HTMLElement, surface: PlacesSurface) => {
    type Branch = { folders: Map<string, Branch>; notes: { path: string; title: string }[] };
    const branch = (): Branch => ({ folders: new Map(), notes: [] });
    const root = branch();
    for (const path of surface.paths) {
      const parts = path.split("/");
      let current = root;
      for (const folder of parts.slice(0, -1)) {
        if (!current.folders.has(folder)) current.folders.set(folder, branch());
        current = current.folders.get(folder)!;
      }
      current.notes.push({ path, title: parts.at(-1)!.replace(/\.md$/, "") });
    }
    target.append(element("p", "notient-surface-qualification", "Only the notes returned for this turn."));
    const paint = (container: HTMLElement, current: Branch, depth: number) => {
      for (const [name, nested] of [...current.folders].sort(([a], [b]) => a.localeCompare(b))) {
        const folder = element("details", "notient-tree-folder");
        folder.open = depth < 1;
        folder.append(element("summary", "notient-tree-label", name));
        const children = element("div", "notient-tree-children");
        paint(children, nested, depth + 1);
        folder.append(children);
        container.append(folder);
      }
      for (const note of current.notes.sort((a, b) => a.title.localeCompare(b.title))) {
        container.append(noteLink(note.path, note.title));
      }
    };
    const contents = element("div", "notient-surface-tree");
    paint(contents, root, 0);
    target.append(contents);
  };
  const map = (target: HTMLElement, surface: MapSurface) => {
    const visible = surface.nodes.slice(0, 10);
    if (visible.length) {
      const namespace = "http://www.w3.org/2000/svg";
      const svg = doc.createElementNS(namespace, "svg");
      svg.classList.add("notient-surface-diagram");
      svg.setAttribute("viewBox", "0 0 360 230");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", `${visible.length} notes; relationship directions and names follow below.`);
      const arrowId = `notient-map-arrow-${++nextMapArrow}`;
      const defs = doc.createElementNS(namespace, "defs");
      const marker = doc.createElementNS(namespace, "marker");
      marker.setAttribute("id", arrowId);
      marker.setAttribute("viewBox", "0 0 10 10");
      marker.setAttribute("refX", "9"); marker.setAttribute("refY", "5");
      marker.setAttribute("markerWidth", "7"); marker.setAttribute("markerHeight", "7");
      marker.setAttribute("orient", "auto"); marker.setAttribute("markerUnits", "userSpaceOnUse");
      const arrow = doc.createElementNS(namespace, "path");
      arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 Z"); arrow.setAttribute("fill", "context-stroke");
      marker.append(arrow); defs.append(marker); svg.append(defs);
      const coordinates = new Map(visible.map((node, index) => {
        const angle = (index - 1) * Math.PI * 2 / Math.max(1, visible.length - 1) - Math.PI / 2;
        return [node.path, index === 0 ? { x: 180, y: 115 }
          : { x: 180 + Math.cos(angle) * 120, y: 115 + Math.sin(angle) * 85 }];
      }));
      for (const edge of surface.edges) {
        const from = coordinates.get(edge.from), to = coordinates.get(edge.to);
        if (!from || !to) continue;
        const line = doc.createElementNS(namespace, "line");
        const distance = Math.hypot(to.x - from.x, to.y - from.y);
        const inset = Math.min(9, distance / 2);
        line.setAttribute("x1", String(from.x)); line.setAttribute("y1", String(from.y));
        line.setAttribute("x2", String(to.x - (to.x - from.x) * inset / distance));
        line.setAttribute("y2", String(to.y - (to.y - from.y) * inset / distance));
        line.setAttribute("marker-end", `url(#${arrowId})`);
        line.setAttribute("class", `notient-map-edge is-${edge.state}`);
        svg.append(line);
      }
      for (const node of visible) {
        const point = coordinates.get(node.path)!;
        const circle = doc.createElementNS(namespace, "circle");
        circle.setAttribute("cx", String(point.x)); circle.setAttribute("cy", String(point.y));
        circle.setAttribute("r", "5"); circle.classList.add("notient-map-node");
        const label = doc.createElementNS(namespace, "text");
        label.setAttribute("x", String(point.x)); label.setAttribute("y", String(point.y + 17));
        label.setAttribute("text-anchor", "middle");
        label.textContent = node.title.length > 19 ? `${node.title.slice(0, 18)}…` : node.title;
        const title = doc.createElementNS(namespace, "title"); title.textContent = node.path;
        circle.append(title); svg.append(circle, label);
      }
      target.append(svg);
    }
    if (surface.nodes.length > visible.length) {
      target.append(element("p", "notient-surface-qualification", `Diagram shows ${visible.length} of ${surface.nodes.length} returned notes.`));
    }
    const states = [...new Set(surface.edges.map((edge) => edge.state))];
    if (states.length) target.append(element("p", "notient-surface-qualification", states.map((state) =>
      `${surface.edges.filter((edge) => edge.state === state).length} ${state} connections`).join(" · ")));
    const details = element("details", "notient-map-connections");
    details.append(element("summary", "", `${surface.edges.length} returned connections`));
    let mounted = false;
    details.addEventListener("toggle", () => {
      if (!details.open || mounted) return;
      mounted = true;
      for (const edge of surface.edges) {
        const row = element("div", "notient-map-connection");
        const name = (path: string) => surface.nodes.find((node) => node.path === path)?.title ?? path;
        row.append(noteLink(edge.from, name(edge.from)));
        row.append(element("span", "notient-map-relation", `→ ${edge.relation.replace(/_/g, " ")} · ${edge.state} →`));
        row.append(noteLink(edge.to, name(edge.to)));
        details.append(row);
      }
    });
    target.append(details);
  };
  const render = (surface: NotientSurface, animate: boolean) => {
    const card = element("section", `notient-surface notient-surface-${surface.kind}`);
    card.dataset.surfaceId = surface.id;
    card.classList.toggle("is-arriving", animate);
    if (animate) (doc.defaultView ?? window).setTimeout(() => card.classList.remove("is-arriving"), 550);
    card.append(element("h4", "notient-surface-title", surface.title));
    if (surface.kind === "evidence") {
      if (!surface.items.length) card.append(element("p", "notient-surface-qualification", "No notes were returned for this search."));
      for (const item of surface.items.slice(0, 3)) card.append(passage(item));
      if (surface.items.length > 3) {
        const more = element("details", "notient-evidence-more");
        more.append(element("summary", "", `${surface.items.length - 3} more returned passages`));
        let mounted = false;
        more.addEventListener("toggle", () => {
          if (!more.open || mounted) return;
          mounted = true;
          for (const item of surface.items.slice(3)) more.append(passage(item));
        });
        card.append(more);
      }
    } else if (surface.kind === "places") {
      const details = element("details", "notient-surface-source");
      details.append(element("summary", "", `${surface.paths.length} returned notes`));
      let mounted = false;
      details.addEventListener("toggle", () => {
        if (!details.open || mounted) return;
        mounted = true;
        tree(details, surface);
      });
      card.append(details);
    }
    else map(card, surface);
    if (surface.kind !== "places" && surface.qualification) {
      card.append(element("p", "notient-surface-qualification", surface.qualification));
    }
    return card;
  };
  return {
    update(surfaces: readonly NotientSurface[], settings: { animate?: boolean } = {}) {
      const ids = new Set(surfaces.map((surface) => surface.id));
      for (const [id, record] of records) {
        if (!ids.has(id)) { record.element.remove(); records.delete(id); }
      }
      let previous: HTMLElement | null = null;
      for (const surface of surfaces) {
        const fingerprint = JSON.stringify(surface);
        let record = records.get(surface.id);
        if (!record || record.fingerprint !== fingerprint) {
          const next = render(surface, settings.animate === true && !record && doc.visibilityState === "visible" &&
            !(doc.defaultView ?? window).matchMedia("(prefers-reduced-motion: reduce)").matches);
          if (record) record.element.replaceWith(next);
          record = { element: next, fingerprint };
          records.set(surface.id, record);
        }
        const before: Element | null = previous ? previous.nextElementSibling : parent.firstElementChild;
        if (before !== record.element) parent.insertBefore(record.element, before);
        previous = record.element;
      }
    },
    dispose() { for (const record of records.values()) record.element.remove(); records.clear(); },
  };
}
