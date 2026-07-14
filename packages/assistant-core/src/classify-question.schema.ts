// classify-question.schema.ts — Spec 12 §5.4.1. The classifier LLM's
// entire structured-output surface (FR-1, FR-17): this call has zero
// bound tools, so this schema's fields are the only way its output can
// affect anything downstream.
import { z } from "zod";
import { ASSISTANT_INTENTS } from "./types.js";

const OBLIGATION_STATUS_VALUES = [
  "proposed",
  "tier_a_committed",
  "tier_b_review",
  "tier_c_review",
  "escalated",
  "committed",
  "rejected"
] as const;

export const assistantSlotsSchema = z.object({
  categoryName: z.string().nullable(),
  obligationId: z.string().nullable(),
  circularId: z.string().nullable(),
  titleContains: z.string().nullable(),
  status: z.enum(OBLIGATION_STATUS_VALUES).nullable(),
  reviewerId: z.string().nullable(),
  decision: z.enum(["approve", "reject"]).nullable(),
  dateFrom: z.string().nullable(),
  dateTo: z.string().nullable()
});

export const classificationOutputSchema = z.object({
  intent: z.enum(ASSISTANT_INTENTS),
  confidence: z.number().min(0).max(1),
  slots: assistantSlotsSchema,
  unsupportedReason: z.string().nullable()
});

export type ClassificationModelOutput = z.infer<typeof classificationOutputSchema>;
