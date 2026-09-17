import { expect, test } from "bun:test";
import type {
  SettingsChangeEntry,
  SettingsChangeJournal,
  SettingsTransaction,
} from "../../../../src/core/settings/changeJournal";
import { resolveSettings } from "../../../../src/core/settings/envOverrides";
import { SettingsService } from "../../../../src/core/settings/settingsService";
import { DEFAULT_NOTIENT_CONFIG } from "../../../../src/core/settings/types";

function fixture() {
  const config = structuredClone(DEFAULT_NOTIENT_CONFIG);
  let raw = JSON.stringify(config);
  let writes = 0;
  let failReceipt = false;
  const entries = new Map<string, SettingsChangeEntry>();
  const journal: SettingsChangeJournal = {
    get: async (id) => structuredClone(entries.get(id) ?? null),
    save: async (id, entry) => {
      if (failReceipt && entry.state === "committed") throw new Error("receipt unavailable");
      entries.set(id, structuredClone(entry));
    },
  };
  const boot = () =>
    new SettingsService(resolveSettings(JSON.parse(raw), {}), {
      config,
      load: async () => raw,
      compareAndSwap: async (before, after, authorize) => {
        if (before !== raw) return false;
        await authorize?.();
        raw = after;
        writes++;
        return true;
      },
    });
  const transaction = (request: unknown, key = "same-key"): SettingsTransaction => ({
    journal,
    caller: { id: "human", kind: "human" },
    key,
    request,
    authorize: () => {},
  });
  return {
    boot,
    transaction,
    writes: () => writes,
    entries,
    failReceipt: (fail: boolean) => {
      failReceipt = fail;
    },
    edit: (paused: boolean) => {
      const config = JSON.parse(raw);
      config.background.paused = paused;
      raw = JSON.stringify(config);
    },
  };
}
test("lost configuration receipt recovers from exact file, survives reboot and cannot undo a later edit", async () => {
  const f = fixture();
  const service = f.boot();
  const before = service.background();
  const next = structuredClone(before.settings);
  next.paused = true;
  const tx = f.transaction({ paused: true, revision: before.revision });
  f.failReceipt(true);
  await expect(service.updateBackground(next, before.revision, tx)).rejects.toThrow(
    "receipt unavailable",
  );
  expect(service.background().settings.paused).toBe(true);
  expect(f.writes()).toBe(1);
  f.failReceipt(false);
  const reboot = f.boot();
  const recovered = await reboot.updateBackground(next, before.revision, tx);
  expect(recovered.replayed).toBe(true);
  expect(recovered.settings.paused).toBe(true);
  f.edit(false);
  await reboot.refreshBackground();
  expect((await reboot.updateBackground(next, before.revision, tx)).replayed).toBe(true);
  expect(reboot.background().settings.paused).toBe(false);
  expect(f.writes()).toBe(1);
  await expect(
    reboot.updateBackground(next, before.revision, f.transaction({ paused: false })),
  ).rejects.toThrow("different configuration inputs");
});
test("an ambiguous interrupted save followed by operator edits never replays the old effect", async () => {
  const f = fixture();
  const service = f.boot();
  const before = service.background();
  const next = structuredClone(before.settings);
  next.paused = true;
  const tx = f.transaction({ paused: true });
  f.failReceipt(true);
  await expect(service.updateBackground(next, before.revision, tx)).rejects.toThrow();
  f.edit(false);
  f.failReceipt(false);
  await expect(f.boot().updateBackground(next, before.revision, tx)).rejects.toThrow(
    "cannot be confirmed",
  );
  expect(f.writes()).toBe(1);
  expect([...f.entries.values()][0].state).toBe("abandoned");
});
test("revocation after intent persistence blocks the configuration write, including an explicit retry", async () => {
  const f = fixture();
  const service = f.boot();
  const before = service.background();
  const next = structuredClone(before.settings);
  next.paused = true;
  const tx = f.transaction({ paused: true });
  let checks = 0;
  tx.authorize = () => {
    if (++checks > 2) throw new Error("revoked immediately before effect");
  };
  await expect(service.updateBackground(next, before.revision, tx)).rejects.toThrow("revoked");
  expect(f.writes()).toBe(0);
  tx.authorize = () => {};
  await expect(service.updateBackground(next, before.revision, tx)).rejects.toThrow(
    "cannot be confirmed",
  );
  expect(service.background().settings.paused).toBe(false);
});
test("chat budget changes commit through the same journal, apply to the next snapshot and preserve other sections", async () => {
  const f = fixture();
  const service = f.boot();
  const before = service.chatBudget();
  const background = service.background().revision;
  const next = { ...before.budget, modelCalls: 3, durationMs: 45000 };
  const tx = f.transaction({ budget: next, revision: before.revision }, "budget-key");
  const saved = await service.updateChatBudget(next, before.revision, tx);
  expect(saved).toMatchObject({ ok: true, budget: next, replayed: false });
  expect(service.get().chat.budget).toEqual(next);
  expect(service.background().revision).toBe(background);
  expect(f.boot().chatBudget().budget).toEqual(next);
  expect((await service.updateChatBudget(next, before.revision, tx)).replayed).toBe(true);
  expect(f.writes()).toBe(1);
  await expect(
    service.updateChatBudget(
      { ...next, modelCalls: 4 },
      before.revision,
      f.transaction({ budget: { ...next, modelCalls: 4 } }, "stale-key"),
    ),
  ).rejects.toThrow("chat resource limits changed");
  await expect(
    service.updateChatBudget(
      { ...next, modelCalls: 0 },
      saved.revision,
      f.transaction({ budget: { ...next, modelCalls: 0 } }, "invalid-key"),
    ),
  ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  expect(f.writes()).toBe(1);
});
