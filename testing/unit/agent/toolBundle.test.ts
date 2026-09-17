import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import { buildAgentToolRegistry } from "../../../src/agent/toolBundle";
import type { NoteAnalysis } from "../../../src/core/analysis/noteAnalysis";
import type { ApprovalService } from "../../../src/core/approvals/approvalService";
import { ApprovalGate } from "../../../src/core/chat/approvalGate";
import type { Agent, AgentRunResult } from "../../../src/core/coordinator/types";
import type { GraphService } from "../../../src/core/graph/graphService";
import type { ChangeService } from "../../../src/core/history/changeService";
import type { SearchPipeline } from "../../../src/core/search/searchPipeline";
import type { VitalsService } from "../../../src/core/vitals/vitalsService";

function noopAgent(name: Agent["name"]): Agent {
  return {
    name,
    usesReasoningModel: false,
    run: async (): Promise<AgentRunResult> => ({ proposals: 0 }),
  };
}

function makeDeps(): Parameters<typeof buildAgentToolRegistry>[0] {
  return {
    analysis: {} as NoteAnalysis,
    db: {} as Surreal,
    graph: {} as GraphService,
    searchPipeline: {} as SearchPipeline,
    vitalsService: {} as VitalsService,
    vaultFacade: { read: async () => "", readBounded: async () => "", isIndexablePath: () => true },
    notesFacade: {
      readNote: async () => "",
      exists: async () => false,
    },
    approvalGate: new ApprovalGate({
      recordHistoryAutoApprove: async () => {},
      perToolPolicy: () => ({}),
      sessionGrants: { claim: async () => null },
    }),
    approvalService: {} as ApprovalService,
    changes: {} as ChangeService,
    authorizeIdentity: () => {},
    hash: async () => "00",
    approvalMode: () => "yolo",
    applyWrite: async () => ({
      applied: true,
      historyId: 'history:u"00000000-0000-4000-8000-000000000001"',
    }),
    generateCallId: () => "call-1",
  };
}

describe("buildAgentToolRegistry", () => {
  test("registers all tool packages", () => {
    const registry = buildAgentToolRegistry(makeDeps());
    const names = registry.list().map((tool) => tool.name);
    expect(names).toContain("vault.search_notes");
    expect(names).toContain("vault.read_note");
    expect(names).toContain("vault.list_neighbors");
    expect(names).toContain("vault.get_vitals");
    expect(names).toContain("brief.run");
    expect(names).toContain("notes.compare");
    expect(names).toContain("notes.correlate");
    expect(names).toContain("notes.create");
    expect(names).toContain("notes.append");
    expect(names).toContain("notes.replace_section");
    expect(names).toContain("notes.update_frontmatter");
    expect(names).toContain("changes.preview");
    expect(names).toContain("changes.submit_for_review");
    expect(names).toContain("proposals.list_pending");
    expect(names).toContain("proposals.get");
    expect(names).toContain("proposals.approve");
    expect(names).toContain("proposals.reject");
    expect(names).toContain("graph.find_path");
  });

  test("write-style tools are flagged writeGated", () => {
    const registry = buildAgentToolRegistry(makeDeps());
    expect(registry.isWriteGated("notes.create")).toBe(true);
    expect(registry.isWriteGated("notes.append")).toBe(true);
    expect(registry.isWriteGated("notes.replace_section")).toBe(true);
    expect(registry.isWriteGated("notes.update_frontmatter")).toBe(true);
    expect(registry.isWriteGated("proposals.approve")).toBe(true);
    expect(registry.isWriteGated("proposals.reject")).toBe(true);
    expect(registry.isWriteGated("proposals.list_pending")).toBe(false);
    expect(registry.isWriteGated("proposals.get")).toBe(false);
    expect(registry.isWriteGated("vault.search_notes")).toBe(false);
    expect(registry.isWriteGated("vault.read_note")).toBe(false);
    expect(registry.isWriteGated("graph.find_path")).toBe(false);
  });
});
