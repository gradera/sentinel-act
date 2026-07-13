// Zod schemas the Grounding and Verification Agent's model output is
// structurally constrained against (Spec 04 §5, FR-2.6), plus the FR-11
// output-contract invariant validator. Field names mirror
// grounding-verification.types.ts / grounding-scoring.ts exactly — do not
// rename `case` or `divergent_field`; Spec 05/09/10 consume this agent's
// final output shape (not this raw schema directly), but drift here would
// silently break the mapping in grounding-verification.agent.ts.
import { z } from "zod";
import { CHECKABLE_FIELDS } from "./grounding-verification.types.js";
import { FIELD_CASES } from "./grounding-scoring.js";

export const checkableFieldSchema = z.enum(CHECKABLE_FIELDS);
export const fieldCaseSchema = z.enum(FIELD_CASES);
export const divergentFieldSchema = z.enum(["deadline_rule", "requirement_text", "penalty_ref"]);

// FR-2.3: "Quote the literal supporting span(s) of Clause.text for every
// field scored (a) [directly_stated] or (b) [paraphrase]. An empty quote
// is only valid for (c) [fabricated]." `dropped_condition` also implies
// real supporting text exists (the field IS supported, just missing a
// qualifier) so it is grouped with directly_stated/paraphrase here.
// `legitimately_absent` is the other case where an empty quote is valid
// (there is genuinely nothing to quote on either side).
const CASES_REQUIRING_SPANS: ReadonlySet<string> = new Set(["directly_stated", "paraphrase", "dropped_condition"]);

export const fieldAssessmentSchema = z
  .object({
    field: checkableFieldSchema,
    case: fieldCaseSchema,
    supporting_spans: z.array(z.string()),
    rationale: z.string().min(1)
  })
  .refine((v) => !CASES_REQUIRING_SPANS.has(v.case) || v.supporting_spans.length > 0, {
    message: 'supporting_spans must be non-empty for "directly_stated", "paraphrase", and "dropped_condition" cases'
  });

// FR-9/FR-10: the model assesses each contradiction candidate retrieved
// by contradictionLookupTool (pre-fetched deterministically, see
// grounding-verification.agent.ts) and judges whether a genuine conflict
// exists. `conflict: false` entries are still part of the model's raw
// output (so the prompt can require an explicit judgment per candidate,
// not just silence-implies-no-conflict) but are filtered out before
// becoming a ContradictionDetail (post-processing, FR-11).
export const candidateAssessmentSchema = z
  .object({
    conflicting_obligation_id: z.string(),
    conflict: z.boolean(),
    divergent_field: divergentFieldSchema.nullable(),
    proposed_value: z.string().nullable(),
    existing_value: z.string().nullable(),
    // FR-12: a generic "conflict detected" string is a spec violation —
    // min(15) is a coarse heuristic floor, not a substitute for the
    // manual-verification Definition-of-Done check against the flagship
    // CUSPA fixture.
    explanation: z.string().nullable()
  })
  .refine(
    (v) =>
      !v.conflict ||
      (v.divergent_field !== null && v.proposed_value !== null && v.existing_value !== null && v.explanation !== null && v.explanation.length >= 15),
    {
      message: "conflict: true requires divergent_field, proposed_value, existing_value, and a specific (>=15 char) explanation"
    }
  );

export const groundingModelOutputSchema = z
  .object({
    field_assessments: z.array(fieldAssessmentSchema),
    candidate_assessments: z.array(candidateAssessmentSchema),
    summary: z.string().min(1)
  })
  .refine(
    (v) => {
      const fields = v.field_assessments.map((f) => f.field);
      const uniqueFields = new Set(fields);
      return uniqueFields.size === fields.length && CHECKABLE_FIELDS.every((f) => uniqueFields.has(f));
    },
    { message: `field_assessments must contain exactly one entry per checkable field: ${CHECKABLE_FIELDS.join(", ")}` }
  );

export type GroundingModelOutput = z.infer<typeof groundingModelOutputSchema>;
export type FieldAssessment = z.infer<typeof fieldAssessmentSchema>;
export type CandidateAssessment = z.infer<typeof candidateAssessmentSchema>;

// ============================================================================
// FR-11 output-contract invariant, enforced in code (not just prompted):
// `contradiction` MUST be true iff `contradiction_details` is non-empty.
// Exposed as both a Zod schema (for a single assertParse-style call site)
// and a plain predicate (for the "reject a hand-built malformed payload"
// unit test in Spec 04 §10, which constructs a raw object rather than
// going through this agent's own derivation).
// ============================================================================
export const contradictionInvariantSchema = z
  .object({
    contradiction: z.boolean(),
    contradiction_details: z.array(z.unknown())
  })
  .refine((v) => v.contradiction === (v.contradiction_details.length > 0), {
    message: "contradiction must be true iff contradiction_details is non-empty (FR-11)"
  });

export function satisfiesContradictionInvariant(output: { contradiction: boolean; contradiction_details: unknown[] }): boolean {
  return output.contradiction === (output.contradiction_details.length > 0);
}
