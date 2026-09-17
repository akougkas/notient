import type { KeyBinding, TextareaRenderable } from "@opentui/core";
import { flushSync } from "@opentui/react";
import type React from "react";
import { useEffect, useRef } from "react";
import { buildTextareaKeyBindings } from "./inputBindings";
import { COLOR } from "./views/theme";

export interface InputBarProps {
  width: number;
  busy: boolean;
  value: string;
  height: number;
  focused: boolean;
  onChange: (next: string) => void;
  onSubmit: (final: string) => void;
}

const KEY_BINDINGS: KeyBinding[] = buildTextareaKeyBindings();

export function InputBar({
  width,
  busy,
  value,
  height,
  focused,
  onChange,
  onSubmit,
}: InputBarProps): React.ReactNode {
  const ref = useRef<TextareaRenderable | null>(null);

  useEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    if (textarea.plainText === value) return;
    const cursor = textarea.cursorOffset;
    textarea.setText(value);
    const clamped = Math.min(value.length, cursor);
    textarea.cursorOffset = clamped;
  }, [value]);

  const accent = focused && !busy ? COLOR.accent : COLOR.border;
  return (
    <box
      width={width}
      height={height + 2}
      flexShrink={0}
      backgroundColor={COLOR.bg}
      border={["top"]}
      borderColor={accent}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      flexDirection="row"
    >
      <text fg={focused ? COLOR.accent : COLOR.dim}>{"› "}</text>
      <textarea
        ref={ref}
        flexGrow={1}
        focused={focused && !busy}
        keyBindings={KEY_BINDINGS}
        wrapMode="word"
        backgroundColor={COLOR.bg}
        textColor={COLOR.text}
        focusedBackgroundColor={COLOR.bg}
        focusedTextColor={COLOR.bright}
        cursorColor={COLOR.accent}
        cursorStyle={{ style: "block", blinking: true }}
        placeholder={busy ? "Working…" : "Ask anything, or bring a note with @path"}
        placeholderColor={COLOR.dim}
        initialValue={value}
        onContentChange={() => {
          const textarea = ref.current;
          if (!textarea) return;
          const next = textarea.plainText;
          // A terminal can deliver the entire command and Enter in one batch.
          // Commit the typed value before its accepted submission clears it.
          if (next !== value) flushSync(() => onChange(next));
        }}
        onSubmit={() => {
          const textarea = ref.current;
          const final = textarea ? textarea.plainText : value;
          // Native content-change notifications can follow the Enter event.
          // Establish the submitted value before the parent accepts or retains it.
          flushSync(() => onChange(final));
          // The parent clears an accepted send. A failed conversation start
          // must leave the draft intact rather than erase it before admission.
          flushSync(() => onSubmit(final));
        }}
      />
    </box>
  );
}
