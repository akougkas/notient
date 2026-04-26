import { describe, expect, test } from "bun:test";
// Render function exercised manually via Obsidian; model state asserted here.
import { CoAuthorPanelModel } from "./coAuthorRender";

describe("CoAuthorPanelModel", () => {
  test("starts in idle state", () => {
    const model = new CoAuthorPanelModel();
    const state = model.snapshot();
    expect(state.status).toBe("idle");
    expect(state.notePath).toBeNull();
    expect(state.sections).toEqual({ summary: "", implies: "", connects: "" });
  });

  test("startStream switches to streaming and clears sections", () => {
    const model = new CoAuthorPanelModel();
    model.appendSection("summary", "leftover");
    model.startStream("/a.md");
    const state = model.snapshot();
    expect(state.status).toBe("streaming");
    expect(state.notePath).toBe("/a.md");
    expect(state.sections).toEqual({ summary: "", implies: "", connects: "" });
  });

  test("appendSection accumulates deltas per section", () => {
    const model = new CoAuthorPanelModel();
    model.startStream("/a.md");
    model.appendSection("summary", "A short take.");
    model.appendSection("summary", " More.");
    model.appendSection("implies", "X follows.");
    model.appendSection("connects", "- [[B]]: reason");
    const state = model.snapshot();
    expect(state.sections.summary).toBe("A short take. More.");
    expect(state.sections.implies).toBe("X follows.");
    expect(state.sections.connects).toBe("- [[B]]: reason");
  });

  test("appendSectionForNote starts the matching stream when active-note event was missed", () => {
    const model = new CoAuthorPanelModel();
    model.appendSectionForNote("/late.md", "summary", "First delta.");
    const state = model.snapshot();
    expect(state.notePath).toBe("/late.md");
    expect(state.status).toBe("streaming");
    expect(state.sections.summary).toBe("First delta.");
  });

  test("finish, cancel, and reset transition status correctly and notify subscribers", () => {
    const model = new CoAuthorPanelModel();
    let ticks = 0;
    const off = model.subscribe(() => {
      ticks++;
    });
    model.startStream("/a.md");
    model.finish(true);
    expect(model.snapshot().status).toBe("done");
    model.cancel();
    expect(model.snapshot().status).toBe("cancelled");
    model.reset();
    expect(model.snapshot().status).toBe("idle");
    expect(ticks).toBeGreaterThanOrEqual(4);
    off();
  });
});
