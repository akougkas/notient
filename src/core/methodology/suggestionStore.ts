import { RecordId, type Surreal } from "surrealdb";
import { z } from "zod";
import {
  methodologySuggestionResultSchema,
  type MethodologySuggestionResult,
} from "../../api/methodology";
import { contentRevision } from "../../api/notes";
import { NoteApiError } from "../../api/schema";
import type { ChangeCaller } from "../history/changeService";

const storedEntrySchema = z
  .object({
    principal_id: z.string().min(1),
    principal_kind: z.string().min(1),
    idempotency_key: z.string().min(1).max(128),
    request_hash: z.string().regex(/^[a-f0-9]{64}$/u),
    created_ms: z.number().int().nonnegative(),
    payload: z.string().min(1),
  })
  .strict();

export interface MethodologySuggestionResultStore {
  findReplay(
    caller: Pick<ChangeCaller, "id" | "kind">,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<MethodologySuggestionResult | null>;
  saveReplay(
    caller: Pick<ChangeCaller, "id" | "kind">,
    idempotencyKey: string,
    requestHash: string,
    result: MethodologySuggestionResult,
  ): Promise<MethodologySuggestionResult>;
}

export class DatabaseMethodologySuggestionResultStore implements MethodologySuggestionResultStore {
  constructor(private readonly db: Surreal) {}

  async findReplay(
    caller: Pick<ChangeCaller, "id" | "kind">,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<MethodologySuggestionResult | null> {
    const [rows] = await this.db
      .query<[Array<z.infer<typeof storedEntrySchema>>]>(
        "SELECT principal_id, principal_kind, idempotency_key, request_hash, created_ms, payload FROM methodology_suggestion WHERE id = $id;",
        { id: this.recordId(caller, idempotencyKey) },
      )
      .collect();
    if (!rows.length) return null;
    const row = storedEntrySchema.parse(rows[0]);
    this.assertBinding(row, caller, idempotencyKey, requestHash);
    return methodologySuggestionResultSchema.parse(JSON.parse(row.payload));
  }

  async saveReplay(
    caller: Pick<ChangeCaller, "id" | "kind">,
    idempotencyKey: string,
    requestHash: string,
    result: MethodologySuggestionResult,
  ): Promise<MethodologySuggestionResult> {
    const validated = methodologySuggestionResultSchema.parse(result);
    const created = Date.now();
    try {
      await this.db
        .query(
          "CREATE ONLY $id CONTENT { principal_id: $principal, principal_kind: $kind, idempotency_key: $key, request_hash: $requestHash, created_ms: $created, payload: $payload };",
          {
            id: this.recordId(caller, idempotencyKey),
            principal: caller.id,
            kind: caller.kind,
            key: idempotencyKey,
            requestHash,
            created,
            payload: JSON.stringify(validated),
          },
        )
        .collect();
      return validated;
    } catch (error) {
      const raced = await this.findReplay(caller, idempotencyKey, requestHash);
      if (raced) return raced;
      throw error;
    }
  }

  private recordId(caller: Pick<ChangeCaller, "id" | "kind">, idempotencyKey: string) {
    return new RecordId(
      "methodology_suggestion",
      contentRevision(JSON.stringify([caller.kind, caller.id, idempotencyKey])),
    );
  }

  private assertBinding(
    row: z.infer<typeof storedEntrySchema>,
    caller: Pick<ChangeCaller, "id" | "kind">,
    idempotencyKey: string,
    requestHash: string,
  ): void {
    if (
      row.principal_id !== caller.id ||
      row.principal_kind !== caller.kind ||
      row.idempotency_key !== idempotencyKey
    )
      throw new NoteApiError("CONFLICT", "methodology suggestion replay binding is invalid");
    if (row.request_hash !== requestHash)
      throw new NoteApiError(
        "CONFLICT",
        "methodology idempotency key was reused with different request inputs",
      );
  }
}
