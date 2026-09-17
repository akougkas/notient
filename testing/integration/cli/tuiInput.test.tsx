import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { InputBar } from "../../../src/cli/tui/InputBar";

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] rapid command submission clears the native composer before another command",
  async () => {
    const submitted: string[] = [];
    let accept = true;
    function Composer() {
      const [value, setValue] = useState("");
      return (
        <InputBar
          width={70}
          height={4}
          busy={false}
          focused
          value={value}
          onChange={setValue}
          onSubmit={(text) => {
            submitted.push(text);
            if (accept) setValue("");
          }}
        />
      );
    }
    let screen: Awaited<ReturnType<typeof testRender>> | undefined;
    try {
      await act(async () => {
        screen = await testRender(<Composer />, { width: 80, height: 12 });
      });
      for (const command of ["/history", "/undo example", "/health"]) {
        await act(async () => {
          await screen?.mockInput.pressKeys([...command, "\r"]);
        });
        await screen?.renderOnce();
        expect(screen?.captureCharFrame()).not.toContain(command);
      }
      expect(submitted).toEqual(["/history", "/undo example", "/health"]);
      accept = false;
      await act(async () => {
        await screen?.mockInput.pressKeys([..."Keep this unsent thought", "\r"]);
      });
      await screen?.renderOnce();
      expect(screen?.captureCharFrame()).toContain("Keep this unsent thought");
    } finally {
      await act(async () => {
        screen?.renderer.destroy();
      });
    }
  },
);
