import { z } from "zod";
import { notePathSchema, noteReferenceSchema, sourceReferenceSchema } from "../../api/schema";

export const intelligenceKindSchema = z.enum([
  "finding",
  "interpretation",
  "decision",
  "question",
  "relationship",
  "feedback",
]);

export const intelligenceStatusSchema = z.enum([
  "supported",
  "provisional",
  "disputed",
  "decided",
  "open",
  "retained",
  "superseded",
]);

export const intelligenceAttributionSchema = z
  .object({
    kind: z.enum(["human", "agent", "clipper", "software"]),
    id: z.string().trim().min(1).max(128),
    label: z.string().trim().min(1).max(200),
  })
  .strict();

export const intelligenceEvidenceSchema = z
  .object({
    source: sourceReferenceSchema,
    relation: z.enum(["supports", "qualifies", "disputes", "reports"]),
    assessment: z.enum(["direct", "source-assertion", "unverified"]),
  })
  .strict();

export const intelligenceRelationshipSchema = z
  .object({
    target: notePathSchema.max(1000),
    relation: z.enum(["supports", "contradicts", "extends", "exemplifies", "synthesizes", "related_to"]).optional(),
    meaning: z.string().trim().min(1).max(10000),
    provenance: z.enum(["authored", "inferred"]),
    evidence: z.array(sourceReferenceSchema).max(20),
  })
  .strict();

export const intelligenceFeedbackReasonSchema = z.enum([
  "false",
  "unsupported",
  "irrelevant",
  "already-known",
  "deferred",
]);

export const intelligenceFeedbackSchema = z
  .object({
    reason: intelligenceFeedbackReasonSchema,
    target: z.string().trim().min(1).max(8000),
    targetKey: z.string().trim().min(1).max(500),
    explanation: z.string().trim().min(1).max(4000),
  })
  .strict();

export const intelligenceRecordSchema = z
  .object({
    kind: intelligenceKindSchema,
    status: intelligenceStatusSchema,
    statement: z.string().trim().min(1).max(8000),
    attribution: intelligenceAttributionSchema,
    capturedContribution: z.literal(true).optional(),
    assessmentOf: z.string().regex(/^i-[a-f0-9]{64}$/).optional(),
    evidence: z.array(intelligenceEvidenceSchema).max(30),
    qualifications: z.array(z.string().trim().min(1).max(2000)).max(20),
    relationships: z.array(intelligenceRelationshipSchema).max(20),
    dependencies: z.array(noteReferenceSchema).max(30),
    feedback: intelligenceFeedbackSchema.nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if ((record.kind === "feedback") !== (record.feedback !== null)) {
      context.addIssue({
        code: "custom",
        path: ["feedback"],
        message: "feedback details are required only for feedback records",
      });
    }
  });

export type IntelligenceKind = z.infer<typeof intelligenceKindSchema>;
export type IntelligenceStatus = z.infer<typeof intelligenceStatusSchema>;
export type IntelligenceAttribution = z.infer<typeof intelligenceAttributionSchema>;
export type IntelligenceEvidence = z.infer<typeof intelligenceEvidenceSchema>;
export type IntelligenceRelationship = z.infer<typeof intelligenceRelationshipSchema>;
export type IntelligenceFeedbackReason = z.infer<typeof intelligenceFeedbackReasonSchema>;
export type IntelligenceFeedback = z.infer<typeof intelligenceFeedbackSchema>;
export type IntelligenceRecord = z.infer<typeof intelligenceRecordSchema>;

export interface IntelligenceDependencyState {
  path: string;
  previousRevision: string;
  currentRevision: string | null;
  retainedEvidence: boolean;
  changedEvidence: string[];
}

export interface CurrentIntelligenceSource {
  path: string;
  revision: string;
  body: string;
}
