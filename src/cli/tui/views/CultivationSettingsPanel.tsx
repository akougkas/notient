import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { flushSync, useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import {
  cultivationSettingsSchema,
  type CultivationSettings,
  type MethodologySettings,
} from "../../../api/cultivationSettings";
import type { OperationInput } from "../../../api/operations";
import type { OperationResult } from "../../../api/results";
import { METHODOLOGY_TEMPLATES } from "../../../core/methodology/templates";
import type { NotientRpc } from "../rpc";
import {
  validateConventionDraftCurrent,
  type ConventionDraft,
} from "../methodologyConvention";
import { COLOR, HORIZONTAL_SCROLLBAR_OPTIONS, VERTICAL_SCROLLBAR_OPTIONS, truncate } from "./theme";

type FieldId =
  | "methodology.mode"
  | "methodology.name"
  | "methodology.conventions"
  | "attention.dailyTokens"
  | "attention.dailyModelCalls"
  | "attention.revisitDays"
  | "attention.digestItems"
  | "attention.priorities";

interface SettingField {
  id: FieldId;
  label: string;
  help: string;
  kind: "mode" | "text" | "textarea" | "number" | "priorities";
  unit?: string;
}

const fields: SettingField[] = [
  {
    id: "methodology.mode",
    label: "Methodology",
    help: "Choose AI-managed, PARA, FLAP or your own named convention. These guide interpretation and organization; they do not grant write permission.",
    kind: "mode",
  },
  {
    id: "methodology.name",
    label: "Custom methodology name",
    help: "Name your custom method. It is shown when Custom is selected.",
    kind: "text",
  },
  {
    id: "methodology.conventions",
    label: "Additional conventions",
    help: "Write local terms, examples and preferences for interpreting the vault. These are guidance; evidence and existing review boundaries still apply.",
    kind: "textarea",
  },
  {
    id: "attention.dailyTokens",
    label: "Daily token budget",
    help: "Maximum inference tokens available to automatic cultivation per day. Use 0 to pause token-consuming work.",
    kind: "number",
    unit: "tokens/day",
  },
  {
    id: "attention.dailyModelCalls",
    label: "Daily model-call budget",
    help: "Maximum model calls available to automatic cultivation per day. Use 0 to pause model-assisted work.",
    kind: "number",
    unit: "calls/day",
  },
  {
    id: "attention.revisitDays",
    label: "Revisit interval",
    help: "Days before revisiting an unchanged cultivated note. New revisions and ready saves can receive attention sooner.",
    kind: "number",
    unit: "days",
  },
  {
    id: "attention.digestItems",
    label: "Digest size",
    help: "Maximum number of recent cultivation outcomes shown in the attention digest.",
    kind: "number",
    unit: "items",
  },
  {
    id: "attention.priorities",
    label: "Note priorities",
    help: "One vault-relative path = priority per line, for example Projects/launch.md = 20. Higher numbers rank eligible notes sooner; they do not retrigger unchanged cultivated notes before their revisit. Use -100 to 100. Omitted notes use the default priority.",
    kind: "priorities",
  },
];

const modes: MethodologySettings["mode"][] = ["ai-managed", "para", "flap", "custom"];
const modeNames: Record<MethodologySettings["mode"], string> = {
  "ai-managed": "AI-managed",
  para: "PARA",
  flap: "FLAP",
  custom: "Custom",
};

function settingsOf(result: OperationResult<"cultivation.settings">): CultivationSettings {
  return { attention: result.attention, methodology: result.methodology };
}

function priorityText(settings: CultivationSettings): string {
  return settings.attention.priorities
    .map(({ path, priority }) => `${path} = ${priority}`)
    .join("\n");
}

function fieldText(settings: CultivationSettings, field: SettingField): string {
  switch (field.id) {
    case "methodology.mode":
      return modeNames[settings.methodology.mode];
    case "methodology.name":
      return settings.methodology.name;
    case "methodology.conventions":
      return settings.methodology.conventions;
    case "attention.dailyTokens":
      return String(settings.attention.dailyTokens);
    case "attention.dailyModelCalls":
      return String(settings.attention.dailyModelCalls);
    case "attention.revisitDays":
      return String(settings.attention.revisitDays);
    case "attention.digestItems":
      return String(settings.attention.digestItems);
    case "attention.priorities":
      return priorityText(settings);
  }
}

function prioritiesFromText(text: string): CultivationSettings["attention"]["priorities"] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return [];
  return lines.map((line, index) => {
    const separator = line.lastIndexOf("=");
    if (separator < 1) throw new Error(`Priority line ${index + 1}: use path = integer.`);
    const path = line.slice(0, separator).trim();
    const rawPriority = line.slice(separator + 1).trim();
    if (!/^-?\d+$/.test(rawPriority))
      throw new Error(`Priority line ${index + 1}: enter a whole number from -100 to 100.`);
    return { path, priority: Number(rawPriority) };
  });
}

