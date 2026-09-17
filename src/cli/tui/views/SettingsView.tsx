import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { flushSync, useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OperationInput, PipelinePolicy } from "../../../api/operations";
import {
  type PolicyField,
  type PolicySection,
  editPolicyField,
  policyFieldText,
  policyFields,
} from "../../../api/policyEditor";
import type { OperationResult } from "../../../api/results";
import { readingColumn } from "../layout";
import type { NotientRpc } from "../rpc";
import { ChatBudgetPanel } from "./ChatBudgetPanel";
import { COLOR, truncate } from "./theme";

const sections: PolicySection[] = ["Basics", "Scope", "Schedule", "Resources", "Details"];
interface Props {
  rpc: () => NotientRpc;
  width: number;
  height: number;
  onClose: () => void;
  onExit: () => void;
}
export function SettingsView(props: Props) {
  const column = readingColumn(props.width);
  const [catalog, setCatalog] = useState<OperationResult<"pipelines.list"> | null>(null);
  const [chat, setChat] = useState<OperationResult<"chat.settings"> | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [draft, setDraft] = useState<PipelinePolicy | null>(null);
  const [section, setSection] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<PolicyField | null>(null);
  const [confirmation, setConfirmation] = useState<string[] | null>(null);
  const [notice, setNotice] = useState("Loading your workflow settings…");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState(false);
  const flight = useRef(false);
  const alive = useRef(true);
  const editor = useRef<TextareaRenderable | null>(null);
  const reviewScroll = useRef<ScrollBoxRenderable | null>(null);
  const pending = useRef<OperationInput<"pipelines.configure"> | null>(null);
  const pausePending = useRef<OperationInput<"background.pause"> | null>(null);
  const rpc = useRef(props.rpc);
  rpc.current = props.rpc;
  const entry = catalog?.pipelines[selected];
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(entry?.policy);
  const fields = entry
    ? policyFields(entry.id).filter((field) => field.section === sections[section])
    : [];
  const field = fields[cursor];
  const report = useCallback((error: unknown) => {
    setError(true);
    setNotice(error instanceof Error ? error.message : String(error));
  }, []);
  const load = useCallback(async () => {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    try {
      const [result, chatSettings] = await Promise.all([
        rpc.current().pipelines(),
        rpc.current().chatSettings(),
      ]);
      if (!alive.current) return;
      setCatalog(result);
      setChat(chatSettings);
      setDraft(null);
      setConfirmation(null);
      setEditing(null);
      setDiscard(false);
      pending.current = null;
      pausePending.current = null;
      setError(false);
      setNotice("Choose what Notient may do. Reading and structural watching stay available.");
    } catch (error) {
      if (alive.current) report(error);
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }, [report]);
  // Editing continues from the end of the current value, as a person expects.
  useEffect(() => {
    if (editing) editor.current?.gotoBufferEnd();
  }, [editing]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  const save = async () => {
    if (!entry || !draft || !catalog || flight.current) return;
    if (!dirty && !pending.current) {
      setNotice("These preferences already match the saved settings.");
      return;
    }
    flight.current = true;
    setBusy(true);
    try {
      if (!confirmation) {
        const result = await rpc.current().validatePipeline({ pipeline: entry.id, policy: draft });
        if (!result.valid)
          throw new Error(
            result.issues
              .filter((i) => i.severity === "error")
              .map((i) => i.message)
              .join(" "),
          );
        const changes = policyFields(entry.id)
          .filter((f) => policyFieldText(draft, f) !== policyFieldText(entry.policy, f))
          .map(
            (f) =>
              `${f.label}: ${policyFieldText(entry.policy, f).replaceAll("\n", ", ") || "empty"} → ${policyFieldText(draft, f).replaceAll("\n", ", ") || "empty"}`,
          );
        setConfirmation([...changes, ...result.issues.map((i) => i.message)]);
        setError(false);
        setNotice("Review these permissions. Ctrl+S saves; Esc keeps editing.");
      } else {
        pending.current ??= {
          pipeline: entry.id,
          policy: draft,
          revision: catalog.revision,
          idempotencyKey: crypto.randomUUID(),
        };
        await rpc.current().configurePipeline(pending.current);
        const result = await rpc.current().pipelines();
        if (!alive.current) return;
        setCatalog(result);
        setDraft(null);
        setConfirmation(null);
        pending.current = null;
        setError(false);
        setNotice("Saved. These settings are active; runs under changed permissions are stopped.");
      }
    } catch (error) {
      if (alive.current) report(error);
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const pause = async () => {
    if (!catalog || flight.current) return;
    flight.current = true;
    setBusy(true);
    try {
      pausePending.current ??= {
        paused: !catalog.paused,
        revision: catalog.revision,
        idempotencyKey: crypto.randomUUID(),
      };
      await rpc.current().pauseBackground(pausePending.current);
      const result = await rpc.current().pipelines();
      if (!alive.current) return;
      setCatalog(result);
      pausePending.current = null;
      setError(false);
      setNotice(
        result.paused
          ? "Background work paused. Manual requests and structural watching remain available."
          : "Background work resumed only for explicitly enabled workflows.",
      );
    } catch (error) {
      if (alive.current) report(error);
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const finishField = () => {
    if (!draft || !editing) return;
    try {
      setDraft(editPolicyField(draft, editing, editor.current?.plainText ?? ""));
      setEditing(null);
      setError(false);
      setNotice("Unsaved change · Ctrl+S reviews all changes.");
    } catch (error) {
      report(error);
    }
  };
  useKeyboard((key) =>
    flushSync(() => {
      // The resource panel owns the keyboard while it is open.
      if (chatOpen) return;
      if (key.eventType !== "press" && key.eventType !== "repeat") return;
      if (key.ctrl && key.name === "c") {
        key.preventDefault();
        props.onExit();
        return;
      }
      if (busy) return;
      if (editing) {
        if (key.name === "escape") {
          key.preventDefault();
          setEditing(null);
        } else if (key.ctrl && key.name === "s" && key.eventType !== "repeat") {
          key.preventDefault();
          finishField();
        }
        return;
      }
      key.preventDefault();
      if (key.name === "f5") {
        if (dirty && !discard) {
          setDiscard(true);
          setNotice("F5 again discards unsaved settings and reloads current state.");
        } else void load();
        return;
      }
      if (key.name === "escape") {
        if (pending.current || pausePending.current) {
          setNotice(
            "The last request may have saved. Retry the exact request or press F5 to inspect current settings.",
          );
          return;
        }
        if (confirmation) {
          setConfirmation(null);
          return;
        }
        if (draft) {
          if (dirty && !discard) {
            setDiscard(true);
            setNotice("Esc again discards unsaved settings. Ctrl+S reviews them.");
          } else {
            setDraft(null);
            setDiscard(false);
          }
        } else props.onClose();
        return;
      }
      if (key.ctrl && key.name === "s" && key.eventType !== "repeat") {
        void save();
        return;
      }
      if (confirmation || pending.current || pausePending.current) {
        if (["up", "down", "pageup", "pagedown"].includes(key.name))
          reviewScroll.current?.scrollBy(
            {
              x: 0,
              y:
                (key.name.startsWith("page") ? Math.max(1, props.height - 10) : 1) *
                (["up", "pageup"].includes(key.name) ? -1 : 1),
            },
            "absolute",
          );
        if (pausePending.current && key.name === "p" && key.eventType !== "repeat") void pause();
        return;
      }
      setDiscard(false);
      if (!draft) {
        if (key.name === "down" || key.name === "j")
          setSelected((v) => Math.min(catalog?.pipelines.length ?? 0, v + 1));
        if (key.name === "up" || key.name === "k") setSelected((v) => Math.max(0, v - 1));
        if (key.name === "p" && key.eventType !== "repeat") void pause();
        if (key.name === "return" && !entry && chat && key.eventType !== "repeat")
          setChatOpen(true);
        if (key.name === "return" && entry) {
          setDraft(structuredClone(entry.policy));
          setSection(0);
          setCursor(0);
        }
      } else if (key.name === "tab") {
        setSection((section + (key.shift ? 4 : 1)) % sections.length);
        setCursor(0);
      } else if (key.name === "down" || key.name === "j")
        setCursor((v) => Math.min(fields.length - 1, v + 1));
      else if (key.name === "up" || key.name === "k") setCursor((v) => Math.max(0, v - 1));
      else if (key.name === "return" && field && key.eventType !== "repeat") {
        if (field.kind === "boolean" || field.kind === "choice") {
          const choices = field.choices ?? ["false", "true"];
          setDraft(
            editPolicyField(
              draft,
              field,
              choices[(choices.indexOf(policyFieldText(draft, field)) + 1) % choices.length],
            ),
          );
        } else setEditing(field);
      }
    }),
  );
  const rows = Math.max(3, props.height - 14);
  const start = Math.max(0, cursor - rows + 1);
  const rowHeight = props.height < 28 ? 1 : 2;
  const listRows = Math.max(1, Math.floor((props.height - 11) / rowHeight));
  const listStart = Math.max(0, selected - listRows + 1);
  return (
    <box
      width={props.width}
      height={props.height}
      backgroundColor={COLOR.bg}
      flexDirection="column"
      paddingLeft={column.inset}
      paddingTop={1}
    >
      <text width={column.width} height={2} fg={COLOR.accent}>
        notient / Your preferences
      </text>
      <text width={column.width} height={2} fg={COLOR.bright}>
        {draft && entry
          ? `${entry.title}${dirty ? " · unsaved" : ""}`
          : `Background intelligence · ${catalog?.paused ? "paused" : "enabled per workflow"}`}
      </text>
      {chatOpen && chat ? (
        <ChatBudgetPanel
          rpc={props.rpc}
          current={chat}
          width={column.width}
          height={Math.max(8, props.height - 5)}
          onSaved={(saved) => {
            setChat(saved);
            setChatOpen(false);
            setError(false);
            setNotice("Saved. The next chat turn uses these limits.");
          }}
          onClose={() => setChatOpen(false)}
          onExit={props.onExit}
        />
      ) : editing && draft ? (
        <box flexDirection="column" width={column.width} flexGrow={1}>
          <text fg={COLOR.accent} height={2}>
            {editing.label}
          </text>
          <text fg={COLOR.dim} width={column.width} height={3} wrapMode="word">
            {editing.help}
          </text>
          <textarea
            ref={editor}
            key={editing.path}
            keyBindings={[
              { name: "a", ctrl: true, action: "select-all" },
              { name: "home", ctrl: true, action: "buffer-home" },
              { name: "end", ctrl: true, action: "buffer-end" },
            ]}
            initialValue={policyFieldText(draft, editing)}
            focused
            width={column.width}
            flexGrow={1}
            backgroundColor={COLOR.panel}
            focusedBackgroundColor={COLOR.panel}
            textColor={COLOR.text}
            focusedTextColor={COLOR.bright}
            cursorColor={COLOR.accent}
            wrapMode="word"
          />
        </box>
      ) : confirmation ? (
        <scrollbox ref={reviewScroll} width={column.width} flexGrow={1}>
          <box flexDirection="column" width={column.width - 2} gap={1}>
            <text fg={COLOR.accent}>Review settings</text>
            {confirmation.map((line, i) => (
              <text key={`${i}:${line}`} fg={COLOR.text} wrapMode="word">
                {line}
              </text>
            ))}
          </box>
        </scrollbox>
      ) : draft ? (
        <box flexDirection="column" width={column.width} flexGrow={1}>
          <text height={2}>
            {sections.map((name, i) => (
              <span key={name} fg={i === section ? COLOR.accent : COLOR.dim}>{`${name}  `}</span>
            ))}
          </text>
          {fields.slice(start, start + rows).map((f, i) => (
            <text key={f.path} height={1} fg={start + i === cursor ? COLOR.accent : COLOR.text}>
              {truncate(
                `${start + i === cursor ? "›" : " "} ${f.label}   ${policyFieldText(draft, f).replaceAll("\n", ", ") || "—"}`,
                column.width,
              )}
            </text>
          ))}
          <text height={3} marginTop={1} width={column.width} fg={COLOR.dim} wrapMode="word">
            {field?.help}
          </text>
        </box>
      ) : (
        <box flexDirection="column" width={column.width} flexGrow={1}>
          {catalog?.pipelines.slice(listStart, listStart + listRows).map((p, i) => (
            <text
              key={p.id}
              height={rowHeight}
              fg={listStart + i === selected ? COLOR.accent : COLOR.text}
            >{`${listStart + i === selected ? "›" : " "} ${p.title}   ${p.policy.enabled ? "on" : "off"} · ${p.policy.mode === "propose" ? "review" : p.policy.mode}`}</text>
          ))}
          {chat ? (
            <text
              height={rowHeight}
              fg={selected === (catalog?.pipelines.length ?? 0) ? COLOR.accent : COLOR.text}
            >
              {`${selected === (catalog?.pipelines.length ?? 0) ? "›" : " "} Conversation resources   ${chat.budget.modelCalls} calls · ${chat.budget.tokens} tokens · ${chat.budget.durationMs / 1000}s`}
            </text>
          ) : null}
          <text width={column.width} wrapMode="word" fg={COLOR.dim}>
            {entry?.description ??
              (chat
                ? "Limits for each chat answer: model calls, tokens, time and the largest single generation."
                : "")}
          </text>
        </box>
      )}
      {chatOpen ? null : (
        <text width={column.width} height={3} wrapMode="word" fg={error ? COLOR.bad : COLOR.dim}>
          {busy ? "Saving or checking settings…" : notice}
        </text>
      )}
      <text width={column.width} height={chatOpen ? 0 : 2} wrapMode="word" fg={COLOR.label}>
        {chatOpen
          ? ""
          : editing
            ? "Ctrl+S keep value · Esc cancel field"
            : confirmation
              ? "Ctrl+S save settings · Esc edit · F5 inspect current"
              : draft
                ? "↑/↓ choose · Enter edit · Tab section · Ctrl+S review · Esc back"
                : "↑/↓ choose · Enter customize · p pause/resume · F5 refresh · Esc back"}
      </text>
    </box>
  );
}
