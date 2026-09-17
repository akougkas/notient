import { z } from "zod";
import { EffectAuthorityRevoked } from "../history/effectAuthority";
import type { SessionGrant } from "../services/sessionGrants";
import { NOTIENT_PROPOSALS_FOLDER, isCanonicalPublicNotePath } from "../vault/publicPath";
import type { ApprovalMode, ToolCall } from "./types";

const operatorSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("human"),
    scopes: z.array(z.string()),
  })
  .strict();
export type ApprovalOperator = z.infer<typeof operatorSchema>;
export const toolApprovalSchema = z
  .object({
    clientIdentity: z.string().min(1),
    tool: z.string().min(1),
    paths: z.array(z.string()).max(200),
    edgeId: z.string().nullable(),
    permission: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("human"), operator: operatorSchema }).strict(),
      z
        .object({
          kind: z.literal("session"),
          id: z.string().min(1),
          claimedWrite: z.number().int().positive(),
          /** Older durable approvals reserved exactly one slot. */
          claimedWrites: z.number().int().positive().optional(),
        })
        .strict(),
      z.object({ kind: z.literal("policy") }).strict(),
    ]),
  })
  .strict();
export type ToolApproval = z.infer<typeof toolApprovalSchema>;

/** Domain-planned batch targets also determine how many write slots to reserve.
 * Extra model arguments on ordinary note tools cannot redefine their effects. */
export function toolApprovalPaths(call: ToolCall): string[] {
  if (call.name === "agent.distill") {
    const prefix = `${NOTIENT_PROPOSALS_FOLDER}/`;
    const paths = z
      .array(
        z
          .string()
          .refine(
            (path) =>
              isCanonicalPublicNotePath(path) &&
              path.startsWith(prefix) &&
              !path.slice(prefix.length).includes("/"),
          ),
      )
      .min(1)
      .max(200)
      .parse(call.args.proposalPaths);
    if (new Set(paths).size !== paths.length || paths[0] !== call.args.path)
      throw new Error("distillation approval requires distinct exact planned paths");
    return paths;
  }
  const path = call.args.notePath ?? call.args.path;
  return typeof path === "string" ? [path] : [];
}

/** Private attribution carried with exact write intents, never accepted from tool arguments. */
export function toolApproval(
  call: ToolCall,
  clientIdentity: string,
  permission: ToolApproval["permission"],
): ToolApproval {
  const paths = toolApprovalPaths(call);
  return toolApprovalSchema.parse({
    clientIdentity,
    tool: call.name,
    paths,
    edgeId:
      call.name === "proposals.approve" && typeof call.args.id === "string" ? call.args.id : null,
    permission,
  });
}

export interface ToolAuthorityChecks {
  authorizeIdentity: (id: string, scope: "write" | "admin") => void | Promise<void>;
  grant: (id: string) => Promise<SessionGrant | null>;
  policy: () => Promise<{ approvalMode: ApprovalMode; perTool: Record<string, "auto" | "ask"> }>;
  now?: () => number;
}

export async function assertToolApproval(
  input: ToolApproval,
  checks: ToolAuthorityChecks,
): Promise<void> {
  const proof = toolApprovalSchema.parse(input);
  await checks.authorizeIdentity(proof.clientIdentity, "write");
  const permission = proof.permission;
  if (permission.kind === "human") {
    if (!permission.operator.scopes.includes("admin"))
      throw new EffectAuthorityRevoked("the approving operator lacks administration scope");
    await checks.authorizeIdentity(permission.operator.id, "admin");
    return;
  }
  if (permission.kind === "policy") {
    const current = await checks.policy();
    if (
      (current.perTool[proof.tool] ?? (current.approvalMode === "yolo" ? "auto" : "ask")) !== "auto"
    )
      throw new EffectAuthorityRevoked(
        "automatic tool writes are no longer authorized; request approval again",
      );
    return;
  }
  const grant = await checks.grant(permission.id);
  const now = (checks.now ?? Date.now)();
  const reserved = permission.claimedWrites ?? 1;
  // The slot was already consumed. An exhausted allowance does not revoke its
  // last claimed write; expiry, revocation and scope still apply at the effect.
  if (
    !grant ||
    reserved < Math.max(1, proof.paths.length) ||
    permission.claimedWrite < reserved ||
    grant.client !== proof.clientIdentity ||
    grant.revokedAt !== null ||
    grant.expiresAt <= now ||
    grant.usedWrites < permission.claimedWrite ||
    !grant.allowedTools.some((tool) => tool === "*" || tool === proof.tool) ||
    !(proof.paths.length ? proof.paths : [""]).every((path) =>
      grant.allowedFolders.some((folder) => path.startsWith(folder)),
    )
  )
    throw new EffectAuthorityRevoked(
      "the tool's scoped write grant expired, was revoked or no longer matches",
    );
}

export function assertToolTarget(
  proof: ToolApproval,
  clientIdentity: string,
  target: { path: string } | { edgeId: string },
): void {
  if (
    proof.clientIdentity !== clientIdentity ||
    ("path" in target ? !proof.paths.includes(target.path) : proof.edgeId !== target.edgeId)
  )
    throw new EffectAuthorityRevoked("the stored approval does not authorize this effect");
}
