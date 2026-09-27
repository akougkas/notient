import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { MethodologySuggestionResult } from "../../../api/methodology";
import type { MethodologySettings } from "../../../api/cultivationSettings";
import type { NoteReference, SourceReference } from "../../../api/schema";
import { Markdown } from "../Markdown";
import {
  prepareConventionDraft,
  type ConventionDraft,
} from "../methodologyConvention";
import type { NotientRpc } from "../rpc";
import { readingColumn } from "../layout";
import { COLOR } from "./theme";

export interface MethodologySession {
  path: string;
  result: MethodologySuggestionResult | null;
  pending: Promise<void> | null;
  message: string;
  request?: { path: string; revision: string; configurationRevision: string; idempotencyKey: string };
  studyMethodology?: MethodologySettings | null;
  scroll?: number;
}

export function MethodologyView(props: {
  session: MethodologySession;
  initialPath: string;
  rpc: () => NotientRpc;
  width: number;
  height: number;
  onClose: () => void;
  onReview: () => void;
  onUseConvention?: (draft: ConventionDraft) => void;
  onSource: (source: SourceReference) => void;
  onExaminedSource?: (source: NoteReference) => void;
}) {
  const { width, inset } = readingColumn(props.width);
  const [, render] = useState(0);
  const mounted = useRef(true);
  const session = props.session;
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const rememberScroll = () => {
    session.scroll = Math.max(0, scroll.current?.scrollTop ?? 0);
  };
  if (!session.path && props.initialPath) {
    session.path = props.initialPath;
    session.result = null;
    session.studyMethodology = undefined;
    session.message =
      "Enter studies this saved note's organization and conventions with current examples. Changes remain pending review.";
  }
  const refresh = () => {
    if (mounted.current) render((value) => value + 1);
  };
  useEffect(() => {
    mounted.current = true;
    void session.pending?.then(refresh);
    return () => {
      mounted.current = false;
      rememberScroll();
    };
  }, [session.pending]);
  useEffect(() => {
    scroll.current?.scrollTo(session.scroll ?? 0);
  }, [session.result]);
  const run = () => {
    if (session.pending || !session.path) return;
    session.result = null;
    session.scroll = 0;
    scroll.current?.scrollTo(0);
    session.message =
      "Studying organization and recurring conventions. Reading and conversation remain available with Esc.";
    session.pending = (async () => {
      try {
        const [note, settings] = await Promise.all([
          props.rpc().noteBody(session.path),
          props.rpc().cultivationSettings(),
        ]);
        if (
          session.request?.path !== note.note.path ||
          session.request.revision !== note.note.revision ||
          session.request.configurationRevision !== settings.revision
        )
          session.request = {
            path: note.note.path,
            revision: note.note.revision,
            configurationRevision: settings.revision,
            idempotencyKey: crypto.randomUUID(),
          };
        const result = await props.rpc().suggestMethodology({
          source: note.note,
          candidateLimit: 5,
          idempotencyKey: session.request.idempotencyKey,
        });
        session.result = result;
        const afterSettings = await props.rpc().cultivationSettings();
        if (
          JSON.stringify(afterSettings.methodology) !== JSON.stringify(settings.methodology)
        ) {
          session.studyMethodology = null;
          session.message =
            "Study completed, but saved methodology changed while it was running. Review the result, then run a fresh study before using its convention.";
          return;
        }
        session.studyMethodology = structuredClone(settings.methodology);
        session.message =
          result.status === "no-suggestion"
            ? "This study did not recommend a methodology change. Review its observations and limitations below."
            : `Suggestion ${result.proposal.state}. Press v to inspect its exact changes before deciding.`;
      } catch (error) {
        session.message = error instanceof Error ? error.message : String(error);
      } finally {
        session.pending = null;
        refresh();
      }
    })();
    refresh();
  };
  const useConvention = () => {
    const result = session.result;
    if (session.pending || result?.status !== "convention-suggestion" || !props.onUseConvention)
      return;
    session.message = "Checking the reviewed suggestion before preparing a settings change.";
    session.pending = (async () => {
      try {
        if (!session.studyMethodology)
          throw new Error(
            "This study does not have a current methodology snapshot. Run a fresh methodology study before using its convention.",
          );
        const draft = await prepareConventionDraft(
          props.rpc(),
          result,
          session.studyMethodology,
        );
        const { proposal } = await props.rpc().review(result.proposal.id);
        session.result = { ...result, proposal };
        session.message =
          "The approved convention is ready in a settings draft. Review and save it there to activate the guidance.";
        props.onUseConvention?.(draft);
      } catch (error) {
        session.message = error instanceof Error ? error.message : String(error);
      } finally {
        session.pending = null;
        refresh();
      }
    })();
    refresh();
  };
  useKeyboard((key) => {
    if (!["press", "repeat"].includes(key.eventType) || key.ctrl || key.meta) return;
    if (["up", "k", "down", "j", "pageup", "pagedown"].includes(key.name)) {
      const amount = key.name.startsWith("page") ? Math.max(1, props.height - 10) : 3;
      scroll.current?.scrollBy(["up", "k", "pageup"].includes(key.name) ? -amount : amount);
      rememberScroll();
      key.preventDefault();
      return;
    }
    if (key.eventType === "repeat") return;
    rememberScroll();
    if (key.name === "escape") {
      mounted.current = false;
      props.onClose();
    } else if (key.name === "return") run();
    else if (key.name === "v" && (session.result?.proposal || session.request)) props.onReview();
    else if (key.name === "c") useConvention();
    else if (/^f[1-7]$/.test(key.name) && session.result && props.onExaminedSource) {
      const source = session.result.examinedSources[Number(key.name.slice(1)) - 1];
      if (source) props.onExaminedSource(source);
    }
    else if (/^[1-6]$/.test(key.name) && session.result && "evidence" in session.result) {
      const source = session.result.evidence[Number(key.name) - 1];
      if (source) props.onSource(source);
    }
    key.preventDefault();
  });
  const result = session.result;
  return (
    <box
      width={props.width}
      height={props.height}
      paddingLeft={inset}
      paddingRight={inset}
      flexDirection="column"
    >
      <text fg={COLOR.accent} height={2}>
        Methodology suggestions
      </text>
      <text fg={COLOR.bright} height={2}>
        {session.path || "Open a note before requesting a methodology suggestion."}
      </text>
      <text fg={COLOR.dim} width={width} height={3} wrapMode="word">
        {session.message}
      </text>
      <scrollbox ref={scroll} width={width} flexGrow={1} minHeight={0}>
        <box flexDirection="column" gap={1}>
          {result ? (
            <>
              <text fg={COLOR.label}>{result.methodology}</text>
              <Markdown
                text={result.status === "no-suggestion" ? result.reason : result.rationale}
              />
              {result.examinedSources.length ? (
                <box flexDirection="column" gap={1}>
                  <text fg={COLOR.label}>Notes read for this study</text>
                  {result.examinedSources.map((note, index) => (
                    <text key={note.path} fg={COLOR.dim} wrapMode="word">
                      {props.onExaminedSource ? `F${index + 1} · ` : ""}{note.path} · {note.revision.slice(0, 12)}
                    </text>
                  ))}
                </box>
              ) : null}
              {result.status === "proposal-created" ? (
                <text fg={COLOR.accent}>
                  Proposed destination: {result.destination} · role: {result.role}
                </text>
              ) : null}
              {result.status === "convention-suggestion" ? (
                <>
                  <Markdown text={result.conventionSuggestion.text} />
                  <text fg={COLOR.dim}>
                    Review retains this suggestion on the note. Press c after approval to review
                    using it in your configured conventions.
                  </text>
                </>
              ) : null}
              {result.evidence.length ? <text fg={COLOR.label}>Cited passages</text> : null}
              {result.evidence.map((source, index) => (
                <box key={`${source.path}:${index}`} flexDirection="column">
                  <text fg={COLOR.label}>
                    {index + 1} · {source.path} · line {source.range.startLine}
                  </text>
                  <Markdown
                    text={source.quote
                      .split(/\r?\n/u)
                      .map((line) => `> ${line}`)
                      .join("\n")}
                  />
                </box>
              ))}
            </>
          ) : null}
        </box>
      </scrollbox>
      <text fg={COLOR.dim} height={3}>
        {session.pending
          ? "Esc return · request continues"
          : `Enter study · ↑/↓ scroll · v review${result?.status === "convention-suggestion" && props.onUseConvention ? " · c use convention" : ""} · 1–6 passage${result?.examinedSources.length && props.onExaminedSource ? ` · F1–F${result.examinedSources.length} studied note` : ""} · Esc return`}
      </text>
    </box>
  );
}
