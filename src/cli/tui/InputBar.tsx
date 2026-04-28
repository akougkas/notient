import type { KeyBinding, TextareaRenderable } from "@opentui/core";
import type React from "react";
import { useEffect, useRef } from "react";
import { buildTextareaKeyBindings } from "./inputBindings";

export interface InputBarProps {
  busy: boolean;
  value: string;
  height: number;
  focused: boolean;
  onChange: (next: string) => void;
  onSubmit: (final: string) => void;
}

const KEY_BINDINGS: KeyBinding[] = buildTextareaKeyBindings();

export function InputBar({
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
    textarea.editBuffer.setText(value);
    const clamped = Math.min(value.length, cursor);
    textarea.cursorOffset = clamped;
  }, [value]);

  const accent = focused && !busy ? "#7DD3FC" : "#334155";
  return (
    <box
      height={height + 2}
      backgroundColor="#0B1220"
      border
      borderStyle="rounded"
      borderColor={accent}
      paddingLeft={1}
      paddingRight={1}
    >
      <textarea
        ref={ref}
        focused={focused && !busy}
        keyBindings={KEY_BINDINGS}
        wrapMode="word"
        backgroundColor="#0B1220"
        textColor="#E2E8F0"
        focusedBackgroundColor="#0B1220"
        focusedTextColor="#F8FAFC"
        cursorColor="#7DD3FC"
        cursorStyle={{ style: "block", blinking: true }}
        placeholder={busy ? "thinking…" : "Message notient. /help for commands."}
        placeholderColor="#475569"
        initialValue={value}
        onContentChange={() => {
          const textarea = ref.current;
          if (!textarea) return;
          const next = textarea.plainText;
          if (next !== value) onChange(next);
        }}
        onSubmit={() => {
          const textarea = ref.current;
          const final = textarea ? textarea.plainText : value;
          onSubmit(final);
        }}
      />
    </box>
  );
}
