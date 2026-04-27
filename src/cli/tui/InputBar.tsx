import type React from "react";

export interface InputBarProps {
  busy: boolean;
  buffer: string;
}

export function InputBar({ busy, buffer }: InputBarProps): React.ReactNode {
  const cursor = busy ? "…" : "›";
  const cursorColor = busy ? "#94A3B8" : "#7DD3FC";
  return (
    <box height={1} backgroundColor="#111111" paddingLeft={1} paddingRight={1}>
      <text fg={cursorColor}>
        {cursor} {buffer}
      </text>
    </box>
  );
}
