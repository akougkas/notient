import { expect, test } from "bun:test";
import type {
  SettingsChangeEntry,
  SettingsChangeJournal,
} from "../../../../src/core/settings/changeJournal";
import { resolveSettings } from "../../../../src/core/settings/envOverrides";
import { SettingsService } from "../../../../src/core/settings/settingsService";
import { DEFAULT_NOTIENT_CONFIG } from "../../../../src/core/settings/types";
import { makeChatSettingsHandlers } from "../../../../src/daemon/handlers/chatSettings";
import { agentPrincipal, rpcRequest } from "../../../rpcRequest";

function harness(authorize: () => void = () => {}) {
  const config = structuredClone(DEFAULT_NOTIENT_CONFIG);
  let raw = JSON.stringify(config);
  const entries = new Map<string, SettingsChangeEntry>();
  const journal: SettingsChangeJournal = {
    get: async (id) => entries.get(id) ?? null,
    save: async (id, entry) => {
      entries.set(id, entry);
    },
  };
  const settings = new SettingsService(resolveSettings(JSON.parse(raw), {}), {
    config,
    load: async () => raw,
    compareAndSwap: async (before, after) => {
      if (before !== raw) return false;
      raw = after;
      return true;
    },
  });
  return {
    settings,
    raw: () => raw,
    handlers: makeChatSettingsHandlers({ settings, journal, authorize }),
    setRaw: (next: string) => {
      raw = next;
    },
  };
}
const human = { id: "operator", kind: "human" as const, scopes: ["read", "write", "admin"] };

test("chat settings reads adopt operator file edits and only a live human administrator saves", async () => {
  const h = harness();
  const current = await h.handlers.get(rpcRequest({}, { principal: human }));
  const edited = JSON.parse(h.raw());
  edited.chat.budget.modelCalls = 5;
  h.setRaw(JSON.stringify(edited));
  const refreshed = await h.handlers.get(rpcRequest({}, { principal: agentPrincipal() }));
  expect(refreshed.budget.modelCalls).toBe(5);
  expect(refreshed.revision).not.toBe(current.revision);
  expect(h.settings.get().chat.budget.modelCalls).toBe(5);
  const request = {
    budget: { ...refreshed.budget, tokens: 64000 },
    revision: refreshed.revision,
    idempotencyKey: "save-budget",
  };
  await expect(
    h.handlers.configure(rpcRequest(request, { principal: agentPrincipal() })),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    h.handlers.configure(rpcRequest({ ...request, extra: true }, { principal: human })),
  ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  const saved = await h.handlers.configure(rpcRequest(request, { principal: human }));
  expect(saved).toMatchObject({ budget: { tokens: 64000 }, replayed: false });
  expect(JSON.parse(h.raw()).chat.budget.tokens).toBe(64000);
  const revoked = harness(() => {
    throw new Error("credential revoked");
  });
  const before = await revoked.handlers.get(rpcRequest({}, { principal: human }));
  await expect(
    revoked.handlers.configure(
      rpcRequest(
        { budget: before.budget, revision: before.revision, idempotencyKey: "k" },
        { principal: human },
      ),
    ),
  ).rejects.toThrow("credential revoked");
});
