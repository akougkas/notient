import type { CultivationDigest, CultivationDigestItem } from "../../api/cultivation";
import type { AppState } from "./store";

export type ChromeTone = "ok" | "warn" | "dim" | "bad";

export interface CapabilitySegment {
  readonly text: string;
  readonly tone: ChromeTone;
}

export interface DevelopmentRow {
  readonly id: string;
  readonly text: string;
  readonly item: CultivationDigestItem | null;
}

const DISPOSITION_LABEL: Record<CultivationDigestItem["disposition"], string> = {
  applied: "retained on the note",
  "awaiting-review": "awaits your review",
  "report-only": "reported, nothing written",
  partial: "partly applied",
};

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

export function threadLine(state: AppState): string {
  const vault = state.vaultPath.split("/").filter(Boolean).pop() ?? state.vaultPath;
  const topic = state.ask.topic.trim();
  const thread =
    state.ask.resumed && topic
      ? `Resumed thread: ${shorten(topic, 48)}`
      : state.ask.conversationId !== null && topic
        ? `Thread: ${shorten(topic, 48)}`
        : "New thread";
  return `${vault} · ${thread} · Ctrl+O switch · Ctrl+N new`;
}

export function capabilitySegments(state: AppState, width: number): CapabilitySegment[] {
  if (!state.connection.connected)
    return [
      {
        text: "Workspace disconnected. Press any key to reconnect. Your draft is kept.",
        tone: "bad",
      },
    ];
  const segments: CapabilitySegment[] = [];
  const indexing = state.status?.indexing ?? null;
  if (indexing === null) segments.push({ text: "Checking your notes…", tone: "dim" });
  else if (indexing.state === "current")
    segments.push({ text: "Reading and search ready", tone: "ok" });
  else if (indexing.state === "failed")
    segments.push({
      text: `Search index needs attention. Reading and capture work`,
      tone: "warn",
    });
  else if (indexing.state === "paused")
    segments.push({ text: "Search indexing paused. Reading and capture work", tone: "warn" });
  else if (indexing.state === "unknown")
    segments.push({ text: "Reading ready, search coverage unknown", tone: "warn" });
  else
    segments.push({
      text: `Indexing ${indexing.current}/${indexing.total ?? "?"} notes. Search may be partial`,
      tone: "warn",
    });

  const probe = state.status?.probe ?? null;
  const model = shorten(probe?.configuredModel || state.ask.model || "model", 26);
  if (probe === null) segments.push({ text: "Model checking…", tone: "dim" });
  else if (probe.status === "ok") segments.push({ text: `Model ${model} ready`, tone: "ok" });
  else if (probe.status === "available")
    segments.push({ text: `Model ${model} listed`, tone: "dim" });
  else if (probe.status === "not-loaded")
    segments.push({
      text: `Model ${model} not loaded. Capture and search still work`,
      tone: "warn",
    });
  else if (probe.status === "unconfigured")
    segments.push({
      text: "No model set up (notient setup). Capture and search work",
      tone: "warn",
    });
  else if (probe.status === "mismatch")
    segments.push({ text: `Model ${model} differs from settings`, tone: "warn" });
  else
    segments.push({
      text: "Model unreachable. Capture, find and reading still work",
      tone: "warn",
    });

  const { digest, enabledPipelines } = state.developments;
  if (digest === null) segments.push({ text: "Cultivation status loading", tone: "dim" });
  else if (digest.paused)
    segments.push({ text: "Cultivation paused (/unpause resumes)", tone: "warn" });
  else if (digest.conditions.some((condition) => condition.id === "no-trigger"))
    segments.push({ text: "Cultivation has no active trigger", tone: "warn" });
  else if (digest.conditions.some((condition) => condition.id === "no-save-trigger"))
    segments.push({ text: "Saved notes wait for scheduled cultivation", tone: "dim" });
  else if ((enabledPipelines ?? 0) > 0)
    segments.push({
      text:
        width >= 110
          ? "Cultivation on within its budget, continues after you exit (/pause stops it)"
          : "Cultivation on (/pause)",
      tone: "ok",
    });
  else segments.push({ text: "Cultivation off (Ctrl+P, Preferences)", tone: "dim" });
  return segments;
}

export function developmentConditions(digest: CultivationDigest): string[] {
  return digest.conditions.map((condition) => condition.label);
}

export function capabilityRows(segments: ReadonlyArray<CapabilitySegment>, width: number): number {
  const length = segments.reduce((sum, segment) => sum + segment.text.length + 3, -3);
  return Math.min(2, Math.max(1, Math.ceil(length / Math.max(20, width - 1))));
}

export function developmentRowLimit(height: number): number {
  if (height >= 34) return 3;
  if (height >= 26) return 2;
  return height >= 18 ? 1 : 0;
}

export function buildDevelopmentsStrip(
  state: AppState,
  maxItems: number,
  width: number,
): { heading: string; rows: DevelopmentRow[] } {
  const { digest, error } = state.developments;
  if (digest === null)
    return {
      heading: error
        ? `Developments unavailable: ${shorten(error, Math.max(20, width - 26))}`
        : "Developments loading…",
      rows: [],
    };
  if (digest.items.length === 0) {
    const quiet = digest.quiet.slice(0, Math.max(0, maxItems));
    return {
      heading: `Developments: ${developmentConditions(digest)[0] ?? (quiet.length ? "recent work made no note change." : "nothing new worth surfacing right now.")}`,
      rows: quiet.map((result) => ({
        id: result.jobId,
        item: null,
        text: shorten(
          `${result.outcome === "failed" ? "Needs attention" : "No note change"} · ${result.pipeline} · ${result.reason}`,
          Math.max(20, width - 4),
        ),
      })),
    };
  }
  const visible = digest.items.slice(0, Math.max(0, maxItems));
  const hidden = digest.items.length - visible.length;
  return {
    heading: `Developments · ${digest.items.length}${hidden > 0 ? ` (Esc then d for all)` : ""}${digest.conditions.some((condition) => condition.level === "attention") ? " · needs attention" : ""}`,
    rows: visible.map((item) => ({
      id: item.id,
      item,
      text: shorten(
        `${item.origin?.trigger ? `${item.origin.trigger} · ` : ""}${item.title} · ${item.path} · ${DISPOSITION_LABEL[item.disposition]} · ${item.status}`,
        Math.max(20, width - 4),
      ),
    })),
  };
}

export function welcomeText(state: AppState): string {
  const sample = state.developments.samples[0];
  const stem = sample?.replace(/\.md$/i, "").split("/").pop();
  const lines = [
    "Your vault, in conversation.",
    "",
    `Ask          Type below and press Enter.${stem ? ` Try: What do my notes say about "${stem}"?` : ""}`,
    "Capture      Ctrl+B or Alt+C saves a thought in your own words before any model answers.",
    `Find a note  Alt+O, or /find <words>.${sample ? ` Your notes include ${state.developments.samples.slice(0, 2).join(" and ")}.` : ""}`,
    "",
    "Ctrl+P opens every action. /help lists them with their keys.",
  ];
  return lines.join("\n");
}
