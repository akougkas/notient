import { z } from "zod";
import { NOTE_CONNECTION_TABLES } from "../core/db/edgeTables";
import { searchCoverageSchema } from "./indexing";
import { notePathSchema, noteReferenceSchema, sourceReferenceSchema } from "./schema";

export const connectionSchema = z.object({
  id: z.string().min(1).max(512),
  note: noteReferenceSchema,
  relation: z.enum(NOTE_CONNECTION_TABLES),
  direction: z.enum(["outgoing", "incoming"]),
  state: z.enum(["authored", "approved", "proposed"]),
  assessment: z.number().min(0).max(1).nullable(),
  author: z.string(),
  rationale: z.string().nullable(),
  evidence: z.array(sourceReferenceSchema).max(20),
  evidenceState: z.enum(["current", "stale", "unavailable"]),
});
export type Connection = z.infer<typeof connectionSchema>;
export const graphNeighborsSchema = z
  .object({
    ok: z.literal(true),
    note: noteReferenceSchema,
    connections: z.array(connectionSchema).max(200),
    coverage: searchCoverageSchema,
    omitted: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .superRefine((result, context) => {
    if (
      new Set(result.connections.map((edge) => edge.id)).size !== result.connections.length ||
      result.connections.some((edge) => edge.note.path === result.note.path)
    )
      context.addIssue({
        code: "custom",
        message: "connections must be distinct and refer to another note",
      });
  });
export type GraphNeighbors = z.infer<typeof graphNeighborsSchema>;
export const graphPathSchema = z
  .object({
    ok: z.literal(true),
    from: notePathSchema,
    to: notePathSchema,
    path: z.array(noteReferenceSchema).max(7),
    steps: z.array(connectionSchema).max(6),
    outcome: z.enum(["found", "not-found", "incomplete"]),
    coverage: searchCoverageSchema,
    visited: z.number().int().nonnegative().max(256),
  })
  .superRefine((result, context) => {
    const found = result.outcome === "found";
    if (
      found
        ? result.path.length === 0 ||
          result.path[0].path !== result.from ||
          result.path[result.path.length - 1].path !== result.to ||
          result.steps.length !== result.path.length - 1
        : result.path.length !== 0 || result.steps.length !== 0
    )
      context.addIssue({
        code: "custom",
        message: "route does not match its outcome or endpoints",
      });
    if (
      new Set(result.path.map((note) => note.path)).size !== result.path.length ||
      result.steps.some(
        (edge, index) =>
          edge.state === "proposed" ||
          edge.note.path !== result.path[index + 1]?.path ||
          edge.note.revision !== result.path[index + 1]?.revision,
      )
    )
      context.addIssue({
        code: "custom",
        message: "route steps are inconsistent or contain proposed relationships",
      });
    if (result.outcome === "not-found" && result.coverage.state !== "current")
      context.addIssue({ code: "custom", message: "incomplete coverage cannot establish absence" });
  });
export type GraphPath = z.infer<typeof graphPathSchema>;
