import type { Database } from "../db/database";
import type { EventBus } from "../events/eventBus";
import type { LLMProvider } from "../llm/provider";
import { buildVoiceContext } from "./voiceContext";

export interface CoAuthorNeighbor {
  path: string;
  title: string;
  summary: string;
}

export interface CoAuthorOptions {
  db: Database;
  bus: EventBus;
  provider: LLMProvider;
  reasoningModel: string;
  readNote: (path: string, signal: AbortSignal) => Promise<string>;
  neighbors: (path: string) => CoAuthorNeighbor[];
  minWords: number;
  voiceMax?: number;
}

type Section = "summary" | "implies" | "connects";

const SECTION_HEADERS: Record<Section, RegExp> = {
  summary: /^[ \t]*#{2,3}[ \t]+SUMMARY\b[^\r\n]*(?:\r?\n|$)/im,
  implies: /^[ \t]*#{2,3}[ \t]+IMPLIES\b[^\r\n]*(?:\r?\n|$)/im,
  connects: /^[ \t]*#{2,3}[ \t]+CONNECTS\b[^\r\n]*(?:\r?\n|$)/im,
};

interface StreamState {
  currentSection: Section | null;
  pending: string;
}

export class CoAuthorService {
  constructor(private readonly opts: CoAuthorOptions) {}

  async runFor(notePath: string, signal: AbortSignal): Promise<void> {
    const start = Date.now();
    debugCoAuthor("run:start", { notePath, model: this.opts.reasoningModel });
    const noteBody = await this.opts.readNote(notePath, signal);
    if (signal.aborted) {
      debugCoAuthor("run:cancelled-after-read", { notePath });
      this.opts.bus.emit({ type: "coAuthor:cancelled", notePath });
      return;
    }
    const indexedWordCount =
      this.opts.db.query<{ word_count: number }>("SELECT word_count FROM notes WHERE path = ?;", [
        notePath,
      ])[0]?.word_count ?? 0;
    const wordCount = Math.max(indexedWordCount, countWords(stripFrontmatter(noteBody)));
    if (wordCount < this.opts.minWords) {
      const error = `Note is below Co-author minimum (${wordCount}/${this.opts.minWords} words).`;
      debugCoAuthor("run:skip-short-note", { notePath, wordCount, minWords: this.opts.minWords });
      this.opts.bus.emit({
        type: "coAuthor:done",
        notePath,
        ok: false,
        durationMs: Date.now() - start,
        error,
      });
      return;
    }
    const messages = this.buildMessages(notePath, noteBody);
    debugCoAuthor("run:messages-built", {
      notePath,
      wordCount,
      neighborCount: this.opts.neighbors(notePath).length,
    });
    await this.streamSections(notePath, messages, signal, start);
  }

  private buildMessages(notePath: string, noteBody: string) {
    const neighbors = this.opts.neighbors(notePath);
    const voice = buildVoiceContext(this.opts.db, {
      excludePath: notePath,
      max: this.opts.voiceMax ?? 3,
      snippetChars: 240,
    });
    return [
      {
        role: "system" as const,
        content:
          "You are the user's research chief of staff. Match the user's voice, shown in <voice/> snippets. Output exactly three labelled markdown sections in this order: ## SUMMARY (1-2 sentences), ## IMPLIES (1-3 bullet inferences), ## CONNECTS (3-5 [[wikilink]] suggestions with one-line reasons). Cite [[notes]] for every claim. Never invent a note path that is not in <neighbors/>.",
      },
      {
        role: "user" as const,
        content: JSON.stringify({
          voice: voice.snippets,
          activeNote: { path: notePath, body: noteBody.slice(0, 6000) },
          neighbors,
        }),
      },
    ];
  }

