import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { PendingApproval } from "../../../core/chat/approvalGate";
import { ApprovalCard } from "./ApprovalCard";

function pending(): PendingApproval {
  return {
    callId: "tc-1",
    toolName: "notes.create",
    args: { path: "n.md", content: "x" },
    preview: "+ first line\n+ second line",
    resolve: () => undefined,
  };
}

describe("ApprovalCard", () => {
  test("renders diff preview and approve/reject buttons in safe mode", () => {
    const html = render(<ApprovalCard pending={pending()} />);
    expect(html).toContain("notient-chat-approval");
    expect(html).toContain("notes.create");
    expect(html).toContain("+ first line");
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
  });

  test("renders auto-approved pill in yolo mode", () => {
    const html = render(<ApprovalCard pending={pending()} autoApproved historyId="hist-1" />);
    expect(html).toContain("notient-chat-approval--auto");
    expect(html).toContain("Auto-approved");
    expect(html).toContain("Undo");
  });

  test("auto-approved pill omits undo when no historyId is supplied", () => {
    const html = render(<ApprovalCard pending={pending()} autoApproved />);
    expect(html).toContain("notient-chat-approval--auto");
    expect(html).not.toContain("Undo");
  });
});
