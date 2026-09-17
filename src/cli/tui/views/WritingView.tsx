import { randomUUID } from "node:crypto";
import type { KeyEvent, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { flushSync, useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type NoteDraft, draftChangeSet, newDraft } from "../../../api/drafts";
import { noteFilename } from "../../../core/vault/noteFilename";
import { Markdown } from "../Markdown";
import { DraftStore, type WritingRequest, previewDiff } from "../draft";
import { readingColumn } from "../layout";
import type { NotientRpc } from "../rpc";
import {
  COLOR,
  HORIZONTAL_SCROLLBAR_OPTIONS,
  VERTICAL_SCROLLBAR_OPTIONS,
  basename,
  truncate,
} from "./theme";

interface Props {
  vaultPath: string;
  identity: string;
  request: WritingRequest;
  width: number;
  height: number;
  rpc: () => NotientRpc;
  onClose: () => void;
  onExit: () => void;
  onSaved: (path: string, historyId: string | null) => void;
  onThink: (thought: string) => void;
  onReconnect: () => Promise<void>;
}

/** Human-owned writing UI. No inference or filesystem note writes happen here. */
export function WritingView(props: Props) {
  const { width: column, inset } = readingColumn(props.width);
  const store = useMemo(
    () => new DraftStore(props.vaultPath, props.identity),
    [props.vaultPath, props.identity],
  );
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [phase, setPhase] = useState<"edit" | "preview" | "discard">("edit");
  const [focusPath, setFocusPath] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("Opening your draft…");
  const [error, setError] = useState<string | null>(null);
  const [persisted, setPersisted] = useState(false);
  const current = useRef<NoteDraft | null>(null);
  const flight = useRef(false);
  const textarea = useRef<TextareaRenderable | null>(null);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const [attempt, setAttempt] = useState(0);
  const rpc = useRef(props.rpc);
  rpc.current = props.rpc;
  const update = useCallback((next: NoteDraft) => {
    current.current = next;
    setDraft(next);
    setPersisted(false);
  }, []);
  const report = useCallback((error: unknown) => {
    setError(error instanceof Error ? error.message : String(error));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    setMessage(attempt ? "Reopening your draft…" : "Opening your draft…");
    void (async () => {
      try {
        const { draft: next, restored } = await openWritingDraft(
          store,
          rpc.current(),
          props.request,
        );
        if (cancelled) return;
        update(next);
        setPhase(next.preview ? "preview" : "edit");
        setShowDiff(next.base !== null);
        setMessage(
          restored
            ? "Your unsaved draft is restored. Save or discard it before starting another."
            : next.base
              ? "Edit your Markdown below. Review the changes before saving."
              : "Make room for the thought. You can organize it after capturing it.",
        );
      } catch (error) {
        if (!cancelled) report(error);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store, props.request, report, update, attempt]);

  useEffect(() => {
    if (!draft) return;
    const timer = setTimeout(() => {
      if (current.current !== draft || flight.current) return;
      void store
        .save(draft)
        .then(() => {
          if (current.current === draft) setPersisted(true);
        })
        .catch(report);
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, store, report]);

  const edit = (patch: Partial<Pick<NoteDraft, "path" | "body">>) => {
    if (flight.current || !current.current) return;
    // Native inputs also notify when a controlled value is restored. A display
    // update must not invalidate a durable preview or mint another write key.
    if (
      (patch.path === undefined || patch.path === current.current.path) &&
      (patch.body === undefined || patch.body === current.current.body)
    )
      return;
    update({ ...current.current, ...patch, id: randomUUID(), preview: null });
    setError(null);
  };
  const leave = async (quit = false) => {
    if (flight.current) return;
    flight.current = true;
    try {
      if (current.current) await store.save(current.current);
      if (quit) props.onExit();
      else props.onClose();
    } catch (error) {
      report(error);
    } finally {
      flight.current = false;
    }
  };
  const save = async () => {
    const value = current.current;
    if (flight.current || busy || !value) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (phase !== "preview") {
        const next = await prepareDraftPreview(value, props.rpc(), store);
        update(next);
        setPhase("preview");
        setMessage(
          "Review the exact content below. Ctrl+S saves this version; Esc returns to editing.",
        );
      } else if (value.preview) {
        // Persist the exact review before dispatch, so retries after an ambiguous
        // disconnect reuse its durable effect receipts instead of creating a new write.
        await store.save(value);
        const result = await props.rpc().applyChanges({
          previewId: value.preview.previewId,
          previewRevision: value.preview.revision,
          idempotencyKey: `${value.id}:apply`,
        });
        if (!result.ok || result.state !== "applied")
          throw new Error(
            result.effects
              .map((effect) => effect.message)
              .filter(Boolean)
              .join("; ") || `Save ${result.state}. The draft is retained.`,
          );
        await store.save(null);
        current.current = null;
        props.onSaved(value.path, result.effects[0]?.historyId ?? null);
      }
    } catch (error) {
      report(error);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  const think = async () => {
    if (flight.current || !current.current?.body.trim()) return;
    flight.current = true;
    try {
      await store.save(current.current);
      props.onThink(current.current.body);
    } catch (error) {
      report(error);
    } finally {
      flight.current = false;
    }
  };
  const discard = async () => {
    if (flight.current) return;
    flight.current = true;
    try {
      await store.save(null);
      current.current = null;
      props.onClose();
    } catch (error) {
      report(error);
    } finally {
      flight.current = false;
    }
  };

  const controlKey = (name: string) => {
    switch (name) {
      case "c":
        void leave(true);
        return;
      case "s":
        void save();
        return;
      case "l":
        if (phase === "edit" && !draft?.base) flushSync(() => setFocusPath(!focusPath));
        return;
      case "b":
        if (phase === "edit" && props.request.text)
          flushSync(() => {
            edit({ body: props.request.text });
            textarea.current?.setText(props.request.text ?? "");
          });
        return;
      case "g":
        void think();
        return;
      case "r":
        void props
          .onReconnect()
          .then(() => {
            if (!current.current) setAttempt((value) => value + 1);
          })
          .catch(report);
        return;
      case "x":
        flushSync(() => setPhase("discard"));
        return;
    }
  };
  useKeyboard((key: KeyEvent) => {
    if (key.eventType !== "press") return;
    if (phase === "preview" && scrollPreview(key, scroll.current, props.height)) return;
    if (key.repeated) return;
    if (key.ctrl && ["c", "s", "l", "b", "g", "r", "x"].includes(key.name)) {
      key.preventDefault();
      if (!busy) controlKey(key.name);
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      if (busy) return;
      if (phase === "edit") void leave();
      else
        flushSync(() => {
          setPhase("edit");
          setError(null);
        });
      return;
    }
    if (phase === "edit") return;
    key.preventDefault();
    if (phase === "discard" && key.name === "return") void discard();
    if (phase === "preview" && key.name === "tab") flushSync(() => setShowDiff(!showDiff));
  });

  const status = busy
    ? "working…"
    : error
      ? "needs attention"
      : persisted
        ? "draft kept locally"
        : "keeping draft…";
  const preview = draft?.preview;
  const contentHeight = Math.max(1, props.height - 11);
  return (
    <box
      width={props.width}
      height={props.height}
      flexDirection="column"
      backgroundColor={COLOR.bg}
    >
      <box
        height={1}
        backgroundColor={COLOR.panel}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text fg={COLOR.accent}>
          notient <span fg={COLOR.label}>/ {basename(props.vaultPath)}</span>
        </text>
        <text fg={COLOR.dim}>
          {draft?.base ? "Edit note" : "Capture"} · {status}
        </text>
      </box>
      <box paddingLeft={inset} width={props.width} flexDirection="column">
        <text height={2} paddingTop={1} fg={COLOR.bright}>
          <b>{phase === "preview" ? "Ready to become a note" : "A place for the thought"}</b>
        </text>
        <box
          width={column}
          height={1}
          flexDirection="row"
          onMouseUp={() => {
            if (phase === "edit" && !draft?.base) setFocusPath(true);
          }}
        >
          <text fg={COLOR.dim}>To </text>
          <input
            width={Math.max(1, column - 4)}
            value={draft?.path ?? ""}
            focused={focusPath && phase === "edit" && !busy && !draft?.base}
            onInput={(path) => edit({ path })}
            onSubmit={() => setFocusPath(false)}
            backgroundColor={COLOR.bg}
            focusedBackgroundColor={COLOR.panel}
            textColor={COLOR.accent}
          />
        </box>
        <text height={2} width={column} fg={COLOR.dim} wrapMode="word">
          {truncate(
            props.request.text && draft?.body !== props.request.text
              ? "Your earlier draft is restored. Ctrl+B replaces its text with the selected answer. You can review before saving."
              : message,
            column * 2,
          )}
        </text>
        {phase === "discard" ? (
          <box height={contentHeight} width={column} flexDirection="column">
            <text fg={COLOR.warn}>Discard this unsaved draft?</text>
            <text fg={COLOR.text}>The note in your vault stays as it is.</text>
            <text fg={COLOR.label}>Enter discards the draft · Esc keeps writing</text>
          </box>
        ) : phase === "preview" && preview ? (
          <scrollbox
            ref={scroll}
            width={column}
            height={contentHeight}
            horizontalScrollbarOptions={HORIZONTAL_SCROLLBAR_OPTIONS}
            verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
          >
            <box width={Math.max(1, column - 1)} flexDirection="column">
              {showDiff ? (
                <diff
                  diff={previewDiff(preview)}
                  view="unified"
                  wrapMode="word"
                  fg={COLOR.text}
                  addedBg="#243426"
                  removedBg="#3C2825"
                  showLineNumbers
                />
              ) : (
                <Markdown text={preview.effects[0]?.after ?? ""} />
              )}
            </box>
          </scrollbox>
        ) : (
          <textarea
            key={draft ? (draft.base?.revision ?? "capture") : "loading"}
            keyBindings={[
              { name: "home", ctrl: true, action: "buffer-home" },
              { name: "end", ctrl: true, action: "buffer-end" },
            ]}
            ref={textarea}
            width={column}
            height={contentHeight}
            focused={!!draft && !focusPath && !busy}
            initialValue={draft?.body ?? ""}
            backgroundColor={COLOR.bg}
            focusedBackgroundColor={COLOR.bg}
            textColor={COLOR.text}
            focusedTextColor={COLOR.bright}
            cursorColor={COLOR.accent}
            wrapMode="word"
            placeholder="Start anywhere. A thought, a question, a paragraph worth keeping…"
            placeholderColor={COLOR.dim}
            onContentChange={() => {
              if (textarea.current && draft && textarea.current.plainText !== current.current?.body)
                edit({ body: textarea.current.plainText });
            }}
          />
        )}
        <text height={2} width={column} wrapMode="word" fg={error ? COLOR.bad : COLOR.dim}>
          {error ??
            (phase === "preview"
              ? `${showDiff ? "Changes" : "Reading preview"} · Tab switches view · source revision checked on save`
              : "Ctrl+G think with Notient · Ctrl+X discard · Ctrl+R reconnect")}
        </text>
        <text height={1} width={column} fg={COLOR.label}>
          {phase === "preview"
            ? "Ctrl+S save note · Esc keep editing"
            : `Ctrl+S review & save · ${draft?.base ? "" : "Ctrl+L destination · "}Esc keep draft`}
        </text>
      </box>
    </box>
  );
}

async function openWritingDraft(store: DraftStore, rpc: NotientRpc, request: WritingRequest) {
  const existing = await store.load();
  if (existing) return { draft: existing, restored: true };
  if (request.path) {
    const source = await rpc.noteBody(request.path);
    const draft: NoteDraft = {
      id: randomUUID(),
      path: source.note.path,
      body: source.body.replace(/^\ufeff/, "").replace(/\r\n/g, "\n"),
      base: { ...source.note, body: source.body },
      preview: null,
    };
    return { draft, restored: false };
  }
  const inbox = await rpc.listNotes("inbox", 10);
  const folder = inbox.notes
    .map((note) => /^(.*?(?:^|\/)(?:\d+-)?inbox)\//i.exec(note.path)?.[1])
    .find(Boolean);
  const draft = newDraft(folder ?? "Inbox", request.text);
  if (request.title) draft.path = `${folder ?? "Inbox"}/${noteFilename(request.title)}`;
  return { draft, restored: false };
}

async function prepareDraftPreview(value: NoteDraft, rpc: NotientRpc, store: DraftStore) {
  const preview = await rpc.previewChanges(draftChangeSet(value));
  if (preview.conflicts.length)
    throw new Error(preview.conflicts.map((item) => item.reason).join("; "));
  if (!preview.effects.length)
    throw new Error("No changes to save. Your note already has this content.");
  const next = { ...value, preview };
  await store.save(next);
  return next;
}

function scrollPreview(key: KeyEvent, scroll: ScrollBoxRenderable | null, height: number): boolean {
  if (!["up", "down", "pageup", "pagedown"].includes(key.name)) return false;
  key.preventDefault();
  const amount = key.name.startsWith("page") ? Math.max(1, height - 12) : 1;
  scroll?.scrollBy({ x: 0, y: ["up", "pageup"].includes(key.name) ? -amount : amount }, "absolute");
  return true;
}
