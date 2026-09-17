import { expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { Markdown } from "../../../src/cli/tui/Markdown";
import { deriveTuiLayout } from "../../../src/cli/tui/layout";
import { initialState, reducer } from "../../../src/cli/tui/store";
import { ExploreView } from "../../../src/cli/tui/views/ExploreView";
import { COLOR } from "../../../src/cli/tui/views/theme";

const DOCUMENT = [
  "# A quiet workspace",
  "",
  "A **durable journal**, an *explicit decision*, and `replay()`.",
  "",
  "- [x] Read the source",
  "- [ ] Review the change",
  "",
  "> Keep the evidence close to the decision.",
  "",
  "| Stage | Responsibility |",
  "| --- | --- |",
  "| Journal | Store accepted changes |",
  "| Recovery | Replay after a crash |",
  "",
  "```typescript",
  "const journal = await readJournal();",
  "await replay(journal);",
  "```",
  "",
  "Final paragraph with a [source](https://example.com/source).",
].join("\n");

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] note reader preserves every word when prose wraps beside a scrollbar",
  async () => {
    const paragraph =
      "Reading a substantial source should preserve every single character of the evidence. A narrow terminal is still a complete workspace for understanding a document, including its final word: verification.";
    const body = `${paragraph}\n\n${"More source material.\n\n".repeat(60)}`;
    const state = reducer(
      reducer(initialState("/vault"), { type: "explore/open", notePath: "Deep/Source.md" }),
      { type: "explore/body", body },
    );
    for (const width of [60, 80, 120]) {
      let screen: Awaited<ReturnType<typeof testRender>> | undefined;
      try {
        await act(async () => {
          screen = await testRender(
            <ExploreView state={state} layout={deriveTuiLayout(width, 30).explore} />,
            { width, height: 30 },
          );
        });
        const deadline = performance.now() + 8000;
        let frame = "";
        do {
          await act(async () => {
            await Bun.sleep(30);
          });
          await screen?.renderOnce();
          frame = screen?.captureCharFrame() ?? "";
          if (frame.includes("verification.")) break;
        } while (performance.now() < deadline);
        expect(frame.replace(/[▀▄█│]/g, "").replace(/\s+/g, " ")).toContain(paragraph);
      } finally {
        await act(async () => {
          screen?.renderer.destroy();
        });
      }
    }
  },
  30000,
);

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] native Markdown renders styles, lists, tables and code through streaming completion and resize",
  async () => {
    let update: (text: string, streaming: boolean) => void = () => {};
    function Reader() {
      const [value, setValue] = useState({
        text: "# A quiet workspace\n\nA **durable",
        streaming: true,
      });
      update = (text, streaming) => setValue({ text, streaming });
      return (
        <box backgroundColor={COLOR.bg} width="100%" height="100%" padding={2}>
          <Markdown text={value.text} streaming={value.streaming} />
        </box>
      );
    }
    let screen: Awaited<ReturnType<typeof testRender>> | undefined;
    try {
      await act(async () => {
        screen = await testRender(<Reader />, { width: 80, height: 40 });
      });
      if (!screen) throw new Error("No terminal renderer");
      await act(async () => {
        update(DOCUMENT.slice(0, DOCUMENT.indexOf("```typescript") + 22), true);
      });
      await screen.renderOnce();
      expect(screen.captureCharFrame()).toContain("A quiet workspace");
      await act(async () => {
        update(DOCUMENT, false);
      });
      for (const width of [80, 120, 200, 60]) {
        await act(async () => {
          screen?.resize(width, 40);
        });
        const deadline = performance.now() + 8000;
        let frame = "";
        do {
          await act(async () => {
            await Bun.sleep(30);
          });
          await screen.renderOnce();
          frame = screen.captureCharFrame();
          if (
            frame.includes("Final paragraph") &&
            !frame.includes("**durable") &&
            !frame.includes("# A quiet") &&
            !frame.includes("```typescript")
          )
            break;
        } while (performance.now() < deadline);
        expect(frame).toContain("A quiet workspace");
        expect(frame).toContain("durable journal");
        expect(frame).toContain("Read the source");
        expect(frame).toContain("Review the change");
        expect(frame).toContain("Store accepted changes");
        expect(frame).toContain("await replay(journal)");
        expect(frame).toContain("Final paragraph");
        expect(frame).not.toContain("**");
        expect(frame).not.toContain("```typescript");
        expect(frame).not.toContain("# A quiet");
        const spans = screen.captureSpans().lines.flatMap((line) => line.spans);
        expect(
          spans.some(
            (span) =>
              span.text.includes("durable journal") &&
              (span.attributes & TextAttributes.BOLD) !== 0,
          ),
        ).toBe(true);
        expect(
          spans.some(
            (span) =>
              span.text.includes("explicit decision") &&
              (span.attributes & TextAttributes.ITALIC) !== 0,
          ),
        ).toBe(true);
      }
    } finally {
      await act(async () => {
        screen?.renderer.destroy();
      });
    }
  },
  40000,
);
