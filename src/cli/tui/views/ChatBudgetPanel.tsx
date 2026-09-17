import type { TextareaRenderable } from "@opentui/core";
import { flushSync, useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { type ChatBudget, chatBudgetSchema } from "../../../api/chat";
import type { OperationInput } from "../../../api/operations";
import type { OperationResult } from "../../../api/results";
import type { NotientRpc } from "../rpc";
import { COLOR, truncate } from "./theme";

interface BudgetField {
  key: keyof ChatBudget;
  label: string;
  help: string;
  scale: number;
  unit: string;
}

export const CHAT_BUDGET_FIELDS: readonly BudgetField[] = [
  {
    key: "modelCalls",
    label: "Model calls per turn",
    help: "Every request in one answer counts: capability checks, tool rounds, nested analysis and memory refresh.",
    scale: 1,
    unit: "calls",
  },
  {
    key: "tokens",
    label: "Tokens per turn",
    help: "Provider-reported prompt and completion tokens across the whole turn, including reasoning.",
    scale: 1,
    unit: "tokens",
  },
  {
    key: "durationMs",
    label: "Time per turn",
    help: "Wall-clock limit for one answer. The turn stops cleanly and reports it was incomplete.",
    scale: 1000,
    unit: "seconds",
  },
  {
    key: "generationTokens",
    label: "Generation ceiling per call",
    help: "Largest completion a single model call may produce. Reasoning models spend part of it thinking.",
    scale: 1,
    unit: "tokens",
  },
];

export function budgetText(budget: ChatBudget, field: BudgetField): string {
  return String(budget[field.key] / field.scale);
}

/** Parses one edited value; the schema bounds are the same ones the daemon enforces. */
export function editBudget(budget: ChatBudget, field: BudgetField, text: string): ChatBudget {
  const value = Number(text.trim());
  if (!text.trim() || !Number.isFinite(value)) throw new Error("Enter a finite number.");
  const parsed = chatBudgetSchema.safeParse({
    ...budget,
    [field.key]: Math.round(value * field.scale),
  });
  if (!parsed.success) {
    // Bounds are stated in the unit the person typed, not the stored one.
    const { minValue, maxValue } = chatBudgetSchema.shape[field.key];
    throw new Error(
      `${field.label}: enter a whole number from ${(minValue ?? 0) / field.scale} to ${(maxValue ?? 0) / field.scale} ${field.unit}.`,
    );
  }
  return parsed.data;
}

type BudgetAction =
  | "exit"
  | "cancel-field"
  | "keep-field"
  | "save"
  | "back"
  | "down"
  | "up"
  | "edit";

const LIST_KEYS: Record<string, BudgetAction> = { down: "down", j: "down", up: "up", k: "up" };

/** Maps one key press to the panel action it requests in the current mode. */
function budgetAction(
  key: { name: string; ctrl: boolean; eventType: string },
  state: { busy: boolean; editing: boolean; review: boolean },
): BudgetAction | null {
  if (key.eventType !== "press" && key.eventType !== "repeat") return null;
  if (key.ctrl && key.name === "c") return "exit";
  if (state.busy) return null;
  const save = key.ctrl && key.name === "s" && key.eventType !== "repeat";
  if (state.editing) return editingAction(key.name, save);
  if (save) return "save";
  if (key.name === "escape") return "back";
  if (state.review) return null;
  if (key.name === "return") return key.eventType === "repeat" ? null : "edit";
  return LIST_KEYS[key.name] ?? null;
}

function editingAction(name: string, save: boolean): BudgetAction | null {
  if (name === "escape") return "cancel-field";
  return save ? "keep-field" : null;
}

interface Props {
  rpc: () => NotientRpc;
  current: OperationResult<"chat.settings">;
  width: number;
  height: number;
  onSaved: (result: OperationResult<"chat.settings">) => void;
  onClose: () => void;
  onExit: () => void;
}

/** Reviewable editor for per-turn chat resource limits. Saving is a human
 * administrator decision and governs the next chat turn. */
export function ChatBudgetPanel(props: Props) {
  const [draft, setDraft] = useState<ChatBudget>(props.current.budget);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<BudgetField | null>(null);
  const [review, setReview] = useState<string[] | null>(null);
  const [notice, setNotice] = useState(
    "Limits apply to each answer in chat. Enter edits a value; Ctrl+S reviews changes.",
  );
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef<OperationInput<"chat.configure"> | null>(null);
  const editor = useRef<TextareaRenderable | null>(null);
  // Editing continues from the end of the current value, as a person expects.
  useEffect(() => {
    if (editing) editor.current?.gotoBufferEnd();
  }, [editing]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(props.current.budget);
  const fail = (cause: unknown) => {
    setError(true);
    setNotice(cause instanceof Error ? cause.message : String(cause));
  };
  const save = async () => {
    if (!dirty && !pending.current) {
      setNotice("These limits already match the saved settings.");
      return;
    }
    if (!review) {
      setReview(
        CHAT_BUDGET_FIELDS.filter(
          (field) => draft[field.key] !== props.current.budget[field.key],
        ).map(
          (field) =>
            `${field.label}: ${budgetText(props.current.budget, field)} → ${budgetText(draft, field)} ${field.unit}`,
        ),
      );
      setError(false);
      setNotice("Review these limits. Ctrl+S saves; Esc keeps editing.");
      return;
    }
    setBusy(true);
    try {
      pending.current ??= {
        budget: draft,
        revision: props.current.revision,
        idempotencyKey: crypto.randomUUID(),
      };
      const saved = await props.rpc().configureChat(pending.current);
      pending.current = null;
      props.onSaved({ ok: true, revision: saved.revision, budget: saved.budget });
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const keepField = (field: BudgetField) => {
    try {
      setDraft(editBudget(draft, field, editor.current?.plainText ?? ""));
      setEditing(null);
      setError(false);
      setNotice("Unsaved change · Ctrl+S reviews all changes.");
    } catch (cause) {
      fail(cause);
    }
  };
  const back = () => {
    if (pending.current)
      setNotice("The last save may have completed. Ctrl+S retries the exact request.");
    else if (review) setReview(null);
    else props.onClose();
  };
  const actions: Record<BudgetAction, () => void> = {
    exit: props.onExit,
    "cancel-field": () => setEditing(null),
    "keep-field": () => editing && keepField(editing),
    save: () => void save(),
    back,
    down: () => setCursor((value) => Math.min(CHAT_BUDGET_FIELDS.length - 1, value + 1)),
    up: () => setCursor((value) => Math.max(0, value - 1)),
    edit: () => setEditing(CHAT_BUDGET_FIELDS[cursor]),
  };
  useKeyboard((key) =>
    flushSync(() => {
      const action = budgetAction(key, {
        busy,
        editing: editing !== null,
        review: review !== null,
      });
      if (!action) return;
      key.preventDefault();
      actions[action]();
    }),
  );
  const field = CHAT_BUDGET_FIELDS[cursor];
  return (
    <box flexDirection="column" width={props.width} height={props.height}>
      <text height={2} fg={COLOR.bright}>
        {`Conversation resources${dirty ? " · unsaved" : ""}`}
      </text>
      {editing ? (
        <box flexDirection="column" width={props.width} flexGrow={1}>
          <text fg={COLOR.accent} height={1}>{`${editing.label} (${editing.unit})`}</text>
          <text fg={COLOR.dim} width={props.width} height={2} wrapMode="word">
            {editing.help}
          </text>
          <textarea
            ref={editor}
            key={editing.key}
            keyBindings={[{ name: "a", ctrl: true, action: "select-all" }]}
            initialValue={budgetText(draft, editing)}
            focused
            width={props.width}
            height={3}
            backgroundColor={COLOR.panel}
            focusedBackgroundColor={COLOR.panel}
            textColor={COLOR.text}
            focusedTextColor={COLOR.bright}
            cursorColor={COLOR.accent}
          />
        </box>
      ) : review ? (
        <box flexDirection="column" width={props.width} flexGrow={1} gap={1}>
          <text fg={COLOR.accent}>Review limits</text>
          {review.map((line) => (
            <text key={line} fg={COLOR.text} wrapMode="word">
              {line}
            </text>
          ))}
        </box>
      ) : (
        <box flexDirection="column" width={props.width} flexGrow={1}>
          {CHAT_BUDGET_FIELDS.map((item, index) => (
            <text key={item.key} height={1} fg={index === cursor ? COLOR.accent : COLOR.text}>
              {truncate(
                `${index === cursor ? "›" : " "} ${item.label}   ${budgetText(draft, item)} ${item.unit}`,
                props.width,
              )}
            </text>
          ))}
          <text height={3} marginTop={1} width={props.width} fg={COLOR.dim} wrapMode="word">
            {field?.help}
          </text>
        </box>
      )}
      <text width={props.width} height={3} wrapMode="word" fg={error ? COLOR.bad : COLOR.dim}>
        {busy ? "Saving limits…" : notice}
      </text>
      <text width={props.width} height={1} fg={COLOR.label}>
        {editing
          ? "Ctrl+S keep value · Esc cancel field"
          : review
            ? "Ctrl+S save limits · Esc edit"
            : "↑/↓ choose · Enter edit · Ctrl+S review · Esc back"}
      </text>
    </box>
  );
}
