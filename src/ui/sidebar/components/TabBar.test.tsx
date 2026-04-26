import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { activeTab, setActiveTab } from "../state";
import { TabBar } from "./TabBar";

describe("TabBar", () => {
  test("renders three tabs with the active one marked", () => {
    setActiveTab("stream");
    const html = render(<TabBar pendingApprovals={3} />);
    expect(html).toContain('data-tab="stream"');
    expect(html).toContain('data-tab="vitals"');
    expect(html).toContain('data-tab="chat"');
    expect(html).toContain("notient-tab--active");
    // Reference activeTab to keep the signal import grounded.
    expect(activeTab.value).toBe("stream");
  });

  test("renders the pending-approvals badge on the stream tab when count > 0", () => {
    setActiveTab("stream");
    const withBadge = render(<TabBar pendingApprovals={3} />);
    expect(withBadge).toContain("notient-tab__badge");
    expect(withBadge).toContain(">3<");
    const withoutBadge = render(<TabBar pendingApprovals={0} />);
    expect(withoutBadge).not.toContain("notient-tab__badge");
  });

  test("active tab reflects state.activeTab signal value", () => {
    setActiveTab("vitals");
    const html = render(<TabBar pendingApprovals={0} />);
    const vitalsActive = /data-tab="vitals"[^>]*notient-tab--active/.test(html);
    expect(vitalsActive).toBe(true);
  });

  test("renders all tab labels", () => {
    setActiveTab("stream");
    const html = render(<TabBar pendingApprovals={0} />);
    expect(html).toContain("Stream");
    expect(html).toContain("Vitals");
    expect(html).toContain("Chat");
  });
});
