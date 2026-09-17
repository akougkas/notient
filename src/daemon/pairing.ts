import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import { assertPrivateDirectory, readPrivateJson, writePrivateJson } from "./ipcSecurity";
import { type Principal, RpcError } from "./rpc";

const principalSchema = z.object({
  id: z.string(),
  kind: z.enum(["human", "agent"]),
  scopes: z.array(z.enum(["read", "write", "admin", "host"])),
});
const credentialSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  principal: principalSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number(),
  revoked: z.boolean(),
});
const credentialsSchema = z.array(credentialSchema).max(100);
type Credential = z.infer<typeof credentialSchema>;
export const pairingRequestSchema = z
  .object({
    label: z.string().min(1).max(100),
    kind: z.enum(["human", "agent"]),
    scopes: z
      .array(z.enum(["read", "write", "admin", "host"]))
      .min(1)
      .max(4),
  })
  .strict();

/** Private reconnectable credentials. Only token hashes are persisted; pairing
 * codes are single-use, short-lived and created by an authenticated operator. */
export class PairingStore {
  private credentials: Credential[] = [];
  private codes = new Map<
    string,
    { request: z.infer<typeof pairingRequestSchema>; expires: number }
  >();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly revokedListeners = new Set<(principalId: string) => void>();
  constructor(
    private readonly path: string,
    readonly vaultId: string,
  ) {}
  async load(): Promise<void> {
    await assertPrivateDirectory(dirname(this.path));
    try {
      this.credentials = credentialsSchema.parse(await readPrivateJson(this.path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  create(
    input: unknown,
    principal: Principal,
  ): { code: string; expiresAt: number; vaultId: string } {
    requireOperator(principal);
    const parsed = pairingRequestSchema.safeParse(input);
    if (!parsed.success) throw new RpcError("INVALID_PARAMS", parsed.error.message);
    const request = parsed.data;
    if (request.kind === "agent" && request.scopes.some((s) => s === "admin" || s === "host"))
      throw new RpcError("FORBIDDEN", "agents cannot receive administration or host authority");
    for (const [key, pending] of this.codes)
      if (pending.expires < Date.now()) this.codes.delete(key);
    if (this.codes.size >= 8) throw new RpcError("LIMIT_EXCEEDED", "too many pending pairings");
    const code = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + 300000;
    this.codes.set(digest(code), { request, expires: expiresAt });
    return { code, expiresAt, vaultId: this.vaultId };
  }
  exchange(
    input: unknown,
  ): Promise<{ token: string; credentialId: string; principal: Principal; vaultId: string }> {
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        const parsed = z
          .object({ code: z.string().min(1).max(128), vaultId: z.string() })
          .strict()
          .safeParse(input);
        if (!parsed.success || parsed.data.vaultId !== this.vaultId)
          throw new RpcError("UNAUTHENTICATED", "pairing failed or vault identity does not match");
        const key = digest(parsed.data.code);
        const pending = this.codes.get(key);
        this.codes.delete(key);
        if (!pending || pending.expires < Date.now())
          throw new RpcError("UNAUTHENTICATED", "pairing code is invalid, expired or already used");
        if (this.credentials.length >= 100)
          throw new RpcError("LIMIT_EXCEEDED", "credential limit reached");
        const id = randomUUID();
        const token = randomBytes(32).toString("base64url");
        const principal: Principal = {
          id: `paired-${id}`,
          kind: pending.request.kind,
          scopes: pending.request.scopes,
        };
        const credential: Credential = {
          id,
          label: pending.request.label,
          principal: principalSchema.parse(principal),
          hash: digest(token),
          createdAt: Date.now(),
          revoked: false,
        };
        await this.save([...this.credentials, credential]);
        return { token, credentialId: id, principal, vaultId: this.vaultId };
      });
    this.tail = operation;
    return operation;
  }
  authenticate(token: string): { principal: Principal; credentialId: string } {
    const hash = Buffer.from(digest(token), "hex");
    const credential = this.credentials.find(
      (entry) => !entry.revoked && timingSafeEqual(hash, Buffer.from(entry.hash, "hex")),
    );
    if (!credential) throw new RpcError("UNAUTHENTICATED", "invalid or revoked credential");
    return { principal: structuredClone(credential.principal), credentialId: credential.id };
  }
  /** Detached jobs retain an identity, never a bearer token. Verify that saved
   * identity and scopes against the current credential authority before effects. */
  isActivePrincipal(principal: Principal): boolean {
    return this.credentials.some(
      (entry) =>
        !entry.revoked &&
        entry.principal.id === principal.id &&
        entry.principal.kind === principal.kind &&
        principal.scopes.every((scope) =>
          entry.principal.scopes.some((allowed) => allowed === scope),
        ),
    );
  }
  hasActiveScope(id: string, scope: "write" | "admin"): boolean {
    return this.credentials.some(
      (entry) =>
        !entry.revoked &&
        entry.principal.id === id &&
        entry.principal.scopes.includes(scope) &&
        (scope !== "admin" || entry.principal.kind === "human"),
    );
  }
  onRevoked(listener: (principalId: string) => void): () => void {
    this.revokedListeners.add(listener);
    return () => this.revokedListeners.delete(listener);
  }
  list(principal: Principal) {
    requireOperator(principal);
    return this.credentials.map(({ hash: _hash, ...entry }) => entry);
  }
  revoke(id: string, principal: Principal): Promise<void> {
    requireOperator(principal);
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        if (!this.credentials.some((entry) => entry.id === id))
          throw new RpcError("NOT_FOUND", "credential does not exist");
        await this.save(
          this.credentials.map((entry) => (entry.id === id ? { ...entry, revoked: true } : entry)),
        );
        const credential = this.credentials.find((entry) => entry.id === id);
        if (credential)
          for (const listener of this.revokedListeners) listener(credential.principal.id);
      });
    this.tail = operation;
    return operation;
  }
  private async save(credentials: Credential[]): Promise<void> {
    await writePrivateJson(this.path, credentials);
    this.credentials = credentials;
  }
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function requireOperator(principal: Principal): void {
  if (principal.kind !== "human" || !principal.scopes.includes("admin"))
    throw new RpcError("FORBIDDEN", "pairing administration requires the human operator");
}
