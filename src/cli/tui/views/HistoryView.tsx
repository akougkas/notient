import type { ScrollBoxRenderable } from "@opentui/core";
import { flushSync, useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HistoryDetail, HistoryEntry } from "../../../api/history";
import { Markdown } from "../Markdown";
import { readingColumn } from "../layout";
import type { NotientRpc } from "../rpc";
import {
  COLOR,
  HORIZONTAL_SCROLLBAR_OPTIONS,
  VERTICAL_SCROLLBAR_OPTIONS,
  truncateMiddle,
} from "./theme";

export function HistoryView(props: {
  rpc: () => NotientRpc;
  width: number;
  height: number;
  onClose: () => void;
  onExit: () => void;
}) {
  const { width, inset } = readingColumn(props.width);
  const [rows, setRows] = useState<HistoryEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const [next, setNext] = useState<string | null>(null);
  const [pages, setPages] = useState<Array<string | undefined>>([undefined]);
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [before, setBefore] = useState(true);
  const [raw, setRaw] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Loading your changes…");
  const [error, setError] = useState(false);
  const flight = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const rpc = useRef(props.rpc);
  rpc.current = props.rpc;
  const run = useCallback(async (work: () => Promise<void>) => {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      if (mounted.current) {
        setError(true);
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  const load = useCallback(
    async (page?: string) =>
      run(async () => {
        const request = ++generation.current;
        const result = await rpc.current().historyList(30, page);
        if (request !== generation.current) return;
        setRows(result.entries);
        setNext(result.nextCursor);
        setCursor(0);
        setDetail(null);
        setConfirm(false);
        setError(false);
        setMessage(
          result.entries.length
            ? "Choose a change to inspect its exact saved versions."
            : "Your first saved thought will appear here.",
        );
        scroll.current?.scrollTo(0);
      }),
    [run],
  );
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    if (!detail) scroll.current?.scrollTo(Math.max(0, cursor * 3 - 3));
  }, [cursor, detail]);
  const inspect = (id: string) =>
    run(async () => {
      const request = ++generation.current;
      const result = await rpc.current().historyEntry(id);
      if (request !== generation.current) return;
      setDetail(result);
      setBefore(true);
      setRaw(false);
      setConfirm(false);
      setError(false);
      setMessage(
        result.entry.undo?.completedAt != null
          ? "Undone · the original change remains in your history."
          : result.entry.undo
            ? "An interrupted undo can be inspected and resumed with the same guarded operation."
            : "Compare the saved versions before choosing undo. Newer edits are protected.",
      );
      scroll.current?.scrollTo(0);
    });
  const undo = () =>
    run(async () => {
      if (!detail || !confirm) return;
      const request = ++generation.current;
      const result = await rpc.current().undoHistory({
        id: detail.entry.id,
        sources: detail.sources,
        idempotencyKey: `undo:${detail.entry.id}`,
      });
      if (request !== generation.current) return;
      setDetail({ ...detail, entry: result.entry });
      setConfirm(false);
      setError(false);
      setMessage("Restored · the original change and undo receipt are preserved.");
    });
  const canUndo =
    !!detail?.entry.reversible &&
    detail.sources.length > 0 &&
    detail.entry.undo?.completedAt == null;
  const action = detail?.destination
    ? `Move back to ${detail.entry.target}`
    : detail?.before === null
      ? "Remove this created note"
      : "Restore the earlier version";
  const confirmUndo = () => {
    if (!canUndo || busy) return;
    setConfirm(true);
    setBefore(true);
    setError(false);
    setMessage(`${action}? Enter confirms · Esc keeps the current note.`);
    scroll.current?.scrollTo(0);
  };
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      props.onExit();
      return;
    }
    if (key.ctrl || key.meta || !["press", "repeat"].includes(key.eventType)) return;
    key.preventDefault();
    if (key.name === "escape" && !busy) {
      if (confirm) {
        setConfirm(false);
        setMessage("Undo cancelled. Your note is unchanged.");
      } else if (detail) void load(pages.at(-1));
      else props.onClose();
      return;
    }
    if (busy) return;
    if (detail) {
      if (key.name === "tab") {
        setBefore((value) => !value);
        scroll.current?.scrollTo(0);
      } else if (key.name === "r") setRaw((value) => !value);
      else if (key.name === "u" && key.eventType === "press") confirmUndo();
      else if (key.name === "return" && confirm && key.eventType === "press") void undo();
      else if (["down", "j", "pagedown"].includes(key.name))
        scroll.current?.scrollBy(key.name === "pagedown" ? 10 : 1);
      else if (["up", "k", "pageup"].includes(key.name))
        scroll.current?.scrollBy(key.name === "pageup" ? -10 : -1);
    } else {
      if (["down", "j"].includes(key.name))
        flushSync(() => setCursor((value) => Math.max(0, Math.min(rows.length - 1, value + 1))));
      else if (["up", "k"].includes(key.name))
        flushSync(() => setCursor((value) => Math.max(0, value - 1)));
      else if (key.name === "return" && rows[cursor]) void inspect(rows[cursor].id);
      else if (key.name === "r") {
        setPages([undefined]);
        void load();
      } else if (key.name === "n" && next) {
        setPages([...pages, next]);
        void load(next);
      } else if (key.name === "p" && pages.length > 1) {
        const previous = pages.slice(0, -1);
        setPages(previous);
        void load(previous.at(-1));
      }
    }
  });
  const body = detail ? (before ? detail.before : detail.after) : null;
  return (
    <box
      width={props.width}
      height={props.height}
      backgroundColor={COLOR.bg}
      flexDirection="column"
      paddingLeft={inset}
      paddingRight={inset}
    >
      <box height={3} paddingTop={1} flexShrink={0}>
        <text fg={COLOR.accent}>
          <b>Your change history</b>
        </text>
      </box>
      <text
        width={width}
        height={2}
        flexShrink={0}
        wrapMode="word"
        fg={error ? COLOR.bad : COLOR.dim}
      >
        {busy ? "Working…" : message}
      </text>
      {detail ? (
        <box flexDirection="column" paddingTop={1} height={4} flexShrink={0}>
          <text fg={COLOR.bright}>
            <b>{truncateMiddle(detail.entry.target, width)}</b>
          </text>
          <text fg={COLOR.dim}>
            {detail.entry.kind.replace(/^notes?\./, "").replaceAll("_", " ")} ·{" "}
            {new Date(detail.entry.createdAt).toLocaleString()}
          </text>
          <text fg={COLOR.accent}>
            {before ? "Earlier version" : "Recorded change"}
            {detail.destination ? ` · ${before ? detail.entry.target : detail.destination}` : ""} ·{" "}
            {raw ? "exact Markdown" : "preview"}
          </text>
        </box>
      ) : (
        <text height={1} flexShrink={0} fg={COLOR.dim}>
          {rows.length} changes · page {pages.length}
        </text>
      )}
      <scrollbox
        ref={scroll}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        width={width}
        verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
        horizontalScrollbarOptions={HORIZONTAL_SCROLLBAR_OPTIONS}
      >
        {detail ? (
          body === null ? (
            <text fg={COLOR.dim}>
              {before && detail.sources.length > 0
                ? "This note did not exist before the change."
                : "This audit event has no note-body snapshot."}
            </text>
          ) : raw ? (
            <text fg={COLOR.text}>{body}</text>
          ) : (
            <Markdown text={body} />
          )
        ) : (
          rows.map((entry, index) => (
            <box
              key={entry.id}
              height={3}
              flexDirection="column"
              onMouseUp={() => {
                setCursor(index);
                void inspect(entry.id);
              }}
            >
              <text fg={index === cursor ? COLOR.accent : COLOR.bright}>
                {index === cursor ? "› " : "  "}
                {truncateMiddle(entry.target, width - 3)}
              </text>
              <text fg={COLOR.dim}>
                {" "}
                {new Date(entry.createdAt).toLocaleString()} ·{" "}
                {entry.undo?.completedAt != null
                  ? "undone"
                  : entry.undo
                    ? "undo interrupted"
                    : entry.kind.replace(/^notes?\./, "").replaceAll("_", " ")}
              </text>
            </box>
          ))
        )}
      </scrollbox>
      {canUndo && (
        <text
          height={2}
          flexShrink={0}
          wrapMode="word"
          fg={confirm ? COLOR.warn : COLOR.accent}
          onMouseUp={() => {
            if (confirm) void undo();
            else confirmUndo();
          }}
        >
          {confirm ? `Confirm: ${action}` : `u · ${action}`}
        </text>
      )}
      <box height={2} paddingTop={1} flexShrink={0}>
        <text fg={COLOR.dim}>
          {detail
            ? "Tab compare · r source/preview · u review undo · Esc back"
            : "Enter inspect · j/k select · n/p pages · r refresh · Esc close"}
        </text>
      </box>
    </box>
  );
}
