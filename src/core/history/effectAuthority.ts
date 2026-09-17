import { RecordId, type Surreal } from "surrealdb";
import { z } from "zod";
import type { PreviewEffect } from "../../api/changes";
import { contentRevision } from "../../api/notes";
import { NoteApiError, revisionSchema } from "../../api/schema";

const effectAuthoritySchema = z
  .object({
    previewId: revisionSchema,
    previewRevision: revisionSchema,
    index: z.number().int().nonnegative(),
    caller: z.object({
      id: z.string().min(1),
      kind: z.enum(["human", "agent"]),
      scopes: z.array(z.string()),
    }),
    reviewId: revisionSchema.nullable(),
    jobId: z.string().uuid().nullable(),
  })
  .strict();
export type EffectAuthority = z.infer<typeof effectAuthoritySchema>;
export class EffectAuthorityRevoked extends NoteApiError {
  constructor(message: string) {
    super("FORBIDDEN", message);
  }
}
/** Private durable attribution for one already-authorized preview effect.
 * This record never grants authority; current caller, review and policy are
 * checked again immediately before an interrupted filesystem effect. */
export async function saveEffectAuthority(
  db: Surreal,
  input: EffectAuthority,
  effect: PreviewEffect,
): Promise<void> {
  const authority = effectAuthoritySchema.parse(input);
  const id = new RecordId(
    "change_authority",
    contentRevision(JSON.stringify([authority.previewId, authority.index])),
  );
  await db
    .query("UPSERT $id CONTENT { payload: $payload, preview_id: $preview, edge_id: $edge };", {
      id,
      payload: JSON.stringify(authority),
      preview: authority.previewId,
      edge: effect.relationship?.edgeId ?? null,
    })
    .collect();
}
export async function effectAuthorities(
  db: Surreal,
  selector: { previewId: string } | { edgeId: string },
): Promise<EffectAuthority[]> {
  const [rows] = await db
    .query<[Array<{ payload: string }>]>(
      `SELECT payload FROM change_authority WHERE ${"previewId" in selector ? "preview_id" : "edge_id"} = $value LIMIT 201;`,
      { value: "previewId" in selector ? selector.previewId : selector.edgeId },
    )
    .collect();
  if (rows.length > 200) throw new Error("effect authority inventory exceeds its bounded preview");
  return rows.map((row) => effectAuthoritySchema.parse(JSON.parse(row.payload)));
}
