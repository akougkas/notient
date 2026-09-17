import { RecordId, type Surreal } from "surrealdb";
import { contentRevision } from "../../api/notes";
import { NoteApiError } from "../../api/schema";

/** Bind a mutation key before effects. This is a request binding, not a success
 * receipt: each domain operation still owns its durable effects and recovery. */
export async function bindMutationRequest(
  db: Surreal,
  domain: string,
  caller: { id: string; kind: string },
  key: string,
  request: unknown,
): Promise<void> {
  const id = new RecordId(
    "mutation_request",
    contentRevision(JSON.stringify([domain, caller.kind, caller.id, key])),
  );
  const payload = JSON.stringify(request);
  const existing = async () => {
    const [rows] = await db
      .query<[Array<{ payload: string }>]>("SELECT payload FROM mutation_request WHERE id = $id;", {
        id,
      })
      .collect();
    if (!rows.length) return false;
    if (rows[0].payload !== payload)
      throw new NoteApiError("CONFLICT", "idempotency key was reused with different inputs");
    return true;
  };
  if (await existing()) return;
  try {
    await db.query("CREATE ONLY $id CONTENT { payload: $payload };", { id, payload }).collect();
  } catch (error) {
    if (!(await existing())) throw error;
  }
}
