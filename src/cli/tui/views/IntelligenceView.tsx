import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PIPELINE_CATALOG } from "../../../api/pipelineCatalog";
import type { NoteReference, SourceReference } from "../../../api/schema";
import type { CultivationDigest } from "../../../api/cultivation";
import { Markdown } from "../Markdown";
import { readingColumn } from "../layout";
import { isDisconnect, type NotientRpc } from "../rpc";
import {
  COLOR,
  VERTICAL_SCROLLBAR_OPTIONS,
  HORIZONTAL_SCROLLBAR_OPTIONS,
  truncateMiddle,
} from "./theme";
import type { IntelligenceSession } from "../store";

type Job = Awaited<ReturnType<NotientRpc["job"]>>["job"];
type Row = Awaited<ReturnType<NotientRpc["jobs"]>>["jobs"][number];
const titles = Object.fromEntries(
  Object.entries(PIPELINE_CATALOG).map(([id, entry]) => [id, entry.title]),
);

export function IntelligenceView(props: {
  rpc: () => NotientRpc;
  width: number;
  height: number;
  onClose: () => void;
  onExit: () => void;
  onReconnect: () => Promise<void>;
  onReview: () => void;
  onSettings: () => void;
  onNote?: (note: NoteReference) => void;
  onSource: (source: SourceReference) => void;
  session: IntelligenceSession;
  onSessionChange: (session: IntelligenceSession) => void;
}) {
  const { width, inset } = readingColumn(props.width);
  const [rows, setRows] = useState<Row[]>([]);
  const [digest, setDigest] = useState<CultivationDigest | null>(null);
  const [detail, setDetail] = useState<Job | null>(null);
  const [schedule, setSchedule] = useState("Loading background work…");
  const [message, setMessage] = useState("");
  const [disconnected, setDisconnected] = useState(false);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rpc = useRef(props.rpc);
  rpc.current = props.rpc;
  const mounted = useRef(true);
  const flight = useRef(false);
  const sessionRef = useRef(props.session);
  const detailId = useRef<string | null>(props.session.detailJobId);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const page = props.session.pages.at(-1) ?? null;
  const { showWork, digestCursor, selectedJobId: selected } = props.session;
  const updateSession = (patch: Partial<IntelligenceSession>) => {
    const next = { ...sessionRef.current, ...patch };
    sessionRef.current = next;
    props.onSessionChange(next);
  };
  const rememberScroll = () => {
    const session = sessionRef.current;
    const section = session.detailJobId ? "detail" : session.showWork ? "work" : "developments";
    updateSession({
      scroll: {
        ...session.scroll,
        [section]: Math.max(0, scroll.current?.scrollTop ?? 0),
      },
    });
  };
  const openSource = (source: SourceReference) => {
    rememberScroll();
    props.onSource(source);
  };
  const openDigestNote = (item: CultivationDigest["items"][number]) => {
    rememberScroll();
    if (props.onNote) {
      props.onNote({ path: item.path, revision: item.revision });
      return;
    }
    const source = item.evidence.find((entry) => entry.path === item.path);
    if (source) props.onSource(source);
  };
  const load = useCallback(async () => {
    if (flight.current) return;
    flight.current = true;
    try {
      const [jobs, pipelines, developments] = await Promise.all([
        rpc.current().jobs(page ?? undefined),
        rpc.current().pipelines(),
        rpc.current().cultivationDigest(),
      ]);
      const id = detailId.current;
      const entry = id ? await rpc.current().job(id) : null;
      if (!mounted.current) return;
      setRows(jobs.jobs);
      setDigest(developments);
      setNext(jobs.nextCursor);
      const previousSession = sessionRef.current;
      const matchingDigest = developments.items.findIndex(
        (item) => item.id === previousSession.selectedDigestId,
      );
      const nextDigestCursor =
        matchingDigest >= 0
          ? matchingDigest
          : Math.min(previousSession.digestCursor, Math.max(0, developments.items.length - 1));
      const nextDigestId = developments.items[nextDigestCursor]?.id ?? null;
      const nextSelectedJob = jobs.jobs.some((row) => row.id === previousSession.selectedJobId)
        ? previousSession.selectedJobId
        : (jobs.jobs[0]?.id ?? null);
      updateSession({
        digestCursor: nextDigestCursor,
        selectedDigestId: nextDigestId,
        selectedJobId: nextSelectedJob,
      });
      if (entry && detailId.current === id) setDetail(entry.job);
      const enabled = pipelines.pipelines.filter((p) => p.policy.enabled);
      setSchedule(
        pipelines.paused
          ? "Cultivation paused · retained developments remain available"
          : `Methodology: ${developments.methodology.mode === "custom" ? developments.methodology.name : developments.methodology.mode} · ${enabled.length ? "Cultivation enabled" : "Open settings to enable cultivation"}`,
      );
      setMessage("");
      setDisconnected(false);
    } catch (error) {
      if (mounted.current) {
        setMessage(error instanceof Error ? error.message : String(error));
        setDisconnected(isDisconnect(error));
      }
    } finally {
      flight.current = false;
    }
  }, [page]);
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [load]);
  const inspect = async (id: string) => {
    detailId.current = id;
    updateSession({ detailJobId: id, scroll: { ...sessionRef.current.scroll, detail: 0 } });
    setBusy(true);
    try {
      const result = await rpc.current().job(id);
      if (mounted.current && detailId.current === id) {
        setDetail(result.job);
        scroll.current?.scrollTo(0);
      }
    } catch (error) {
      if (mounted.current) setMessage(String(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  useEffect(() => {
    const current = props.session;
    const section = current.detailJobId ? "detail" : current.showWork ? "work" : "developments";
    scroll.current?.scrollTo({ x: 0, y: current.scroll[section] });
  }, [props.session.detailJobId, props.session.showWork, props.session.pages, props.session.scroll]);
  const selectedDevelopmentId = digest?.items[digestCursor]?.id;
  useEffect(() => {
    if (showWork || props.session.detailJobId || !selectedDevelopmentId) return;
    const timer = setTimeout(() => {
      scroll.current?.scrollChildIntoView(`cultivation-development-${selectedDevelopmentId}`);
      rememberScroll();
    }, 50);
    return () => clearTimeout(timer);
  }, [selectedDevelopmentId, digestCursor, showWork, props.session.detailJobId, props.width, props.height]);
  const sources = detail ? findingSources(detail) : showWork ? [] : digest?.items[digestCursor]?.evidence.slice(0, 9) ?? [];
  const canPause = !!detail && ["queued", "running", "waiting-inference"].includes(detail.state);
  const canResume = detail?.state === "paused";
  const canRetry = !!detail && ["failed", "partial", "waiting-inference"].includes(detail.state);
  const control = async (action: "pause" | "resume" | "cancel" | "retry") => {
    if (!detail || busy) return;
    setBusy(true);
    try {
      const result = await rpc.current().controlJob({
        id: detail.id,
        revision: detail.revision,
        action,
        idempotencyKey: crypto.randomUUID(),
      });
      if (mounted.current) {
        setDetail(result.job);
        setMessage("");
      }
    } catch (error) {
      if (mounted.current) setMessage(String(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      props.onExit();
      return;
    }
    if (key.name === "escape" || key.name === "esc") {
      if (detailId.current) {
        detailId.current = null;
        updateSession({ detailJobId: null });
        setDetail(null);
      } else {
        rememberScroll();
        props.onClose();
      }
      return;
    }
    if (key.name === "r") {
      rememberScroll();
      if (disconnected) void props.onReconnect().then(load);
      else void load();
      return;
    }
    if (key.name === "v") {
      rememberScroll();
      props.onReview();
      return;
    }
    if (key.name === "s") {
      rememberScroll();
      props.onSettings();
      return;
    }
    if (key.name === "tab" && !detail) {
      rememberScroll();
      updateSession({ showWork: !showWork });
      return;
    }
    if (detail) {
      const source = /^[1-9]$/.test(key.name) ? sources[Number(key.name) - 1] : undefined;
      if (source) {
        openSource(source);
        return;
      }
      if (key.name === "p" && (canPause || canResume)) void control(canResume ? "resume" : "pause");
      if (key.name === "c" && (canPause || canResume)) void control("cancel");
      if (key.name === "t" && canRetry) void control("retry");
      if (["j", "down"].includes(key.name)) {
        scroll.current?.scrollBy(3);
        rememberScroll();
      }
      if (["k", "up"].includes(key.name)) {
        scroll.current?.scrollBy(-3);
        rememberScroll();
      }
      if (key.name === "pagedown") {
        scroll.current?.scrollBy(Math.max(5, props.height - 12));
        rememberScroll();
      }
      if (key.name === "pageup") {
        scroll.current?.scrollBy(-Math.max(5, props.height - 12));
        rememberScroll();
      }
      return;
    }
    if (!showWork) {
      const item = digest?.items[digestCursor];
      const source = /^[1-9]$/.test(key.name) ? sources[Number(key.name) - 1] : undefined;
      if (source) {
        openSource(source);
        return;
      }
      if (["j", "down", "k", "up"].includes(key.name)) {
        const cursor = Math.max(
          0,
          Math.min((digest?.items.length ?? 1) - 1, digestCursor + (["j", "down"].includes(key.name) ? 1 : -1)),
        );
        updateSession({ digestCursor: cursor, selectedDigestId: digest?.items[cursor]?.id ?? null });
      }
      if (key.name === "return" && item) void inspect(item.jobId);
      if (key.name === "o" && item) openDigestNote(item);
      if (key.name === "pagedown") {
        scroll.current?.scrollBy(Math.max(5, props.height - 12));
        rememberScroll();
      }
      if (key.name === "pageup") {
        scroll.current?.scrollBy(-Math.max(5, props.height - 12));
        rememberScroll();
      }
      return;
    }
    const index = Math.max(
      0,
      rows.findIndex((row) => row.id === selected),
    );
    if (["j", "down", "k", "up"].includes(key.name)) {
      const i = Math.max(
        0,
        Math.min(rows.length - 1, index + (["j", "down"].includes(key.name) ? 1 : -1)),
      );
      updateSession({ selectedJobId: rows[i]?.id ?? null });
      scroll.current?.scrollTo(Math.max(0, i * 3 - 3));
      rememberScroll();
    }
    if (key.name === "return" && selected) void inspect(selected);
    if (key.name === "n" && next && !flight.current) {
      updateSession({
        pages: [...sessionRef.current.pages, next],
        selectedJobId: null,
        detailJobId: null,
        scroll: { ...sessionRef.current.scroll, work: 0, detail: 0 },
      });
      detailId.current = null;
      scroll.current?.scrollTo(0);
    }
    if (key.name === "p" && sessionRef.current.pages.length > 1 && !flight.current) {
      updateSession({
        pages: sessionRef.current.pages.slice(0, -1),
        selectedJobId: null,
        detailJobId: null,
        scroll: { ...sessionRef.current.scroll, work: 0, detail: 0 },
      });
      detailId.current = null;
      scroll.current?.scrollTo(0);
    }
  });
  return (
    <box
      width={props.width}
      height={props.height}
      flexDirection="column"
      paddingLeft={inset}
      paddingRight={inset}
    >
      <text fg={COLOR.accent} height={2}>
        {detail || showWork ? "Cultivation work" : "Developments"}
      </text>
      <text fg={COLOR.label} height={2}>
        {schedule}
      </text>
      <text fg={COLOR.accent} height={1}>
        {!detail && !showWork && digest?.items[digestCursor]
          ? `${digest.items[digestCursor]!.path} · o open note`
          : ""}
      </text>
      <scrollbox
        ref={scroll}
        width={width}
        height={Math.max(
          5,
          props.height - 7 - (sources.length ? Math.min(3, sources.length) : 0) - (message ? 2 : 0),
        )}
        flexShrink={0}
        minHeight={0}
        stickyScroll={false}
        verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
        horizontalScrollbarOptions={HORIZONTAL_SCROLLBAR_OPTIONS}
      >
        {detail ? (
          <Markdown text={jobMarkdown(detail)} />
        ) : !showWork ? (
          digest?.items.length ? digest.items.map((item, index) => (
            <box key={item.id} flexDirection="column" paddingBottom={2} gap={1}>
              <text
                id={`cultivation-development-${item.id}`}
                fg={index === digestCursor ? COLOR.accent : COLOR.bright}
                onMouseDown={() => updateSession({ digestCursor: index, selectedDigestId: item.id })}
              >
                {index === digestCursor ? "› " : ""}{item.title} · {item.status} · {item.disposition}
              </text>
              <Markdown text={item.explanation} />
              {item.qualifications.map((qualification, qualificationIndex) => (
                <text key={qualificationIndex} fg={COLOR.dim} wrapMode="word">{qualification}</text>
              ))}
              <text fg={COLOR.dim} wrapMode="word">{item.reasons.join(" ")}</text>
              <text
                fg={COLOR.accent}
                wrapMode="word"
                onMouseDown={() => {
                  updateSession({ digestCursor: index, selectedDigestId: item.id });
                  openDigestNote(item);
                }}
              >
                {item.path} ↗
              </text>
            </box>
          )) : <text fg={COLOR.dim}>No current developments to surface. Read and capture normally; use settings to choose attention and permissions.</text>
        ) : rows.length ? (
          rows.map((row) => (
            <box key={row.id} flexDirection="column" height={3}>
              <text
                fg={row.id === selected ? COLOR.accent : COLOR.text}
              >{`${row.id === selected ? "›" : " "} ${titles[row.pipeline]} · ${row.state} · ${row.findingCount} findings${row.proposalCount ? ` · ${row.proposalCount} reviews` : ""}`}</text>
              <text fg={row.failure ? COLOR.bad : COLOR.dim}>
                {truncateMiddle(
                  row.failure?.message ??
                    row.headline ??
                    `${row.background ? "Background" : "Requested"} · ${new Date(row.createdAt).toLocaleString()} · ${row.stage}`,
                  width - 2,
                )}
              </text>
            </box>
          ))
        ) : (
          <text fg={COLOR.dim}>
            No work recorded yet. Open settings to enable background intelligence.
          </text>
        )}
      </scrollbox>
      {sources.length > 0 ? (
        <text fg={COLOR.label} height={Math.min(3, sources.length)}>
          {sources
            .slice(0, 9)
            .map((s, i) => `[${i + 1}] ${s.path}`)
            .join("  ")}
        </text>
      ) : null}
      {message ? (
        <text fg={COLOR.bad} height={2}>
          {message}
        </text>
      ) : null}
      <text fg={COLOR.dim} height={2}>
        {busy
          ? "Updating…"
          : detail
            ? [
                sources.length ? "1–9 source" : null,
                "v reviews",
                canPause ? "p pause" : canResume ? "p resume" : null,
                canPause || canResume ? "c cancel" : null,
                canRetry ? "t retry" : null,
                disconnected ? "r reconnect" : null,
                "Esc back",
              ]
                .filter(Boolean)
                .join(" · ")
            : showWork
              ? `Enter findings · j/k select · n/p pages · Tab developments · v reviews · s settings · r ${disconnected ? "reconnect" : "refresh"} · Esc close`
              : `j/k choose · 1–9 source · o note · Enter details · Tab work · v reviews · s settings · r ${disconnected ? "reconnect" : "refresh"} · Esc close`}
      </text>
    </box>
  );
}

function findingSources(job: Job): SourceReference[] {
  const seen = new Set<string>();
  return (job.plan?.findings.flatMap((f) => f.evidence) ?? []).filter((s) => {
    const key = `${s.path}:${s.revision}:${s.range.start}:${s.range.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function jobMarkdown(job: Job): string {
  const lines = [
    `# ${titles[job.pipeline]}`,
    `${job.background ? "Background work" : "Requested work"} · **${job.state}** · ${job.stage}`,
  ];
  if (job.failure) lines.push(`## Could not complete\n${job.failure.message}`);
  if (job.plan) {
    lines.push(job.plan.summary);
    for (const f of job.plan.findings)
      lines.push(
        `## ${f.title}\n${f.explanation}\n\n${f.qualifications?.join("\n\n") ?? ""}\n\n${f.evidence.map((s) => `> ${s.quote.replace(/\n/g, "\n> ")}\n\n${s.path}`).join("\n\n")}`,
      );
    for (const r of job.plan.relationships)
      lines.push(`## ${r.relation}\n${r.source.path} → ${r.target.path}\n\n${r.rationale}`);
    if (job.plan.changes.length)
      lines.push(
        `## Proposed changes\n${job.plan.changes.map((c) => `- ${c.kind}`).join("\n")}\n\nOpen reviews to inspect the exact changes.`,
      );
  } else
    lines.push("Findings will appear when this run finishes. Progress refreshes automatically.");
  return lines.join("\n\n");
}
