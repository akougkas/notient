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
  summary: /##\s*SUMMARY/i,
  implies: /##\s*IMPLIES/i,
  connects: /##\s*CONNECTS/i,
};

interface StreamState {
  currentSection: Section | null;
  pending: string;
}

export class CoAuthorService {
  constructor(private readonly opts: CoAuthorOptions) {}

  async runFor(notePath: string, signal: AbortSignal): Promise<void> {
    const start = Date.now();
    const noteRow = this.opts.db.query<{ word_count: number }>(
      "SELECT word_count FROM notes WHERE path = ?;",
      [notePath],
    )[0];
    if (!noteRow || noteRow.word_count < this.opts.minWords) return;

    const noteBody = await this.opts.readNote(notePath, signal);
    if (signal.aborted) {
      this.opts.bus.emit({ type: "coAuthor:cancelled", notePath });
      return;
    }
    const messages = this.buildMessages(notePath, noteBody);
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
    try {
      for await (const delta of this.opts.provider.chatStream(messages, {
        model: this.opts.reasoningModel,
        temperature: 0.4,
        signal,
        maxTokens: 1200,
      })) {
        if (signal.aborted) {
          this.opts.bus.emit({ type: "coAuthor:cancelled", notePath });
          return;
        }
        this.consumeDelta(notePath, state, delta);
      }
      this.flush(notePath, state);
    } catch (error) {
      if (signal.aborted) {
        this.opts.bus.emit({ type: "coAuthor:cancelled", notePath });
        return;
      }
      this.opts.bus.emit({
        type: "coAuthor:done",
        notePath,
        ok: false,
        durationMs: Date.now() - start,
        error: (error as Error).message,
      });
      return;
    }
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
        this.opts.bus.emit({
          type: "coAuthor:section",
          notePath,
          section: state.currentSection,
          delta: next.before,
        });
      }
      state.currentSection = next.section;
      state.pending = next.after;
    }
    if (state.currentSection && state.pending.length > 0 && !containsAnyHeader(state.pending)) {
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
  const lineEnd = text.indexOf("\n", earliest.idx + earliest.matchLen);
  const consumeUntil = lineEnd === -1 ? text.length : lineEnd + 1;
  return {
    before: text.slice(0, earliest.idx),
    section: earliest.section,
    after: text.slice(consumeUntil),
  };
}