function editField(
  settings: CultivationSettings,
  field: SettingField,
  text: string,
): CultivationSettings {
  const next = structuredClone(settings);
  switch (field.id) {
    case "methodology.name":
      next.methodology.name = text;
      break;
    case "methodology.conventions":
      next.methodology.conventions = text;
      break;
    case "attention.dailyTokens":
    case "attention.dailyModelCalls":
    case "attention.revisitDays":
    case "attention.digestItems": {
      const raw = text.trim();
      if (!/^\d+$/.test(raw)) throw new Error("Enter a whole number.");
      const value = Number(raw);
      if (field.id === "attention.dailyTokens") next.attention.dailyTokens = value;
      if (field.id === "attention.dailyModelCalls") next.attention.dailyModelCalls = value;
      if (field.id === "attention.revisitDays") next.attention.revisitDays = value;
      if (field.id === "attention.digestItems") next.attention.digestItems = value;
      break;
    }
    case "attention.priorities":
      next.attention.priorities = prioritiesFromText(text);
      break;
    case "methodology.mode":
      break;
  }
  return cultivationSettingsSchema.parse(next);
}

function changesBetween(before: CultivationSettings, after: CultivationSettings): string[] {
  return fields
    .filter((field) => field.id !== "methodology.name" || after.methodology.mode === "custom")
    .filter((field) => fieldText(before, field) !== fieldText(after, field))
    .map((field) => {
      const oldValue = fieldText(before, field).replaceAll("\n", ", ") || "empty";
      const newValue = fieldText(after, field).replaceAll("\n", ", ") || "empty";
      return `${field.label}: ${oldValue} → ${newValue}`;
    });
}

interface Props {
  rpc: () => NotientRpc;
  current: OperationResult<"cultivation.settings">;
  initialConvention?: ConventionDraft;
  width: number;
  height: number;
  onSaved: (result: OperationResult<"cultivation.settings">) => void;
  onClose: () => void;
  onExit: () => void;
}

