// Zod schema the Obligation Extraction Agent's model output is
// structurally constrained against (Spec 03 §5.4). Field names and
// validation rules are copied verbatim from the spec — do not rename
// `applies_to_category_names` to `_ids`; Spec 04 (Grounding and
// Verification) depends on this exact shape (Spec 03 §8 cross-spec note).
//
// `confidence_score` / `confidence_breakdown` are deliberately NOT part of
// this schema: they are computed by this agent's own post-processing code
// (confidence-score.ts) from `model_self_reported` plus deterministic
// signals, never trusted as raw model output (FR-10).
import { z } from "zod";

export const obligationCategorySchema = z.enum([
  "reporting",
  "record_keeping",
  "disclosure",
  "kyc_aml",
  "risk_management",
  "governance",
  "investor_grievance",
  "operational_control",
  "capital_adequacy",
  "other"
]);

export const obligationProposalSchema = z.object({
  category: obligationCategorySchema,
  requirement_text: z.string().min(10),
  trigger_event: z.string().min(3),
  // "NONE" (literal) is a valid value — see FR-8, never fabricated.
  deadline_rule: z.string().min(2),
  responsible_role: z.string().min(2),
  evidence_required: z.string().min(2),
  penalty_ref: z.string().nullable(),
  applies_to_category_names: z.array(z.string()).min(1),
  applies_to_unknown_category_names: z.array(z.string()).default([]),
  model_self_reported: z.number().min(0).max(1),
  extraction_index: z.number().int().min(0)
});

export const obligationProposalListSchema = z
  .object({
    proposals: z.array(obligationProposalSchema),
    informational_only: z.boolean(),
    informational_reason: z.string().nullable()
  })
  .refine((v) => v.informational_only === (v.proposals.length === 0), {
    message: "informational_only must be true iff proposals is empty"
  })
  .refine((v) => !v.informational_only || v.informational_reason !== null, {
    message: "informational_reason is required when informational_only is true"
  });

export type ObligationProposalListModelOutput = z.infer<typeof obligationProposalListSchema>;
export type ObligationProposalModelOutput = z.infer<typeof obligationProposalSchema>;