  private async streamSections(
    notePath: string,
    messages: ReturnType<CoAuthorService["buildMessages"]>,
    signal: AbortSignal,
    start: number,
  ): Promise<void> {
    const state: StreamState = { currentSection: null, pending: "" };
    let sawFirstDelta = false;
    try {
      for await (const delta of this.opts.provider.chatStream(messages, {
        model: this.opts.reasoningModel,
        temperature: 0.4,
        signal,
        maxTokens: 1200,
      })) {
        if (!sawFirstDelta) {
          sawFirstDelta = true;
          debugCoAuthor("stream:first-delta", { notePath, chars: delta.length });
        }
        if (signal.aborted) {
          debugCoAuthor("stream:cancelled-after-delta", { notePath });
          this.opts.bus.emit({ type: "coAuthor:cancelled", notePath });
          return;
        }
        this.consumeDelta(notePath, state, delta);
      }
      this.flush(notePath, state);
    } catch (error) {
      if (signal.aborted) {
        debugCoAuthor("stream:cancelled-error", { notePath });
        this.opts.bus.emit({ type: "coAuthor:cancelled", notePath });
        return;
      }
      debugCoAuthor("stream:error", { notePath, error: (error as Error).message });
      this.opts.bus.emit({
        type: "coAuthor:done",
        notePath,
        ok: false,
        durationMs: Date.now() - start,
        error: (error as Error).message,
      });
      return;
    }
    debugCoAuthor("stream:done", { notePath, durationMs: Date.now() - start });
    this.opts.bus.emit({
      type: "coAuthor:done",
      notePath,
      ok: true,
      durationMs: Date.now() - start,
    });
  }

  private consumeDelta(notePath: string, state: StreamState, delta: string): void {
    state.pending += delta;
    for (;;) {
      const next = findNextHeader(state.pending);
      if (!next) break;
      if (state.currentSection && next.before.length > 0) {
        debugCoAuthor("section:delta", {
          notePath,
          section: state.currentSection,
          chars: next.before.length,
        });
        this.opts.bus.emit({
          type: "coAuthor:section",
          notePath,
          section: state.currentSection,
          delta: next.before,
        });
      }
      state.currentSection = next.section;
      debugCoAuthor("section:start", { notePath, section: next.section });
      state.pending = next.after;
    }
    if (state.currentSection && state.pending.length > 0 && !containsAnyHeader(state.pending)) {
      debugCoAuthor("section:delta", {
        notePath,
        section: state.currentSection,
        chars: state.pending.length,
      });
      this.opts.bus.emit({
        type: "coAuthor:section",
        notePath,
        section: state.currentSection,
        delta: state.pending,
      });
      state.pending = "";
    }
  }

  private flush(notePath: string, state: StreamState): void {
    if (state.currentSection && state.pending.length > 0) {
      debugCoAuthor("section:flush", {
        notePath,
        section: state.currentSection,
        chars: state.pending.length,
      });
      this.opts.bus.emit({
        type: "coAuthor:section",
        notePath,
        section: state.currentSection,
        delta: state.pending,
      });
      state.pending = "";
    }
  }
}

const FENCE = "---";

function stripFrontmatter(content: string): string {
  if (!content.startsWith(FENCE)) return content;
  const closeIdx = content.indexOf(`\n${FENCE}`, FENCE.length);
  if (closeIdx === -1) return content;
  const after = closeIdx + 1 + FENCE.length;
  return content.slice(after).replace(/^\r?\n/, "");
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function containsAnyHeader(text: string): boolean {
  return Object.values(SECTION_HEADERS).some((rx) => rx.test(text));
}

function findNextHeader(text: string): { before: string; section: Section; after: string } | null {
  let earliest: { idx: number; matchLen: number; section: Section } | null = null;
  for (const section of Object.keys(SECTION_HEADERS) as Section[]) {
    const match = text.match(SECTION_HEADERS[section]);
    if (match && match.index !== undefined) {
      if (!earliest || match.index < earliest.idx) {
        earliest = { idx: match.index, matchLen: match[0].length, section };
      }
    }
  }
  if (!earliest) return null;
  return {
    before: text.slice(0, earliest.idx),
    section: earliest.section,
    after: text.slice(earliest.idx + earliest.matchLen),
  };
}

function debugCoAuthor(message: string, data?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  console.log(`[Notient][CoAuthor] ${message}`, data ?? {});
}
