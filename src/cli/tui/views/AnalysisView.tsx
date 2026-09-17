import type { ScrollBoxRenderable } from "@opentui/core";
import { flushSync, useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import type { ComparisonResult } from "../../../api/comparison";
import { comparisonLabels } from "../../../api/comparisonMarkdown";
import type { SourceReference } from "../../../api/schema";
import { analyzePaths } from "../../commands/analysis";
import { Markdown } from "../Markdown";
import { readingColumn } from "../layout";
import type { NotientRpc } from "../rpc";
import {
  COLOR,
  HORIZONTAL_SCROLLBAR_OPTIONS,
  VERTICAL_SCROLLBAR_OPTIONS,
  truncateMiddle,
} from "./theme";

export interface AnalysisSession {
  paths: string[];
  question: string;
  result: ComparisonResult | null;
}

export function AnalysisView(props: {
  session?: AnalysisSession;
  kind: "compare" | "correlate";
  initialPath: string;
  vaultPath: string;
  clientIdentity?: string;
  rpc: () => NotientRpc;
  width: number;
  height: number;
  onClose: () => void;
  onExit: () => void;
  onSource: (source: SourceReference) => void;
}) {
  const { width, inset } = readingColumn(props.width);
  const [paths, setPaths] = useState(
    props.session?.paths.length ? props.session.paths : [props.initialPath, ""],
  );
  const [question, setQuestion] = useState(props.session?.question ?? "");
  const [field, setField] = useState(props.initialPath && props.kind === "compare" ? 1 : 0);
  const [matches, setMatches] = useState<string[]>([]);
  const [finding, setFinding] = useState(false);
  const [selected, setSelected] = useState(0);
  const [result, setResult] = useState<ComparisonResult | null>(props.session?.result ?? null);
  const [message, setMessage] = useState(
    props.session?.result
      ? analysisStatus(props.session.result)
      : "Choose saved notes. Quotations will show what supports each judgment.",
  );
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // Terminal keys can arrive in one input batch before hook listeners refresh.
  // Keep the selection used for Enter/Run synchronous with every keystroke.
  const input = useRef({ paths, question, field, selected, matches });
  input.current = { paths, question, field, selected, matches };
  const selectField = (next: number) => {
    input.current.field = next;
    setField(next);
  };
  const editPath = (index: number, value: string) => {
    const next = input.current.paths.map((old, i) => (i === index ? value : old));
    input.current.paths = next;
    setPaths(next);
  };
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const rpc = useRef(props.rpc);
  rpc.current = props.rpc;
  const fields = props.kind === "compare" ? 3 : 1;
  const query = paths[field] ?? "";
  useEffect(() => {
    if (props.session) {
      props.session.paths = paths;
      props.session.question = question;
      props.session.result = result;
    }
  }, [paths, question, result, props.session]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (field >= 2 || busy || result) {
      setMatches([]);
      setFinding(false);
      return;
    }
    let stale = false;
    setFinding(true);
    const timer = setTimeout(() => {
      void rpc
        .current()
        .listNotes(query.length > 256 ? (query.split("/").at(-1)?.slice(0, 256) ?? "") : query, 6)
        .then((page) => {
          if (stale) return;
          setFinding(false);
          setMatches(
            page.notes
              .map((note) => note.path)
              .filter((path) => props.kind !== "compare" || path !== paths[1 - field]),
          );
          setSelected(0);
        })
        .catch((reason) => {
          if (!stale) {
            setFinding(false);
            setError(true);
            setMessage(String(reason));
          }
        });
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, field, busy, result, paths, props.kind]);
  const choose = (path: string) => {
    if (request.current) return;
    const field = input.current.field;
    editPath(field, path);
    selectField(Math.min(fields - 1, field + 1));
  };
  const run = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setResult(null);
    setError(false);
    setElapsed(0);
    setMessage("Reading saved revisions and comparing their evidence…");
    const started = performance.now();
    const timer = setInterval(() => {
      if (mounted.current) setElapsed(Math.floor((performance.now() - started) / 1000));
    }, 1000);
    try {
      const answer = await analyzePaths({
        kind: props.kind,
        vaultPath: props.vaultPath,
        clientIdentity: props.clientIdentity,
        paths: props.kind === "compare" ? input.current.paths : [input.current.paths[0]],
        question: input.current.question.trim() || undefined,
        signal: controller.signal,
      });
      if (!mounted.current) return;
      setResult(answer);
      setMessage(analysisStatus(answer));
      scroll.current?.scrollTo(0);
    } catch (reason) {
      if (!mounted.current) return;
      setError(!controller.signal.aborted);
      setMessage(
        controller.signal.aborted
          ? "Stopped. Your notes are unchanged."
          : reason instanceof Error
            ? reason.message
            : String(reason),
      );
    } finally {
      clearInterval(timer);
      request.current = null;
      if (mounted.current) setBusy(false);
    }
  };
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
          const source = result.comparisons.flatMap((item) => item.evidence)[
            Number(key.sequence) - 1
          ];
          if (source) props.onSource(source);
        }
        return;
      }
      const { field, selected, matches } = input.current;
      if (key.ctrl && ["return", "r"].includes(key.name)) {
        key.preventDefault();
        if (key.eventType === "press") void run();
      } else if (key.name === "tab") {
        key.preventDefault();
        selectField((field + (key.shift ? fields - 1 : 1)) % fields);
      } else if (field < 2 && ["down", "up"].includes(key.name)) {
        key.preventDefault();
        const next = Math.max(
          0,
          Math.min(matches.length - 1, selected + (key.name === "down" ? 1 : -1)),
        );
        input.current.selected = next;
        setSelected(next);
      } else if (key.name === "return" && field < 2 && matches[selected]) {
        key.preventDefault();
        choose(matches[selected]);
      }
    }),
  );
  let evidenceIndex = 0;
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
        <b>{props.kind === "compare" ? "Think across your notes" : "Find a useful connection"}</b>
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
          {result.coverage && result.coverage.state !== "current" && (
            <Markdown text={`**Retrieval coverage:** ${result.coverage.message}`} />
          )}
          {result.comparisons.map((item, index) => (
            <box key={index} flexDirection="column" marginBottom={1}>
              <text height={1} fg={COLOR.accent}>
                <b>{comparisonLabels[item.judgment]}</b>
              </text>
              <text height={2} fg={COLOR.dim} wrapMode="word">
                {item.source.path} → {item.target.path}
              </text>
              <Markdown text={item.explanation} />
              {item.evidence.map((source, quoteIndex) => {
                const number = ++evidenceIndex;
                return (
                  <box key={quoteIndex} flexDirection="column" marginTop={1}>
                    <text fg={COLOR.accent} onMouseUp={() => props.onSource(source)}>
                      [{number}] {truncateMiddle(source.path, width - 12)} · L
                      {source.range.startLine}
                    </text>
                    <Markdown
                      text={source.quote
                        .split("\n")
                        .map((line) => `> ${line}`)
                        .join("\n")}
                    />
                  </box>
                );
              })}
            </box>
          ))}
          {result.limitations.length > 0 && (
            <Markdown
              text={`### Limits of this comparison\n\n${result.limitations.map((line) => `- ${line}`).join("\n")}`}
            />
          )}
        </scrollbox>
      ) : (
        <box flexGrow={1} minHeight={0} flexDirection="column">
          {(props.kind === "compare" ? paths : paths.slice(0, 1)).map((path, index) => (
            <box
              height={2}
              flexShrink={0}
              flexDirection="row"
              key={index}
              onMouseUp={() => selectField(index)}
            >
              <text width={12} fg={field === index ? COLOR.accent : COLOR.dim}>
                {index ? "With" : "Note"}
              </text>
              <input
                width={Math.max(1, width - 12)}
                value={path}
                focused={field === index && !busy}
                onInput={(value) => flushSync(() => editPath(index, value))}
                backgroundColor={COLOR.bg}
                focusedBackgroundColor={COLOR.panel}
                textColor={COLOR.text}
                placeholder="Find a note by name…"
              />
            </box>
          ))}
          {props.kind === "compare" && (
            <box height={2} flexShrink={0} flexDirection="row" onMouseUp={() => selectField(2)}>
              <text width={12} fg={field === 2 ? COLOR.accent : COLOR.dim}>
                Question
              </text>
              <input
                width={Math.max(1, width - 12)}
                value={question}
                focused={field === 2 && !busy}
                onInput={(value) =>
                  flushSync(() => {
                    input.current.question = value;
                    setQuestion(value);
                  })
                }
                backgroundColor={COLOR.bg}
                focusedBackgroundColor={COLOR.panel}
                textColor={COLOR.text}
                placeholder="Optional · what would you like to understand?"
              />
            </box>
          )}
          <scrollbox
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
            width={width}
            verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
            horizontalScrollbarOptions={HORIZONTAL_SCROLLBAR_OPTIONS}
          >
            {field < 2 && !busy && (finding || !matches.length) && (
              <text height={2} wrapMode="word" fg={COLOR.dim}>
                {finding
                  ? "Finding saved notes…"
                  : "No matching notes. Try another title or a vault-relative path."}
              </text>
            )}
            {matches.map((path, index) => (
              <text
                key={path}
                height={1}
                fg={index === selected ? COLOR.accent : COLOR.dim}
                onMouseUp={() => choose(path)}
              >
                {index === selected ? "› " : "  "}
                {truncateMiddle(path, width - 3)}
              </text>
            ))}
          </scrollbox>
          <text
            height={2}
            flexShrink={0}
            fg={COLOR.accent}
            onMouseUp={() => {
              if (busy) request.current?.abort();
              else void run();
            }}
          >
            {busy
              ? "Stop comparison"
              : props.kind === "compare"
                ? "Compare these notes · Ctrl+R"
                : "Find connections · Ctrl+R"}
          </text>
        </box>
      )}
      <text height={2} paddingTop={1} flexShrink={0} fg={COLOR.dim}>
        {result
          ? "j/k scroll · 1–8 open evidence · click any source · Esc edit selection"
          : "Tab fields · ↑↓ choose · Enter select · Ctrl+R run · Esc back"}
      </text>
    </box>
  );
}

function analysisStatus(result: ComparisonResult): string {
  return result.abstained
    ? (result.reason ?? "Evidence is insufficient.")
    : `${result.comparisons.length} ${result.comparisons.length === 1 ? "comparison" : "comparisons"} · ${result.sources.length} sources checked · ${(result.durationMs / 1000).toFixed(1)}s`;
}
