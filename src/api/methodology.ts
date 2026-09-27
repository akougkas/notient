import { z } from "zod";
import { reviewProposalSchema } from "./proposals";
import {
  notePathSchema,
  noteReferenceSchema,
  revisionSchema,
  sourceReferenceSchema,
} from "./schema";

const methodologyEvidenceSchema = z.array(sourceReferenceSchema).min(1).max(6);
const methodologyReportEvidenceSchema = z.array(sourceReferenceSchema).max(6).default([]);
const methodologyExaminedSourcesSchema = z.array(noteReferenceSchema).max(7).default([]);

export const methodologySuggestionResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      ok: z.literal(true),
      status: z.literal("proposal-created"),
      methodology: z.string().min(1).max(100),
      source: noteReferenceSchema,
      destination: notePathSchema,
      role: z.string().trim().min(1).max(100),
      rationale: z.string().trim().min(1).max(4000),
      evidence: methodologyEvidenceSchema,
      examinedSources: methodologyExaminedSourcesSchema,
      previewId: revisionSchema,
      previewRevision: revisionSchema,
      proposal: reviewProposalSchema,
      conventionSuggestion: z.null(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      status: z.literal("convention-suggestion"),
      methodology: z.string().min(1).max(100),
      source: noteReferenceSchema,
      rationale: z.string().trim().min(1).max(4000),
      evidence: methodologyEvidenceSchema,
      examinedSources: methodologyExaminedSourcesSchema,
      previewId: revisionSchema,
      previewRevision: revisionSchema,
      proposal: reviewProposalSchema,
      conventionSuggestion: z
        .object({
          text: z.string().trim().min(1).max(4000),
          rationale: z.string().trim().min(1).max(4000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      status: z.literal("no-suggestion"),
      methodology: z.string().min(1).max(100),
      source: noteReferenceSchema,
      reason: z.string().trim().min(1).max(4000),
      evidence: methodologyReportEvidenceSchema,
      examinedSources: methodologyExaminedSourcesSchema,
      candidateCount: z.number().int().nonnegative().max(6),
      previewId: z.null(),
      previewRevision: z.null(),
      proposal: z.null(),
      conventionSuggestion: z.null(),
    })
    .strict(),
]);

export type MethodologySuggestionResult = z.infer<typeof methodologySuggestionResultSchema>;
