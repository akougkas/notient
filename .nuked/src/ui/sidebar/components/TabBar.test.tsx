import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { activeTab, setActiveTab } from "../state";
import { TabBar } from "./TabBar";

describe("TabBar", () => {
  test("renders three tabs with the active one marked via aria-current", () => {
    setActiveTab("stream");
    const html = render(<TabBar pendingApprovals={3} />);
    expect(html).toContain('data-tab="stream"');
    expect(html).toContain('data-tab="vitals"');
    expect(html).toContain('data-tab="chat"');
    expect(html).toContain('aria-current="page"');
    // Reference activeTab to keep the signal import grounded.
    expect(activeTab.value).toBe("stream");
  });

  test("renders the pending-approvals badge on the stream tab when count > 0", () => {
    setActiveTab("stream");
    const withBadge = render(<TabBar pendingApprovals={3} />);
    expect(withBadge).toContain("notient-tabbar__count");
    expect(withBadge).toContain('data-pulse="true"');
    expect(withBadge).toContain(">3<");
    const withoutBadge = render(<TabBar pendingApprovals={0} />);
    expect(withoutBadge).not.toContain("notient-tabbar__count");
  });

  test("active tab reflects state.activeTab signal value", () => {
    setActiveTab("vitals");
    const html = render(<TabBar pendingApprovals={0} />);
    const vitalsActive = /data-tab="vitals"[^>]*aria-current="page"/.test(html);
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
