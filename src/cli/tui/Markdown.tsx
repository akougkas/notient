import { SyntaxStyle } from "@opentui/core";
import { memo } from "react";
import { COLOR } from "./views/theme";

let style: SyntaxStyle | undefined;

/** One native theme shared by note reading and streamed answers. */
function markdownStyle(): SyntaxStyle {
  style ??= SyntaxStyle.fromStyles({
    default: { fg: COLOR.text },
    conceal: { fg: COLOR.dim },
    "markup.heading": { fg: COLOR.bright, bold: true },
    "markup.heading.1": { fg: COLOR.accent, bold: true },
    "markup.heading.2": { fg: COLOR.bright, bold: true },
    "markup.heading.3": { fg: COLOR.bright, bold: true },
    "markup.strong": { fg: COLOR.bright, bold: true },
    "markup.italic": { fg: COLOR.text, italic: true },
    "markup.link": { fg: COLOR.accent, underline: true },
    "markup.link.label": { fg: COLOR.accent, underline: true },
    "markup.link.url": { fg: COLOR.dim },
    "markup.raw": { fg: COLOR.warn, bg: COLOR.panel },
    "markup.raw.block": { fg: COLOR.text, bg: COLOR.panel },
    "markup.quote": { fg: COLOR.label, italic: true },
    "markup.list": { fg: COLOR.accent },
    "markup.list.checked": { fg: COLOR.ok },
    "markup.list.unchecked": { fg: COLOR.dim },
    keyword: { fg: COLOR.proposal },
    string: { fg: COLOR.accent },
    number: { fg: COLOR.warn },
    comment: { fg: COLOR.dim, italic: true },
    function: { fg: COLOR.bright },
    type: { fg: COLOR.warn },
    operator: { fg: COLOR.label },
    punctuation: { fg: COLOR.dim },
  });
  return style;
}

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
}: { text: string; streaming?: boolean }) {
  return (
    <markdown
      content={text}
      syntaxStyle={markdownStyle()}
      fg={COLOR.text}
      conceal
      streaming={streaming}
      tableOptions={{
        style: "columns",
        widthMode: "full",
        wrapMode: "word",
        cellPaddingX: 1,
        borderColor: COLOR.border,
      }}
    />
  );
});
