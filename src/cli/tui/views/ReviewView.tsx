import type { ScrollBoxRenderable } from "@opentui/core";
import { flushSync, useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangePreview } from "../../../api/changes";
import { PIPELINE_CATALOG } from "../../../api/pipelineCatalog";
import { type ReviewProposal, reviewTitle } from "../../../api/proposals";
import type { SourceReference } from "../../../api/schema";
import { Markdown } from "../Markdown";
import { previewDiff } from "../draft";
import { readingColumn } from "../layout";
import type { NotientRpc } from "../rpc";
import { COLOR, HORIZONTAL_SCROLLBAR_OPTIONS, VERTICAL_SCROLLBAR_OPTIONS } from "./theme";

const pipelineTitles = Object.fromEntries(
  Object.entries(PIPELINE_CATALOG).map(([id, entry]) => [id, entry.title]),
) as Parameters<typeof reviewTitle>[1];

interface Props {
  rpc: () => NotientRpc;
  width: number;
  height: number;
  active: boolean;
  onRequests: () => void;
  onOpen: (source: SourceReference) => void;
  onClose: () => void;
}
/** Exact stored reviews in the same quiet reading column as notes and writing. */
export function ReviewView(props: Props) {
  const { width, inset } = readingColumn(props.width);
  const [rows, setRows] = useState<ReviewProposal[]>([]);
  const [cursor, setCursor] = useState(0);
  const [next, setNext] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ proposal: ReviewProposal; preview: ChangePreview } | null>(
    null,
  );
  const [tab, setTab] = useState<"evidence" | "changes" | "after">("evidence");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Loading suggestions…");
  const [error, setError] = useState(false);
  const [confirm, setConfirm] = useState<"approve" | "reject" | null>(null);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const flight = useRef(false);
  const generation = useRef(0);
  const rpc = useRef(props.rpc);
  rpc.current = props.rpc;
  const report = useCallback((error: unknown) => {
    setError(true);
    setMessage(error instanceof Error ? error.message : String(error));
  }, []);
  const load = useCallback(async (page?: string) => {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    const current = ++generation.current;
    try {
      const result = await rpc.current().reviews({ limit: 30, cursor: page });
      if (current !== generation.current) return;
      setRows(result.proposals);
      setNext(result.nextCursor);
      setCursor(0);
      setDetail(null);
      setConfirm(null);
      setError(false);
      setMessage(
        result.proposals.length
          ? "Choose a suggestion to read its evidence and exact changes."
          : "No suggestions yet. Explore a note when you want a fresh perspective.",
      );
    } catch (error) {
      if (current === generation.current) report(error);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      ++generation.current;
    };
  }, [load]);
  const inspect = async (id: string) => {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setConfirm(null);
    const current = ++generation.current;
    try {
      const { proposal } = await rpc.current().review(id);
      const preview = await rpc.current().changePreview(proposal.previewId);
      if (current !== generation.current) return;
      setDetail({ proposal, preview });
      setTab("evidence");
      setError(false);
      setMessage(
        proposal.state === "stale"
          ? "Saved evidence changed. Inspect current sources before deciding."
          : `${proposal.state} · ${preview.effects.length} file effects${proposal.appliedHistory.length ? ` · ${proposal.appliedHistory.length} effects already recorded` : ""}`,
      );
      scroll.current?.scrollTo(0);
    } catch (error) {
      if (current === generation.current) report(error);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  const decide = async (action: "approve" | "reject") => {
    if (!detail || flight.current) return;
    const { proposal, preview } = detail;
    if (proposal.state === "approved" || proposal.state === "rejected") return;
    if (
      action === "approve" &&
      (preview.conflicts.length || (proposal.state === "stale" && !proposal.appliedHistory.length))
    ) {
      setError(true);
      setMessage("This suggestion needs fresh evidence or resolved conflicts before applying.");
      return;
    }
    if (confirm !== action) {
      setConfirm(action);
      setTab("changes");
      setError(false);
      setMessage(
        action === "approve"
          ? "Review the exact changes. Press a again to apply; Esc keeps everything unchanged."
          : "Press r again to record rejection. Already applied effects stay in history.",
      );
      scroll.current?.scrollTo(0);
      return;
    }
    flight.current = true;
    setBusy(true);
    try {
      if (action === "approve") {
        const result = await rpc.current().approveReview({
          id: proposal.id,
          previewId: preview.previewId,
          previewRevision: preview.revision,
          idempotencyKey: `tui-approve-${proposal.id}-${preview.revision.slice(0, 16)}`,
        });
        setMessage(
          `${result.state}${result.effects
            .filter((e) => e.message)
            .map((e) => ` · ${e.path}: ${e.message}`)
            .join("")}`,
        );
        setError(!result.ok);
      } else {
        await rpc.current().rejectReview({
          id: proposal.id,
          revision: proposal.revision,
          idempotencyKey: `tui-reject-${proposal.id}-${proposal.revision.slice(0, 12)}`,
        });
        setMessage("Rejected · your decision is recorded.");
        setError(false);
      }
      const latest = await rpc.current().review(proposal.id);
      setDetail({ proposal: latest.proposal, preview });
      setConfirm(null);
    } catch (error) {
      report(error);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  useKeyboard((key) => {
    if (!props.active || key.ctrl || key.meta || !["press", "repeat"].includes(key.eventType))
      return;
    if (key.name === "escape") {
      if (confirm) {
        setConfirm(null);
        setMessage("Decision cancelled. No new effect was requested.");
      } else if (detail) {
        setDetail(null);
        void load();
      } else props.onClose();
    } else if (busy) return;
    else if (key.name === "tab") props.onRequests();
    else if (key.name === "f5") void load();
    else if (!detail) {
      if (["down", "j"].includes(key.name))
        flushSync(() => setCursor((value) => Math.min(rows.length - 1, value + 1)));
      if (["up", "k"].includes(key.name))
        flushSync(() => setCursor((value) => Math.max(0, value - 1)));
      if (key.name === "return" && rows[cursor]) void inspect(rows[cursor].id);
      if (key.name === "n" && next) void load(next);
    } else {
      if (key.eventType !== "repeat" && key.name === "a") void decide("approve");
      if (key.eventType !== "repeat" && key.name === "r") void decide("reject");
      if (key.name === "1") {
        setTab("evidence");
        scroll.current?.scrollTo(0);
      }
      if (key.name === "2") {
        setTab("changes");
        scroll.current?.scrollTo(0);
      }
      if (key.name === "3") {
        setTab("after");
        scroll.current?.scrollTo(0);
      }
      if (["down", "j", "pagedown"].includes(key.name))
        scroll.current?.scrollBy(key.name === "pagedown" ? props.height - 8 : 3);
      if (["up", "k", "pageup"].includes(key.name))
        scroll.current?.scrollBy(key.name === "pageup" ? 8 - props.height : -3);
      if (key.name === "o" && detail.proposal.provenance.evidence[0])
        props.onOpen(detail.proposal.provenance.evidence[0]);
    }
    key.preventDefault();
  });
  useEffect(() => {
    if (!detail) scroll.current?.scrollTo(Math.max(0, cursor * 4 - props.height + 12));
  }, [cursor, detail, props.height]);
  return (
    <box
      width={props.width}
      height={props.height}
      flexDirection="column"
      paddingLeft={inset}
      paddingRight={inset}
    >
      <box height={2} flexDirection="row" gap={3} paddingTop={1}>
        <text fg={COLOR.accent}>
          <b>Suggestions</b>
        </text>
        <text fg={COLOR.dim} onMouseDown={props.onRequests}>
          Requests →
        </text>
      </box>
      <text height={2} fg={COLOR.bright}>
        <b>
          {detail
            ? reviewTitle(detail.proposal.provenance, pipelineTitles)
            : "Small changes. A more useful vault."}
        </b>
      </text>
      <text width={width} wrapMode="word" fg={error ? COLOR.bad : COLOR.dim}>
        {busy ? "Checking saved evidence…" : message}
      </text>
      {detail ? (
        <box height={2} flexDirection="row" gap={3} paddingTop={1}>
          {(["evidence", "changes", "after"] as const).map((item, index) => (
            <text
              key={item}
              fg={tab === item ? COLOR.accent : COLOR.dim}
              onMouseDown={() => {
                setTab(item);
                scroll.current?.scrollTo(0);
              }}
            >
              {index + 1} {item}
            </text>
          ))}
        </box>
      ) : null}
      <scrollbox
        ref={scroll}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        width={width}
        horizontalScrollbarOptions={HORIZONTAL_SCROLLBAR_OPTIONS}
        verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
      >
        <box flexDirection="column" width={Math.max(1, width - 2)} paddingTop={1} gap={1}>
          {!detail ? (
            rows.map((proposal, index) => (
              <box
                key={proposal.id}
                flexDirection="column"
                paddingBottom={1}
                onMouseDown={() => {
                  setCursor(index);
                  void inspect(proposal.id);
                }}
              >
                <text fg={index === cursor ? COLOR.accent : COLOR.bright}>
                  {index === cursor ? "› " : "  "}
                  {reviewTitle(proposal.provenance, pipelineTitles)} · {proposal.state}
                </text>
                <text fg={COLOR.text} wrapMode="word">
                  {" "}
                  {proposal.provenance.sources.map((source) => source.path).join(" · ")}
                </text>
                <text fg={COLOR.dim}>
                  {" "}
                  {new Date(proposal.createdAt).toLocaleString()}
                  {proposal.appliedHistory.length
                    ? ` · ${proposal.appliedHistory.length} effects recorded`
                    : ""}
                </text>
              </box>
            ))
          ) : tab === "evidence" ? (
            <>
              <Markdown text={detail.proposal.provenance.rationale} />
              {detail.proposal.provenance.evidence.map((source, index) => (
                <box
                  key={`${source.path}:${source.range.start}:${index}`}
                  flexDirection="column"
                  gap={1}
                >
                  <text fg={COLOR.accent} wrapMode="word" onMouseDown={() => props.onOpen(source)}>
                    {source.path} · line {source.range.startLine} ↗
                  </text>
                  <Markdown text={source.quote} />
                </box>
              ))}
            </>
          ) : tab === "changes" ? (
            <>
              {detail.preview.conflicts.map((conflict) => (
                <text key={conflict.path} fg={COLOR.bad} wrapMode="word">
                  {conflict.path}: {conflict.reason}
                </text>
              ))}
              <diff
                diff={previewDiff(detail.preview)}
                view="unified"
                wrapMode="word"
                fg={COLOR.text}
                addedBg="#243426"
                removedBg="#3C2825"
                showLineNumbers
              />
            </>
          ) : (
            detail.preview.effects.map((effect) => (
              <box key={`${effect.path}:${effect.afterRevision}`} flexDirection="column" gap={1}>
                <text fg={COLOR.accent} wrapMode="word">
                  {effect.destination ?? effect.path}
                </text>
                <Markdown text={effect.after} />
              </box>
            ))
          )}
        </box>
      </scrollbox>
      <text height={1} flexShrink={0} fg={COLOR.dim}>
        {detail
          ? "1 evidence · 2 changes · 3 after · a approve · r reject · o source · Esc back"
          : `↑↓ choose · Enter inspect${next ? " · n next page" : ""} · F5 refresh · Tab requests`}
      </text>
    </box>
  );
}
