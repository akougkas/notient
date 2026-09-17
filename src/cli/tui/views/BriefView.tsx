import type { ScrollBoxRenderable } from "@opentui/core";
import { flushSync, useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import type { BriefResult } from "../../../api/brief";
import { briefLabels } from "../../../api/briefMarkdown";
import type { SourceReference } from "../../../api/schema";
import { briefNotes } from "../../commands/brief";
import { Markdown } from "../Markdown";
import { readingColumn } from "../layout";
import {
  COLOR,
  HORIZONTAL_SCROLLBAR_OPTIONS,
  VERTICAL_SCROLLBAR_OPTIONS,
  truncateMiddle,
} from "./theme";

export interface BriefSession {
  topic: string;
  mode: "topic" | "note";
  result: BriefResult | null;
}
export function BriefView(props: {
  session: BriefSession;
  initialPath: string;
  vaultPath: string;
  clientIdentity?: string;
  width: number;
  height: number;
  onClose: () => void;
  onExit: () => void;
  onSource: (source: SourceReference) => void;
}) {
  const { width, inset } = readingColumn(props.width);
  const [topic, setTopic] = useState(props.session.topic);
  const [mode, setMode] = useState(props.session.mode);
  const [result, setResult] = useState(props.session.result);
  const [message, setMessage] = useState(
    props.session.result
      ? briefStatus(props.session.result)
      : "The essentials, with the passages behind them.",
  );
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const request = useRef<AbortController | null>(null);
  const input = useRef({ topic, mode });
  const mounted = useRef(true);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    props.session.topic = topic;
    props.session.mode = mode;
    props.session.result = result;
  }, [topic, mode, result, props.session]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);
  const run = async () => {
    if (request.current) return;
    const { topic, mode } = input.current;
    if (mode === "topic" ? !topic.trim() : !props.initialPath) {
      setError(true);
      setMessage(
        mode === "topic"
          ? "Enter a topic to explore."
          : "Open a note first, or press Tab to brief on a topic.",
      );
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(false);
    setElapsed(0);
    setMessage("Reading current sources and preparing your brief…");
    const started = performance.now();
    const timer = setInterval(() => {
      if (mounted.current) setElapsed(Math.floor((performance.now() - started) / 1000));
    }, 1000);
    try {
      const answer = await briefNotes({
        vaultPath: props.vaultPath,
        clientIdentity: props.clientIdentity,
        ...(mode === "topic" ? { topic: topic.trim() } : { filePath: props.initialPath }),
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (mounted.current) {
        setResult(answer);
        setMessage(briefStatus(answer));
      }
    } catch (reason) {
      if (mounted.current) {
        setError(!controller.signal.aborted);
        setMessage(
          controller.signal.aborted
            ? "Stopped. Your notes are unchanged."
            : reason instanceof Error
              ? reason.message
              : String(reason),
        );
      }
    } finally {
      clearInterval(timer);
      request.current = null;
      if (mounted.current) setBusy(false);
    }
  };
  const statements = result
    ? [
        ...(result.summary ? [{ ...result.summary, label: "Overview" }] : []),
        ...result.findings.map((finding) => ({ ...finding, label: briefLabels[finding.kind] })),
      ]
    : [];
  const evidence = statements.flatMap((statement) => statement.evidence);
  useKeyboard((key) =>
    flushSync(() => {
      if (key.ctrl && key.name === "c") {
        request.current?.abort();
        props.onExit();
        return;
      }
      if (!["press", "repeat"].includes(key.eventType)) return;
      if (key.name === "escape") {
        key.preventDefault();
        if (busy) request.current?.abort();
        else if (result) setResult(null);
        else props.onClose();
        return;
      }
      if (busy) return;
      if (result) {
        if (["down", "j", "pagedown"].includes(key.name))
          scroll.current?.scrollBy(key.name === "pagedown" ? 10 : 1);
        else if (["up", "k", "pageup"].includes(key.name))
          scroll.current?.scrollBy(key.name === "pageup" ? -10 : -1);
        else if (/^[1-8]$/.test(key.sequence)) {
          const source = evidence[Number(key.sequence) - 1];
          if (source) props.onSource(source);
        }
        return;
      }
      if (key.name === "tab") {
        key.preventDefault();
        const next = input.current.mode === "topic" ? "note" : "topic";
        input.current.mode = next;
        setMode(next);
      } else if (
        key.eventType === "press" &&
        (key.name === "return" || (key.ctrl && key.name === "r"))
      ) {
        key.preventDefault();
        void run();
      }
    }),
  );
  let number = 0;
  return (
    <box
      width={props.width}
      height={props.height}
      paddingLeft={inset}
      paddingRight={inset}
      flexDirection="column"
      backgroundColor={COLOR.bg}
    >
      <text height={3} paddingTop={1} flexShrink={0} fg={COLOR.accent}>
        <b>A little clarity</b>
      </text>
      <text
        height={2}
        flexShrink={0}
        width={width}
        wrapMode="word"
        fg={error ? COLOR.bad : COLOR.dim}
      >
        {message}
        {busy ? ` ${elapsed}s · Esc stops` : ""}
      </text>
      {result ? (
        <scrollbox
          ref={scroll}
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          width={width}
          verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
          horizontalScrollbarOptions={HORIZONTAL_SCROLLBAR_OPTIONS}
        >
          <Markdown text={`## ${result.topic}`} />
          {result.abstained && <Markdown text={result.reason ?? "Insufficient evidence."} />}
          {result.coverage.state !== "current" && (
            <Markdown
              text={`**Retrieval coverage:** ${result.coverage.message ?? "Incomplete index."}`}
            />
          )}
          {statements.map((statement, index) => (
            <box key={index} flexDirection="column" marginBottom={1}>
              <text height={1} fg={COLOR.accent}>
                <b>{statement.label}</b>
              </text>
              <Markdown text={statement.text} />
              {statement.evidence.map((source, index) => (
                <box key={index} flexDirection="column" marginTop={1}>
                  <text fg={COLOR.accent} onMouseUp={() => props.onSource(source)}>
                    [{++number}] {truncateMiddle(source.path, width - 12)} · L
                    {source.range.startLine}
                  </text>
                  <Markdown
                    text={source.quote
                      .split("\n")
                      .map((line) => `> ${line}`)
                      .join("\n")}
                  />
                </box>
              ))}
            </box>
          ))}
          {!!result.limitations.length && (
            <Markdown
              text={`### Limits of this brief\n\n${result.limitations.map((line) => `- ${line}`).join("\n")}`}
            />
          )}
        </scrollbox>
      ) : (
        <box flexGrow={1} minHeight={0} flexDirection="column">
          <text height={2} flexShrink={0} fg={COLOR.accent}>
            {mode === "topic" ? "Topic" : "Current saved note"} · Tab to switch
          </text>
          {mode === "topic" ? (
            <input
              width={width}
              value={topic}
              focused={!busy}
              onInput={(value) =>
                flushSync(() => {
                  input.current.topic = value;
                  setTopic(value);
                })
              }
              placeholder="What would you like to get up to speed on?"
              backgroundColor={COLOR.bg}
              focusedBackgroundColor={COLOR.panel}
              textColor={COLOR.text}
            />
          ) : (
            <text height={3} wrapMode="word" fg={COLOR.text}>
              {props.initialPath || "Open a note first, or switch to a topic."}
            </text>
          )}
          <text height={3} marginTop={1} wrapMode="word" fg={COLOR.dim}>
            A short overview, useful findings, and exact source passages. Saved notes only; unsaved
            editor changes stay in your editor.
          </text>
          <box flexGrow={1} />
          <text
            height={2}
            flexShrink={0}
            fg={COLOR.accent}
            onMouseUp={() => {
              if (busy) request.current?.abort();
              else void run();
            }}
          >
            {busy ? "Stop briefing" : "Prepare brief · Enter"}
          </text>
        </box>
      )}
      <text height={2} paddingTop={1} flexShrink={0} fg={COLOR.dim}>
        {result
          ? "j/k scroll · 1–8 open evidence · click any source · Esc new brief"
          : "Tab topic / note · Enter run · Esc back"}
      </text>
    </box>
  );
}

function briefStatus(result: BriefResult): string {
  return result.abstained
    ? (result.reason ?? "Insufficient evidence.")
    : `${result.sources.length} ${result.sources.length === 1 ? "source" : "sources"} checked · ${(result.durationMs / 1000).toFixed(1)}s`;
}
