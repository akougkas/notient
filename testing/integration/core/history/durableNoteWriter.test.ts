import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordId } from "surrealdb";
import { FsVault } from "../../../../src/adapters/fsVault";
import { VaultMutationBlockedError } from "../../../../src/adapters/vaultAdapter";
import { contentRevision } from "../../../../src/api/notes";
import { NoteApiError } from "../../../../src/api/schema";
import { ApprovalGate } from "../../../../src/core/chat/approvalGate";
import { assertToolApproval, assertToolTarget } from "../../../../src/core/chat/toolAuthority";
import { unwrapNativeValue } from "../../../../src/core/db/nativeValue";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { ChangeService } from "../../../../src/core/history/changeService";
import { DurableNoteWriter } from "../../../../src/core/history/durableNoteWriter";
import { EffectAuthorityRevoked } from "../../../../src/core/history/effectAuthority";
import { SessionGrants } from "../../../../src/core/services/sessionGrants";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

class MemoryVault {
  readonly files = new Map<string, string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    const body = this.files.get(path);
    if (body === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return body;
  }

  async createIfAbsent(path: string, body: string): Promise<boolean> {
    if (this.files.has(path)) return false;
    this.files.set(path, body);
    return true;
  }

  async writeIfUnchanged(path: string, before: string, after: string): Promise<boolean> {
    if (this.files.get(path) !== before) return false;
    this.files.set(path, after);
    return true;
  }
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] DurableNoteWriter", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "notient-durable-note-writer-"));
    handle = await startSurreal({
      dataDir: join(tempDir, "data"),
      secret: "durable-note-writer-secret",
      portFile: join(tempDir, "port"),
      pidFile: join(tempDir, "pid"),
      logLevel: "warn",
      hnswCacheMib: 64,
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: "durable-note-writer-secret",
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, "durable-note-writer-secret", {
      embedDim: 4,
      embedModel: "fixture",
    });
  }, 30_000);

  afterAll(async () => {
    await connection?.close();
    await handle?.stop();
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
  }, 30_000);

  test("[smoke] closes exact filesystem bytes into one native history receipt", async () => {
    const vault = new MemoryVault();
    vault.files.set("notes/a.md", "before\n");
    const writer = new DurableNoteWriter({
      db: connection.db,
      vault,
      hash: async (body) => createHash("sha256").update(body).digest("hex"),
      now: () => 10_000,
    });

    const result = await writer.apply({
      kind: "notes.append",
      target: "notes/a.md",
      before: "before\n",
      after: "before\nafter\n",
      clientIdentity: "human",
    });

    expect(result.applied).toBe(true);
    const [history] = await connection.db
      .query<
        [
          Array<{
            id: RecordId<"history">;
            kind: string;
            target: string;
            before: unknown;
            after: unknown;
          }>,
        ]
      >("SELECT id, kind, target, before, after FROM history;")
      .collect();
    expect(history).toHaveLength(1);
    expect(history[0]?.kind).toBe("notes.append");
    expect(history[0]?.target).toBe("notes/a.md");
    expect(unwrapNativeValue(history[0]?.before, "smoke before")).toBe("before\n");
    expect(unwrapNativeValue(history[0]?.after, "smoke after")).toBe("before\nafter\n");
    const [intents] = await connection.db
      .query<[Array<{ id: RecordId<"note_write_intent"> }>]>("SELECT id FROM note_write_intent;")
      .collect();
    expect(intents).toEqual([]);
  });

  test("real files: exact structural previews, reference-aware moves and idempotent retry", async () => {
    const root = join(tempDir, "vault");
    const vault = new FsVault(root, { recoveryDir: join(tempDir, "recovery") });
    await vault.createFolder("");
    const before =
      "\ufeff---\r\naliases: [Storage]\r\nstatus: draft # preserve\r\n---\r\n# Decision\r\nfirst\r\n# Decision\r\nsecond ^choice\r\n";
    await vault.createIfAbsent("Projects/Source.md", before);
    await vault.createIfAbsent(
      "Reference.md",
      "![[Projects/Source#^choice|Quoted]]\n[Read](Projects/Source.md#Decision)\n",
    );
    const writer = new DurableNoteWriter({
      db: connection.db,
      vault,
      hash: async (body) => createHash("sha256").update(body).digest("hex"),
    });
    const changes = new ChangeService({ db: connection.db, vault, writer });
    const caller = { id: "human", kind: "human" as const, scopes: ["read", "write", "admin"] };
    await expect(
      changes.preview(
        {
          idempotencyKey: "ambiguous-heading",
          changes: [
            {
              kind: "edit",
              source: { path: "Projects/Source.md", revision: contentRevision(before) },
              selector: { kind: "heading", text: "Decision" },
              replacement: "bad",
            },
          ],
        },
        caller,
      ),
    ).rejects.toThrow("ambiguous");
    const preview = await changes.preview(
      {
        idempotencyKey: "second-heading",
        changes: [
          {
            kind: "edit",
            source: { path: "Projects/Source.md", revision: contentRevision(before) },
            selector: { kind: "heading", text: "Decision", occurrence: 2 },
            replacement: "# Decision\r\nchanged ^choice\r\n",
          },
        ],
      },
      caller,
    );
    const request = {
      previewId: preview.previewId,
      previewRevision: preview.revision,
      idempotencyKey: "apply-heading",
    };
    const applied = await changes.apply(request, caller, new AbortController().signal);
    if (!applied.ok) throw new Error(JSON.stringify(applied));
    expect(applied.state).toBe("applied");
    expect(await changes.apply(request, caller, new AbortController().signal)).toEqual(applied);
    const edited = await vault.read("Projects/Source.md");
    expect(edited).toBe(before.replace("second ^choice", "changed ^choice"));
    const move = await changes.preview(
      {
        idempotencyKey: "archive-source",
        changes: [
          {
            kind: "archive",
            source: { path: "Projects/Source.md", revision: contentRevision(edited) },
            destination: "Archive/Source.md",
            updateReferences: true,
          },
        ],
      },
      caller,
    );
    expect(move.effects).toHaveLength(2);
    expect(move.effects[0].after).toBe(
      "![[Archive/Source#^choice|Quoted]]\n[Read](Archive/Source.md#Decision)\n",
    );
    const moveRequest = {
      previewId: move.previewId,
      previewRevision: move.revision,
      idempotencyKey: "apply-archive",
    };
    const moved = await changes.apply(moveRequest, caller, new AbortController().signal);
    if (!moved.ok) throw new Error(JSON.stringify(moved));
    expect(moved.state).toBe("applied");
    expect(await vault.exists("Projects/Source.md")).toBe(false);
    expect(await vault.read("Archive/Source.md")).toBe(edited);
    const restarted = new ChangeService({
      db: connection.db,
      vault,
      writer: new DurableNoteWriter({
        db: connection.db,
        vault,
        hash: async (body) => createHash("sha256").update(body).digest("hex"),
      }),
    });
    expect(await restarted.apply(moveRequest, caller, new AbortController().signal)).toEqual(moved);
  });

  test("Obsidian move previews property/definition updates and preserves moved-note attachment targets", async () => {
    const vault = new FsVault(join(tempDir, "obsidian-links"), {
      recoveryDir: join(tempDir, "obsidian-recovery"),
    });
    await vault.createFolder("");
    const source =
      "# Source\n[Sibling](Sibling.md#Top)\n![Diagram](../assets/diagram.svg)\n[[Sibling#Top|Related]]\n";
    const index =
      '---\nrelated: "[[Projects/Source#^proof|Source]]" # keep\n---\n[Read][ref] and [Again][ref]\n\n[ref]: Projects/Source.md#Top "Title"\n';
    await vault.createIfAbsent("Projects/Source.md", source);
    await vault.createIfAbsent("Projects/Sibling.md", "# Top\nA sibling.");
    await vault.createIfAbsent("Index.md", index);
    const writer = new DurableNoteWriter({
      db: connection.db,
      vault,
      hash: async (body) => contentRevision(body),
    });
    const changes = new ChangeService({ db: connection.db, vault, writer });
    const caller = { id: "human", kind: "human" as const, scopes: ["read", "write", "admin"] };
    const preview = await changes.preview(
      {
        idempotencyKey: "obsidian-links-move",
        changes: [
          {
            kind: "move",
            source: { path: "Projects/Source.md", revision: contentRevision(source) },
            destination: "Archive/Deep/Source.md",
            updateReferences: true,
          },
        ],
      },
      caller,
    );
    expect(preview.conflicts).toEqual([]);
    expect(preview.effects).toHaveLength(3);
    expect(await vault.read("Index.md")).toBe(index);
    const request = {
      previewId: preview.previewId,
      previewRevision: preview.revision,
      idempotencyKey: "obsidian-links-apply",
    };
    const applied = await changes.apply(request, caller, new AbortController().signal);
    expect(applied.state).toBe("applied");
    expect(await vault.read("Index.md")).toBe(
      index.replaceAll("Projects/Source", "Archive/Deep/Source"),
    );
    expect(await vault.read("Archive/Deep/Source.md")).toBe(
      "# Source\n[Sibling](../../Projects/Sibling.md#Top)\n![Diagram](../../assets/diagram.svg)\n[[Projects/Sibling#Top|Related]]\n",
    );
    expect(await changes.apply(request, caller, new AbortController().signal)).toEqual(applied);
    expect(await vault.exists("Projects/Source.md")).toBe(false);
  });

  test("dirty-editor veto and racing destination preserve both files", async () => {
    const root = join(tempDir, "guarded-vault");
    let dirty = false;
    const vault = new FsVault(root, {
      recoveryDir: join(tempDir, "guarded-recovery"),
      beforeMutation: async () => {
        if (dirty) throw new Error("editor has unsaved changes");
        return undefined;
      },
    });
    await vault.createFolder("");
    await vault.createIfAbsent("from.md", "source");
    await vault.createIfAbsent("to.md", "human destination");
    expect(await vault.moveIfUnchanged("from.md", "to.md", "source")).toBe(false);
    expect(await vault.read("from.md")).toBe("source");
    expect(await vault.read("to.md")).toBe("human destination");
    dirty = true;
    await expect(vault.writeIfUnchanged("from.md", "source", "new")).rejects.toThrow("unsaved");
    await expect(vault.moveIfUnchanged("from.md", "clean.md", "source")).rejects.toThrow("unsaved");
    expect(await vault.read("from.md")).toBe("source");
  });

  test("revocation during editor acknowledgement cannot replay a refused effect after restart", async () => {
    const root = join(tempDir, "revoked-vault");
    let authorized = true;
    let guardEnabled = false;
    const vault = new FsVault(root, {
      recoveryDir: join(tempDir, "revoked-recovery"),
      beforeMutation: async () => {
        if (guardEnabled) authorized = false;
        return undefined;
      },
    });
    await vault.createFolder("");
    await vault.createIfAbsent("note.md", "original");
    const options = {
      db: connection.db,
      vault,
      hash: async (body: string) => contentRevision(body),
    };
    guardEnabled = true;
    await expect(
      new DurableNoteWriter(options).apply({
        kind: "notes.append",
        target: "note.md",
        before: "original",
        after: "changed",
        clientIdentity: "revoked-human",
        idempotencyKey: "revoked-during-guard",
        authorize: async () => {
          if (!authorized) throw new Error("permission revoked");
        },
      }),
    ).rejects.toThrow("permission revoked");
    expect(await vault.read("note.md")).toBe("original");
    guardEnabled = false;
    const recovery = await new DurableNoteWriter(options).reconcilePendingWrites();
    expect(recovery.replayed).toBe(0);
    expect(await vault.read("note.md")).toBe("original");
  });

  test("recovery checks the applying human credential, not the preview owner", async () => {
    const root = join(tempDir, "recover-caller");
    let blocked = false;
    let authorized = true;
    const vault = new FsVault(root, {
      recoveryDir: join(tempDir, "recover-caller-state"),
      beforeMutation: async () => {
        if (blocked) throw new VaultMutationBlockedError("editor disconnected");
        return undefined;
      },
    });
    await vault.createFolder("");
    await vault.createIfAbsent("Note.md", "original");
    const writer = new DurableNoteWriter({
      db: connection.db,
      vault,
      hash: async (body) => contentRevision(body),
      authorizeRecovery: async (intent) => {
        if (intent.previewId)
          await changes.authorizeRecoveredEffect({ previewId: intent.previewId }, intent);
      },
    });
    const changes = new ChangeService({
      db: connection.db,
      vault,
      writer,
      authorizeCaller: (caller) => {
        expect(caller.id).toBe("paired-operator");
        if (!authorized)
          throw new NoteApiError("FORBIDDEN", "credential revoked while daemon was down");
      },
    });
    const owner = { id: "agent-preview-owner", kind: "agent" as const, scopes: ["read", "write"] };
    const human = { id: "paired-operator", kind: "human" as const, scopes: ["read", "write"] };
    const preview = await changes.preview(
      {
        idempotencyKey: "caller-recovery",
        changes: [
          {
            kind: "append",
            source: { path: "Note.md", revision: contentRevision("original") },
            text: "after",
          },
        ],
      },
      owner,
    );
    blocked = true;
    const result = await changes.apply(
      {
        previewId: preview.previewId,
        previewRevision: preview.revision,
        idempotencyKey: "operator-approve",
      },
      human,
      new AbortController().signal,
    );
    expect(result.state).toBe("conflict");
    expect(await vault.read("Note.md")).toBe("original");
    authorized = false;
    blocked = false;
    const recovered = await writer.reconcilePendingWrites();
    expect(recovered.abandoned).toBe(1);
    expect(recovered.failed).toBe(0);
    expect(await vault.read("Note.md")).toBe("original");
    expect((await changes.get(preview.previewId, human)).effects).toHaveLength(1);
  });

  test("an authorized stored preview survives a disconnect and checks authority again after host acknowledgement", async () => {
    const root = join(tempDir, "recover-valid");
    let blocked = false;
    let revokeDuringGuard = false;
    let authorized = true;
    const vault = new FsVault(root, {
      recoveryDir: join(tempDir, "recover-valid-state"),
      beforeMutation: async () => {
        if (blocked) throw new VaultMutationBlockedError("host offline");
        if (revokeDuringGuard) authorized = false;
        return undefined;
      },
    });
    await vault.createFolder("");
    const caller = { id: "paired-valid", kind: "human" as const, scopes: ["read", "write"] };
    const writer = new DurableNoteWriter({
      db: connection.db,
      vault,
      hash: async (body) => contentRevision(body),
      authorizeRecovery: async (intent) => {
        if (intent.previewId)
          await changes.authorizeRecoveredEffect({ previewId: intent.previewId }, intent);
      },
    });
    const changes = new ChangeService({
      db: connection.db,
      vault,
      writer,
      authorizeCaller: () => {
        if (!authorized) throw new NoteApiError("FORBIDDEN", "revoked");
      },
    });
    for (const denied of [false, true]) {
      const path = denied ? "Refused.md" : "Recovered.md";
      const preview = await changes.preview(
        {
          idempotencyKey: path,
          changes: [{ kind: "create", path, expected: null, body: "exact draft" }],
        },
        caller,
      );
      blocked = true;
      await changes.apply(
        { previewId: preview.previewId, previewRevision: preview.revision, idempotencyKey: path },
        caller,
        new AbortController().signal,
      );
      blocked = false;
      revokeDuringGuard = denied;
      const result = await writer.reconcilePendingWrites();
      expect(result.failed).toBe(0);
      expect(result[denied ? "abandoned" : "replayed"]).toBe(1);
      expect(await vault.exists(path)).toBe(!denied);
    }
    expect(await vault.read("Recovered.md")).toBe("exact draft");
  });
  for (const scenario of [
    "valid-last-slot",
    "revoked-grant",
    "expired-grant",
    "disabled-policy",
    "revoked-operator",
    "revoked-client",
    "cancelled-at-editor",
  ] as const) {
    test(`tool intent recovery: ${scenario}`, async () => {
      let now = 1_000;
      let blocked = true;
      let revoked = "";
      let automatic = true;
      const controller = new AbortController();
      const grants = new SessionGrants({ db: connection.db, now: () => now });
      const clientIdentity = `agent-${scenario}`;
      const usesGrant = ["valid-last-slot", "revoked-grant", "expired-grant"].includes(scenario);
      const grant = usesGrant
        ? await grants.grant({
            client: clientIdentity,
            allowedFolders: ["Inbox/"],
            allowedTools: ["notes.create"],
            maxWrites: 1,
            ttlMinutes: 1,
          })
        : null;
      const authorize = (proof: Parameters<typeof assertToolApproval>[0]) =>
        assertToolApproval(proof, {
          authorizeIdentity: (id) => {
            if (id === revoked) throw new EffectAuthorityRevoked("credential revoked");
          },
          grant: (id) => grants.get(id),
          policy: async () => ({ approvalMode: automatic ? "yolo" : "safe", perTool: {} }),
          now: () => now,
        });
      const gate = new ApprovalGate({
        sessionGrants: grants,
        perToolPolicy: () => ({}),
        authorize,
        recordHistoryAutoApprove: async () => {},
        now: () => now,
      });
      const operator = {
        id: "paired-operator",
        kind: "human" as const,
        scopes: ["read", "write", "admin"],
      };
      gate.subscribe({
        onPending: (call) => {
          gate.resolve(call.callId, { approved: true }, operator);
        },
        onResolved: () => {},
      });
      const target = `Inbox/${scenario}.md`;
      const decision = await gate.request(
        { id: scenario, name: "notes.create", args: { notePath: target, body: "approved text" } },
        scenario === "revoked-operator" ? "safe" : "yolo",
        "create",
        controller.signal,
        { clientIdentity },
      );
      const vault = new FsVault(join(tempDir, `tool-${scenario}`), {
        recoveryDir: join(tempDir, `tool-state-${scenario}`),
        beforeMutation: async () => {
          if (scenario === "cancelled-at-editor") {
            controller.abort();
            return undefined;
          }
          if (blocked) throw new VaultMutationBlockedError("host disconnected");
          return undefined;
        },
      });
      const options = {
        db: connection.db,
        vault,
        hash: async (body: string) => contentRevision(body),
        authorizeRecovery: async (
          intent: Parameters<
            NonNullable<ConstructorParameters<typeof DurableNoteWriter>[0]["authorizeRecovery"]>
          >[0],
        ) => {
          if (!intent.toolApproval) throw new EffectAuthorityRevoked("missing tool approval");
          assertToolTarget(intent.toolApproval, intent.clientIdentity, { path: intent.target });
          await authorize(intent.toolApproval);
        },
      };
      await expect(
        new DurableNoteWriter(options).apply({
          kind: "notes.create",
          target,
          before: null,
          after: "approved text",
          clientIdentity,
          ...gate.writeGuard(decision, controller.signal),
        }),
      ).rejects.toThrow();
      expect(await vault.exists(target)).toBe(false);
      if (grant) expect((await grants.get(grant.id))?.usedWrites).toBe(1);
      if (scenario === "revoked-grant" && grant) await grants.revoke(grant.id);
      if (scenario === "expired-grant") now += 60_001;
      if (scenario === "disabled-policy") automatic = false;
      if (scenario === "revoked-operator") revoked = operator.id;
      if (scenario === "revoked-client") revoked = clientIdentity;
      blocked = false;
      const result = await new DurableNoteWriter(options).reconcilePendingWrites();
      const shouldApply = scenario === "valid-last-slot";
      expect(result.failed).toBe(0);
      expect(result.deferred).toBe(0);
      expect(result.replayed).toBe(shouldApply ? 1 : 0);
      if (scenario !== "cancelled-at-editor") expect(result.abandoned).toBe(shouldApply ? 0 : 1);
      expect(await vault.exists(target)).toBe(shouldApply);
      if (shouldApply) expect(await vault.read(target)).toBe("approved text");
    });
  }

  test("landed tool bytes close their receipt after revocation without replaying an effect", async () => {
    const target = "Inbox/landed.md";
    const root = join(tempDir, "tool-landed");
    let active = true;
    let effects = 0;
    class ReplyLostVault extends FsVault {
      override async createIfAbsent(...args: Parameters<FsVault["createIfAbsent"]>) {
        const applied = await super.createIfAbsent(...args);
        if (applied) {
          effects++;
          throw new Error("connection lost after effect");
        }
        return applied;
      }
    }
    const vault = new ReplyLostVault(root);
    const gate = new ApprovalGate({
      sessionGrants: { claim: async () => null },
      perToolPolicy: () => ({}),
      recordHistoryAutoApprove: async () => {},
      authorize: async () => {
        if (!active) throw new EffectAuthorityRevoked("revoked");
      },
    });
    const signal = new AbortController().signal;
    const decision = await gate.request(
      { id: "landed", name: "notes.create", args: { notePath: target } },
      "yolo",
      "create",
      signal,
      { clientIdentity: "agent-landed" },
    );
    const options = {
      db: connection.db,
      vault,
      hash: async (body: string) => contentRevision(body),
      authorizeRecovery: async () => {
        throw new EffectAuthorityRevoked("revoked");
      },
    };
    await expect(
      new DurableNoteWriter(options).apply({
        kind: "notes.create",
        target,
        before: null,
        after: "landed text",
        clientIdentity: "agent-landed",
        ...gate.writeGuard(decision, signal),
      }),
    ).rejects.toThrow("connection lost");
    active = false;
    expect(await new DurableNoteWriter(options).reconcilePendingWrites()).toEqual({
      replayed: 1,
      abandoned: 0,
      failed: 0,
      deferred: 0,
    });
    expect(await vault.read(target)).toBe("landed text");
    expect(effects).toBe(1);
    const [rows] = await connection.db
      .query<[Array<{ tool_approval: string }>]>(
        "SELECT tool_approval FROM history WHERE target = $target;",
        { target },
      )
      .collect();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].tool_approval).clientIdentity).toBe("agent-landed");
  });
});
