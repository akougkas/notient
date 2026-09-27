export type PresenceState = "idle" | "waiting" | "reading" | "responding" | "review" | "error";
export type PresenceLayout = "center" | "dock";

export interface PresenceUpdate {
  state: PresenceState;
  label: string;
  detail?: string;
}

export interface PresenceOptions {
  welcome?: boolean;
  layout?: PresenceLayout;
  motionAllowed?: () => boolean;
}

export function createPresence(parent: HTMLElement, options: PresenceOptions = {}) {
  const document = parent.ownerDocument;
  const view = document.defaultView ?? window;
  const reducedMotion = view.matchMedia("(prefers-reduced-motion: reduce)");
  const element = document.createElement("div");
  element.className = `notient-presence${options.welcome ? " is-welcome" : ""}`;
  element.dataset.state = "idle";
  element.dataset.layout = options.layout ?? "center";
  element.dataset.visible = "false";
  const orb = document.createElement("span");
  orb.className = "notient-orb";
  orb.setAttribute("aria-hidden", "true");
  for (const layer of ["halo", "shell", "tide", "seed"]) {
    const child = document.createElement("span");
    child.className = `notient-orb-${layer}`;
    orb.append(child);
  }
  const copy = document.createElement("span");
  copy.className = "notient-presence-copy";
  copy.setAttribute("role", "status");
  copy.setAttribute("aria-live", "polite");
  copy.setAttribute("aria-atomic", "true");
  const label = document.createElement("span");
  label.className = "notient-presence-label";
  const detail = document.createElement("span");
  detail.className = "notient-presence-detail";
  detail.hidden = true;
  copy.append(label, detail);
  const extra = document.createElement("div");
  extra.className = "notient-presence-extra";
  element.append(orb, copy, extra);
  parent.append(element);

  let intersecting = false;
  let disposed = false;
  let moving: Animation | null = null;
  const motionAllowed = () =>
    !disposed &&
    !reducedMotion.matches &&
    document.visibilityState === "visible" &&
    (options.motionAllowed?.() ?? !element.closest('[data-motion="paused"]'));
  const updateVisibility = () => {
    element.dataset.visible = String(!disposed && intersecting && document.visibilityState === "visible");
    if (document.visibilityState !== "visible") moving?.finish();
  };
  const observer = new view.IntersectionObserver((entries) => {
    intersecting = entries.some((entry) => entry.isIntersecting);
    updateVisibility();
  });
  observer.observe(element);
  document.addEventListener("visibilitychange", updateVisibility);

  return {
    extra,
    update(value: PresenceUpdate) {
      if (disposed) return;
      if (element.dataset.state !== value.state) element.dataset.state = value.state;
      copy.classList.toggle("notient-sr-only", value.state !== "review" && value.state !== "error");
      if (label.textContent !== value.label) label.textContent = value.label;
      const nextDetail = value.detail ?? "";
      if (detail.textContent !== nextDetail) detail.textContent = nextDetail;
      detail.hidden = !nextDetail;
      copy.hidden = !value.label && !nextDetail;
    },
    get layoutState(): PresenceLayout {
      return element.dataset.layout === "dock" ? "dock" : "center";
    },
    layout(next: PresenceLayout, apply: () => void = () => {}, allowMotion = true) {
      if (disposed) return;
      if (element.dataset.layout === next) {
        apply();
        return;
      }
      const animate = allowMotion && motionAllowed() && typeof orb.animate === "function";
      moving?.cancel();
      moving = null;
      const before = animate ? orb.getBoundingClientRect() : null;
      element.dataset.layout = next;
      apply();
      if (!before || !before.width) return;
      const after = orb.getBoundingClientRect();
      if (!after.width) return;
      const dx = before.left + before.width / 2 - (after.left + after.width / 2);
      const dy = before.top + before.height / 2 - (after.top + after.height / 2);
      const scale = before.width / after.width;
      moving = orb.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
          { transform: "translate(0, 0) scale(1)" },
        ],
        { duration: 480, easing: "cubic-bezier(.22, .8, .24, 1)" },
      );
      moving.onfinish = () => {
        moving = null;
      };
      if (typeof copy.animate === "function")
        copy.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 180, easing: "ease-out", fill: "backwards" });
    },
    dispose() {
      disposed = true;
      moving?.cancel();
      observer.disconnect();
      document.removeEventListener("visibilitychange", updateVisibility);
      updateVisibility();
      element.remove();
    },
  };
}
