import { randomUUID } from "node:crypto";
import { z } from "zod";
import { VaultMutationBlockedError } from "../adapters/vaultAdapter";
import type { HostCommand, HostReply } from "../api/host";
import { hostInputs, hostReplySchema } from "../api/host";
import { isCanonicalPublicNotePath } from "../core/vault/publicPath";
import { readPrivateJson, writePrivateJson } from "./ipcSecurity";
import type { PairingStore } from "./pairing";
import { type MethodDispatcher, type Principal, RpcError } from "./rpc";

const bindingsSchema = z
  .array(
    z.object({
      principal: z.object({
        id: z.string(),
        kind: z.literal("human"),
        scopes: z.array(z.string()),
      }),
      label: z.string().max(100),
    }),
  )
  .max(16);
type Binding = z.infer<typeof bindingsSchema>[number];
interface Pending {
  command: HostCommand;
  result: HostReply | null;
  resolve: (result: HostReply) => void;
  reject: (error: Error) => void;
}
interface Session {
  id: string;
  instance: string;
  seen: number;
  pending: Map<string, Pending>;
}

/** A paired desktop supplies finite native operations. It never supplies authority
 * to mutate the vault. Persisted attachment fails closed across disconnect/reboot. */
export class HostBridge {
  readonly epoch = randomUUID();
  private bindings: Binding[] = [];
  private sessions = new Map<string, Session>();
  private saving: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly path: string,
    private readonly pairing: Pick<PairingStore, "isActivePrincipal">,
    private readonly now = () => performance.now(),
  ) {}

  async load(): Promise<void> {
    try {
      this.bindings = bindingsSchema.parse(await readPrivateJson(this.path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  register(dispatcher: MethodDispatcher): void {
    dispatcher.register(
      "host.attach",
      async ({ params, principal }) => {
        const input = parse(hostInputs["host.attach"], params);
        this.assertHost(principal);
        const work = this.saving
          .catch(() => {})
          .then(async () => {
            this.assertHost(principal);
            const existing = this.sessions.get(principal.id);
            if (existing && existing.instance !== input.instanceId)
              throw new RpcError(
                "CONFLICT",
                "This pairing is already attached to another Obsidian window. Use a separate pairing.",
              );
            if (!this.bindings.some((b) => b.principal.id === principal.id)) {
              const next = this.activeBindings();
              if (next.length >= 16)
                throw new RpcError("LIMIT_EXCEEDED", "host attachment limit reached");
              next.push({ principal: { ...principal, kind: "human" }, label: input.label });
              await writePrivateJson(this.path, next);
              this.bindings = next;
            }
            const session = existing ?? {
              id: randomUUID(),
              instance: input.instanceId,
              seen: this.now(),
              pending: new Map(),
            };
            session.seen = this.now();
            this.sessions.set(principal.id, session);
            return { ok: true, sessionId: session.id, epoch: this.epoch };
          });
        this.saving = work;
        return work;
      },
      { kind: "host" },
    );
    dispatcher.register(
      "host.poll",
      async ({ params, principal }) => {
        const { sessionId } = parse(hostInputs["host.poll"], params);
        const session = this.session(principal, sessionId);
        session.seen = this.now();
        const pending = [...session.pending.values()];
        return {
          ok: true,
          epoch: this.epoch,
          commands: pending.filter((p) => !p.result).map((p) => p.command),
          guards: pending
            .filter((p) => p.command.kind === "guard")
            .map((p) => ({
              id: p.command.id,
              paths: p.command.kind === "guard" ? p.command.paths : [],
            })),
        };
      },
      { kind: "host" },
    );
    dispatcher.register(
      "host.reply",
      async ({ params, principal }) => {
        const input = parse(hostInputs["host.reply"], params);
        const session = this.session(principal, input.sessionId);
        const pending = session.pending.get(input.commandId);
        if (!pending) return { ok: true, accepted: false };
        if (input.result.kind !== "error" && input.result.kind !== pending.command.kind)
          throw new RpcError("INVALID_PARAMS", "host reply does not match the requested operation");
        if (pending.result && JSON.stringify(pending.result) !== JSON.stringify(input.result))
          throw new RpcError("CONFLICT", "host result changed after acknowledgement");
        pending.result = input.result;
        pending.resolve(input.result);
        return { ok: true, accepted: true };
      },
      { kind: "host" },
    );
    dispatcher.register(
      "host.status",
      async ({ params }) => {
        parse(hostInputs["host.status"], params);
        return {
          ok: true,
          hosts: this.activeBindings().map((b) => ({
            label: b.label,
            connected: this.live(this.sessions.get(b.principal.id)),
            pending: this.sessions.get(b.principal.id)?.pending.size ?? 0,
          })),
        };
      },
      { kind: "read" },
    );
    dispatcher.register(
      "host.context",
      async ({ params, signal }) => {
        parse(hostInputs["host.context"], params);
        const result = await this.request(
          this.singleHost(),
          { id: randomUUID(), kind: "context" },
          signal,
        );
        if (result.kind !== "context")
          throw new RpcError("CONFLICT", "host did not return editor context");
        return { ok: true, context: result.context };
      },
      { kind: "read" },
    );
    dispatcher.register(
      "host.open",
      async ({ params, principal, signal }) => {
        if (principal.kind !== "human")
          throw new RpcError("FORBIDDEN", "opening the operator's editor requires human authority");
        const { source } = parse(hostInputs["host.open"], params);
        const result = await this.request(
          this.singleHost(),
          { id: randomUUID(), kind: "open", source },
          signal,
        );
        if (result.kind !== "open" || !result.opened)
          throw new RpcError(
            "CONFLICT",
            result.kind === "open"
              ? (result.reason ?? "host did not open the source")
              : "unexpected host result",
          );
        return { ok: true, opened: true };
      },
      { kind: "write" },
    );
  }

  /** The returned guard is held through the actual filesystem operation, including
   * its rollback. The host keeps protected buffers read-only until a later poll
   * confirms release; a network outage never silently unlocks a pending write. */
  async beforeMutation(paths: string[]): Promise<(() => void) | undefined> {
    const publicPaths = [...new Set(paths.filter(isCanonicalPublicNotePath))];
    if (!publicPaths.length) return;
    const held: Array<{ session: Session; id: string }> = [];
    try {
      for (const binding of this.activeBindings()) {
        const session = this.requireLive(binding);
        const command: HostCommand = { id: randomUUID(), kind: "guard", paths: publicPaths };
        held.push({ session, id: command.id });
        const result = await this.request(binding, command, undefined, true);
        if (result.kind !== "guard" || !result.allowed)
          throw new RpcError(
            "CONFLICT",
            result.kind === "guard"
              ? (result.reason ?? "Obsidian refused this write")
              : "Obsidian did not guard this write",
          );
      }
      // A later host must not make the earlier host's revocation invisible.
      for (const binding of this.activeBindings()) this.requireLive(binding);
      return () => {
        for (const item of held) item.session.pending.delete(item.id);
      };
    } catch (error) {
      for (const item of held) item.session.pending.delete(item.id);
      if (error instanceof RpcError) throw new VaultMutationBlockedError(error.message);
      throw error;
    }
  }
  hasAttachedHosts(): boolean {
    return this.activeBindings().length > 0;
  }
  allConnected(): boolean {
    return this.activeBindings().every((binding) =>
      this.live(this.sessions.get(binding.principal.id)),
    );
  }
  private activeBindings(): Binding[] {
    return this.bindings.filter((b) => this.pairing.isActivePrincipal(b.principal));
  }
  private assertHost(principal: Principal): void {
    if (
      principal.kind !== "human" ||
      !principal.scopes.includes("host") ||
      !this.pairing.isActivePrincipal(principal)
    )
      throw new RpcError(
        "FORBIDDEN",
        "an active explicitly paired human host credential is required",
      );
  }
  private session(principal: Principal, id: string): Session {
    this.assertHost(principal);
    const session = this.sessions.get(principal.id);
    if (!session || session.id !== id)
      throw new RpcError("CONFLICT", "host session changed; attach again before polling");
    return session;
  }
  private live(session?: Session): boolean {
    return !!session && this.now() - session.seen < 5000;
  }
  private requireLive(binding: Binding): Session {
    const session = this.sessions.get(binding.principal.id);
    if (!this.live(session))
      throw new RpcError(
        "CONFLICT",
        `${binding.label} is disconnected. Reconnect Obsidian before changing notes, or explicitly revoke its pairing to release protection.`,
      );
    return session!;
  }
  private singleHost(): Binding {
    const bindings = this.activeBindings();
    if (bindings.length !== 1)
      throw new RpcError(
        "CONFLICT",
        bindings.length
          ? "More than one Obsidian host is attached; choose a single host before using editor actions."
          : "No Obsidian host is attached.",
      );
    this.requireLive(bindings[0]);
    return bindings[0];
  }
  private async request(
    binding: Binding,
    command: HostCommand,
    signal?: AbortSignal,
    hold = false,
  ): Promise<HostReply> {
    const session = this.requireLive(binding);
    if (session.pending.size >= 16)
      throw new RpcError("LIMIT_EXCEEDED", "host request queue is full");
    const bounded = AbortSignal.any([AbortSignal.timeout(4000), ...(signal ? [signal] : [])]);
    let abort = () => {};
    try {
      return await new Promise<HostReply>((resolve, reject) => {
        abort = () =>
          reject(
            new RpcError(
              "CONFLICT",
              "Obsidian host operation interrupted or timed out; completion was not confirmed",
            ),
          );
        bounded.addEventListener("abort", abort, { once: true });
        session.pending.set(command.id, {
          command,
          result: null,
          resolve: (result) => {
            if (!this.pairing.isActivePrincipal(binding.principal))
              return reject(new RpcError("FORBIDDEN", "host pairing was revoked"));
            if (result.kind === "error") reject(new RpcError("CONFLICT", result.message));
            else resolve(hostReplySchema.parse(result));
          },
          reject,
        });
        if (bounded.aborted) abort();
      });
    } catch (error) {
      session.pending.delete(command.id);
      throw error;
    } finally {
      bounded.removeEventListener("abort", abort);
      if (!hold) session.pending.delete(command.id);
    }
  }
}

function parse<T>(schema: z.ZodType<T>, params: unknown): T {
  const result = schema.safeParse(params);
  if (!result.success) throw new RpcError("INVALID_PARAMS", result.error.message);
  return result.data;
}
