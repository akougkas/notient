import { describe, expect, test } from "bun:test";
import type { ContradictionHunter } from "../core/agents/contradictionHunter";
import type { Synthesizer } from "../core/agents/synthesizer";
import { ApprovalGate } from "../core/chat/approvalGate";
import type { Database } from "../core/db/database";
import { EventBus } from "../core/events/eventBus";
import type { SearchPipeline } from "../core/search/searchPipeline";
import type { VitalsService } from "../core/vitals/vitalsService";
import { buildAgentToolRegistry } from "./toolBundle";

function makeDeps(): Parameters<typeof buildAgentToolRegistry>[0] {
  return {
    database: {} as Database,
    searchPipeline: {} as SearchPipeline,
    vitalsService: {} as VitalsService,
    vaultFacade: { readNote: async () => "" },
    notesFacade: {
      readNote: async () => "",
      writeNote: async () => {},
      exists: async () => false,
    },
    approvalGate: new ApprovalGate({
      events: { onPending: () => {}, onResolved: () => {} },
      recordHistoryAutoApprove: async () => {},
      sessionGrants: { find: () => null, incrementWriteCount: () => {} },
    }),
    echoGuard: { mark: () => {} },
    hash: async () => "00",
    approvalMode: () => "yolo",
    recordHistory: async () => "history:fake-0",
    generateCallId: () => "call-1",
    contradictionHunter: {} as ContradictionHunter,
    synthesizer: {} as Synthesizer,
    clusterCache: null,
    bus: new EventBus(),
  };
}

describe("buildAgentToolRegistry", () => {
  test("registers all five tool packages", () => {
    const registry = buildAgentToolRegistry(makeDeps());
    const names = registry.list().map((tool) => tool.name);
    expect(names).toContain("vault.search_notes");
    expect(names).toContain("vault.read_note");
    expect(names).toContain("vault.list_neighbors");
    expect(names).toContain("vault.get_vitals");
    expect(names).toContain("notes.create");
    expect(names).toContain("notes.append");
    expect(names).toContain("notes.replace_section");
    expect(names).toContain("notes.update_frontmatter");
    expect(names).toContain("proposals.list_pending");
    expect(names).toContain("proposals.get");
    expect(names).toContain("graph.find_path");
    expect(names).toContain("graph.list_clusters");
    expect(names).toContain("agents.contradiction_check");
    expect(names).toContain("agents.synthesize");
  });

  test("write-style tools are flagged writeGated", () => {
    const registry = buildAgentToolRegistry(makeDeps());
    expect(registry.isWriteGated("notes.create")).toBe(true);
    expect(registry.isWriteGated("notes.append")).toBe(true);
    expect(registry.isWriteGated("notes.replace_section")).toBe(true);
    expect(registry.isWriteGated("notes.update_frontmatter")).toBe(true);
    expect(registry.isWriteGated("vault.search_notes")).toBe(false);
    expect(registry.isWriteGated("vault.read_note")).toBe(false);
    expect(registry.isWriteGated("graph.find_path")).toBe(false);
  });
});