export function CultivationSettingsPanel(props: Props) {
  const [base, setBase] = useState(props.current);
  const [draft, setDraft] = useState<CultivationSettings>(() => {
    const settings = settingsOf(props.current);
    if (
      props.initialConvention &&
      !settings.methodology.conventions.includes(props.initialConvention.text)
    )
      settings.methodology = {
        ...settings.methodology,
        conventions: [settings.methodology.conventions.trimEnd(), props.initialConvention.text]
          .filter(Boolean)
          .join("\n\n"),
      };
    return settings;
  });
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<SettingField | null>(null);
  const [review, setReview] = useState<string[] | null>(null);
  const [notice, setNotice] = useState(
    props.initialConvention
      ? "The approved convention is in this settings draft. Ctrl+S reviews the change; a second Ctrl+S saves it."
      : "Set how cultivation pays attention to your vault. Enter edits; Ctrl+S reviews changes.",
  );
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [stale, setStale] = useState(false);
  const pending = useRef<OperationInput<"cultivation.configure"> | null>(null);
  const editor = useRef<TextareaRenderable | null>(null);
  const reviewScroll = useRef<ScrollBoxRenderable | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settingsOf(base));
  const conventionActivationPending = Boolean(
    props.initialConvention &&
      !settingsOf(base).methodology.conventions.includes(props.initialConvention.text) &&
      draft.methodology.conventions.includes(props.initialConvention.text),
  );
  const visibleFields = fields.filter(
    (field) => field.id !== "methodology.name" || draft.methodology.mode === "custom",
  );
  const field = visibleFields[cursor];
  const fail = (cause: unknown) => {
    setError(true);
    setNotice(cause instanceof Error ? cause.message : String(cause));
  };

  useEffect(() => {
    if (editing) editor.current?.gotoBufferEnd();
  }, [editing]);

  const refresh = async () => {
    setBusy(true);
    try {
      const result = await props.rpc().cultivationSettings();
      if (pending.current) {
        if (JSON.stringify(settingsOf(result)) === JSON.stringify(pending.current.settings)) {
          pending.current = null;
          setBase(result);
          setDraft(settingsOf(result));
          setReview(null);
          setStale(false);
          setError(false);
          setNotice(
            "The current settings match the pending save. Cultivation settings are up to date.",
          );
          props.onSaved(result);
          return;
        }
        setBase(result);
        setStale(true);
        setReview(null);
        setError(true);
        setNotice(
          "Settings changed since this save was prepared. Ctrl+R reviews a new save against the current revision.",
        );
        return;
      }
      setBase(result);
      setDraft(settingsOf(result));
      setReview(null);
      setDiscard(false);
      setError(false);
      setNotice("Loaded the current cultivation settings.");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!dirty && !pending.current) {
      setNotice("These settings already match the saved configuration.");
      return;
    }
    if (stale && pending.current) {
      setNotice("Press Ctrl+R to prepare a reviewed save against the latest revision.");
      return;
    }
    if (!review) {
      setReview(changesBetween(settingsOf(base), draft));
      setError(false);
      setNotice("Review attention and methodology changes. Ctrl+S saves; Esc keeps editing.");
      return;
    }
    setBusy(true);
    try {
      if (pending.current) {
        const current = await props.rpc().cultivationSettings();
        if (JSON.stringify(settingsOf(current)) === JSON.stringify(pending.current.settings)) {
          pending.current = null;
          setBase(current);
          setDraft(settingsOf(current));
          setReview(null);
          setDiscard(false);
          setStale(false);
          setError(false);
          setNotice("The pending settings save is already active.");
          props.onSaved(current);
          return;
        }
      }
      if (conventionActivationPending && props.initialConvention)
        await validateConventionDraftCurrent(props.rpc(), props.initialConvention);
      pending.current ??= {
        settings: cultivationSettingsSchema.parse(draft),
        revision: base.revision,
        idempotencyKey: crypto.randomUUID(),
      };
      await props.rpc().configureCultivation(pending.current);
      const result = await props.rpc().cultivationSettings();
      pending.current = null;
      setBase(result);
      setDraft(settingsOf(result));
      setReview(null);
      setDiscard(false);
      setStale(false);
      setError(false);
      setNotice("Saved. These attention and methodology settings are active.");
      props.onSaved(result);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const keepField = (target: SettingField) => {
    try {
      if (target.kind === "mode") return;
      setDraft(editField(draft, target, editor.current?.plainText ?? ""));
      setEditing(null);
      setError(false);
      setNotice("Unsaved change · Ctrl+S reviews all changes.");
    } catch (cause) {
      fail(cause);
    }
  };

  const cycleMode = () => {
    const next = structuredClone(draft);
    const index = modes.indexOf(next.methodology.mode);
    next.methodology.mode = modes[(index + 1) % modes.length];
    setDraft(cultivationSettingsSchema.parse(next));
    setCursor(
      Math.min(cursor, visibleFields.length - (next.methodology.mode === "custom" ? 1 : 2)),
    );
    setError(false);
    setNotice(`Selected ${modeNames[next.methodology.mode]}. Ctrl+S reviews the change.`);
  };

  useKeyboard((key) =>
    flushSync(() => {
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
          keepField(editing);
        }
        return;
      }
      if (key.name === "f5") {
        key.preventDefault();
        if (dirty && !pending.current && !discard) {
          setDiscard(true);
          setNotice("F5 again discards unsaved settings and reloads current state.");
        } else void refresh();
        return;
      }
      if (key.ctrl && key.name === "r" && key.eventType !== "repeat" && stale) {
        key.preventDefault();
        pending.current = null;
        setStale(false);
        setReview(null);
        setError(false);
        setNotice(
          "The previous request was set aside. Ctrl+S reviews this draft against the current revision.",
        );
        return;
      }
      if (key.name === "escape") {
        key.preventDefault();
        if (pending.current) {
          setNotice(
            stale
              ? "F5 checks current settings · Ctrl+R prepares a new reviewed save."
              : "The last save may have completed. Ctrl+S retries the exact request; F5 checks current settings.",
          );
          return;
        }
        if (review) {
          setReview(null);
          return;
        }
        if (dirty && !discard) {
          setDiscard(true);
          setNotice("Esc again discards unsaved settings. Ctrl+S reviews them.");
        } else if (dirty) {
          setDraft(settingsOf(base));
          setDiscard(false);
        } else props.onClose();
        return;
      }
      if (key.ctrl && key.name === "s" && key.eventType !== "repeat") {
        key.preventDefault();
        void save();
        return;
      }
      if (review) {
        if (["up", "k", "down", "j", "pageup", "pagedown"].includes(key.name)) {
          key.preventDefault();
          reviewScroll.current?.scrollBy(
            (key.name.startsWith("page") ? Math.max(1, props.height - 8) : 1) *
              (["up", "k", "pageup"].includes(key.name) ? -1 : 1),
          );
        }
        return;
      }
      if (pending.current || stale) return;
      key.preventDefault();
      setDiscard(false);
      if (key.name === "down" || key.name === "j")
        setCursor((value) => Math.min(visibleFields.length - 1, value + 1));
      else if (key.name === "up" || key.name === "k") setCursor((value) => Math.max(0, value - 1));
      else if (key.name === "return" && field && key.eventType !== "repeat") {
        if (field.kind === "mode") cycleMode();
        else setEditing(field);
      }
    }),
  );

  const template = METHODOLOGY_TEMPLATES[draft.methodology.mode];
  const roleSummary = Object.keys(template.roles).join(" · ");
  const linesAvailable = Math.max(1, Math.floor((props.height - 22) / 1));
  const start = Math.max(
    0,
    Math.min(cursor - linesAvailable + 1, visibleFields.length - linesAvailable),
  );
  const shown = visibleFields.slice(start, start + linesAvailable);
  const selectedValue = field ? fieldText(draft, field).replaceAll("\n", ", ") || "empty" : "";
  return (
    <box flexDirection="column" width={props.width} height={props.height}>
      <text height={2} fg={COLOR.bright}>
        {`Cultivation attention & methodology${dirty ? " · unsaved" : ""}`}
      </text>
      {editing ? (
        <box flexDirection="column" width={props.width} flexGrow={1}>
          <text
            fg={COLOR.accent}
            height={1}
          >{`${editing.label}${editing.unit ? ` (${editing.unit})` : ""}`}</text>
          <text fg={COLOR.dim} width={props.width} height={3} wrapMode="word">
            {editing.help}
          </text>
          <textarea
            ref={editor}
            key={editing.id}
            keyBindings={[
              { name: "a", ctrl: true, action: "select-all" },
              { name: "home", ctrl: true, action: "buffer-home" },
              { name: "end", ctrl: true, action: "buffer-end" },
            ]}
            initialValue={fieldText(draft, editing)}
            focused
            width={props.width}
            flexGrow={1}
            backgroundColor={COLOR.panel}
            focusedBackgroundColor={COLOR.panel}
            textColor={COLOR.text}
            focusedTextColor={COLOR.bright}
            cursorColor={COLOR.accent}
            wrapMode="word"
          />
        </box>
      ) : review ? (
        <scrollbox
          ref={reviewScroll}
          width={props.width}
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          horizontalScrollbarOptions={HORIZONTAL_SCROLLBAR_OPTIONS}
          verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
        >
          <box flexDirection="column" width={Math.max(1, props.width - 2)} gap={1}>
            <text fg={COLOR.accent}>Review cultivation settings</text>
            {review.length ? (
              <>
                {review.map((line, index) => (
                  <text key={`${index}:${line}`} fg={COLOR.text} wrapMode="word">
                    {line}
                  </text>
                ))}
                {conventionActivationPending && props.initialConvention ? (
                  <>
                    <text fg={COLOR.label} wrapMode="word">
                      Approved convention evidence · preview {props.initialConvention.approvedPreview.id.slice(0, 12)}
                    </text>
                    {props.initialConvention.evidence.map((evidence, index) => (
                      <text key={`${evidence.path}:${evidence.range.start}:${index}`} fg={COLOR.dim} wrapMode="word">
                        {`${evidence.path}:${evidence.range.startLine} · ${evidence.quote}`}
                      </text>
                    ))}
                    <text fg={COLOR.dim} wrapMode="word">
                      {`Expected current sources: ${props.initialConvention.expectedCurrent.map((source) => `${source.path}@${source.revision.slice(0, 12)}`).join(" · ")}`}
                    </text>
                  </>
                ) : null}
              </>
            ) : (
              <text fg={COLOR.text}>No changes.</text>
            )}
          </box>
        </scrollbox>
      ) : (
        <box flexDirection="column" width={props.width} flexGrow={1}>
          {shown.map((item, index) => {
            const itemCursor = start + index;
            const value = fieldText(draft, item).replaceAll("\n", ", ") || "—";
            return (
              <text key={item.id} height={1} fg={itemCursor === cursor ? COLOR.accent : COLOR.text}>
                {truncate(
                  `${itemCursor === cursor ? "›" : " "} ${item.label}   ${value}`,
                  props.width,
                )}
              </text>
            );
          })}
          <text height={3} marginTop={1} width={props.width} fg={COLOR.dim} wrapMode="word">
            {field
              ? `${field.help}${field.kind === "mode" ? ` Current profile: ${template.purpose}` : ` Current value: ${selectedValue}`}`
              : ""}
          </text>
          <text height={2} width={props.width} fg={COLOR.label} wrapMode="word">
            {`${template.name}: ${template.purpose}${roleSummary ? ` Roles: ${roleSummary}.` : ""}`}
          </text>
        </box>
      )}
      <text width={props.width} height={3} wrapMode="word" fg={error ? COLOR.bad : COLOR.dim}>
        {busy ? "Saving or checking cultivation settings…" : notice}
      </text>
      <text width={props.width} height={1} fg={COLOR.label}>
        {editing
          ? "Ctrl+S keep value · Esc cancel field"
          : review
            ? "↑/↓ scroll review · Ctrl+S save settings · Esc edit"
            : stale
              ? "F5 inspect current · Ctrl+R prepare reviewed save"
              : pending.current
                ? "Ctrl+S retry exact save · F5 inspect current"
                : "↑/↓ choose · Enter edit/select · Ctrl+S review · F5 refresh · Esc back"}
      </text>
    </box>
  );
}
