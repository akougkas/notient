import { randomUUID } from "node:crypto";
import type { KeyEvent, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { flushSync, useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangePreview } from "../../../api/changes";
import { type NoteDraft, draftChangeSet, newDraft } from "../../../api/drafts";
import { scopeAllows } from "../../../api/scope";
import { noteFilename } from "../../../core/vault/noteFilename";
import { Markdown } from "../Markdown";
import { DraftStore, type WritingRequest, previewDiff, redirectNotice } from "../draft";
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
  const [phase, setPhase] = useState<"edit" | "preview" | "discard" | "delete" | "deleted">("edit");
  const [focusPath, setFocusPath] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("Opening your draft…");
  const [error, setError] = useState<string | null>(null);
  const [persisted, setPersisted] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [removal, setRemoval] = useState<{
    preview: ChangePreview;
    key: string;
    historyIds: string[];
  } | null>(null);
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
        const { draft: next, restored, note } = await openWritingDraft(
          store,
          rpc.current(),
          props.request,
        );
        if (cancelled) return;
        update(next);
        setPhase(next.preview ? "preview" : "edit");
        setShowDiff(next.base !== null);
        const redirect = restored ? redirectNotice(props.request, next) : null;
        setPendingDelete(props.request.action === "delete" && redirect === null);
        setMessage(
          redirect
            ? redirect
            : restored
            ? "Your unsaved draft is restored. Save or discard it before starting another."
            : next.base
              ? "Edit your Markdown below. Review the changes before saving."
              : `Write the thought. Ctrl+S saves it to the folder below. Draft kept privately. ${note ?? ""}`.trim(),
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
  const applyPreview = async (value: NoteDraft) => {
    if (!value.preview) throw new Error("Review the note before saving.");
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
    if (!value.base) {
      const saved = await props.rpc().noteBody(value.path);
      if (saved.body !== value.body)
        throw new Error(
          `${value.path} exists but its content differs from your words. The draft is retained.`,
        );
    }
    await store.save(null);
    current.current = null;
    props.onSaved(value.path, result.effects[0]?.historyId ?? null);
  };
  const save = async (reviewFirst = false) => {
    const value = current.current;
    if (flight.current || busy || !value || (phase !== "edit" && phase !== "preview")) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    let prepared: NoteDraft | null = null;
    try {
      if (phase === "preview") {
        await applyPreview(value);
      } else if (reviewFirst || value.base) {
        const next = await prepareDraftPreview(value, props.rpc(), store);
        update(next);
        setPhase("preview");
        setMessage(
          "Review the exact content below. Ctrl+S or Alt+S saves this version; Esc returns to editing.",
        );
      } else {
        prepared = await prepareDraftPreview(value, props.rpc(), store);
        update(prepared);
        await applyPreview(prepared);
      }
    } catch (error) {
      if (prepared) {
        setPhase("preview");
        setMessage(
          "The note was not saved. Ctrl+S or Alt+S retries; your words are kept as a draft.",
        );
      }
      report(error);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  const reviewDelete = async () => {
    const value = current.current;
    if (flight.current || busy || !value?.base) return;
    if (hasUnsavedEdits(value)) {
      setError(
        "This note has unsaved edits. Ctrl+S saves them after review, or Ctrl+X discards the draft. Then delete the note.",
      );
      return;
    }
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      const key = randomUUID();
      const preview = await props.rpc().previewChanges({
        idempotencyKey: `${key}:delete`,
        changes: [
          { kind: "delete", source: { path: value.base.path, revision: value.base.revision } },
        ],
      });
      if (preview.conflicts.length)
        throw new Error(preview.conflicts.map((item) => item.reason).join("; "));
      setRemoval({ preview, key, historyIds: [] });
      setPhase("delete");
    } catch (error) {
      report(error);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  const confirmDelete = async () => {
    if (flight.current || busy || !removal) return;
    if (current.current && hasUnsavedEdits(current.current)) {
      setPhase("edit");
      setError("Unsaved edits appeared. Save or discard them before deleting.");
      return;
    }
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await props.rpc().applyChanges({
        previewId: removal.preview.previewId,
        previewRevision: removal.preview.revision,
        idempotencyKey: `${removal.key}:delete-apply`,
      });
      const historyIds = result.effects.flatMap((effect) =>
        effect.state === "applied" && effect.historyId ? [effect.historyId] : [],
      );
      setRemoval({ ...removal, historyIds });
      if (!result.ok || result.state !== "applied")
        throw new Error(
          `${
            result.effects
              .map((effect) => effect.message)
              .filter(Boolean)
              .join("; ") || `Delete ${result.state}`
          }. Nothing was lost; ${historyIds.length ? "earlier steps can be undone with Ctrl+Z" : "the note is unchanged"}.`,
        );
      await store.save(null);
      current.current = null;
      setPhase("deleted");
    } catch (error) {
      report(error);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  const undoDelete = async () => {
    if (flight.current || busy || !removal?.historyIds.length) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      for (const id of [...removal.historyIds].reverse()) {
        const detail = await props.rpc().historyEntry(id);
        if (detail.entry.undo?.completedAt != null) continue;
        await props.rpc().undoHistory({
          id,
          sources: detail.sources,
          idempotencyKey: `undo:${id}`,
        });
      }
      setRemoval({ ...removal, historyIds: [] });
      setMessage("Restored. The note is back at its original path.");
      props.onClose();
    } catch (error) {
      report(error);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!pendingDelete || busy || !draft) return;
    setPendingDelete(false);
    void reviewDelete();
  });
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
      case "o":
        if (phase === "edit") void save(true);
        return;
      case "l":
        if (phase === "edit" && !draft?.base) flushSync(() => setFocusPath(!focusPath));
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
      case "d":
        if (phase === "edit" && draft?.base) void reviewDelete();
        return;
      case "z":
        if (phase === "delete" || phase === "deleted") void undoDelete();
        return;
    }
  };
  useKeyboard((key: KeyEvent) => {
    if (key.eventType !== "press") return;
    if (phase === "preview" && scrollPreview(key, scroll.current, props.height)) return;
    if (key.repeated) return;
    const alt = (key.meta || key.option) && !key.ctrl && key.name === "s";
    if (
      (key.ctrl && ["c", "s", "o", "l", "g", "r", "x", "d", "z"].includes(key.name)) ||
      alt
    ) {
      key.preventDefault();
      if (!busy) controlKey(key.name);
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      if (busy) return;
      if (phase === "edit") void leave();
      else if (phase === "deleted") props.onClose();
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
    if (phase === "delete" && key.name === "return") void confirmDelete();
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
          <b>
            {phase === "preview"
              ? "Ready to become a note"
              : draft?.base
                ? "Edit note"
                : "Capture a thought"}
          </b>
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
          {truncate(message, column * 2)}
        </text>
        {phase === "discard" ? (
          <box height={contentHeight} width={column} flexDirection="column">
            <text fg={COLOR.warn}>Discard this unsaved draft?</text>
            <text fg={COLOR.text}>The note in your vault stays as it is.</text>
            <text fg={COLOR.label}>Enter discards the draft · Esc keeps writing</text>
          </box>
        ) : phase === "delete" && removal ? (
          <box height={contentHeight} width={column} flexDirection="column">
            <text fg={COLOR.warn}>
              Move {draft?.base?.path} to{" "}
              {removal.preview.effects.find((e) => e.kind === "move")?.destination}?
            </text>
            {removal.preview.effects.map((effect) => (
              <text key={`${effect.path}:${effect.reason}`} fg={COLOR.text} wrapMode="word">
                {effect.kind === "move" ? "Move" : "Qualify"} {effect.path}: {effect.reason}
              </text>
            ))}
            <text fg={COLOR.label}>
              Nothing is erased: the note keeps its exact content in Trash and Ctrl+Z restores it.
              Enter moves it · Esc cancels
            </text>
          </box>
        ) : phase === "deleted" ? (
          <box height={contentHeight} width={column} flexDirection="column">
            <text fg={COLOR.accent}>
              Moved to {removal?.preview.effects.find((e) => e.kind === "move")?.destination}
            </text>
            <text fg={COLOR.label}>Ctrl+Z restores it · Esc closes</text>
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
            ? "Ctrl+S/Alt+S save note · Esc keep editing"
            : draft?.base
              ? "Ctrl+S/Alt+S review changes · Ctrl+D delete · Esc keep draft"
              : "Ctrl+S/Alt+S save to Inbox · Ctrl+O preview · Ctrl+L destination · Esc keep draft"}
        </text>
      </box>
    </box>
  );
}

function hasUnsavedEdits(value: NoteDraft): boolean {
  if (!value.base) return value.body.trim().length > 0;
  return value.body !== value.base.body.replace(/^\ufeff/, "").replace(/\r\n/g, "\n");
}

const DEFAULT_CAPTURE_FOLDER = "Inbox";

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
  const destination = await captureDestination(rpc);
  const draft = newDraft(destination.folder, request.text);
  if (request.title) draft.path = `${destination.folder ? `${destination.folder}/` : ""}${noteFilename(request.title)}`;
  return { draft, restored: false, note: destination.note(draft.path) };
}

async function captureDestination(rpc: NotientRpc) {
  try {
    const catalog = await rpc.pipelines();
    const entry = catalog.pipelines.find((item) => item.id === "inbox");
    if (!entry) return { folder: DEFAULT_CAPTURE_FOLDER, note: () => "" };
    const { policy } = entry;
    return {
      folder: policy.destinations.inbox,
      note: (path: string) =>
        !policy.enabled || catalog.paused || !policy.triggers.includes("save")
          ? "Background Inbox work is off, so saving only stores the note."
          : scopeAllows({ ...policy.readScope, tags: [], excludeTags: [] }, path, [])
            ? "This folder is your Inbox: your background save trigger applies."
            : "This folder is outside your background scope, so saving only stores the note.",
    };
  } catch {
    return {
      folder: DEFAULT_CAPTURE_FOLDER,
      note: () => "Background settings were unavailable, so the Inbox folder is a default.",
    };
  }
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
