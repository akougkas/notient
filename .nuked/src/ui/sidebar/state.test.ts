import { describe, expect, test } from "bun:test";
import { type SidebarTab, activeTab, setActiveTab } from "./state";

describe("sidebar state", () => {
  test("defaults to stream", () => {
    expect(activeTab.value).toBe("stream");
  });

  test("setActiveTab updates the signal", () => {
    setActiveTab("vitals");
    expect(activeTab.value).toBe("vitals");
    setActiveTab("chat");
    expect(activeTab.value).toBe("chat");
    setActiveTab("stream");
    expect(activeTab.value).toBe("stream");
  });

  test("rejects unknown tabs at the type boundary", () => {
    const valid: SidebarTab[] = ["stream", "vitals", "chat"];
    for (const tab of valid) {
      setActiveTab(tab);
      expect(activeTab.value).toBe(tab);
    }
  });
});
